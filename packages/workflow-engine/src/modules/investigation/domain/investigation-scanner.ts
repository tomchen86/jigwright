import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type {
  TrackedObjectEntryV1,
  TrackedObjectReaderPortV1,
  TrackedObjectSnapshotV1,
} from '@jigwright/core/tracked-object-reader-port';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import {
  assertInvestigationLimits,
  INVESTIGATION_LIMITS,
  normalizeInvestigationTerm,
  type InvestigationLimits,
  type InvestigationTermProvenance,
  type NormalizedInvestigationTerm,
} from './investigation-terms.ts';
import {
  workflowTrackedObjectReaderPort,
  type TrackedTreeEntry,
  type TrackedTreeOperationalDeadline,
  type TrackedTreePathIdentity,
  type TrackedTreeSkipReason,
  type TrackedTreeSnapshot,
} from '../../../runtime/repository-transaction/tracked-tree-reader.ts';

const POLICY_SCHEMA = 'investigation-scan-policy.v2';

/**
 * Tracked paths whose content is produced from other tracked content.
 *
 * A content or symbol match inside a generated artifact is a copy of a match
 * the same scan already has at the source, so admitting it adds a group to
 * disposition, a row to review, and nothing to what is known. Coverage reports
 * and lock files were the largest single source of that noise in practice.
 *
 * The rule applies only to terms that did not name a path: a `literal-path`
 * term names its target deliberately, and a change that really is about a lock
 * file has to stay investigable. Excluded entries are recorded in the scan
 * inventory rather than dropped silently.
 */
const GENERATED_DIRECTORY_SEGMENTS: ReadonlySet<string> = new Set([
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.turbo',
  'coverage',
  'dist',
  'node_modules',
]);

const GENERATED_FILE_NAMES: ReadonlySet<string> = new Set([
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'go.sum',
  'npm-shrinkwrap.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'poetry.lock',
  'yarn.lock',
]);

const GENERATED_FILE_SUFFIXES: readonly string[] = [
  '.css.map',
  '.js.map',
  '.min.css',
  '.min.js',
];

