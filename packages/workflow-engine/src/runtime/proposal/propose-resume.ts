import type { createPlanReviewCompletion } from './plan-review-completion.ts';
import type { createPlanReviewRetry } from './plan-review-retry.ts';
import type { createProposeContext } from './propose-context.ts';
import type { createInvestigationFacts } from './propose-investigation-facts.ts';
import type { createInvestigationRebuild } from './propose-investigation-rebuild.ts';
import type { createPlanningMaterialization } from './propose-planning-materialization.ts';
import type { createProposeProviderLifecycle } from './propose-provider-lifecycle.ts';
import type { createReviewerReconciliation } from './propose-reviewer-reconciliation.ts';
import type { createProposeStart } from './propose-start.ts';
import type { createProposeStatus } from './propose-status.ts';
import type { PlanningTransitionExecutionServices } from '../../modules/lifecycle/planning-execution-epoch.ts';
import type {
  InvestigationCheckpointEnvelope,
  InvestigationScanSaturationAcceptanceEnvelope,
  InvestigationSession,
} from '../../modules/investigation/domain/investigation-session-types.ts';
import type {
  ProposeResumeOptions,
  ProposeOutput,
} from '../../modules/proposal/propose-types.ts';

import {
  assertProposeInput,
  assertPlanningBinding,
  assertProgressBinding,
} from '../../modules/proposal/propose-input.ts';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';

import type { InvestigationStatus } from '../../modules/lifecycle/investigation-status.ts';
import { mergeReviewerReopenCheckpoint } from '../../modules/proposal/propose-reviewer-checkpoint.ts';
import { expandSubmittedDispositions } from './propose-investigation-facts.ts';
import { materializeInvestigationEvidenceViewFromFacts } from '../../modules/investigation/manifest/investigation-materializer.ts';

