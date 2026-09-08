#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadWorkflowConformanceVectorsV2 } from '@jigwright/core/conformance-vectors';
import { dispatchAiAdapterCommand } from './entrypoints/cli/ai-adapter-cli.ts';
import { dispatchAgentProviderCommand } from './entrypoints/cli/agent-provider-cli.ts';
import { dispatchAgentGuidanceCommand } from './entrypoints/cli/agent-guidance-cli.ts';
import { inspectProjectionStatus } from './composition-root/projection-status-production.ts';
import { dispatchCentralRoleProviderDefaultCommand } from './entrypoints/cli/central-role-provider-default-cli.ts';
import {
  type AuthorityRemapPair,
  projectAuthorityRemap,
} from './composition-root/authority-remap.ts';
import { inspectChangeAssurance } from './runtime/repository-transaction/assurance-inspection.ts';
import { loadWorkflowConfig } from './adapters/consumer/repository/work-registry/contracts.ts';
import {
  generateOpenSpecPlanningAssets,
  checkOpenSpecPlanningAssets,
  installOpenSpecPlanningPrompts,
} from './adapters/planning/openspec/documents/openspec-planning-assets.ts';
import {
  preparePullRequestPreMergeAssurance,
  completePreparedPullRequestPreMergeAssurance,
} from './entrypoints/ci/pre-merge-assurance-git.ts';
import type { IntegrationDeltaReviewSubmission } from './modules/assurance/pre-merge-assurance.ts';
import { inspectT3BoundaryInventory } from './modules/assurance/t3-boundary-inventory.ts';
import type { T3BoundaryTypeScriptApi } from './modules/assurance/t3-boundary-scanner.ts';
import { dispatchDocumentRefreshCommand } from './entrypoints/cli/document-refresh-cli.ts';
import { collectEngineMetrics } from './application/control-plane/engine-metrics.ts';
import {
  WorkflowError,
  workflowError,
  ExitCode,
} from './foundation/errors/errors.ts';
import {
  requestExecutionReplacement,
  executeGrantedReplacement,
} from './application/control-plane/execution-replacement.ts';
import {
  type ExecutionJobInspection,
  watchExecutionJob,
  listExecutionJobs,
  inspectExecutionJob,
  prepareProviderReplacement,
} from './runtime/provider-execution/execution-runtime.ts';
import { pruneProviderRuntime } from './runtime/provider-execution/provider-retention.ts';
import {
  inspectEvidenceRetention,
  runEvidenceRetentionMaintenance,
  pinWorkflowEvidence,
} from './runtime/provider-execution/retention-control.ts';
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
  requestChangeRoutingContinuationGrant,
  requestProtectedTaskApplyGrant,
  requestProtectedTaskApplyRecoveryGrant,
  requestProtectedTaskApplyDescendantSettlementGrant,
} from './composition-root/grant-production.ts';
import { dispatchGovernanceIntakeCommand } from './entrypoints/cli/governance-intake-cli.ts';
import { dispatchChangeRoutingCommand } from './entrypoints/cli/change-routing-cli.ts';
import { productionConsumedPlanReviewReplayPort } from './composition-root/grant-verifier-composition.ts';
import {
  inspectImplementationReconciliation,
  recordImplementationReconciliation,
} from './modules/why-knowledge/implementation-reconciliation.ts';
import { listSessions } from './application/execute-task/session.ts';
import { validateManagedDocuments } from './runtime/managed-documents/validation/managed-documents.ts';
import { diagnoseOpenSpec } from './adapters/planning/openspec/documents/openspec-doctor.ts';
import { startPropose } from './application/propose/propose-orchestrator.ts';
import { productionRoleTopologyResolutionPort } from './composition-root/role-topology-resolution-production.ts';
import {
  runProviderWorkerAsync,
  dispatchProviderWorker,
} from './entrypoints/worker/provider-worker.ts';
import {
  pumpProviderRetrySchedules,
  listProviderAutomaticRetrySchedules,
  listProviderRetryScheduleReceipts,
} from './runtime/provider-execution/provider-retry-scheduler.ts';
import { runRegisteredCheck } from './adapters/consumer/repository/work-registry/registered-check.ts';
import { loadStableValidatedChangeContract } from './composition-root/validated-contract-context.ts';
import {
  workflowResultNextSteps,
  workflowFailureRecoveryCommand,
  WORKFLOW_GUIDANCE_CATALOG,
} from './modules/guidance/next-steps/workflow-guidance.ts';
import {
  hasTerminalJsonOutputFlag,
  type CommandResult,
  requireArgumentCount,
  usage,
  optionValue,
  usageText,
} from './entrypoints/cli/cli-input.ts';
import {
  type ChangeRoutingGrantRequest,
  createProposeProtectedBaseFailGrantResult,
  createRoleAssignmentFailGrantResult,
  createProtectedTaskApplyFailGrantResult,
  createProtectedTaskApplyDescendantSettlementFailGrantResult,
  createProtectedTaskApplyRecoveryFailGrantResult,
  createWorkRegistryFailGrantResult,
  createChangeRoutingFailGrantResult,
} from './entrypoints/cli/fail-grant-cli.ts';
import {
  dispatchArchivePullRequest,
  dispatchArchiveCommand,
} from './entrypoints/cli/archive-cli.ts';
import {
  currentGovernanceIntakeCounts,
  dispatchTaskLifecycleCommand,
} from './entrypoints/cli/task-lifecycle-cli.ts';
import { dispatchAuthorityCommand } from './entrypoints/cli/authority-management-cli.ts';

