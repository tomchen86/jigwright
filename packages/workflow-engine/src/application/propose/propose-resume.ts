import type { PlanningTransitionExecutionServices } from '../../modules/lifecycle/planning-execution-epoch.ts';
/**
 * Routes typed propose submissions through the current investigation transition.
 *
 * Invariants:
 * - Submissions retain their exact change, revision, baseline, and input bindings.
 * - Published provider progress replays without applying the transition twice.
 * - Scan acceptance names the exact saturated terms of the current pinned scan.
 */

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  workflowError,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import { materializeInvestigationEvidenceViewFromFacts } from '../../modules/investigation/manifest/investigation-materializer.ts';
import {
  completePlanReviewDispositions,
  resumePlanReview,
} from './plan-review-completion.ts';
import { resumePlanReviewRetry } from './plan-review-retry.ts';
import { readCallerJson } from './propose-artifacts.ts';
import {
  resolveProposePlanningWorkspace,
  resumeInvestigationForPropose,
  withProposeTransitionAuthority,
} from './propose-context.ts';
import {
  assertPlanningBinding,
  assertProgressBinding,
} from './propose-input.ts';
import {
  buildWhyAuthoringFromCheckpoint,
  expandSubmittedDispositions,
  mergeReviewerReopenCheckpoint,
} from './propose-investigation-facts.ts';
import { rebuildInvestigation } from './propose-investigation-rebuild.ts';
import { materializePlanningContribution } from './propose-planning-materialization.ts';
import {
  dispatchPreparedInvocation,
  dispatchPreparedPlanReview,
  resumeProviderRetry,
} from './propose-provider-lifecycle.ts';
import { assertProposeInput } from './propose-request-validation.ts';
import { reconcileReviewerTermPlanningRevision } from './propose-reviewer-reconciliation.ts';
import type {
  InvestigationCheckpointEnvelope,
  InvestigationScanSaturationAcceptanceEnvelope,
  InvestigationSession,
  InvestigationStatus,
  ProposeRuntime,
} from './propose-runtime.ts';
import { resumeExemptionPlanningContribution } from './propose-start.ts';
import {
  getProposeStatus,
  renderProposeOutput,
  renderProposeOutputWithPlanningAuthority,
} from './propose-status.ts';
import {
  type ExemptionPlanningContributionEnvelope,
  type ExemptionProposeOutput,
  type OrdinaryProposeOutput,
  type PlanningContributionEnvelope,
  type PlanReviewDispositionsEnvelope,
  type PlanReviewProgressEnvelope,
  type PlanReviewRetryEnvelope,
  type ProposeOutput,
  type ProposeResumeOptions,
  type ProviderProgressEnvelope,
  type ProviderRetryEnvelope,
} from './propose-types.ts';

export function resumePropose(
  planningExecution: PlanningTransitionExecutionServices,
  services: ProposeRuntime,
  cwd: string,
  requestedChangeId: string,
  inputValue:
    | InvestigationCheckpointEnvelope
    | InvestigationScanSaturationAcceptanceEnvelope
    | PlanningContributionEnvelope
    | ProviderProgressEnvelope
    | ProviderRetryEnvelope,
  options?: ProposeResumeOptions,
): OrdinaryProposeOutput;

export function resumePropose(
  planningExecution: PlanningTransitionExecutionServices,
  services: ProposeRuntime,
  cwd: string,
  requestedChangeId: string,
  inputValue: ExemptionPlanningContributionEnvelope,
  options?: ProposeResumeOptions,
): ExemptionProposeOutput;

export function resumePropose(
  planningExecution: PlanningTransitionExecutionServices,
  services: ProposeRuntime,
  cwd: string,
  requestedChangeId: string,
  inputValue:
    | PlanReviewRetryEnvelope
    | PlanReviewProgressEnvelope
    | PlanReviewDispositionsEnvelope,
  options?: ProposeResumeOptions,
): ProposeOutput;

export function resumePropose(
  planningExecution: PlanningTransitionExecutionServices,
  services: ProposeRuntime,
  cwd: string,
  requestedChangeId: string,
  inputValue: unknown,
  options?: ProposeResumeOptions,
): ProposeOutput;

