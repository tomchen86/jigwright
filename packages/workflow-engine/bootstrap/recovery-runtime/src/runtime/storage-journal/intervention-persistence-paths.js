/**
 * Resolves and prepares the private namespaces that own intervention persistence records.
 *
 * Invariants:
 * - Storage roots and derived filenames retain their canonical identity and path validation.
 * - Record and operation namespaces remain distinct and preserve existing directory permissions.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { ensurePlainDirectory } from "../repository-transaction/filesystem-safety.js";
import { PRIVATE_DIRECTORY_MODE, } from "./intervention-persistence-contracts.js";
import { identityFileName } from "./intervention-persistence-values.js";
export function interventionControlPersistencePaths(requestedRoot) {
    const root = assertStorageRoot(requestedRoot);
    return {
        root,
        checkpoints: path.join(root, 'checkpoints'),
        interventions: path.join(root, 'interventions'),
        sidecarSessions: path.join(root, 'sidecar-sessions'),
        sidecarHistory: path.join(root, 'sidecar-session-history'),
        adoptions: path.join(root, 'adoptions'),
        operations: path.join(root, 'operations'),
    };
}
export function interventionRecordPath(storageRoot, parentChangeId) {
    return path.join(interventionControlPersistencePaths(storageRoot).interventions, `${identityFileName('intervention', parentChangeId)}.json`);
}
export function persistedBootstrapSidecarSessionPath(storageRoot, parentChangeId) {
    return path.join(interventionControlPersistencePaths(storageRoot).sidecarSessions, `${identityFileName('sidecar-session', parentChangeId)}.json`);
}
export function engineAdoptionRecordPath(storageRoot, txId) {
    return path.join(interventionControlPersistencePaths(storageRoot).adoptions, `${identityFileName('adoption', txId)}.json`);
}
export function ensurePersistenceDirectories(storageRoot) {
    const paths = interventionControlPersistencePaths(storageRoot);
    for (const directory of [
        paths.root,
        paths.checkpoints,
        paths.interventions,
        paths.sidecarSessions,
        paths.sidecarHistory,
        paths.adoptions,
        paths.operations,
    ]) {
        ensurePlainDirectory(directory);
        const stats = fs.statSync(directory);
        if ((stats.mode & 0o077) !== 0) {
            try {
                fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE);
            }
            catch {
                throw workflowError('INTERVENTION_PERSISTENCE_DIRECTORY_UNSAFE', 'Persistence directory permissions are not private.', ExitCode.unsafeEnvironment);
            }
        }
    }
}
function assertStorageRoot(requestedRoot) {
    if (typeof requestedRoot !== 'string' || !path.isAbsolute(requestedRoot)) {
        throw workflowError('INTERVENTION_PERSISTENCE_ROOT_INVALID', 'Persistence root must be an explicit absolute path.', ExitCode.usage);
    }
    const root = path.resolve(requestedRoot);
    if (root === path.parse(root).root) {
        throw workflowError('INTERVENTION_PERSISTENCE_ROOT_INVALID', 'Filesystem root cannot be used as intervention persistence.', ExitCode.guard);
    }
    return root;
}
