/** Reads the pinned tree and owns the scan's wall/CPU deadline. */
import { performance } from 'node:perf_hooks';
import type {
  TrackedObjectEntryV1,
  TrackedObjectReaderPortV1,
  TrackedObjectSnapshotV1,
  TrackedObjectOperationalDeadlineV1,
} from '@jigwright/core/tracked-object-reader-port';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  investigationScanLimits,
  scanInvestigationSnapshotFacts,
  type InvestigationTreeScanner,
  type ScanTreeEntry,
  type ScanTreeSnapshot,
} from '../../modules/investigation/domain/investigation-scanner.ts';

export function createInvestigationTreeScanner(
  trackedObjectReader: TrackedObjectReaderPortV1,
): InvestigationTreeScanner {
  return function scanInvestigationTreeFacts(request) {
    const { repositoryRoot, treeOid } = request;
    const limits = investigationScanLimits(request);
    const operationalDeadline: TrackedObjectOperationalDeadlineV1 = {
      expiresAtMonotonicMillis: performance.now() + limits.maxScanCpuMillis,
    };
    const scanCpuStart = process.cpuUsage();
    const snapshot = readTrackedTreeForScan(trackedObjectReader, {
      repositoryRoot,
      treeOid,
      limits: {
        maxBlobBytes: limits.maxBlobBytes,
        maxTotalScannedBytes: limits.maxTotalScannedBlobBytes,
      },
      operationalDeadline,
    });
    const assertBudget = () =>
      assertOperationalScanBudget(
        operationalDeadline,
        scanCpuStart,
        limits.maxScanCpuMillis,
      );
    assertBudget();
    return scanInvestigationSnapshotFacts(
      {
        snapshot,
        terms: request.terms,
        limits,
        allowSaturatedTerms: request.allowSaturatedTerms,
      },
      assertBudget,
    );
  };
}

function readTrackedTreeForScan(
  reader: TrackedObjectReaderPortV1,
  request: Parameters<TrackedObjectReaderPortV1['readPinnedTree']>[0],
): ScanTreeSnapshot {
  if (
    reader?.contractVersion !== 'jigwright.tracked-object-reader-port.v1' ||
    typeof reader.readPinnedTree !== 'function'
  ) {
    throw workflowError(
      'TRACKED_OBJECT_READER_UNSUPPORTED',
      'Tracked-object reader contract version is unsupported.',
      ExitCode.guard,
    );
  }
  const snapshot = reader.readPinnedTree(request);
  if (
    !isTrackedObjectSnapshot(snapshot) ||
    snapshot.treeOid !== request.treeOid
  ) {
    throw workflowError(
      'TRACKED_OBJECT_READER_INVALID',
      'Tracked-object reader returned an invalid snapshot.',
      ExitCode.guard,
    );
  }
  return {
    treeOid: snapshot.treeOid,
    treeDigest: snapshot.treeDigest,
    entries: snapshot.entries.map(adaptTrackedObjectEntry),
    totalScannedBlobBytes: snapshot.totalScannedBlobBytes,
    budgetExceeded: snapshot.budgetExceeded,
  };
}

function adaptTrackedObjectEntry(entry: TrackedObjectEntryV1): ScanTreeEntry {
  return {
    path: { rawBase64: entry.path.rawBase64, utf8: entry.path.utf8 },
    objectId: entry.objectId,
    objectType: entry.objectType,
    mode: entry.mode,
    byteSize: entry.byteSize,
    ...(entry.content === undefined
      ? {}
      : {
          content: Buffer.isBuffer(entry.content)
            ? entry.content
            : Buffer.from(entry.content),
        }),
    ...(entry.contentSha256 === undefined
      ? {}
      : { contentSha256: entry.contentSha256 }),
    ...(entry.skipReason === undefined ? {} : { skipReason: entry.skipReason }),
  };
}

function isTrackedObjectSnapshot(
  value: TrackedObjectSnapshotV1,
): value is TrackedObjectSnapshotV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.treeOid) &&
    /^[0-9a-f]{64}$/.test(value.treeDigest) &&
    Array.isArray(value.entries) &&
    Number.isSafeInteger(value.totalScannedBlobBytes) &&
    value.totalScannedBlobBytes >= 0 &&
    typeof value.budgetExceeded === 'boolean'
  );
}

function assertOperationalScanBudget(
  deadline: TrackedObjectOperationalDeadlineV1,
  cpuStart: NodeJS.CpuUsage,
  maxCpuMillis: number,
): void {
  const cpu = process.cpuUsage(cpuStart);
  if (
    performance.now() >= deadline.expiresAtMonotonicMillis ||
    cpu.user + cpu.system >= maxCpuMillis * 1000
  ) {
    throw workflowError(
      'INVESTIGATION_SCAN_TIMEOUT',
      'Investigation scan exceeded its operational wall/CPU deadline.',
      ExitCode.unsafeEnvironment,
      { details: { limitMillis: maxCpuMillis } },
    );
  }
}
