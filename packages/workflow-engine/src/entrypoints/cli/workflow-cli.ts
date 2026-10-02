#!/usr/bin/env node
import { diagnoseWorkflowRepository } from '../../composition-root/workflow-doctor-production.ts';
import {
  currentGovernanceIntakeCounts,
  createGovernanceIntakeCommandDependencies,
} from '../../composition-root/governance-intake-command-production.ts';
import type { WorkflowGrantServices } from '../../composition-root/grant-production.ts';
import type { ProductionFinalizationService } from '../../composition-root/finalization-production.ts';
import type { ProductionSessionCheck } from '../../composition-root/session-check-production.ts';
import type { ArchivePullRequestCliDependencies } from '../../composition-root/archive-cli-production.ts';
import { dispatchArchivePullRequest as dispatchArchivePullRequestWithDependencies } from './archive-cli.ts';
import { createTaskLifecycleCommands } from './task-lifecycle-cli.ts';
import { createFailGrantCli } from './fail-grant-cli.ts';
import { createSystemDocumentFailGrantCli } from './system-document-fail-grant-cli.ts';
import { handoffDocuments } from '../../composition-root/handoff-production.ts';
const { validateHandoff } = handoffDocuments;
/**
 * Dispatches workflow commands and renders synchronous or asynchronous CLI
 * results.
 *
 * Invariants:
 * - Reported failures return their workflow exit code.
 */

import { boundaryCommandOperations } from '../../composition-root/boundary-cli-production.ts';
import { createBoundaryCommand } from './boundary-cli.ts';
import { renderHumanCommandResult } from './human-command-output.ts';
import {
  providerOperationsServices,
  collectEngineMetrics,
} from '../../composition-root/provider-operations-cli-production.ts';
import { createProviderOperationsCommands } from './provider-operations-cli.ts';
import { dispatchCiCommand } from './ci-cli.ts';
import fs from 'node:fs';

import path from 'node:path';

import { dispatchAiAdapterCommand } from './ai-adapter-cli.ts';
import { dispatchAgentProviderCommand } from './agent-provider-cli.ts';
import { dispatchAgentGuidanceCommand } from './agent-guidance-cli.ts';
import { dispatchCentralRoleProviderDefaultCommand } from './central-role-provider-default-cli.ts';

import { inspectChangeAssurance } from '../../runtime/repository-validation/assurance-inspection.ts';
import {
  checkOpenSpecPlanningAssets,
  installOpenSpecPlanningPrompts,
} from '../../adapters/planning/openspec/documents/openspec-planning-assets.ts';
import { generateOpenSpecPlanningAssets } from '../../composition-root/planning-provider-authoring-production.ts';

import { dispatchDocumentRefreshCommand } from './document-refresh-cli.ts';
import { systemDocumentDispositions } from '../../composition-root/system-document-disposition-production.ts';