function isGeneratedArtifactPath(utf8Path: string | null): boolean {
  if (utf8Path === null) return false;
  const segments = utf8Path.split('/');
  if (segments.some((segment) => GENERATED_DIRECTORY_SEGMENTS.has(segment))) {
    return true;
  }
  const name = segments.at(-1) ?? '';
  return (
    GENERATED_FILE_NAMES.has(name) ||
    GENERATED_FILE_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/**
 * A sealed term as consumed by the scanner: its normalized identity plus the
 * retained union provenance. The normalized identity remains independent of
 * provenance while the facts retain the exact sources that contributed it.
 */
export type ScanInvestigationTerm = NormalizedInvestigationTerm & {
  provenance: InvestigationTermProvenance[];
};

/**
 * Stable pinned object identity carried by every scan hit so Task 3.2 grouping
 * and the exact-blob WHY task can bind matches to their exact source object. A
 * skipped object still yields `literal-path` hits: scanned text carries a
 * SHA-256 and a null `skipReason`; a skipped path carries a null SHA-256 and its
 * exact reason.
 */
export type ScanHitSourceObject = {
  objectId: string;
  objectType: string;
  mode: string;
  byteSize: number | null;
  contentSha256: string | null;
  skipReason: TrackedTreeSkipReason | null;
};

/**
 * The bytes surrounding a content hit, so a class predicate can be replayed
 * later as a pure recomputation over stored evidence rather than by reopening
 * the repository. Bounded on purpose: a minified bundle is one enormous line,
 * and storing it whole would put the file back into the evidence this exists
 * to avoid.
 */
export type ScanHitContextWindow = {
  rawBase64: string;
  utf8: string | null;
  byteOffset: number;
  byteLength: number;
  truncated: boolean;
};

export type ScanHit = {
  path: TrackedTreePathIdentity;
  sourceObject: ScanHitSourceObject;
  surface: 'path' | 'content';
  byteOffset: number;
  byteLength: number;
  /**
   * Present for content hits only. A path-surface hit has no content to quote,
   * so it can never satisfy a predicate and can never join a class.
   */
  contextWindow?: ScanHitContextWindow;
};

export const SCAN_HIT_MAX_CONTEXT_BYTES = 512;

export function hitContextWindow(
  haystack: Buffer,
  byteOffset: number,
  byteLength: number,
): ScanHitContextWindow | null {
  if (
    !Number.isSafeInteger(byteOffset) ||
    !Number.isSafeInteger(byteLength) ||
    byteOffset < 0 ||
    byteLength <= 0 ||
    byteOffset + byteLength > haystack.length
  ) {
    return null;
  }
  const lineStart = haystack.lastIndexOf(0x0a, byteOffset) + 1;
  let lineEnd = haystack.indexOf(0x0a, byteOffset + byteLength - 1);
  if (lineEnd === -1) lineEnd = haystack.length;
  if (lineEnd > lineStart && haystack[lineEnd - 1] === 0x0d) lineEnd -= 1;

  let start = lineStart;
  let end = lineEnd;
  let truncated = false;
  if (end - start > SCAN_HIT_MAX_CONTEXT_BYTES) {
    // Keep the hit itself centred; a window that dropped the match would prove
    // nothing about the match.
    truncated = true;
    const slack =
      SCAN_HIT_MAX_CONTEXT_BYTES -
      Math.min(byteLength, SCAN_HIT_MAX_CONTEXT_BYTES);
    const before = Math.floor(slack / 2);
    start = Math.max(lineStart, byteOffset - before);
    end = Math.min(lineEnd, start + SCAN_HIT_MAX_CONTEXT_BYTES);
    start = Math.max(lineStart, end - SCAN_HIT_MAX_CONTEXT_BYTES);
  }
  const bytes = haystack.subarray(start, end);
  const utf8 = bytes.toString('utf8');
  return {
    rawBase64: bytes.toString('base64'),
    utf8: Buffer.compare(Buffer.from(utf8, 'utf8'), bytes) === 0 ? utf8 : null,
    byteOffset: start,
    byteLength: bytes.length,
    truncated,
  };
}

export type ScanSkippedObject = {
  path: { rawBase64: string; utf8: string | null };
  objectId: string;
  objectType: string;
  mode: string;
  byteSize: number | null;
  reason: TrackedTreeSkipReason | 'generated-artifact';
};

export type ScanInventoryFacts = {
  treeDigest: string;
  skippedObjects: readonly ScanSkippedObject[];
};

export type InvestigationScanTermFacts = {
  term: ScanInvestigationTerm;
  hits: ScanHit[];
};

/** Deterministic scanner output consumed by the manifest-first v3 writer. */
export type InvestigationScanFacts = {
  schemaVersion: 1;
  kind: 'investigation-scan-facts';
  treeDigest: string;
  policyDigest: string;
  inventory: ScanInventoryFacts;
  terms: InvestigationScanTermFacts[];
};

export type ScanViolation = {
  code:
    | 'TERM_HIT_LIMIT_EXCEEDED'
    | 'TOTAL_HIT_LIMIT_EXCEEDED'
    | 'HIT_DISPOSITION_WORK_LIMIT_EXCEEDED'
    | 'SCANNED_BYTE_LIMIT_EXCEEDED'
    | 'SCAN_WORK_LIMIT_EXCEEDED';
  termId?: string;
};

export type ReadyScanFactsResult = {
  outcome: 'ready';
  facts: InvestigationScanFacts;
  saturatedTermIds?: string[];
};

export type NarrowingScanFactsResult = {
  outcome: 'requires-narrowing';
  policyDigest: string;
  inventory: ScanInventoryFacts;
  violations: ScanViolation[];
  terms: ScanInvestigationTerm[];
};

export type InvestigationScanFactsResult =
  ReadyScanFactsResult | NarrowingScanFactsResult;

/**
 * Deterministically scan every sealed term against the pinned Git-tracked tree
 * and emit one independent fact set per term, sorted by term ID so caller order
 * is irrelevant. The scanner reads only the pinned object graph — never task
 * `allowedPaths`, working-tree files, recognized environment files, a shell, or
 * the caller PATH — and matches exact literal bytes with no regex. Each supplied
 * term is revalidated by recomputation; a forged term field or duplicate term
 * ID fails closed. A per-term, aggregate, work, or scanned-byte overage returns
 * typed `requires-narrowing` with the original terms and no partial facts.
 */
export function scanInvestigationTreeFacts(request: {
  repositoryRoot: string;
  treeOid: string;
  terms: ScanInvestigationTerm[];
  limits?: InvestigationLimits;
  /**
   * Accept a term that hit its own ceiling instead of refusing the scan.
   *
   * Off by default, because a truncated term is a search that cannot claim to
   * be complete and silently proceeding would let that claim be made anyway.
   * A caller that opts in is told which terms saturated, and the class
   * compression that would have relied on their completeness is refused for
   * exactly those terms — which is what makes carrying on honest rather than
   * merely convenient.
   */
  allowSaturatedTerms?: boolean;
  trackedObjectReader?: TrackedObjectReaderPortV1;
}): InvestigationScanFactsResult {
  const { repositoryRoot, treeOid, terms } = request;
  const allowSaturatedTerms = request.allowSaturatedTerms === true;
  const limits = assertInvestigationLimits(
    request.limits ?? { ...INVESTIGATION_LIMITS },
  );
  assertScanTerms(terms);
  if (terms.length > limits.maxEffectiveTerms) {
    throw scanInvalid(
      'Supplied terms exceed the effective-term limit and are not a sealed union.',
    );
  }

  const operationalDeadline: TrackedTreeOperationalDeadline = {
    expiresAtMonotonicMillis: performance.now() + limits.maxScanCpuMillis,
  };
  const scanCpuStart = process.cpuUsage();
  const snapshot = readTrackedTreeForScan(
    request.trackedObjectReader ?? workflowTrackedObjectReaderPort,
    {
      repositoryRoot,
      treeOid,
      limits: {
        maxBlobBytes: limits.maxBlobBytes,
        maxTotalScannedBytes: limits.maxTotalScannedBlobBytes,
      },
      operationalDeadline,
    },
  );
  assertOperationalScanBudget(
    operationalDeadline,
    scanCpuStart,
    limits.maxScanCpuMillis,
  );

  const policyDigest = computePolicyDigest(limits);
  const generatedEntries = snapshot.entries.filter(
    (entry) =>
      entry.skipReason === undefined &&
      isGeneratedArtifactPath(entry.path.utf8),
  );
  const generatedObjectIds = new Set(
    generatedEntries.map((entry) => entry.objectId),
  );
  const sourceEntries =
    generatedEntries.length === 0
      ? snapshot.entries
      : snapshot.entries.filter(
          (entry) => !generatedObjectIds.has(entry.objectId),
        );
  const inventory = buildInventoryFacts(snapshot, generatedEntries);
  const violations: ScanViolation[] = [];
  if (snapshot.budgetExceeded) {
    violations.push({ code: 'SCANNED_BYTE_LIMIT_EXCEEDED' });
  }

  // Semantic narrowing uses a deterministic byte-work ceiling. The separate
  // operational wall/CPU watchdog throws without returning evidence, so
  // runtime/JIT speed can never change canonical scan output.
  let remainingScanWork = limits.maxScanWorkBytes;
  const perTermHits: ScanHit[][] = [];
  let totalHits = 0;
  for (const term of terms) {
    const collected = collectTermHits(
      term,
      // A path term names its target, so it still sees generated artifacts.
      term.kind === 'literal-path' ? snapshot.entries : sourceEntries,
      limits.maxHitsPerTerm,
      remainingScanWork,
      operationalDeadline,
      scanCpuStart,
      limits.maxScanCpuMillis,
    );
    if (collected.workLimitExceeded) {
      violations.push({ code: 'SCAN_WORK_LIMIT_EXCEEDED' });
      break;
    }
    remainingScanWork -= collected.workBytes;
    const { hits } = collected;
    if (hits.length > limits.maxHitsPerTerm) {
      violations.push({ code: 'TERM_HIT_LIMIT_EXCEEDED', termId: term.termId });
    }
    totalHits += hits.length;
    perTermHits.push(hits);
  }
  if (totalHits > limits.maxTotalHits) {
    violations.push({ code: 'TOTAL_HIT_LIMIT_EXCEEDED' });
  }
  if (totalHits > limits.maxHitDispositionWorkItems) {
    violations.push({ code: 'HIT_DISPOSITION_WORK_LIMIT_EXCEEDED' });
  }

  assertOperationalScanBudget(
    operationalDeadline,
    scanCpuStart,
    limits.maxScanCpuMillis,
  );
  // A term that hit its own ceiling is the one violation a caller can carry,
  // because the hits it did collect remain true — only their completeness is
  // lost. Every other violation means the scan itself is not sound, so none of
  // them are eligible for this exit.
  const saturatedTermIds = violations
    .filter(({ code }) => code === 'TERM_HIT_LIMIT_EXCEEDED')
    .map(({ termId }) => termId)
    .filter((termId): termId is string => termId !== undefined)
    .sort();
  const onlySaturation =
    saturatedTermIds.length > 0 &&
    violations.every(({ code }) => code === 'TERM_HIT_LIMIT_EXCEEDED');

  if (violations.length > 0 && !(allowSaturatedTerms && onlySaturation)) {
    violations.sort(compareViolations);
    return {
      outcome: 'requires-narrowing',
      policyDigest,
      inventory,
      violations,
      terms,
    };
  }

  const saturated = allowSaturatedTerms ? saturatedTermIds : [];
  const termFacts = terms
    .map((term, index) => ({
      term: structuredClone(term),
      hits: structuredClone(perTermHits[index]!),
    }))
    .sort((left, right) => (left.term.termId < right.term.termId ? -1 : 1));

  return {
    outcome: 'ready',
    facts: {
      schemaVersion: 1,
      kind: 'investigation-scan-facts',
      treeDigest: snapshot.treeDigest,
      policyDigest,
      inventory,
      terms: termFacts,
    },
    ...(saturated.length === 0 ? {} : { saturatedTermIds: saturated }),
  };
}

function readTrackedTreeForScan(
  reader: TrackedObjectReaderPortV1,
  request: Parameters<TrackedObjectReaderPortV1['readPinnedTree']>[0],
): TrackedTreeSnapshot {
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

function adaptTrackedObjectEntry(
  entry: TrackedObjectEntryV1,
): TrackedTreeEntry {
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

function assertScanTerms(terms: ScanInvestigationTerm[]): void {
  const seen = new Set<string>();
  for (const term of terms) {
    let recomputed: NormalizedInvestigationTerm;
    try {
      recomputed = normalizeInvestigationTerm({
        kind: term.kind,
        value: term.value,
      });
    } catch {
      throw scanInvalid('Supplied term is not a valid normalized term.');
    }
    if (
      recomputed.termId !== term.termId ||
      recomputed.matching !== term.matching
    ) {
      throw scanInvalid('Supplied term identity does not match its fields.');
    }
    if (seen.has(term.termId)) {
      throw scanInvalid('Duplicate term ID supplied to scan.');
    }
    seen.add(term.termId);
  }
}

function collectTermHits(
  term: ScanInvestigationTerm,
  entries: TrackedTreeEntry[],
  maxHitsPerTerm: number,
  workBudget: number,
  operationalDeadline: TrackedTreeOperationalDeadline,
  scanCpuStart: NodeJS.CpuUsage,
  maxScanCpuMillis: number,
): {
  hits: ScanHit[];
  workBytes: number;
  workLimitExceeded: boolean;
} {
  const needle = Buffer.from(term.value, 'utf8');
  const hits: ScanHit[] = [];
  const cap = maxHitsPerTerm + 1;
  let workBytes = 0;

  for (const entry of entries) {
    assertOperationalScanBudget(
      operationalDeadline,
      scanCpuStart,
      maxScanCpuMillis,
    );
    const sourceObject = entrySourceObject(entry);
    // A skipped blob suppresses content scanning but never path scanning:
    // `literal-path` still matches the raw tracked path bytes of every entry.
    if (term.kind === 'literal-path') {
      const pathBytes = Buffer.from(entry.path.rawBase64, 'base64');
      if (workBytes + pathBytes.byteLength > workBudget) {
        return { hits: [], workBytes, workLimitExceeded: true };
      }
      workBytes += pathBytes.byteLength;
      for (const offset of findOccurrences(
        pathBytes,
        needle,
        operationalDeadline,
        scanCpuStart,
        maxScanCpuMillis,
      )) {
        hits.push(makeHit(entry.path, sourceObject, 'path', offset, needle));
        if (hits.length >= cap) {
          return {
            hits: sortHits(hits),
            workBytes,
            workLimitExceeded: false,
          };
        }
      }
    }
    if (entry.content !== undefined) {
      if (workBytes + entry.content.byteLength > workBudget) {
        return { hits: [], workBytes, workLimitExceeded: true };
      }
      workBytes += entry.content.byteLength;
      for (const offset of findOccurrences(
        entry.content,
        needle,
        operationalDeadline,
        scanCpuStart,
        maxScanCpuMillis,
      )) {
        hits.push(
          makeHit(
            entry.path,
            sourceObject,
            'content',
            offset,
            needle,
            entry.content,
          ),
        );
        if (hits.length >= cap) {
          return {
            hits: sortHits(hits),
            workBytes,
            workLimitExceeded: false,
          };
        }
      }
    }
  }

  return {
    hits: sortHits(hits),
    workBytes,
    workLimitExceeded: false,
  };
}

function entrySourceObject(entry: TrackedTreeEntry): ScanHitSourceObject {
  return {
    objectId: entry.objectId,
    objectType: entry.objectType,
    mode: entry.mode,
    byteSize: entry.byteSize,
    contentSha256: entry.contentSha256 ?? null,
    skipReason: entry.skipReason ?? null,
  };
}

function makeHit(
  path: TrackedTreePathIdentity,
  sourceObject: ScanHitSourceObject,
  surface: 'path' | 'content',
  byteOffset: number,
  needle: Buffer,
  haystack?: Buffer,
): ScanHit {
  const contextWindow =
    surface === 'content' && haystack !== undefined
      ? hitContextWindow(haystack, byteOffset, needle.length)
      : null;
  return {
    path: { rawBase64: path.rawBase64, utf8: path.utf8 },
    sourceObject,
    surface,
    byteOffset,
    byteLength: needle.length,
    ...(contextWindow === null ? {} : { contextWindow }),
  };
}

function* findOccurrences(
  haystack: Buffer,
  needle: Buffer,
  operationalDeadline: TrackedTreeOperationalDeadline,
  scanCpuStart: NodeJS.CpuUsage,
  maxScanCpuMillis: number,
): Generator<number> {
  let from = 0;
  for (;;) {
    assertOperationalScanBudget(
      operationalDeadline,
      scanCpuStart,
      maxScanCpuMillis,
    );
    const index = haystack.indexOf(needle, from);
    assertOperationalScanBudget(
      operationalDeadline,
      scanCpuStart,
      maxScanCpuMillis,
    );
    if (index === -1) {
      break;
    }
    yield index;
    // Advance by one byte so overlapping occurrences are all reported
    // (for example `ZXZ` occurs at offsets 0 and 2 within `ZXZXZ`).
    from = index + 1;
  }
}

function sortHits(hits: ScanHit[]): ScanHit[] {
  return hits.sort((left, right) => {
    const pathOrder = Buffer.compare(
      Buffer.from(left.path.rawBase64, 'base64'),
      Buffer.from(right.path.rawBase64, 'base64'),
    );
    if (pathOrder !== 0) {
      return pathOrder;
    }
    if (left.surface !== right.surface) {
      return left.surface < right.surface ? -1 : 1;
    }
    return left.byteOffset - right.byteOffset;
  });
}

function buildInventoryFacts(
  snapshot: TrackedTreeSnapshot,
  generatedEntries: readonly TrackedTreeEntry[] = [],
): ScanInventoryFacts {
  const skippedObjects = [
    ...snapshot.entries
      .filter((entry) => entry.skipReason !== undefined)
      .map((entry) => ({
        path: { rawBase64: entry.path.rawBase64, utf8: entry.path.utf8 },
        objectId: entry.objectId,
        objectType: entry.objectType,
        mode: entry.mode,
        byteSize: entry.byteSize,
        reason: entry.skipReason!,
      })),
    ...generatedEntries.map((entry) => ({
      path: { rawBase64: entry.path.rawBase64, utf8: entry.path.utf8 },
      objectId: entry.objectId,
      objectType: entry.objectType,
      mode: entry.mode,
      byteSize: entry.byteSize,
      reason: 'generated-artifact' as const,
    })),
  ].sort((left, right) =>
    left.objectId < right.objectId ? -1 : left.objectId > right.objectId ? 1 : 0,
  );
  return {
    treeDigest: snapshot.treeDigest,
    skippedObjects,
  };
}

function computePolicyDigest(limits: InvestigationLimits): string {
  return sha256(
    canonicalJson({
      schema: POLICY_SCHEMA,
      generatedArtifacts: {
        directorySegments: [...GENERATED_DIRECTORY_SEGMENTS].sort(),
        fileNames: [...GENERATED_FILE_NAMES].sort(),
        fileSuffixes: [...GENERATED_FILE_SUFFIXES],
      },
      limits: {
        maxHitsPerTerm: limits.maxHitsPerTerm,
        maxTotalHits: limits.maxTotalHits,
        maxHitDispositionWorkItems: limits.maxHitDispositionWorkItems,
        maxScanWorkBytes: limits.maxScanWorkBytes,
        maxBlobBytes: limits.maxBlobBytes,
        maxTotalScannedBlobBytes: limits.maxTotalScannedBlobBytes,
      },
    }),
  );
}

function compareViolations(left: ScanViolation, right: ScanViolation): number {
  if (left.code !== right.code) {
    return left.code < right.code ? -1 : 1;
  }
  return (left.termId ?? '') < (right.termId ?? '') ? -1 : 1;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function scanInvalid(message: string) {
  return workflowError('INVESTIGATION_SCAN_INVALID', message, ExitCode.usage);
}

function assertOperationalScanBudget(
  deadline: TrackedTreeOperationalDeadline,
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