export function resumePropose(
  planningExecution: PlanningTransitionExecutionServices,
  services: ProposeRuntime,
  cwd: string,
  requestedChangeId: string,
  inputValue: unknown,
  options: ProposeResumeOptions = {},
): ProposeOutput {
  const changeId = services.workspace.assertChangeId(requestedChangeId);
  const input = assertProposeInput(services, inputValue);
  if (input.changeId !== changeId) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'Propose input belongs to another change.',
      ExitCode.staleState,
    );
  }
  cwd = resolveProposePlanningWorkspace(services, cwd, changeId, 'resume');
  if (input.kind === 'exemption-planning-contribution') {
    return resumeExemptionPlanningContribution(services, cwd, input, options);
  }
  if (input.kind === 'scan-saturation-acceptance') {
    return resumeScanSaturationAcceptance(services, cwd, input, options);
  }
  if (input.kind === 'planning-contribution') {
    const initialContext =
      services.workspace.loadInvestigationRuntimeContext(cwd);
    const output = withProposeTransitionAuthority(
      services,
      cwd,
      initialContext.lifecycleRuntime,
      changeId,
      (assertOwned) => {
        assertOwned();
        const status = services.investigation.getInvestigationStatus(
          cwd,
          input.investigationId,
        );
        assertPlanningBinding(status, input);
        if (status.state !== 'investigation-sealed') {
          throw workflowError(
            'INVESTIGATION_NOT_SEALED',
            'Planning materialization requires a sealed investigation.',
            ExitCode.guard,
          );
        }
        const rebuilt = rebuildInvestigation(
          services,
          cwd,
          status.investigationId,
          'consume',
          options.collaborationGrantValidation,
          assertOwned,
        );
        assertOwned();
        const materializedArtifacts = materializePlanningContribution(
          services,
          cwd,
          status,
          rebuilt,
          input.payload,
          options.collaborationGrant,
          options.roleTopologyResolution,
          options.roleContextSharingGrant,
          assertOwned,
        );
        assertOwned();
        const current = services.investigation.getInvestigationStatus(
          cwd,
          input.investigationId,
        );
        assertPlanningBinding(current, input);
        return renderProposeOutput(
          services,
          cwd,
          current,
          'consume',
          null,
          materializedArtifacts,
          options.collaborationGrantValidation,
          assertOwned,
        );
      },
    );
    dispatchPreparedPlanReview(services, cwd, output, options);
    return getProposeStatus(
      services,
      cwd,
      input.investigationId,
      options.collaborationGrantValidation,
    );
  }

  if (input.kind === 'plan-review-progress') {
    return resumePlanReview(planningExecution, services, cwd, input, options);
  }

  if (input.kind === 'plan-review-dispositions') {
    return completePlanReviewDispositions(
      planningExecution,
      services,
      cwd,
      input,
      options,
    );
  }

  if (input.kind === 'provider-retry') {
    return resumeProviderRetry(services, cwd, input, options);
  }

  if (input.kind === 'plan-review-retry') {
    return resumePlanReviewRetry(services, cwd, input, options);
  }

  if (input.kind === 'provider-progress') {
    const current = services.investigation.getInvestigationStatus(
      cwd,
      input.investigationId,
    );
    assertProgressBinding(current, input);
    let resumed: InvestigationStatus;
    if (current.revision === input.expectedRevision) {
      dispatchPreparedInvocation(
        services,
        cwd,
        current,
        options.providerDispatcher,
      );
      resumed = resumeInvestigationForPropose(
        services,
        cwd,
        changeId,
        input.investigationId,
      );
    } else if (
      current.revision === input.expectedRevision + 1 &&
      isExactPublishedProviderProgressReplay(services, cwd, current)
    ) {
      resumed = current;
    } else {
      throw workflowError(
        'INVESTIGATION_CAS_MISMATCH',
        'Investigation session changed during provider progress.',
        ExitCode.conflict,
      );
    }
    return renderProposeOutputWithPlanningAuthority(
      services,
      cwd,
      resumed,
      null,
      options.collaborationGrantValidation,
    );
  }

  const suppliedCheckpoint =
    services.investigation.assertInvestigationCheckpointEnvelope(input);
  const before = services.investigation.getInvestigationStatus(
    cwd,
    suppliedCheckpoint.investigationId,
  );
  dispatchPreparedInvocation(services, cwd, before, options.providerDispatcher);
  let checkpoint = suppliedCheckpoint;
  if (checkpoint.kind === 'group-dispositions') {
    const rebuilt = rebuildInvestigation(
      services,
      cwd,
      before.investigationId,
      'consume',
      options.collaborationGrantValidation,
    );
    const effectiveCheckpoint = mergeReviewerReopenCheckpoint(
      services,
      rebuilt,
      checkpoint,
    ) as Extract<
      InvestigationCheckpointEnvelope,
      { kind: 'group-dispositions' }
    >;
    checkpoint = effectiveCheckpoint;
    if (rebuilt.v3Domain === null) {
      throw workflowError(
        'INVESTIGATION_NOT_READY',
        'Group dispositions have no current investigation facts.',
        ExitCode.staleState,
      );
    }
    const dispositions = expandSubmittedDispositions(
      services.workspace.loadInvestigationRuntimeContext(cwd).git
        .repositoryRoot,
      {
        scanFacts: rebuilt.v3Domain.scanFacts,
        groupFacts: rebuilt.v3Domain.groupFacts,
        payload: effectiveCheckpoint.payload,
        saturatedTermIds: rebuilt.saturatedTermIds,
        assuranceAssessmentNode: rebuilt.assuranceAssessmentNode,
      },
    );
    try {
      materializeInvestigationEvidenceViewFromFacts({
        scanFacts: rebuilt.v3Domain.scanFacts,
        grouping: rebuilt.v3Domain.groupFacts,
        canonicalTerms: rebuilt.v3Domain.canonicalTerms,
        semanticGroupDecisions: [],
        dispositionDecisions: dispositions.map((disposition) => ({
          groupKey: disposition.groupId,
          classification: disposition.classification,
          rationale: disposition.rationale,
          semanticAuthor: {
            id: disposition.author,
            provenance: `checkpoint:${services.investigation.checkpointContributionDigest(
              effectiveCheckpoint,
            )}`,
          },
        })),
      });
    } catch (error) {
      if (error instanceof WorkflowError) {
        throw workflowError(
          'INVESTIGATION_DISPOSITIONS_INVALID',
          error.message,
          ExitCode.usage,
        );
      }
      throw error;
    }
  } else if (checkpoint.kind === 'why-answers') {
    const rebuilt = rebuildInvestigation(
      services,
      cwd,
      before.investigationId,
      'consume',
      options.collaborationGrantValidation,
    );
    const effectiveCheckpoint = mergeReviewerReopenCheckpoint(
      services,
      rebuilt,
      checkpoint,
    ) as Extract<InvestigationCheckpointEnvelope, { kind: 'why-answers' }>;
    checkpoint = effectiveCheckpoint;
    try {
      buildWhyAuthoringFromCheckpoint(services, {
        repositoryRoot:
          services.workspace.loadInvestigationRuntimeContext(cwd).git
            .repositoryRoot,
        rebuilt,
        answers: effectiveCheckpoint.payload.answers,
        checkpointProvenanceDigest:
          services.investigation.checkpointContributionDigest(
            effectiveCheckpoint,
          ),
      });
    } catch (error) {
      if (error instanceof WorkflowError) {
        throw workflowError(
          'INVESTIGATION_WHY_INVALID',
          error.message,
          ExitCode.usage,
        );
      }
      throw error;
    }
  }

  let status = resumeInvestigationForPropose(
    services,
    cwd,
    changeId,
    checkpoint.investigationId,
    checkpoint,
  );
  if (
    checkpoint.kind === 'main-terms' &&
    status.state === 'waiting-for-provider' &&
    status.provider.state === 'succeeded'
  ) {
    status = resumeInvestigationForPropose(
      services,
      cwd,
      changeId,
      checkpoint.investigationId,
    );
  }
  if (
    status.state === 'investigation-sealed' &&
    services.investigation.readInvestigationSession(
      services.workspace.loadInvestigationRuntimeContext(cwd).runtime,
      status.investigationId,
    ).milestones.reviewerTermSourceNodeId !== null
  ) {
    return reconcileReviewerTermPlanningRevision(
      services,
      cwd,
      status,
      options,
    );
  }
  return renderProposeOutputWithPlanningAuthority(
    services,
    cwd,
    status,
    null,
    options.collaborationGrantValidation,
  );
}

