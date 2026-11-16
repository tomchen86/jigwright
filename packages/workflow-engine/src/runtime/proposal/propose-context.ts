import path from 'node:path';
import crypto from 'node:crypto';
import {
  type CollaborationGrantRequest,
  type CollaborationGrantExpectedBinding,
  COLLABORATION_GRANT_POLICY_DIGEST,
} from '../../modules/authority/collaboration-grant-codec.ts';
import { runGit } from '../repository-transaction/git-command.ts';
import { parseMaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  type AuthoritativeCollaborationGrantVerifier,
  assertAuthoritativeCollaborationGrantVerifier,
} from '../../modules/authority/grant-verifier-port.ts';
import {
  type AuthoritativeRoleContextSharingGrantVerifier,
  assertAuthoritativeRoleContextSharingGrantVerifier,
} from '../../modules/authority/role-context-sharing-grant-verifier-port.ts';
import { observeInvestigationRuntimeContext as loadInvestigationRuntimeContext } from '../repository-observation/investigation-runtime-context.ts';
import { listSessions } from '../repository-observation/workflow-session-context.ts';
import {
  type HeldChangeTransitionAuthority,
  withInvestigationTransitionAuthority,
} from '../session-workspace/planning-lock.ts';
import type { ProposeDecisionServices } from './propose-decision-services.ts';
import type { InvestigationCheckpointEnvelope } from '../../modules/investigation/domain/investigation-session-types.ts';
import type { InvestigationStatus } from '../../modules/lifecycle/investigation-status.ts';
import {
  resumeInvestigationSessionUnderAuthority,
  getInvestigationStatus,
} from '../investigation-lifecycle/investigation-session.ts';
import type { ProposeExemptionSession } from '../../modules/lifecycle/propose-exemption-session.ts';
import {
  readCurrentProposeExemptionSession,
  readProposeExemptionSession,
} from '../storage-journal/propose-exemption-store.ts';
import type {
  ProposeLifecycleStatus,
  ProposeOptions,
} from '../../modules/proposal/propose-types.ts';
import { isProposeExemptionInvestigationId } from '../../modules/investigation/domain/investigation-store-values.ts';
import { readInvestigationSession } from '../storage-journal/investigation-session-records.ts';
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';
import { discoverRepository } from '../repository-transaction/git-working-state.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import type { NormalizedChangeIntent } from '../../modules/source/change-intent.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

