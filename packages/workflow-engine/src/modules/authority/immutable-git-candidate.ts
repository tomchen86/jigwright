/**
 * Builds immutable Git candidates and verifies their observed repository
 * state and pinned objects.
 *
 * Invariants:
 * - The build re-discovers the repository and rebuilds the manifest after
 *   observation, raising drift unless the repeat is canonically identical
 *   to the first.
 * - A candidate must contain at least one exact changed path.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode } from '../../foundation/errors/errors.ts';
import {
  parseChecksConfigSource,
  type CheckDefinition,
} from '../source/check-command.ts';
import { normalizeExactRepositoryPath } from '../../foundation/repository-path/repository-path.ts';
import {
  CHECK_ID,
  POLICY_PATH,
  REPOSITORY_ID,
  TARGET_REF,
  candidateError,
  candidateInvalid,
  canonicalImmutableGitCandidate,
  compareCanonicalUtf8,
  compareObservation,
  freezeCanonical,
  isObjectId,
  isRepositoryOrigin,
  parseImmutableGitCandidate,
  sha256,
} from './immutable-git-candidate-codec.ts';

export {
  canonicalImmutableGitCandidate,
  parseImmutableGitCandidate,
} from './immutable-git-candidate-codec.ts';
export type { Sha256Digest };
export type { GitObjectFormat };
export type { PolicyObservationBinding };

const CHECKS_PATH = 'workflow/checks.json';

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

export type ImmutableGitCandidateRuntimePort = Readonly<{
  discoverRepository(cwd: string): Readonly<{
    repositoryRoot: string;
    repositoryRealPath: string;
    gitCommonDirectory: string;
    branch: string | null;
    head: string;
    tree: string;
    statusEntries: string[];
  }>;
  fingerprintWorkingState(
    repositoryRoot: string,
    baselineHead: string,
    statusEntries: string[],
  ): string;
  listChangedPaths(repositoryRoot: string, baselineHead: string): string[];
  pinCheckRunner(
    repositoryRoot: string,
    checkId: string,
    definition: CheckDefinition,
  ): Readonly<{ runner: string; digest: string }>;
  previewExactStaging(
    repositoryRoot: string,
    baselineHead: string,
    expectedPaths: string[],
  ): Readonly<{ tree: string; previousIndexTree: string }>;
  runGit(cwd: string, args: string[], allowFailure?: boolean): string;
  runGitBuffer(
    cwd: string,
    args: string[],
    options?: Readonly<{
      input?: Buffer;
      allowFailure?: boolean;
      timeoutMs?: number;
    }>,
  ): Buffer;
}>;

/**
 * Observe and freeze an exact Git candidate without granting, signing,
 * committing, updating a ref, or publishing a durable candidate record.
 * Policy changes and check definitions remain facts; neither is an authority
 * decision in this module. Check execution belongs to the later durable,
 * Grant-authorized operation, so candidate-controlled code never runs here.
 */
