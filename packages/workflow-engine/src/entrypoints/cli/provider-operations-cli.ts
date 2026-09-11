/**
 * Routes execution job inspection, retries and evidence retention commands.
 *
 * Invariants:
 * - Explained retries remain owned by their planning lifecycle.
 * - Budget exceptions use the existing granted replacement service.
 */
import fs from 'node:fs';
import path from 'node:path';
import { type CommandResult, usage } from './cli-input.ts';
import type { WorkflowError } from '../../foundation/errors/errors.ts';
import { dispatchProviderWorker } from '../worker/provider-worker.ts';
import {
  listExecutionJobs,
  inspectExecutionJob,
  pruneProviderRuntime,
  pumpProviderRetrySchedules,
  listProviderAutomaticRetrySchedules,
  listProviderRetryScheduleReceipts,
  requestExecutionReplacement,
  executeGrantedReplacement,
  productionConsumedPlanReviewReplayPort,
  previewExecutionJobRetry,
  requestExecutionJobRetry,
  inspectEvidenceRetention,
  runEvidenceRetentionMaintenance,
  pinWorkflowEvidence,
} from '../../composition-root/cli-operational-services.ts';

function executionJobUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow job <list|status <job-id>|watch <job-id>|prune --limit <count>|retry-pump --limit <count>|retry-schedules|retry-receipts [schedule-id]|retry-request <job-id> --input <retry.json>|retry-request <job-id> --timeout <milliseconds>|retry <job-id> --grant <grant-id>|retry-preview <job-id> [--timeout <milliseconds>]> [--json]',
  );
}
function retentionUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow retention <inspect|sweep --limit <count>|pin <workflow-id> <evidence-id> --reason <text>> [--json]',
  );
}
export function dispatchExecutionJobCommand(
  rest: string[],
  cwd: string,
): CommandResult {
  const command = 'job';
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
  if (
    rest[0] === 'retry-request' &&
    rest.length === 4 &&
    rest[2] === '--input'
  ) {
    let input: unknown;
    try {
      input = JSON.parse(fs.readFileSync(path.resolve(cwd, rest[3]!), 'utf8'));
    } catch {
      throw usage(
        'Retry input must be a readable JSON file from retry-preview.',
      );
    }
    return {
      command,
      action: 'retry-request',
      ok: true,
      result: requestExecutionJobRetry(cwd, rest[1]!, input, {
        collaborationGrantValidation: {
          consumedRoleResultReplay: productionConsumedPlanReviewReplayPort,
          consumedPlanReviewReplay: productionConsumedPlanReviewReplayPort,
        },
        providerDispatcher:
          process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH === '1'
            ? undefined
            : dispatchProviderWorker,
      }),
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
    (rest.length === 2 || (rest.length === 4 && rest[2] === '--timeout'))
  ) {
    const timeoutMs = rest.length === 4 ? Number(rest[3]) : undefined;
    return {
      command,
      action: 'retry-preview',
      ok: true,
      result: previewExecutionJobRetry(cwd, rest[1]!, {
        timeoutMs,
        collaborationGrantValidation: {
          consumedRoleResultReplay: productionConsumedPlanReviewReplayPort,
          consumedPlanReviewReplay: productionConsumedPlanReviewReplayPort,
        },
      }),
    };
  }
  throw executionJobUsage();
}
export function dispatchRetentionCommand(
  rest: string[],
  cwd: string,
): CommandResult {
  const command = 'retention';
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
