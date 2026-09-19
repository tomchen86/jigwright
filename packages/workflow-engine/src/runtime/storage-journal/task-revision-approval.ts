/** Owns private approval records and their exact content-addressed publication. */
import fs from 'node:fs';
import path from 'node:path';
import { defaultSessionRuntimeLayoutPort } from '@jigwright/core/session-runtime-layout-port';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  approvalInvalid,
  type TaskRevisionApprovalRecords,
} from '../../modules/authority/task-revision-approval-contracts.ts';
import { loadWorkflowConfig } from '../workflow-configuration/workflow-configuration.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';
import {
  readContentRecord,
  writeContentRecord,
} from './content-record-store.ts';

export const taskRevisionApprovalRecords: TaskRevisionApprovalRecords = {
  read(repository, approvalId) {
    const directory = approvalDirectory(
      repository.gitCommonDirectory,
      repository.repositoryRoot,
    );
    const recordPath = path.join(directory, `${approvalId}.json`);
    try {
      assertPrivateApprovalDirectory(directory);
      const stats = fs.lstatSync(recordPath, { throwIfNoEntry: false });
      if (
        !stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 ||
        fs.realpathSync(recordPath) !== path.resolve(recordPath)
      ) {
        throw new Error('unsafe approval record');
      }
      return readContentRecord(directory, approvalId);
    } catch {
      throw workflowError(
        'TASK_REVISION_APPROVAL_NOT_FOUND',
        `Task-revision approval ${approvalId} is unavailable or unsafe.`,
        ExitCode.staleState,
      );
    }
  },
  publish(repository, record) {
    const directory = approvalDirectory(
      repository.gitCommonDirectory,
      repository.repositoryRoot,
    );
    ensurePrivateApprovalDirectory(directory);
    const approvalId = writeContentRecord(directory, record);
    return {
      approvalId,
      recordPath: path.join(directory, `${approvalId}.json`),
    };
  },
};

function approvalDirectory(
  gitCommonDirectory: string,
  repositoryRoot: string,
): string {
  const config = loadWorkflowConfig(repositoryRoot);
  return path.join(
    defaultSessionRuntimeLayoutPort.resolve({
      gitCommonDirectory,
      runtimeDirectory: config.runtimeDirectory,
    }).root,
    'task-revision-approvals',
  );
}

function ensurePrivateApprovalDirectory(directory: string): void {
  ensurePlainDirectory(directory);
  assertPrivateApprovalDirectory(directory);
}

function assertPrivateApprovalDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    fs.realpathSync(absolute) !== absolute
  ) {
    throw approvalInvalid(
      'Task-revision approval storage is not a private canonical directory.',
    );
  }
}
