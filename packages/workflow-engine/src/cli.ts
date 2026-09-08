#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadWorkflowConformanceVectorsV2 } from '@jigwright/core/conformance-vectors';
import { canonicalJson } from './foundation/canonical-json/canonical-json.ts';

import { dispatchAiAdapterCommand } from './entrypoints/cli/ai-adapter-cli.ts';
import { dispatchAgentProviderCommand } from './entrypoints/cli/agent-provider-cli.ts';
import { dispatchAgentGuidanceCommand } from './entrypoints/cli/agent-guidance-cli.ts';
import { inspectProjectionStatus } from './composition-root/projection-status-production.ts';
import { dispatchCentralRoleProviderDefaultCommand } from './entrypoints/cli/central-role-provider-default-cli.ts';
import { commitArchiveTransition } from './application/archive/archive-transition.ts';
import {
  discoverArchivePullRequestCandidates,
  inspectArchivePublicationPreparation,
  preparePostMergeArchivePullRequest,
  publishPostMergeArchivePullRequest,
  type ExactArchiveBranchPublisherPortV1,
  type GitHubArchiveAdapterModuleV1,
} from './application/archive/archive-pr-orchestration.ts';
import type {
  GitHubArchiveAdapterConfigV1,
  GitHubArchiveRulesetObserverPortV1,
} from '@jigwright/github-adapter';
import {
  createGitExactArchiveBranchPublisher,
  createGitHubApiArchiveRulesetObserver,
  resolveArchivePullRequestPublicationTarget,
} from './composition-root/archive-pr-publication-production.ts';
import {
  approveAndApplyAuthorityPlan,
  attestAuthorityPlan,
  createAuthorityPlan,
  inspectAuthorityPlan,
  resumeAuthorityPlan,
  type AuthorityPlanIntent,
} from './application/control-plane/authority-plan.ts';
import {
  projectAuthorityRemap,
  type AuthorityRemapPair,
} from './composition-root/authority-remap.ts';
import { dispatchAuthorityAuditCommand } from './entrypoints/cli/authority-audit-cli.ts';
import {
  deriveAuthorityAuditRepositoryId,
  type AuthorityAuditEventType,
  type AuthorityAuditResult,
} from './runtime/storage-journal/authority-audit-ledger.ts';
import { recordAuthorityAuditEvent } from './runtime/storage-journal/authority-audit-service.ts';
import {
  dispatchCollaborationGrantCommand,
  isCollaborationGrantCommand,
} from './entrypoints/cli/collaboration-grant-cli.ts';
import { dispatchRoleContextSharingGrantCommand } from './entrypoints/cli/role-context-sharing-grant-cli.ts';
import { inspectChangeAssurance } from './runtime/repository-transaction/assurance-inspection.ts';
import { loadWorkflowConfig } from './adapters/consumer/repository/work-registry/contracts.ts';
import {
  contextualizeOpenTaskError,
  findOpenTaskLifecycleStatus,
  openTask,
  resolveOpenTaskId,
} from './application/execute-task/open-task.ts';
import {
  checkOpenSpecPlanningAssets,
  generateOpenSpecPlanningAssets,
  installOpenSpecPlanningPrompts,
} from './adapters/planning/openspec/documents/openspec-planning-assets.ts';
import {
  completePreparedPullRequestPreMergeAssurance,
  preparePullRequestPreMergeAssurance,
} from './entrypoints/ci/pre-merge-assurance-git.ts';
import type { IntegrationDeltaReviewSubmission } from './modules/assurance/pre-merge-assurance.ts';
import { inspectT3BoundaryInventory } from './modules/assurance/t3-boundary-inventory.ts';
import type { T3BoundaryTypeScriptApi } from './modules/assurance/t3-boundary-scanner.ts';
import { dispatchDocumentRefreshCommand } from './entrypoints/cli/document-refresh-cli.ts';
import { collectEngineMetrics } from './application/control-plane/engine-metrics.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from './foundation/errors/errors.ts';
import {
  inspectIssuedExecutionBudgetGrant,
  issueExecutionBudgetGrant,
  revokeIssuedExecutionBudgetGrant,
} from './entrypoints/cli/execution-grant-cli.ts';
import { parseExecutionBudgetGrantRequest } from './modules/authority/execution-governance.ts';
import {
  EXTERNAL_EFFECT_MAX_TTL_SECONDS,
  externalEffectStorePaths,
  inspectExternalEffectGrant,
  issueExternalEffectGrant,
  reconcileExternalEffectGrant,
  revokeExternalEffectGrant,
  type ExternalEffectGrantRequest,
  type ExternalEffectKind,
  type ExternalEffectReconciliationRequest,
  type ExternalEffectRollbackPlan,
  type ExternalEffectTarget,
} from './modules/authority/external-effect-grant.ts';
import {
  executeGrantedReplacement,
  requestExecutionReplacement,
} from './application/control-plane/execution-replacement.ts';
import {
  inspectExecutionJob,
  listExecutionJobs,
  prepareProviderReplacement,
  watchExecutionJob,
  type ExecutionJobInspection,
} from './runtime/provider-execution/execution-runtime.ts';
import { pruneProviderRuntime } from './runtime/provider-execution/provider-retention.ts';
import {
  inspectEvidenceRetention,
  pinWorkflowEvidence,
  runEvidenceRetentionMaintenance,
} from './runtime/provider-execution/retention-control.ts';
import { executePublishGrant } from './adapters/remote/github/publish-executor.ts';
import {
  discoverRepository,
  runGit,
} from './runtime/repository-transaction/git.ts';
import { validateHandoff } from './adapters/consumer/repository/handoff/handoff.ts';
import { runRepositoryHook } from './entrypoints/hooks/hooks.ts';
import {
  isHumanGrantCliInvocation,
  runHumanGrantCli,
} from './entrypoints/cli/human-grant-cli.ts';
import {
  requestChangeRoleAssignmentGrant,
  requestArchivePullRequestPublicationGrant,
  requestChangeRoutingContinuationGrant,
  requestProtectedTaskApplyGrant,
  requestProtectedTaskApplyDescendantSettlementGrant,
  requestProtectedTaskApplyRecoveryGrant,
  requestProtectedBaseInitializationGrant,
  requestWorkRegistryPromotionGrant,
  requestWorkRegistryReviewGrant,
} from './composition-root/grant-production.ts';
import {
  assertProtectedTaskApplyRecoveryGrantRequiredDetails,
  type ProtectedTaskApplyRecoveryGrantRequiredDetailsV1,
} from './modules/authority/protected-task-apply-recovery-grant.ts';
import {
  assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails,
  type ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1,
} from './modules/authority/protected-task-apply-descendant-settlement-grant.ts';
import { dispatchGovernanceIntakeCommand } from './entrypoints/cli/governance-intake-cli.ts';
import { inspectGovernanceIntakeCounts } from './modules/governance-intake/intake-summary.ts';
import type {
  WorkItemReviewV1,
  WorkRegistryGrantRequiredDetailsV1,
} from './modules/governance-intake/work-registry.ts';
import { dispatchChangeRoutingCommand } from './entrypoints/cli/change-routing-cli.ts';
import {
  observeChangeRoutingContinuationState,
  parseChangeRoutingIntent,
} from './modules/lifecycle/change-routing.ts';
import { assertMaintainerGrantId } from './modules/authority/maintainer-grant.ts';
import {
  parseMaintainerEvidenceWaivers,
  preflightMaintainerGrantV2,
  type MaintainerEvidenceWaiver,
  type MaintainerGrantV2PreflightRequest,
} from './modules/authority/maintainer-grant-v2.ts';
import {
  issueAuthorityAttestation,
  projectAuthorityAttestationRelay,
  type AuthorityAttestationRequest,
} from './application/control-plane/maintainer-attestation.ts';
import {
  inspectMaintainerGrants,
  maintainerGrantStorePaths,
} from './runtime/storage-journal/maintainer-store.ts';
import {
  assertInteractiveSignerContext,
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from './adapters/signing/ssh/maintainer-signer.ts';
import {
  createConsumedCollaborationGrantReplayVerifier,
  createCurrentAuthoritativeCollaborationGrantVerifier,
  createCurrentAuthoritativeRoleContextSharingGrantVerifier,
  productionConsumedPlanReviewReplayPort,
  productionConsumedRoleResultReplayPort,
} from './composition-root/grant-verifier-composition.ts';
import { readCollaborationGrantInspection } from './runtime/storage-journal/collaboration-grant-store.ts';
import { parseMaintainerPolicy } from './modules/authority/maintainer-policy.ts';
import {
  approveAndApplyMaintainerGrantV2,
  reissueAndApplyMaintainerGrantV2,
  revokeMaintainerGrantV2,
  type ApproveAndApplyMaintainerGrantV2Request,
  type ReissueAndApplyMaintainerGrantV2Request,
} from './application/control-plane/maintainer-approve.ts';
import type { CandidateExternalEffect } from './modules/authority/maintainer-candidate.ts';
import {
  bootstrapInterventionStateRoot,
  dispatchBootstrapInterventionCommand,
} from './entrypoints/cli/intervention-control-bootstrap-cli.ts';
import { createHarnessBootstrapDependencies } from './harness-bootstrap.ts';
import { dispatchInterventionControlCommand } from './entrypoints/cli/intervention-control-cli.ts';
import {
  controlPlaneTaskMandateBindingFromTaskMandate,
  dispatchProductionControlPlaneUpdaterCommand,
} from './entrypoints/cli/intervention-control-updater-cli.ts';
import {
  produceControlPlaneApprovalCandidateV3,
  type ControlPlanePromotionReviewSummaryV3,
} from './application/control-plane/control-plane-promotion-producer.ts';
import {
  assertSameControlPlaneTaskMandateBinding,
  type ControlPlaneTaskMandateValidationPhase,
  type ControlPlaneApprovalSummaryV3,
  type ControlPlaneUpdaterAuditRecord,
} from './application/control-plane/intervention-control-updater.ts';
import {
  discardHumanResolutionGrantPublication,
  inspectHumanResolutionGrantPublicationRecoveries,
  inspectHumanResolutionGrants,
  revokeHumanResolutionGrant,
} from './adapters/planning/investigation/investigation-session.ts';
import { inspectInvestigationQuarantineState } from './runtime/storage-journal/investigation-session-store.ts';
import {
  inspectImplementationReconciliation,
  recordImplementationReconciliation,
} from './modules/why-knowledge/implementation-reconciliation.ts';
import { loadInvestigationRuntimeContext } from './composition-root/lifecycle-context.ts';
import {
  cancelFinalizeRecovery,
  commitSession,
  completeTask,
  finalizeSession,
  findTaskCommits,
  finishSession,
  inspectFinalizeRecoveryStatus,
  recoverFinalize,
  rollbackCompletion,
} from './application/finalize/lifecycle.ts';
import {
  abortSession,
  checkSession,
  getSession,
  listSessions,
  preflightTaskSession,
} from './application/execute-task/session.ts';
import { updateTaskSessionBase } from './application/execute-task/update-base.ts';
import { runtimePaths } from './runtime/session-workspace/session-store.ts';
import {
  inspectTaskRevisionStatus,
  prepareTaskRevisionApprovalBinding,
  resumeTask,
  reviseTask,
} from './application/revise/task-revision.ts';
import {
  inspectTaskStrategyLifecycle,
  resumeTaskStrategy,
  type TaskStrategyLifecycleStatus,
} from './application/execute-task/task-strategy-lifecycle.ts';
import { parseTaskStrategyRedRevisionRequest } from './runtime/storage-journal/task-strategy-red-revision-store.ts';
import {
  beginTaskDiffReviewContinuationFromInput,
  beginTaskDiffReview,
  inspectTaskDiffReviewStatus,
  inspectTaskDiffReviewSubject,
  loadCurrentAuthenticatedTaskDiffReview,
  reconcileExternalTaskDiffReview,
  reconcileTaskDiffReviewContinuation,
  reconcileTaskDiffReview,
  resumeDirectHumanTaskDiffReview,
  submitExternalTaskDiffReview,
  submitExternalTaskDiffReviewContinuation,
} from './application/finalize/task-diff-review-lifecycle.ts';
import { createTaskDiffReviewChallengeResponse } from './modules/assurance/task-diff-review-artifact.ts';
import {
  parseTaskDiffReviewChallengeResponseInput,
  parseTaskDiffReviewExternalClosureRequestInput,
  parseTaskDiffReviewExternalSubmissionInput,
  type TaskDiffReviewChallengeResponseInput,
  type TaskDiffReviewExternalClosureRequestInput,
  type TaskDiffReviewExternalSubmissionInput,
} from './modules/assurance/task-diff-review-input.ts';
import { issueTaskRevisionApproval } from './modules/authority/task-revision-approval.ts';
import { validateManagedDocuments } from './runtime/managed-documents/validation/managed-documents.ts';
import { diagnoseOpenSpec } from './adapters/planning/openspec/documents/openspec-doctor.ts';
import {
  commitPlanAmendment,
  commitPlanningTransition,
} from './application/propose/planning-transition.ts';
import {
  getProposeStatus,
  resumeProposeFromFile,
  startPropose,
  startProposeFromFile,
} from './application/propose/propose-orchestrator.ts';
import { productionRoleTopologyResolutionPort } from './composition-root/role-topology-resolution-production.ts';
import { productionRoleContextSharingGrantLifecyclePort } from './composition-root/role-context-sharing-grant-lifecycle-production.ts';
import {
  dispatchProviderWorker,
  runProviderWorkerAsync,
} from './entrypoints/worker/provider-worker.ts';
import { readProviderInvocation } from './runtime/storage-journal/provider-invocation-store.ts';
import {
  listProviderAutomaticRetrySchedules,
  listProviderRetryScheduleReceipts,
  pumpProviderRetrySchedules,
} from './runtime/provider-execution/provider-retry-scheduler.ts';
import { runRegisteredCheck } from './adapters/consumer/repository/work-registry/registered-check.ts';
import { loadStableValidatedChangeContract } from './composition-root/validated-contract-context.ts';
import {
  authorizeTaskMandate,
  inspectActiveTaskMandateBinding,
  inspectTaskMandate,
  parseTaskMandateRequest,
  revokeTaskMandate,
} from './modules/authority/task-mandate.ts';
import {
  WORKFLOW_GUIDANCE_CATALOG,
  workflowCommandGuidance,
  workflowFailureRecoveryCommand,
  workflowGuidanceUsageLines,
  workflowResultNextSteps,
} from './modules/guidance/next-steps/workflow-guidance.ts';

type CommandResult = Record<string, unknown>;
type RunCliAsyncDependencies = Readonly<{
  watchJob?: (
    cwd: string,
    jobId: string,
  ) => AsyncIterable<ExecutionJobInspection>;
  writeStdout?: (chunk: string) => void;
}>;
const STANDALONE_COMMAND_FLAGS = new Set(['--resume']);
const toolingRequire = createRequire(import.meta.url);
const OPTION_SHAPED_TEXT_VALUE_OPTIONS = new Set([
  '--message',
  '--rationale',
  '--reason',
  '--replacement',
  '--resolution-reason',
  '--reviewer',
  '--section',
]);

export function runCli(argv: string[], cwd = process.cwd()): number {
  const json = hasTerminalJsonOutputFlag(argv);
  const args = json ? argv.slice(0, -1) : [...argv];

  try {
    const result = dispatch(args, cwd);
    printSuccess(
      json
        ? { ...result, nextSteps: workflowResultNextSteps(result, args) }
        : result,
      json,
    );
    return 0;
  } catch (error) {
    const workflowFailure =
      error instanceof WorkflowError
        ? error
        : workflowError(
            'INTERNAL_ERROR',
            error instanceof Error ? error.message : String(error),
            ExitCode.internal,
          );
    printFailure(workflowFailure, json, args);
    return workflowFailure.exitCode;
  }
}

/**
 * Production CLI entry. Provider work and Fail-Grant challenge creation use
 * the async boundary; ordinary commands retain the synchronous dispatcher.
 */
export async function runCliAsync(
  argv: string[],
  cwd = process.cwd(),
  dependencies: RunCliAsyncDependencies = {},
): Promise<number> {
  const json = hasTerminalJsonOutputFlag(argv);
  const args = json ? argv.slice(0, -1) : [...argv];

  try {
    if (args[0] === 'job' && args[1] === 'watch' && args.length === 3) {
      const watchJob = dependencies.watchJob ?? watchExecutionJob;
      const writeStdout =
        dependencies.writeStdout ??
        ((chunk: string) => {
          process.stdout.write(chunk);
        });
      for await (const observation of watchJob(cwd, args[2]!)) {
        printSuccess(
          {
            command: 'job',
            action: 'watch',
            ok: true,
            result: observation,
          },
          json,
          writeStdout,
        );
      }
      return 0;
    }
    const result = await dispatchAsync(args, cwd);
    printSuccess(
      json
        ? { ...result, nextSteps: workflowResultNextSteps(result, args) }
        : result,
      json,
    );
    return 0;
  } catch (error) {
    const workflowFailure =
      error instanceof WorkflowError
        ? error
        : workflowError(
            'INTERNAL_ERROR',
            error instanceof Error ? error.message : String(error),
            ExitCode.internal,
          );
    printFailure(workflowFailure, json, args);
    return workflowFailure.exitCode;
  }
}

export async function dispatchAsync(
  args: string[],
  cwd: string,
  providerWorker: typeof runProviderWorkerAsync = runProviderWorkerAsync,
  roleAssignmentGrantRequest: typeof requestChangeRoleAssignmentGrant = requestChangeRoleAssignmentGrant,
  changeRoutingGrantRequest: ChangeRoutingGrantRequest = requestChangeRoutingContinuationGrant,
  protectedTaskApplyGrantRequest: typeof requestProtectedTaskApplyGrant = requestProtectedTaskApplyGrant,
  protectedTaskApplyRecoveryGrantRequest: typeof requestProtectedTaskApplyRecoveryGrant = requestProtectedTaskApplyRecoveryGrant,
  protectedTaskApplyDescendantSettlementGrantRequest: typeof requestProtectedTaskApplyDescendantSettlementGrant = requestProtectedTaskApplyDescendantSettlementGrant,
): Promise<CommandResult> {
  const [command, ...rest] = args;
  if (command === 'role-config') {
    return {
      command,
      ok: true,
      result: await dispatchCentralRoleProviderDefaultCommand(
        rest,
        discoverRepository(cwd).repositoryRoot,
      ),
    };
  }
  if (command === 'agent') {
    return {
      command,
      ok: true,
      result: await dispatchAgentProviderCommand(
        rest,
        discoverRepository(cwd).repositoryRoot,
      ),
    };
  }
  if (command === 'archive-pr') {
    return dispatchArchivePullRequest(args, cwd);
  }
  if (command !== 'provider-worker') {
    try {
      return dispatch(args, cwd);
    } catch (error) {
      const failGrant = await createProposeProtectedBaseFailGrantResult(
        args,
        cwd,
        error,
      );
      if (failGrant !== null) return failGrant;
      const roleAssignmentGrant = await createRoleAssignmentFailGrantResult(
        args,
        cwd,
        error,
        roleAssignmentGrantRequest,
      );
      if (roleAssignmentGrant !== null) return roleAssignmentGrant;
      const protectedTaskApplyGrant =
        await createProtectedTaskApplyFailGrantResult(
          args,
          cwd,
          error,
          protectedTaskApplyGrantRequest,
        );
      if (protectedTaskApplyGrant !== null) return protectedTaskApplyGrant;
      const protectedTaskApplyDescendantSettlementGrant =
        await createProtectedTaskApplyDescendantSettlementFailGrantResult(
          args,
          cwd,
          error,
          protectedTaskApplyDescendantSettlementGrantRequest,
        );
      if (protectedTaskApplyDescendantSettlementGrant !== null) {
        return protectedTaskApplyDescendantSettlementGrant;
      }
      const protectedTaskApplyRecoveryGrant =
        await createProtectedTaskApplyRecoveryFailGrantResult(
          args,
          cwd,
          error,
          protectedTaskApplyRecoveryGrantRequest,
        );
      if (protectedTaskApplyRecoveryGrant !== null) {
        return protectedTaskApplyRecoveryGrant;
      }
      const workRegistryGrant = await createWorkRegistryFailGrantResult(
        args,
        cwd,
        error,
      );
      if (workRegistryGrant !== null) return workRegistryGrant;
      const changeRoutingGrant = await createChangeRoutingFailGrantResult(
        args,
        cwd,
        error,
        changeRoutingGrantRequest,
      );
      if (changeRoutingGrant !== null) return changeRoutingGrant;
      throw error;
    }
  }
  requireArgumentCount(command, rest, 1, 1);
  try {
    return {
      command,
      ok: true,
      result: await providerWorker(cwd, rest[0]!),
    };
  } catch (error) {
    const failGrant = await createRoleAssignmentFailGrantResult(
      args,
      cwd,
      error,
      roleAssignmentGrantRequest,
    );
    if (failGrant !== null) return failGrant;
    throw error;
  }
}

export async function createProtectedTaskApplyDescendantSettlementFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: typeof requestProtectedTaskApplyDescendantSettlementGrant = requestProtectedTaskApplyDescendantSettlementGrant,
): Promise<CommandResult | null> {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== 'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_GRANT_REQUIRED'
  ) {
    return null;
  }
  const details = protectedTaskApplyDescendantSettlementRequiredDetails(
    error.details,
  );
  if (details === null) return null;
  const expectedArgs =
    details.action === 'cancel'
      ? [
          'finalize-recover',
          details.sessionId,
          '--cancel',
          details.transactionId,
          '--reason',
          details.reason,
        ]
      : ['abort', details.sessionId, '--reason', details.reason];
  if (canonicalJson(args) !== canonicalJson(expectedArgs)) return null;
  const grant = await requestGrant(
    cwd,
    details,
    `Settle only the ${details.preparedDescendantTree.nodes.length} exact prepared child Grant(s) bound to protected Apply ${details.parentChallengeId}; preserve every observed effect truthfully, then retry ${details.action}.`,
  );
  return {
    command: args[0]!,
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      sessionId: details.sessionId,
      transactionId: details.transactionId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        details,
      },
      grant,
      transitionAppliesOnDecision: false,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        recoveryCommand: `pnpm workflow grant human recover ${grant.challengeId} --json`,
        observeAfterDecision: `pnpm workflow status ${details.sessionId} --json`,
        retryAfterDecision:
          details.action === 'cancel'
            ? `pnpm workflow finalize-recover ${details.sessionId} --cancel ${details.transactionId} --reason ${JSON.stringify(details.reason)} --json`
            : `pnpm workflow abort ${details.sessionId} --reason ${JSON.stringify(details.reason)} --json`,
      },
    },
  };
}

