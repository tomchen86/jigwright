/** Observe repository/session facts and binding-file presence for parent bootstrap. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkflowConfig } from "../workflow-configuration/workflow-configuration.js";
import { discoverRepository } from "../repository-transaction/git.js";
import { listActiveWorkflowSessionIds, readSessionFile, runtimePaths, } from "../session-workspace/session-store.js";
export const observeParentSessions = (cwd, parentChangeId) => {
    const repository = discoverRepository(cwd);
    const config = loadWorkflowConfig(repository.repositoryRoot);
    const runtime = runtimePaths(repository.gitCommonDirectory, config.runtimeDirectory);
    const candidates = listActiveWorkflowSessionIds(runtime)
        .map((sessionId) => ({
        sessionId,
        sessionPath: path.join(runtime.sessions, `${sessionId}.json`),
    }))
        .map((entry) => ({
        ...entry,
        session: readSessionFile(entry.sessionPath),
    }))
        .filter(({ session }) => session.changeId === parentChangeId);
    return { repository, runtime, candidates };
};
export const observeParentBindingPath = (stateRoot, parentChangeId) => {
    const identity = crypto
        .createHash('sha256')
        .update(`parent-session\0${parentChangeId}`)
        .digest('hex');
    const bindingPath = path.join(stateRoot, 'local-parent-sessions', `${identity}.json`);
    if (!fs.lstatSync(bindingPath, { throwIfNoEntry: false }))
        return null;
    return bindingPath;
};