export {
  createProtectedTaskApplyDescendantSettlementFailGrantResult,
  createProtectedTaskApplyFailGrantResult,
  createProtectedTaskApplyRecoveryFailGrantResult,
  createChangeRoutingFailGrantResult,
  createRoleAssignmentFailGrantResult,
  createProposeProtectedBaseFailGrantResult,
  createWorkRegistryFailGrantResult,
} from './entrypoints/cli/fail-grant-cli.ts';
export { createArchivePullRequestCliDispatcherForTesting } from './entrypoints/cli/archive-cli.ts';
export { dispatchPreparedTaskStrategyProvider } from './entrypoints/cli/task-lifecycle-cli.ts';

type RunCliAsyncDependencies = Readonly<{
  watchJob?: (
    cwd: string,
    jobId: string,
  ) => AsyncIterable<ExecutionJobInspection>;
  writeStdout?: (chunk: string) => void;
}>;

const toolingRequire = createRequire(import.meta.url);

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

/** Test-only seam proving the hidden command selects the async worker. */
export function createAsyncCliDispatcherForTesting(
  providerWorker: typeof runProviderWorkerAsync,
  roleAssignmentGrantRequest: typeof requestChangeRoleAssignmentGrant = requestChangeRoleAssignmentGrant,
): (args: string[], cwd: string) => Promise<CommandResult> {
  return (args, cwd) =>
    dispatchAsync(args, cwd, providerWorker, roleAssignmentGrantRequest);
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
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'route':
      return {
        command,
        ok: true,
        result: dispatchChangeRoutingCommand(
          rest,
          discoverRepository(cwd).repositoryRoot,
        ),
      };
    case 'task-preflight':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'open-task':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'update-base':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'amend-plan':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'propose':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'archive':
      return dispatchArchiveCommand(args, cwd);
    case 'archive-candidates':
      return dispatchArchiveCommand(args, cwd);
    case 'after-merge':
      return dispatchArchiveCommand(args, cwd);
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
    case 'grant':
      return dispatchAuthorityCommand(args, cwd);
    case 'external-effect':
      return dispatchAuthorityCommand(args, cwd);
    case 'publish':
      return dispatchAuthorityCommand(args, cwd);
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
      return dispatchAuthorityCommand(args, cwd);
    case 'control-plane':
      return dispatchAuthorityCommand(args, cwd);
    case 'audit':
      return dispatchAuthorityCommand(args, cwd);
    case 'change':
      return dispatchAuthorityCommand(args, cwd);
    case 'engine':
      return dispatchAuthorityCommand(args, cwd);
    case 'task':
      return dispatchAuthorityCommand(args, cwd);
    case 'revise-task':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'resume-task':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'resume':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'status':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'check':
      return dispatchTaskLifecycleCommand(args, cwd);
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
    case 'authority-plan':
      return dispatchAuthorityCommand(args, cwd);
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
    case 'maintainer':
      return dispatchAuthorityCommand(args, cwd);
    case 'human-resolution-state':
      return dispatchAuthorityCommand(args, cwd);
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
    case 'complete-task':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'finish':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'finalize':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'finalize-recover':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'review-diff':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'rollback-completion':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'commit':
      return dispatchTaskLifecycleCommand(args, cwd);
    case 'abort':
      return dispatchTaskLifecycleCommand(args, cwd);
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
