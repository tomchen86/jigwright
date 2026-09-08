import path from 'node:path';
import fs from 'node:fs';
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import crypto from 'node:crypto';
export function createTaskMandateStore({ runtimePaths, ensurePlainDirectory, parseCurrentTaskMandateRecord, assertTaskMandateTaskId, assertMandateId, unsafeStore, }) {
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
    }
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
    }
    function readTaskRecord(paths, taskId) {
        const active = taskRecordPath(paths.active, taskId);
        const terminal = taskRecordPath(paths.terminal, taskId);
        if (fs.existsSync(active))
            return parseCurrentTaskMandateRecord(readPrivateFile(active));
        if (fs.existsSync(terminal)) {
            return parseCurrentTaskMandateRecord(readPrivateFile(terminal));
        }
        throw workflowError('TASK_MANDATE_NOT_FOUND', `No task mandate exists for ${taskId}.`, ExitCode.guard);
    }
    function taskRecordPath(directory, taskId) {
        return path.join(directory, `${assertTaskMandateTaskId(taskId)}.json`);
    }
    function taskHistoryPath(directory, taskId, mandateId) {
        return path.join(directory, `${assertTaskMandateTaskId(taskId)}.${assertMandateId(mandateId)}.json`);
    }
    function createPrivateFileAtomic(filePath, content) {
        const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        let descriptor;
        try {
            descriptor = fs.openSync(temporary, 'wx', 0o600);
            fs.writeFileSync(descriptor, content, 'utf8');
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.linkSync(temporary, filePath);
            fs.unlinkSync(temporary);
            fsyncDirectory(path.dirname(filePath));
        }
        finally {
            if (descriptor !== undefined)
                fs.closeSync(descriptor);
            fs.rmSync(temporary, { force: true });
        }
    }
    function replacePrivateFileAtomic(filePath, content) {
        const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        let descriptor;
        try {
            descriptor = fs.openSync(temporary, 'wx', 0o600);
            fs.writeFileSync(descriptor, content, 'utf8');
            fs.fsyncSync(descriptor);
            fs.closeSync(descriptor);
            descriptor = undefined;
            fs.renameSync(temporary, filePath);
            fsyncDirectory(path.dirname(filePath));
        }
        finally {
            if (descriptor !== undefined)
                fs.closeSync(descriptor);
            fs.rmSync(temporary, { force: true });
        }
    }
    function readPrivateFile(filePath) {
        const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
        if (!stats?.isFile() ||
            stats.isSymbolicLink() ||
            stats.nlink !== 1 ||
            (stats.mode & 0o777) !== 0o600) {
            throw unsafeStore();
        }
        return fs.readFileSync(filePath, 'utf8');
    }
    function fsyncDirectory(directory) {
        const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
        try {
            fs.fsyncSync(descriptor);
        }
        finally {
            fs.closeSync(descriptor);
        }
    }
    return {
        taskMandateStorePaths,
        ensureStore,
        readTaskRecord,
        taskRecordPath,
        taskHistoryPath,
        createPrivateFileAtomic,
        replacePrivateFileAtomic,
        readPrivateFile,
        fsyncDirectory,
    };
}
