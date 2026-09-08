/**
 * Reads, quarantines, and compare-and-swaps canonical evidence ref documents.
 *
 * Invariants:
 * - Ref changes retain exact expected node or document digests under the ref lock.
 * - Publication validates every target node and keeps rename and fsync ordering.
 *
 * Depends on: evidence node readers, ref locking, canonical JSON, and private files.
 * Failure modes: concurrent writers overwrite refs or a ref points to missing or invalid evidence.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type InvestigationRuntimePaths,
  assertChangeId,
} from '../session-workspace/paths.ts';
import { readEvidenceNode } from './evidence-node-store.ts';
import {
  assertNoFollowDirectory,
  assertPrivateFileStats,
  ensureNoFollowDirectory,
  fsyncDirectory,
  NO_FOLLOW_CREATE,
  readNoFollow,
} from './evidence-private-files.ts';
import { withRefLock } from './evidence-ref-lock.ts';
import {
  assertNodeId,
  assertRefName,
  DIGEST_PATTERN,
  evidenceObjectPath,
  evidenceRefPath,
  hasExactKeys,
  isDigest,
  isPlainRecord,
  objectUnavailable,
  objectUnsafe,
  REF_NAME_PATTERN,
  refCasMismatch,
  refInvalid,
  refsDocumentCasMismatch,
  refUnsafe,
  sha256,
} from './evidence-store-values.ts';
import { exactUnsafePathObservationDigest } from './evidence-unsafe-observation.ts';

export type CompareAndSwapEvidenceRefParams = {
  changeId: string;
  refName: string;
  expectedNodeId: string | null;
  nextNodeId: string;
};

export type EvidenceRefsSnapshot = Readonly<{
  rawDocument: string | null;
  digest: string | null;
  refs: Readonly<Record<string, string>> | null;
}>;

export type CompareAndSwapEvidenceRefsDocumentParams = {
  changeId: string;
  expectedDigest: string | null;
  nextRefs: Record<string, string> | null;
};

export function readEvidenceRefs(
  paths: InvestigationRuntimePaths,
  changeId: string,
): Record<string, string> {
  assertChangeId(changeId);
  const refPath = evidenceRefPath(paths, changeId);
  if (!assertNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe)) {
    return {};
  }
  const stats = fs.lstatSync(refPath, { throwIfNoEntry: false });
  if (!stats) {
    return {};
  }
  const content = readNoFollow(refPath, refUnsafe);
  return parseRefDocument(content, changeId);
}

export function readEvidenceRefsSnapshot(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
): EvidenceRefsSnapshot {
  const changeId = assertChangeId(requestedChangeId);
  const refPath = evidenceRefPath(paths, changeId);
  if (!assertNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe)) {
    return absentEvidenceRefsSnapshot();
  }
  const stats = fs.lstatSync(refPath, { throwIfNoEntry: false });
  if (!stats) {
    return absentEvidenceRefsSnapshot();
  }
  const rawDocument = readNoFollow(refPath, refUnsafe);
  const refs = parseRefDocument(rawDocument, changeId);
  return Object.freeze({
    rawDocument,
    digest: sha256(rawDocument),
    refs: Object.freeze({ ...refs }),
  });
}

export function quarantineUnsafeEvidenceRefsDocument(
  paths: InvestigationRuntimePaths,
  requestedChangeId: string,
  expectedObservationDigest: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  if (!DIGEST_PATTERN.test(expectedObservationDigest)) {
    throw refInvalid();
  }
  const source = evidenceRefPath(paths, changeId);
  const quarantineDirectory = path.join(
    paths.root,
    'human-resolutions',
    'quarantine',
  );
  const target = path.join(
    quarantineDirectory,
    `${changeId}.${expectedObservationDigest}.evidence-refs.artifact`,
  );
  return withRefLock(paths, changeId, () => {
    ensureNoFollowDirectory(
      paths.base,
      paths.root,
      quarantineDirectory,
      refUnsafe,
    );
    const sourceStats = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!sourceStats) {
      if (
        fs.lstatSync(target, { throwIfNoEntry: false }) &&
        exactUnsafePathObservationDigest(target, 'evidence-refs') ===
          expectedObservationDigest
      ) {
        return target;
      }
      throw refsDocumentCasMismatch(expectedObservationDigest, null, null);
    }
    if (
      exactUnsafePathObservationDigest(source, 'evidence-refs') !==
      expectedObservationDigest
    ) {
      throw refsDocumentCasMismatch(
        expectedObservationDigest,
        exactUnsafePathObservationDigest(source, 'evidence-refs'),
        null,
      );
    }
    if (fs.lstatSync(target, { throwIfNoEntry: false })) {
      throw refInvalid();
    }
    fs.renameSync(source, target);
    fsyncDirectory(paths.refs);
    fsyncDirectory(quarantineDirectory);
    if (
      exactUnsafePathObservationDigest(target, 'evidence-refs') !==
      expectedObservationDigest
    ) {
      throw refInvalid();
    }
    return target;
  });
}

export function compareAndSwapEvidenceRefsDocument(
  paths: InvestigationRuntimePaths,
  params: CompareAndSwapEvidenceRefsDocumentParams,
): EvidenceRefsSnapshot {
  const changeId = assertChangeId(params.changeId);
  if (
    params.expectedDigest !== null &&
    !DIGEST_PATTERN.test(params.expectedDigest)
  ) {
    throw refInvalid();
  }
  const nextRefs =
    params.nextRefs === null
      ? null
      : validateEvidenceRefsForPublication(paths, params.nextRefs);
  const nextDigest =
    nextRefs === null ? null : sha256(canonicalRefDocument(changeId, nextRefs));

  return withRefLock(paths, changeId, () => {
    const current = readEvidenceRefsSnapshot(paths, changeId);
    if (current.digest === nextDigest) {
      return current;
    }
    if (current.digest !== params.expectedDigest) {
      throw refsDocumentCasMismatch(
        params.expectedDigest,
        current.digest,
        nextDigest,
      );
    }
    if (nextRefs === null) {
      fs.unlinkSync(evidenceRefPath(paths, changeId));
      fsyncDirectory(paths.refs);
    } else {
      writeRefDocument(paths, changeId, nextRefs);
    }
    const published = readEvidenceRefsSnapshot(paths, changeId);
    if (published.digest !== nextDigest) {
      throw refInvalid();
    }
    return published;
  });
}

export function compareAndSwapEvidenceRef(
  paths: InvestigationRuntimePaths,
  params: CompareAndSwapEvidenceRefParams,
): void {
  assertChangeId(params.changeId);
  assertRefName(params.refName);
  assertNodeId(params.nextNodeId);
  if (
    params.expectedNodeId !== null &&
    !DIGEST_PATTERN.test(params.expectedNodeId)
  ) {
    throw refInvalid();
  }
  const nextObjectPath = evidenceObjectPath(paths, params.nextNodeId);
  const nextDirectoryExists = assertNoFollowDirectory(
    paths.base,
    paths.root,
    path.dirname(nextObjectPath),
    objectUnsafe,
  );
  if (
    !nextDirectoryExists ||
    !fs.lstatSync(nextObjectPath, { throwIfNoEntry: false })
  ) {
    throw objectUnavailable(params.nextNodeId);
  }
  readEvidenceNode(paths, params.nextNodeId);

  withRefLock(paths, params.changeId, () => {
    const current = readEvidenceRefs(paths, params.changeId);
    const observed = current[params.refName] ?? null;
    if (observed !== (params.expectedNodeId ?? null)) {
      throw refCasMismatch(params.refName, params.expectedNodeId, observed);
    }
    const next = { ...current, [params.refName]: params.nextNodeId };
    writeRefDocument(paths, params.changeId, next);
  });
}

function parseRefDocument(
  content: string,
  changeId: string,
): Record<string, string> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw refInvalid();
  }
  if (
    !isPlainRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'changeId', 'refs']) ||
    value.schemaVersion !== 1 ||
    value.changeId !== changeId ||
    !isPlainRecord(value.refs)
  ) {
    throw refInvalid();
  }
  const refs = value.refs as Record<string, unknown>;
  for (const [name, digest] of Object.entries(refs)) {
    if (!REF_NAME_PATTERN.test(name) || !isDigest(digest)) {
      throw refInvalid();
    }
  }
  if (content !== canonicalJson(value)) {
    throw refInvalid();
  }
  return refs as Record<string, string>;
}

function writeRefDocument(
  paths: InvestigationRuntimePaths,
  changeId: string,
  refs: Record<string, string>,
): void {
  const refPath = evidenceRefPath(paths, changeId);
  const content = canonicalRefDocument(changeId, refs);
  ensureNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe);
  const existing = fs.lstatSync(refPath, { throwIfNoEntry: false });
  if (existing) {
    assertPrivateFileStats(existing, refUnsafe);
  }
  const temporary = `${refPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, NO_FOLLOW_CREATE, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    ensureNoFollowDirectory(paths.base, paths.root, paths.refs, refUnsafe);
    const current = fs.lstatSync(refPath, { throwIfNoEntry: false });
    if (current) {
      assertPrivateFileStats(current, refUnsafe);
    }
    fs.renameSync(temporary, refPath);
    fsyncDirectory(paths.refs);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function validateEvidenceRefsForPublication(
  paths: InvestigationRuntimePaths,
  refs: Record<string, string>,
): Record<string, string> {
  if (!isPlainRecord(refs)) {
    throw refInvalid();
  }
  const validated: Record<string, string> = {};
  for (const [name, nodeId] of Object.entries(refs)) {
    assertRefName(name);
    assertNodeId(nodeId);
    readEvidenceNode(paths, nodeId);
    validated[name] = nodeId;
  }
  return validated;
}

function canonicalRefDocument(
  changeId: string,
  refs: Record<string, string>,
): string {
  return canonicalJson({ schemaVersion: 1, changeId, refs });
}

function absentEvidenceRefsSnapshot(): EvidenceRefsSnapshot {
  return Object.freeze({
    rawDocument: null,
    digest: null,
    refs: null,
  });
}