type ChangeRoutingGrantChallenge = Readonly<{
  challengeId: string;
  challengeDigest: string;
}>;

export async function createProtectedTaskApplyFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: typeof requestProtectedTaskApplyGrant = requestProtectedTaskApplyGrant,
): Promise<CommandResult | null> {
  const fullGate = args.length === 5 && args[4] === '--full-gate';
  if (
    (args.length !== 4 && !fullGate) ||
    args[0] !== 'finalize' ||
    args[2] !== '--message' ||
    !(error instanceof WorkflowError) ||
    error.code !== 'PROTECTED_TASK_APPLY_REQUIRED'
  ) {
    return null;
  }
  const sessionId = args[1];
  const commitMessage = args[3];
  const details = protectedTaskApplyRequiredDetails(error.details);
  if (
    sessionId === undefined ||
    commitMessage === undefined ||
    details === null
  ) {
    return null;
  }
  const grant = await requestGrant(
    cwd,
    sessionId,
    commitMessage,
    fullGate,
    details,
    `Authorize only the exact checked finalize of protected task ${details.taskId} for ${details.changeId}; preserve its Task Mandate, baseline, paths, checks, TaskDiffReview, projection, and managed-commit boundaries.`,
  );
  return {
    command: 'finalize',
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      sessionId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        details,
      },
      grant,
      transitionAppliesOnDecision: true,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        recoveryCommand: `pnpm workflow grant human recover ${grant.challengeId} --json`,
        observeAfterDecision: `pnpm workflow status ${sessionId} --json`,
      },
    },
  };
}

export async function createProtectedTaskApplyRecoveryFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: typeof requestProtectedTaskApplyRecoveryGrant = requestProtectedTaskApplyRecoveryGrant,
): Promise<CommandResult | null> {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== 'PROTECTED_TASK_APPLY_RECOVERY_GRANT_REQUIRED'
  ) {
    return null;
  }
  const details = protectedTaskApplyRecoveryRequiredDetails(error.details);
  if (details === null) return null;
  const expectedArgs =
    details.action === 'cancel'
      ? [
          'finalize-recover',
          details.sessionId,
          '--cancel',
          details.transactionId,
          '--reason',
          details.reason,
        ]
      : ['abort', details.sessionId, '--reason', details.reason];
  if (canonicalJson(args) !== canonicalJson(expectedArgs)) return null;
  const grant = await requestGrant(
    cwd,
    details,
    details.action === 'cancel'
      ? `Cancel only protected finalize transaction ${details.transactionId}, restore its exact projection, record its parent Apply as failed, and leave session ${details.sessionId} active.`
      : `Cancel only protected finalize transaction ${details.transactionId}, restore its exact projection, record its parent Apply as failed, then abort session ${details.sessionId}.`,
  );
  return {
    command: args[0]!,
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      sessionId: details.sessionId,
      transactionId: details.transactionId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        details,
      },
      grant,
      transitionAppliesOnDecision: true,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        recoveryCommand: `pnpm workflow grant human recover ${grant.challengeId} --json`,
        observeAfterDecision: `pnpm workflow status ${details.sessionId} --json`,
      },
    },
  };
}

function protectedTaskApplyRecoveryRequiredDetails(
  value: unknown,
): ProtectedTaskApplyRecoveryGrantRequiredDetailsV1 | null {
  try {
    return assertProtectedTaskApplyRecoveryGrantRequiredDetails(value);
  } catch {
    return null;
  }
}

function protectedTaskApplyDescendantSettlementRequiredDetails(
  value: unknown,
): ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1 | null {
  try {
    return assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails(
      value,
    );
  } catch {
    return null;
  }
}

function protectedTaskApplyRequiredDetails(value: unknown): Readonly<{
  changeId: string;
  taskId: string;
  mandateTaskId: string;
  changedPaths: readonly string[];
  roles: readonly string[];
  matchedPatterns: readonly string[];
  unclassifiedScope: boolean;
}> | null {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      'changeId',
      'taskId',
      'mandateTaskId',
      'changedPaths',
      'roles',
      'matchedPatterns',
      'unclassifiedScope',
    ]) ||
    typeof value.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.changeId) ||
    typeof value.taskId !== 'string' ||
    value.taskId.length === 0 ||
    typeof value.mandateTaskId !== 'string' ||
    value.mandateTaskId.length === 0 ||
    !isExactStringArray(value.changedPaths, true) ||
    !isExactStringArray(value.roles, false) ||
    !isExactStringArray(value.matchedPatterns, false) ||
    typeof value.unclassifiedScope !== 'boolean'
  ) {
    return null;
  }
  return Object.freeze({
    changeId: value.changeId,
    taskId: value.taskId,
    mandateTaskId: value.mandateTaskId,
    changedPaths: Object.freeze([...value.changedPaths]),
    roles: Object.freeze([...value.roles]),
    matchedPatterns: Object.freeze([...value.matchedPatterns]),
    unclassifiedScope: value.unclassifiedScope,
  });
}

function isExactStringArray(
  value: unknown,
  requireEntry: boolean,
): value is string[] {
  return (
    Array.isArray(value) &&
    (!requireEntry || value.length > 0) &&
    value.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry.trim() === entry &&
        !/\p{Cc}/u.test(entry),
    ) &&
    new Set(value).size === value.length
  );
}

type ChangeRoutingGrantRequest = (
  cwd: string,
  changeId: string,
  proposedReason: string,
  expected: Readonly<{
    sourceDigest: `sha256:${string}`;
    stateBindingDigest: `sha256:${string}`;
  }>,
) => Promise<ChangeRoutingGrantChallenge>;

export async function createChangeRoutingFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: ChangeRoutingGrantRequest = requestChangeRoutingContinuationGrant,
): Promise<CommandResult | null> {
  if (
    args.length !== 6 ||
    args[0] !== 'route' ||
    args[1] !== 'prepare' ||
    args[2] !== '--intent' ||
    args[4] !== '--output' ||
    !(error instanceof WorkflowError) ||
    error.code !== 'CHANGE_ROUTING_GRANT_REQUIRED'
  ) {
    return null;
  }
  const details = changeRoutingGrantRequiredDetails(error.details);
  if (details === null) return null;
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const intentPath = path.resolve(repositoryRoot, args[3]!);
  let intent: ReturnType<typeof parseChangeRoutingIntent>;
  try {
    intent = parseChangeRoutingIntent(
      JSON.parse(fs.readFileSync(intentPath, 'utf8')) as unknown,
    );
  } catch {
    throw workflowError(
      'CHANGE_ROUTING_GRANT_STATE_CHANGED',
      'The exact resume intent changed before its Central Grant challenge could be created.',
      ExitCode.staleState,
    );
  }
  if (
    intent.action.kind !== 'resume' ||
    intent.action.changeId !== details.changeId ||
    intent.action.grantChallengeId !== undefined
  ) {
    throw workflowError(
      'CHANGE_ROUTING_GRANT_STATE_CHANGED',
      'The exact resume intent no longer matches the protected continuation refusal.',
      ExitCode.staleState,
    );
  }
  const current = observeChangeRoutingContinuationState(
    repositoryRoot,
    details.changeId,
  );
  if (
    current.sourceDigest !== details.sourceDigest ||
    current.digest !== details.stateBindingDigest
  ) {
    throw workflowError(
      'CHANGE_ROUTING_GRANT_STATE_CHANGED',
      'The protected routing record changed before its Central Grant challenge could be created.',
      ExitCode.staleState,
    );
  }
  const grant = await requestGrant(
    repositoryRoot,
    details.changeId,
    `Authorize only this exact protected routing record for ${details.changeId} to return to ready; preserve its source digest, blocker identity, review, managed commit, and no-auto-focus boundary.`,
    {
      sourceDigest: details.sourceDigest,
      stateBindingDigest: details.stateBindingDigest,
    },
  );
  return {
    command: 'route',
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      changeId: details.changeId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        details,
      },
      grant,
      transitionAppliesOnDecision: false,
      inputSchema: {
        schemaVersion: 1,
        kind: 'change-routing-central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        grantChallengeId: grant.challengeId,
        retryAfterDecision: `pnpm workflow route prepare --intent ${shellCommandArgument(args[3]!)} --output ${shellCommandArgument(args[5]!)} --grant ${shellCommandArgument(grant.challengeId)} --json`,
      },
    },
  };
}

function changeRoutingGrantRequiredDetails(value: unknown): Readonly<{
  schemaVersion: 1;
  kind: 'change-routing-grant-required.v1';
  changeId: string;
  sourceDigest: `sha256:${string}`;
  stateBindingDigest: `sha256:${string}`;
}> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const details = value as Record<string, unknown>;
  if (
    Object.keys(details).sort().join('\0') !==
      'changeId\0kind\0schemaVersion\0sourceDigest\0stateBindingDigest' ||
    details.schemaVersion !== 1 ||
    details.kind !== 'change-routing-grant-required.v1' ||
    typeof details.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(details.changeId) ||
    typeof details.sourceDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(details.sourceDigest) ||
    typeof details.stateBindingDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(details.stateBindingDigest)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    kind: 'change-routing-grant-required.v1',
    changeId: details.changeId,
    sourceDigest: details.sourceDigest as `sha256:${string}`,
    stateBindingDigest: details.stateBindingDigest as `sha256:${string}`,
  };
}

export async function createRoleAssignmentFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: typeof requestChangeRoleAssignmentGrant = requestChangeRoleAssignmentGrant,
): Promise<CommandResult | null> {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== 'AGENT_RUNTIME_GRANT_REQUIRED'
  ) {
    return null;
  }
  const invocationId =
    typeof error.details?.invocationId === 'string'
      ? error.details.invocationId
      : args[0] === 'provider-worker' && typeof args[1] === 'string'
        ? args[1]
        : null;
  if (invocationId === null) return null;
  const grant = await requestGrant(
    cwd,
    invocationId,
    'Authorize only this exact prepared provider invocation to use its current below-floor role assignment; preserve all provider, data-authorization, executable-identity, and stale-state checks.',
  );
  return {
    command: args[0] ?? 'provider-worker',
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      invocationId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      grant,
      providerInvocationState: 'prepared',
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        retryAfterDecision: `pnpm workflow provider-worker ${invocationId} --json`,
      },
    },
  };
}

export async function createProposeProtectedBaseFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: typeof requestProtectedBaseInitializationGrant = requestProtectedBaseInitializationGrant,
): Promise<CommandResult | null> {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== 'PROPOSE_PROTECTED_BASE_UNAVAILABLE'
  ) {
    return null;
  }
  // The intent-level facades (`now`, `finding convert --now`) start the same
  // propose and must reach the same Fail-Grant decision instead of a raw error.
  const startsPropose =
    args[0] === 'propose' ||
    args[0] === 'now' ||
    (args[0] === 'finding' && args.includes('--now'));
  const changeId =
    args[0] === 'propose'
      ? args[1]
      : typeof error.details?.changeId === 'string'
        ? error.details.changeId
        : undefined;
  if (!startsPropose || changeId === undefined) return null;
  const grant = await requestGrant(
    cwd,
    'Authorize create-only initialization of the empty canonical remote protected base from the exact current commit so governed planning can continue.',
  );
  return {
    command: args[0]!,
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      changeId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      grant,
      externalPublicationPending: true,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        retryAfterPublication: 'rerun the same propose command',
      },
    },
  };
}

type WorkRegistryGrantChallenge = Readonly<{
  challengeId: string;
  challengeDigest: string;
}>;

type WorkRegistryFailGrantDependencies = Readonly<{
  requestReview(
    cwd: string,
    workItemId: string,
    review: WorkItemReviewV1,
    proposedReason: string,
  ): Promise<WorkRegistryGrantChallenge>;
  requestPromotion(
    cwd: string,
    workItemId: string,
    changeId: string,
    expectedDigest: string,
    proposedReason: string,
  ): Promise<WorkRegistryGrantChallenge>;
}>;

const WORK_REGISTRY_FAIL_GRANT_DEPENDENCIES: WorkRegistryFailGrantDependencies =
  Object.freeze({
    requestReview: requestWorkRegistryReviewGrant,
    requestPromotion: requestWorkRegistryPromotionGrant,
  });

export async function createWorkRegistryFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  dependencies: WorkRegistryFailGrantDependencies = WORK_REGISTRY_FAIL_GRANT_DEPENDENCIES,
): Promise<CommandResult | null> {
  if (
    (args[0] !== 'work-item' && args[0] !== 'now') ||
    !(error instanceof WorkflowError) ||
    error.code !== 'WORK_REGISTRY_GRANT_REQUIRED'
  ) {
    return null;
  }
  const details = workRegistryGrantRequiredDetails(error.details);
  if (details === null || !workRegistryArgsMatch(args, details)) return null;
  const proposedReason =
    details.operation === 'review'
      ? `Authorize only this exact ${details.review.action} Work Registry transition for ${details.workItemId}; the Human Gate decision applies the digest-bound mutation and any state change requires a fresh Grant.`
      : `Authorize only this exact Work Registry promotion of ${details.workItemId} to ${details.changeId}; the Human Gate decision applies the digest-bound mutation and any state change requires a fresh Grant.`;
  const grant =
    details.operation === 'review'
      ? await dependencies.requestReview(
          cwd,
          details.workItemId,
          details.review,
          proposedReason,
        )
      : await dependencies.requestPromotion(
          cwd,
          details.workItemId,
          details.changeId,
          details.expectedDigest,
          proposedReason,
        );
  return {
    command: args[0],
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      workItemId: details.workItemId,
      transition: details.transition,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        details,
      },
      grant,
      transitionAppliesOnDecision: true,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        recoveryCommand: `pnpm workflow grant human recover ${grant.challengeId} --json`,
        observeAfterDecision: `pnpm workflow work-item show ${details.workItemId} --json`,
      },
    },
  };
}

