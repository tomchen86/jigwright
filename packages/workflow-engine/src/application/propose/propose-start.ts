/**
 * Starts ordinary investigations and carries structured exemptions into planning.
 *
 * Invariants:
 * - Repeated starts reuse the exact durable request, actor, intent, and baseline.
 * - Ordinary and exemption branches cannot both own the current change.
 * - Survey dispatch follows durable authorization and session creation.
 */

import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertActiveTaskMandateBindingUnderLifecycleLock,
  authorizeTaskMandateOperation,
  type TaskMandateBinding,
} from '../../modules/authority/task-mandate.ts';
import {
  createInvestigationApplicability,
  INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
} from '../../modules/investigation/domain/investigation-applicability.ts';
import { resolveActorIdentity } from '../../modules/provider-orchestration/actor-identity.ts';
import { createProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  authorizeGrantedOrdinaryRole,
  scheduleOrdinaryRole,
  type GrantedSameProviderRoleAssignment,
  type ProviderRoleAssignment,
  type RoleParticipant,
} from '../../modules/provider-orchestration/role-scheduler.ts';
import {
  blindSurveyGrantRequest,
  collaborationTransitionDigest,
  type ProposeGrantAuthorization,
} from './plan-review-contracts.ts';
import { readCallerJson } from './propose-artifacts.ts';
import { createRuntimeId, sha256 } from './propose-common.ts';
import {
  assertCurrentExemptionContext,
  assertCurrentGovernanceSources,
  assertProposeStartContextStable,
  currentExemptionContextMatches,
  deriveCollaborationGrantBinding,
  resolveAuthoritativeCollaborationGrantVerifier,
  resolveImmediateSource,
  resolveProposePlanningWorkspace,
  withProposeTransitionAuthority,
} from './propose-context.ts';
import { createProposeAuthorizationNode } from './propose-evidence.ts';
import {
  assertExemptionPlanningBinding,
  isInvestigationExemptionRequest,
} from './propose-input.ts';
import { collaborationGrantRequiredOutput } from './propose-output.ts';
import { materializeExemptionPlanningContribution } from './propose-planning-materialization.ts';
import {
  dispatchMandatedProviderInvocation,
  dispatchPreparedPlanReview,
} from './propose-provider-lifecycle.ts';
import { prepareExemptionPlanningScaffold } from './propose-publication.ts';
import {
  assertProposeStartInput,
  readProposeAuthorization,
} from './propose-request-validation.ts';
import type {
  BlindSurveyManifest,
  InvestigationStatus,
  NormalizedChangeIntent,
  ProposeRuntime,
} from './propose-runtime.ts';
import {
  getExemptionProposeStatus,
  renderExemptionProposeOutput,
  renderProposeOutputWithPlanningAuthority,
} from './propose-status.ts';
import {
  type ExemptionPlanningContributionEnvelope,
  type ExemptionProposeOutput,
  type InvestigationExemptionRequest,
  type OrdinaryProposeOutput,
  type ProposeOptions,
  type ProposeOutput,
  type ProposeResumeOptions,
} from './propose-types.ts';

export function startPropose(
  services: ProposeRuntime,
  cwd: string,
  requestedChangeId: string,
  intentInput: NormalizedChangeIntent,
  options?: ProposeOptions,
): OrdinaryProposeOutput;

export function startPropose(
  services: ProposeRuntime,
  cwd: string,
  requestedChangeId: string,
  intentInput: InvestigationExemptionRequest,
  options?: ProposeOptions,
): ExemptionProposeOutput;

export function startPropose(
  services: ProposeRuntime,
  cwd: string,
  requestedChangeId: string,
  intentInput: unknown,
  options?: ProposeOptions,
): ProposeOutput;

