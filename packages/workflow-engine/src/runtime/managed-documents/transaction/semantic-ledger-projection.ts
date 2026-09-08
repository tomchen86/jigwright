/**
 * Projects validated planning and reconciled source bindings into the semantic index.
 *
 * Invariants:
 * - Explanations remain in source headers; import edges bind actual snapshot bytes.
 * - Replays preserve immutable objects and move the index through explicit supersession.
 */

import crypto from 'node:crypto';
import { readFileAtCommit } from '../../repository-transaction/git.ts';
import { loadChangeContract } from '../../../adapters/consumer/repository/work-registry/contracts.ts';
import { PROPOSE_POLICY_DIGEST } from '../../../modules/provider-orchestration/provider-contracts.ts';
import type { GeneratedDocumentMutation } from '../validation/managed-documents.ts';
import { readImportDependencies } from '../../../modules/source/import-dependencies.ts';
import { readSystemDescriptionSnapshot } from '../../repository-transaction/system-description-snapshot.ts';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import type { InvestigationWhyOverlayV3 } from '../../../modules/investigation/manifest/investigation-manifest.ts';
import { normalizeExactRepositoryPath } from '../../session-workspace/paths.ts';
import type { ActualMutation } from '../../../modules/why-knowledge/semantic-reconciliation.ts';
import {
  createLedgerEntry,
  semanticFileSubjectId,
  type LedgerEntry,
  type LedgerEntryInput,
} from '../../../modules/why-knowledge/semantic-ledger.ts';
import {
  assertLedgerIndex,
  readLedgerEntry,
  readLedgerIndex,
  ledgerIndexPath,
  ledgerObjectPath,
  updateLedgerIndex,
  writeLedgerEntry,
  type LedgerIndex,
} from '../../storage-journal/semantic-ledger-store.ts';

export type ReconciledLedgerProjection = Readonly<{
  schemaVersion: 1;
  kind: 'reconciled-semantic-ledger-projection';
  entryIds: readonly string[];
  paths: readonly string[];
  indexDigest: string;
}>;

/** Planning-time v3 projection from one authority-validated Manifest. */
export function projectInvestigationManifestWhyToLedger(input: {
  repositoryRoot: string;
  changeId: string;
  baselineCommit: string;
  whyOverlays: readonly InvestigationWhyOverlayV3[];
  policyDigest: string;
  persist?: boolean;
  priorIndex?: LedgerIndex;
}): Readonly<{ entries: readonly LedgerEntry[]; index: LedgerIndex }> {
  return projectPlanningWhyClaims({
    ...input,
    claims: input.whyOverlays.map((overlay) => ({
      pathIdentity: overlay.pathIdentity,
      contentSha256: overlay.contentSha256,
      semanticDigest: prefixedDigest(
        sha256(
          canonicalJson({ schema: 'investigation-why-overlay.v3', overlay }),
        ),
      ),
      extractorVersion: 'investigation-why-overlay.v3',
      why: overlay.why,
      protectedInvariant: overlay.protectedInvariant,
      reviewerQuestion: overlay.reviewerQuestion,
    })),
  });
}

