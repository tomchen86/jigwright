/** Presents document remediation and the existing Human Gate for an exact skip exception. */
import type { CentralGrantRequestPortV1 } from '@jigwright/core/central-grant-port';
import { createProductionCentralGrantRequestPort } from '../../composition-root/grant-production.ts';
import { createSystemDocumentGrantRequest } from '../../application/finalize/system-document-grant.ts';
import { SYSTEM_DOCUMENT_DISPOSITION_REQUIRED } from '../../application/finalize/system-document-dispositions.ts';
import {
  WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';
import {
  plainRecord,
  shellCommandArgument,
  type CommandResult,
} from './cli-input.ts';

export async function createSystemDocumentFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestPort?: CentralGrantRequestPortV1,
): Promise<CommandResult | null> {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== SYSTEM_DOCUMENT_DISPOSITION_REQUIRED ||
    !['finalize', 'complete-task', 'finish'].includes(args[0] ?? '') ||
    !plainRecord(error.details) ||
    typeof error.details.sessionId !== 'string' ||
    args[1] !== error.details.sessionId
  )
    return null;
  const sessionId = error.details.sessionId;
  const request = createSystemDocumentGrantRequest(cwd, sessionId);
  if (request.stateBinding.digest !== error.details.candidateDigest)
    throw workflowError(
      'SYSTEM_DOCUMENT_REVIEW_STALE',
      'The candidate changed after document review was requested; retry the original command to inspect its current obligations.',
      ExitCode.staleState,
    );
  const grant = await (
    requestPort ?? createProductionCentralGrantRequestPort(cwd)
  ).requestGrant(request);
  return {
    command: args[0],
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
        details: error.details,
      },
      grant,
      transitionAppliesOnDecision: false,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        reviewCommand: `pnpm workflow documents review ${sessionId} --json`,
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        recoveryCommand: `pnpm workflow grant human recover ${grant.challengeId} --json`,
        retryAfterDecision: `pnpm workflow ${args.map(shellCommandArgument).join(' ')} --json`,
      },
    },
  };
}
