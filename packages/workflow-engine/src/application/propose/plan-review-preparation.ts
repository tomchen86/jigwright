/**
 * Reserves a reviewer and immutable plan snapshot before preparing provider work.
 *
 * Invariants:
 * - The assignment, topology, grant, and mandate bind the same exact planning subject.
 * - Snapshot bytes match the current materialization before an invocation is created.
 * - Existing reservations and interrupted invocations retain request and policy identity.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  type PlanReviewTargetSnapshot,
  PLAN_REVIEW_OUTPUT_SCHEMA,
  createPlanReviewTargetSnapshotNode,
  readPlanReviewTargetSnapshotNode,
} from '../../modules/assurance/plan-review.ts';
import { type InvestigationFirstPlanningSubject } from '../../modules/assurance/planning-assurance-validator.ts';
import {
  type TaskMandateBinding,
  assertActiveTaskMandateBindingUnderLifecycleLock,
  authorizeTaskMandateProviderReservationUnderLifecycleLock,
} from '../../modules/authority/task-mandate.ts';
import { createProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  type GrantedSameProviderRoleAssignment,
  type ProviderRoleAssignment,
  type RecordedRoleParticipant,
  type RoleParticipant,
  authorizeGrantedOrdinaryRole,
  scheduleOrdinaryRole,
} from '../../modules/provider-orchestration/role-scheduler.ts';
import {
  type RoleTopologyResolutionDependencyPortV1,
  type RoleTopologyResolutionV1,
} from '../../modules/provider-orchestration/role-topology-resolution.ts';
import {
  type ProposeGrantAuthorization,
  collaborationTransitionDigest,
  createCollaborationPlanReviewRequirementV3,
  planReviewGrantRequest,
} from './plan-review-contracts.ts';
import { preparePlanReviewRoleTopology } from './plan-review-role-topology.ts';
import {
  persistPlanReviewGrantRequirement,
  persistPlanReviewTopologyRequirement,
  readPlanReviewGrantRequirement,
  readPlanReviewReservation,
} from './plan-review-store.ts';
import {
  readPlanReviewSnapshotContents,
  readPriorPlanReviewSnapshotContents,
} from './propose-artifacts.ts';
import {
  PLANNING_MATERIALIZATION_REF,
  PLAN_REVIEW_REQUEST_REF,
  createRuntimeId,
  isDigestRecord,
  isRecord,
  planReviewRequestStale,
  sha256,
} from './propose-common.ts';
import {
  deriveCollaborationGrantBinding,
  loadMaintainerPolicyAtCommit,
  resolveAuthoritativeCollaborationGrantVerifier,
  resolveAuthoritativeRoleContextSharingGrantVerifier,
} from './propose-context.ts';
import {
  createPlanReviewAuthorizationNode,
  createPlanReviewReservationNode,
} from './propose-evidence.ts';
import { readProposeAuthorization } from './propose-request-validation.ts';
import type { PlanReviewManifest, ProposeRuntime } from './propose-runtime.ts';
import {
  type PlanReviewReservation,
  type ProposeLifecycleStatus,
  type ProposeResumeOptions,
} from './propose-types.ts';
import { reserveRoleContextSharingPlanReview } from './role-context-sharing-plan-review.ts';

export function durablePlanReviewMandateBinding(
  services: Pick<ProposeRuntime, 'investigation'>,
  context: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >,
  status: ProposeLifecycleStatus,
): TaskMandateBinding | undefined {
  if (status.state === 'investigation-exempt') {
    const session = services.investigation.readProposeExemptionSession(
      context.runtime,
      status.investigationId,
    );
    if (
      session.changeId !== status.changeId ||
      canonicalJson(session.baseline) !== canonicalJson(status.baseline)
    ) {
      throw workflowError(
        'TASK_MANDATE_BINDING_STALE',
        'The exempt PlanReview owner no longer matches the durable planning context.',
        ExitCode.staleState,
      );
    }
    return session.mandateBinding;
  }
  const session = services.investigation.readInvestigationSession(
    context.runtime,
    status.investigationId,
  );
  if (
    session.changeId !== status.changeId ||
    canonicalJson(session.baseline) !== canonicalJson(status.baseline)
  ) {
    throw workflowError(
      'TASK_MANDATE_BINDING_STALE',
      'The PlanReview owner session no longer matches the durable planning context.',
      ExitCode.staleState,
    );
  }
  return session.mandateBinding;
}

export function authorizePlanReviewReservationMandate(
  cwd: string,
  binding: TaskMandateBinding | undefined,
  reservation: PlanReviewReservation,
  assertOwned: () => void,
  executionGrant?: { grantId: string },
): void {
  if (binding === undefined) return;
  authorizeTaskMandateProviderReservationUnderLifecycleLock(
    cwd,
    binding,
    reservation.request.invocationId,
    {
      providerId: reservation.request.providerId,
      dataTypes: ['diff', 'repository-metadata', 'source-code', 'test-output'],
      sourceCode: true,
      secrets: false,
      retry: reservation.retry !== null,
      budget: null,
      requestDigest: reservation.request.requestDigest,
      ...(executionGrant === undefined ? {} : { executionGrant }),
    },
    assertOwned,
  );
}

export function preparePlanReviewInvocation(
  services: Pick<
    ProposeRuntime,
    'evidence' | 'grants' | 'investigation' | 'provider' | 'workspace'
  >,
  cwd: string,
  status: ProposeLifecycleStatus,
  planning: InvestigationFirstPlanningSubject,
  collaborationGrant: ProposeResumeOptions['collaborationGrant'] | undefined,
  roleTopologyResolution: RoleTopologyResolutionDependencyPortV1 | undefined,
  roleContextSharingGrant:
    ProposeResumeOptions['roleContextSharingGrant'] | undefined,
  assertOwned: () => void,
): PlanReviewReservation | null {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const mandateBinding = durablePlanReviewMandateBinding(
    services,
    context,
    status,
  );
  if (mandateBinding) {
    assertActiveTaskMandateBindingUnderLifecycleLock(
      cwd,
      mandateBinding,
      assertOwned,
    );
  }
  const currentRefs = services.evidence.readEvidenceRefs(
    context.runtime,
    status.changeId,
  );
  const existing = readPlanReviewReservation(
    services,
    context.runtime,
    status,
    undefined,
    true,
  );
  if (
    existing !== null &&
    canonicalJson(existing.subject) === canonicalJson(planning.subject) &&
    existing.materializationNode.nodeId ===
      currentRefs[PLANNING_MATERIALIZATION_REF]
  ) {
    if (
      roleTopologyResolution !== undefined &&
      existing.roleTopology === null &&
      !services.provider.providerInvocationExists(
        context.runtime,
        existing.request.invocationId,
      )
    ) {
      throw workflowError(
        'PLAN_REVIEW_ROLE_TOPOLOGY_REQUIRED',
        'A current PlanReview reservation without durable topology evidence cannot launch new provider work.',
        ExitCode.guard,
      );
    }
    authorizePlanReviewReservationMandate(
      cwd,
      mandateBinding,
      existing,
      assertOwned,
    );
    ensurePlanReviewInvocation(
      services,
      context.git.repositoryRoot,
      context.runtime,
      status,
      existing,
      mandateBinding,
    );
    return existing;
  }
  const expectedReservationNodeId =
    currentRefs[PLAN_REVIEW_REQUEST_REF] ?? null;

  const author = planAuthor(services, context.runtime, status);
  const recordedAuthor: RecordedRoleParticipant = {
    providerId: author.providerId ?? null,
    sessionId: author.sessionId ?? null,
    principalId: author.principalId ?? null,
    identityAssurance: author.identityAssurance,
    engineSpawned: author.engineSpawned,
  };
  const existingGrantRequirement = readPlanReviewGrantRequirement(
    services,
    context.runtime,
    status,
  );
  const durableRoleContextRequirement =
    existingGrantRequirement?.kind === 'role-context-sharing'
      ? existingGrantRequirement
      : null;
  const durableCollaborationRequirement =
    existingGrantRequirement?.kind === 'collaboration'
      ? existingGrantRequirement
      : null;
  if (
    existingGrantRequirement !== null &&
    (canonicalJson(existingGrantRequirement.requirement.subject) !==
      canonicalJson(planning.subject) ||
      canonicalJson(existingGrantRequirement.requirement.author) !==
        canonicalJson(recordedAuthor))
  ) {
    throw workflowError(
      'PLAN_REVIEW_GRANT_REQUIREMENT_STALE',
      'The durable R-007 requirement belongs to another PlanReview subject or author.',
      ExitCode.staleState,
    );
  }
  const policy = services.provider.loadAiAdapterPolicy(
    context.git.repositoryRoot,
  );
  const providerSessionId =
    durableRoleContextRequirement === null
      ? createRuntimeId('provider-session')
      : durableRoleContextRequirement.requirement.reviewerPlacement.sessionId;
  const schedulingCandidates = (['codex', 'claude'] as const).map(
    (providerId) => ({
      providerId,
      sessionId:
        providerId === author.providerId
          ? `author-${providerSessionId}`
          : providerSessionId,
      enabled: policy.policy.providers[providerId].enabled,
      available: policy.policy.providers[providerId].enabled,
    }),
  );
  const scheduled =
    durableRoleContextRequirement === null &&
    roleTopologyResolution === undefined
      ? scheduleOrdinaryRole({
          role: 'plan-reviewer',
          requestedIndependence: 'session-independent',
          author,
          targetDigest: planning.subject.subjectDigest,
          candidates: schedulingCandidates,
        })
      : null;
  const callableProviderIds = (['codex', 'claude'] as const).filter(
    (providerId) => policy.policy.providers[providerId].enabled,
  );
  const grantRequest =
    durableCollaborationRequirement === null
      ? planReviewGrantRequest({
          changeId: status.changeId,
          baseline: status.baseline,
          targetDigest: planning.subject.subjectDigest,
          author,
          callableProviderIds,
        })
      : durableCollaborationRequirement.requirement.grantRequest;
  let assignment: ProviderRoleAssignment;
  let grantAuthorization: ProposeGrantAuthorization | null = null;
  let roleTopology: RoleTopologyResolutionV1 | null = null;
  if (durableRoleContextRequirement !== null) {
    if (roleContextSharingGrant === undefined) return null;
    const requirement = durableRoleContextRequirement.requirement;
    const maintainerPolicy = loadMaintainerPolicyAtCommit(
      services,
      context.git.repositoryRoot,
      requirement.baseline.head,
    );
    const verifier = resolveAuthoritativeRoleContextSharingGrantVerifier(
      roleContextSharingGrant.verifier,
    );
    const reserved = reserveRoleContextSharingPlanReview({
      gitCommonDirectory: context.git.gitCommonDirectory,
      requirementNodeId: durableRoleContextRequirement.requirementNodeId,
      requirement,
      grantId: roleContextSharingGrant.grantId,
      policy: maintainerPolicy,
      policyBlob: services.workspace
        .runGit(context.git.repositoryRoot, [
          'rev-parse',
          `${requirement.baseline.head}:workflow/maintainer-policy.json`,
        ])
        .trim(),
      verifier,
      lifecycle: roleContextSharingGrant.lifecycle,
      ...(roleContextSharingGrant.now === undefined
        ? {}
        : { now: roleContextSharingGrant.now }),
      assertOwned,
    });
    assignment = reserved.assignment;
    grantAuthorization = reserved.authorization;
    roleTopology = requirement.roleTopology;
  } else if (roleTopologyResolution !== undefined) {
    const preparedTopology = preparePlanReviewRoleTopology(
      {
        topology: {
          repositoryRoot: context.git.repositoryRoot,
          changeId: status.changeId,
          planningGeneration: planning.generation.planningGenerationId,
          author: {
            providerId: author.providerId,
            sessionId: author.sessionId,
          },
          providerPolicyDigest: policy.digest,
          providerEnabled: {
            claude: policy.policy.providers.claude.enabled,
            codex: policy.policy.providers.codex.enabled,
          },
        },
        author,
        candidates: schedulingCandidates,
        requirement: {
          investigationId: status.investigationId,
          changeId: status.changeId,
          baseline: status.baseline,
          subject: planning.subject,
          author: recordedAuthor,
          contextGeneration: status.revision + 1,
        },
      },
      roleTopologyResolution,
    );
    roleTopology = preparedTopology.roleTopology;
    if (preparedTopology.kind === 'grant-required') {
      persistPlanReviewTopologyRequirement(
        services,
        context.runtime,
        status,
        preparedTopology.requirement,
      );
      return null;
    }
    assignment = preparedTopology.assignment;
  } else if (scheduled?.outcome === 'assigned') {
    assignment = scheduled.assignment;
  } else if (!collaborationGrant) {
    persistPlanReviewGrantRequirement(
      services,
      context.runtime,
      status,
      createCollaborationPlanReviewRequirementV3({
        investigationId: status.investigationId,
        changeId: status.changeId,
        subject: planning.subject,
        author: recordedAuthor,
        grantRequest,
      }),
    );
    return null;
  } else {
    if (grantRequest === null) {
      throw workflowError(
        'COLLABORATION_GRANT_FORM_REQUIRED',
        'No provider is callable; submit an explicitly typed caller-supplied or direct-human PlanReview grant.',
        ExitCode.guard,
      );
    }
    const expectedBinding = deriveCollaborationGrantBinding(
      services,
      context.git.repositoryRoot,
      grantRequest,
    );
    const verifier = resolveAuthoritativeCollaborationGrantVerifier(
      collaborationGrant.verifier,
    );
    const transitionDigest = collaborationTransitionDigest(expectedBinding);
    const reservation =
      services.grants.reserveCollaborationGrantUnderLifecycleLock(
        context.git.repositoryRoot,
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
      targetDigest: planning.subject.subjectDigest,
      reservation,
      actualParticipant: {
        providerId: author.providerId,
        sessionId: providerSessionId,
        principalId: undefined,
        identityAssurance: author.identityAssurance,
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
  const materializationNodeId = currentRefs[PLANNING_MATERIALIZATION_REF];
  if (!materializationNodeId) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_STALE',
      'Plan review requires current planning materialization evidence.',
      ExitCode.staleState,
    );
  }
  const materializationNode = services.evidence.readEvidenceNode(
    context.runtime,
    materializationNodeId,
  );
  const materializationOutput = materializationNode.output;
  if (
    !isRecord(materializationOutput) ||
    !isDigestRecord(materializationOutput.artifacts)
  ) {
    throw workflowError(
      'PLANNING_MATERIALIZATION_STALE',
      'Plan review requires valid current planning materialization evidence.',
      ExitCode.staleState,
    );
  }
  const changePrefix = `${context.config.changeRoot}/${status.changeId}`;
  const snapshotContents = readPlanReviewSnapshotContents(
    context.git.repositoryRoot,
    changePrefix,
    materializationOutput.artifacts,
  );
  const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
    changeId: status.changeId,
    changePrefix,
    subject: planning.subject,
    materializationNode,
    artifacts: snapshotContents,
  });
  services.evidence.writeEvidenceNode(context.runtime, targetSnapshotNode);
  const planningTarget = readPlanReviewTargetSnapshotNode(targetSnapshotNode);
  const reviewAuthorization = createPlanReviewAuthorizationNode({
    planning,
    assignment,
    grantAuthorization,
    roleTopology,
    targetSnapshotNode,
    materializationNode,
    materializationNodeId,
    author: recordedAuthor,
  });
  services.evidence.writeEvidenceNode(context.runtime, reviewAuthorization);
  const invocationId = createRuntimeId('invocation');
  const manifest: PlanReviewManifest & {
    planningTarget: PlanReviewTargetSnapshot;
  } = {
    schemaVersion: 1,
    kind: 'plan-review-manifest',
    changeId: status.changeId,
    repositoryId: context.config.repositoryName,
    baseCommit: status.baseline.head,
    baseTree: status.baseline.tree,
    subject: planning.subject,
    planningTarget,
    capabilityProfile: 'repository-read-only',
  };
  const request = createProviderInvocationRequest({
    invocationId,
    nonce: `plan-review-${crypto.randomUUID()}`,
    purpose: 'plan-review',
    providerId: assignment.providerId,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: context.config.repositoryName,
    baseCommit: status.baseline.head,
    baseTree: status.baseline.tree,
    targetDigest: planning.subject.subjectDigest,
    inputManifestDigest:
      services.provider.providerInvocationManifestDigest(manifest),
    authorizationNodeId: reviewAuthorization.nodeId,
    writeAllowedPaths: [],
    outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
    evaluatorVersion: 'plan-review.v2',
    policyDigest: policy.digest,
    limits: {
      timeoutMs: policy.policy.limits.timeoutMs,
      aggregateOutputBytes: policy.policy.limits.aggregateOutputBytes,
    },
  });
  const reservationNode = createPlanReviewReservationNode({
    status,
    planning,
    assignment,
    author: recordedAuthor,
    materializationNode,
    targetSnapshotNode,
    manifest,
    request,
    grantAuthorization,
    reviewAuthorization,
  });
  services.provider.storeProviderExecutionPolicySnapshot(
    context.runtime,
    request,
    policy,
  );
  services.evidence.writeEvidenceNode(context.runtime, reservationNode);
  services.evidence.compareAndSwapEvidenceRef(context.runtime, {
    changeId: status.changeId,
    refName: PLAN_REVIEW_REQUEST_REF,
    expectedNodeId: expectedReservationNodeId,
    nextNodeId: reservationNode.nodeId,
  });
  const reservation = {
    reservationNode,
    planning,
    subject: planning.subject,
    assignment,
    author: recordedAuthor,
    materializationNode,
    targetSnapshotNode,
    manifest,
    request,
    grantAuthorization,
    roleTopology,
    retry: null,
  };
  authorizePlanReviewReservationMandate(
    cwd,
    mandateBinding,
    reservation,
    assertOwned,
  );
  ensurePlanReviewInvocation(
    services,
    context.git.repositoryRoot,
    context.runtime,
    status,
    reservation,
    mandateBinding,
  );
  return reservation;
}

function planAuthor(
  services: Pick<ProposeRuntime, 'evidence' | 'provider'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  status: ProposeLifecycleStatus,
): RoleParticipant {
  if (status.state === 'investigation-exempt') {
    return {
      providerId: status.actor.providerId,
      sessionId: `plan-author-${status.investigationId}`,
      principalId: undefined,
      identityAssurance: status.actor.assurance,
      engineSpawned: false,
    };
  }
  const blindRequest = services.provider.readProviderInvocationRequest(
    paths,
    status.providerInvocationId,
  );
  const authorization = readProposeAuthorization(services, paths, blindRequest);
  return {
    providerId: authorization.actor.providerId,
    sessionId: `plan-author-${status.investigationId}`,
    principalId: undefined,
    identityAssurance: authorization.actor.assurance,
    engineSpawned: false,
  };
}

export function ensurePlanReviewInvocation(
  services: Pick<ProposeRuntime, 'provider'>,
  repositoryRoot: string,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  status: ProposeLifecycleStatus,
  reservation: PlanReviewReservation,
  mandateBinding: TaskMandateBinding | undefined,
  prevalidatedSnapshotFiles?: Array<{
    snapshotFile: string;
    content: Buffer;
  }>,
): void {
  if (reservation.retry === null) {
    services.provider.ensureProviderExecutionPolicySnapshot(
      paths,
      reservation.request,
      services.provider.loadAiAdapterPolicy(repositoryRoot),
    );
  } else {
    services.provider.ensureProviderExecutionPolicySnapshotFromSnapshot(
      paths,
      reservation.request,
      reservation.retry.executionPolicySnapshot,
    );
  }
  if (
    services.provider.providerInvocationExists(
      paths,
      reservation.request.invocationId,
    )
  ) {
    const record = services.provider.readProviderInvocation(
      paths,
      reservation.request.invocationId,
    );
    const durable = services.provider.readProviderInvocationRequest(
      paths,
      reservation.request.invocationId,
    );
    if (
      record.investigationId !== status.investigationId ||
      record.changeId !== status.changeId ||
      canonicalJson(record.mandateBinding ?? null) !==
        canonicalJson(mandateBinding ?? null) ||
      record.attempt !== (reservation.retry?.attempt ?? 1) ||
      record.requestDigest !== reservation.request.requestDigest ||
      canonicalJson(durable) !== canonicalJson(reservation.request)
    ) {
      throw workflowError(
        'PLAN_REVIEW_REQUEST_CONFLICT',
        'The durable plan-review request differs from its reservation.',
        ExitCode.conflict,
      );
    }
    return;
  }
  const planReviewSnapshotFiles =
    prevalidatedSnapshotFiles ??
    (reservation.retry === null
      ? reservation.manifest.planningTarget.artifacts.map((artifact) => {
          const target = path.join(repositoryRoot, artifact.path);
          const stats = fs.lstatSync(target, { throwIfNoEntry: false });
          if (
            !stats?.isFile() ||
            stats.isSymbolicLink() ||
            stats.nlink !== 1 ||
            (stats.mode & 0o777) !== 0o644
          ) {
            throw workflowError(
              'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
              'Current planning target contains an unsafe artifact.',
              ExitCode.staleState,
            );
          }
          const content = fs.readFileSync(target);
          if (
            content.byteLength !== artifact.byteLength ||
            sha256(content) !== artifact.sha256
          ) {
            throw workflowError(
              'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
              'Current planning bytes differ from the reserved target snapshot.',
              ExitCode.staleState,
            );
          }
          return {
            snapshotFile: artifact.snapshotFile,
            content,
          };
        })
      : copyPriorPlanReviewSnapshot(services, paths, reservation));
  services.provider.createProviderInvocation(paths, {
    investigationId: status.investigationId,
    changeId: status.changeId,
    ...(mandateBinding ? { mandateBinding } : {}),
    attempt: reservation.retry?.attempt ?? 1,
    manifest: reservation.manifest,
    request: reservation.request,
    planReviewSnapshotFiles,
  });
}

function copyPriorPlanReviewSnapshot(
  services: Pick<ProposeRuntime, 'provider'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  reservation: PlanReviewReservation,
): Array<{ snapshotFile: string; content: Buffer }> {
  if (reservation.retry === null) {
    throw planReviewRequestStale();
  }
  return readPriorPlanReviewSnapshotFiles(
    services,
    paths,
    reservation.manifest,
    reservation.retry.failedInvocation.invocationId,
  );
}

export function readPriorPlanReviewSnapshotFiles(
  services: Pick<ProposeRuntime, 'provider'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  manifest: PlanReviewReservation['manifest'],
  failedInvocationId: string,
): Array<{ snapshotFile: string; content: Buffer }> {
  const snapshot = services.provider.readPlanReviewSnapshotRuntime(
    paths,
    failedInvocationId,
  );
  if (snapshot === null) {
    throw workflowError(
      'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
      'Failed PlanReview invocation has no immutable target snapshot.',
      ExitCode.staleState,
    );
  }
  return readPriorPlanReviewSnapshotContents(
    snapshot.root,
    manifest.planningTarget.artifacts,
  );
}
