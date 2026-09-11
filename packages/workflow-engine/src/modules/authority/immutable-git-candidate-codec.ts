/**
 * Decodes immutable Git candidates and validates their canonical patch,
 * policy and check bindings.
 *
 * Invariants:
 * - The candidate identity is recomputed from the canonical body and must
 *   equal the supplied identity.
 * - Patch-manifest files must be strictly ascending by canonical UTF-8 path
 *   and unique case-insensitively.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import {
  ExitCode,
  workflowError,
  type ExitCodeValue,
} from '../../foundation/errors/errors.ts';
import {
  parseChecksConfigSource,
  type CheckDefinition,
} from '../source/check-command.ts';
import { normalizeExactRepositoryPath } from '../../foundation/repository-path/repository-path.ts';
import type {
  GitObjectFormat,
  ImmutableGitCandidateV1,
  ImmutableGitCheckObservation,
  ImmutableGitObjectIdentity,
  ImmutableGitPatchEntry,
  ImmutableGitPatchManifestV1,
  ImmutableGitPolicyObservation,
  PolicyObservationBinding,
  Sha256Digest,
} from './immutable-git-candidate.ts';

export const POLICY_PATH = 'workflow/maintainer-policy.json';

export const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const REPOSITORY_ID =
  /^[a-z][a-z0-9.-]*:[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export const TARGET_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export function canonicalImmutableGitCandidate(
  candidate: ImmutableGitCandidateV1,
): string {
  return `${canonicalJson(parseImmutableGitCandidate(candidate))}\n`;
}

export function parseImmutableGitCandidate(
  value: string | unknown,
): ImmutableGitCandidateV1 {
  let parsed: unknown = value;
  try {
    if (typeof value === 'string') {
      if (Buffer.byteLength(value) > 2 * 1024 * 1024) {
        throw new Error('candidate is too large');
      }
      parsed = JSON.parse(value) as unknown;
    }
  } catch {
    throw candidateInvalid();
  }
  if (
    !isRecord(parsed) ||
    !hasExactKeys(parsed, [
      'schemaVersion',
      'kind',
      'repositoryId',
      'repositoryOrigin',
      'targetRef',
      'expectedOldCommit',
      'expectedOldTree',
      'indexTree',
      'worktreeStateDigest',
      'resultTree',
      'manifest',
      'manifestDigest',
      'policyObservations',
      'policyObservationsDigest',
      'checkObservations',
      'checkObservationsDigest',
      'candidateDigest',
    ]) ||
    parsed.schemaVersion !== 1 ||
    parsed.kind !== 'immutable-git-candidate.v1' ||
    typeof parsed.repositoryId !== 'string' ||
    !REPOSITORY_ID.test(parsed.repositoryId) ||
    typeof parsed.repositoryOrigin !== 'string' ||
    !isRepositoryOrigin(parsed.repositoryOrigin) ||
    typeof parsed.targetRef !== 'string' ||
    !TARGET_REF.test(parsed.targetRef) ||
    typeof parsed.worktreeStateDigest !== 'string' ||
    !SHA256_DIGEST.test(parsed.worktreeStateDigest) ||
    typeof parsed.manifestDigest !== 'string' ||
    !SHA256_DIGEST.test(parsed.manifestDigest) ||
    typeof parsed.policyObservationsDigest !== 'string' ||
    !SHA256_DIGEST.test(parsed.policyObservationsDigest) ||
    typeof parsed.checkObservationsDigest !== 'string' ||
    !SHA256_DIGEST.test(parsed.checkObservationsDigest) ||
    typeof parsed.candidateDigest !== 'string' ||
    !SHA256_DIGEST.test(parsed.candidateDigest)
  ) {
    throw candidateInvalid();
  }
  const manifest = assertPatchManifest(parsed.manifest);
  const objectFormat = manifest.objectFormat;
  if (
    !isObjectId(parsed.expectedOldCommit, objectFormat) ||
    !isObjectId(parsed.expectedOldTree, objectFormat) ||
    !isObjectId(parsed.indexTree, objectFormat) ||
    !isObjectId(parsed.resultTree, objectFormat) ||
    parsed.expectedOldCommit !== manifest.baseCommit ||
    parsed.expectedOldTree !== manifest.baseTree ||
    parsed.indexTree !== manifest.baseTree ||
    parsed.resultTree !== manifest.resultTree ||
    parsed.resultTree === parsed.expectedOldTree ||
    parsed.manifestDigest !== sha256(canonicalJson(manifest))
  ) {
    throw candidateInvalid();
  }
  const policyObservations = assertPolicyObservations(
    parsed.policyObservations,
    manifest,
  );
  const checkObservations = assertCheckObservations(parsed.checkObservations);
  if (
    parsed.policyObservationsDigest !==
      sha256(canonicalJson(policyObservations)) ||
    parsed.checkObservationsDigest !== sha256(canonicalJson(checkObservations))
  ) {
    throw candidateInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'immutable-git-candidate.v1' as const,
    repositoryId: parsed.repositoryId,
    repositoryOrigin: parsed.repositoryOrigin,
    targetRef: parsed.targetRef,
    expectedOldCommit: parsed.expectedOldCommit,
    expectedOldTree: parsed.expectedOldTree,
    indexTree: parsed.indexTree,
    worktreeStateDigest: parsed.worktreeStateDigest as Sha256Digest,
    resultTree: parsed.resultTree,
    manifest,
    manifestDigest: parsed.manifestDigest as Sha256Digest,
    policyObservations,
    policyObservationsDigest: parsed.policyObservationsDigest as Sha256Digest,
    checkObservations,
    checkObservationsDigest: parsed.checkObservationsDigest as Sha256Digest,
  };
  if (parsed.candidateDigest !== sha256(canonicalJson(body))) {
    throw candidateInvalid();
  }
  const candidate = freezeCanonical({
    ...body,
    candidateDigest: parsed.candidateDigest as Sha256Digest,
  });
  if (typeof value === 'string' && value !== `${canonicalJson(candidate)}\n`) {
    throw candidateInvalid();
  }
  return candidate;
}

function assertPatchManifest(value: unknown): ImmutableGitPatchManifestV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'objectFormat',
      'baseCommit',
      'baseTree',
      'resultTree',
      'files',
      'patchDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'immutable-git-patch-manifest.v1' ||
    (value.objectFormat !== 'sha1' && value.objectFormat !== 'sha256') ||
    !isObjectId(value.baseCommit, value.objectFormat) ||
    !isObjectId(value.baseTree, value.objectFormat) ||
    !isObjectId(value.resultTree, value.objectFormat) ||
    value.baseTree === value.resultTree ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    typeof value.patchDigest !== 'string' ||
    !SHA256_DIGEST.test(value.patchDigest)
  ) {
    throw candidateInvalid();
  }
  const files = value.files.map((entry) =>
    assertPatchEntry(entry, value.objectFormat as GitObjectFormat),
  );
  if (
    files.some(
      (file, index) =>
        index > 0 &&
        compareCanonicalUtf8(file.path, files[index - 1]!.path) <= 0,
    ) ||
    new Set(files.map(({ path: filePath }) => filePath.toLowerCase())).size !==
      files.length
  ) {
    throw candidateInvalid();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'immutable-git-patch-manifest.v1' as const,
    objectFormat: value.objectFormat as GitObjectFormat,
    baseCommit: value.baseCommit,
    baseTree: value.baseTree,
    resultTree: value.resultTree,
    files,
  };
  if (value.patchDigest !== sha256(canonicalJson(body))) {
    throw candidateInvalid();
  }
  return freezeCanonical({
    ...body,
    patchDigest: value.patchDigest as Sha256Digest,
  });
}

function assertPatchEntry(
  value: unknown,
  objectFormat: GitObjectFormat,
): ImmutableGitPatchEntry {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['path', 'operation', 'before', 'after']) ||
    typeof value.path !== 'string' ||
    !['add', 'modify', 'delete'].includes(String(value.operation))
  ) {
    throw candidateInvalid();
  }
  let normalized: string;
  try {
    normalized = normalizeExactRepositoryPath(value.path);
  } catch {
    throw candidateInvalid();
  }
  const before =
    value.before === null
      ? null
      : assertObjectIdentity(value.before, objectFormat);
  const after =
    value.after === null
      ? null
      : assertObjectIdentity(value.after, objectFormat);
  if (
    normalized !== value.path ||
    (value.operation === 'add' && (before !== null || after === null)) ||
    (value.operation === 'modify' && (before === null || after === null)) ||
    (value.operation === 'delete' && (before === null || after !== null)) ||
    (before !== null && after !== null && before.objectId === after.objectId)
  ) {
    throw candidateInvalid();
  }
  return freezeCanonical({
    path: normalized,
    operation: value.operation as 'add' | 'modify' | 'delete',
    before,
    after,
  });
}

function assertObjectIdentity(
  value: unknown,
  objectFormat: GitObjectFormat,
): ImmutableGitObjectIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'objectId',
      'objectType',
      'mode',
      'sha256',
      'size',
    ]) ||
    !isObjectId(value.objectId, objectFormat) ||
    value.objectType !== 'blob' ||
    (value.mode !== '100644' && value.mode !== '100755') ||
    typeof value.sha256 !== 'string' ||
    !SHA256_DIGEST.test(value.sha256) ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) < 0
  ) {
    throw candidateInvalid();
  }
  return freezeCanonical({
    objectId: value.objectId,
    objectType: 'blob' as const,
    mode: value.mode,
    sha256: value.sha256 as Sha256Digest,
    size: Number(value.size),
  });
}

function assertPolicyObservations(
  value: unknown,
  manifest: ImmutableGitPatchManifestV1,
): readonly ImmutableGitPolicyObservation[] {
  if (!Array.isArray(value)) throw candidateInvalid();
  const policy = manifest.files.find(
    ({ path: filePath }) => filePath === POLICY_PATH,
  );
  const observations = value.map((entry) =>
    assertPolicyObservation(entry, policy),
  );
  if (
    observations.some(
      (entry, index) =>
        index > 0 && compareObservation(observations[index - 1]!, entry) >= 0,
    )
  ) {
    throw candidateInvalid();
  }
  return freezeCanonical(observations);
}

function assertPolicyObservation(
  value: unknown,
  policy: ImmutableGitPatchEntry | undefined,
): ImmutableGitPolicyObservation {
  if (!isRecord(value) || !policy?.before) throw candidateInvalid();
  const commonKeys = [
    'kind',
    'path',
    'baseObjectId',
    'resultObjectId',
    'baseContentDigest',
    'resultContentDigest',
  ];
  const extraKeys =
    value.kind === 'policy-sealed-phase-rollback.v1'
      ? ['beforePhase', 'afterPhase']
      : value.kind === 'policy-sealed-immutable-path-removal.v1'
        ? ['removedPaths']
        : value.kind === 'policy-required-check-removal.v1'
          ? ['removedCheckIds']
          : value.kind === 'policy-bytes-unrecognized.v1'
            ? ['unrecognizedSide']
            : value.kind === 'policy-file-deletion.v1'
              ? []
              : null;
  if (
    extraKeys === null ||
    !hasExactKeys(value, [...commonKeys, ...extraKeys]) ||
    value.path !== POLICY_PATH ||
    value.baseObjectId !== policy.before.objectId ||
    value.resultObjectId !== (policy.after?.objectId ?? null) ||
    value.baseContentDigest !== policy.before.sha256 ||
    value.resultContentDigest !== (policy.after?.sha256 ?? null)
  ) {
    throw candidateInvalid();
  }
  const binding: PolicyObservationBinding = {
    path: POLICY_PATH,
    baseObjectId: value.baseObjectId as string,
    resultObjectId: value.resultObjectId as string | null,
    baseContentDigest: value.baseContentDigest as Sha256Digest,
    resultContentDigest: value.resultContentDigest as Sha256Digest | null,
  };
  if (value.kind === 'policy-file-deletion.v1') {
    if (policy.operation !== 'delete') throw candidateInvalid();
    return freezeCanonical({ kind: value.kind, ...binding });
  }
  if (policy.operation !== 'modify') throw candidateInvalid();
  if (value.kind === 'policy-sealed-phase-rollback.v1') {
    if (
      value.beforePhase !== 'sealed' ||
      typeof value.afterPhase !== 'string' ||
      value.afterPhase.length < 1 ||
      value.afterPhase === 'sealed'
    ) {
      throw candidateInvalid();
    }
    return freezeCanonical({
      kind: value.kind,
      ...binding,
      beforePhase: 'sealed' as const,
      afterPhase: value.afterPhase,
    });
  }
  if (value.kind === 'policy-sealed-immutable-path-removal.v1') {
    const removedPaths = assertSortedStrings(value.removedPaths);
    return freezeCanonical({ kind: value.kind, ...binding, removedPaths });
  }
  if (value.kind === 'policy-required-check-removal.v1') {
    const removedCheckIds = assertSortedStrings(
      value.removedCheckIds,
      CHECK_ID,
    );
    return freezeCanonical({ kind: value.kind, ...binding, removedCheckIds });
  }
  if (
    value.unrecognizedSide !== 'base' &&
    value.unrecognizedSide !== 'result' &&
    value.unrecognizedSide !== 'both'
  ) {
    throw candidateInvalid();
  }
  return freezeCanonical({
    kind: 'policy-bytes-unrecognized.v1' as const,
    ...binding,
    unrecognizedSide: value.unrecognizedSide,
  });
}

function assertCheckObservations(
  value: unknown,
): readonly ImmutableGitCheckObservation[] {
  if (!Array.isArray(value)) throw candidateInvalid();
  const checks = value.map(assertCheckObservation);
  if (
    checks.some(
      (check, index) =>
        index > 0 && check.checkId <= checks[index - 1]!.checkId,
    )
  ) {
    throw candidateInvalid();
  }
  return freezeCanonical(checks);
}

function assertCheckObservation(value: unknown): ImmutableGitCheckObservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'checkId',
      'definition',
      'definitionDigest',
      'commandDigest',
      'runner',
      'runnerDigest',
      'observationDigest',
    ]) ||
    typeof value.checkId !== 'string' ||
    !CHECK_ID.test(value.checkId) ||
    typeof value.definitionDigest !== 'string' ||
    !SHA256_DIGEST.test(value.definitionDigest) ||
    typeof value.commandDigest !== 'string' ||
    !SHA256_DIGEST.test(value.commandDigest) ||
    typeof value.runner !== 'string' ||
    value.runner.length < 1 ||
    typeof value.runnerDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.runnerDigest) ||
    typeof value.observationDigest !== 'string' ||
    !SHA256_DIGEST.test(value.observationDigest)
  ) {
    throw candidateInvalid();
  }
  const definition = assertExactCheckDefinition(
    value.checkId,
    value.definition,
  );
  const body = {
    checkId: value.checkId,
    definition,
    definitionDigest: value.definitionDigest as Sha256Digest,
    commandDigest: value.commandDigest as Sha256Digest,
    runner: value.runner,
    runnerDigest: value.runnerDigest,
  };
  if (
    value.definitionDigest !== sha256(canonicalJson(definition)) ||
    value.commandDigest !== sha256(canonicalJson(definition.command)) ||
    value.observationDigest !== sha256(canonicalJson(body))
  ) {
    throw candidateInvalid();
  }
  return freezeCanonical({
    ...body,
    observationDigest: value.observationDigest as Sha256Digest,
  });
}

function assertExactCheckDefinition(
  checkId: string,
  value: unknown,
): CheckDefinition {
  const parsed = parseChecksConfigSource({
    schemaVersion: 1,
    checks: { [checkId]: value },
  });
  if (!parsed.ok) throw candidateInvalid();
  const definition = parsed.value.checks[checkId];
  if (
    definition === undefined ||
    canonicalJson(definition) !== canonicalJson(value)
  ) {
    throw candidateInvalid();
  }
  return freezeCanonical(definition);
}

export function isRepositoryOrigin(value: string): boolean {
  if (
    value.trim() !== value ||
    Buffer.byteLength(value, 'utf8') > 2048 ||
    /[\0\r\n]/u.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.search === '' &&
      parsed.hash === '' &&
      parsed.hostname.length > 0
    );
  } catch {
    return false;
  }
}

export function compareObservation(
  left: ImmutableGitPolicyObservation,
  right: ImmutableGitPolicyObservation,
): number {
  return compareCanonicalUtf8(left.kind, right.kind);
}

export function compareCanonicalUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertSortedStrings(
  value: unknown,
  pattern?: RegExp,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.some(
      (entry) =>
        typeof entry !== 'string' ||
        entry.length < 1 ||
        entry.trim() !== entry ||
        /[\0\r\n]/u.test(entry) ||
        (pattern !== undefined && !pattern.test(entry)),
    ) ||
    value.some((entry, index) => index > 0 && entry <= value[index - 1])
  ) {
    throw candidateInvalid();
  }
  return Object.freeze([...value]) as readonly string[];
}

export function isObjectId(
  value: unknown,
  objectFormat: GitObjectFormat,
): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^[0-9a-f]{${objectFormat === 'sha1' ? 40 : 64}}$`).test(value)
  );
}

export function sha256(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

export function freezeCanonical<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach((entry) => deepFreeze(entry));
  }
  return value;
}

export function candidateInvalid() {
  return candidateError(
    'IMMUTABLE_GIT_CANDIDATE_INVALID',
    'Immutable Git candidate facts are malformed or inconsistent.',
    ExitCode.guard,
  );
}

export function candidateError(
  code: string,
  message: string,
  exitCode: ExitCodeValue,
) {
  return workflowError(code, message, exitCode);
}
