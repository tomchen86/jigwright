/** Reads and atomically publishes private Task Mandate files. */
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';
import { parseCurrentTaskMandateRecord } from '../../modules/authority/task-mandate-records.ts';
import { assertTaskMandateTaskId } from '../../modules/authority/task-mandate-policy.ts';
import {
  assertMandateId,
  unsafeStore,
} from '../../modules/authority/task-mandate-values.ts';

import type { TaskMandateStoreServices } from '../../modules/authority/task-mandate-services.ts';

const taskMandateStorePaths: TaskMandateStoreServices['taskMandateStorePaths'] =
  function taskMandateStorePaths(gitCommonDirectory) {
    const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
    const root = path.join(runtime.root, 'task-mandates');
    return {
      runtime,
      root,
      active: path.join(root, 'active'),
      terminal: path.join(root, 'terminal'),
      history: path.join(root, 'history'),
    };
  };

const ensureStore: TaskMandateStoreServices['ensureStore'] =
  function ensureStore(paths) {
    for (const directory of [
      paths.root,
      paths.active,
      paths.terminal,
      paths.history,
    ]) {
      ensurePlainDirectory(directory);
      fs.chmodSync(directory, 0o700);
    }
  };

const readTaskRecord: TaskMandateStoreServices['readTaskRecord'] =
  function readTaskRecord(paths, taskId) {
    const active = taskRecordPath(paths.active, taskId);
    const terminal = taskRecordPath(paths.terminal, taskId);
    if (fs.existsSync(active))
      return parseCurrentTaskMandateRecord(readPrivateFile(active));
    if (fs.existsSync(terminal)) {
      return parseCurrentTaskMandateRecord(readPrivateFile(terminal));
    }
    throw workflowError(
      'TASK_MANDATE_NOT_FOUND',
      `No task mandate exists for ${taskId}.`,
      ExitCode.guard,
    );
  };

const taskRecordPath: TaskMandateStoreServices['taskRecordPath'] =
  function taskRecordPath(directory, taskId) {
    return path.join(directory, `${assertTaskMandateTaskId(taskId)}.json`);
  };

const taskHistoryPath: TaskMandateStoreServices['taskHistoryPath'] =
  function taskHistoryPath(directory, taskId, mandateId) {
    return path.join(
      directory,
      `${assertTaskMandateTaskId(taskId)}.${assertMandateId(mandateId)}.json`,
    );
  };

const createPrivateFileAtomic: TaskMandateStoreServices['createPrivateFileAtomic'] =
  function createPrivateFileAtomic(filePath, content) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.linkSync(temporary, filePath);
      fs.unlinkSync(temporary);
      fsyncDirectory(path.dirname(filePath));
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  };

const replacePrivateFileAtomic: TaskMandateStoreServices['replacePrivateFileAtomic'] =
  function replacePrivateFileAtomic(filePath, content) {
    const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, content, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, filePath);
      fsyncDirectory(path.dirname(filePath));
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  };

const readPrivateFile: TaskMandateStoreServices['readPrivateFile'] =
  function readPrivateFile(filePath) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw unsafeStore();
    }
    return fs.readFileSync(filePath, 'utf8');
  };

const fsyncDirectory: TaskMandateStoreServices['fsyncDirectory'] =
  function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  };

export const taskMandateStore: TaskMandateStoreServices = {
  taskMandateStorePaths,
  ensureStore,
  readTaskRecord,
  taskRecordPath,
  taskHistoryPath,
  createPrivateFileAtomic,
  replacePrivateFileAtomic,
  readPrivateFile,
  fsyncDirectory,
  exists: fs.existsSync,
  move: fs.renameSync,
};