function workRegistryGrantRequiredDetails(
  value: unknown,
): WorkRegistryGrantRequiredDetailsV1 | null {
  if (
    !plainRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'work-registry-grant-required.v1' ||
    typeof value.workItemId !== 'string' ||
    !/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.workItemId)
  ) {
    return null;
  }
  if (
    value.operation === 'review' &&
    (value.transition === 'intake' || value.transition === 'prioritize') &&
    exactKeys(value, [
      'kind',
      'operation',
      'review',
      'schemaVersion',
      'transition',
      'workItemId',
    ])
  ) {
    const review = workItemReview(value.review);
    const transition =
      review?.action === 'prioritize' ? 'prioritize' : 'intake';
    if (review !== null && value.transition === transition) {
      return { ...value, review } as WorkRegistryGrantRequiredDetailsV1;
    }
  }
  if (
    value.operation === 'promote' &&
    value.transition === 'promote' &&
    exactKeys(value, [
      'changeId',
      'expectedDigest',
      'kind',
      'operation',
      'schemaVersion',
      'transition',
      'workItemId',
    ]) &&
    typeof value.changeId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.changeId) &&
    typeof value.expectedDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(value.expectedDigest)
  ) {
    return value as WorkRegistryGrantRequiredDetailsV1;
  }
  return null;
}

function workRegistryArgsMatch(
  args: readonly string[],
  details: WorkRegistryGrantRequiredDetailsV1,
): boolean {
  if (details.operation === 'review') {
    return (
      args.length === 5 &&
      args[1] === 'review' &&
      args[2] === details.workItemId &&
      args[3] === '--input'
    );
  }
  if (args[0] === 'now') {
    return (
      args.length === 2 &&
      args[1] === details.workItemId &&
      details.changeId ===
        `work-${details.workItemId.slice('WORK-'.length).toLowerCase()}`
    );
  }
  return (
    args.length === 7 &&
    args[1] === 'promote' &&
    args[2] === details.workItemId &&
    args[3] === '--change' &&
    args[4] === details.changeId &&
    args[5] === '--expected' &&
    args[6] === details.expectedDigest
  );
}

function workItemReview(value: unknown): WorkItemReviewV1 | null {
  if (
    !plainRecord(value) ||
    typeof value.expectedDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.expectedDigest)
  ) {
    return null;
  }
  if (
    value.action === 'accept' &&
    exactKeys(value, ['action', 'expectedDigest', 'summary']) &&
    typeof value.summary === 'string' &&
    value.summary.length > 0 &&
    Buffer.byteLength(value.summary, 'utf8') <= 2_000 &&
    !value.summary.includes('\0')
  ) {
    return value as WorkItemReviewV1;
  }
  if (
    value.action === 'prioritize' &&
    exactKeys(value, ['action', 'blockedBy', 'expectedDigest', 'lane']) &&
    ['now', 'next', 'later', 'icebox'].includes(String(value.lane)) &&
    Array.isArray(value.blockedBy) &&
    value.blockedBy.every(
      (entry) =>
        typeof entry === 'string' &&
        /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/u.test(entry),
    ) &&
    new Set(value.blockedBy).size === value.blockedBy.length
  ) {
    return value as WorkItemReviewV1;
  }
  if (
    value.action === 'decline' &&
    exactKeys(value, ['action', 'expectedDigest', 'outcome']) &&
    ['declined', 'duplicate', 'obsolete'].includes(String(value.outcome))
  ) {
    return value as WorkItemReviewV1;
  }
  return null;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index])
  );
}

/** Test-only seam proving the hidden command selects the async worker. */
export function createAsyncCliDispatcherForTesting(
  providerWorker: typeof runProviderWorkerAsync,
  roleAssignmentGrantRequest: typeof requestChangeRoleAssignmentGrant = requestChangeRoleAssignmentGrant,
): (args: string[], cwd: string) => Promise<CommandResult> {
  return (args, cwd) =>
    dispatchAsync(args, cwd, providerWorker, roleAssignmentGrantRequest);
}

async function dispatchArchivePullRequest(
  args: string[],
  cwd: string,
  dependencies: ArchivePullRequestCliDependencies = ARCHIVE_PULL_REQUEST_CLI_DEPENDENCIES,
): Promise<CommandResult> {
  const [, action, ...rest] = args;
  if (action === 'doctor') {
    if (rest.length !== 2 || rest[0] !== '--base') {
      throw archivePullRequestUsage();
    }
    return {
      command: 'archive-pr',
      action,
      ok: true,
      result: dependencies.discover(cwd, rest[1]!),
    };
  }
  if (action === 'status') {
    if (rest.length !== 1) throw archivePullRequestUsage();
    return {
      command: 'archive-pr',
      action,
      ok: true,
      result: dependencies.inspect(cwd, rest[0]!),
    };
  }
  if (action === 'dry-run') {
    const parsed = parseArchivePullRequestCliOptions(
      'archive-pr dry-run',
      rest,
      {
        requireConfig: false,
        requireGrant: false,
      },
    );
    const local = dependencies.prepare(cwd, parsed.changeId, {
      ...(parsed.workspaceParent === undefined
        ? {}
        : { workspaceParent: parsed.workspaceParent }),
    });
    return {
      command: 'archive-pr',
      action,
      ok: true,
      result: {
        schemaVersion: 1,
        kind: 'archive-pr-dry-run.v1',
        remoteState: 'not-observed',
        operationalGate: 'pending',
        local,
      },
    };
  }
  if (action !== 'prepare' && action !== 'open') {
    throw archivePullRequestUsage();
  }
  const parsed = parseArchivePullRequestCliOptions(
    `archive-pr ${action}`,
    rest,
    {
      requireConfig: true,
      requireGrant: action === 'open',
    },
  );
  const configValue = readArchivePullRequestJson(
    cwd,
    parsed.configPath!,
    'ARCHIVE_PR_GITHUB_CONFIG_INVALID',
  );
  let adapter: GitHubArchiveAdapterModuleV1;
  try {
    adapter = await dependencies.loadAdapter();
  } catch {
    throw workflowError(
      'ARCHIVE_PR_GITHUB_ADAPTER_UNAVAILABLE',
      'Remote archive request preparation requires the optional @jigwright/github-adapter package.',
      ExitCode.unsafeEnvironment,
    );
  }
  let config: GitHubArchiveAdapterConfigV1;
  try {
    config = adapter.parseGitHubArchiveAdapterConfig(configValue);
  } catch {
    throw workflowError(
      'ARCHIVE_PR_GITHUB_CONFIG_INVALID',
      'Remote archive publication configuration is invalid or contains forbidden credential material.',
      ExitCode.guard,
    );
  }
  const publicationTarget = dependencies.resolvePublicationTarget(cwd, config);
  const local = dependencies.prepare(cwd, parsed.changeId, {
    ...(parsed.workspaceParent === undefined
      ? {}
      : { workspaceParent: parsed.workspaceParent }),
  });
  if (action === 'prepare') {
    const grant = await dependencies.requestGrant(
      cwd,
      local.preparation.preparationIdentity,
      config,
      'Authorize only this exact immutable archive preparation for create-only branch publication and one idempotent pull-request opening; preserve adapter, configuration, ruleset, credential, stale-state, and collision checks.',
    );
    return {
      command: 'archive-pr',
      action,
      ok: true,
      result: {
        schemaVersion: 1,
        kind: 'workflow-fail-grant-required.v1',
        changeId: parsed.changeId,
        preparationIdentity: local.preparation.preparationIdentity,
        state: 'human-action-required',
        nextAction: 'human-action',
        failure: {
          code: 'ARCHIVE_PR_PUBLICATION_GRANT_REQUIRED',
          message:
            'The exact locally assured archive publication requires Human Gate authorization.',
        },
        grant,
        local,
        externalPublicationPending: true,
        inputSchema: {
          schemaVersion: 1,
          kind: 'central-grant-resolution.v1',
          inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
          decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
          publishAfterDecision: archivePullRequestOpenCommand(
            parsed,
            grant.challengeId,
          ),
        },
      },
    };
  }
  const environment = dependencies.environment ?? process.env;
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const published = await dependencies.publish(cwd, local, config, {
    environment,
    ...(fetchImplementation === undefined
      ? {}
      : { fetch: fetchImplementation }),
    loadAdapter: async () => adapter,
    grantChallengeId: parsed.grantChallengeId!,
    publicationTarget,
    rulesetObserver: dependencies.createRulesetObserver({
      config,
      environment,
      ...(fetchImplementation === undefined
        ? {}
        : { fetch: fetchImplementation }),
    }),
    branchPublisher: dependencies.createBranchPublisher(),
  });
  return {
    command: 'archive-pr',
    action,
    ok: true,
    result: published,
  };
}

type ArchivePullRequestCliDependencies = Readonly<{
  discover: typeof discoverArchivePullRequestCandidates;
  inspect: typeof inspectArchivePublicationPreparation;
  prepare: typeof preparePostMergeArchivePullRequest;
  requestGrant: typeof requestArchivePullRequestPublicationGrant;
  publish: typeof publishPostMergeArchivePullRequest;
  loadAdapter(): Promise<GitHubArchiveAdapterModuleV1>;
  createRulesetObserver(
    input: Readonly<{
      config: GitHubArchiveAdapterConfigV1;
      environment: NodeJS.ProcessEnv;
      fetch?: typeof globalThis.fetch;
    }>,
  ): GitHubArchiveRulesetObserverPortV1;
  createBranchPublisher(): ExactArchiveBranchPublisherPortV1;
  resolvePublicationTarget(
    cwd: string,
    configValue: unknown,
  ): ReturnType<typeof resolveArchivePullRequestPublicationTarget>;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}>;

const ARCHIVE_PULL_REQUEST_CLI_DEPENDENCIES: ArchivePullRequestCliDependencies =
  Object.freeze({
    discover: discoverArchivePullRequestCandidates,
    inspect: inspectArchivePublicationPreparation,
    prepare: preparePostMergeArchivePullRequest,
    requestGrant: requestArchivePullRequestPublicationGrant,
    publish: publishPostMergeArchivePullRequest,
    async loadAdapter() {
      return (await import('@jigwright/github-adapter')) as GitHubArchiveAdapterModuleV1;
    },
    createRulesetObserver: createGitHubApiArchiveRulesetObserver,
    createBranchPublisher: createGitExactArchiveBranchPublisher,
    resolvePublicationTarget: resolveArchivePullRequestPublicationTarget,
  });

export function createArchivePullRequestCliDispatcherForTesting(
  dependencies: ArchivePullRequestCliDependencies,
): (args: string[], cwd: string) => Promise<CommandResult> {
  return (args, cwd) => dispatchArchivePullRequest(args, cwd, dependencies);
}

function archivePullRequestOpenCommand(
  parsed: Readonly<{
    changeId: string;
    configPath?: string;
    workspaceParent?: string;
  }>,
  challengeId: string,
): string {
  const values = [
    'pnpm workflow archive-pr open',
    shellCommandArgument(parsed.changeId),
    '--config',
    shellCommandArgument(parsed.configPath!),
    '--grant',
    shellCommandArgument(challengeId),
    ...(parsed.workspaceParent === undefined
      ? []
      : ['--workspace-parent', shellCommandArgument(parsed.workspaceParent)]),
    '--json',
  ];
  return values.join(' ');
}

function shellCommandArgument(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

function parseArchivePullRequestCliOptions(
  command: string,
  args: string[],
  requirements: Readonly<{
    requireConfig: boolean;
    requireGrant: boolean;
  }>,
): Readonly<{
  changeId: string;
  configPath?: string;
  grantChallengeId?: string;
  workspaceParent?: string;
}> {
  const changeId = args[0];
  if (!changeId || args.length < 1 || args.length % 2 === 0) {
    throw archivePullRequestUsage(command);
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !['--config', '--grant', '--workspace-parent'].includes(option) ||
      values.has(option)
    ) {
      throw archivePullRequestUsage(command);
    }
    values.set(option, value);
  }
  const configPath = values.get('--config');
  const grantChallengeId = values.get('--grant');
  if (
    (requirements.requireConfig
      ? configPath === undefined
      : configPath !== undefined) ||
    (requirements.requireGrant
      ? grantChallengeId === undefined
      : grantChallengeId !== undefined)
  ) {
    throw archivePullRequestUsage(command);
  }
  return {
    changeId,
    ...(configPath === undefined ? {} : { configPath }),
    ...(grantChallengeId === undefined ? {} : { grantChallengeId }),
    ...(values.get('--workspace-parent') === undefined
      ? {}
      : { workspaceParent: values.get('--workspace-parent') }),
  };
}

function readArchivePullRequestJson(
  cwd: string,
  filePath: string,
  code: string,
): unknown {
  try {
    const absolute = path.resolve(cwd, filePath);
    const stats = fs.lstatSync(absolute);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size < 2 ||
      stats.size > 64 * 1024
    ) {
      throw new Error('invalid archive PR input file');
    }
    return JSON.parse(fs.readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    throw workflowError(
      code,
      'Archive pull request input must be one bounded readable JSON file.',
      ExitCode.guard,
    );
  }
}

function archivePullRequestUsage(command = 'archive-pr'): WorkflowError {
  return usage(
    command === 'after-merge'
      ? 'Usage: pnpm workflow after-merge <change-id> [--workspace-parent <absolute-path>] [--json]'
      : 'Usage: pnpm workflow archive-pr doctor --base <origin/protected-branch> [--json]\n       pnpm workflow archive-pr dry-run <change-id> [--workspace-parent <absolute-path>] [--json]\n       pnpm workflow archive-pr status <sha256:preparation-identity> [--json]\n       pnpm workflow archive-pr prepare <change-id> --config <github-adapter.json> [--workspace-parent <absolute-path>] [--json]\n       pnpm workflow archive-pr open <change-id> --config <github-adapter.json> --grant <challenge-id> [--workspace-parent <absolute-path>] [--json]',
  );
}

function hasTerminalJsonOutputFlag(argv: string[]): boolean {
  if (argv.at(-1) !== '--json') return false;
  const previousArgument = argv.at(-2);
  if (
    previousArgument === undefined ||
    !previousArgument.startsWith('--') ||
    STANDALONE_COMMAND_FLAGS.has(previousArgument)
  ) {
    return true;
  }
  const valueOption = argv.at(-3);
  if (previousArgument === '--json') {
    return (
      valueOption !== undefined &&
      OPTION_SHAPED_TEXT_VALUE_OPTIONS.has(valueOption)
    );
  }
  return !OPTION_SHAPED_TEXT_VALUE_OPTIONS.has(previousArgument);
}