export function startPropose(
  services: ProposeRuntime,
  cwd: string,
  requestedChangeId: string,
  intentInput: unknown,
  options: ProposeOptions = {},
): ProposeOutput {
  const changeId = services.workspace.assertChangeId(requestedChangeId);
  const startInput = assertProposeStartInput(services, intentInput);
  const intent = isInvestigationExemptionRequest(startInput)
    ? startInput.intent
    : startInput;
  const environment = options.environment ?? process.env;
  const actorResolution = resolveActorIdentity({
    ...(options.explicitActor === undefined
      ? {}
      : { explicitActor: options.explicitActor }),
    environment,
  });
  if (actorResolution.outcome === 'actor-resolution-required') {
    return {
      schemaVersion: 1,
      kind: 'workflow-propose',
      changeId,
      state: 'actor-resolution-required',
      nextAction: 'resolve-actor',
      investigation: null,
      createdDate: new Date().toISOString().slice(0, 10),
      actorResolution,
      inputSchema: {
        schemaVersion: 1,
        kind: 'actor-selection',
        allowedProviders: ['claude', 'codex'],
      },
      work: null,
      materializedArtifacts: null,
      planReview: null,
      planningTransition: null,
      semanticReuse: null,
      classSampleAudits: [],
      floorTrimming: { dropped: [], escalated: false },
    };
  }

  const repository = services.workspace.discoverRepository(cwd);
  assertCurrentGovernanceSources(repository.repositoryRoot, intent.sourceRefs);
  const immediateSource = resolveImmediateSource(
    repository.repositoryRoot,
    changeId,
    intent,
    options.immediateSource,
  );
  if (options.taskMandateId === undefined) {
    services.workspace.assertTaskMandateOptional(
      repository.repositoryRoot,
      services.workspace.loadWorkflowConfig(repository.repositoryRoot),
      intent.explicitPaths,
    );
  }

  cwd = resolveProposePlanningWorkspace(
    services,
    cwd,
    changeId,
    'start',
    immediateSource,
  );

  const mandateAuthorization = options.taskMandateId
    ? authorizeTaskMandateOperation(
        cwd,
        options.taskMandateId,
        { kind: 'candidate-or-design-artifact' },
        {
          ...options.taskMandateValidation,
          changeId,
        },
      )
    : null;

  if (isInvestigationExemptionRequest(startInput)) {
    return startExemptionPropose(
      services,
      cwd,
      changeId,
      startInput,
      actorResolution,
      mandateAuthorization?.binding,
    );
  }

  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const initialExemption =
    services.investigation.readCurrentProposeExemptionSession(
      context.runtime,
      changeId,
    );
  if (
    initialExemption !== null &&
    currentExemptionContextMatches(context, initialExemption, initialExemption)
  ) {
    throw workflowError(
      'CURRENT_INVESTIGATION_EXEMPTION_CONFLICT',
      'The current change already has a structured investigation-exemption branch.',
      ExitCode.conflict,
    );
  }
  const adapterPolicy = services.provider.loadAiAdapterPolicy(
    context.git.repositoryRoot,
  );
  const intentDigest = sha256(canonicalJson(intent));
  const invocationId = createRuntimeId('invocation');
  const providerSessionId = createRuntimeId('provider-session');
  const author: RoleParticipant = {
    providerId: actorResolution.actor.providerId,
    sessionId: `author-${actorResolution.actor.providerId}`,
    principalId: undefined,
    identityAssurance: actorResolution.actor.assurance,
    engineSpawned: false,
  };
  const candidates = (['codex', 'claude'] as const).map((providerId) => ({
    providerId,
    sessionId:
      providerId === actorResolution.actor.providerId
        ? `author-${providerSessionId}`
        : providerSessionId,
    enabled: adapterPolicy.policy.providers[providerId].enabled,
    available: adapterPolicy.policy.providers[providerId].enabled,
  }));
  const scheduled = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    purpose: 'survey',
    author,
    targetDigest: intentDigest,
    candidates,
  });
  const callableProviderIds = candidates
    .filter(({ enabled, available }) => enabled && available)
    .map(({ providerId }) => providerId);
  const grantRequest = blindSurveyGrantRequest({
    changeId,
    baseline: { head: context.git.head, tree: context.git.tree },
    targetDigest: intentDigest,
    author,
    callableProviderIds,
  });
  if (scheduled.outcome !== 'assigned' && !options.collaborationGrant) {
    return collaborationGrantRequiredOutput({
      changeId,
      actorResolution,
      grantRequest,
      lifecyclePhase: 'blind-survey',
      conflictingRole: 'plan-reviewer',
    });
  }
  if (scheduled.outcome !== 'assigned' && grantRequest === null) {
    throw workflowError(
      'COLLABORATION_GRANT_FORM_REQUIRED',
      'No provider is callable; submit an explicitly typed caller-supplied survey grant.',
      ExitCode.guard,
    );
  }
  const protectedBranch = context.config.protectedBranches[0];
  if (!protectedBranch) {
    throw workflowError(
      'PROPOSE_BASE_REF_REQUIRED',
      'A configured protected base is required for pinned floor derivation.',
      ExitCode.guard,
    );
  }
  const protectedBaseRef = services.workspace.resolveProtectedBaseRef(
    context.git.repositoryRoot,
    protectedBranch,
  );
  const protectedBaseCommit = services.workspace
    .runGit(
      context.git.repositoryRoot,
      ['rev-parse', '--verify', `${protectedBaseRef}^{commit}`],
      true,
    )
    .trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(protectedBaseCommit)) {
    throw workflowError(
      'PROPOSE_PROTECTED_BASE_UNAVAILABLE',
      'The configured protected base is unavailable; an exact Fail-Grant challenge is required before initialization.',
      ExitCode.staleState,
      { details: { protectedBaseRef, changeId } },
    );
  }

  const manifest: BlindSurveyManifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId,
    repositoryId: context.config.repositoryName,
    baseCommit: context.git.head,
    baseTree: context.git.tree,
    normalizedIntent: intent,
    architectureQuestion:
      `Which existing consumers, invariants, and architecture precedents are ` +
      `load-bearing for this change: ${intent.summary}`,
    capabilityProfile: 'repository-read-only',
  };
  const manifestDigest = services.provider.blindSurveyManifestDigest(manifest);
  const collaborationGrant = options.collaborationGrant;
  const status = withProposeTransitionAuthority(
    services,
    cwd,
    context.lifecycleRuntime,
    changeId,
    (assertOwned) => {
      assertOwned();
      const lockedContext =
        services.workspace.loadInvestigationRuntimeContext(cwd);
      assertProposeStartContextStable(context, lockedContext);
      const lockedExemption =
        services.investigation.readCurrentProposeExemptionSession(
          lockedContext.runtime,
          changeId,
        );
      if (lockedExemption !== null) {
        if (
          currentExemptionContextMatches(
            lockedContext,
            lockedExemption,
            lockedExemption,
          )
        ) {
          throw workflowError(
            'CURRENT_INVESTIGATION_EXEMPTION_CONFLICT',
            'The current change already has a structured investigation-exemption branch.',
            ExitCode.conflict,
          );
        }
        services.investigation.retireCurrentProposeExemptionSession(
          lockedContext.runtime,
          lockedExemption,
          assertOwned,
        );
      }
      const readDurableStart = (startedStatus: InvestigationStatus) => {
        const durableInvocation = services.provider.readProviderInvocation(
          lockedContext.runtime,
          startedStatus.providerInvocationId,
        );
        const durableRequest = services.provider.readProviderInvocationRequest(
          lockedContext.runtime,
          startedStatus.providerInvocationId,
        );
        const durableAuthorization = readProposeAuthorization(
          services,
          lockedContext.runtime,
          durableRequest,
        );
        if (
          durableAuthorization.actor.providerId !==
          actorResolution.actor.providerId
        ) {
          throw workflowError(
            'CURRENT_INVESTIGATION_ACTOR_CONFLICT',
            'The current investigation is pinned to a different actor.',
            ExitCode.conflict,
          );
        }
        assertOwned();
        return {
          status: startedStatus,
          durableInvocation,
          durableRequest,
          durableAuthorization,
        };
      };
      const currentRef = services.investigation.readCurrentInvestigationRef(
        lockedContext.runtime,
        changeId,
      );
      if (currentRef !== null) {
        const current = services.investigation.readInvestigationSession(
          lockedContext.runtime,
          currentRef.investigationId,
        );
        if (current.blindManifestDigest !== manifestDigest) {
          throw workflowError(
            'CURRENT_INVESTIGATION_CONFLICT',
            `Change ${changeId} already has a different current investigation.`,
            ExitCode.conflict,
          );
        }
        const durableRequest = services.provider.readProviderInvocationRequest(
          lockedContext.runtime,
          current.currentBlindInvocationId,
        );
        const durableManifest = services.provider.readBlindSurveyManifest(
          lockedContext.runtime,
          current.currentBlindInvocationId,
        );
        return readDurableStart(
          services.investigation.startInvestigationSessionUnderLifecycleLock(
            cwd,
            {
              changeId,
              blindManifest: durableManifest,
              blindRequest: durableRequest,
            },
            lockedContext,
            assertOwned,
          ),
        );
      }
      let assignment: ProviderRoleAssignment;
      let grantAuthorization: ProposeGrantAuthorization | null = null;
      if (scheduled.outcome === 'assigned') {
        assignment = scheduled.assignment;
      } else {
        if (!collaborationGrant || grantRequest === null) {
          throw workflowError(
            'COLLABORATION_GRANT_FORM_REQUIRED',
            'No provider is callable; submit an explicitly typed caller-supplied survey grant.',
            ExitCode.guard,
          );
        }
        const expectedBinding = deriveCollaborationGrantBinding(
          services,
          lockedContext.git.repositoryRoot,
          grantRequest,
        );
        const verifier = resolveAuthoritativeCollaborationGrantVerifier(
          collaborationGrant.verifier,
        );
        const transitionDigest = collaborationTransitionDigest(expectedBinding);
        const reservation =
          services.grants.reserveCollaborationGrantUnderLifecycleLock(
            lockedContext.git.repositoryRoot,
            collaborationGrant.grantId,
            {
              transitionDigest,
              expected: expectedBinding,
              ...(collaborationGrant.now === undefined
                ? {}
                : { now: collaborationGrant.now }),
              verifier,
            },
            assertOwned,
          );
        assignment = authorizeGrantedOrdinaryRole({
          role: 'plan-reviewer',
          author,
          targetDigest: intentDigest,
          reservation,
          actualParticipant: {
            providerId: actorResolution.actor.providerId,
            sessionId: providerSessionId,
            principalId: undefined,
            identityAssurance: actorResolution.actor.assurance,
            engineSpawned: true,
          },
          callableProviderIds,
        }) as GrantedSameProviderRoleAssignment;
        grantAuthorization = {
          grantId: reservation.grantId,
          transitionDigest,
          expectedBinding,
        };
      }
      const authorizationNode = createProposeAuthorizationNode({
        actorResolution,
        assignment,
        grantAuthorization,
        baseline: {
          head: lockedContext.git.head,
          tree: lockedContext.git.tree,
        },
        intent,
        intentDigest,
        protectedBase: {
          ref: protectedBaseRef,
          commit: protectedBaseCommit,
        },
      });
      const request = createProviderInvocationRequest({
        invocationId,
        nonce: `propose-${crypto.randomUUID()}`,
        purpose: 'survey',
        providerId: assignment.providerId,
        roleAssignment: assignment,
        capabilityProfile: 'repository-read-only',
        repositoryId: lockedContext.config.repositoryName,
        baseCommit: lockedContext.git.head,
        baseTree: lockedContext.git.tree,
        targetDigest: intentDigest,
        inputManifestDigest: manifestDigest,
        authorizationNodeId: authorizationNode.nodeId,
        writeAllowedPaths: [],
        outputSchema: services.provider.BLIND_SURVEY_OUTPUT_SCHEMA,
        evaluatorVersion: 'blind-survey-evaluator.v1',
        policyDigest: adapterPolicy.digest,
        limits: {
          timeoutMs: adapterPolicy.policy.limits.timeoutMs,
          aggregateOutputBytes:
            adapterPolicy.policy.limits.aggregateOutputBytes,
        },
      });
      services.evidence.writeEvidenceNode(
        lockedContext.runtime,
        authorizationNode,
      );
      assertOwned();
      return readDurableStart(
        services.investigation.startInvestigationSessionUnderLifecycleLock(
          cwd,
          {
            changeId,
            blindManifest: manifest,
            blindRequest: request,
            ...(mandateAuthorization
              ? { mandateBinding: mandateAuthorization.binding }
              : {}),
          },
          lockedContext,
          assertOwned,
        ),
      );
    },
  );
  const {
    status: durableStatus,
    durableInvocation,
    durableRequest,
    durableAuthorization,
  } = status;
  if (
    durableInvocation.state === 'prepared' &&
    (options.providerDriver || options.providerDispatcher)
  ) {
    dispatchMandatedProviderInvocation(
      services,
      cwd,
      durableRequest.invocationId,
      (runtime, request) => {
        if (options.providerDriver) {
          options.providerDriver({ paths: runtime, request });
        } else if (options.providerDispatcher) {
          options.providerDispatcher(cwd, request.invocationId);
        }
      },
    );
  }

  return renderProposeOutputWithPlanningAuthority(
    services,
    cwd,
    durableStatus,
    {
      outcome: 'resolved',
      providerId: durableAuthorization.actor.providerId,
      assurance: durableAuthorization.actor.assurance,
      signals: durableAuthorization.signals,
    },
    options.collaborationGrant,
  );
}

