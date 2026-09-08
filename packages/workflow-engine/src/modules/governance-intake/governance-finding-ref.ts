/** Canonical Finding record paths and the persistence boundary used by intake. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export const GOVERNANCE_FINDING_REF = 'refs/heads/jigwright/findings';
const SESSION = '[A-Za-z0-9][A-Za-z0-9._@:-]{0,511}';
const RECORD_PATH = new RegExp(
  `^findings/${SESSION}/FND-[0-9a-f]{64}(?:\\.disposition)?\\.json$`,
);
const DIRECTORY_PATH = new RegExp(`^findings(?:/${SESSION})?$`);

export type GovernanceFindingRefPort = Readonly<{
  readFindingRef(runtimeRoot: string): Readonly<{
    records: ReadonlyMap<string, Buffer>;
  }>;
  publishFindingRefRecord(
    runtimeRoot: string,
    recordPath: string,
    bytes: Buffer,
  ): boolean;
}>;

export function findingRecordPath(
  sessionId: string,
  findingId: string,
  disposition = false,
): string {
  const recordPath = `findings/${sessionId}/${findingId}${disposition ? '.disposition' : ''}.json`;
  if (!isFindingRefRecordPath(recordPath)) throw findingRefUnsafe(recordPath);
  return recordPath;
}

export function findingRecordLocation(recordPath: string): string {
  return `${GOVERNANCE_FINDING_REF}:${recordPath}`;
}

export function isFindingRefRecordPath(recordPath: string): boolean {
  return RECORD_PATH.test(recordPath);
}

export function isFindingRefDirectoryPath(recordPath: string): boolean {
  return DIRECTORY_PATH.test(recordPath);
}

export function findingRefUnsafe(recordPath: string) {
  return workflowError(
    'GOVERNANCE_FINDING_STORE_UNSAFE',
    'Finding Git storage must contain only canonical plain record blobs.',
    ExitCode.unsafeEnvironment,
    { details: { ref: GOVERNANCE_FINDING_REF, path: recordPath } },
  );
}