function resumeScanSaturationAcceptance(
  services: ProposeRuntime,
  cwd: string,
  input: InvestigationScanSaturationAcceptanceEnvelope,
  options: ProposeResumeOptions,
): ProposeOutput {
  const initialContext =
    services.workspace.loadInvestigationRuntimeContext(cwd);
  return withProposeTransitionAuthority(
    services,
    cwd,
    initialContext.lifecycleRuntime,
    input.changeId,
    (assertOwned) => {
      assertOwned();
      const context = services.workspace.loadInvestigationRuntimeContext(cwd);
      const current = services.investigation.readInvestigationSession(
        context.runtime,
        input.investigationId,
      );
      assertScanSaturationAcceptanceBinding(current, input);
      const envelopeDigest =
        services.investigation.scanSaturationAcceptanceEnvelopeDigest(input);
      if (current.scanSaturationAcceptance !== undefined) {
        if (
          current.scanSaturationAcceptance.envelopeDigest !== envelopeDigest
        ) {
          throw workflowError(
            'INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_MISMATCH',
            'The investigation already records a different scan saturation acceptance.',
            ExitCode.staleState,
          );
        }
        return renderProposeOutput(
          services,
          cwd,
          services.investigation.getInvestigationStatus(
            cwd,
            current.investigationId,
          ),
          'replay-consumed',
          null,
          undefined,
          options.collaborationGrantValidation,
          assertOwned,
        );
      }
      if (current.revision !== input.expectedRevision) {
        throw workflowError(
          'PROPOSE_INPUT_STALE',
          'Scan saturation acceptance is not bound to the current investigation revision.',
          ExitCode.staleState,
        );
      }
      const inspected = rebuildInvestigation(
        services,
        cwd,
        current.investigationId,
        'replay-consumed',
        options.collaborationGrantValidation,
        assertOwned,
        true,
      );
      if (
        canonicalJson(inspected.saturatedTermIds) !==
          canonicalJson(input.saturatedTermIds) ||
        inspected.saturatedTermIds.length === 0
      ) {
        throw workflowError(
          'INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_MISMATCH',
          'The acknowledged terms do not exactly match the current saturated scan terms.',
          ExitCode.staleState,
          {
            details: {
              expectedTermIds: inspected.saturatedTermIds,
              suppliedTermIds: input.saturatedTermIds,
            },
          },
        );
      }
      services.investigation.compareAndSwapInvestigationSession(
        context.runtime,
        current.investigationId,
        current.revision,
        (session) => ({
          ...session,
          revision: session.revision + 1,
          scanSaturationAcceptance: {
            envelopeDigest,
            envelope: input,
          },
          updatedAt: new Date().toISOString(),
        }),
      );
      assertOwned();
      return renderProposeOutput(
        services,
        cwd,
        services.investigation.getInvestigationStatus(
          cwd,
          current.investigationId,
        ),
        'replay-consumed',
        null,
        undefined,
        options.collaborationGrantValidation,
        assertOwned,
      );
    },
  );
}