function dispatch(args: string[], cwd: string): CommandResult {
  const [command, ...rest] = args;

  switch (command) {
    case 'boundary': {
      const [subcommand, ...options] = rest;
      if (subcommand === 'remap') {
        if (
          options.length !== 2 ||
          options[0] !== '--input' ||
          options[1] === undefined
        ) {
          throw usage(
            'Usage: pnpm workflow boundary remap --input <request.json> [--json]',
          );
        }
        const repositoryRoot = discoverRepository(cwd).repositoryRoot;
        const input = readAuthorityRemapInput(cwd, options[1]);
        return {
          command,
          ok: true,
          result: projectAuthorityRemap({
            repositoryRoot,
            baseCommit: input.baseCommit,
            moveCommit: input.moveCommit,
            ...(input.materializationCommit === null
              ? {}
              : { materializationCommit: input.materializationCommit }),
            renamePairs: input.renamePairs,
            authorityPlan: input.authorityPlan,
          }),
        };
      }
      if (
        (subcommand !== 'inventory' && subcommand !== 'vectors') ||
        (options.length !== 0 &&
          !(options.length === 1 && options[0] === '--check'))
      ) {
        throw usage(
          'Usage: pnpm workflow boundary <inventory|vectors> [--check] [--json]\n       pnpm workflow boundary remap --input <request.json> [--json]',
        );
      }
      if (subcommand === 'vectors') {
        const vectors = loadWorkflowConformanceVectorsV2();
        return {
          command,
          ok: true,
          result: {
            kind: 'jigwright.conformance-vectors-check.v1',
            status: 'current',
            domainCount: Object.keys(vectors.domains).length,
            vectorSetDigest: vectors.vectorSetDigest,
          },
        };
      }
      return {
        command,
        ok: true,
        result: inspectT3BoundaryInventory({
          repositoryRoot: discoverRepository(cwd).repositoryRoot,
          check: options[0] === '--check',
          typescript: loadT3BoundaryTypeScript(),
        }),
      };
    }
    case 'guide':
      requireArgumentCount(command, rest, 0, 0);
      return {
        command,
        ok: true,
        guide: WORKFLOW_GUIDANCE_CATALOG,
      };
    case 'doctor':
      requireArgumentCount(command, rest, 0, 0);
      return doctor(cwd);
    case 'guidance':
      return {
        command,
        ok: true,
        result: dispatchAgentGuidanceCommand(
          rest,
          runGit(cwd, ['rev-parse', '--show-toplevel'], true).trim() || cwd,
        ),
      };
    case 'validate-change': {
      requireArgumentCount(command, rest, 1, 1);
      const contract = loadStableValidatedChangeContract(
        discoverRepository(cwd),
        rest[0],
      ).contract;
      return {
        command,
        ok: true,
        changeId: contract.changeId,
        tasks: contract.tasks,
        artifactDigests: contract.artifactDigests,
        artifactModes: contract.artifactModes,
        schemaName: contract.schemaName,
        openspec: contract.openspec,
        diagnostics: contract.diagnostics,
        contractDigest: contract.contractDigest,
      };
    }
    case 'plan-commit':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: commitPlanningTransition(cwd, rest[0]),
      };
    case 'route':
      return {
        command,
        ok: true,
        result: dispatchChangeRoutingCommand(
          rest,
          discoverRepository(cwd).repositoryRoot,
        ),
      };
    case 'task-preflight': {
      const changeId = rest[0];
      const taskId = optionValue(rest.slice(1), '--task');
      const expected = taskId ? [changeId, '--task', taskId] : [changeId];
      if (
        !changeId ||
        rest.length !== expected.length ||
        JSON.stringify(rest) !== JSON.stringify(expected)
      ) {
        throw usage(
          'Usage: pnpm workflow task-preflight <change-id> [--task <task-id>] [--json]',
        );
      }
      const resolvedTaskId = resolveOpenTaskId(cwd, changeId, taskId);
      return {
        command,
        ok: true,
        result: preflightTaskSession(cwd, changeId, resolvedTaskId),
      };
    }
    case 'open-task': {
      const changeId = rest[0];
      const taskId = optionValue(rest.slice(1), '--task');
      const mandateTaskId = optionValue(rest.slice(1), '--mandate');
      const expected = taskId
        ? mandateTaskId
          ? [changeId, '--task', taskId, '--mandate', mandateTaskId]
          : [changeId, '--task', taskId]
        : mandateTaskId
          ? [changeId, '--mandate', mandateTaskId]
          : [changeId];
      if (
        !changeId ||
        rest.length !== expected.length ||
        JSON.stringify(rest) !== JSON.stringify(expected)
      ) {
        throw usage(
          'Usage: pnpm workflow open-task <change-id> [--task <task-id>] [--mandate <mandate-task-id>] [--json]',
        );
      }
      const resolvedTaskId = resolveOpenTaskId(cwd, changeId, taskId);
      try {
        const result = openTask(cwd, changeId, resolvedTaskId, mandateTaskId);
        return {
          command,
          ok: true,
          result,
          intakeCounts: currentGovernanceIntakeCounts(cwd),
        };
      } catch (error) {
        throw contextualizeOpenTaskError(cwd, changeId, resolvedTaskId, error);
      }
    }
    case 'update-base': {
      const changeId = rest[0];
      const ontoRef = optionValue(rest.slice(1), '--onto');
      const expected = [changeId, '--onto', ontoRef];
      if (
        !changeId ||
        !ontoRef ||
        rest.length !== expected.length ||
        JSON.stringify(rest) !== JSON.stringify(expected)
      ) {
        throw usage(
          'Usage: pnpm workflow update-base <change-id> --onto <ref> [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: updateTaskSessionBase(cwd, changeId, ontoRef),
      };
    }
    case 'amend-plan': {
      // Both arguments are mandatory: an amendment that has not said why it
      // was needed, or whether the work already done still stands, has not
      // answered the questions the transition exists to ask.
      requireArgumentCount(command, rest, 6, 6);
      if (
        rest[0] !== '--change' ||
        rest[2] !== '--reason' ||
        rest[4] !== '--execution-impact'
      ) {
        throw usage(
          'workflow amend-plan --change <change-id> --reason <code> --execution-impact <none|required>',
        );
      }
      return {
        command,
        ok: true,
        result: commitPlanAmendment(cwd, rest[1]!, {
          reason: rest[3]!,
          executionImpact: rest[5] as 'none' | 'required',
        }),
      };
    }
    case 'propose': {
      const providerDispatcher =
        process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH === '1'
          ? undefined
          : dispatchProviderWorker;
      const changeId = rest[0];
      if (changeId && rest[1] === '--resume') {
        const { values } = parseProposeOptions(rest.slice(2), [
          '--input',
          '--grant',
          '--role-context-grant',
        ]);
        const input = values.get('--input');
        if (!input) {
          throw proposeUsage();
        }
        const grantId = values.get('--grant');
        const roleContextSharingGrantId = values.get('--role-context-grant');
        if (grantId !== undefined && roleContextSharingGrantId !== undefined) {
          throw proposeUsage();
        }
        const collaborationGrant =
          grantId === undefined
            ? undefined
            : currentCollaborationGrantSelection(cwd, grantId);
        return {
          command,
          ok: true,
          result: resumeProposeFromFile(cwd, changeId, input, {
            ...(providerDispatcher ? { providerDispatcher } : {}),
            roleTopologyResolution: productionRoleTopologyResolutionPort,
            ...(roleContextSharingGrantId === undefined
              ? {}
              : {
                  roleContextSharingGrant:
                    currentRoleContextSharingGrantSelection(
                      cwd,
                      roleContextSharingGrantId,
                    ),
                }),
            ...(collaborationGrant === undefined
              ? {}
              : {
                  collaborationGrant,
                }),
            collaborationGrantValidation: {
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
              consumedPlanReviewReplay: productionConsumedPlanReviewReplayPort,
              ...(collaborationGrant === undefined
                ? {}
                : { verifier: collaborationGrant.verifier }),
            },
          }),
        };
      }
      if (changeId) {
        const { values } = parseProposeOptions(
          rest.slice(1),
          ['--intent', '--actor', '--grant', '--mandate'],
          [],
        );
        const intent = values.get('--intent');
        const mandateTaskId = values.get('--mandate');
        if (!intent) {
          throw proposeUsage();
        }
        return {
          command,
          ok: true,
          result: startProposeFromFile(cwd, changeId, intent, {
            ...(values.get('--actor') === undefined
              ? {}
              : { explicitActor: values.get('--actor') }),
            environment: process.env,
            ...(mandateTaskId === undefined
              ? {}
              : { taskMandateId: mandateTaskId }),
            ...(providerDispatcher ? { providerDispatcher } : {}),
            roleTopologyResolution: productionRoleTopologyResolutionPort,
            ...(values.get('--grant') === undefined
              ? {}
              : {
                  collaborationGrant: currentCollaborationGrantSelection(
                    cwd,
                    values.get('--grant')!,
                  ),
                }),
          }),
        };
      }
      throw proposeUsage();
    }
    case 'archive':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: commitArchiveTransition(cwd, rest[0]),
      };
    case 'archive-candidates': {
      if (rest.length !== 2 || rest[0] !== '--base') {
        throw usage(
          'Usage: pnpm workflow archive-candidates --base <origin/protected-branch> [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: discoverArchivePullRequestCandidates(cwd, rest[1]!),
      };
    }
    case 'after-merge': {
      const parsed = parseArchivePullRequestCliOptions(command, rest, {
        requireConfig: false,
        requireGrant: false,
      });
      return {
        command,
        ok: true,
        result: preparePostMergeArchivePullRequest(cwd, parsed.changeId, {
          ...(parsed.workspaceParent === undefined
            ? {}
            : { workspaceParent: parsed.workspaceParent }),
        }),
      };
    }
    case 'openspec-assets': {
      const repositoryRoot = discoverRepository(cwd).repositoryRoot;
      if (rest.length === 1 && rest[0] === 'generate') {
        return {
          command,
          ok: true,
          result: generateOpenSpecPlanningAssets(repositoryRoot),
        };
      }
      if (rest.length === 1 && rest[0] === 'check') {
        return {
          command,
          ok: true,
          result: checkOpenSpecPlanningAssets(repositoryRoot),
        };
      }
      if (
        rest.length === 3 &&
        rest[0] === 'install-prompts' &&
        rest[1] === '--codex-home'
      ) {
        return {
          command,
          ok: true,
          result: installOpenSpecPlanningPrompts(repositoryRoot, rest[2]!),
        };
      }
      throw usage(
        'Usage: pnpm workflow openspec-assets <generate|check|install-prompts --codex-home <path>> [--json]',
      );
    }
    case 'grant': {
      if (rest[0] === 'approve' && (rest.length === 2 || rest.length === 4)) {
        if (rest.length === 4 && rest[2] !== '--uses') {
          throw executionGrantUsage();
        }
        const requestedUses =
          rest.length === 4 ? Number.parseInt(rest[3]!, 10) : undefined;
        if (
          requestedUses !== undefined &&
          (!Number.isSafeInteger(requestedUses) || requestedUses < 1)
        ) {
          throw executionGrantUsage();
        }
        const requestPath = path.resolve(cwd, rest[1]!);
        const request = parseExecutionBudgetGrantRequest(
          fs.readFileSync(requestPath, 'utf8'),
        );
        const issued = issueExecutionBudgetGrant(cwd, request, {
          ...(requestedUses === undefined ? {} : { maxUses: requestedUses }),
        });
        return {
          command,
          action: 'approve',
          ok: true,
          grantId: issued.grantId,
          jobId: issued.envelope.payload.jobId,
          epoch: issued.envelope.payload.epoch,
          maxUses: issued.envelope.payload.maxUses,
          recordPath: issued.recordPath,
        };
      }
      if (rest[0] === 'inspect' && rest.length === 2) {
        return {
          command,
          action: 'inspect',
          ok: true,
          result: inspectIssuedExecutionBudgetGrant(cwd, rest[1]!),
        };
      }
      if (rest[0] === 'revoke' && rest.length === 4 && rest[2] === '--reason') {
        const grantId = rest[1]!;
        const reason = rest[3]!;
        const family = resolveStoredGrantFamily(cwd, grantId);
        const result =
          family === 'execution-budget'
            ? revokeIssuedExecutionBudgetGrant(cwd, grantId, { reason })
            : family === 'apply'
              ? revokeMaintainerGrantV2(cwd, { grantId, reason })
              : revokeExternalEffectGrant(cwd, grantId, { reason });
        return {
          command,
          action: 'revoke',
          family,
          ok: true,
          result,
        };
      }
      throw executionGrantUsage();
    }
    case 'external-effect': {
      if (
        rest[0] === 'issue' &&
        (rest.length === 17 || rest.length === 19) &&
        rest[1] === '--grant' &&
        rest[3] === '--task' &&
        rest[5] === '--kind' &&
        rest[7] === '--target-file' &&
        rest[9] === '--artifact-digest' &&
        rest[11] === '--prestate-digest' &&
        rest[13] === '--rollback-plan-file' &&
        rest[15] === '--idempotency-key' &&
        (rest.length === 17 || rest[17] === '--ttl-seconds')
      ) {
        const ttlToken = rest.length === 19 ? rest[18]! : undefined;
        if (ttlToken !== undefined && !/^[1-9][0-9]*$/.test(ttlToken)) {
          throw externalEffectUsage();
        }
        const ttlSeconds =
          ttlToken === undefined ? undefined : Number(ttlToken);
        if (
          ttlSeconds !== undefined &&
          (!Number.isSafeInteger(ttlSeconds) ||
            ttlSeconds < 1 ||
            ttlSeconds > EXTERNAL_EFFECT_MAX_TTL_SECONDS)
        ) {
          throw externalEffectUsage();
        }
        const mandateBinding = inspectActiveTaskMandateBinding(cwd, rest[4]!);
        const target = readExternalEffectJson<ExternalEffectTarget>(
          rest[8]!,
          cwd,
        );
        const rollbackPlan =
          rest[14] === 'none'
            ? null
            : readExternalEffectJson<ExternalEffectRollbackPlan>(
                rest[14]!,
                cwd,
              );
        const request: ExternalEffectGrantRequest = {
          mandateBinding,
          effectKind: rest[6]! as ExternalEffectKind,
          target,
          artifactDigest: rest[10]! as `sha256:${string}`,
          prestateDigest: rest[12]! as `sha256:${string}`,
          rollbackPlan,
          ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
          idempotencyKey: rest[16]!,
        };
        const issued = issueExternalEffectGrant(cwd, request, {
          grantId: rest[2]!,
        });
        return {
          command,
          action: 'issue',
          ok: true,
          grantId: issued.grantId,
          grantDigest: issued.grantDigest,
          taskId: issued.envelope.payload.taskId,
          effectKind: issued.envelope.payload.effectKind,
          expiresAt: issued.envelope.payload.expiresAt,
          recordPath: issued.recordPath,
        };
      }
      if (rest[0] === 'inspect' && rest.length === 2) {
        return {
          command,
          action: 'inspect',
          ok: true,
          result: inspectExternalEffectGrant(cwd, rest[1]!),
        };
      }
      if (rest[0] === 'revoke' && rest.length === 4 && rest[2] === '--reason') {
        return {
          command,
          action: 'revoke',
          ok: true,
          result: revokeExternalEffectGrant(cwd, rest[1]!, {
            reason: rest[3]!,
          }),
        };
      }
      if (
        rest[0] === 'reconcile' &&
        rest.length === 4 &&
        rest[2] === '--evidence-file'
      ) {
        return {
          command,
          action: 'reconcile',
          ok: true,
          result: reconcileExternalEffectGrant(
            cwd,
            rest[1]!,
            readExternalEffectJson<ExternalEffectReconciliationRequest>(
              rest[3]!,
              cwd,
            ),
            {},
          ),
        };
      }
      throw externalEffectUsage();
    }
    case 'publish': {
      if (rest[0] !== 'execute' || rest.length !== 3 || rest[1] !== '--grant') {
        throw publishUsage();
      }
      return {
        command,
        action: 'execute',
        ok: true,
        result: executePublishGrant(cwd, rest[2]!, {}),
      };
    }
    case 'job': {
      if (rest[0] === 'list' && rest.length === 1) {
        return {
          command,
          action: 'list',
          ok: true,
          jobs: listExecutionJobs(cwd),
        };
      }
      if (rest[0] === 'status' && rest.length === 2) {
        return {
          command,
          action: 'status',
          ok: true,
          result: inspectExecutionJob(cwd, rest[1]!),
        };
      }
      if (
        rest[0] === 'prune' &&
        rest.length === 3 &&
        rest[1] === '--limit' &&
        /^[1-9][0-9]*$/.test(rest[2]!)
      ) {
        return {
          command,
          action: 'prune',
          ok: true,
          result: pruneProviderRuntime(cwd, {
            limit: Number.parseInt(rest[2]!, 10),
          }),
        };
      }
      if (
        rest[0] === 'retry-pump' &&
        rest.length === 3 &&
        rest[1] === '--limit' &&
        /^[1-9][0-9]*$/.test(rest[2]!)
      ) {
        return {
          command,
          action: 'retry-pump',
          ok: true,
          result: pumpProviderRetrySchedules(cwd, {
            limit: Number.parseInt(rest[2]!, 10),
            dispatcher:
              process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH === '1'
                ? undefined
                : dispatchProviderWorker,
          }),
        };
      }
      if (rest[0] === 'retry-schedules' && rest.length === 1) {
        return {
          command,
          action: 'retry-schedules',
          ok: true,
          result: listProviderAutomaticRetrySchedules(cwd),
        };
      }
      if (
        rest[0] === 'retry-receipts' &&
        (rest.length === 1 || rest.length === 2)
      ) {
        return {
          command,
          action: 'retry-receipts',
          ok: true,
          result: listProviderRetryScheduleReceipts(cwd, rest[1]),
        };
      }
      if (
        rest[0] === 'retry-request' &&
        rest.length === 4 &&
        rest[2] === '--timeout'
      ) {
        const timeoutMs = Number.parseInt(rest[3]!, 10);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
          throw executionJobUsage();
        }
        return {
          command,
          action: 'retry-request',
          ok: true,
          result: requestExecutionReplacement(cwd, rest[1]!, { timeoutMs }),
        };
      }
      if (rest[0] === 'retry' && rest.length === 4 && rest[2] === '--grant') {
        return {
          command,
          action: 'retry',
          ok: true,
          result: executeGrantedReplacement(cwd, rest[1]!, rest[3]!, {
            providerDispatcher:
              process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH === '1'
                ? undefined
                : dispatchProviderWorker,
            consumedRoleResultReplay: productionConsumedPlanReviewReplayPort,
          }),
        };
      }
      if (
        rest[0] === 'retry-preview' &&
        rest.length === 4 &&
        rest[2] === '--timeout'
      ) {
        const timeoutMs = Number.parseInt(rest[3]!, 10);
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
          throw executionJobUsage();
        }
        return {
          command,
          action: 'retry-preview',
          ok: true,
          result: prepareProviderReplacement(cwd, rest[1]!, { timeoutMs }),
        };
      }
      throw executionJobUsage();
    }
    case 'metrics':
      if (rest.length !== 1 || rest[0] !== 'show') {
        throw usage('Usage: pnpm workflow metrics show [--json]');
      }
      return {
        command,
        action: 'show',
        ok: true,
        result: collectEngineMetrics(cwd),
      };
    case 'assurance': {
      if (rest.length === 2 && rest[0] === 'inspect') {
        return {
          command,
          action: 'inspect',
          ok: true,
          result: inspectChangeAssurance(cwd, rest[1]),
        };
      }
      throw usage('workflow assurance inspect <change-id>');
    }
    case 'semantic-ledger': {
      if (
        rest[0] === 'reconcile' &&
        rest[1] === '--change' &&
        rest.length === 3
      ) {
        return {
          command,
          action: 'reconcile-inspect',
          ok: true,
          result: inspectImplementationReconciliation(cwd, rest[2]!),
        };
      }
      if (
        rest[0] === 'reconcile' &&
        rest[1] === '--change' &&
        rest[3] === '--input' &&
        rest.length === 5
      ) {
        let input: unknown;
        try {
          input = JSON.parse(
            fs.readFileSync(path.resolve(cwd, rest[4]!), 'utf8'),
          );
        } catch {
          throw usage(
            'workflow semantic-ledger reconcile --change <change-id> --input <json>',
          );
        }
        return {
          command,
          action: 'reconcile',
          ok: true,
          result: recordImplementationReconciliation(cwd, rest[2]!, input),
        };
      }
      throw usage(
        'workflow semantic-ledger reconcile --change <change-id> [--input <json>]',
      );
    }
    case 'retention': {
      if (rest.length === 1 && rest[0] === 'inspect') {
        return {
          command,
          action: 'inspect',
          ok: true,
          result: inspectEvidenceRetention(cwd),
        };
      }
      if (
        rest.length === 3 &&
        rest[0] === 'sweep' &&
        rest[1] === '--limit' &&
        /^[1-9][0-9]*$/.test(rest[2]!)
      ) {
        return {
          command,
          action: 'sweep',
          ok: true,
          result: runEvidenceRetentionMaintenance(cwd, {
            limit: Number.parseInt(rest[2]!, 10),
          }),
        };
      }
      if (rest.length === 5 && rest[0] === 'pin' && rest[3] === '--reason') {
        return {
          command,
          action: 'pin',
          ok: true,
          result: pinWorkflowEvidence(cwd, {
            workflowId: rest[1]!,
            evidenceId: rest[2]!,
            reason: rest[4]!,
          }),
        };
      }
      throw retentionUsage();
    }
    case 'intervention':
      return {
        command,
        ok: true,
        result: dispatchBootstrapInterventionCommand(
          rest,
          cwd,
          interventionControlDependencies(cwd),
        ),
      };
    case 'control-plane':
      if (
        [
          'produce',
          'approve-and-apply',
          'promote',
          'recover',
          'status',
        ].includes(rest[0] ?? '')
      ) {
        return {
          command,
          ok: true,
          result: dispatchProductionControlPlaneCommand(rest, cwd),
        };
      }
      return {
        command,
        ok: true,
        result: dispatchInterventionControlCommand(
          [command, ...rest],
          interventionControlDependencies(cwd),
        ),
      };
    case 'audit':
      return {
        command,
        ok: true,
        result: dispatchAuthorityAuditCommand(rest, cwd),
      };
    case 'change':
    case 'engine':
      if (
        (command === 'change' &&
          ['intervene', 'revoke-intervention'].includes(rest[0] ?? '')) ||
        (command === 'engine' &&
          ['adopt', 'build-artifact'].includes(rest[0] ?? ''))
      ) {
        return {
          command,
          ok: true,
          result: dispatchBootstrapInterventionCommand(
            [command, ...rest],
            cwd,
            createHarnessBootstrapDependencies(cwd),
          ),
        };
      }
      return {
        command,
        ok: true,
        result: dispatchInterventionControlCommand(
          [command, ...rest],
          interventionControlDependencies(cwd),
        ),
      };
    case 'task': {
      if (
        rest[0] === 'authorize' &&
        rest.length === 4 &&
        rest[2] === '--audit-root'
      ) {
        const request = readTaskMandateRequest(rest[1]!, cwd);
        const mandate = authorizeTaskMandate(cwd, request, {
          externalAuditRoot: rest[3]!,
        });
        return {
          command,
          action: 'authorize',
          ok: true,
          mandateId: mandate.mandateId,
          taskId: mandate.envelope.payload.taskId,
          intent: mandate.envelope.payload.intent,
          inactivityDays: mandate.envelope.payload.validUntil.inactivityDays,
          authoritativeEffects: mandate.envelope.payload.authoritativeEffects,
          controlPlaneMutation: mandate.envelope.payload.controlPlaneMutation,
          recordPath: mandate.recordPath,
          audit: mandate.audit,
        };
      }
      if (rest[0] === 'status' && rest.length === 2) {
        return {
          command,
          action: 'status',
          ok: true,
          result: inspectTaskMandate(cwd, rest[1]!),
        };
      }
      if (rest[0] === 'revoke' && rest.length === 4 && rest[2] === '--reason') {
        return {
          command,
          action: 'revoke',
          ok: true,
          result: revokeTaskMandate(cwd, rest[1]!, {
            reason: rest[3]!,
          }),
        };
      }
      throw taskMandateUsage();
    }
    case 'revise-task': {
      const sessionId = rest[0];
      const reason = optionValue(rest.slice(1), '--reason');
      if (
        !sessionId ||
        !reason ||
        rest.length !== 3 ||
        rest[1] !== '--reason'
      ) {
        throw usage(
          'Usage: pnpm workflow revise-task <session-id> --reason <text> [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: reviseTask(cwd, sessionId, reason),
      };
    }
    case 'resume-task': {
      const sessionId = rest[0];
      const approvalId = optionValue(rest.slice(1), '--approval');
      if (
        !sessionId ||
        !(
          rest.length === 1 ||
          (rest.length === 3 && rest[1] === '--approval' && approvalId)
        )
      ) {
        throw usage(
          'Usage: pnpm workflow resume-task <session-id> [--approval <approval-id>] [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: resumeTask(cwd, sessionId, { approvalId }),
      };
    }
    case 'resume': {
      const sessionId = rest[0];
      const actor = optionValue(rest.slice(1), '--actor');
      const grantId = optionValue(rest.slice(1), '--grant');
      const inputPath = optionValue(rest.slice(1), '--input');
      const validArguments =
        rest.length === 1 ||
        (rest.length === 3 && rest[1] === '--actor' && actor !== undefined) ||
        (rest.length === 3 && rest[1] === '--grant' && grantId !== undefined) ||
        (rest.length === 3 &&
          rest[1] === '--input' &&
          inputPath !== undefined) ||
        (rest.length === 5 &&
          rest[1] === '--actor' &&
          actor !== undefined &&
          rest[3] === '--grant' &&
          grantId !== undefined);
      if (!sessionId || !validArguments) {
        throw usage(
          'Usage: pnpm workflow resume <session-id> [--actor <provider>] [--grant <grant-id>] [--input <typed-envelope.json>] [--json]',
        );
      }
      let redRevisionRequest;
      if (inputPath !== undefined) {
        try {
          redRevisionRequest = parseTaskStrategyRedRevisionRequest(
            JSON.parse(
              fs.readFileSync(path.resolve(cwd, inputPath), 'utf8'),
            ) as unknown,
          );
        } catch (error) {
          if (error instanceof WorkflowError) throw error;
          throw workflowError(
            'TASK_STRATEGY_RED_REVISION_REQUEST_INVALID',
            'Task strategy resume input must be a readable typed RED revision envelope.',
            ExitCode.usage,
          );
        }
      }
      const result = resumeTaskStrategy(cwd, sessionId, {
        ...(actor === undefined ? {} : { explicitActor: actor }),
        ...(grantId === undefined
          ? {}
          : {
              collaborationGrant: currentCollaborationGrantSelection(
                cwd,
                grantId,
              ),
            }),
        ...(redRevisionRequest === undefined ? {} : { redRevisionRequest }),
      });
      let providerDispatch = null;
      if (process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH !== '1') {
        providerDispatch = dispatchPreparedTaskStrategyProvider(cwd, result);
      }
      return {
        command,
        ok: true,
        result,
        ...(providerDispatch === null ? {} : { providerDispatch }),
      };
    }
    case 'status': {
      requireArgumentCount(command, rest, 0, 1);
      const intakeCounts = currentGovernanceIntakeCounts(cwd);
      if (rest[0]) {
        if (rest[0].startsWith('investigation-')) {
          return {
            command,
            ok: true,
            intakeCounts,
            result: getProposeStatus(cwd, rest[0], {
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
              consumedPlanReviewReplay: productionConsumedPlanReviewReplayPort,
            }),
          };
        }
        const openTaskStatus = findOpenTaskLifecycleStatus(cwd, rest[0]);
        if (openTaskStatus !== null) {
          if (
            openTaskStatus.state === 'opening' ||
            openTaskStatus.state === 'recovery-required'
          ) {
            return {
              command,
              ok: true,
              intakeCounts,
              openTask: openTaskStatus,
            };
          }
          const session = getSession(cwd, openTaskStatus.sessionId);
          const statusRoot = sessionStatusRepositoryRoot(cwd, session);
          const finalizeStatus = inspectFinalizeRecoveryStatus(
            statusRoot,
            session.sessionId,
            {
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
            },
          );
          return {
            command,
            ok: true,
            intakeCounts,
            openTask: openTaskStatus,
            session,
            ...(finalizeStatus ? { finalize: finalizeStatus } : {}),
            taskStrategy: inspectTaskStrategyLifecycle(
              statusRoot,
              session.sessionId,
            ),
            taskRevision: inspectTaskRevisionStatus(
              statusRoot,
              session.sessionId,
            ),
            taskCommits: findTaskCommits(
              statusRoot,
              session.changeId,
              session.taskId,
            ),
          };
        }
        const session = getSession(cwd, rest[0]);
        const statusRoot = sessionStatusRepositoryRoot(cwd, session);
        const finalizeStatus = inspectFinalizeRecoveryStatus(
          statusRoot,
          session.sessionId,
          {
            consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
          },
        );
        return {
          command,
          ok: true,
          intakeCounts,
          session,
          ...(finalizeStatus ? { finalize: finalizeStatus } : {}),
          taskStrategy: inspectTaskStrategyLifecycle(
            statusRoot,
            session.sessionId,
          ),
          taskRevision: inspectTaskRevisionStatus(
            statusRoot,
            session.sessionId,
          ),
          taskCommits: findTaskCommits(
            statusRoot,
            session.changeId,
            session.taskId,
          ),
        };
      }
      const sessions = listSessions(cwd);
      return {
        command,
        ok: true,
        intakeCounts,
        sessions,
        taskStrategies: sessions.map((session) => {
          const statusRoot = sessionStatusRepositoryRoot(cwd, session);
          return inspectTaskStrategyLifecycle(statusRoot, session.sessionId);
        }),
        taskRevisions: sessions.map((session) => {
          const statusRoot = sessionStatusRepositoryRoot(cwd, session);
          return inspectTaskRevisionStatus(statusRoot, session.sessionId);
        }),
        taskCommits: sessions.map((session) => ({
          changeId: session.changeId,
          taskId: session.taskId,
          commits: findTaskCommits(
            sessionStatusRepositoryRoot(cwd, session),
            session.changeId,
            session.taskId,
          ),
        })),
      };
    }
    case 'check':
      requireArgumentCount(command, rest, 1, 1);
      return { command, ok: true, result: checkSession(cwd, rest[0]) };
    case 'run-check':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: runRegisteredCheck(cwd, rest[0], process.env),
      };
    case 'ci': {
      const inputPath = optionValue(rest, '--input');
      const expected =
        inputPath === undefined
          ? ['--base', rest[1], '--head', rest[3]]
          : ['--base', rest[1], '--head', rest[3], '--input', inputPath];
      if (
        !rest[1] ||
        !rest[3] ||
        (rest.length !== 4 && rest.length !== 6) ||
        JSON.stringify(rest) !== JSON.stringify(expected)
      ) {
        throw usage(
          'Usage: pnpm workflow ci --base <commit> --head <commit> [--input <integration-review.json>] [--json]',
        );
      }
      const prepared = preparePullRequestPreMergeAssurance(
        cwd,
        rest[1],
        rest[3],
      );
      if (prepared.prepared === null && inputPath === undefined) {
        return { command, ok: true, result: prepared.verification };
      }
      const submission =
        inputPath === undefined ? null : readPreMergeSubmission(cwd, inputPath);
      return {
        command,
        ok: true,
        result: completePreparedPullRequestPreMergeAssurance(
          prepared,
          submission,
          cwd,
        ),
      };
    }
    case 'authority-plan': {
      if (
        rest.length === 3 &&
        rest[0] === 'prepare' &&
        rest[1] === '--intent'
      ) {
        return {
          command,
          action: 'prepare',
          ok: true,
          result: createAuthorityPlan(
            cwd,
            readAuthorityPlanIntent(cwd, rest[2]),
          ),
        };
      }
      if (rest.length === 2 && rest[0] === 'status') {
        return {
          command,
          action: 'status',
          ok: true,
          result: inspectAuthorityPlan(cwd, rest[1]),
        };
      }
      if (rest.length === 2 && rest[0] === 'resume') {
        return {
          command,
          action: 'resume',
          ok: true,
          result: resumeAuthorityPlan(cwd, rest[1]),
        };
      }
      if (rest.length === 2 && rest[0] === 'approve-and-apply') {
        assertControllingTerminal();
        return {
          command,
          action: 'approve-and-apply',
          ok: true,
          result: approveAndApplyAuthorityPlan(cwd, rest[1]),
        };
      }
      if (rest.length === 2 && rest[0] === 'attest') {
        assertControllingTerminal();
        return {
          command,
          action: 'attest',
          ok: true,
          result: attestAuthorityPlan(cwd, rest[1]),
        };
      }
      throw authorityPlanUsage();
    }
    case 'adapter':
      return {
        command,
        ok: true,
        result: dispatchAiAdapterCommand(
          rest,
          discoverRepository(cwd).repositoryRoot,
        ),
      };
    case 'source':
    case 'work-item':
    case 'later':
    case 'attach':
      return {
        command,
        ok: true,
        result: dispatchGovernanceIntakeCommand(
          command,
          rest,
          discoverRepository(cwd).repositoryRoot,
        ),
      };
    case 'finding':
    case 'now': {
      const providerDispatcher =
        process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH === '1'
          ? undefined
          : dispatchProviderWorker;
      return {
        command,
        ok: true,
        result: dispatchGovernanceIntakeCommand(
          command,
          rest,
          discoverRepository(cwd).repositoryRoot,
          {
            startImmediateChange(
              repositoryRoot,
              changeId,
              intent,
              immediateSource,
            ) {
              return startPropose(repositoryRoot, changeId, intent, {
                environment: process.env,
                ...(immediateSource ? { immediateSource } : {}),
                ...(providerDispatcher ? { providerDispatcher } : {}),
                roleTopologyResolution: productionRoleTopologyResolutionPort,
              });
            },
          },
        ),
      };
    }
    case 'maintainer': {
      if (rest[0] === 'review-diff-attest') {
        const sessionId = rest[1];
        const inputPath = rest[3];
        const grantId = rest[5];
        if (
          rest.length !== 6 ||
          !sessionId ||
          rest[2] !== '--input' ||
          !inputPath ||
          rest[4] !== '--grant' ||
          !grantId
        ) {
          throw maintainerTaskDiffReviewUsage();
        }
        const parsedInput = parseTaskDiffReviewCliInput(cwd, inputPath);
        if (parsedInput.route === 'provider-response') {
          throw maintainerTaskDiffReviewUsage();
        }
        const collaborationGrant = taskDiffCollaborationGrantSelection(
          cwd,
          grantId,
        );
        return {
          command,
          action: 'review-diff-attest',
          ok: true,
          result: resumeDirectHumanTaskDiffReview(
            cwd,
            sessionId,
            parsedInput.input,
            grantId,
            {
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
              ...('verifier' in collaborationGrant
                ? { verifier: collaborationGrant.verifier }
                : {}),
              consumedReplayVerifier: collaborationGrant.consumedReplayVerifier,
            },
          ),
        };
      }
      if (
        rest.length === 6 &&
        rest[0] === 'revision-approval' &&
        rest[2] === '--target' &&
        rest[4] === '--reason'
      ) {
        const binding = prepareTaskRevisionApprovalBinding(cwd, rest[1]!);
        const approval = issueTaskRevisionApproval(cwd, {
          binding,
          expectedTargetDigest: rest[3]!,
          rationale: rest[5]!,
        });
        return {
          command,
          action: 'revision-approval',
          ok: true,
          approvalId: approval.approvalId,
          recordPath: approval.recordPath,
          expiresAt: approval.envelope.payload.expiresAt,
          targetDigest: approval.envelope.payload.targetDigest,
          binding: approval.envelope.payload.binding,
        };
      }
      if (isCollaborationGrantCommand(rest)) {
        return {
          command,
          ...dispatchCollaborationGrantCommand(rest, cwd),
        };
      }
      if (rest[0] === 'role-context-sharing-grant') {
        return {
          command,
          ...dispatchRoleContextSharingGrantCommand(rest, cwd),
        };
      }
      if (rest[0] === 'grant' && rest[1] === 'preflight') {
        const request = parseMaintainerGrantV2PreflightArguments(rest);
        return {
          command,
          action: 'grant-preflight',
          ok: true,
          result: preflightMaintainerGrantV2(cwd, request),
        };
      }
      if (rest[0] === 'grant' && rest[1] === 'issue') {
        throw workflowError(
          'MAINTAINER_V2_MANUAL_ISSUE_DISABLED',
          'Apply Grant v2 is issued only inside the atomic approve-and-apply command.',
          ExitCode.guard,
        );
      }
      if (rest[0] === 'grant' && rest[1] === 'approve-and-apply') {
        const request = parseMaintainerApproveAndApplyArguments(rest, cwd);
        return {
          command,
          action: 'grant-approve-and-apply',
          ok: true,
          result: approveAndApplyMaintainerGrantV2(cwd, request),
        };
      }
      if (rest[0] === 'grant' && rest[1] === 'reissue-and-apply') {
        const request = parseMaintainerReissueAndApplyArguments(rest, cwd);
        return {
          command,
          action: 'grant-reissue-and-apply',
          ok: true,
          result: reissueAndApplyMaintainerGrantV2(cwd, request),
        };
      }
      if (rest[0] === 'resolution-inspect' && rest.length <= 2) {
        const publicationRecoveries =
          inspectHumanResolutionGrantPublicationRecoveries(cwd, rest[1]);
        let grants: ReturnType<typeof inspectHumanResolutionGrants>;
        try {
          grants = inspectHumanResolutionGrants(cwd, rest[1]);
        } catch (error) {
          if (
            publicationRecoveries.length === 0 ||
            !(error instanceof WorkflowError) ||
            error.code !== 'HUMAN_RESOLUTION_GRANT_NOT_FOUND'
          ) {
            throw error;
          }
          grants = [];
        }
        return {
          command,
          action: 'resolution-inspect',
          ok: true,
          grants,
          publicationRecoveries,
        };
      }
      if (rest[0] === 'resolution-publication-discard') {
        const request = parseHumanResolutionPublicationDiscardArguments(rest);
        assertInteractiveSignerContext({
          stdinIsTty: process.stdin.isTTY === true,
          stdoutIsTty: process.stdout.isTTY === true,
          stderrIsTty: process.stderr.isTTY === true,
        });
        return {
          command,
          action: 'resolution-publication-discard',
          ok: true,
          recovery: discardHumanResolutionGrantPublication(
            cwd,
            request.grantId,
            request.expectedPublicationStateDigest,
            request.reason,
          ),
        };
      }
      if (
        rest[0] === 'resolution-revoke' &&
        rest.length === 4 &&
        rest[2] === '--reason'
      ) {
        return {
          command,
          action: 'resolution-revoke',
          ok: true,
          grant: revokeHumanResolutionGrant(cwd, rest[1], {
            reason: rest[3],
          }),
        };
      }
      if (rest[0] === 'attest') {
        const request = parseMaintainerAttestArguments(rest);
        const attestation = issueAuthorityAttestation(cwd, request);
        return {
          command,
          action: 'attest',
          ok: true,
          grantId: attestation.grantId,
          tagRef: attestation.tagRef,
          originalCommit: attestation.envelope.payload.originalCommit,
          mainCommit: attestation.envelope.payload.mainCommit,
          grantBases: attestation.envelope.payload.grantBases,
          publishCommand: attestation.publishCommand,
        };
      }
      if (
        rest[0] === 'attestation-relay' &&
        rest.length === 3 &&
        rest[1] === '--original'
      ) {
        return {
          command,
          action: 'attestation-relay',
          ok: true,
          result: projectAuthorityAttestationRelay(cwd, rest[2]),
        };
      }
      if (rest[0] !== 'inspect') {
        throw maintainerUsage();
      }
      const git = discoverRepository(cwd);
      if (rest[0] === 'inspect' && rest.length <= 2) {
        return {
          command,
          action: 'inspect',
          ok: true,
          grants: inspectMaintainerGrants(git.gitCommonDirectory, rest[1]),
        };
      }
      throw maintainerUsage();
    }
    case 'human-resolution-state': {
      requireArgumentCount(command, rest, 1, 1);
      const context = loadInvestigationRuntimeContext(cwd);
      const policy = parseMaintainerPolicy(
        JSON.parse(
          runGit(context.git.repositoryRoot, [
            'show',
            `${context.git.head}:workflow/maintainer-policy.json`,
          ]),
        ),
      );
      return {
        command,
        ok: true,
        state: inspectInvestigationQuarantineState(
          context.runtime,
          rest[0],
          policy.repository.id,
        ),
      };
    }
    case 'documents':
      if (rest.length !== 1 || rest[0] !== 'validate') {
        throw usage('Usage: pnpm workflow documents validate [--json]');
      }
      return {
        command,
        ok: true,
        validated: validateManagedDocuments(
          discoverRepository(cwd).repositoryRoot,
        ),
      };
    case 'document-refresh':
      return {
        command,
        ok: true,
        result: dispatchDocumentRefreshCommand(rest, cwd),
      };
    case 'handoff': {
      const repositoryRoot = discoverRepository(cwd).repositoryRoot;
      if (rest.length !== 1 || rest[0] !== 'validate') {
        throw usage('Usage: pnpm workflow handoff validate [--json]');
      }
      validateHandoff(repositoryRoot);
      return {
        command,
        ok: true,
        action: 'validate',
        intakeCounts: currentGovernanceIntakeCounts(repositoryRoot),
      };
    }
    case 'hook': {
      const [hook, ...hookArgs] = rest;
      return {
        command,
        ok: true,
        result: runRepositoryHook(cwd, hook ?? '', hookArgs),
      };
    }
    case 'complete-task': {
      requireArgumentCount(command, rest, 1, 1);
      const result = completeTask(cwd, rest[0], process.env, {
        consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
      });
      return {
        command,
        ok: true,
        result,
        intakeCounts: currentGovernanceIntakeCounts(cwd),
      };
    }
    case 'finish':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: finishSession(cwd, rest[0], process.env, {
          consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
        }),
      };
    case 'finalize': {
      const sessionId = rest[0];
      const message = optionValue(rest.slice(1), '--message');
      const fullGate = rest.includes('--full-gate');
      const expected = [
        sessionId,
        '--message',
        message,
        ...(fullGate ? ['--full-gate'] : []),
      ];
      if (
        !sessionId ||
        !message ||
        rest.length !== expected.length ||
        JSON.stringify(rest) !== JSON.stringify(expected)
      ) {
        throw usage(
          'Usage: pnpm workflow finalize <session-id> --message <subject> [--full-gate] [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: finalizeSession(cwd, sessionId, message, process.env, {
          fullGate,
          consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
          onCheckEscalation: announceFinalizeCheckEscalation,
        }),
        intakeCounts: currentGovernanceIntakeCounts(cwd),
      };
    }
    case 'finalize-recover': {
      if (rest.length === 1) {
        return {
          command,
          ok: true,
          result: recoverFinalize(cwd, rest[0], process.env, {
            consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
          }),
        };
      }
      const sessionId = rest[0];
      const transactionId = optionValue(rest.slice(1), '--cancel');
      const reason = optionValue(rest.slice(1), '--reason');
      if (
        !sessionId ||
        !transactionId ||
        !reason ||
        rest.length !== 5 ||
        rest[1] !== '--cancel' ||
        rest[3] !== '--reason'
      ) {
        throw usage(
          'Usage: pnpm workflow finalize-recover <session-id> [--cancel <transaction-id> --reason <text>] [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: cancelFinalizeRecovery(cwd, sessionId, transactionId, reason, {
          consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
        }),
      };
    }
    case 'review-diff': {
      if (rest.length === 2 && rest[0] === 'inspect') {
        return {
          command,
          ok: true,
          result: inspectTaskDiffReviewSubject(cwd, rest[1]),
        };
      }
      if (rest.length === 2 && rest[0] === 'status') {
        return {
          command,
          ok: true,
          result: inspectTaskDiffReviewStatus(cwd, rest[1]),
        };
      }
      if (rest.length === 2 && rest[0] === 'reconcile') {
        let status;
        try {
          status = inspectTaskDiffReviewStatus(cwd, rest[1]);
        } catch (error) {
          if (
            !(error instanceof WorkflowError) ||
            error.code !==
              'TASK_DIFF_REVIEW_SUPERSESSION_RECONCILIATION_REQUIRED'
          ) {
            throw error;
          }
          return {
            command,
            ok: true,
            result: reconcileTaskDiffReview(cwd, rest[1], {
              collaborationGrantValidation: {
                consumedRoleResultReplay:
                  productionConsumedRoleResultReplayPort,
              },
            }),
          };
        }
        if (status.state === 'external-reconciliation-required') {
          return {
            command,
            ok: true,
            result: reconcileExternalTaskDiffReview(cwd, rest[1], {
              consumedReplayVerifier:
                taskDiffConsumedCollaborationGrantReplayVerifier(
                  cwd,
                  status.grantId,
                ),
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
            }),
          };
        }
        const grantSelection =
          'assignment' in status && 'grantId' in status.assignment
            ? taskDiffCollaborationGrantSelection(
                cwd,
                status.assignment.grantId,
              )
            : undefined;
        return {
          command,
          ok: true,
          result:
            'response' in status
              ? reconcileTaskDiffReviewContinuation(
                  cwd,
                  rest[1],
                  status.response.responseDigest,
                  {
                    consumedRoleResultReplay:
                      productionConsumedRoleResultReplayPort,
                  },
                )
              : reconcileTaskDiffReview(cwd, rest[1], {
                  collaborationGrantValidation: {
                    consumedRoleResultReplay:
                      productionConsumedRoleResultReplayPort,
                    ...(grantSelection !== undefined &&
                    'verifier' in grantSelection
                      ? { verifier: grantSelection.verifier }
                      : {}),
                  },
                }),
        };
      }
      const sessionId = rest[0];
      const actor = optionValue(rest.slice(1), '--actor');
      const grantId = optionValue(rest.slice(1), '--grant');
      const inputPath = optionValue(rest.slice(1), '--input');
      const collaborationGrantSelection =
        grantId === undefined
          ? undefined
          : taskDiffCollaborationGrantSelection(cwd, grantId);
      const validStartArguments =
        rest.length === 1 ||
        (rest.length === 3 && rest[1] === '--actor' && actor !== undefined) ||
        (rest.length === 3 && rest[1] === '--grant' && grantId !== undefined) ||
        (rest.length === 3 &&
          rest[1] === '--input' &&
          inputPath !== undefined) ||
        (rest.length === 5 &&
          rest[1] === '--actor' &&
          actor !== undefined &&
          rest[3] === '--grant' &&
          grantId !== undefined) ||
        (rest.length === 5 &&
          rest[1] === '--input' &&
          inputPath !== undefined &&
          rest[3] === '--grant' &&
          grantId !== undefined);
      if (sessionId && validStartArguments) {
        let status;
        if (inputPath !== undefined) {
          const parsedInput = parseTaskDiffReviewCliInput(cwd, inputPath);
          if (parsedInput.route === 'provider-response') {
            if (grantId !== undefined) throw taskDiffReviewUsage();
            status = beginTaskDiffReviewContinuationFromInput(
              cwd,
              sessionId,
              parsedInput.input,
              {
                consumedRoleResultReplay:
                  productionConsumedRoleResultReplayPort,
              },
            );
          } else if (parsedInput.route === 'external-initial') {
            status = submitExternalTaskDiffReview(
              cwd,
              sessionId,
              parsedInput.input,
              {
                consumedRoleResultReplay:
                  productionConsumedRoleResultReplayPort,
                ...(collaborationGrantSelection === undefined
                  ? {}
                  : { collaborationGrant: collaborationGrantSelection }),
              },
            );
          } else {
            const current = loadCurrentAuthenticatedTaskDiffReview(
              cwd,
              sessionId,
              {
                consumedRoleResultReplay:
                  productionConsumedRoleResultReplayPort,
              },
            );
            const response = createTaskDiffReviewChallengeResponse({
              review: current.review,
              responses: parsedInput.input.responses,
            });
            status = submitExternalTaskDiffReviewContinuation(
              cwd,
              sessionId,
              response,
              {
                schemaVersion: 1,
                kind: 'task-diff-review-closure-input.v1',
                subjectDigest: parsedInput.input.subjectDigest,
                reviewRecordDigest: parsedInput.input.reviewRecordDigest,
                responseDigest: response.responseDigest,
                proposedDispositions: parsedInput.input.proposedDispositions,
              },
              {
                consumedRoleResultReplay:
                  productionConsumedRoleResultReplayPort,
                ...(collaborationGrantSelection === undefined
                  ? {}
                  : { collaborationGrant: collaborationGrantSelection }),
              },
            );
          }
        } else {
          status = inspectTaskDiffReviewStatus(cwd, sessionId);
          if (
            status.state === 'ready' ||
            actor !== undefined ||
            grantId !== undefined
          ) {
            status = beginTaskDiffReview(cwd, sessionId, {
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
              ...(actor === undefined ? {} : { explicitActor: actor }),
              ...(grantId === undefined
                ? {}
                : {
                    collaborationGrant: collaborationGrantSelection,
                  }),
            });
          }
        }
        if (status.state === 'provider-succeeded-awaiting-reconciliation') {
          const reconciliationGrantSelection =
            'grantId' in status.assignment
              ? taskDiffCollaborationGrantSelection(
                  cwd,
                  status.assignment.grantId,
                )
              : collaborationGrantSelection;
          status =
            'response' in status
              ? reconcileTaskDiffReviewContinuation(
                  cwd,
                  sessionId,
                  status.response.responseDigest,
                  {
                    consumedRoleResultReplay:
                      productionConsumedRoleResultReplayPort,
                  },
                )
              : reconcileTaskDiffReview(cwd, sessionId, {
                  collaborationGrantValidation: {
                    consumedRoleResultReplay:
                      productionConsumedRoleResultReplayPort,
                    ...(reconciliationGrantSelection !== undefined &&
                    'verifier' in reconciliationGrantSelection
                      ? { verifier: reconciliationGrantSelection.verifier }
                      : {}),
                  },
                });
        }
        if (status.state === 'waiting-for-provider') {
          const runtime = loadInvestigationRuntimeContext(cwd).runtime;
          const invocation = readProviderInvocation(
            runtime,
            status.invocationId,
          );
          if (
            invocation.state === 'prepared' &&
            process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH !== '1'
          ) {
            dispatchProviderWorker(cwd, invocation.invocationId);
          }
        }
        return { command, ok: true, result: status };
      }
      throw taskDiffReviewUsage();
    }
    case 'rollback-completion': {
      const sessionId = rest[0];
      const reason = optionValue(rest.slice(1), '--reason');
      if (
        !sessionId ||
        !reason ||
        rest.length !== 3 ||
        rest[1] !== '--reason'
      ) {
        throw usage(
          'Usage: pnpm workflow rollback-completion <session-id> --reason <text> [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: rollbackCompletion(cwd, sessionId, reason),
      };
    }
    case 'commit': {
      const sessionId = rest[0];
      const message = optionValue(rest.slice(1), '--message');
      if (
        !sessionId ||
        !message ||
        rest.length !== 3 ||
        rest[1] !== '--message'
      ) {
        throw usage(
          'Usage: pnpm workflow commit <session-id> --message <subject> [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: commitSession(cwd, sessionId, message),
      };
    }
    case 'abort': {
      const sessionId = rest[0];
      const reason = optionValue(rest.slice(1), '--reason');
      if (
        !sessionId ||
        !reason ||
        rest.length !== 3 ||
        rest[1] !== '--reason'
      ) {
        throw usage(
          'Usage: pnpm workflow abort <session-id> --reason <text> [--json]',
        );
      }
      return {
        command,
        ok: true,
        session: abortSession(cwd, sessionId, reason),
      };
    }
    case 'help':
    case '--help':
    case '-h':
      return { command: 'help', ok: true, usage: usageText() };
    default:
      throw usage(
        command ? `Unknown workflow command: ${command}` : usageText(),
      );
  }
}

