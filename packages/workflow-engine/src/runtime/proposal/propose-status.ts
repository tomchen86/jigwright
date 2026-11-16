import type { createPlanReviewStore } from './plan-review-store.ts';
import type { createProposeContext } from './propose-context.ts';
import type { createInvestigationRebuild } from './propose-investigation-rebuild.ts';
import type { createPlanningStore } from './propose-planning-store.ts';
import type { createProposePublication } from './propose-publication.ts';
import path from 'node:path';
import type { ProposeExemptionSession } from '../../modules/lifecycle/propose-exemption-session.ts';

import type {
  ExemptionProposeOutput,
  ProposeResumeOptions,
  ProposeOutput,
  RebuiltInvestigation,
  CollaborationGrantAccessMode,
  ProposeWork,
  ProposeLifecycleStatus,
} from '../../modules/proposal/propose-types.ts';
import {
  exemptionPlanningContributionSchema,
  planningContributionSchema,
} from '../../modules/proposal/propose-input.ts';
import { assertCurrentExemptionContext } from './propose-context.ts';

import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import { readProposeExemptionSession } from '../storage-journal/propose-exemption-store.ts';
import {
  readExemptionPlanningMaterializationReceipt,
  projectExemptionPlanDigest,
  projectOrdinaryPlanDigest,
} from './propose-planning-store.ts';
import {
  readProposeAuthorization,
  inputSchemaForStatus,
} from './propose-request-validation.ts';

import {
  scanSaturationRequirement,
  workFromRebuilt,
  classSampleAuditsFor,
  renderScanSaturationOutput,
  renderPlanReviewRequirementOutput,
  renderPlanReviewProgressOutput,
} from '../../modules/proposal/propose-output.ts';
import { isProposeExemptionInvestigationId } from '../../modules/investigation/domain/investigation-store-values.ts';
import { getInvestigationStatus } from '../investigation-lifecycle/investigation-session.ts';
import {
  readProviderInvocationRequest,
  providerInvocationExists,
} from '../storage-journal/provider-invocation-artifacts.ts';
import type { InvestigationStatus } from '../../modules/lifecycle/investigation-status.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { readInvestigationSession } from '../storage-journal/investigation-session-records.ts';
import type { WorkflowPlanDigest } from '../../modules/guidance/renderers/plan-digest.ts';
import type { ReuseCoverageRecord } from '../../modules/assurance/review-coverage.ts';
import {
  readPlanReviewReservation,
  readPlanReviewGrantRequirement,
} from './plan-review-store.ts';
import { readProviderInvocation } from '../storage-journal/provider-invocation-state.ts';