function startExemptionPropose(
  services: Pick<
    ProposeRuntime,
    'evidence' | 'investigation' | 'provider' | 'publication' | 'workspace'
  >,
  cwd: string,
  changeId: string,
  request: InvestigationExemptionRequest,
  actorResolution: Extract<
    ReturnType<typeof resolveActorIdentity>,
    { outcome: 'resolved' }
  >,
  mandateBinding?: TaskMandateBinding,
): ProposeOutput {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  return withProposeTransitionAuthority(
    services,
    cwd,
    context.lifecycleRuntime,
    changeId,
    (assertOwned) => {
      assertOwned();
      const lockedContext =
        services.workspace.loadInvestigationRuntimeContext(cwd);
      assertProposeStartContextStable(context, lockedContext);
      if (mandateBinding) {
        assertActiveTaskMandateBindingUnderLifecycleLock(
          cwd,
          mandateBinding,
          assertOwned,
        );
      }
      const ordinary = services.investigation.readCurrentInvestigationRef(
        lockedContext.runtime,
        changeId,
      );
      if (ordinary !== null) {
        throw workflowError(
          'CURRENT_INVESTIGATION_CONFLICT',
          'The current change already has an ordinary investigation session.',
          ExitCode.conflict,
        );
      }
      const currentExemption =
        services.investigation.readCurrentProposeExemptionSession(
          lockedContext.runtime,
          changeId,
        );
      if (
        currentExemption !== null &&
        !currentExemptionContextMatches(
          lockedContext,
          currentExemption,
          currentExemption,
        )
      ) {
        services.investigation.retireCurrentProposeExemptionSession(
          lockedContext.runtime,
          currentExemption,
          assertOwned,
        );
      }
      const intentDigest = sha256(canonicalJson(request.intent));
      const applicability = createInvestigationApplicability({
        kind: 'investigation-exemption',
        ...request.exemption,
        baseline: {
          head: lockedContext.git.head,
          tree: lockedContext.git.tree,
        },
        intentDigest,
      });
      if (applicability.kind !== 'investigation-exemption') {
        throw workflowError(
          'INVESTIGATION_EXEMPTION_INVALID',
          'The structured investigation exemption did not produce its exact branch.',
          ExitCode.staleState,
        );
      }
      const applicabilityNode = services.evidence.createEvidenceNode({
        type: 'investigation-applicability',
        nodeSchema: 'investigation.applicability.v1',
        evaluator: 'investigation-applicability.v1',
        policyDigest: INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
        exactInputDigests: {
          applicability: applicability.applicabilityDigest,
        },
        semanticParentResultDigests: {},
        provenanceParentNodeIds: {},
        outputSchema: 'investigation.applicability-output.v1',
        output: applicability,
        runtimeMetadata: {},
      });
      const session = services.investigation.createProposeExemptionSession(
        lockedContext.runtime,
        {
          changeId,
          ...(mandateBinding ? { mandateBinding } : {}),
          repositoryRoot: lockedContext.git.repositoryRealPath,
          gitCommonDirectory: lockedContext.git.gitCommonDirectory,
          branch: lockedContext.git.branch,
          baseline: {
            head: lockedContext.git.head,
            tree: lockedContext.git.tree,
          },
          intentDigest,
          intent: request.intent,
          applicability,
          applicabilityNode,
          actor: actorResolution.actor,
          signals: actorResolution.signals,
        },
      );
      if (
        session.actor.providerId !== actorResolution.actor.providerId ||
        session.actor.assurance !== actorResolution.actor.assurance
      ) {
        throw workflowError(
          'CURRENT_INVESTIGATION_ACTOR_CONFLICT',
          'The current structured investigation exemption is pinned to a different actor.',
          ExitCode.conflict,
        );
      }
      assertCurrentExemptionContext(services, lockedContext, session);
      const scaffold = prepareExemptionPlanningScaffold(
        services,
        cwd,
        session,
        false,
        false,
        true,
        assertOwned,
      );
      const output = renderExemptionProposeOutput(
        services,
        cwd,
        session,
        scaffold,
      );
      assertOwned();
      return output;
    },
  );
}