type AuthorityRemapCliInput = Readonly<{
  schemaVersion: 1;
  kind: 'workflow.authority-remap-request.v1';
  baseCommit: string;
  moveCommit: string;
  materializationCommit: string | null;
  renamePairs: readonly AuthorityRemapPair[];
  authorityPlan: Readonly<{
    changeId: string;
    taskId: string;
    profileId: string;
    reason: string;
    message: string;
  }>;
}>;

function readAuthorityRemapInput(
  cwd: string,
  inputPath: string,
): AuthorityRemapCliInput {
  const resolved = path.resolve(cwd, inputPath);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (
    stat === undefined ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size === 0 ||
    stat.size > 1024 * 1024
  ) {
    throw usage('Authority remap input must be a bounded plain JSON file.');
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  } catch {
    throw usage('Authority remap input must be valid JSON.');
  }
  const isObject = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' &&
    candidate !== null &&
    !Array.isArray(candidate);
  const hasStringFields = (
    candidate: unknown,
    fields: readonly string[],
  ): candidate is Record<string, string> =>
    isObject(candidate) &&
    fields.every((field) => typeof candidate[field] === 'string');
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'workflow.authority-remap-request.v1' ||
    typeof value.baseCommit !== 'string' ||
    typeof value.moveCommit !== 'string' ||
    (value.materializationCommit !== null &&
      typeof value.materializationCommit !== 'string') ||
    !Array.isArray(value.renamePairs) ||
    value.renamePairs.some(
      (pair) =>
        !isObject(pair) ||
        typeof pair.from !== 'string' ||
        typeof pair.to !== 'string',
    ) ||
    !hasStringFields(value.authorityPlan, [
      'changeId',
      'taskId',
      'profileId',
      'reason',
      'message',
    ])
  ) {
    throw usage('Authority remap input has an unsupported shape.');
  }
  return value as AuthorityRemapCliInput;
}

