/** Persist an inspected session only while its stored predecessor is unchanged. */
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import type { WorkflowSession } from '../../modules/lifecycle/workflow-session-contract.ts';
import {
  readSessionFile,
  runtimePaths,
  writeJsonAtomic,
} from './workflow-session-records.ts';
export function persistSession(
  inspection: SessionInspection,
  session: WorkflowSession,
): void {
  const runtime = runtimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const sessionPath = path.join(runtime.sessions, `${session.sessionId}.json`);
  const current = readSessionFile(sessionPath);
  if (JSON.stringify(current) !== JSON.stringify(inspection.session)) {
    throw workflowError(
      'SESSION_CHANGED_DURING_TRANSITION',
      'The session changed before its transition could be persisted.',
      ExitCode.staleState,
    );
  }
  writeJsonAtomic(sessionPath, session);
}