function projectPlanningWhyClaims(input: {
  repositoryRoot: string;
  changeId: string;
  baselineCommit: string;
  claims: readonly {
    pathIdentity: { rawBase64: string; utf8: string | null };
    contentSha256: string;
    semanticDigest: string;
    extractorVersion: string;
    why: string;
    protectedInvariant: string;
    reviewerQuestion: string;
  }[];
  policyDigest: string;
  persist?: boolean;
  priorIndex?: LedgerIndex;
}): Readonly<{ entries: readonly LedgerEntry[]; index: LedgerIndex }> {
  const priorIndex = input.priorIndex ?? readLedgerIndex(input.repositoryRoot);
  const snapshot = readSystemDescriptionSnapshot(
    input.repositoryRoot,
    input.baselineCommit,
  );
  const seenPaths = new Set<string>();
  const entries = [...input.claims]
    .sort((left, right) => {
      const leftPath = left.pathIdentity.utf8 ?? left.pathIdentity.rawBase64;
      const rightPath = right.pathIdentity.utf8 ?? right.pathIdentity.rawBase64;
      return leftPath.localeCompare(rightPath);
    })
    .map((claim) => {
      const subjectPath = claim.pathIdentity.utf8;
      if (subjectPath === null) {
        throw projectionInvalid(
          'A semantic ledger subject requires a canonical UTF-8 repository path.',
        );
      }
      if (seenPaths.has(subjectPath)) {
        throw projectionInvalid(
          `Semantic ledger projection received duplicate WHY claims for ${subjectPath}.`,
        );
      }
      seenPaths.add(subjectPath);
      const subjectId = semanticFileSubjectId(subjectPath);
      const currentId = priorIndex.subjects[subjectId]?.currentEntryId;
      const current =
        currentId === undefined
          ? null
          : readLedgerEntry(input.repositoryRoot, currentId);
      const entryInput: LedgerEntryInput = {
        schemaVersion: 2,
        kind: 'semantic-ledger-entry',
        subject: { subjectId, kind: 'file', path: subjectPath },
        binding: {
          baselineCommit: input.baselineCommit,
          blobDigest: prefixedDigest(claim.contentSha256),
          sourceDigest: prefixedDigest(claim.contentSha256),
          semanticDigest: claim.semanticDigest,
          extractorVersion: claim.extractorVersion,
        },
        semanticDependencies: readImportDependencies(snapshot, subjectPath),
        policyDigest: prefixedDigest(input.policyDigest),
        provenance: {
          changeId: input.changeId,
          createdAtCommit: input.baselineCommit,
        },
        supersedes: current?.entryId ?? null,
        status: 'current',
      };
      if (current !== null && sameClaim(current, entryInput)) {
        return current;
      }
      return createLedgerEntry(entryInput);
    });

  if (input.persist !== false) {
    for (const entry of entries) writeLedgerEntry(input.repositoryRoot, entry);
    return Object.freeze({
      entries: Object.freeze(entries),
      index: updateLedgerIndex(input.repositoryRoot, entries),
    });
  }
  const subjects = { ...priorIndex.subjects };
  for (const entry of entries)
    subjects[entry.subject.subjectId] = { currentEntryId: entry.entryId };
  return Object.freeze({
    entries: Object.freeze(entries),
    index: { ...priorIndex, subjects },
  });
}

export function planPlanningSemanticLedger(
  repositoryRoot: string,
  changeId: string,
): GeneratedDocumentMutation[] {
  const contract = loadChangeContract(repositoryRoot, changeId);
  const applicability = contract.investigation?.manifest.applicability;
  if (
    applicability?.kind !== 'ordinary' ||
    applicability.semanticDelta.whyOverlays.length === 0
  )
    return [];
  const baselineCommit = applicability.replayContract.baseline.commitOid;
  const prior = readFileAtCommit(
    repositoryRoot,
    baselineCommit,
    ledgerIndexPath(),
  );
  const priorIndex: LedgerIndex =
    prior === undefined
      ? { schemaVersion: 1, kind: 'semantic-ledger-index', subjects: {} }
      : assertLedgerIndex(JSON.parse(prior));
  const { entries, index } = projectInvestigationManifestWhyToLedger({
    repositoryRoot,
    changeId,
    baselineCommit,
    priorIndex,
    whyOverlays: applicability.semanticDelta.whyOverlays,
    policyDigest: PROPOSE_POLICY_DIGEST,
    persist: false,
  });
  return [
    ...entries.map(
      (entry) => [ledgerObjectPath(entry.entryId), entry] as const,
    ),
    [ledgerIndexPath(), index] as const,
  ]
    .map(([relative, value]) => {
      const absolute = path.join(repositoryRoot, relative);
      const before = fs.existsSync(absolute)
        ? fs.readFileSync(absolute, 'utf8')
        : undefined;
      return { path: relative, before, after: `${canonicalJson(value)}\n` };
    })
    .filter((mutation) => mutation.before !== mutation.after);
}

/** Production v3 projection from the current Manifest's validated WHY facts. */
export function projectReconciledInvestigationManifestWhyToLedger(input: {
  repositoryRoot: string;
  changeId: string;
  baselineCommit: string;
  whyOverlays: readonly InvestigationWhyOverlayV3[];
  policyDigest: string;
  actualMutations: readonly ActualMutation[];
}): ReconciledLedgerProjection | null {
  return projectReconciledWhyClaims({
    ...input,
    claims: input.whyOverlays.map((overlay) => ({
      identity: overlay.overlayId,
      pathIdentity: overlay.pathIdentity,
      why: overlay.why,
      protectedInvariant: overlay.protectedInvariant,
      reviewerQuestion: overlay.reviewerQuestion,
    })),
  });
}