import {
  WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';

import {
  type ExecutionJobInspection,
  watchExecutionJob,
} from '../../runtime/provider-execution/execution-runtime.ts';

import {
  discoverRepository,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { runRepositoryHook } from '../../composition-root/repository-hooks-production.ts';

import { dispatchGovernanceIntakeCommand } from './governance-intake-cli.ts';
import { dispatchChangeRoutingCommand } from './change-routing-cli.ts';

import {
  inspectImplementationReconciliation,
  recordImplementationReconciliation,
} from '../../composition-root/implementation-reconciliation-production.ts';
import { validateManagedDocuments } from '../../composition-root/managed-documents-production.ts';
import {
  renderSystemDocuments,
  testSystemDocuments,
} from '../../runtime/managed-documents/validation/system-documents.ts';
import { runProviderWorkerAsync } from '../worker/provider-worker.ts';
import { dispatchProviderWorker } from '../../composition-root/provider-worker-dispatch-production.ts';

import { runRegisteredCheck } from '../../composition-root/check-execution-production.ts';
import { loadStableValidatedChangeContract } from '../../composition-root/validated-contract-context.ts';
import {
  workflowResultNextSteps,
  workflowFailureRecoveryCommand,
  WORKFLOW_GUIDANCE_CATALOG,
} from '../../modules/guidance/next-steps/workflow-guidance.ts';
import {
  hasTerminalJsonOutputFlag,
  type CommandResult,
  requireArgumentCount,
  usage,
  usageText,
} from './cli-input.ts';
import { type ChangeRoutingGrantRequest } from './fail-grant-cli.ts';
import { dispatchArchiveCommand } from './archive-cli.ts';
import type { createAuthorityCommands } from './authority-management-cli.ts';
import type { HarnessBootstrapProduction } from '../../composition-root/harness-bootstrap-production.ts';
export { createArchivePullRequestCliDispatcherForTesting } from './archive-cli.ts';
export { dispatchPreparedTaskStrategyProvider } from './task-lifecycle-cli.ts';

type RunCliAsyncDependencies = Readonly<{
  watchJob?: (
    cwd: string,
    jobId: string,
  ) => AsyncIterable<ExecutionJobInspection>;
  writeStdout?: (chunk: string) => void;
}>;

const dispatchBoundaryCommand = createBoundaryCommand(
  boundaryCommandOperations,
);
const { dispatchExecutionJobCommand, dispatchRetentionCommand } =
  createProviderOperationsCommands({
    ...providerOperationsServices,
    providerDispatcher: dispatchProviderWorker,
  });

/**
 * Production CLI entry. Provider work and Fail-Grant challenge creation use
 * the async boundary; ordinary commands retain the synchronous dispatcher.
 */

/** Test-only seam proving the hidden command selects the async worker. */

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

export function createWorkflowCli({
  dispatchAuthorityCommand,
  createHarnessBootstrapDependencies,
  workflowGrants,
  sessionLifecycle,
  archiveDependencies,
}: ReturnType<typeof createAuthorityCommands> &
  Pick<HarnessBootstrapProduction, 'createHarnessBootstrapDependencies'> & {
    workflowGrants: WorkflowGrantServices;
    sessionLifecycle: ProductionFinalizationService & {
      checkSession: ProductionSessionCheck;
    };
    archiveDependencies: ArchivePullRequestCliDependencies;
  }) {
  const {
    requestProtectedTaskApplyGrant,
    requestProtectedTaskApplyRecoveryGrant,
    requestProtectedTaskApplyDescendantSettlementGrant,
    requestProviderInvocationCancellationGrant,
    requestChangeRoleAssignmentGrant,
    requestProtectedBaseInitializationGrant,
    requestArchivePullRequestPublicationGrant,
    requestWorkRegistryReviewGrant,
    requestWorkRegistryPromotionGrant,
    requestChangeRoutingContinuationGrant,
    requestInvestigationV3Grant,
    requestInvestigationV3PublicationGrant,
  } = workflowGrants;
  const failGrantCli = createFailGrantCli(workflowGrants);
  const {
    createProtectedTaskApplyDescendantSettlementFailGrantResult,
    createProtectedTaskApplyFailGrantResult,
    createProtectedTaskApplyRecoveryFailGrantResult,
    createChangeRoutingFailGrantResult,
    createRoleAssignmentFailGrantResult,
    createProposeProtectedBaseFailGrantResult,
    createWorkRegistryFailGrantResult,
  } = failGrantCli;
  const { createSystemDocumentFailGrantResult } =
    createSystemDocumentFailGrantCli(
      workflowGrants.createProductionCentralGrantRequestPort,
    );
  const { dispatchTaskLifecycleCommand } =
    createTaskLifecycleCommands(sessionLifecycle);
  const dispatchArchivePullRequest = (args: string[], cwd: string) =>
    dispatchArchivePullRequestWithDependencies(args, cwd, archiveDependencies);
  function runCli(argv: string[], cwd = process.cwd()): number {
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

  async function runCliAsync(
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

  async function dispatchAsync(
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

  function createAsyncCliDispatcherForTesting(
    providerWorker: typeof runProviderWorkerAsync,
    roleAssignmentGrantRequest: typeof requestChangeRoleAssignmentGrant = requestChangeRoleAssignmentGrant,
  ): (args: string[], cwd: string) => Promise<CommandResult> {
    return (args, cwd) =>
      dispatchAsync(args, cwd, providerWorker, roleAssignmentGrantRequest);
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
        return { command, ...diagnoseWorkflowRepository(cwd) };
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
        const intakeDependencies = createGovernanceIntakeCommandDependencies();
        return {
          command,
          ok: true,
          result: dispatchGovernanceIntakeCommand(
            command,
            rest,
            discoverRepository(cwd).repositoryRoot,
            intakeDependencies,
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
  return {
    ...failGrantCli,
    createSystemDocumentFailGrantResult,
    runCli,
    runCliAsync,
    dispatchAsync,
    createAsyncCliDispatcherForTesting,
  };
}