export function deriveCollaborationGrantBinding(
  repositoryRoot: string,
  request: CollaborationGrantRequest,
): CollaborationGrantExpectedBinding {
  const policy = loadMaintainerPolicyAtCommit(
    repositoryRoot,
    request.baselineCommit,
  );
  return {
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob: runGit(repositoryRoot, [
      'rev-parse',
      `${request.baselineCommit}:workflow/maintainer-policy.json`,
    ]).trim(),
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
  repositoryRoot: string,
  baselineCommit: string,
): ReturnType<typeof parseMaintainerPolicy> {
  const policyText = runGit(repositoryRoot, [
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
  before: ReturnType<typeof loadInvestigationRuntimeContext>,
  after: ReturnType<typeof loadInvestigationRuntimeContext>,
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
export function createProposeContext({
  planningWorkspace,
  sources,
  withTaskRevisionPlanningOperation,
  workRegistry,
}: {
  planningWorkspace: ProposeDecisionServices['planningWorkspace'];
  sources: ProposeDecisionServices['sources'];
  withTaskRevisionPlanningOperation: ProposeDecisionServices['withTaskRevisionPlanningOperation'];
  workRegistry: ProposeDecisionServices['workRegistry'];
}) {
  function withProposeTransitionAuthority<T>(
    cwd: string,
    lifecycleRuntime: Parameters<
      typeof withInvestigationTransitionAuthority
    >[0],
    changeId: string,
    operation: (authority: HeldChangeTransitionAuthority) => T,
  ): T {
    const revising = currentRevisingTaskSession(cwd, changeId);
    if (revising === null) {
      return withInvestigationTransitionAuthority(
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

  function resumeInvestigationForPropose(
    cwd: string,
    changeId: string,
    investigationId: string,
    checkpoint?: InvestigationCheckpointEnvelope,
  ): InvestigationStatus {
    const context = loadInvestigationRuntimeContext(cwd);
    return withProposeTransitionAuthority(
      cwd,
      context.lifecycleRuntime,
      changeId,
      (authority) =>
        resumeInvestigationSessionUnderAuthority(
          cwd,
          changeId,
          investigationId,
          checkpoint,
          authority,
        ),
    );
  }

  function resolveProposePlanningWorkspaceForInvestigation(
    cwd: string,
    investigationId: string,
  ): string {
    const context = loadInvestigationRuntimeContext(cwd);
    const changeId = isProposeExemptionInvestigationId(investigationId)
      ? readProposeExemptionSession(context.runtime, investigationId).changeId
      : readInvestigationSession(context.runtime, investigationId).changeId;
    return resolveProposePlanningWorkspace(cwd, changeId, 'status');
  }

  function resolveProposePlanningWorkspace(
    cwd: string,
    changeId: string,
    mode: 'start' | 'resume' | 'status',
    immediateSource: GovernanceSourceV1 | null = null,
  ): string {
    const repository = discoverRepository(cwd);
    const revising = currentRevisingTaskSession(cwd, changeId);
    if (revising !== null) {
      return revising.repositoryRoot;
    }
    const config = loadWorkflowConfig(repository.repositoryRoot);
    const expectedBranch = config.branchTemplate.replaceAll(
      '{changeId}',
      changeId,
    );
    const record =
      mode === 'status'
        ? planningWorkspace.inspectPlanningDraftWorkspace(cwd, changeId)
        : planningWorkspace.readPlanningDraftWorkspace(cwd, changeId);
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
      const prepared = planningWorkspace.preparePlanningDraftWorkspace(
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
      return planningWorkspace.preparePlanningDraftWorkspace(cwd, changeId, {
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
    const prepared = planningWorkspace.preparePlanningDraftWorkspace(
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

  function resolveImmediateSource(
    repositoryRoot: string,
    changeId: string,
    intent: NormalizedChangeIntent,
    binding: ProposeOptions['immediateSource'],
  ): GovernanceSourceV1 | null {
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
    const source = sources.readGovernanceSource(
      repositoryRoot,
      binding.sourceId,
    );
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
    source: GovernanceSourceV1,
  ): void {
    const changeDirectory = workRegistry.ensureWorkItemPromotionChangeDirectory(
      repositoryRoot,
      changeId,
    );
    const existingOrigin = workRegistry.readCurrentChangeOrigin(
      repositoryRoot,
      changeId,
    );
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
        canonicalJson(
          sources.readGovernanceSource(repositoryRoot, source.id),
        ) !== canonicalJson(source)
      ) {
        throw workflowError(
          'PROPOSE_INPUT_STALE',
          'Immediate propose Source bytes no longer match the captured Source.',
          ExitCode.staleState,
        );
      }
      return;
    }
    const captured = sources.captureGovernanceSource(repositoryRoot, {
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
    workRegistry.linkSourceToChange(repositoryRoot, source.id, changeId);
    const publishedOrigin = workRegistry.readCurrentChangeOrigin(
      repositoryRoot,
      changeId,
    );
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

  function assertCurrentGovernanceSources(
    repositoryRoot: string,
    sourceRefs: readonly `SRC-${string}`[],
  ): void {
    for (const sourceRef of sourceRefs) {
      sources.readGovernanceSource(repositoryRoot, sourceRef);
    }
  }
  return {
    withProposeTransitionAuthority,
    resumeInvestigationForPropose,
    resolveProposePlanningWorkspaceForInvestigation,
    resolveProposePlanningWorkspace,
    resolveImmediateSource,
    assertCurrentGovernanceSources,
  };
}

export function assertCurrentExemptionContext(
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
  session: ProposeExemptionSession,
): void {
  const current = readCurrentProposeExemptionSession(
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
  context: ReturnType<typeof loadInvestigationRuntimeContext>,
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
  cwd: string,
  investigationId: string,
): ProposeLifecycleStatus {
  if (isProposeExemptionInvestigationId(investigationId)) {
    const context = loadInvestigationRuntimeContext(cwd);
    return readProposeExemptionSession(context.runtime, investigationId);
  }
  return getInvestigationStatus(cwd, investigationId);
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
