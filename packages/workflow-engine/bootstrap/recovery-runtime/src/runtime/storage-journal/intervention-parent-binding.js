/** Read retained parent metadata without loading or probing its engine artifact. */
import path from 'node:path';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { readCanonicalPrivateJson } from "./intervention-persistence-files.js";
import { canonicalAbsolutePath } from "./intervention-persistence-paths.js";
import { isRecord, hasExactKeys, isDigest, canonicalDigest, exactIso, assertDigest, } from "./intervention-persistence-values.js";
import { interventionControlPersistencePaths } from "./intervention-persistence-paths.js";
export function readLocalEngineBinding(bindingPath) {
    const value = readCanonicalPrivateJson(canonicalAbsolutePath(bindingPath), 'BOOTSTRAP_BINDING_NOT_FOUND', 64 * 1024);
    if (!isRecord(value) ||
        value.kind !== 'local-parent-session-metadata.v2' ||
        !hasExactKeys(value, [
            'activeArtifact',
            'blocker',
            'checkpointId',
            'engineDigest',
            'generation',
            'interventionChangeId',
            'interventionState',
            'kind',
            'parentBranch',
            'parentChangeId',
            'parentWorkspacePath',
            'recordDigest',
            'sessionSchema',
            'txId',
            'updatedAt',
        ])) {
        throw corruptBinding();
    }
    const binding = value;
    const { recordDigest, ...payload } = binding;
    if (!isDigest(recordDigest) ||
        canonicalDigest(payload) !== recordDigest ||
        !Number.isSafeInteger(binding.generation) ||
        binding.generation < 1 ||
        !isDigest(binding.engineDigest) ||
        !isDigest(binding.checkpointId) ||
        !isRecord(binding.activeArtifact) ||
        !hasExactKeys(binding.activeArtifact, [
            'artifactId',
            'executableDigest',
            'executablePath',
        ]) ||
        !isDigest(binding.activeArtifact.artifactId) ||
        !isDigest(binding.activeArtifact.executableDigest) ||
        binding.activeArtifact.executablePath !==
            localEngineArtifactPath(bindingStateRoot(bindingPath), binding.activeArtifact.artifactId) ||
        typeof binding.txId !== 'string' ||
        binding.txId.length === 0 ||
        binding.txId.trim() !== binding.txId ||
        typeof binding.parentChangeId !== 'string' ||
        binding.parentChangeId.length === 0 ||
        binding.parentChangeId.trim() !== binding.parentChangeId ||
        binding.parentBranch !== `refs/heads/work/${binding.parentChangeId}` ||
        canonicalAbsolutePath(binding.parentWorkspacePath) !==
            binding.parentWorkspacePath ||
        !['active', 'adopted'].includes(binding.interventionState) ||
        (binding.interventionState === 'active'
            ? !isHarnessInterventionBlocker(binding.blocker, binding.checkpointId, binding.interventionChangeId)
            : binding.blocker !== null)) {
        throw corruptBinding();
    }
    exactIso(binding.updatedAt, 'BOOTSTRAP_BINDING_CORRUPT');
    return binding;
}
function isHarnessInterventionBlocker(value, checkpointId, interventionChangeId) {
    return (isRecord(value) &&
        hasExactKeys(value, ['blockedBy', 'checkpointId', 'kind']) &&
        value.kind === 'harness-intervention' &&
        value.checkpointId === checkpointId &&
        value.blockedBy === interventionChangeId);
}
function localEngineArtifactPath(storageRoot, artifactId) {
    assertDigest(artifactId, 'BOOTSTRAP_ENGINE_ARTIFACT_CORRUPT');
    return path.join(interventionControlPersistencePaths(storageRoot).root, 'local-engine-artifacts', artifactId.slice('sha256:'.length), 'engine');
}
function bindingStateRoot(bindingPath) {
    const directory = path.dirname(canonicalAbsolutePath(bindingPath));
    return path.basename(directory) === 'local-parent-sessions'
        ? path.dirname(directory)
        : directory;
}
function corruptBinding() {
    return workflowError('BOOTSTRAP_BINDING_CORRUPT', 'Local engine binding failed integrity verification.', ExitCode.verification);
}
