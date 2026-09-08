/**
 * Reads and publishes canonical execution job state under private job locks.
 *
 * Invariants:
 * - State revision and canonical content comparisons precede creation or replacement.
 * - Job paths, private directory checks, and lock boundaries remain unchanged.
 */
import path from 'node:path';
import { WorkflowError } from "../../foundation/errors/errors.js";
import { assertDurableExecutionJobState, canonicalStateIgnoringRevision, } from "./execution-state-contract.js";
import { assertExecutionJobId, executionStoreUnsafe, sha256Text, } from "./execution-state-values.js";
import { createPrivateCanonicalJson, privatePathExists, readPrivateCanonicalJson, withPrivateRuntimeLock, writePrivateCanonicalJsonAtomic, } from "./investigation-private-files.js";
export function executionStorePaths(paths) {
    const root = path.join(paths.root, 'execution');
    return {
        root,
        jobs: path.join(root, 'jobs'),
        admissionAuthorities: path.join(root, 'admission-authorities'),
    };
}
export function executionJobStatePath(paths, requestedJobId) {
    const jobId = assertExecutionJobId(requestedJobId);
    return path.join(executionStorePaths(paths).jobs, `${sha256Text(jobId)}.json`);
}
export function persistExecutionJobState(paths, current, input) {
    const candidate = assertDurableExecutionJobState(input);
    if (current !== null &&
        canonicalStateIgnoringRevision(current) ===
            canonicalStateIgnoringRevision(candidate)) {
        return current;
    }
    const next = assertDurableExecutionJobState({
        ...candidate,
        revision: current === null ? 0 : current.revision + 1,
    });
    const statePath = executionJobStatePath(paths, next.job.jobId);
    if (current === null) {
        createPrivateCanonicalJson(paths, statePath, next, executionStoreUnsafe, 'EXECUTION_STORE_COLLISION');
    }
    else {
        writePrivateCanonicalJsonAtomic(paths, statePath, next, executionStoreUnsafe);
    }
    const stored = readExecutionJobStateUnlocked(paths, next.job.jobId);
    if (stored === null)
        throw executionStoreUnsafe();
    return stored;
}
export function readExecutionJobStateUnlocked(paths, jobId) {
    const statePath = executionJobStatePath(paths, jobId);
    try {
        if (!privatePathExists(paths, statePath, executionStoreUnsafe))
            return null;
        const state = assertDurableExecutionJobState(readPrivateCanonicalJson(paths, statePath, executionStoreUnsafe));
        if (state.job.jobId !== jobId)
            throw executionStoreUnsafe();
        return state;
    }
    catch (error) {
        if (error instanceof WorkflowError &&
            error.code === 'EXECUTION_STORE_UNSAFE') {
            throw error;
        }
        throw executionStoreUnsafe(error);
    }
}
export function withExecutionJobLock(paths, jobId, operation) {
    return withPrivateRuntimeLock(paths, path.join(paths.locks, `execution-job-${sha256Text(jobId)}.lock`), operation, 'EXECUTION_STORE_OPERATION_CONFLICT', executionStoreUnsafe);
}
