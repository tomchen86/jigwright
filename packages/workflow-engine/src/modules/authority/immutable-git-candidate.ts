import crypto from 'node:crypto';

import { pinCheckRunner } from '../../adapters/consumer/repository/work-registry/check-runner.ts';
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
import {
  discoverRepository,
  fingerprintWorkingState,
  listChangedPaths,
  runGit,
  runGitBuffer,
} from '../../runtime/repository-transaction/git.ts';
import { previewExactStaging } from '../../runtime/repository-transaction/git-transitions.ts';
import { normalizeExactRepositoryPath } from '../../runtime/session-workspace/paths.ts';

const POLICY_PATH = 'workflow/maintainer-policy.json';
const CHECKS_PATH = 'workflow/checks.json';
const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REPOSITORY_ID = /^[a-z][a-z0-9.-]*:[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const TARGET_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_MODES = new Set(['100644', '100755']);

type GitObjectFormat = 'sha1' | 'sha256';
type Sha256Digest = `sha256:${string}`;

export type ImmutableGitObjectIdentity = Readonly<{
  objectId: string;
  objectType: 'blob';
  mode: '100644' | '100755';
  sha256: Sha256Digest;
  size: number;
}>;

export type ImmutableGitPatchEntry = Readonly<{
  path: string;
  operation: 'add' | 'modify' | 'delete';
  before: ImmutableGitObjectIdentity | null;
  after: ImmutableGitObjectIdentity | null;
}>;

export type ImmutableGitPatchManifestV1 = Readonly<{
  schemaVersion: 1;
  kind: 'immutable-git-patch-manifest.v1';
  objectFormat: GitObjectFormat;
  baseCommit: string;
  baseTree: string;
  resultTree: string;
  files: readonly ImmutableGitPatchEntry[];
  patchDigest: Sha256Digest;
}>;

type PolicyObservationBinding = Readonly<{
  path: typeof POLICY_PATH;
  baseObjectId: string;
  resultObjectId: string | null;
  baseContentDigest: Sha256Digest;
  resultContentDigest: Sha256Digest | null;
}>;

export type ImmutableGitPolicyObservation =
  | (PolicyObservationBinding &
      Readonly<{
        kind: 'policy-file-deletion.v1';
      }>)
  | (PolicyObservationBinding &
      Readonly<{
        kind: 'policy-sealed-phase-rollback.v1';
        beforePhase: 'sealed';
        afterPhase: string;
      }>)
  | (PolicyObservationBinding &
      Readonly<{
        kind: 'policy-sealed-immutable-path-removal.v1';
        removedPaths: readonly string[];
      }>)
  | (PolicyObservationBinding &
      Readonly<{
        kind: 'policy-required-check-removal.v1';
        removedCheckIds: readonly string[];
      }>)
  | (PolicyObservationBinding &
      Readonly<{
        kind: 'policy-bytes-unrecognized.v1';
        unrecognizedSide: 'base' | 'result' | 'both';
      }>);

export type ImmutableGitCheckObservation = Readonly<{
  checkId: string;
  definition: CheckDefinition;
  definitionDigest: Sha256Digest;
  commandDigest: Sha256Digest;
  runner: string;
  runnerDigest: string;
  observationDigest: Sha256Digest;
}>;

export type ImmutableGitCandidateV1 = Readonly<{
  schemaVersion: 1;
  kind: 'immutable-git-candidate.v1';
  repositoryId: string;
  repositoryOrigin: string;
  targetRef: string;
  expectedOldCommit: string;
  expectedOldTree: string;
  indexTree: string;
  worktreeStateDigest: Sha256Digest;
  resultTree: string;
  manifest: ImmutableGitPatchManifestV1;
  manifestDigest: Sha256Digest;
  policyObservations: readonly ImmutableGitPolicyObservation[];
  policyObservationsDigest: Sha256Digest;
  checkObservations: readonly ImmutableGitCheckObservation[];
  checkObservationsDigest: Sha256Digest;
  candidateDigest: Sha256Digest;
}>;

export type BuildImmutableGitCandidateRequest = Readonly<{
  targetRef: string;
  expectedOldCommit: string;
  observeCheckIds?: readonly string[];
}>;

export type BuildImmutableGitCandidateOptions = Readonly<{
  /** Test-only crash seam after isolated-index cleanup and before observation. */
  testAfterPreview?: () => void;
}>;

/**
 * Observe and freeze an exact Git candidate without granting, signing,
 * committing, updating a ref, or publishing a durable candidate record.
 * Policy changes and check definitions remain facts; neither is an authority
 * decision in this module. Check execution belongs to the later durable,
 * Grant-authorized operation, so candidate-controlled code never runs here.
 */
export function buildImmutableGitCandidate(
  cwd: string,
  request: BuildImmutableGitCandidateRequest,
  options: BuildImmutableGitCandidateOptions = {},
): ImmutableGitCandidateV1 {
  const checkIds = assertCheckIds(request.observeCheckIds ?? []);
  if (!TARGET_REF.test(request.targetRef)) throw candidateInvalid();

  const initial = discoverRepository(cwd);
  const objectFormat = readObjectFormat(initial.repositoryRoot);
  assertRepositoryPrestate(initial, request, objectFormat);
  const repositoryIdentity = readBaseRepositoryIdentity(
    initial.repositoryRoot,
    request.expectedOldCommit,
  );
  const changedPaths = listChangedPaths(
    initial.repositoryRoot,
    request.expectedOldCommit,
  );
  if (changedPaths.length === 0) {
    throw candidateError(
      'IMMUTABLE_GIT_CANDIDATE_EMPTY',
      'An immutable Git candidate requires at least one exact changed path.',
      ExitCode.verification,
    );
  }
  const refsBefore = refsSnapshot(initial.repositoryRoot);
  const worktreeStateDigest = prefixedDigest(
    fingerprintWorkingState(
      initial.repositoryRoot,
      initial.head,
      initial.statusEntries,
    ),
  );
  const preview = previewExactStaging(
    initial.repositoryRoot,
    initial.head,
    changedPaths,
  );
  if (preview.previousIndexTree !== initial.tree) {
    throw candidateError(
      'IMMUTABLE_GIT_CANDIDATE_INDEX_DIRTY',
      'The caller index does not match the immutable candidate base tree.',
      ExitCode.staleState,
    );
  }
  options.testAfterPreview?.();

  const manifest = buildPatchManifest(
    initial.repositoryRoot,
    objectFormat,
    initial.head,
    initial.tree,
    preview.tree,
    changedPaths,
  );
  const policyObservations = derivePolicyObservations(
    initial.repositoryRoot,
    manifest,
  );
  const checkObservations = observeCandidateChecks(
    initial.repositoryRoot,
    initial.head,
    checkIds,
  );

  const current = discoverRepository(initial.repositoryRoot);
  if (
    current.repositoryRealPath !== initial.repositoryRealPath ||
    current.gitCommonDirectory !== initial.gitCommonDirectory ||
    current.branch !== initial.branch ||
    current.head !== initial.head ||
    current.tree !== initial.tree ||
    refsSnapshot(current.repositoryRoot) !== refsBefore ||
    prefixedDigest(
      fingerprintWorkingState(
        current.repositoryRoot,
        current.head,
        current.statusEntries,
      ),
    ) !== worktreeStateDigest
  ) {
    throw candidateDrift();
  }
  const repeatedPreview = previewExactStaging(
    current.repositoryRoot,
    current.head,
    changedPaths,
  );
  if (
    repeatedPreview.previousIndexTree !== preview.previousIndexTree ||
    repeatedPreview.tree !== preview.tree
  ) {
    throw candidateDrift();
  }
  const repeatedManifest = buildPatchManifest(
    current.repositoryRoot,
    objectFormat,
    current.head,
    current.tree,
    repeatedPreview.tree,
    changedPaths,
  );
  if (canonicalJson(repeatedManifest) !== canonicalJson(manifest)) {
    throw candidateDrift();
  }

  const manifestDigest = sha256(canonicalJson(manifest));
  const policyObservationsDigest = sha256(canonicalJson(policyObservations));
  const checkObservationsDigest = sha256(canonicalJson(checkObservations));
  const body = {
    schemaVersion: 1 as const,
    kind: 'immutable-git-candidate.v1' as const,
    repositoryId: repositoryIdentity.id,
    repositoryOrigin: repositoryIdentity.origin,
    targetRef: request.targetRef,
    expectedOldCommit: initial.head,
    expectedOldTree: initial.tree,
    indexTree: preview.previousIndexTree,
    worktreeStateDigest,
    resultTree: preview.tree,
    manifest,
    manifestDigest,
    policyObservations,
    policyObservationsDigest,
    checkObservations,
    checkObservationsDigest,
  };
  return parseImmutableGitCandidate({
    ...body,
    candidateDigest: sha256(canonicalJson(body)),
  });
}

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

export function verifyImmutableGitCandidateAgainstRepository(
  cwd: string,
  value: ImmutableGitCandidateV1,
): ImmutableGitCandidateV1 {
  const candidate = parseImmutableGitCandidate(
    canonicalImmutableGitCandidate(value),
  );
  const repository = discoverRepository(cwd);
  const branchRef = repository.branch
    ? `refs/heads/${repository.branch}`
    : null;
  const observedRef = runGit(
    repository.repositoryRoot,
    ['rev-parse', '--verify', candidate.targetRef],
    true,
  ).trim();
  const refsBefore = refsSnapshot(repository.repositoryRoot);
  const repositoryIdentity = readBaseRepositoryIdentity(
    repository.repositoryRoot,
    candidate.expectedOldCommit,
  );
  if (
    branchRef !== candidate.targetRef ||
    repository.head !== candidate.expectedOldCommit ||
    repository.tree !== candidate.expectedOldTree ||
    observedRef !== candidate.expectedOldCommit ||
    repositoryIdentity.id !== candidate.repositoryId ||
    repositoryIdentity.origin !== candidate.repositoryOrigin ||
    readObjectFormat(repository.repositoryRoot) !==
      candidate.manifest.objectFormat ||
    prefixedDigest(
      fingerprintWorkingState(
        repository.repositoryRoot,
        repository.head,
        repository.statusEntries,
      ),
    ) !== candidate.worktreeStateDigest
  ) {
    throw candidateDrift();
  }
  const changedPaths = listChangedPaths(
    repository.repositoryRoot,
    candidate.expectedOldCommit,
  );
  const preview = previewExactStaging(
    repository.repositoryRoot,
    candidate.expectedOldCommit,
    changedPaths,
  );
  const manifest = buildPatchManifest(
    repository.repositoryRoot,
    candidate.manifest.objectFormat,
    candidate.expectedOldCommit,
    candidate.expectedOldTree,
    preview.tree,
    changedPaths,
  );
  const observations = derivePolicyObservations(
    repository.repositoryRoot,
    manifest,
  );
  const checkObservations = observeCandidateChecks(
    repository.repositoryRoot,
    candidate.expectedOldCommit,
    candidate.checkObservations.map(({ checkId }) => checkId),
  );
  const current = discoverRepository(repository.repositoryRoot);
  if (
    preview.previousIndexTree !== candidate.indexTree ||
    preview.tree !== candidate.resultTree ||
    canonicalJson(manifest) !== canonicalJson(candidate.manifest) ||
    canonicalJson(observations) !==
      canonicalJson(candidate.policyObservations) ||
    canonicalJson(checkObservations) !==
      canonicalJson(candidate.checkObservations) ||
    current.repositoryRealPath !== repository.repositoryRealPath ||
    current.gitCommonDirectory !== repository.gitCommonDirectory ||
    current.branch !== repository.branch ||
    current.head !== candidate.expectedOldCommit ||
    current.tree !== candidate.expectedOldTree ||
    refsSnapshot(current.repositoryRoot) !== refsBefore ||
    prefixedDigest(
      fingerprintWorkingState(
        current.repositoryRoot,
        current.head,
        current.statusEntries,
      ),
    ) !== candidate.worktreeStateDigest
  ) {
    throw candidateDrift();
  }
  return candidate;
}

function assertRepositoryPrestate(
  repository: ReturnType<typeof discoverRepository>,
  request: BuildImmutableGitCandidateRequest,
  objectFormat: GitObjectFormat,
): void {
  const branchRef = repository.branch
    ? `refs/heads/${repository.branch}`
    : null;
  const observedRef = runGit(
    repository.repositoryRoot,
    ['rev-parse', '--verify', request.targetRef],
    true,
  ).trim();
  if (
    !isObjectId(request.expectedOldCommit, objectFormat) ||
    branchRef !== request.targetRef ||
    repository.head !== request.expectedOldCommit ||
    observedRef !== request.expectedOldCommit ||
    !isObjectId(repository.tree, objectFormat) ||
    runGit(repository.repositoryRoot, [
      'cat-file',
      '-t',
      request.expectedOldCommit,
    ]).trim() !== 'commit' ||
    runGit(repository.repositoryRoot, [
      'cat-file',
      '-t',
      repository.tree,
    ]).trim() !== 'tree'
  ) {
    throw candidateError(
      'IMMUTABLE_GIT_CANDIDATE_PRESTATE_INVALID',
      'The immutable Git candidate does not match the exact repository, ref, base commit, and tree.',
      ExitCode.staleState,
    );
  }
}

function buildPatchManifest(
  repositoryRoot: string,
  objectFormat: GitObjectFormat,
  baseCommit: string,
  baseTree: string,
  resultTree: string,
  changedPaths: readonly string[],
): ImmutableGitPatchManifestV1 {
  if (
    runGit(repositoryRoot, ['cat-file', '-t', resultTree]).trim() !== 'tree'
  ) {
    throw candidateObjectInvalid();
  }
  const files = readRawPatch(
    repositoryRoot,
    objectFormat,
    baseCommit,
    resultTree,
  );
  if (
    files.length !== changedPaths.length ||
    files.some((file, index) => file.path !== changedPaths[index])
  ) {
    throw candidateDrift();
  }
  const body = {
    schemaVersion: 1 as const,
    kind: 'immutable-git-patch-manifest.v1' as const,
    objectFormat,
    baseCommit,
    baseTree,
    resultTree,
    files,
  };
  return freezeCanonical({
    ...body,
    patchDigest: sha256(canonicalJson(body)),
  });
}

function readRawPatch(
  repositoryRoot: string,
  objectFormat: GitObjectFormat,
  baseCommit: string,
  resultTree: string,
): readonly ImmutableGitPatchEntry[] {
  const output = runGitBuffer(repositoryRoot, [
    'diff-tree',
    '--no-commit-id',
    '-r',
    '--raw',
    '-z',
    '--no-renames',
    baseCommit,
    resultTree,
  ]);
  const parts = splitNul(output);
  if (parts.length % 2 !== 0) throw candidateObjectInvalid();
  const files: ImmutableGitPatchEntry[] = [];
  for (let index = 0; index < parts.length; index += 2) {
    const metadata = exactUtf8(parts[index]!);
    const filePath = exactUtf8(parts[index + 1]!);
    const match =
      /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([ADMT])$/u.exec(
        metadata,
      );
    if (!match) throw candidateObjectInvalid();
    let normalized: string;
    try {
      normalized = normalizeExactRepositoryPath(filePath);
    } catch {
      throw candidateObjectInvalid();
    }
    if (normalized !== filePath) throw candidateObjectInvalid();
    const [, beforeMode, afterMode, beforeId, afterId, status] = match;
    const zero = '0'.repeat(objectFormat === 'sha1' ? 40 : 64);
    const before =
      beforeId === zero
        ? null
        : readBlobIdentity(
            repositoryRoot,
            objectFormat,
            beforeId!,
            beforeMode!,
          );
    const after =
      afterId === zero
        ? null
        : readBlobIdentity(repositoryRoot, objectFormat, afterId!, afterMode!);
    const operation =
      before === null ? 'add' : after === null ? 'delete' : 'modify';
    if (
      (operation === 'add' && status !== 'A') ||
      (operation === 'delete' && status !== 'D') ||
      (operation === 'modify' && status !== 'M')
    ) {
      throw candidateObjectInvalid();
    }
    files.push({ path: normalized, operation, before, after });
  }
  files.sort((left, right) => compareCanonicalUtf8(left.path, right.path));
  if (
    new Set(files.map(({ path: filePath }) => filePath.toLowerCase())).size !==
    files.length
  ) {
    throw candidateObjectInvalid();
  }
  return freezeCanonical(files);
}

function readBlobIdentity(
  repositoryRoot: string,
  objectFormat: GitObjectFormat,
  objectId: string,
  mode: string,
): ImmutableGitObjectIdentity {
  if (
    !isObjectId(objectId, objectFormat) ||
    !GIT_MODES.has(mode) ||
    runGit(repositoryRoot, ['cat-file', '-t', objectId]).trim() !== 'blob'
  ) {
    throw candidateError(
      'IMMUTABLE_GIT_CANDIDATE_PATH_UNSAFE',
      'Candidate paths must resolve to exact regular non-symlink Git blobs.',
      ExitCode.guard,
    );
  }
  const bytes = runGitBuffer(repositoryRoot, ['cat-file', 'blob', objectId]);
  const observedObjectId = exactUtf8(
    runGitBuffer(repositoryRoot, ['hash-object', '--stdin'], { input: bytes }),
  ).trim();
  if (observedObjectId !== objectId) throw candidateObjectInvalid();
  return freezeCanonical({
    objectId,
    objectType: 'blob' as const,
    mode: mode as '100644' | '100755',
    sha256: sha256(bytes),
    size: bytes.length,
  });
}

function derivePolicyObservations(
  repositoryRoot: string,
  manifest: ImmutableGitPatchManifestV1,
): readonly ImmutableGitPolicyObservation[] {
  const policy = manifest.files.find(
    ({ path: filePath }) => filePath === POLICY_PATH,
  );
  if (!policy || !policy.before) return Object.freeze([]);
  const binding: PolicyObservationBinding = {
    path: POLICY_PATH,
    baseObjectId: policy.before.objectId,
    resultObjectId: policy.after?.objectId ?? null,
    baseContentDigest: policy.before.sha256,
    resultContentDigest: policy.after?.sha256 ?? null,
  };
  if (!policy.after) {
    return freezeCanonical([
      { kind: 'policy-file-deletion.v1' as const, ...binding },
    ]);
  }
  const before = readJsonObject(
    runGitBuffer(repositoryRoot, ['cat-file', 'blob', policy.before.objectId]),
  );
  const after = readJsonObject(
    runGitBuffer(repositoryRoot, ['cat-file', 'blob', policy.after.objectId]),
  );
  const observations: ImmutableGitPolicyObservation[] = [];
  const beforeFacts = policyFacts(before);
  const afterFacts = policyFacts(after);
  if (!beforeFacts || !afterFacts) {
    observations.push({
      kind: 'policy-bytes-unrecognized.v1',
      ...binding,
      unrecognizedSide:
        !beforeFacts && !afterFacts ? 'both' : !beforeFacts ? 'base' : 'result',
    });
  }
  if (
    beforeFacts?.phase === 'sealed' &&
    afterFacts?.phase !== undefined &&
    afterFacts.phase !== 'sealed'
  ) {
    observations.push({
      kind: 'policy-sealed-phase-rollback.v1',
      ...binding,
      beforePhase: 'sealed',
      afterPhase: afterFacts.phase,
    });
  }
  const removedPaths =
    beforeFacts?.phase === 'sealed'
      ? removedStrings(
          beforeFacts.sealedImmutablePaths,
          afterFacts?.sealedImmutablePaths,
        )
      : Object.freeze([]);
  if (removedPaths.length > 0) {
    observations.push({
      kind: 'policy-sealed-immutable-path-removal.v1',
      ...binding,
      removedPaths,
    });
  }
  const removedCheckIds = removedStrings(
    beforeFacts?.requiredChecks,
    afterFacts?.requiredChecks,
  );
  if (removedCheckIds.length > 0) {
    observations.push({
      kind: 'policy-required-check-removal.v1',
      ...binding,
      removedCheckIds,
    });
  }
  return freezeCanonical(observations.sort(compareObservation));
}

function observeCandidateChecks(
  repositoryRoot: string,
  baseCommit: string,
  checkIds: readonly string[],
): readonly ImmutableGitCheckObservation[] {
  if (checkIds.length === 0) return Object.freeze([]);
  const definitions = loadBaseCheckDefinitions(
    repositoryRoot,
    baseCommit,
    checkIds,
  );
  return freezeCanonical(
    checkIds.map((checkId) =>
      observeCandidateCheck(repositoryRoot, checkId, definitions[checkId]!),
    ),
  );
}

function observeCandidateCheck(
  repositoryRoot: string,
  checkId: string,
  definition: CheckDefinition,
): ImmutableGitCheckObservation {
  const exactDefinition = freezeCanonical(definition);
  const pinned = pinCheckRunner(repositoryRoot, checkId, definition);
  const repeated = pinCheckRunner(repositoryRoot, checkId, definition);
  if (canonicalJson(repeated) !== canonicalJson(pinned)) {
    throw candidateDrift();
  }
  const body = {
    checkId,
    definition: exactDefinition,
    definitionDigest: sha256(canonicalJson(exactDefinition)),
    commandDigest: sha256(canonicalJson(exactDefinition.command)),
    runner: pinned.runner,
    runnerDigest: pinned.digest,
  };
  return freezeCanonical({
    ...body,
    observationDigest: sha256(canonicalJson(body)),
  });
}

function loadBaseCheckDefinitions(
  repositoryRoot: string,
  baseCommit: string,
  checkIds: readonly string[],
): Record<string, CheckDefinition> {
  let source: unknown;
  try {
    source = JSON.parse(
      runGitBuffer(repositoryRoot, [
        'show',
        `${baseCommit}:${CHECKS_PATH}`,
      ]).toString('utf8'),
    ) as unknown;
  } catch {
    throw candidateInvalid();
  }
  const parsed = parseChecksConfigSource(source);
  if (!parsed.ok) throw candidateInvalid();
  const definitions: Record<string, CheckDefinition> = {};
  for (const checkId of checkIds) {
    const definition = parsed.value.checks[checkId];
    if (!definition) throw candidateInvalid();
    definitions[checkId] = definition;
  }
  return definitions;
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

function readObjectFormat(repositoryRoot: string): GitObjectFormat {
  const value = runGit(repositoryRoot, [
    'rev-parse',
    '--show-object-format',
  ]).trim();
  if (value !== 'sha1' && value !== 'sha256') throw candidateObjectInvalid();
  return value;
}

function readBaseRepositoryIdentity(
  repositoryRoot: string,
  baseCommit: string,
): Readonly<{ id: string; origin: string }> {
  let value: unknown;
  try {
    value = JSON.parse(
      runGitBuffer(repositoryRoot, [
        'show',
        `${baseCommit}:${POLICY_PATH}`,
      ]).toString('utf8'),
    ) as unknown;
  } catch {
    throw candidateInvalid();
  }
  if (
    !isRecord(value) ||
    !isRecord(value.repository) ||
    typeof value.repository.id !== 'string' ||
    !REPOSITORY_ID.test(value.repository.id) ||
    typeof value.repository.origin !== 'string' ||
    !isRepositoryOrigin(value.repository.origin)
  ) {
    throw candidateInvalid();
  }
  return Object.freeze({
    id: value.repository.id,
    origin: value.repository.origin,
  });
}

function isRepositoryOrigin(value: string): boolean {
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

function refsSnapshot(repositoryRoot: string): string {
  return runGit(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname) %(objectname)',
  ]);
}

function readJsonObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function policyFacts(value: Record<string, unknown> | null): {
  phase?: string;
  sealedImmutablePaths?: readonly string[];
  requiredChecks?: readonly string[];
} | null {
  if (!value) return null;
  const phase = typeof value.phase === 'string' ? value.phase : undefined;
  const sealedImmutablePaths = stringArray(value.sealedImmutablePaths);
  const requiredChecks = stringArray(value.requiredChecks);
  if (
    phase === undefined ||
    sealedImmutablePaths === undefined ||
    requiredChecks === undefined
  ) {
    return null;
  }
  return { phase, sealedImmutablePaths, requiredChecks };
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string')
    ? [...value]
    : undefined;
}

function removedStrings(
  before: readonly string[] | undefined,
  after: readonly string[] | undefined,
): readonly string[] {
  if (!before || !after) return Object.freeze([]);
  const afterSet = new Set(after);
  return Object.freeze(
    [...new Set(before.filter((entry) => !afterSet.has(entry)))].sort(
      compareCanonicalUtf8,
    ),
  );
}

function compareObservation(
  left: ImmutableGitPolicyObservation,
  right: ImmutableGitPolicyObservation,
): number {
  return compareCanonicalUtf8(left.kind, right.kind);
}

function compareCanonicalUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertCheckIds(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    throw candidateInvalid();
  }
  const sorted = [...value].sort();
  if (
    sorted.some((entry) => !CHECK_ID.test(entry)) ||
    new Set(sorted).size !== sorted.length
  ) {
    throw candidateInvalid();
  }
  return Object.freeze(sorted);
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

function splitNul(value: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== 0) continue;
    if (index > start) parts.push(value.subarray(start, index));
    start = index + 1;
  }
  if (start !== value.length) throw candidateObjectInvalid();
  return parts;
}

