import { humanResolutionGrantNotFound } from '../../modules/investigation/domain/human-resolution-values.ts';
import {
  assertHumanResolutionGrantId,
  exactResolutionTimestamp,
  humanResolutionInvalid,
  humanResolutionObjectUnsafe,
  isBoundedResolutionText,
  isEmptyRecord,
  isSortedUniqueStrings,
  humanResolutionGrantUnsafe,
} from '../../modules/investigation/domain/human-resolution-values.ts';
/**
 * Supplies investigation resolution paths, scalar checks, observations, and stable errors.
 *
 * Invariants:
 * - Path construction and identifier validation keep their existing accepted values.
 * - Unsafe observations, canonical envelope checks, and error codes remain byte-compatible.
 */
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { exactUnsafePathObservationDigest } from './evidence-unsafe-observation.ts';

export function investigationSessionPath(
  paths: InvestigationRuntimePaths,
  investigationId: string,
): string {
  return path.join(paths.sessions, `${investigationId}.json`);
}

export function currentInvestigationRefPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(paths.refs, `${changeId}.investigation-session.json`);
}

export function investigationStartReservationPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(paths.refs, `${changeId}.investigation-start.json`);
}

export function humanResolutionPaths(paths: InvestigationRuntimePaths) {
  const root = path.join(paths.root, 'human-resolutions');
  return {
    root,
    nodes: path.join(root, 'nodes'),
    refs: path.join(root, 'refs'),
    available: path.join(root, 'grants', 'available'),
    reserved: path.join(root, 'grants', 'reserved'),
    terminal: path.join(root, 'grants', 'terminal'),
    publicationRecoveries: path.join(root, 'grants', 'publication-recoveries'),
    active: path.join(root, 'active'),
    journals: path.join(root, 'journals'),
    receipts: path.join(root, 'receipts'),
    archives: path.join(root, 'archives'),
    retiredRefs: path.join(root, 'retired-refs'),
    quarantine: path.join(root, 'quarantine'),
    locks: path.join(root, 'locks'),
  };
}

export function humanResolutionGrantPublicationRecoveryRequired() {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_REQUIRED',
    'An interrupted human resolution grant publication requires explicit reconciliation through maintainer resolution-inspect and resolution-publication-discard.',
    ExitCode.unsafeEnvironment,
  );
}

export function humanResolutionGrantPublicationRecoveryInvalid() {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_INVALID',
    'Interrupted human resolution grant publication recovery input is malformed.',
    ExitCode.guard,
  );
}

export function humanResolutionGrantPublicationRecoveryAmbiguous() {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_PUBLICATION_RECOVERY_AMBIGUOUS',
    'Interrupted human resolution grant publication state is not a unique temp-only prefix.',
    ExitCode.unsafeEnvironment,
  );
}

export function humanResolutionNodePath(
  paths: InvestigationRuntimePaths,
  nodeId: string,
): string {
  return path.join(humanResolutionPaths(paths).nodes, `${nodeId}.json`);
}

export function humanResolutionRefPath(
  paths: InvestigationRuntimePaths,
  investigationId: string,
): string {
  return path.join(humanResolutionPaths(paths).refs, `${investigationId}.json`);
}

export function humanResolutionJournalPath(
  paths: InvestigationRuntimePaths,
  grantId: string,
): string {
  return path.join(humanResolutionPaths(paths).journals, `${grantId}.json`);
}

export function activeHumanResolutionJournalPath(
  paths: InvestigationRuntimePaths,
  changeId: string,
): string {
  return path.join(humanResolutionPaths(paths).active, `${changeId}.json`);
}

export function observeUnsafePath(
  filePath: string,
  object: string,
  observations: Array<{
    object: string;
    observationDigest: string;
  }>,
): string {
  let observationDigest: string;
  try {
    observationDigest = exactUnsafePathObservationDigest(filePath, object);
  } catch {
    throw humanResolutionStateInvalid();
  }
  observations.push({ object, observationDigest });
  return observationDigest;
}

export function normalizeAmbiguityObservations(
  observations: Array<{
    object: string;
    observationDigest: string;
  }>,
): Array<{ object: string; observationDigest: string }> {
  const normalized = new Map<string, string>();
  for (const { object, observationDigest } of observations) {
    const existing = normalized.get(object);
    if (existing !== undefined && existing !== observationDigest) {
      throw humanResolutionStateInvalid();
    }
    normalized.set(object, observationDigest);
  }
  return [...normalized]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([object, observationDigest]) => ({ object, observationDigest }));
}

export function assertCanonicalResolutionEnvelopeBytes(content: string): void {
  if (
    typeof content !== 'string' ||
    Buffer.byteLength(content, 'utf8') > 65_536
  ) {
    throw humanResolutionGrantUnsafe();
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw humanResolutionGrantUnsafe();
  }
  if (`${JSON.stringify(value)}\n` !== content) {
    throw humanResolutionGrantUnsafe();
  }
}

export function sessionUnsafe() {
  return workflowError(
    'INVESTIGATION_SESSION_UNSAFE',
    'Investigation session storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

export function investigationCasMismatch(expected: number, observed: number) {
  return workflowError(
    'INVESTIGATION_CAS_MISMATCH',
    'Investigation session changed during compare-and-swap.',
    ExitCode.conflict,
    { details: { expectedRevision: expected, observedRevision: observed } },
  );
}

export function refUnsafe() {
  return workflowError(
    'CURRENT_INVESTIGATION_REF_UNSAFE',
    'Current investigation reference is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

export function humanResolutionStateInvalid() {
  return workflowError(
    'HUMAN_RESOLUTION_STATE_UNSAFE',
    'The workflow state cannot be uniquely bound for human resolution.',
    ExitCode.unsafeEnvironment,
  );
}

export function humanResolutionRecoveryAmbiguous() {
  return workflowError(
    'HUMAN_RESOLUTION_RECOVERY_AMBIGUOUS',
    'Human resolution recovery observed state outside the exact journal.',
    ExitCode.staleState,
  );
}

export function startReservationUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_START_RESERVATION_UNSAFE',
    'Referenced investigation start reservation is unsafe or non-canonical.',
    ExitCode.unsafeEnvironment,
  );
}

export function humanResolutionRefUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_REF_UNSAFE',
    'Human resolution ref storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

export function humanResolutionGrantUnavailable(grantId: string) {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_UNAVAILABLE',
    `Human resolution grant ${grantId} is unavailable or already terminal.`,
    ExitCode.conflict,
  );
}

export function humanResolutionArchiveUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_ARCHIVE_UNSAFE',
    'Human resolution evidence archive is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

export function humanResolutionReceiptUnsafe() {
  return workflowError(
    'HUMAN_RESOLUTION_RECEIPT_UNSAFE',
    'Human resolution receipt is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

export function sessionLockInvalid() {
  return workflowError(
    'INVESTIGATION_SESSION_LOCK_INVALID',
    'Investigation session lock ownership changed during the transition.',
    ExitCode.staleState,
  );
}