function doctor(cwd: string): CommandResult {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const openspec = diagnoseOpenSpec(git.repositoryRoot);
  const warnings: Array<{ code: string; message: string }> = [];

  if (!git.branch) {
    warnings.push({ code: 'DETACHED_HEAD', message: 'HEAD is detached.' });
  } else if (config.protectedBranches.includes(git.branch)) {
    warnings.push({
      code: 'PROTECTED_BRANCH',
      message: `Current branch ${git.branch} is protected; task session activation will fail.`,
    });
  }
  if (git.statusEntries.length > 0) {
    warnings.push({
      code: 'DIRTY_WORKTREE',
      message: `Worktree has ${git.statusEntries.length} staged, unstaged, or untracked status entries; task session activation will fail.`,
    });
  }
  const baseSpecRoot = path.posix.join(
    path.posix.dirname(config.changeRoot),
    'specs',
  );
  if (!fs.existsSync(path.join(git.repositoryRoot, baseSpecRoot))) {
    warnings.push({
      code: 'NO_BASE_SPECS',
      message: `${baseSpecRoot} does not exist yet; create the current managed base specifications before planning changes.`,
    });
  }
  for (const diagnostic of openspec.diagnostics) {
    if (diagnostic.severity !== 'info') {
      warnings.push({
        code: diagnostic.code,
        message: diagnostic.message,
      });
    }
  }

  return {
    command: 'doctor',
    ok: true,
    mode: 'diagnostic',
    repository: {
      root: git.repositoryRealPath,
      gitCommonDirectory: git.gitCommonDirectory,
      branch: git.branch,
      head: git.head,
      clean: git.statusEntries.length === 0,
    },
    configuration: {
      path: 'workflow/config.json',
      changeRoot: config.changeRoot,
      runtimeDirectory: config.runtimeDirectory,
      protectedBranches: config.protectedBranches,
      branchTemplate: config.branchTemplate,
    },
    openspec,
    projections: inspectProjectionStatus(git.repositoryRoot),
    retainedSpectraUsed: false,
    activeSessionCount: listSessions(cwd).filter(
      (session) => session.state === 'active' || session.state === 'revising',
    ).length,
    warnings,
  };
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function sessionStatusRepositoryRoot(
  callerRoot: string,
  session: ReturnType<typeof getSession>,
): string {
  return session.state === 'active' || session.state === 'revising'
    ? session.repositoryRoot
    : callerRoot;
}

function currentGovernanceIntakeCounts(cwd: string) {
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  return inspectGovernanceIntakeCounts(
    repository.repositoryRoot,
    runtimePaths(repository.gitCommonDirectory, config.runtimeDirectory).root,
  );
}

type TaskDiffReviewCliInput =
  | Readonly<{
      route: 'provider-response';
      input: TaskDiffReviewChallengeResponseInput;
    }>
  | Readonly<{
      route: 'external-initial';
      input: TaskDiffReviewExternalSubmissionInput;
    }>
  | Readonly<{
      route: 'external-closure';
      input: TaskDiffReviewExternalClosureRequestInput;
    }>;

function parseTaskDiffReviewCliInput(
  cwd: string,
  inputPath: string,
): TaskDiffReviewCliInput {
  let value: unknown;
  try {
    value = JSON.parse(
      fs.readFileSync(path.resolve(cwd, inputPath), 'utf8'),
    ) as unknown;
  } catch {
    throw workflowError(
      'TASK_DIFF_REVIEW_INPUT_INVALID',
      'TaskDiffReview input must be a readable exact typed JSON envelope.',
      ExitCode.usage,
    );
  }
  const kind =
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).kind === 'string'
      ? (value as Record<string, unknown>).kind
      : null;
  if (kind === 'task-diff-review-challenge-response-input.v1') {
    return Object.freeze({
      route: 'provider-response' as const,
      input: parseTaskDiffReviewChallengeResponseInput(value),
    });
  }
  if (kind === 'task-diff-review-submission-input.v1') {
    return Object.freeze({
      route: 'external-initial' as const,
      input: parseTaskDiffReviewExternalSubmissionInput(value),
    });
  }
  if (kind === 'task-diff-review-external-closure-request.v1') {
    return Object.freeze({
      route: 'external-closure' as const,
      input: parseTaskDiffReviewExternalClosureRequestInput(value),
    });
  }
  throw workflowError(
    'TASK_DIFF_REVIEW_INPUT_INVALID',
    'TaskDiffReview input kind must select provider response, external initial review, or external challenge closure.',
    ExitCode.usage,
  );
}

function taskDiffReviewUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow review-diff <session-id> [--actor <provider>] [--grant <grant-id>] [--input <typed-envelope.json> [--grant <grant-id>]] [--json]\n' +
      '       pnpm workflow review-diff <inspect|status|reconcile> <session-id> [--json]',
  );
}

function maintainerTaskDiffReviewUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer review-diff-attest <session-id> --input <typed-envelope.json> --grant <grant-id> [--json]',
  );
}

function parseProposeOptions(
  args: string[],
  allowedOptions: string[],
  allowedFlags: string[] = [],
): { values: Map<string, string>; flags: Set<string> } {
  const flags = new Set<string>();
  const pairs: string[] = [];
  for (const argument of args) {
    if (allowedFlags.includes(argument)) {
      if (flags.has(argument)) {
        throw proposeUsage();
      }
      flags.add(argument);
      continue;
    }
    pairs.push(argument);
  }
  if (pairs.length === 0 || pairs.length % 2 !== 0) {
    throw proposeUsage();
  }
  const allowed = new Set(allowedOptions);
  const values = new Map<string, string>();
  for (let index = 0; index < pairs.length; index += 2) {
    const option = pairs[index];
    const value = pairs[index + 1];
    if (!option || !value || !allowed.has(option) || values.has(option)) {
      throw proposeUsage();
    }
    values.set(option, value);
  }
  return { values, flags };
}

function parseMaintainerGrantV2PreflightArguments(
  args: string[],
): MaintainerGrantV2PreflightRequest {
  if (
    args.length !== 4 ||
    args[0] !== 'grant' ||
    args[1] !== 'preflight' ||
    args[2] !== '--profile' ||
    !args[3]
  ) {
    throw maintainerGrantV2PreflightUsage();
  }
  return { profileId: args[3] };
}

function parseMaintainerApproveAndApplyArguments(
  args: string[],
  cwd: string,
): ApproveAndApplyMaintainerGrantV2Request {
  if (args[0] !== 'grant' || args[1] !== 'approve-and-apply') {
    throw maintainerApproveAndApplyUsage();
  }
  const values = args.slice(2);
  const scalar = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (
      !option ||
      !value ||
      ![
        '--change',
        '--task',
        '--profile',
        '--reason',
        '--message',
        '--effects-file',
        '--waivers-file',
      ].includes(option) ||
      scalar.has(option)
    ) {
      throw maintainerApproveAndApplyUsage();
    }
    scalar.set(option, value);
  }
  const changeId = scalar.get('--change');
  const taskId = scalar.get('--task');
  const profileId = scalar.get('--profile');
  const reason = scalar.get('--reason');
  const message = scalar.get('--message');
  const effectsFile = scalar.get('--effects-file');
  const waiversFile = scalar.get('--waivers-file');
  if (
    !changeId ||
    !taskId ||
    !profileId ||
    !reason ||
    !message ||
    !effectsFile
  ) {
    throw maintainerApproveAndApplyUsage();
  }
  return {
    changeId,
    taskId,
    profileId,
    reason,
    message,
    externalEffects:
      effectsFile === 'none'
        ? []
        : readCandidateExternalEffectsDeclaration(effectsFile, cwd),
    ...(waiversFile === undefined
      ? {}
      : {
          evidenceWaivers:
            waiversFile === 'none'
              ? []
              : readMaintainerEvidenceWaiversDeclaration(waiversFile, cwd),
        }),
  };
}

function parseMaintainerReissueAndApplyArguments(
  args: string[],
  cwd: string,
): ReissueAndApplyMaintainerGrantV2Request {
  if (args[0] !== 'grant' || args[1] !== 'reissue-and-apply') {
    throw maintainerReissueAndApplyUsage();
  }
  const values = args.slice(2);
  const scalar = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (
      !option ||
      !value ||
      !['--grant', '--reason', '--ttl-minutes', '--waivers-file'].includes(
        option,
      ) ||
      scalar.has(option)
    ) {
      throw maintainerReissueAndApplyUsage();
    }
    scalar.set(option, value);
  }
  const priorGrantId = scalar.get('--grant');
  const reason = scalar.get('--reason');
  const waiversFile = scalar.get('--waivers-file');
  if (!priorGrantId || !reason) {
    throw maintainerReissueAndApplyUsage();
  }
  const requestedTtlMinutes = scalar.get('--ttl-minutes');
  if (
    requestedTtlMinutes !== undefined &&
    !/^[1-9][0-9]*$/.test(requestedTtlMinutes)
  ) {
    throw maintainerReissueAndApplyUsage();
  }
  const ttlMinutes =
    requestedTtlMinutes === undefined
      ? undefined
      : Number.parseInt(requestedTtlMinutes, 10);
  if (
    ttlMinutes !== undefined &&
    (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1)
  ) {
    throw maintainerReissueAndApplyUsage();
  }
  return {
    priorGrantId,
    reason,
    ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
    ...(waiversFile === undefined
      ? {}
      : {
          evidenceWaivers:
            waiversFile === 'none'
              ? []
              : readMaintainerEvidenceWaiversDeclaration(waiversFile, cwd),
        }),
  };
}

function readCandidateExternalEffectsDeclaration(
  requestedPath: string,
  cwd: string,
): CandidateExternalEffect[] {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.resolve(cwd, requestedPath), 'utf8'),
    ) as unknown;
    if (!Array.isArray(value)) throw new Error('not an array');
    return value as CandidateExternalEffect[];
  } catch {
    throw workflowError(
      'APPLY_CANDIDATE_EFFECTS_DECLARATION_INVALID',
      'External effects declaration must be a readable JSON array or explicit none.',
      ExitCode.usage,
    );
  }
}

function readMaintainerEvidenceWaiversDeclaration(
  requestedPath: string,
  cwd: string,
): MaintainerEvidenceWaiver[] {
  try {
    return parseMaintainerEvidenceWaivers(
      JSON.parse(
        fs.readFileSync(path.resolve(cwd, requestedPath), 'utf8'),
      ) as unknown,
    );
  } catch {
    throw workflowError(
      'MAINTAINER_EVIDENCE_WAIVER_DECLARATION_INVALID',
      'Evidence waiver declaration must be a readable JSON array of sorted {checkId, reason} entries or explicit none.',
      ExitCode.usage,
    );
  }
}

function maintainerGrantV2PreflightUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer grant preflight --profile <profile-id> [--json]',
  );
}

function maintainerApproveAndApplyUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer grant approve-and-apply --change <change-id> --task <mandate-task-id> --profile <profile-id> --reason <text> --message <subject> --effects-file <json|none> [--waivers-file <json|none>] [--json]',
  );
}

function maintainerReissueAndApplyUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer grant reissue-and-apply --grant <prior-grant-id> --reason <text> [--ttl-minutes <positive-integer>] [--waivers-file <json|none>] [--json]',
  );
}

function parseHumanResolutionPublicationDiscardArguments(args: string[]): {
  grantId: string;
  expectedPublicationStateDigest: string;
  reason: string;
} {
  if (
    args[0] !== 'resolution-publication-discard' ||
    typeof args[1] !== 'string'
  ) {
    throw humanResolutionPublicationDiscardUsage();
  }
  const options = new Map<string, string>();
  for (let index = 2; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      typeof key !== 'string' ||
      typeof value !== 'string' ||
      !['--expected-publication-state', '--reason'].includes(key) ||
      options.has(key)
    ) {
      throw humanResolutionPublicationDiscardUsage();
    }
    options.set(key, value);
  }
  const expectedPublicationStateDigest = options.get(
    '--expected-publication-state',
  );
  const reason = options.get('--reason');
  if (
    args.length !== 6 ||
    expectedPublicationStateDigest === undefined ||
    reason === undefined
  ) {
    throw humanResolutionPublicationDiscardUsage();
  }
  return {
    grantId: args[1],
    expectedPublicationStateDigest,
    reason,
  };
}

function humanResolutionPublicationDiscardUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer resolution-publication-discard <grant-id> --expected-publication-state <digest> --reason <text> [--json]',
  );
}

function parseMaintainerAttestArguments(
  args: string[],
): AuthorityAttestationRequest {
  if (args[0] !== 'attest') {
    throw maintainerAttestUsage();
  }
  const values = args.slice(1);
  let originalCommit: string | undefined;
  let mainCommit: string | undefined;
  const grantBasePairs: Array<{ originalBase: string; mainBase: string }> = [];

  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!option || !value || !option.startsWith('--')) {
      throw maintainerAttestUsage();
    }
    switch (option) {
      case '--original':
        if (originalCommit !== undefined) {
          throw maintainerAttestUsage();
        }
        originalCommit = value;
        break;
      case '--main':
        if (mainCommit !== undefined) {
          throw maintainerAttestUsage();
        }
        mainCommit = value;
        break;
      case '--base': {
        const separator = value.indexOf('=');
        if (separator === -1) {
          throw maintainerAttestUsage();
        }
        grantBasePairs.push({
          originalBase: value.slice(0, separator),
          mainBase: value.slice(separator + 1),
        });
        break;
      }
      default:
        throw maintainerAttestUsage();
    }
  }
  if (!originalCommit || !mainCommit) {
    throw maintainerAttestUsage();
  }
  return { originalCommit, mainCommit, grantBasePairs };
}

function maintainerAttestUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer attest --original <commit> --main <commit> [--base <original>=<main> ...] [--json]',
  );
}

function maintainerUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer <review-diff-attest <session-id> --input <typed-envelope.json> --grant <grant-id>|grant ...|resolution-inspect [grant-id]|resolution-publication-discard <grant-id> ...|resolution-revoke <grant-id> --reason <text>|attest ...|attestation-relay --original <commit>|inspect [grant-id]|collaboration-grant ...|collaboration-inspect [grant-id]|collaboration-revoke <grant-id> --reason <text>> [--json]',
  );
}

function authorityPlanUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow authority-plan <prepare --intent <intent.json>|status <plan-id>|approve-and-apply <plan-id>|resume <plan-id>|attest <plan-id>> [--json]',
  );
}

function readAuthorityPlanIntent(
  cwd: string,
  inputPath: string,
): AuthorityPlanIntent {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(cwd, inputPath), 'utf8'),
    ) as AuthorityPlanIntent;
  } catch {
    throw workflowError(
      'AUTHORITY_PLAN_INVALID',
      'Authority plan intent must be a readable exact JSON document.',
      ExitCode.usage,
    );
  }
}

function readPreMergeSubmission(
  cwd: string,
  inputPath: string,
): IntegrationDeltaReviewSubmission {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(cwd, inputPath), 'utf8'),
    ) as IntegrationDeltaReviewSubmission;
  } catch {
    throw workflowError(
      'PRE_MERGE_INTEGRATION_REVIEW_INVALID',
      'Pre-merge review input must be a readable exact JSON document.',
      ExitCode.usage,
    );
  }
}

function assertControllingTerminal(): void {
  assertInteractiveSignerContext({
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    stderrIsTty: process.stderr.isTTY === true,
  });
}

function proposeUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow propose <change-id> --intent <intent.json> [--mandate <mandate-task-id>] [--actor <id>] [--grant <grant-id>] [--json]\n       pnpm workflow propose <change-id> --resume --input <envelope.json> [--grant <grant-id>|--role-context-grant <grant-id>] [--json]',
  );
}

function readTaskMandateRequest(manifestPath: string, cwd: string) {
  let value: unknown;
  try {
    value = JSON.parse(
      fs.readFileSync(path.resolve(cwd, manifestPath), 'utf8'),
    ) as unknown;
  } catch {
    throw workflowError(
      'TASK_MANDATE_INVALID',
      'Task mandate request must be a readable JSON manifest.',
      ExitCode.guard,
    );
  }
  return parseTaskMandateRequest(value);
}

function taskMandateUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow task <authorize <manifest.json> --audit-root <absolute-external-path>|status <task-id>|revoke <task-id> --reason <text>> [--json]',
  );
}

function readExternalEffectJson<T>(manifestPath: string, cwd: string): T {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(cwd, manifestPath), 'utf8'),
    ) as T;
  } catch {
    throw workflowError(
      'EXTERNAL_EFFECT_GRANT_INVALID',
      'External effect target and rollback inputs must be readable JSON files.',
      ExitCode.guard,
    );
  }
}

function externalEffectUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow external-effect <issue --grant <uuid> --task <task-id> --kind <kind> --target-file <json> --artifact-digest <sha256:digest> --prestate-digest <sha256:digest> --rollback-plan-file <json|none> --idempotency-key <key> [--ttl-seconds <1..300>]|inspect <grant-id>|revoke <grant-id> --reason <text>|reconcile <grant-id> --evidence-file <json>> [--json]',
  );
}

function publishUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow publish execute --grant <external-effect-grant-id> [--json]',
  );
}

type StoredGrantFamily = 'execution-budget' | 'apply' | 'external-effect';

function resolveStoredGrantFamily(
  cwd: string,
  requestedGrantId: string,
): StoredGrantFamily {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const runtime = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const maintainer = maintainerGrantStorePaths(repository.gitCommonDirectory);
  const external = externalEffectStorePaths(repository.gitCommonDirectory);
  const recordExists = (filePath: string): boolean =>
    fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
  const recordName = `${grantId}.json`;
  const families: StoredGrantFamily[] = [
    ...(recordExists(
      path.join(runtime.root, 'execution-budget-grants', recordName),
    )
      ? (['execution-budget'] as const)
      : []),
    ...([maintainer.available, maintainer.reserved, maintainer.terminal].some(
      (directory) => recordExists(path.join(directory, recordName)),
    )
      ? (['apply'] as const)
      : []),
    ...([external.available, external.transactions, external.terminal].some(
      (directory) => recordExists(path.join(directory, recordName)),
    )
      ? (['external-effect'] as const)
      : []),
  ];
  if (families.length === 0) {
    throw workflowError(
      'GRANT_NOT_FOUND',
      `Grant ${grantId} does not exist in local authoritative state.`,
      ExitCode.guard,
    );
  }
  if (families.length !== 1) {
    throw workflowError(
      'GRANT_FAMILY_AMBIGUOUS',
      `Grant ${grantId} exists in more than one authority family.`,
      ExitCode.staleState,
    );
  }
  return families[0]!;
}

function executionGrantUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow grant <approve <grant-request.json> [--uses <count>]|inspect <grant-id>|revoke <grant-id> --reason <text>> [--json]',
  );
}

function executionJobUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow job <list|status <job-id>|watch <job-id>|prune --limit <count>|retry-pump --limit <count>|retry-schedules|retry-receipts [schedule-id]|retry-request <job-id> --timeout <milliseconds>|retry <job-id> --grant <grant-id>|retry-preview <job-id> --timeout <milliseconds>> [--json]',
  );
}

function retentionUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow retention <inspect|sweep --limit <count>|pin <workflow-id> <evidence-id> --reason <text>> [--json]',
  );
}