function exactUtf8(value: Buffer): string {
  const text = value.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(value)) throw candidateObjectInvalid();
  return text;
}

function isObjectId(
  value: unknown,
  objectFormat: GitObjectFormat,
): value is string {
  return (
    typeof value === 'string' &&
    new RegExp(`^[0-9a-f]{${objectFormat === 'sha1' ? 40 : 64}}$`).test(value)
  );
}

function prefixedDigest(value: string): Sha256Digest {
  const raw = value.startsWith('sha256:') ? value.slice(7) : value;
  if (!/^[0-9a-f]{64}$/.test(raw)) throw candidateInvalid();
  return `sha256:${raw}`;
}

function sha256(value: string | Buffer): Sha256Digest {
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

function freezeCanonical<T>(value: T): T {
  return deepFreeze(JSON.parse(canonicalJson(value)) as T);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach((entry) => deepFreeze(entry));
  }
  return value;
}

function candidateInvalid() {
  return candidateError(
    'IMMUTABLE_GIT_CANDIDATE_INVALID',
    'Immutable Git candidate facts are malformed or inconsistent.',
    ExitCode.guard,
  );
}

function candidateObjectInvalid() {
  return candidateError(
    'IMMUTABLE_GIT_CANDIDATE_OBJECT_INVALID',
    'Immutable Git candidate object identities are malformed or inconsistent.',
    ExitCode.guard,
  );
}

function candidateDrift() {
  return candidateError(
    'IMMUTABLE_GIT_CANDIDATE_DRIFT',
    'The repository, ref, index, worktree, or candidate tree changed during observation.',
    ExitCode.staleState,
  );
}

function candidateError(
  code: string,
  message: string,
  exitCode: ExitCodeValue,
) {
  return workflowError(code, message, exitCode);
}
