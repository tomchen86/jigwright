/**
 * Parses and dispatches task planning, execution, status, and review
 * commands.
 *
 * Invariants:
 * - Propose options must be recognized, paired, and unique.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  loadWorkflowConfig,
  resolveOpenTaskId,
  openTask,
  contextualizeOpenTaskError,
  findOpenTaskLifecycleStatus,
  discoverRepository,
  inspectGovernanceIntakeCounts,
  inspectFinalizeRecoveryStatus,
  findTaskCommits,
  cancelFinalizeRecovery,
  commitSession,
  getSession,
  preflightTaskSession,
  listSessions,
  abortSession,
  updateTaskSessionBase,
  runtimePaths,
  reviseTask,
  resumeTask,
  inspectTaskRevisionStatus,
  resumeTaskStrategy,
  inspectTaskStrategyLifecycle,
  parseTaskStrategyRedRevisionRequest,
  inspectTaskDiffReviewSubject,
  inspectTaskDiffReviewStatus,
  reconcileTaskDiffReview,
  reconcileExternalTaskDiffReview,
  reconcileTaskDiffReviewContinuation,
  beginTaskDiffReviewContinuationFromInput,
  submitExternalTaskDiffReview,
  loadCurrentAuthenticatedTaskDiffReview,
  submitExternalTaskDiffReviewContinuation,
  beginTaskDiffReview,
  createTaskDiffReviewChallengeResponse,
  commitPlanningTransition,
  commitPlanAmendment,
  resumeProposeFromFile,
  startProposeFromFile,
  getProposeStatus,
  readProviderInvocation,
} from '../../composition-root/cli-command-services.ts';
import type { TaskStrategyLifecycleStatus } from '../../composition-root/cli-command-services.ts';

import {
  WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';

import {
  productionConsumedRoleResultReplayPort,
  productionConsumedPlanReviewReplayPort,
} from '../../composition-root/grant-verifier-composition.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';

import { productionRoleTopologyResolutionPort } from '../../composition-root/role-topology-resolution-production.ts';
import { dispatchProviderWorker } from '../../composition-root/provider-worker-dispatch-production.ts';
import type { ProviderWorkerDispatcher } from '../../composition-root/provider-worker-dispatch-production.ts';

import {
  usage,
  requireArgumentCount,
  optionValue,
  type CommandResult,
  usageText,
} from './cli-input.ts';
import {
  currentCollaborationGrantSelection,
  currentRoleContextSharingGrantSelection,
  taskDiffConsumedCollaborationGrantReplayVerifier,
  taskDiffCollaborationGrantSelection,
} from '../../composition-root/cli-authority-production.ts';
import { parseTaskDiffReviewCliInput } from './task-review-cli-input.ts';

function sessionStatusRepositoryRoot(
  callerRoot: string,
  session: ReturnType<typeof getSession>,
): string {
  return session.state === 'active' || session.state === 'revising'
    ? session.repositoryRoot
    : callerRoot;
}

export function currentGovernanceIntakeCounts(cwd: string) {
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  return inspectGovernanceIntakeCounts(
    repository.repositoryRoot,
    runtimePaths(repository.gitCommonDirectory, config.runtimeDirectory).root,
  );
}

function taskDiffReviewUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow review-diff <session-id> [--actor <provider>] [--grant <grant-id>] [--input <typed-envelope.json> [--grant <grant-id>]] [--json]\n' +
      '       pnpm workflow review-diff <inspect|status|reconcile> <session-id> [--json]',
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

function proposeUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow propose <change-id> --intent <intent.json> [--mandate <mandate-task-id>] [--actor <id>] [--grant <grant-id>] [--json]\n       pnpm workflow propose <change-id> --resume --input <envelope.json> [--grant <grant-id>|--role-context-grant <grant-id>] [--json]',
  );
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

/** Production CLI seam: only a current prepared strategy invocation dispatches. */
export function dispatchPreparedTaskStrategyProvider(
  cwd: string,
  result: Pick<TaskStrategyLifecycleStatus, 'state' | 'invocationId'>,
  dispatcher: ProviderWorkerDispatcher = dispatchProviderWorker,
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

function dispatchProposeCommand(
  command: 'propose',
  rest: string[],
  cwd: string,
): CommandResult {
  {
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
}

function dispatchResumeCommand(
  command: 'resume',
  rest: string[],
  cwd: string,
): CommandResult {
  {
    const sessionId = rest[0];
    const actor = optionValue(rest.slice(1), '--actor');
    const grantId = optionValue(rest.slice(1), '--grant');
    const inputPath = optionValue(rest.slice(1), '--input');
    const validArguments =
      rest.length === 1 ||
      (rest.length === 3 && rest[1] === '--actor' && actor !== undefined) ||
      (rest.length === 3 && rest[1] === '--grant' && grantId !== undefined) ||
      (rest.length === 3 && rest[1] === '--input' && inputPath !== undefined) ||
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
}

function dispatchStatusCommand(
  command: 'status',
  rest: string[],
  cwd: string,
): CommandResult {
  {
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
        taskRevision: inspectTaskRevisionStatus(statusRoot, session.sessionId),
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
}

function dispatchReviewDiffCommand(
  command: 'review-diff',
  rest: string[],
  cwd: string,
): CommandResult {
  {
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
          error.code !== 'TASK_DIFF_REVIEW_SUPERSESSION_RECONCILIATION_REQUIRED'
        ) {
          throw error;
        }
        return {
          command,
          ok: true,
          result: reconcileTaskDiffReview(cwd, rest[1], {
            collaborationGrantValidation: {
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
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
          ? taskDiffCollaborationGrantSelection(cwd, status.assignment.grantId)
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
      (rest.length === 3 && rest[1] === '--input' && inputPath !== undefined) ||
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
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
            },
          );
        } else if (parsedInput.route === 'external-initial') {
          status = submitExternalTaskDiffReview(
            cwd,
            sessionId,
            parsedInput.input,
            {
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
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
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
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
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
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
        const invocation = readProviderInvocation(runtime, status.invocationId);
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
}

import type {
  ProductionFinalizationService,
  ProductionSessionCheck,
} from '../../composition-root/cli-command-services.ts';
export function createTaskLifecycleCommands({
  completeTask,
  finishSession,
  finalizeSession,
  recoverFinalize,
  rollbackCompletion,
  checkSession,
}: ProductionFinalizationService & { checkSession: ProductionSessionCheck }) {
  function dispatchTaskLifecycleCommand(
    args: string[],
    cwd: string,
  ): CommandResult {
    const [command, ...rest] = args;
    switch (command) {
      case 'plan-commit':
        requireArgumentCount(command, rest, 1, 1);
        return {
          command,
          ok: true,
          result: commitPlanningTransition(cwd, rest[0]),
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
          throw contextualizeOpenTaskError(
            cwd,
            changeId,
            resolvedTaskId,
            error,
          );
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
      case 'propose':
        return dispatchProposeCommand(command, rest, cwd);

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
      case 'resume':
        return dispatchResumeCommand(command, rest, cwd);

      case 'status':
        return dispatchStatusCommand(command, rest, cwd);

      case 'check':
        requireArgumentCount(command, rest, 1, 1);
        return { command, ok: true, result: checkSession(cwd, rest[0]) };
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
          result: cancelFinalizeRecovery(
            cwd,
            sessionId,
            transactionId,
            reason,
            {
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
            },
          ),
        };
      }
      case 'review-diff':
        return dispatchReviewDiffCommand(command, rest, cwd);

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
      default:
        throw usage(
          command ? `Unknown workflow command: ${command}` : usageText(),
        );
    }
  }
  return { dispatchTaskLifecycleCommand };
}