function interventionControlDependencies(cwd: string) {
  return {
    now: () => new Date(),
    verifyHumanSignature(
      payload: string,
      signature: string,
      signer: string,
      namespace: string,
    ): boolean {
      try {
        const repository = discoverRepository(cwd);
        const policy = parseMaintainerPolicy(
          JSON.parse(
            runGit(repository.repositoryRoot, [
              'show',
              `${repository.head}:workflow/maintainer-policy.json`,
            ]),
          ),
        );
        const verifier = createInteractiveSshSigner(
          repository.repositoryRoot,
          policy,
        );
        verifier.verify(payload, signature, signer, namespace);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function dispatchProductionControlPlaneCommand(rest: string[], cwd: string) {
  const repository = discoverRepository(cwd);
  const stateRoot = bootstrapInterventionStateRoot(
    repository.gitCommonDirectory,
  );
  const dependencies = controlPlaneUpdaterDependencies(cwd);
  if (rest[0] === 'produce' && rest.length === 2) {
    return produceControlPlaneApprovalCandidateV3(
      repository.repositoryRealPath,
      stateRoot,
      rest[1]!,
      {
        now: dependencies.now,
        reviewSigner: dependencies.approvalSigner,
        verifyHumanSignature: dependencies.verifyHumanSignature,
        presentReviewSummary: dependencies.presentReviewSummary,
      },
    );
  }
  return dispatchProductionControlPlaneUpdaterCommand(
    rest,
    stateRoot,
    dependencies,
    cwd,
  );
}

function controlPlaneUpdaterDependencies(cwd: string) {
  const human = interventionControlDependencies(cwd);
  const repository = discoverRepository(cwd);
  let resolvedApprovalSigner: MaintainerSignerProvider | null = null;
  const resolveApprovalSigner = (): MaintainerSignerProvider => {
    if (resolvedApprovalSigner === null) {
      const policy = parseMaintainerPolicy(
        JSON.parse(
          runGit(repository.repositoryRoot, [
            'show',
            `${repository.head}:workflow/maintainer-policy.json`,
          ]),
        ),
      );
      resolvedApprovalSigner = createInteractiveSshSigner(
        repository.repositoryRoot,
        policy,
      );
    }
    return resolvedApprovalSigner;
  };
  const approvalSigner: MaintainerSignerProvider = {
    assertHumanPresent(): void {
      assertInteractiveSignerContext({
        stdinIsTty: process.stdin.isTTY === true,
        stdoutIsTty: process.stdout.isTTY === true,
        stderrIsTty: process.stderr.isTTY === true,
      });
      resolveApprovalSigner().assertHumanPresent();
    },
    identity: () => resolveApprovalSigner().identity(),
    sign: (payload, namespace) =>
      resolveApprovalSigner().sign(payload, namespace),
    verify: (payload, signature, identity, namespace) =>
      resolveApprovalSigner().verify(payload, signature, identity, namespace),
  };
  return {
    ...human,
    approvalSigner,
    resolveTaskMandateBinding(parentTaskId: string) {
      return controlPlaneTaskMandateBindingFromTaskMandate(
        inspectActiveTaskMandateBinding(cwd, parentTaskId),
      );
    },
    revalidateTaskMandateBinding(
      binding: Parameters<typeof assertSameControlPlaneTaskMandateBinding>[0],
      _phase: ControlPlaneTaskMandateValidationPhase,
    ): void {
      const current = controlPlaneTaskMandateBindingFromTaskMandate(
        inspectActiveTaskMandateBinding(cwd, binding.parentTaskId),
      );
      assertSameControlPlaneTaskMandateBinding(binding, current);
    },
    presentApprovalSummaryV3(summary: ControlPlaneApprovalSummaryV3): void {
      process.stderr.write(`\n${summary.humanReadable}\n\n`);
    },
    presentReviewSummary(summary: ControlPlanePromotionReviewSummaryV3): void {
      process.stderr.write(`\n${summary.humanReadable}\n\n`);
    },
    consumedGrantIds: new Set<string>(),
    auditSink: {
      append(record: ControlPlaneUpdaterAuditRecord): void {
        recordAuthorityAuditEvent(
          {
            externalAuditRoot: record.externalAuditRoot,
            repositoryRoot: repository.repositoryRoot,
            repositoryId: deriveAuthorityAuditRepositoryId(record.repositoryId),
          },
          {
            eventType: controlPlaneAuditEventType(record),
            occurredAt: record.recordedAt,
            idempotencyKey: record.recordId,
            grantDigest: record.grantEnvelopeDigest,
            candidateBundleDigest: record.promotionBundleDigest,
            prestateDigest: null,
            poststateDigest: record.evidenceDigest,
            actor: {
              kind: 'engine',
              identity: 'control-plane-updater',
            },
            taskId: record.parentTaskId,
            changeId: record.changeId,
            workflowId: record.txId,
            command: {
              name: 'control-plane.update',
              argvDigest: record.recordDigest,
            },
            providerInvocation: null,
            externalEffect: null,
            result: controlPlaneAuditResult(record),
            outcomeDigest: record.recordDigest,
            errorCode: null,
          },
        );
      },
    },
  };
}

function controlPlaneAuditEventType(
  record: ControlPlaneUpdaterAuditRecord,
): AuthorityAuditEventType {
  switch (record.event) {
    case 'prepared':
      return 'control-plane-grant';
    case 'switched':
      return 'cas';
    case 'rollback-required':
    case 'rolled-back':
      return 'rollback';
    case 'finalized':
      return 'grant-consume';
    default:
      return 'poststate';
  }
}

function controlPlaneAuditResult(
  record: ControlPlaneUpdaterAuditRecord,
): AuthorityAuditResult {
  switch (record.event) {
    case 'finalized':
      return 'succeeded';
    case 'rolled-back':
      return 'rolled-back';
    default:
      return 'recorded';
  }
}

function requireArgumentCount(
  command: string,
  args: string[],
  minimum: number,
  maximum: number,
): void {
  if (args.length < minimum || args.length > maximum) {
    throw usage(`Invalid arguments for workflow ${command}.\n${usageText()}`);
  }
}

function loadT3BoundaryTypeScript(): T3BoundaryTypeScriptApi {
  try {
    return toolingRequire('typescript') as T3BoundaryTypeScriptApi;
  } catch {
    throw workflowError(
      'T3_BOUNDARY_SCANNER_UNAVAILABLE',
      'The T3 boundary inventory is a Jigwright source-repository command and requires its development TypeScript parser.',
      ExitCode.verification,
    );
  }
}

function usage(message: string): WorkflowError {
  return workflowError('INVALID_USAGE', message, ExitCode.usage);
}

function usageText(): string {
  return [
    'Usage:',
    '  pnpm workflow doctor [--json]',
    '  pnpm workflow validate-change <change-id> [--json]',
    '  pnpm workflow propose <change-id> --intent <intent.json> --mandate <mandate-task-id> [--actor <id>] [--grant <grant-id>] [--json]',
    '  pnpm workflow propose <change-id> --resume --input <envelope.json> [--grant <grant-id>|--role-context-grant <grant-id>] [--json]',
    '  pnpm workflow plan-commit <change-id> [--json]',
    '  pnpm workflow amend-plan --change <change-id> --reason <code> --execution-impact <none|required> [--json]',
    '  pnpm workflow archive <change-id> [--json]',
    '  pnpm workflow archive-candidates --base <origin/protected-branch> [--json]',
    '  pnpm workflow after-merge <change-id> [--workspace-parent <absolute-path>] [--json]',
    '  pnpm workflow archive-pr doctor --base <origin/protected-branch> [--json]',
    '  pnpm workflow archive-pr dry-run <change-id> [--workspace-parent <absolute-path>] [--json]',
    '  pnpm workflow archive-pr status <sha256:preparation-identity> [--json]',
    '  pnpm workflow archive-pr prepare <change-id> --config <github-adapter.json> [--workspace-parent <absolute-path>] [--json]',
    '  pnpm workflow archive-pr open <change-id> --config <github-adapter.json> --grant <challenge-id> [--workspace-parent <absolute-path>] [--json]',
    '  pnpm workflow openspec-assets <generate|check|install-prompts --codex-home <path>> [--json]',
    '  pnpm workflow job list [--json]',
    '  pnpm workflow job status <job-id> [--json]',
    '  pnpm workflow job watch <job-id> [--json]',
    '  pnpm workflow job prune --limit <count> [--json]',
    '  pnpm workflow job retry-pump --limit <count> [--json]',
    '  pnpm workflow job retry-schedules [--json]',
    '  pnpm workflow job retry-receipts [schedule-id] [--json]',
    '  pnpm workflow job retry-request <job-id> --timeout <milliseconds> [--json]',
    '  pnpm workflow job retry <job-id> --grant <grant-id> [--json]',
    '  pnpm workflow job retry-preview <job-id> --timeout <milliseconds> [--json]',
    '  pnpm workflow metrics show [--json]',
    '  pnpm workflow semantic-ledger reconcile --change <change-id> [--input <json>] [--json]',
    '  pnpm workflow retention inspect [--json]',
    '  pnpm workflow retention sweep --limit <count> [--json]',
    '  pnpm workflow retention pin <workflow-id> <evidence-id> --reason <text> [--json]',
    '  pnpm workflow grant approve <grant-request.json> [--uses <count>] [--json]',
    '  pnpm workflow grant inspect <grant-id> [--json]',
    '  pnpm workflow grant revoke <grant-id> --reason <text> [--json]',
    '  pnpm workflow external-effect issue --grant <uuid> --task <task-id> --kind <kind> --target-file <json> --artifact-digest <sha256:digest> --prestate-digest <sha256:digest> --rollback-plan-file <json|none> --idempotency-key <key> [--ttl-seconds <1..300>] [--json]',
    '  pnpm workflow external-effect inspect <grant-id> [--json]',
    '  pnpm workflow external-effect revoke <grant-id> --reason <text> [--json]',
    '  pnpm workflow external-effect reconcile <grant-id> --evidence-file <json> [--json]',
    '  pnpm workflow publish execute --grant <external-effect-grant-id> [--json]',
    '  pnpm workflow task authorize <manifest.json> --audit-root <absolute-external-path> [--json]',
    '  pnpm workflow task status <task-id> [--json]',
    '  pnpm workflow task revoke <task-id> --reason <text> [--json]',
    '  pnpm workflow change intervene <parent-change-id> --reason <text> --audit-root <absolute-external-path> [--json]',
    '  pnpm workflow change revoke-intervention <parent-change-id> --reason <text> [--json]',
    '  pnpm workflow engine build-artifact <absolute-executable-path> --for <parent-change-id> --protocol-version <positive-integer> --policy-schema-version <positive-integer> --audit-root <absolute-path> [--json]',
    '  pnpm workflow engine adopt <artifact-id> --into <parent-change-id> --audit-root <absolute-external-path> [--json]',
    '  pnpm workflow intervention status <parent-change-id> [--tx <tx-id>] [--json]',
    '  pnpm workflow intervention recover <tx-id> [--json]',
    '  pnpm workflow control-plane produce <frozen-candidate-bundle-digest> [--json]',
    '  pnpm workflow control-plane approve-and-apply <candidate-id> --task <parent-task-id> [--json]',
    '  pnpm workflow control-plane recover <grant-id> [--json]',
    '  pnpm workflow control-plane status <grant-id> [--json]',
    '  pnpm workflow audit show <task-id> --audit-root <absolute-external-path> [--json]',
    '  pnpm workflow audit verify <repository-id> --audit-root <absolute-external-path> [--json]',
    '  pnpm workflow run-check <check-id> [--json]',
    '  pnpm workflow ci --base <commit> --head <commit> [--input <integration-review.json>] [--json]',
    '  pnpm workflow adapter evaluate [--config <absolute-host-path>] [--json]',
    '  jigwright agent provider probe <profile-id> --config <absolute-host-path> [--json]',
    '  jigwright agent provider test <profile-id> --config <absolute-host-path> --live [--json]',
    '  pnpm workflow role-config <show|configure --config <absolute-host-path>|simulate --config <absolute-host-path> --caller <logical-provider-id>> [--json]',
    '  pnpm workflow adapter availability-pilot --record <workflow/provider-availability-pilots/name.json> [--json]',
    '  pnpm workflow adapter verify-availability-pilot --record <workflow/provider-availability-pilots/name.json> [--json]',
    '  pnpm workflow source <capture --input <source-envelope.json>|link-change <source-id> --change <change-id>|list|show <source-id>|trace <source-id>> [--json]',
    '  pnpm workflow now <original-text> [--kind <kind>] [--json]',
    '  pnpm workflow now <work-item-id> [--json]',
    '  pnpm workflow later <original-text> [--kind <kind>] [--json]',
    '  pnpm workflow attach <work-item-id> <original-text>|<SRC-id> [--supersedes <SRC-id>] [--json]',
    '  pnpm workflow finding <add [--session <session-id>] --input <finding-envelope.json>|list [--all]|convert <finding-id> [--kind <kind>] [--now]|link <finding-id> --change <change-id>|dismiss <finding-id> --reason <reason>> [--json]',
    '  pnpm workflow work-item <create|review|promote-prepare|promote|list|show|search|trace|recommend|inventory|render|validate> ... [--json]',
    '  pnpm workflow maintainer grant preflight --profile <profile-id> [--json]',
    '  pnpm workflow maintainer grant approve-and-apply --change <change-id> --task <mandate-task-id> --profile <profile-id> --reason <text> --message <subject> --effects-file <json|none> [--waivers-file <json|none>] [--json]',
    '  pnpm workflow maintainer grant reissue-and-apply --grant <prior-grant-id> --reason <text> [--ttl-minutes <positive-integer>] [--waivers-file <json|none>] [--json]',
    '  pnpm workflow maintainer revision-approval <session-id> --target <digest> --reason <text> [--json]',
    '  pnpm workflow maintainer resolution-inspect [grant-id] [--json]',
    '  pnpm workflow maintainer resolution-publication-discard <grant-id> --expected-publication-state <digest> --reason <text> [--json]',
    '  pnpm workflow maintainer resolution-revoke <grant-id> --reason <text> [--json]',
    '  pnpm workflow maintainer attest --original <commit> --main <commit> [--base <original>=<main> ...] [--json]',
    '  pnpm workflow maintainer attestation-relay --original <commit> [--json]',
    '  pnpm workflow maintainer inspect [grant-id] [--json]',
    '  pnpm workflow maintainer collaboration-grant --change <id> [--task <task-id>] --base <commit> --target <digest> --phase <blind-survey|plan-review|task-diff-review|task-implementation> --author-role <role> --conflicting-role <role> (--provider <codex|claude> --actor-assurance <grade>|--caller <id> --actor-assurance <grade>|--direct-human true) --degraded <same-provider-fresh-session|caller-supplied|direct-human-review> --reason <text> [--ttl <minutes>m] [--uses 1] [--json]',
    '  pnpm workflow maintainer collaboration-inspect [grant-id] [--json]',
    '  pnpm workflow maintainer collaboration-revoke <grant-id> --reason <text> [--json]',
    '  pnpm workflow human-resolution-state <investigation-id> [--json]',
    '  pnpm workflow grant human <request-investigation-v3 <investigation-id> --reason <agent-proposed-reason>|request-change-routing-continuation <change-id> --reason <agent-proposed-reason>|request-work-item-review <work-item-id> --input <review.json> --reason <reason>|request-work-item-promotion <work-item-id> --change <change-id> --expected <digest> --reason <reason>|inspect <challenge-id>|decide <challenge-id>|recover <challenge-id>> [--json]',
    '  pnpm workflow documents validate [--json]',
    '  pnpm workflow document-refresh <propose|show|review|apply> ... [--json]',
    '  pnpm workflow handoff validate [--json]',
    '  pnpm workflow guidance <install [path ...]|refresh|remove|status> [--json]',
    '  pnpm workflow hook <pre-commit|commit-msg|pre-push|post-merge> ... [--json]',
    ...workflowGuidanceUsageLines().map((line) => `  ${line}`),
  ].join('\n');
}

function printSuccess(
  result: CommandResult,
  json: boolean,
  write: (chunk: string) => void = (chunk) => {
    process.stdout.write(chunk);
  },
): void {
  if (json) {
    write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (result.command === 'help' && typeof result.usage === 'string') {
    write(`${result.usage}\n`);
    return;
  }
  write(`${JSON.stringify(result, null, 2)}\n`);
}

function announceFinalizeCheckEscalation(
  escalation: 'all-tasks-terminal' | 'explicit',
  requiredChecks: readonly string[],
): void {
  if (!requiredChecks.includes('workflow-full-gate')) return;
  process.stderr.write(
    escalation === 'all-tasks-terminal'
      ? 'This finalize completes the change → running full gate.\n'
      : 'This finalize was explicitly escalated → running full gate.\n',
  );
}

function currentCollaborationGrantSelection(cwd: string, grantId: string) {
  const repository = discoverRepository(cwd);
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  return Object.freeze({
    grantId,
    verifier: createCurrentAuthoritativeCollaborationGrantVerifier(policy),
  });
}

function currentRoleContextSharingGrantSelection(cwd: string, grantId: string) {
  const repository = discoverRepository(cwd);
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  return Object.freeze({
    grantId,
    lifecycle: productionRoleContextSharingGrantLifecyclePort,
    verifier: createCurrentAuthoritativeRoleContextSharingGrantVerifier(policy),
  });
}

function maintainerPolicyAtCommit(repositoryRoot: string, commit: string) {
  return parseMaintainerPolicy(
    JSON.parse(
      runGit(repositoryRoot, [
        'show',
        `${commit}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
}

function taskDiffCollaborationGrantSelection(cwd: string, grantId: string) {
  const repository = discoverRepository(cwd);
  const inspection = readCollaborationGrantInspection(
    repository.gitCommonDirectory,
    grantId,
  );
  if (inspection?.state === 'consumed') {
    if (inspection.use === undefined) {
      throw workflowError(
        'COLLABORATION_GRANT_CONSUMED_REPLAY_VERIFIER_UNAVAILABLE',
        'The terminal-only Collaboration Grant replay verifier is unavailable.',
        ExitCode.guard,
      );
    }
    const historicalPolicy = maintainerPolicyAtCommit(
      repository.repositoryRoot,
      inspection.use.envelope.payload.baselineCommit,
    );
    return Object.freeze({
      grantId,
      consumedReplayVerifier:
        createConsumedCollaborationGrantReplayVerifier(historicalPolicy),
    });
  }
  const currentPolicy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  return Object.freeze({
    grantId,
    verifier:
      createCurrentAuthoritativeCollaborationGrantVerifier(currentPolicy),
    consumedReplayVerifier:
      createConsumedCollaborationGrantReplayVerifier(currentPolicy),
  });
}

function taskDiffConsumedCollaborationGrantReplayVerifier(
  cwd: string,
  grantId: string,
) {
  const repository = discoverRepository(cwd);
  const inspection = readCollaborationGrantInspection(
    repository.gitCommonDirectory,
    grantId,
  );
  if (inspection?.state !== 'consumed' || inspection.use === undefined) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_RECONCILIATION_GRANT_NOT_CONSUMED',
      'External TaskDiffReview reconciliation currently requires the exact Grant to have reached its durable consumed state.',
      ExitCode.guard,
    );
  }
  const historicalPolicy = maintainerPolicyAtCommit(
    repository.repositoryRoot,
    inspection.use.envelope.payload.baselineCommit,
  );
  return createConsumedCollaborationGrantReplayVerifier(historicalPolicy);
}

function printFailure(
  error: WorkflowError,
  json: boolean,
  invocation: readonly string[],
): void {
  const result = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
      recovery: workflowFailureRecoveryCommand(error, invocation),
    },
  };

  const rendered = json
    ? JSON.stringify(result)
    : JSON.stringify(result, null, 2);
  process.stderr.write(`${rendered}\n`);
}

/** Production CLI seam: only a current prepared strategy invocation dispatches. */
export function dispatchPreparedTaskStrategyProvider(
  cwd: string,
  result: Pick<TaskStrategyLifecycleStatus, 'state' | 'invocationId'>,
  dispatcher: typeof dispatchProviderWorker = dispatchProviderWorker,
) {
  if (result.state !== 'waiting-for-provider' || result.invocationId === null) {
    return null;
  }
  const runtime = loadInvestigationRuntimeContext(cwd).runtime;
  const invocation = readProviderInvocation(runtime, result.invocationId);
  return invocation.state === 'prepared'
    ? dispatcher(cwd, invocation.invocationId)
    : null;
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const argv = process.argv.slice(2);
  if (isHumanGrantCliInvocation(argv)) {
    void runHumanGrantCli(argv).then((exitCode) => {
      process.exitCode = exitCode;
    });
  } else {
    void runCliAsync(argv).then((exitCode) => {
      process.exitCode = exitCode;
    });
  }
}
