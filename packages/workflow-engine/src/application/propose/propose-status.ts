/**
 * Projects durable propose progress and the exact input needed for its next transition.
 *
 * Invariants:
 * - Status reads replay consumed grants without admitting reserved grants or provider work.
 * - Displayed planning and review progress agree with current receipts and reservations.
 * - Scaffold materialization retains held authority and a current investigation revision.
 */

import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type WorkflowPlanDigest } from '../../modules/guidance/renderers/plan-digest.ts';
import { type ReuseCoverageRecord } from '../../modules/why-knowledge/semantic-manifest-reuse.ts';
import {
  readPlanReviewGrantRequirement,
  readPlanReviewReservation,
  readTrackedPlanReview,
} from './plan-review-store.ts';
import {
  assertCurrentExemptionContext,
  resolveProposePlanningWorkspaceForInvestigation,
  withProposeTransitionAuthority,
} from './propose-context.ts';
import {
  exemptionPlanningContributionSchema,
  planningContributionSchema,
} from './propose-input.ts';
import { rebuildInvestigation } from './propose-investigation-rebuild.ts';
import {
  classSampleAuditsFor,
  renderPlanReviewProgressOutput,
  renderPlanReviewRequirementOutput,
  renderScanSaturationOutput,
  scanSaturationRequirement,
  workFromRebuilt,
} from './propose-output.ts';
import {
  projectExemptionPlanDigest,
  projectOrdinaryPlanDigest,
  readExemptionPlanningMaterializationReceipt,
  readMaterializedExemptionPlanningArtifacts,
  readMaterializedPlanningArtifacts,
} from './propose-planning-store.ts';
import {
  prepareExemptionPlanningScaffold,
  preparePlanningScaffold,
} from './propose-publication.ts';
import {
  inputSchemaForStatus,
  readProposeAuthorization,
} from './propose-request-validation.ts';
import type {
  InvestigationStatus,
  ProposeExemptionSession,
  ProposeRuntime,
} from './propose-runtime.ts';
import {
  type CollaborationGrantAccessMode,
  type ExemptionProposeOutput,
  type ProposeLifecycleStatus,
  type ProposeOutput,
  type ProposeResumeOptions,
  type ProposeWork,
  type RebuiltInvestigation,
} from './propose-types.ts';

