import type { createProposeContext } from './propose-context.ts';
import type { createPlanningMaterialization } from './propose-planning-materialization.ts';
import type { createProposeProviderLifecycle } from './propose-provider-lifecycle.ts';
import type { createProposePublication } from './propose-publication.ts';
import type { createProposeStatus } from './propose-status.ts';
import crypto from 'node:crypto';

import type {
  ProposeOptions,
  InvestigationExemptionRequest,
  ExemptionProposeOutput,
  ProposeOutput,
  ProposeGrantAuthorization,
  ExemptionPlanningContributionEnvelope,
  ProposeResumeOptions,
} from '../../modules/proposal/propose-types.ts';
import type { ProposeDecisionServices } from './propose-decision-services.ts';
import {
  assertProposeStartInput,
  readProposeAuthorization,
} from './propose-request-validation.ts';
import {
  isInvestigationExemptionRequest,
  assertExemptionPlanningBinding,
} from '../../modules/proposal/propose-input.ts';
import { resolveActorIdentity } from '../../modules/authority/actor-identity.ts';
import { listProviderIds } from '../../modules/provider-orchestration/provider-registry.ts';
import {
  currentExemptionContextMatches,
  assertProposeStartContextStable,
  deriveCollaborationGrantBinding,
  resolveAuthoritativeCollaborationGrantVerifier,
  assertCurrentExemptionContext,
} from './propose-context.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { sha256 } from '../../modules/proposal/propose-values.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { createRuntimeId } from './propose-common.ts';
import {
  type RoleParticipant,
  scheduleOrdinaryRole,
  type ProviderRoleAssignment,
  type GrantedSameProviderRoleAssignment,
} from '../../modules/provider-orchestration/role-assignment.ts';
import { blindSurveyGrantRequest } from '../../modules/proposal/plan-review-contracts.ts';
import { collaborationGrantRequiredOutput } from './propose-output.ts';
import type { BlindSurveyManifest } from '../../modules/investigation/manifest/blind-survey-manifest.ts';
import type { InvestigationStatus } from '../../modules/lifecycle/investigation-status.ts';
import { collaborationTransitionDigest } from '../../modules/proposal/plan-review-grant-authorization.ts';
import { createProposeAuthorizationNode } from '../../modules/proposal/propose-evidence.ts';
import { createProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';

import { assertChangeId } from '../../foundation/repository-path/repository-path.ts';
import { discoverRepository } from '../repository-transaction/git-working-state.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import { assertTaskMandateOptional } from '../repository-observation/task-authorization-policy.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import {
  readCurrentProposeExemptionSession,
  retireCurrentProposeExemptionSession,
  createProposeExemptionSession,
  readProposeExemptionSession,
} from '../storage-journal/propose-exemption-store.ts';
import { loadAiAdapterPolicy } from '../provider-policy/ai-adapter-policy.ts';
import { resolveProtectedBaseRef } from '../repository-transaction/protected-base.ts';
import { runGit } from '../repository-transaction/git-command.ts';
import { blindSurveyManifestDigest } from '../storage-journal/provider-invocation-manifest-validation.ts';
import { readProviderInvocation } from '../storage-journal/provider-invocation-state.ts';
import {
  readProviderInvocationRequest,
  readBlindSurveyManifest,
} from '../storage-journal/provider-invocation-artifacts.ts';
import {
  readCurrentInvestigationRef,
  readInvestigationSession,
} from '../storage-journal/investigation-session-records.ts';
import { startInvestigationSessionUnderLifecycleLock } from '../investigation-lifecycle/investigation-session.ts';
import { reserveCollaborationGrantUnderLifecycleLock } from '../storage-journal/collaboration-grant-reservation.ts';
import { BLIND_SURVEY_OUTPUT_SCHEMA } from '../../modules/provider-orchestration/blind-survey-output.ts';
import { writeEvidenceNode } from '../storage-journal/evidence-node-store.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import {
  createInvestigationApplicability,
  INVESTIGATION_APPLICABILITY_POLICY_DIGEST,
} from '../../modules/investigation/domain/investigation-applicability.ts';

import { createEvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';

import { readCallerJson } from './propose-artifacts.ts';
export function createProposeStart({
  roleAdmission,
  startTaskMandate,
  taskMandate,
  assertCurrentGovernanceSources,
  dispatchMandatedProviderInvocation,
  dispatchPreparedPlanReview,
  getExemptionProposeStatus,
  materializeExemptionPlanningContribution,
  prepareExemptionPlanningScaffold,
  renderExemptionProposeOutput,
  renderProposeOutputWithPlanningAuthority,
  resolveImmediateSource,
  resolveProposePlanningWorkspace,
  withProposeTransitionAuthority,
}: {
  roleAdmission: ProposeDecisionServices['roleAdmission'];
  startTaskMandate: ProposeDecisionServices['taskMandate'];
  taskMandate: ProposeDecisionServices['taskMandate'];
  assertCurrentGovernanceSources: ReturnType<
    typeof createProposeContext
  >['assertCurrentGovernanceSources'];
  dispatchMandatedProviderInvocation: ReturnType<
    typeof createProposeProviderLifecycle
  >['dispatchMandatedProviderInvocation'];
  dispatchPreparedPlanReview: ReturnType<
    typeof createProposeProviderLifecycle
  >['dispatchPreparedPlanReview'];
  getExemptionProposeStatus: ReturnType<
    typeof createProposeStatus
  >['getExemptionProposeStatus'];
  materializeExemptionPlanningContribution: ReturnType<
    typeof createPlanningMaterialization
  >['materializeExemptionPlanningContribution'];
  prepareExemptionPlanningScaffold: ReturnType<
    typeof createProposePublication
  >['prepareExemptionPlanningScaffold'];
  renderExemptionProposeOutput: ReturnType<
    typeof createProposeStatus
  >['renderExemptionProposeOutput'];
  renderProposeOutputWithPlanningAuthority: ReturnType<
    typeof createProposeStatus
  >['renderProposeOutputWithPlanningAuthority'];
  resolveImmediateSource: ReturnType<
    typeof createProposeContext
  >['resolveImmediateSource'];
  resolveProposePlanningWorkspace: ReturnType<
    typeof createProposeContext
  >['resolveProposePlanningWorkspace'];
  withProposeTransitionAuthority: ReturnType<
    typeof createProposeContext
  >['withProposeTransitionAuthority'];
}) {
  function startPropose(
    cwd: string,
    requestedChangeId: string,
    intentInput: unknown,
    options: ProposeOptions = {},
  ): ProposeOutput {
    const changeId = assertChangeId(requestedChangeId);
    const startInput = assertProposeStartInput(intentInput);
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
          allowedProviders: [...listProviderIds()],
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

    const repository = discoverRepository(cwd);
    assertCurrentGovernanceSources(
      repository.repositoryRoot,
      intent.sourceRefs,
    );
    const immediateSource = resolveImmediateSource(
      repository.repositoryRoot,
      changeId,
      intent,
      options.immediateSource,
    );
    if (options.taskMandateId === undefined) {
      assertTaskMandateOptional(
        repository.repositoryRoot,
        loadWorkflowConfig(repository.repositoryRoot),
        intent.explicitPaths,
      );
    }

    cwd = resolveProposePlanningWorkspace(
      cwd,
      changeId,
      'start',
      immediateSource,
    );

    const mandateAuthorization = options.taskMandateId
      ? taskMandate.authorizeTaskMandateOperation(
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
        cwd,
        changeId,
        startInput,
        actorResolution,
        mandateAuthorization?.binding,
      );
    }

    const context = loadInvestigationRuntimeContext(cwd);
    const initialExemption = readCurrentProposeExemptionSession(
      context.runtime,
      changeId,
    );
    if (
      initialExemption !== null &&
      currentExemptionContextMatches(
        context,
        initialExemption,
        initialExemption,
      )
    ) {
      throw workflowError(
        'CURRENT_INVESTIGATION_EXEMPTION_CONFLICT',
        'The current change already has a structured investigation-exemption branch.',
        ExitCode.conflict,
      );
    }
    const adapterPolicy = loadAiAdapterPolicy(context.git.repositoryRoot);
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
    const candidates = listProviderIds().map((providerId) => ({
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
    const protectedBaseRef = resolveProtectedBaseRef(
      context.git.repositoryRoot,
      protectedBranch,
    );
    const protectedBaseCommit = runGit(
      context.git.repositoryRoot,
      ['rev-parse', '--verify', `${protectedBaseRef}^{commit}`],
      true,
    ).trim();
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
    const manifestDigest = blindSurveyManifestDigest(manifest);
    const collaborationGrant = options.collaborationGrant;
    const status = withProposeTransitionAuthority(
      cwd,
      context.lifecycleRuntime,
      changeId,
      (assertOwned) => {
        assertOwned();
        const lockedContext = loadInvestigationRuntimeContext(cwd);
        assertProposeStartContextStable(context, lockedContext);
        const lockedExemption = readCurrentProposeExemptionSession(
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
          retireCurrentProposeExemptionSession(
            lockedContext.runtime,
            lockedExemption,
            assertOwned,
          );
        }
        const readDurableStart = (startedStatus: InvestigationStatus) => {
          const durableInvocation = readProviderInvocation(
            lockedContext.runtime,
            startedStatus.providerInvocationId,
          );
          const durableRequest = readProviderInvocationRequest(
            lockedContext.runtime,
            startedStatus.providerInvocationId,
          );
          const durableAuthorization = readProposeAuthorization(
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
        const currentRef = readCurrentInvestigationRef(
          lockedContext.runtime,
          changeId,
        );
        if (currentRef !== null) {
          const current = readInvestigationSession(
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
          const durableRequest = readProviderInvocationRequest(
            lockedContext.runtime,
            current.currentBlindInvocationId,
          );
          const durableManifest = readBlindSurveyManifest(
            lockedContext.runtime,
            current.currentBlindInvocationId,
          );
          return readDurableStart(
            startInvestigationSessionUnderLifecycleLock(
              startTaskMandate,
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
            lockedContext.git.repositoryRoot,
            grantRequest,
          );
          const verifier = resolveAuthoritativeCollaborationGrantVerifier(
            collaborationGrant.verifier,
          );
          const transitionDigest =
            collaborationTransitionDigest(expectedBinding);
          const reservation = reserveCollaborationGrantUnderLifecycleLock(
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
          assignment = roleAdmission.authorizeGrantedOrdinaryRole({
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
          outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
          evaluatorVersion: 'blind-survey-evaluator.v1',
          policyDigest: adapterPolicy.digest,
          limits: {
            timeoutMs: adapterPolicy.policy.limits.timeoutMs,
            aggregateOutputBytes:
              adapterPolicy.policy.limits.aggregateOutputBytes,
          },
        });
        writeEvidenceNode(lockedContext.runtime, authorizationNode);
        assertOwned();
        return readDurableStart(
          startInvestigationSessionUnderLifecycleLock(
            startTaskMandate,
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
    cwd: string,
    changeId: string,
    request: InvestigationExemptionRequest,
    actorResolution: Extract<
      ReturnType<typeof resolveActorIdentity>,
      { outcome: 'resolved' }
    >,
    mandateBinding?: TaskMandateBinding,
  ): ProposeOutput {
    const context = loadInvestigationRuntimeContext(cwd);
    return withProposeTransitionAuthority(
      cwd,
      context.lifecycleRuntime,
      changeId,
      (assertOwned) => {
        assertOwned();
        const lockedContext = loadInvestigationRuntimeContext(cwd);
        assertProposeStartContextStable(context, lockedContext);
        if (mandateBinding) {
          taskMandate.assertActiveTaskMandateBindingUnderLifecycleLock(
            cwd,
            mandateBinding,
            assertOwned,
          );
        }
        const ordinary = readCurrentInvestigationRef(
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
        const currentExemption = readCurrentProposeExemptionSession(
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
          retireCurrentProposeExemptionSession(
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
        const applicabilityNode = createEvidenceNode({
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
        const session = createProposeExemptionSession(lockedContext.runtime, {
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
        });
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
        assertCurrentExemptionContext(lockedContext, session);
        const scaffold = prepareExemptionPlanningScaffold(
          cwd,
          session,
          false,
          false,
          true,
          assertOwned,
        );
        const output = renderExemptionProposeOutput(cwd, session, scaffold);
        assertOwned();
        return output;
      },
    );
  }

  function resumeExemptionPlanningContribution(
    cwd: string,
    input: ExemptionPlanningContributionEnvelope,
    options: ProposeResumeOptions,
  ): ExemptionProposeOutput {
    const initialContext = loadInvestigationRuntimeContext(cwd);
    const output = withProposeTransitionAuthority(
      cwd,
      initialContext.lifecycleRuntime,
      input.changeId,
      (assertOwned) => {
        assertOwned();
        const lockedContext = loadInvestigationRuntimeContext(cwd);
        assertProposeStartContextStable(initialContext, lockedContext);
        const session = readProposeExemptionSession(
          lockedContext.runtime,
          input.investigationId,
        );
        assertCurrentExemptionContext(lockedContext, session);
        assertExemptionPlanningBinding(session, input);
        const materializedArtifacts = materializeExemptionPlanningContribution(
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
          loadInvestigationRuntimeContext(cwd),
          session,
        );
        return renderExemptionProposeOutput(
          cwd,
          session,
          prepareExemptionPlanningScaffold(
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
    dispatchPreparedPlanReview(cwd, output, options);
    return getExemptionProposeStatus(
      cwd,
      input.investigationId,
      options.collaborationGrantValidation,
    );
  }

  function startProposeFromFile(
    cwd: string,
    changeId: string,
    intentPath: string,
    options: ProposeOptions = {},
  ): ProposeOutput {
    return startPropose(
      cwd,
      changeId,
      readCallerJson(cwd, intentPath),
      options,
    );
  }
  return {
    startPropose,
    resumeExemptionPlanningContribution,
    startProposeFromFile,
  };
}