import { assertChangeId } from '../../foundation/repository-path/repository-path.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import { getInvestigationStatus } from '../investigation-lifecycle/investigation-session.ts';
import {
  assertInvestigationCheckpointEnvelope,
  checkpointContributionDigest,
  scanSaturationAcceptanceEnvelopeDigest,
} from '../../modules/investigation/domain/investigation-checkpoint-contract.ts';
import {
  readInvestigationSession,
  compareAndSwapInvestigationSession,
} from '../storage-journal/investigation-session-records.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { readCallerJson } from './propose-artifacts.ts';
export function createProposeResumption({
  buildWhyAuthoringFromCheckpoint,
  completePlanReviewDispositions,
  dispatchPreparedInvocation,
  dispatchPreparedPlanReview,
  getProposeStatus,
  materializePlanningContribution,
  rebuildInvestigation,
  reconcileReviewerTermPlanningRevision,
  renderProposeOutput,
  renderProposeOutputWithPlanningAuthority,
  resolveProposePlanningWorkspace,
  resumeExemptionPlanningContribution,
  resumeInvestigationForPropose,
  resumePlanReview,
  resumePlanReviewRetry,
  resumeProviderRetry,
  withProposeTransitionAuthority,
}: {
  buildWhyAuthoringFromCheckpoint: ReturnType<
    typeof createInvestigationFacts
  >['buildWhyAuthoringFromCheckpoint'];
  completePlanReviewDispositions: ReturnType<
    typeof createPlanReviewCompletion
  >['completePlanReviewDispositions'];
  dispatchPreparedInvocation: ReturnType<
    typeof createProposeProviderLifecycle
  >['dispatchPreparedInvocation'];
  dispatchPreparedPlanReview: ReturnType<
    typeof createProposeProviderLifecycle
  >['dispatchPreparedPlanReview'];
  getProposeStatus: ReturnType<typeof createProposeStatus>['getProposeStatus'];
  materializePlanningContribution: ReturnType<
    typeof createPlanningMaterialization
  >['materializePlanningContribution'];
  rebuildInvestigation: ReturnType<
    typeof createInvestigationRebuild
  >['rebuildInvestigation'];
  reconcileReviewerTermPlanningRevision: ReturnType<
    typeof createReviewerReconciliation
  >['reconcileReviewerTermPlanningRevision'];
  renderProposeOutput: ReturnType<
    typeof createProposeStatus
  >['renderProposeOutput'];
  renderProposeOutputWithPlanningAuthority: ReturnType<
    typeof createProposeStatus
  >['renderProposeOutputWithPlanningAuthority'];
  resolveProposePlanningWorkspace: ReturnType<
    typeof createProposeContext
  >['resolveProposePlanningWorkspace'];
  resumeExemptionPlanningContribution: ReturnType<
    typeof createProposeStart
  >['resumeExemptionPlanningContribution'];
  resumeInvestigationForPropose: ReturnType<
    typeof createProposeContext
  >['resumeInvestigationForPropose'];
  resumePlanReview: ReturnType<
    typeof createPlanReviewCompletion
  >['resumePlanReview'];
  resumePlanReviewRetry: ReturnType<
    typeof createPlanReviewRetry
  >['resumePlanReviewRetry'];
  resumeProviderRetry: ReturnType<
    typeof createProposeProviderLifecycle
  >['resumeProviderRetry'];
  withProposeTransitionAuthority: ReturnType<
    typeof createProposeContext
  >['withProposeTransitionAuthority'];
}) {
  function resumePropose(
    planningExecution: PlanningTransitionExecutionServices,
    cwd: string,
    requestedChangeId: string,
    inputValue: unknown,
    options: ProposeResumeOptions = {},
  ): ProposeOutput {
    const changeId = assertChangeId(requestedChangeId);
    const input = assertProposeInput(inputValue);
    if (input.changeId !== changeId) {
      throw workflowError(
        'PROPOSE_INPUT_STALE',
        'Propose input belongs to another change.',
        ExitCode.staleState,
      );
    }
    cwd = resolveProposePlanningWorkspace(cwd, changeId, 'resume');
    if (input.kind === 'exemption-planning-contribution') {
      return resumeExemptionPlanningContribution(cwd, input, options);
    }
    if (input.kind === 'scan-saturation-acceptance') {
      return resumeScanSaturationAcceptance(cwd, input, options);
    }
    if (input.kind === 'planning-contribution') {
      const initialContext = loadInvestigationRuntimeContext(cwd);
      const output = withProposeTransitionAuthority(
        cwd,
        initialContext.lifecycleRuntime,
        changeId,
        (assertOwned) => {
          assertOwned();
          const status = getInvestigationStatus(cwd, input.investigationId);
          assertPlanningBinding(status, input);
          if (status.state !== 'investigation-sealed') {
            throw workflowError(
              'INVESTIGATION_NOT_SEALED',
              'Planning materialization requires a sealed investigation.',
              ExitCode.guard,
            );
          }
          const rebuilt = rebuildInvestigation(
            cwd,
            status.investigationId,
            'consume',
            options.collaborationGrantValidation,
            assertOwned,
          );
          assertOwned();
          const materializedArtifacts = materializePlanningContribution(
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
          const current = getInvestigationStatus(cwd, input.investigationId);
          assertPlanningBinding(current, input);
          return renderProposeOutput(
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
      dispatchPreparedPlanReview(cwd, output, options);
      return getProposeStatus(
        cwd,
        input.investigationId,
        options.collaborationGrantValidation,
      );
    }

    if (input.kind === 'plan-review-progress') {
      return resumePlanReview(planningExecution, cwd, input, options);
    }

    if (input.kind === 'plan-review-dispositions') {
      return completePlanReviewDispositions(
        planningExecution,
        cwd,
        input,
        options,
      );
    }

    if (input.kind === 'provider-retry') {
      return resumeProviderRetry(cwd, input, options);
    }

    if (input.kind === 'plan-review-retry') {
      return resumePlanReviewRetry(cwd, input, options);
    }

    if (input.kind === 'provider-progress') {
      const current = getInvestigationStatus(cwd, input.investigationId);
      assertProgressBinding(current, input);
      let resumed: InvestigationStatus;
      if (current.revision === input.expectedRevision) {
        dispatchPreparedInvocation(cwd, current, options.providerDispatcher);
        resumed = resumeInvestigationForPropose(
          cwd,
          changeId,
          input.investigationId,
        );
      } else if (
        current.revision === input.expectedRevision + 1 &&
        isExactPublishedProviderProgressReplay(cwd, current)
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
        cwd,
        resumed,
        null,
        options.collaborationGrantValidation,
      );
    }

    const suppliedCheckpoint = assertInvestigationCheckpointEnvelope(input);
    const before = getInvestigationStatus(
      cwd,
      suppliedCheckpoint.investigationId,
    );
    dispatchPreparedInvocation(cwd, before, options.providerDispatcher);
    let checkpoint = suppliedCheckpoint;
    if (checkpoint.kind === 'group-dispositions') {
      const rebuilt = rebuildInvestigation(
        cwd,
        before.investigationId,
        'consume',
        options.collaborationGrantValidation,
      );
      const effectiveCheckpoint = mergeReviewerReopenCheckpoint(
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
        loadInvestigationRuntimeContext(cwd).git.repositoryRoot,
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
              provenance: `checkpoint:${checkpointContributionDigest(effectiveCheckpoint)}`,
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
        cwd,
        before.investigationId,
        'consume',
        options.collaborationGrantValidation,
      );
      const effectiveCheckpoint = mergeReviewerReopenCheckpoint(
        rebuilt,
        checkpoint,
      ) as Extract<InvestigationCheckpointEnvelope, { kind: 'why-answers' }>;
      checkpoint = effectiveCheckpoint;
      try {
        buildWhyAuthoringFromCheckpoint({
          repositoryRoot:
            loadInvestigationRuntimeContext(cwd).git.repositoryRoot,
          rebuilt,
          answers: effectiveCheckpoint.payload.answers,
          checkpointProvenanceDigest:
            checkpointContributionDigest(effectiveCheckpoint),
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
        cwd,
        changeId,
        checkpoint.investigationId,
      );
    }
    if (
      status.state === 'investigation-sealed' &&
      readInvestigationSession(
        loadInvestigationRuntimeContext(cwd).runtime,
        status.investigationId,
      ).milestones.reviewerTermSourceNodeId !== null
    ) {
      return reconcileReviewerTermPlanningRevision(cwd, status, options);
    }
    return renderProposeOutputWithPlanningAuthority(
      cwd,
      status,
      null,
      options.collaborationGrantValidation,
    );
  }

  function resumeScanSaturationAcceptance(
    cwd: string,
    input: InvestigationScanSaturationAcceptanceEnvelope,
    options: ProposeResumeOptions,
  ): ProposeOutput {
    const initialContext = loadInvestigationRuntimeContext(cwd);
    return withProposeTransitionAuthority(
      cwd,
      initialContext.lifecycleRuntime,
      input.changeId,
      (assertOwned) => {
        assertOwned();
        const context = loadInvestigationRuntimeContext(cwd);
        const current = readInvestigationSession(
          context.runtime,
          input.investigationId,
        );
        assertScanSaturationAcceptanceBinding(current, input);
        const envelopeDigest = scanSaturationAcceptanceEnvelopeDigest(input);
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
            cwd,
            getInvestigationStatus(cwd, current.investigationId),
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
        compareAndSwapInvestigationSession(
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
          cwd,
          getInvestigationStatus(cwd, current.investigationId),
          'replay-consumed',
          null,
          undefined,
          options.collaborationGrantValidation,
          assertOwned,
        );
      },
    );
  }

  function resumeProposeFromFile(
    planningExecution: PlanningTransitionExecutionServices,
    cwd: string,
    changeId: string,
    inputPath: string,
    options: ProposeResumeOptions = {},
  ): ProposeOutput {
    return resumePropose(
      planningExecution,
      cwd,
      changeId,
      readCallerJson(cwd, inputPath),
      options,
    );
  }
  return { resumePropose, resumeProposeFromFile };
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

function isExactPublishedProviderProgressReplay(
  cwd: string,
  status: InvestigationStatus,
): boolean {
  const context = loadInvestigationRuntimeContext(cwd);
  const session = readInvestigationSession(
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
