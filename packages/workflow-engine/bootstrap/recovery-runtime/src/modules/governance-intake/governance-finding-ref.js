/**
 * Defines canonical Finding paths and the dedicated-ref persistence
 * contract.
 *
 * Invariants:
 * - Generated record paths must satisfy the Finding path grammar before
 *   they are returned.
 */
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
export const GOVERNANCE_FINDING_REF = 'refs/heads/jigwright/findings';
const SESSION = '[A-Za-z0-9][A-Za-z0-9._@:-]{0,511}';
const RECORD_PATH = new RegExp(`^findings/${SESSION}/FND-[0-9a-f]{64}(?:\\.disposition)?\\.json$`);
const DIRECTORY_PATH = new RegExp(`^findings(?:/${SESSION})?$`);
export function findingRecordPath(sessionId, findingId, disposition = false) {
    const recordPath = `findings/${sessionId}/${findingId}${disposition ? '.disposition' : ''}.json`;
    if (!isFindingRefRecordPath(recordPath))
        throw findingRefUnsafe(recordPath);
    return recordPath;
}
export function findingRecordLocation(recordPath) {
    return `${GOVERNANCE_FINDING_REF}:${recordPath}`;
}
export function isFindingRefRecordPath(recordPath) {
    return RECORD_PATH.test(recordPath);
}
export function isFindingRefDirectoryPath(recordPath) {
    return DIRECTORY_PATH.test(recordPath);
}
export function findingRefUnsafe(recordPath) {
    return workflowError('GOVERNANCE_FINDING_STORE_UNSAFE', 'Finding Git storage must contain only canonical plain record blobs.', ExitCode.unsafeEnvironment, { details: { ref: GOVERNANCE_FINDING_REF, path: recordPath } });
}