function projectReconciledWhyClaims(input: {
  repositoryRoot: string;
  changeId: string;
  baselineCommit: string;
  claims: readonly {
    identity: string;
    pathIdentity: { rawBase64: string; utf8: string | null };
    why: string;
    protectedInvariant: string;
    reviewerQuestion: string;
  }[];
  policyDigest: string;
  actualMutations: readonly ActualMutation[];
}): ReconciledLedgerProjection | null {
  const priorIndex = readLedgerIndex(input.repositoryRoot);
  const snapshot = readSystemDescriptionSnapshot(input.repositoryRoot);
  const actualBySubject = new Map(
    input.actualMutations.map((mutation) => [mutation.subjectId, mutation]),
  );
  const entries: LedgerEntry[] = [];
  const seenSubjects = new Set<string>();
  for (const claim of [...input.claims].sort((left, right) =>
    left.identity.localeCompare(right.identity),
  )) {
    if (claim.pathIdentity.utf8 === null) {
      throw projectionInvalid(
        'A reconciled semantic ledger subject requires a canonical UTF-8 path.',
      );
    }
    const subjectPath = normalizeExactRepositoryPath(claim.pathIdentity.utf8);
    const subjectId = semanticFileSubjectId(subjectPath);
    const mutation = actualBySubject.get(subjectId);
    if (mutation === undefined) continue;
    if (seenSubjects.has(subjectId)) {
      throw projectionInvalid(
        `Reconciled ledger projection received duplicate WHY claims for ${subjectPath}.`,
      );
    }
    seenSubjects.add(subjectId);
    const currentId = priorIndex.subjects[subjectId]?.currentEntryId;
    const current =
      currentId === undefined
        ? null
        : readLedgerEntry(input.repositoryRoot, currentId);
    const source = readCurrentSource(input.repositoryRoot, subjectPath);
    if (source === null && mutation.disposition !== 'subject-deleted') {
      throw projectionInvalid(
        `Reconciled subject ${subjectPath} is missing without a deletion disposition.`,
      );
    }
    if (source !== null && mutation.disposition === 'subject-deleted') {
      throw projectionInvalid(
        `Reconciled subject ${subjectPath} still exists despite a deletion disposition.`,
      );
    }
    if (source === null && current === null) continue;
    const sourceDigest = prefixedDigest(
      sha256(source ?? Buffer.from('deleted', 'utf8')),
    );
    const entry = createLedgerEntry({
      schemaVersion: 2,
      kind: 'semantic-ledger-entry',
      subject: { subjectId, kind: 'file', path: subjectPath },
      binding: {
        baselineCommit: input.baselineCommit,
        blobDigest: sourceDigest,
        sourceDigest,
        semanticDigest: prefixedDigest(
          sha256(
            canonicalJson({
              schema: 'implementation-reconciliation-exact-source.v1',
              sourceDigest,
              disposition: mutation.disposition,
            }),
          ),
        ),
        extractorVersion: 'implementation-reconciliation-exact-source.v1',
      },
      semanticDependencies: readImportDependencies(snapshot, subjectPath),
      policyDigest: prefixedDigest(input.policyDigest),
      provenance: {
        changeId: input.changeId,
        createdAtCommit: input.baselineCommit,
      },
      supersedes: current?.entryId ?? null,
      status: source === null ? 'tombstone' : 'current',
    });
    entries.push(entry);
  }
  if (entries.length === 0) return null;
  const paths = entries.map((entry) =>
    writeLedgerEntry(input.repositoryRoot, entry),
  );
  const index = updateLedgerIndex(input.repositoryRoot, entries);
  paths.push(ledgerIndexPath());
  return Object.freeze({
    schemaVersion: 1,
    kind: 'reconciled-semantic-ledger-projection',
    entryIds: Object.freeze(entries.map(({ entryId }) => entryId).sort()),
    paths: Object.freeze([...new Set(paths)].sort()),
    indexDigest: sha256(canonicalJson(index)),
  });
}