function exemptionAwaitingPlanningOutput(
  session: ProposeExemptionSession,
  scaffold: ReturnType<typeof prepareExemptionPlanningScaffold>,
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

export function getExemptionProposeStatus(
  services: Pick<
    ProposeRuntime,
    'evidence' | 'investigation' | 'provider' | 'publication' | 'workspace'
  >,
  cwd: string,
  investigationId: string,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
): ExemptionProposeOutput {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const session = services.investigation.readProposeExemptionSession(
    context.runtime,
    investigationId,
  );
  assertCurrentExemptionContext(services, context, session);
  return renderExemptionProposeOutput(
    services,
    cwd,
    session,
    prepareExemptionPlanningScaffold(services, cwd, session, true, true, false),
    undefined,
    grantValidation,
  );
}

export function renderExemptionProposeOutput(
  services: Pick<
    ProposeRuntime,
    'evidence' | 'investigation' | 'provider' | 'publication' | 'workspace'
  >,
  cwd: string,
  session: ProposeExemptionSession,
  knownScaffold?: ReturnType<typeof prepareExemptionPlanningScaffold>,
  knownMaterializedArtifacts?: Record<string, string>,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
): ExemptionProposeOutput {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const receipt = readExemptionPlanningMaterializationReceipt(
    services,
    context.runtime,
    session,
  );
  if (receipt === null) {
    return exemptionAwaitingPlanningOutput(
      session,
      knownScaffold ??
        prepareExemptionPlanningScaffold(
          services,
          cwd,
          session,
          false,
          false,
          false,
        ),
    );
  }
  const scaffold =
    knownScaffold ??
    prepareExemptionPlanningScaffold(services, cwd, session, true, true, false);
  const materializedArtifacts =
    knownMaterializedArtifacts ??
    readMaterializedExemptionPlanningArtifacts(
      services,
      cwd,
      session,
      scaffold.changeDirectory,
    );
  return renderMaterializedProposeOutput(
    services,
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
    projectExemptionPlanDigest(services, cwd, session),
    null,
    [],
    { dropped: [], escalated: false },
    grantValidation,
  ) as ExemptionProposeOutput;
}

export function getProposeStatus(
  services: ProposeRuntime,
  cwd: string,
  requestedInvestigationId: string,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
): ProposeOutput {
  cwd = resolveProposePlanningWorkspaceForInvestigation(
    services,
    cwd,
    requestedInvestigationId,
  );
  return getProposeStatusInternal(
    services,
    cwd,
    requestedInvestigationId,
    grantValidation,
  );
}

export function getProposeStatusInternal(
  services: ProposeRuntime,
  cwd: string,
  requestedInvestigationId: string,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
  assertOwned?: () => void,
): ProposeOutput {
  if (
    services.investigation.isProposeExemptionInvestigationId(
      requestedInvestigationId,
    )
  ) {
    return getExemptionProposeStatus(
      services,
      cwd,
      requestedInvestigationId,
      grantValidation,
    );
  }
  const status = services.investigation.getInvestigationStatus(
    cwd,
    requestedInvestigationId,
  );
  assertOwned?.();
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const request = services.provider.readProviderInvocationRequest(
    context.runtime,
    status.providerInvocationId,
  );
  const authorization = readProposeAuthorization(
    services,
    context.runtime,
    request,
  );
  const actorResolution: ProposeOutput['actorResolution'] = {
    outcome: 'resolved',
    providerId: authorization.actor.providerId,
    assurance: authorization.actor.assurance,
    signals: authorization.signals,
  };
  if (status.state !== 'investigation-sealed') {
    return renderProposeOutput(
      services,
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
      services,
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
      services,
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
    services,
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
    services,
    cwd,
    status,
    actorResolution,
    createdDate,
    workFromRebuilt(rebuilt, []),
    materialized,
    projectOrdinaryPlanDigest(services, cwd, rebuilt),
    rebuilt.reuseCoverage,
    classSampleAuditsFor(rebuilt),
    rebuilt.floorTrimming,
    grantValidation,
  );
}

export function renderProposeOutputWithPlanningAuthority(
  services: ProposeRuntime,
  cwd: string,
  status: InvestigationStatus,
  actorResolution: ProposeOutput['actorResolution'] = null,
  grantValidation?: ProposeResumeOptions['collaborationGrantValidation'],
): ProposeOutput {
  if (status.state !== 'investigation-sealed') {
    return renderProposeOutput(
      services,
      cwd,
      status,
      'consume',
      actorResolution,
      undefined,
      grantValidation,
    );
  }
  const initialContext =
    services.workspace.loadInvestigationRuntimeContext(cwd);
  return withProposeTransitionAuthority(
    services,
    cwd,
    initialContext.lifecycleRuntime,
    status.changeId,
    (assertOwned) => {
      assertOwned();
      const current = services.investigation.getInvestigationStatus(
        cwd,
        status.investigationId,
      );
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
        services,
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

export function renderProposeOutput(
  services: ProposeRuntime,
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
      services,
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
      services,
      services.workspace.loadInvestigationRuntimeContext(cwd),
      status,
      actorResolution,
      requirement,
    );
  }
  const createdDate = rebuilt.session.createdAt.slice(0, 10);
  if (status.state === 'investigation-sealed') {
    const context = services.workspace.loadInvestigationRuntimeContext(cwd);
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
      readMaterializedPlanningArtifacts(
        services,
        cwd,
        status,
        rebuilt,
        receiptLookup,
      );
    if (materialized !== null) {
      return renderMaterializedProposeOutput(
        services,
        cwd,
        status,
        actorResolution,
        createdDate,
        workFromRebuilt(rebuilt, receiptLookup.instructions),
        materialized,
        projectOrdinaryPlanDigest(services, cwd, rebuilt),
        rebuilt.reuseCoverage,
        classSampleAuditsFor(rebuilt),
        rebuilt.floorTrimming,
        grantValidation,
      );
    }
    const scaffold = preparePlanningScaffold(
      services,
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
    inputSchema: inputSchemaForStatus(services, cwd, status, work),
    work,
    materializedArtifacts: null,
    planReview: null,
    planningTransition: null,
    semanticReuse: rebuilt.reuseCoverage,
    classSampleAudits: classSampleAuditsFor(rebuilt),
    floorTrimming: rebuilt.floorTrimming,
  };
}

function renderScanSaturationAcceptanceRequired(
  services: Pick<ProposeRuntime, 'investigation'>,
  context: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >,
  status: InvestigationStatus,
  actorResolution: ProposeOutput['actorResolution'],
  requirement: {
    saturatedTermIds: string[];
    floorTrimming: ProposeOutput['floorTrimming'];
  },
): ProposeOutput {
  const session = services.investigation.readInvestigationSession(
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

function renderMaterializedProposeOutput(
  services: Pick<ProposeRuntime, 'evidence' | 'provider' | 'workspace'>,
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
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const reservation = readPlanReviewReservation(
    services,
    context.runtime,
    status,
  );
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
      services,
      context.runtime,
      status,
    );
    return renderPlanReviewRequirementOutput(presentation, grantRequirement);
  }
  if (
    !services.provider.providerInvocationExists(
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
  const invocation = services.provider.readProviderInvocation(
    context.runtime,
    reservation.request.invocationId,
  );
  const trackedReview = readTrackedPlanReview(
    services,
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
