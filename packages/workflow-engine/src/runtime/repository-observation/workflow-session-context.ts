/** Reads complete repository and stored-session context without active-state admission. */
import path from 'node:path';

import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import { discoverRepository } from '../repository-transaction/git.ts';
import {
  readSessionFile,
  runtimePaths,
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
