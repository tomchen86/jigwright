/**
 * Resolves the planning workspace, captured intent, and authority for propose.
 *
 * Invariants:
 * - Repository identity, branch, and baseline agree with the current durable owner.
 * - Captured Source wording and change-origin references preserve exact identity.
 * - A revising task and its held planning authority remain attached to the change.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  type CollaborationGrantExpectedBinding,
  type CollaborationGrantRequest,
  COLLABORATION_GRANT_POLICY_DIGEST,
} from '../../modules/authority/collaboration-grant.ts';
import {
  type AuthoritativeCollaborationGrantVerifier,
  assertAuthoritativeCollaborationGrantVerifier,
} from '../../modules/authority/grant-verifier-port.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  type AuthoritativeRoleContextSharingGrantVerifier,
  assertAuthoritativeRoleContextSharingGrantVerifier,
} from '../../modules/authority/role-context-sharing-grant-verifier-port.ts';
import {
  captureGovernanceSource,
  readGovernanceSource,
} from '../../modules/governance-intake/governance-intake.ts';
import {
  ensureWorkItemPromotionChangeDirectory,
  linkSourceToChange,
  readCurrentChangeOrigin,
} from '../../modules/governance-intake/work-registry.ts';
import { listSessions } from '../execute-task/session.ts';
import { withTaskRevisionPlanningOperation } from '../revise/task-revision.ts';
import type {
  HeldChangeTransitionAuthority,
  InvestigationCheckpointEnvelope,
  InvestigationStatus,
  NormalizedChangeIntent,
  ProposeExemptionSession,
  ProposeRuntime,
} from './propose-runtime.ts';
import {
  type ProposeLifecycleStatus,
  type ProposeOptions,
} from './propose-types.ts';

export function deriveCollaborationGrantBinding(
  services: Pick<ProposeRuntime, 'workspace'>,
  repositoryRoot: string,
  request: CollaborationGrantRequest,
): CollaborationGrantExpectedBinding {
  const policy = loadMaintainerPolicyAtCommit(
    services,
    repositoryRoot,
    request.baselineCommit,
  );
  return {
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob: services.workspace
      .runGit(repositoryRoot, [
        'rev-parse',
        `${request.baselineCommit}:workflow/maintainer-policy.json`,
      ])
      .trim(),
    collaborationPolicyDigest: COLLABORATION_GRANT_POLICY_DIGEST,
    changeId: request.changeId,
    taskId: request.taskId,
    baselineCommit: request.baselineCommit,
    baselineTree: request.baselineTree,
    targetDigest: request.targetDigest,
    lifecyclePhase: request.lifecyclePhase,
    rolePair: request.rolePair,
    availableActor: request.availableActor,
    degradedForm: request.degradedForm,
    reason: request.reason,
  };
}

export function loadMaintainerPolicyAtCommit(
  services: Pick<ProposeRuntime, 'workspace'>,
  repositoryRoot: string,
  baselineCommit: string,
): ReturnType<typeof parseMaintainerPolicy> {
  const policyText = services.workspace.runGit(repositoryRoot, [
    'show',
    `${baselineCommit}:workflow/maintainer-policy.json`,
  ]);
  let policyValue: unknown;
  try {
    policyValue = JSON.parse(policyText);
  } catch (error) {
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The baseline maintainer policy is not valid JSON.',
      ExitCode.guard,
      {
        details: {
          cause: error instanceof Error ? error.message : String(error),
        },
      },
    );
  }
  return parseMaintainerPolicy(policyValue);
}

export function resolveAuthoritativeCollaborationGrantVerifier(
  candidate: unknown,
): AuthoritativeCollaborationGrantVerifier {
  assertAuthoritativeCollaborationGrantVerifier(candidate);
  return candidate;
}

export function resolveAuthoritativeRoleContextSharingGrantVerifier(
  candidate: unknown,
): AuthoritativeRoleContextSharingGrantVerifier {
  assertAuthoritativeRoleContextSharingGrantVerifier(candidate);
  return candidate;
}

export function assertProposeStartContextStable(
  before: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >,
  after: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >,
): void {
  if (
    before.git.repositoryRealPath !== after.git.repositoryRealPath ||
    before.git.gitCommonDirectory !== after.git.gitCommonDirectory ||
    before.config.runtimeDirectory !== after.config.runtimeDirectory ||
    before.git.branch !== after.git.branch ||
    before.git.head !== after.git.head ||
    before.git.tree !== after.git.tree
  ) {
    throw workflowError(
      'INVESTIGATION_START_STALE',
      'Repository identity, branch, or pinned baseline changed during propose start.',
      ExitCode.staleState,
    );
  }
}

export function currentRevisingTaskSession(cwd: string, changeId: string) {
  const matches = listSessions(cwd).filter(
    (session) => session.changeId === changeId && session.state === 'revising',
  );
  if (matches.length > 1) {
    throw workflowError(
      'TASK_REVISION_AUTHORITY_AMBIGUOUS',
      `Change ${changeId} has more than one revising task session.`,
      ExitCode.conflict,
    );
  }
  return matches[0] ?? null;
}

export function withProposeTransitionAuthority<T>(
  services: Pick<ProposeRuntime, 'workspace'>,
  cwd: string,
  lifecycleRuntime: Parameters<
    ProposeRuntime['workspace']['withInvestigationTransitionAuthority']
  >[0],
  changeId: string,
  operation: (authority: HeldChangeTransitionAuthority) => T,
): T {
  const revising = currentRevisingTaskSession(cwd, changeId);
  if (revising === null) {
    return services.workspace.withInvestigationTransitionAuthority(
      lifecycleRuntime,
      changeId,
      operation,
    );
  }
  return withTaskRevisionPlanningOperation(
    revising.repositoryRoot,
    revising.sessionId,
    operation,
  );
}

export function resumeInvestigationForPropose(
  services: Pick<ProposeRuntime, 'investigation' | 'workspace'>,
  cwd: string,
  changeId: string,
  investigationId: string,
  checkpoint?: InvestigationCheckpointEnvelope,
): InvestigationStatus {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  return withProposeTransitionAuthority(
    services,
    cwd,
    context.lifecycleRuntime,
    changeId,
    (authority) =>
      services.investigation.resumeInvestigationSessionUnderAuthority(
        cwd,
        changeId,
        investigationId,
        checkpoint,
        authority,
      ),
  );
}

export function assertCurrentExemptionContext(
  services: Pick<ProposeRuntime, 'investigation'>,
  context: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >,
  session: ProposeExemptionSession,
): void {
  const current = services.investigation.readCurrentProposeExemptionSession(
    context.runtime,
    session.changeId,
  );
  if (!currentExemptionContextMatches(context, session, current)) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'The structured investigation exemption is no longer current for this repository context.',
      ExitCode.staleState,
    );
  }
}

export function currentExemptionContextMatches(
  context: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >,
  session: ProposeExemptionSession,
  current: ProposeExemptionSession | null,
): boolean {
  return (
    context.git.repositoryRealPath === session.repositoryRoot &&
    context.git.gitCommonDirectory === session.gitCommonDirectory &&
    context.git.branch === session.branch &&
    context.git.head === session.baseline.head &&
    context.git.tree === session.baseline.tree &&
    current !== null &&
    current.investigationId === session.investigationId &&
    current.revision === session.revision &&
    current.intentDigest === session.intentDigest &&
    current.applicability.applicabilityDigest ===
      session.applicability.applicabilityDigest
  );
}

export function getProposeLifecycleStatus(
  services: Pick<ProposeRuntime, 'investigation' | 'workspace'>,
  cwd: string,
  investigationId: string,
): ProposeLifecycleStatus {
  if (
    services.investigation.isProposeExemptionInvestigationId(investigationId)
  ) {
    const context = services.workspace.loadInvestigationRuntimeContext(cwd);
    return services.investigation.readProposeExemptionSession(
      context.runtime,
      investigationId,
    );
  }
  return services.investigation.getInvestigationStatus(cwd, investigationId);
}

export function resolveProposePlanningWorkspaceForInvestigation(
  services: Pick<ProposeRuntime, 'investigation' | 'workspace'>,
  cwd: string,
  investigationId: string,
): string {
  const context = services.workspace.loadInvestigationRuntimeContext(cwd);
  const changeId = services.investigation.isProposeExemptionInvestigationId(
    investigationId,
  )
    ? services.investigation.readProposeExemptionSession(
        context.runtime,
        investigationId,
      ).changeId
    : services.investigation.readInvestigationSession(
        context.runtime,
        investigationId,
      ).changeId;
  return resolveProposePlanningWorkspace(services, cwd, changeId, 'status');
}

export function resolveProposePlanningWorkspace(
  services: Pick<ProposeRuntime, 'workspace'>,
  cwd: string,
  changeId: string,
  mode: 'start' | 'resume' | 'status',
  immediateSource: ReturnType<typeof readGovernanceSource> | null = null,
): string {
  const repository = services.workspace.discoverRepository(cwd);
  const revising = currentRevisingTaskSession(cwd, changeId);
  if (revising !== null) {
    return revising.repositoryRoot;
  }
  const config = services.workspace.loadWorkflowConfig(
    repository.repositoryRoot,
  );
  const expectedBranch = config.branchTemplate.replaceAll(
    '{changeId}',
    changeId,
  );
  const record =
    mode === 'status'
      ? services.workspace.inspectPlanningDraftWorkspace(cwd, changeId)
      : services.workspace.readPlanningDraftWorkspace(cwd, changeId);
  if (record) {
    if (mode === 'status') {
      return record.worktreePath;
    }
    if (immediateSource !== null) {
      materializeImmediateSource(
        record.worktreePath,
        changeId,
        immediateSource,
      );
    }
    const prepared = services.workspace.preparePlanningDraftWorkspace(
      cwd,
      changeId,
      {
        baseCommit: record.baseCommit,
        ...(repository.repositoryRealPath === record.worktreePath
          ? { adoptCurrentWorktree: true }
          : { workspaceParent: path.dirname(record.worktreePath) }),
      },
    );
    return prepared.worktreePath;
  }
  if (repository.branch === expectedBranch) {
    if (mode === 'status') {
      return repository.repositoryRealPath;
    }
    if (immediateSource !== null) {
      materializeImmediateSource(
        repository.repositoryRealPath,
        changeId,
        immediateSource,
      );
    }
    return services.workspace.preparePlanningDraftWorkspace(cwd, changeId, {
      baseCommit: repository.head,
      adoptCurrentWorktree: true,
    }).worktreePath;
  }
  if (mode !== 'start') {
    throw workflowError(
      'PLANNING_WORKSPACE_NOT_FOUND',
      `No durable planning workspace owns change ${changeId}.`,
      ExitCode.staleState,
    );
  }
  const prepared = services.workspace.preparePlanningDraftWorkspace(
    cwd,
    changeId,
    {
      baseCommit: repository.head,
    },
  );
  if (immediateSource !== null) {
    materializeImmediateSource(
      prepared.worktreePath,
      changeId,
      immediateSource,
    );
  }
  return prepared.worktreePath;
}

export function resolveImmediateSource(
  repositoryRoot: string,
  changeId: string,
  intent: NormalizedChangeIntent,
  binding: ProposeOptions['immediateSource'],
): ReturnType<typeof readGovernanceSource> | null {
  if (binding === undefined) return null;
  if (
    !/^SRC-[0-9a-f]{64}$/.test(binding.sourceId) ||
    typeof binding.exactText !== 'string' ||
    changeId !==
      `source-${crypto.createHash('sha256').update(binding.exactText).digest('hex')}` ||
    canonicalJson(intent.sourceRefs) !== canonicalJson([binding.sourceId])
  ) {
    throw workflowError(
      'PROPOSE_INTENT_INVALID',
      'Immediate propose binding does not match its exact Source intent.',
      ExitCode.usage,
    );
  }
  const source = readGovernanceSource(repositoryRoot, binding.sourceId);
  if (source.text !== binding.exactText || source.supersedes !== null) {
    throw workflowError(
      'PROPOSE_INTENT_INVALID',
      'Immediate propose Source no longer matches its exact captured wording.',
      ExitCode.usage,
    );
  }
  return source;
}

function materializeImmediateSource(
  repositoryRoot: string,
  changeId: string,
  source: ReturnType<typeof readGovernanceSource>,
): void {
  const changeDirectory = ensureWorkItemPromotionChangeDirectory(
    repositoryRoot,
    changeId,
  );
  const existingOrigin = readCurrentChangeOrigin(repositoryRoot, changeId);
  if (existingOrigin !== null) {
    if (
      canonicalJson(existingOrigin) !==
      canonicalJson({
        schemaVersion: 1,
        sourceRefs: [source.id],
        workItemRefs: [],
      })
    ) {
      throw workflowError(
        'PROPOSE_INPUT_STALE',
        'Immediate propose origin no longer cites exactly its captured Source.',
        ExitCode.staleState,
      );
    }
    if (
      canonicalJson(readGovernanceSource(repositoryRoot, source.id)) !==
      canonicalJson(source)
    ) {
      throw workflowError(
        'PROPOSE_INPUT_STALE',
        'Immediate propose Source bytes no longer match the captured Source.',
        ExitCode.staleState,
      );
    }
    return;
  }
  const captured = captureGovernanceSource(repositoryRoot, {
    semanticAuthor: source.semanticAuthor,
    capturedBy: source.capturedBy,
    capturedAt: source.capturedAt,
    contextRef: source.contextRef,
    text: source.text,
    supersedes: source.supersedes,
  });
  if (captured.source.id !== source.id) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'Immediate propose Source identity changed during workspace bootstrap.',
      ExitCode.staleState,
    );
  }
  linkSourceToChange(repositoryRoot, source.id, changeId);
  const publishedOrigin = readCurrentChangeOrigin(repositoryRoot, changeId);
  if (
    publishedOrigin === null ||
    canonicalJson(publishedOrigin) !==
      canonicalJson({
        schemaVersion: 1,
        sourceRefs: [source.id],
        workItemRefs: [],
      })
  ) {
    throw workflowError(
      'PROPOSE_INPUT_STALE',
      'Immediate propose origin publication did not converge exactly.',
      ExitCode.staleState,
    );
  }
}

export function assertCurrentGovernanceSources(
  repositoryRoot: string,
  sourceRefs: readonly `SRC-${string}`[],
): void {
  for (const sourceRef of sourceRefs) {
    readGovernanceSource(repositoryRoot, sourceRef);
  }
}

export function currentChangeOriginBytes(
  sourceRefs: readonly `SRC-${string}`[],
): string {
  return `${canonicalJson({
    schemaVersion: 1,
    sourceRefs,
    workItemRefs: [],
  })}\n`;
}
