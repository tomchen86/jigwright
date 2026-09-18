/**
 * Reads complete repository and stored-session context, admits active sessions
 * and runs operations under the session lock.
 *
 * Invariants:
 * - The raw reader performs no active-state admission.
 * - Session operations retain their runtime identity checks and session lock.
 */
import path from 'node:path';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import { discoverRepository } from '../repository-transaction/git.ts';
import {
  readSessionFile,
  runtimePaths,
  withSessionOperation,
} from '../session-workspace/session-store.ts';
import { loadWorkflowConfig } from './workflow-configuration.ts';

export function readWorkflowSessionContext(
  cwd: string,
  requestedSessionId: string,
) {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  const sessionId = assertSessionId(requestedSessionId);
  const session = readSessionFile(
    path.join(runtime.sessions, `${sessionId}.json`),
  );
  return { git, config, runtime, session };
}

export function loadActiveSessionContext(
  cwd: string,
  requestedSessionId: string,
) {
  const context = readWorkflowSessionContext(cwd, requestedSessionId);
  const { session } = context;
  const sessionId = requestedSessionId;
  if (session.state !== 'active') {
    throw workflowError(
      'SESSION_NOT_ACTIVE',
      `Session ${sessionId} is ${session.state}.`,
      ExitCode.staleState,
    );
  }
  return context;
}

export function runSessionOperation<T>(
  cwd: string,
  requestedSessionId: string,
  operation: () => T,
): T {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = runtimePaths(git.gitCommonDirectory, config.runtimeDirectory);
  return withSessionOperation(
    runtime,
    assertSessionId(requestedSessionId),
    operation,
  );
}