export function resumeExemptionPlanningContribution(
  services: ProposeRuntime,
  cwd: string,
  input: ExemptionPlanningContributionEnvelope,
  options: ProposeResumeOptions,
): ExemptionProposeOutput {
  const initialContext =
    services.workspace.loadInvestigationRuntimeContext(cwd);
  const output = withProposeTransitionAuthority(
    services,
    cwd,
    initialContext.lifecycleRuntime,
    input.changeId,
    (assertOwned) => {
      assertOwned();
      const lockedContext =
        services.workspace.loadInvestigationRuntimeContext(cwd);
      assertProposeStartContextStable(initialContext, lockedContext);
      const session = services.investigation.readProposeExemptionSession(
        lockedContext.runtime,
        input.investigationId,
      );
      assertCurrentExemptionContext(services, lockedContext, session);
      assertExemptionPlanningBinding(session, input);
      const materializedArtifacts = materializeExemptionPlanningContribution(
        services,
        cwd,
        session,
        input.payload,
        options.collaborationGrant,
        options.roleTopologyResolution,
        options.roleContextSharingGrant,
        assertOwned,
      );
      assertOwned();
      assertCurrentExemptionContext(
        services,
        services.workspace.loadInvestigationRuntimeContext(cwd),
        session,
      );
      return renderExemptionProposeOutput(
        services,
        cwd,
        session,
        prepareExemptionPlanningScaffold(
          services,
          cwd,
          session,
          true,
          false,
          true,
          assertOwned,
        ),
        materializedArtifacts,
        options.collaborationGrantValidation,
      );
    },
  );
  dispatchPreparedPlanReview(services, cwd, output, options);
  return getExemptionProposeStatus(
    services,
    cwd,
    input.investigationId,
    options.collaborationGrantValidation,
  );
}

export function startProposeFromFile(
  services: ProposeRuntime,
  cwd: string,
  changeId: string,
  intentPath: string,
  options: ProposeOptions = {},
): ProposeOutput {
  return startPropose(
    services,
    cwd,
    changeId,
    readCallerJson(cwd, intentPath),
    options,
  );
}