function assertScanSaturationAcceptanceBinding(
  session: InvestigationSession,
  input: InvestigationScanSaturationAcceptanceEnvelope,
): void {
  if (
    session.investigationId !== input.investigationId ||
    session.changeId !== input.changeId ||
    canonicalJson(session.baseline) !== canonicalJson(input.baseline) ||
    session.intentDigest !== input.intentDigest ||
    session.blindManifestDigest !== input.blindManifestDigest ||
    session.milestones.mainTerms === null ||
    session.milestones.blindResult === null ||
    session.milestones.groupDispositions !== null
  ) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'Scan saturation acceptance is not bound to the current investigation scan.',
      ExitCode.staleState,
    );
  }
}

export function resumeProposeFromFile(
  planningExecution: PlanningTransitionExecutionServices,
  services: ProposeRuntime,
  cwd: string,
  changeId: string,
  inputPath: string,
  options: ProposeResumeOptions = {},
): ProposeOutput {
  return resumePropose(
    planningExecution,
    services,
    cwd,
    changeId,
    readCallerJson(cwd, inputPath),
    options,
  );
}

function isExactPublishedProviderProgressReplay(
  services: Pick<ProposeRuntime, 'investigation' | 'workspace'>,
  cwd: string,
  status: InvestigationStatus,
): boolean {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const session = services.investigation.readInvestigationSession(
    context.runtime,
    status.investigationId,
  );
  const published = session.milestones.blindResult;
  return (
    session.revision === status.revision &&
    session.currentBlindInvocationId === status.providerInvocationId &&
    published !== null &&
    published.invocationId === status.providerInvocationId &&
    published.requestDigest === session.blindRequestDigest &&
    published.outputDigest === status.provider.resultDigest &&
    status.provider.state === 'succeeded'
  );
}
