#!/usr/bin/env node

import { dispatchBoundaryCommand } from './entrypoints/cli/boundary-cli.ts';
import { renderHumanCommandResult } from './entrypoints/cli/human-command-output.ts';
import {
  dispatchExecutionJobCommand,
  dispatchRetentionCommand,
} from './entrypoints/cli/provider-operations-cli.ts';
import { dispatchCiCommand } from './entrypoints/cli/ci-cli.ts';
import fs from 'node:fs';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { dispatchAiAdapterCommand } from './entrypoints/cli/ai-adapter-cli.ts';
import { dispatchAgentProviderCommand } from './entrypoints/cli/agent-provider-cli.ts';
import { dispatchAgentGuidanceCommand } from './entrypoints/cli/agent-guidance-cli.ts';
import { inspectProjectionStatus } from './composition-root/projection-status-production.ts';
import { dispatchCentralRoleProviderDefaultCommand } from './entrypoints/cli/central-role-provider-default-cli.ts';

import { inspectChangeAssurance } from './runtime/repository-transaction/assurance-inspection.ts';
import { loadWorkflowConfig } from './adapters/consumer/repository/work-registry/contracts.ts';
import {
  generateOpenSpecPlanningAssets,
  checkOpenSpecPlanningAssets,
  installOpenSpecPlanningPrompts,
} from './adapters/planning/openspec/documents/openspec-planning-assets.ts';

import { dispatchDocumentRefreshCommand } from './entrypoints/cli/document-refresh-cli.ts';
import { systemDocumentDispositions } from './composition-root/lifecycle-context.ts';
import { createSystemDocumentFailGrantResult } from './entrypoints/cli/system-document-fail-grant-cli.ts';
import { collectEngineMetrics } from './application/control-plane/engine-metrics.ts';
import {
  WorkflowError,
  workflowError,
  ExitCode,
} from './foundation/errors/errors.ts';

import {
  type ExecutionJobInspection,
  watchExecutionJob,
} from './runtime/provider-execution/execution-runtime.ts';

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

import {
  inspectImplementationReconciliation,
  recordImplementationReconciliation,
} from './modules/why-knowledge/implementation-reconciliation.ts';
import { listSessions } from './application/execute-task/session.ts';
import { validateManagedDocuments } from './runtime/managed-documents/validation/managed-documents.ts';
import {
  renderSystemDocuments,
  testSystemDocuments,
  inspectRepositorySystemDocuments,
} from './runtime/managed-documents/validation/system-documents.ts';
import { readSystemDescriptionSnapshot } from './runtime/repository-transaction/system-description-snapshot.ts';
import { systemSpecPaths } from './modules/source/system-documents.ts';
import { diagnoseOpenSpec } from './adapters/planning/openspec/documents/openspec-doctor.ts';
import { startPropose } from './application/propose/propose-orchestrator.ts';
import { productionRoleTopologyResolutionPort } from './composition-root/role-topology-resolution-production.ts';
import {
  runProviderWorkerAsync,
  dispatchProviderWorker,
} from './entrypoints/worker/provider-worker.ts';

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
import { createHarnessBootstrapDependencies } from './harness-bootstrap.ts';

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