function exemptionAwaitingPlanningOutput(
  session: ProposeExemptionSession,
  scaffold: ReturnType<
    ReturnType<
      typeof createProposePublication
    >['prepareExemptionPlanningScaffold']
  >,
): ExemptionProposeOutput {
  return {
    schemaVersion: 1,
    kind: 'workflow-propose',
    changeId: session.changeId,
    state: 'awaiting-planning-contribution',
    nextAction: 'submit-planning-contribution',
    investigation: session,
    createdDate: session.createdAt.slice(0, 10),
    actorResolution: {
      outcome: 'resolved',
      providerId: session.actor.providerId,
      assurance: session.actor.assurance,
      signals: session.signals,
    },
    inputSchema: exemptionPlanningContributionSchema(session),
    work: {
      termSources: { engine: 0, main: 0, reviewer: 0, survey: 0 },
      groups: [],
      fullBlobManifest: [],
      authoredInstructions: scaffold.instructions,
    },
    materializedArtifacts: null,
    planReview: null,
    planningTransition: null,
    semanticReuse: null,
    classSampleAudits: [],
    floorTrimming: { dropped: [], escalated: false },
  };
}
export function createProposeStatus({
  prepareExemptionPlanningScaffold,
  preparePlanningScaffold,
  readMaterializedExemptionPlanningArtifacts,
  readMaterializedPlanningArtifacts,
  readTrackedPlanReview,
  rebuildInvestigation,
  resolveProposePlanningWorkspaceForInvestigation,
  withProposeTransitionAuthority,
}: {
  prepareExemptionPlanningScaffold: ReturnType<
    typeof createProposePublication
  >['prepareExemptionPlanningScaffold'];
  preparePlanningScaffold: ReturnType<
    typeof createProposePublication
  >['preparePlanningScaffold'];
  readMaterializedExemptionPlanningArtifacts: ReturnType<
    typeof createPlanningStore
  >['readMaterializedExemptionPlanningArtifacts'];
  readMaterializedPlanningArtifacts: ReturnType<
    typeof createPlanningStore
  >['readMaterializedPlanningArtifacts'];
  readTrackedPlanReview: ReturnType<
    typeof createPlanReviewStore
  >['readTrackedPlanReview'];
  rebuildInvestigation: ReturnType<
    typeof createInvestigationRebuild
  >['rebuildInvestigation'];
  resolveProposePlanningWorkspaceForInvestigation: ReturnType<
    typeof createProposeContext
  >['resolveProposePlanningWorkspaceForInvestigation'];
  withProposeTransitionAuthority: ReturnType<
    typeof createProposeContext
  >['withProposeTransitionAuthority'];
}) {
  function getExemptionProposeStatus(
    cwd: string,
    investigationId: string,
    grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  ): ExemptionProposeOutput {
    const context = loadInvestigationRuntimeContext(cwd);
    const session = readProposeExemptionSession(
      context.runtime,
      investigationId,
    );
    assertCurrentExemptionContext(context, session);
    return renderExemptionProposeOutput(
      cwd,
      session,
      prepareExemptionPlanningScaffold(cwd, session, true, true, false),
      undefined,
      grantValidation,
    );
  }

  function renderExemptionProposeOutput(
    cwd: string,
    session: ProposeExemptionSession,
    knownScaffold?: ReturnType<
      ReturnType<
        typeof createProposePublication
      >['prepareExemptionPlanningScaffold']
    >,
    knownMaterializedArtifacts?: Record<string, string>,
    grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  ): ExemptionProposeOutput {
    const context = loadInvestigationRuntimeContext(cwd);
    const receipt = readExemptionPlanningMaterializationReceipt(
      context.runtime,
      session,
    );
    if (receipt === null) {
      return exemptionAwaitingPlanningOutput(
        session,
        knownScaffold ??
          prepareExemptionPlanningScaffold(cwd, session, false, false, false),
      );
    }
    const scaffold =
      knownScaffold ??
      prepareExemptionPlanningScaffold(cwd, session, true, true, false);
    const materializedArtifacts =
      knownMaterializedArtifacts ??
      readMaterializedExemptionPlanningArtifacts(
        cwd,
        session,
        scaffold.changeDirectory,
      );
    return renderMaterializedProposeOutput(
      cwd,
      session,
      {
        outcome: 'resolved',
        providerId: session.actor.providerId,
        assurance: session.actor.assurance,
        signals: session.signals,
      },
      session.createdAt.slice(0, 10),
      {
        termSources: { engine: 0, main: 0, reviewer: 0, survey: 0 },
        groups: [],
        fullBlobManifest: [],
        authoredInstructions: scaffold.instructions,
      },
      materializedArtifacts,
      projectExemptionPlanDigest(cwd, session),
      null,
      [],
      { dropped: [], escalated: false },
      grantValidation,
    ) as ExemptionProposeOutput;
  }

  function getProposeStatus(
    cwd: string,
    requestedInvestigationId: string,
    grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  ): ProposeOutput {
    cwd = resolveProposePlanningWorkspaceForInvestigation(
      cwd,
      requestedInvestigationId,
    );
    return getProposeStatusInternal(
      cwd,
      requestedInvestigationId,
      grantValidation,
    );
  }

  function getProposeStatusInternal(
    cwd: string,
    requestedInvestigationId: string,
    grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
    assertOwned?: () => void,
  ): ProposeOutput {
    if (isProposeExemptionInvestigationId(requestedInvestigationId)) {
      return getExemptionProposeStatus(
        cwd,
        requestedInvestigationId,
        grantValidation,
      );
    }
    const status = getInvestigationStatus(cwd, requestedInvestigationId);
    assertOwned?.();
    const context = loadInvestigationRuntimeContext(cwd);
    const request = readProviderInvocationRequest(
      context.runtime,
      status.providerInvocationId,
    );
    const authorization = readProposeAuthorization(context.runtime, request);
    const actorResolution: ProposeOutput['actorResolution'] = {
      outcome: 'resolved',
      providerId: authorization.actor.providerId,
      assurance: authorization.actor.assurance,
      signals: authorization.signals,
    };
    if (status.state !== 'investigation-sealed') {
      return renderProposeOutput(
        cwd,
        status,
        'replay-consumed',
        actorResolution,
        undefined,
        grantValidation,
        assertOwned,
      );
    }

    let rebuilt: RebuiltInvestigation;
    try {
      rebuilt = rebuildInvestigation(
        cwd,
        status.investigationId,
        'replay-consumed',
        grantValidation,
        assertOwned,
      );
    } catch (error) {
      const requirement = scanSaturationRequirement(error);
      if (requirement === null) {
        throw error;
      }
      return renderScanSaturationAcceptanceRequired(
        context,
        status,
        actorResolution,
        requirement,
      );
    }

    const scaffold = {
      changeDirectory: path.join(
        context.git.repositoryRoot,
        context.config.changeRoot,
        status.changeId,
      ),
      investigationBytes: '',
    };
    const materialized = readMaterializedPlanningArtifacts(
      cwd,
      status,
      rebuilt,
      scaffold,
    );
    const createdDate = rebuilt.session.createdAt.slice(0, 10);
    if (materialized === null) {
      return {
        schemaVersion: 1,
        kind: 'workflow-propose',
        changeId: status.changeId,
        state: 'awaiting-planning-contribution',
        nextAction: 'submit-planning-contribution',
        investigation: status,
        createdDate,
        actorResolution,
        inputSchema: planningContributionSchema(status),
        work: workFromRebuilt(rebuilt, []),
        materializedArtifacts: null,
        planReview: null,
        planningTransition: null,
        semanticReuse: rebuilt.reuseCoverage,
        classSampleAudits: classSampleAuditsFor(rebuilt),
        floorTrimming: rebuilt.floorTrimming,
      };
    }
    return renderMaterializedProposeOutput(
      cwd,
      status,
      actorResolution,
      createdDate,
      workFromRebuilt(rebuilt, []),
      materialized,
      projectOrdinaryPlanDigest(cwd, rebuilt),
      rebuilt.reuseCoverage,
      classSampleAuditsFor(rebuilt),
      rebuilt.floorTrimming,
      grantValidation,
    );
  }

  function renderProposeOutputWithPlanningAuthority(
    cwd: string,
    status: InvestigationStatus,
    actorResolution: ProposeOutput['actorResolution'] = null,
    grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  ): ProposeOutput {
    if (status.state !== 'investigation-sealed') {
      return renderProposeOutput(
        cwd,
        status,
        'consume',
        actorResolution,
        undefined,
        grantValidation,
      );
    }
    const initialContext = loadInvestigationRuntimeContext(cwd);
    return withProposeTransitionAuthority(
      cwd,
      initialContext.lifecycleRuntime,
      status.changeId,
      (assertOwned) => {
        assertOwned();
        const current = getInvestigationStatus(cwd, status.investigationId);
        if (
          current.revision !== status.revision ||
          current.changeId !== status.changeId ||
          canonicalJson(current.baseline) !== canonicalJson(status.baseline)
        ) {
          throw workflowError(
            'PROPOSE_INPUT_STALE',
            'Investigation changed before planning scaffold materialization.',
            ExitCode.staleState,
          );
        }
        const result = renderProposeOutput(
          cwd,
          current,
          'consume',
          actorResolution,
          undefined,
          grantValidation,
          assertOwned,
        );
        assertOwned();
        return result;
      },
    );
  }

  function renderProposeOutput(
    cwd: string,
    status: InvestigationStatus,
    grantAccess: CollaborationGrantAccessMode,
    actorResolution: ProposeOutput['actorResolution'] = null,
    knownMaterializedArtifacts?: Record<string, string>,
    grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
    assertOwned?: () => void,
  ): ProposeOutput {
    let rebuilt: RebuiltInvestigation;
    try {
      rebuilt = rebuildInvestigation(
        cwd,
        status.investigationId,
        grantAccess,
        grantValidation,
        assertOwned,
      );
    } catch (error) {
      const requirement = scanSaturationRequirement(error);
      if (requirement === null) {
        throw error;
      }
      return renderScanSaturationAcceptanceRequired(
        loadInvestigationRuntimeContext(cwd),
        status,
        actorResolution,
        requirement,
      );
    }
    const createdDate = rebuilt.session.createdAt.slice(0, 10);
    if (status.state === 'investigation-sealed') {
      const context = loadInvestigationRuntimeContext(cwd);
      const receiptLookup = {
        changeDirectory: path.join(
          context.git.repositoryRoot,
          context.config.changeRoot,
          status.changeId,
        ),
        investigationBytes: '',
        instructions: [] as ProposeWork['authoredInstructions'],
      };
      const materialized =
        knownMaterializedArtifacts ??
        readMaterializedPlanningArtifacts(cwd, status, rebuilt, receiptLookup);
      if (materialized !== null) {
        return renderMaterializedProposeOutput(
          cwd,
          status,
          actorResolution,
          createdDate,
          workFromRebuilt(rebuilt, receiptLookup.instructions),
          materialized,
          projectOrdinaryPlanDigest(cwd, rebuilt),
          rebuilt.reuseCoverage,
          classSampleAuditsFor(rebuilt),
          rebuilt.floorTrimming,
          grantValidation,
        );
      }
      const scaffold = preparePlanningScaffold(
        cwd,
        status,
        rebuilt,
        createdDate,
        false,
        assertOwned !== undefined,
        assertOwned,
      );
      return {
        schemaVersion: 1,
        kind: 'workflow-propose',
        changeId: status.changeId,
        state: 'awaiting-planning-contribution',
        nextAction: 'submit-planning-contribution',
        investigation: status,
        createdDate,
        actorResolution,
        inputSchema: planningContributionSchema(status),
        work: workFromRebuilt(rebuilt, scaffold.instructions),
        materializedArtifacts: null,
        planReview: null,
        planningTransition: null,
        semanticReuse: rebuilt.reuseCoverage,
        classSampleAudits: classSampleAuditsFor(rebuilt),
        floorTrimming: rebuilt.floorTrimming,
      };
    }

    const work = workFromRebuilt(rebuilt, []);
    return {
      schemaVersion: 1,
      kind: 'workflow-propose',
      changeId: status.changeId,
      state: status.state,
      nextAction: status.nextAction,
      investigation: status,
      createdDate,
      actorResolution,
      inputSchema: inputSchemaForStatus(cwd, status, work),
      work,
      materializedArtifacts: null,
      planReview: null,
      planningTransition: null,
      semanticReuse: rebuilt.reuseCoverage,
      classSampleAudits: classSampleAuditsFor(rebuilt),
      floorTrimming: rebuilt.floorTrimming,
    };
  }

  function renderMaterializedProposeOutput(
    cwd: string,
    status: ProposeLifecycleStatus,
    actorResolution: ProposeOutput['actorResolution'],
    createdDate: string,
    work: ProposeWork,
    materializedArtifacts: Record<string, string>,
    planDigest: WorkflowPlanDigest,
    semanticReuse: ReuseCoverageRecord | null = null,
    classSampleAudits: ProposeOutput['classSampleAudits'] = [],
    floorTrimming: ProposeOutput['floorTrimming'] = {
      dropped: [],
      escalated: false,
    },
    grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  ): ProposeOutput {
    const context = loadInvestigationRuntimeContext(cwd);
    const reservation = readPlanReviewReservation(context.runtime, status);
    const presentation = {
      status,
      actorResolution,
      createdDate,
      work,
      materializedArtifacts,
      planDigest,
      semanticReuse,
      classSampleAudits,
      floorTrimming,
    };
    if (reservation === null) {
      const grantRequirement = readPlanReviewGrantRequirement(
        context.runtime,
        status,
      );
      return renderPlanReviewRequirementOutput(presentation, grantRequirement);
    }
    if (
      !providerInvocationExists(
        context.runtime,
        reservation.request.invocationId,
      )
    ) {
      throw workflowError(
        'PLAN_REVIEW_INVOCATION_MISSING',
        'Plan-review status cannot repair a missing provider invocation.',
        ExitCode.staleState,
      );
    }
    const invocation = readProviderInvocation(
      context.runtime,
      reservation.request.invocationId,
    );
    const trackedReview = readTrackedPlanReview(
      context.git.repositoryRoot,
      status.changeId,
      {
        subject: reservation.subject,
        consumedPlanReviewReplay: grantValidation?.consumedPlanReviewReplay,
      },
    );
    return renderPlanReviewProgressOutput(
      presentation,
      reservation,
      invocation,
      trackedReview,
    );
  }
  return {
    getExemptionProposeStatus,
    renderExemptionProposeOutput,
    getProposeStatus,
    getProposeStatusInternal,
    renderProposeOutputWithPlanningAuthority,
    renderProposeOutput,
  };
}

function renderScanSaturationAcceptanceRequired(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  status: InvestigationStatus,
  actorResolution: ProposeOutput['actorResolution'],
  requirement: {
    saturatedTermIds: string[];
    floorTrimming: ProposeOutput['floorTrimming'];
  },
): ProposeOutput {
  const session = readInvestigationSession(
    context.runtime,
    status.investigationId,
  );
  return renderScanSaturationOutput(
    status,
    actorResolution,
    session.createdAt.slice(0, 10),
    requirement,
  );
}