export function assertReconciledLedgerProjection(
  repositoryRoot: string,
  candidate: unknown,
): ReconciledLedgerProjection {
  if (
    !isPlainRecord(candidate) ||
    !hasExactKeys(candidate, [
      'schemaVersion',
      'kind',
      'entryIds',
      'paths',
      'indexDigest',
    ]) ||
    candidate.schemaVersion !== 1 ||
    candidate.kind !== 'reconciled-semantic-ledger-projection' ||
    !Array.isArray(candidate.entryIds) ||
    !Array.isArray(candidate.paths) ||
    typeof candidate.indexDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(candidate.indexDigest)
  ) {
    throw projectionInvalid(
      'Reconciled semantic ledger projection is malformed.',
    );
  }
  const entryIds = canonicalStringArray(candidate.entryIds, 'entry identities');
  const paths = canonicalStringArray(candidate.paths, 'projection paths');
  const expectedPaths = [
    ...entryIds.map(ledgerObjectPath),
    ledgerIndexPath(),
  ].sort();
  if (canonicalJson(paths) !== canonicalJson(expectedPaths)) {
    throw projectionInvalid(
      'Reconciled semantic ledger projection paths are inconsistent.',
    );
  }
  const entries = entryIds.map((entryId) =>
    readLedgerEntry(repositoryRoot, entryId),
  );
  const index = readLedgerIndex(repositoryRoot);
  if (candidate.indexDigest !== sha256(canonicalJson(index))) {
    throw projectionInvalid(
      'Reconciled semantic ledger index changed after projection.',
    );
  }
  for (const entry of entries) {
    const current = index.subjects[entry.subject.subjectId]?.currentEntryId;
    if (
      (entry.status === 'current' && current !== entry.entryId) ||
      (entry.status === 'tombstone' && current !== undefined)
    ) {
      throw projectionInvalid(
        'Reconciled semantic ledger authority is no longer current.',
      );
    }
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'reconciled-semantic-ledger-projection',
    entryIds: Object.freeze(entryIds),
    paths: Object.freeze(paths),
    indexDigest: candidate.indexDigest,
  });
}

function sameClaim(current: LedgerEntry, candidate: LedgerEntryInput): boolean {
  return (
    canonicalJson({
      subject: current.subject,
      binding: current.binding,
      semanticDependencies: current.semanticDependencies,
      policyDigest: current.policyDigest,
    }) ===
    canonicalJson({
      subject: candidate.subject,
      binding: candidate.binding,
      semanticDependencies: candidate.semanticDependencies,
      policyDigest: candidate.policyDigest,
    })
  );
}

function prefixedDigest(value: string): string {
  const normalized = value.replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw projectionInvalid(
      'Semantic ledger projection received a bad digest.',
    );
  }
  return `sha256:${normalized}`;
}

function readCurrentSource(
  repositoryRoot: string,
  subjectPath: string,
): Buffer | null {
  const normalized = normalizeExactRepositoryPath(subjectPath);
  const absolute = path.join(repositoryRoot, normalized);
  const repositoryReal = fs.realpathSync.native(repositoryRoot);
  const parentReal = fs.realpathSync.native(path.dirname(absolute));
  const relativeParent = path.relative(repositoryReal, parentReal);
  if (
    relativeParent === '..' ||
    relativeParent.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeParent)
  ) {
    throw projectionInvalid(
      'A reconciled ledger source escapes the repository.',
    );
  }
  const before = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (before === undefined) return null;
  if (before.isSymbolicLink()) {
    const link = fs.readlinkSync(absolute, 'buffer');
    const after = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      after === undefined ||
      !after.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw projectionInvalid(
        'A reconciled ledger symlink changed while read.',
      );
    }
    return link;
  }
  if (!before.isFile()) {
    throw projectionInvalid('A reconciled ledger source is not a plain file.');
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      throw projectionInvalid(
        'A reconciled ledger source changed while opened.',
      );
    }
    const content = fs.readFileSync(descriptor);
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      !afterDescriptor.isFile() ||
      afterPath === undefined ||
      !afterPath.isFile() ||
      afterDescriptor.dev !== opened.dev ||
      afterDescriptor.ino !== opened.ino ||
      afterDescriptor.size !== opened.size ||
      afterPath.dev !== opened.dev ||
      afterPath.ino !== opened.ino
    ) {
      throw projectionInvalid('A reconciled ledger source changed while read.');
    }
    return content;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function canonicalStringArray(value: unknown[], label: string): string[] {
  if (
    value.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.length === 0 ||
        entry.trim() !== entry ||
        /\p{Cc}/u.test(entry),
    )
  ) {
    throw projectionInvalid(
      `Reconciled semantic ledger ${label} are malformed.`,
    );
  }
  const canonical = [...(value as string[])].sort();
  if (
    new Set(canonical).size !== canonical.length ||
    canonicalJson(canonical) !== canonicalJson(value)
  ) {
    throw projectionInvalid(
      `Reconciled semantic ledger ${label} are not canonical.`,
    );
  }
  return canonical;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join('\0') === [...expected].sort().join('\0')
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function projectionInvalid(message: string) {
  return workflowError(
    'SEMANTIC_LEDGER_PROJECTION_INVALID',
    message,
    ExitCode.guard,
  );
}