export function runCli(argv: string[], cwd = process.cwd()): number {
  const json = hasTerminalJsonOutputFlag(argv);
  const args = json ? argv.slice(0, -1) : [...argv];

  try {
    const result = dispatch(args, cwd);
    printSuccess(
      { ...result, nextSteps: workflowResultNextSteps(result, args) },
      json,
    );
    return result.command === 'doctor' && result.ok === false
      ? ExitCode.verification
      : 0;
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
      { ...result, nextSteps: workflowResultNextSteps(result, args) },
      json,
    );
    return result.command === 'doctor' && result.ok === false
      ? ExitCode.verification
      : 0;
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
  if (command === 'documents' && rest[0] === 'test') {
    if (!(rest.length === 1 || (rest.length === 3 && rest[1] === '--spec')))
      throw usage(
        'Usage: pnpm workflow documents test [--spec <path>] [--json]',
      );
    return {
      command,
      ok: true,
      ...(await testSystemDocuments(
        discoverRepository(cwd).repositoryRoot,
        rest[2],
      )),
    };
  }
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
      const systemDocumentGrant = await createSystemDocumentFailGrantResult(
        args,
        cwd,
        error,
      );
      if (systemDocumentGrant !== null) return systemDocumentGrant;
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

function doctor(cwd: string): CommandResult {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const openspec = diagnoseOpenSpec(git.repositoryRoot);
  const warnings: Array<{ code: string; message: string }> = [];
  const snapshot = readSystemDescriptionSnapshot(git.repositoryRoot);
  const colocatedSpecs = systemSpecPaths(snapshot.listPaths());
  let systemDocuments: {
    configured: boolean;
    healthy: boolean;
    specCount: number;
    diagnostics: readonly { code: string; message: string }[];
  } = {
    configured: colocatedSpecs.length > 0,
    healthy: true,
    specCount: colocatedSpecs.length,
    diagnostics: [],
  };
  if (colocatedSpecs.length > 0) {
    try {
      const { report } = inspectRepositorySystemDocuments(
        git.repositoryRoot,
        snapshot,
        false,
      );
      const diagnostics = report.issues.filter(
        (issue) => issue.code !== 'test-not-passed',
      );
      systemDocuments = {
        ...systemDocuments,
        healthy: diagnostics.length === 0,
        diagnostics,
      };
    } catch (error) {
      systemDocuments = {
        ...systemDocuments,
        healthy: false,
        diagnostics: [
          { code: 'SYSTEM_DOCUMENTS_INVALID', message: String(error) },
        ],
      };
    }
  }

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
  if (
    colocatedSpecs.length === 0 &&
    !fs.existsSync(path.join(git.repositoryRoot, baseSpecRoot))
  ) {
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
    ok: openspec.healthy && systemDocuments.healthy,
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
    systemDocuments,
    projections: inspectProjectionStatus(git.repositoryRoot),
    retainedSpectraUsed: false,
    activeSessionCount: listSessions(cwd).filter(
      (session) => session.state === 'active' || session.state === 'revising',
    ).length,
    warnings,
  };
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
  write(renderHumanCommandResult(result));
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
    : renderHumanCommandResult(result).replace(/\n$/u, '');
  process.stderr.write(`${rendered}\n`);
}

function dispatch(args: string[], cwd: string): CommandResult {
  const [command, ...rest] = args;
  switch (command) {
    case 'boundary':
      return dispatchBoundaryCommand(rest, cwd);
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
    case 'task-preflight':
    case 'open-task':
    case 'update-base':
    case 'amend-plan':
    case 'propose':
    case 'revise-task':
    case 'resume-task':
    case 'resume':
    case 'status':
    case 'check':
    case 'complete-task':
    case 'finish':
    case 'finalize':
    case 'finalize-recover':
    case 'review-diff':
    case 'rollback-completion':
    case 'commit':
    case 'abort':
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

    case 'archive':
    case 'archive-candidates':
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
    case 'external-effect':
    case 'publish':
    case 'intervention':
    case 'control-plane':
    case 'audit':
    case 'change':
    case 'engine':
    case 'task':
    case 'authority-plan':
    case 'maintainer':
    case 'human-resolution-state':
      return dispatchAuthorityCommand(
        args,
        cwd,
        createHarnessBootstrapDependencies,
      );

    case 'job':
      return dispatchExecutionJobCommand(rest, cwd);
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
    case 'retention':
      return dispatchRetentionCommand(rest, cwd);

    case 'run-check':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: runRegisteredCheck(cwd, rest[0], process.env),
      };
    case 'ci':
      return dispatchCiCommand(rest, cwd);

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
    case 'correct':
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

    case 'documents':
      if (rest[0] === 'review') {
        if (!(
          rest.length === 2 ||
          (rest.length === 4 && rest[2] === '--input')
        ))
          throw usage(
            'Usage: pnpm workflow documents review <session-id> [--input <review.json>] [--json]',
          );
        return {
          command,
          ok: true,
          result:
            rest.length === 2
              ? systemDocumentDispositions.inspectSystemDocumentDispositions(
                  cwd,
                  rest[1]!,
                )
              : systemDocumentDispositions.recordSystemDocumentDispositions(
                  cwd,
                  rest[1]!,
                  JSON.parse(
                    fs.readFileSync(path.resolve(cwd, rest[3]!), 'utf8'),
                  ),
                ),
        };
      }
      if (rest.length === 1 && rest[0] === 'render')
        return {
          command,
          ok: true,
          projected: renderSystemDocuments(
            discoverRepository(cwd).repositoryRoot,
          ),
        };
      if (rest.length !== 1 || rest[0] !== 'validate') {
        throw usage(
          'Usage: pnpm workflow documents <validate|render|test [--spec <path>]|review <session-id> [--input <review.json>]> [--json]',
        );
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
