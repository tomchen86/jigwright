/** Bind session-abort Grant recovery preflight to the repository's durable records. */
import { abortSession as abort } from '../application/execute-task/session.ts';
import {
  createFileGrantRecordStore,
  grantStorePaths,
} from '../runtime/storage-journal/grant-store.ts';

export const abortSession = abort.bind(null, (runtimeRoot) =>
  createFileGrantRecordStore(grantStorePaths(runtimeRoot)),
);