export function buildImmutableGitCandidateWithRuntimePort(
  runtime: ImmutableGitCandidateRuntimePort,
  cwd: string,
  request: BuildImmutableGitCandidateRequest,
  options: BuildImmutableGitCandidateOptions = {},
): ImmutableGitCandidateV1 {
  const checkIds = assertCheckIds(request.observeCheckIds ?? []);
  if (!TARGET_REF.test(request.targetRef)) throw candidateInvalid();

  const initial = runtime.discoverRepository(cwd);
  const objectFormat = readObjectFormat(runtime, initial.repositoryRoot);
  assertRepositoryPrestate(runtime, initial, request, objectFormat);
  const repositoryIdentity = readBaseRepositoryIdentity(
    runtime,
    initial.repositoryRoot,
    request.expectedOldCommit,
  );
  const changedPaths = canonicalChangedPaths(
    runtime,
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
  const refsBefore = refsSnapshot(runtime, initial.repositoryRoot);
  const worktreeStateDigest = prefixedDigest(
    runtime.fingerprintWorkingState(
      initial.repositoryRoot,
      initial.head,
      initial.statusEntries,
    ),
  );
  const preview = runtime.previewExactStaging(
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
    runtime,
    initial.repositoryRoot,
    objectFormat,
    initial.head,
    initial.tree,
    preview.tree,
    changedPaths,
  );
  const policyObservations = derivePolicyObservations(
    runtime,
    initial.repositoryRoot,
    manifest,
  );
  const checkObservations = observeCandidateChecks(
    runtime,
    initial.repositoryRoot,
    initial.head,
    checkIds,
  );

  const current = runtime.discoverRepository(initial.repositoryRoot);
  if (
    current.repositoryRealPath !== initial.repositoryRealPath ||
    current.gitCommonDirectory !== initial.gitCommonDirectory ||
    current.branch !== initial.branch ||
    current.head !== initial.head ||
    current.tree !== initial.tree ||
    refsSnapshot(runtime, current.repositoryRoot) !== refsBefore ||
    prefixedDigest(
      runtime.fingerprintWorkingState(
        current.repositoryRoot,
        current.head,
        current.statusEntries,
      ),
    ) !== worktreeStateDigest
  ) {
    throw candidateDrift();
  }
  const repeatedPreview = runtime.previewExactStaging(
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
    runtime,
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

export function verifyImmutableGitCandidateAgainstRepositoryWithRuntimePort(
  runtime: ImmutableGitCandidateRuntimePort,
  cwd: string,
  value: ImmutableGitCandidateV1,
): ImmutableGitCandidateV1 {
  const candidate = parseImmutableGitCandidate(
    canonicalImmutableGitCandidate(value),
  );
  const repository = runtime.discoverRepository(cwd);
  const branchRef = repository.branch
    ? `refs/heads/${repository.branch}`
    : null;
  const observedRef = runtime
    .runGit(
      repository.repositoryRoot,
      ['rev-parse', '--verify', candidate.targetRef],
      true,
    )
    .trim();
  const refsBefore = refsSnapshot(runtime, repository.repositoryRoot);
  const repositoryIdentity = readBaseRepositoryIdentity(
    runtime,
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
    readObjectFormat(runtime, repository.repositoryRoot) !==
      candidate.manifest.objectFormat ||
    prefixedDigest(
      runtime.fingerprintWorkingState(
        repository.repositoryRoot,
        repository.head,
        repository.statusEntries,
      ),
    ) !== candidate.worktreeStateDigest
  ) {
    throw candidateDrift();
  }
  const changedPaths = canonicalChangedPaths(
    runtime,
    repository.repositoryRoot,
    candidate.expectedOldCommit,
  );
  const preview = runtime.previewExactStaging(
    repository.repositoryRoot,
    candidate.expectedOldCommit,
    changedPaths,
  );
  const manifest = buildPatchManifest(
    runtime,
    repository.repositoryRoot,
    candidate.manifest.objectFormat,
    candidate.expectedOldCommit,
    candidate.expectedOldTree,
    preview.tree,
    changedPaths,
  );
  const observations = derivePolicyObservations(
    runtime,
    repository.repositoryRoot,
    manifest,
  );
  const checkObservations = observeCandidateChecks(
    runtime,
    repository.repositoryRoot,
    candidate.expectedOldCommit,
    candidate.checkObservations.map(({ checkId }) => checkId),
  );
  const current = runtime.discoverRepository(repository.repositoryRoot);
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
    refsSnapshot(runtime, current.repositoryRoot) !== refsBefore ||
    prefixedDigest(
      runtime.fingerprintWorkingState(
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

/**
 * Verify the immutable parts of a candidate from Git objects only. This is the
 * clone/CI verifier: the authoring worktree fingerprint and pinned runner path
 * remain signed observations, while every base/result object, policy fact and
 * base check definition is rebuilt from the candidate's pinned objects.
 */
export function verifyImmutableGitCandidateObjectsWithRuntimePort(
  runtime: ImmutableGitCandidateRuntimePort,
  cwd: string,
  value: ImmutableGitCandidateV1,
): ImmutableGitCandidateV1 {
  const candidate = parseImmutableGitCandidate(
    canonicalImmutableGitCandidate(value),
  );
  const repositoryRoot = runtime.discoverRepository(cwd).repositoryRoot;
  const objectFormat = readObjectFormat(runtime, repositoryRoot);
  const baseType = runtime
    .runGit(repositoryRoot, ['cat-file', '-t', candidate.expectedOldCommit])
    .trim();
  const baseTree = runtime
    .runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${candidate.expectedOldCommit}^{tree}`,
    ])
    .trim();
  const resultType = runtime
    .runGit(repositoryRoot, ['cat-file', '-t', candidate.resultTree])
    .trim();
  const identity = readBaseRepositoryIdentity(
    runtime,
    repositoryRoot,
    candidate.expectedOldCommit,
  );
  const manifest = buildPatchManifest(
    runtime,
    repositoryRoot,
    objectFormat,
    candidate.expectedOldCommit,
    candidate.expectedOldTree,
    candidate.resultTree,
    candidate.manifest.files.map(({ path: filePath }) => filePath),
  );
  const policyObservations = derivePolicyObservations(
    runtime,
    repositoryRoot,
    manifest,
  );
  const baseDefinitions =
    candidate.checkObservations.length === 0
      ? {}
      : loadBaseCheckDefinitions(
          runtime,
          repositoryRoot,
          candidate.expectedOldCommit,
          candidate.checkObservations.map(({ checkId }) => checkId),
        );
  if (
    objectFormat !== candidate.manifest.objectFormat ||
    baseType !== 'commit' ||
    baseTree !== candidate.expectedOldTree ||
    resultType !== 'tree' ||
    identity.id !== candidate.repositoryId ||
    identity.origin !== candidate.repositoryOrigin ||
    canonicalJson(manifest) !== canonicalJson(candidate.manifest) ||
    canonicalJson(policyObservations) !==
      canonicalJson(candidate.policyObservations) ||
    candidate.checkObservations.some(
      ({ checkId, definition, definitionDigest, commandDigest }) => {
        const base = baseDefinitions[checkId];
        return (
          base === undefined ||
          canonicalJson(base) !== canonicalJson(definition) ||
          definitionDigest !== sha256(canonicalJson(base)) ||
          commandDigest !== sha256(canonicalJson(base.command))
        );
      },
    )
  ) {
    throw candidateObjectInvalid();
  }
  return candidate;
}

function assertRepositoryPrestate(
  runtime: ImmutableGitCandidateRuntimePort,
  repository: ReturnType<
    ImmutableGitCandidateRuntimePort['discoverRepository']
  >,
  request: BuildImmutableGitCandidateRequest,
  objectFormat: GitObjectFormat,
): void {
  const branchRef = repository.branch
    ? `refs/heads/${repository.branch}`
    : null;
  const observedRef = runtime
    .runGit(
      repository.repositoryRoot,
      ['rev-parse', '--verify', request.targetRef],
      true,
    )
    .trim();
  if (
    !isObjectId(request.expectedOldCommit, objectFormat) ||
    branchRef !== request.targetRef ||
    repository.head !== request.expectedOldCommit ||
    observedRef !== request.expectedOldCommit ||
    !isObjectId(repository.tree, objectFormat) ||
    runtime
      .runGit(repository.repositoryRoot, [
        'cat-file',
        '-t',
        request.expectedOldCommit,
      ])
      .trim() !== 'commit' ||
    runtime
      .runGit(repository.repositoryRoot, ['cat-file', '-t', repository.tree])
      .trim() !== 'tree'
  ) {
    throw candidateError(
      'IMMUTABLE_GIT_CANDIDATE_PRESTATE_INVALID',
      'The immutable Git candidate does not match the exact repository, ref, base commit, and tree.',
      ExitCode.staleState,
    );
  }
}

function buildPatchManifest(
  runtime: ImmutableGitCandidateRuntimePort,
  repositoryRoot: string,
  objectFormat: GitObjectFormat,
  baseCommit: string,
  baseTree: string,
  resultTree: string,
  changedPaths: readonly string[],
): ImmutableGitPatchManifestV1 {
  if (
    runtime.runGit(repositoryRoot, ['cat-file', '-t', resultTree]).trim() !==
    'tree'
  ) {
    throw candidateObjectInvalid();
  }
  const files = readRawPatch(
    runtime,
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
  runtime: ImmutableGitCandidateRuntimePort,
  repositoryRoot: string,
  objectFormat: GitObjectFormat,
  baseCommit: string,
  resultTree: string,
): readonly ImmutableGitPatchEntry[] {
  const output = runtime.runGitBuffer(repositoryRoot, [
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
            runtime,
            repositoryRoot,
            objectFormat,
            beforeId!,
            beforeMode!,
          );
    const after =
      afterId === zero
        ? null
        : readBlobIdentity(
            runtime,
            repositoryRoot,
            objectFormat,
            afterId!,
            afterMode!,
          );
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
  runtime: ImmutableGitCandidateRuntimePort,
  repositoryRoot: string,
  objectFormat: GitObjectFormat,
  objectId: string,
  mode: string,
): ImmutableGitObjectIdentity {
  if (
    !isObjectId(objectId, objectFormat) ||
    !GIT_MODES.has(mode) ||
    runtime.runGit(repositoryRoot, ['cat-file', '-t', objectId]).trim() !==
      'blob'
  ) {
    throw candidateError(
      'IMMUTABLE_GIT_CANDIDATE_PATH_UNSAFE',
      'Candidate paths must resolve to exact regular non-symlink Git blobs.',
      ExitCode.guard,
    );
  }
  const bytes = runtime.runGitBuffer(repositoryRoot, [
    'cat-file',
    'blob',
    objectId,
  ]);
  const observedObjectId = exactUtf8(
    runtime.runGitBuffer(repositoryRoot, ['hash-object', '--stdin'], {
      input: bytes,
    }),
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
  runtime: ImmutableGitCandidateRuntimePort,
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
    runtime.runGitBuffer(repositoryRoot, [
      'cat-file',
      'blob',
      policy.before.objectId,
    ]),
  );
  const after = readJsonObject(
    runtime.runGitBuffer(repositoryRoot, [
      'cat-file',
      'blob',
      policy.after.objectId,
    ]),
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
  runtime: ImmutableGitCandidateRuntimePort,
  repositoryRoot: string,
  baseCommit: string,
  checkIds: readonly string[],
): readonly ImmutableGitCheckObservation[] {
  if (checkIds.length === 0) return Object.freeze([]);
  const definitions = loadBaseCheckDefinitions(
    runtime,
    repositoryRoot,
    baseCommit,
    checkIds,
  );
  return freezeCanonical(
    checkIds.map((checkId) =>
      observeCandidateCheck(
        runtime,
        repositoryRoot,
        checkId,
        definitions[checkId]!,
      ),
    ),
  );
}

function observeCandidateCheck(
  runtime: ImmutableGitCandidateRuntimePort,
  repositoryRoot: string,
  checkId: string,
  definition: CheckDefinition,
): ImmutableGitCheckObservation {
  const exactDefinition = freezeCanonical(definition);
  const pinned = runtime.pinCheckRunner(repositoryRoot, checkId, definition);
  const repeated = runtime.pinCheckRunner(repositoryRoot, checkId, definition);
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
  runtime: ImmutableGitCandidateRuntimePort,
  repositoryRoot: string,
  baseCommit: string,
  checkIds: readonly string[],
): Record<string, CheckDefinition> {
  let source: unknown;
  try {
    source = JSON.parse(
      runtime
        .runGitBuffer(repositoryRoot, ['show', `${baseCommit}:${CHECKS_PATH}`])
        .toString('utf8'),
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

function readObjectFormat(
  runtime: ImmutableGitCandidateRuntimePort,
  repositoryRoot: string,
): GitObjectFormat {
  const value = runtime
    .runGit(repositoryRoot, ['rev-parse', '--show-object-format'])
    .trim();
  if (value !== 'sha1' && value !== 'sha256') throw candidateObjectInvalid();
  return value;
}

function readBaseRepositoryIdentity(
  runtime: ImmutableGitCandidateRuntimePort,
  repositoryRoot: string,
  baseCommit: string,
): Readonly<{ id: string; origin: string }> {
  let value: unknown;
  try {
    value = JSON.parse(
      runtime
        .runGitBuffer(repositoryRoot, ['show', `${baseCommit}:${POLICY_PATH}`])
        .toString('utf8'),
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

function refsSnapshot(
  runtime: ImmutableGitCandidateRuntimePort,
  repositoryRoot: string,
): string {
  return runtime.runGit(repositoryRoot, [
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

function canonicalChangedPaths(
  runtime: ImmutableGitCandidateRuntimePort,
  repositoryRoot: string,
  baselineHead: string,
): string[] {
  return runtime
    .listChangedPaths(repositoryRoot, baselineHead)
    .sort(compareCanonicalUtf8);
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

function prefixedDigest(value: string): Sha256Digest {
  const raw = value.startsWith('sha256:') ? value.slice(7) : value;
  if (!/^[0-9a-f]{64}$/.test(raw)) throw candidateInvalid();
  return `sha256:${raw}`;
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
