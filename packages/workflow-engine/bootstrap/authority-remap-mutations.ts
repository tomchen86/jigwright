/** Exact projected authority text mutations and pinned tree/index evidence. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../src/foundation/errors/errors.ts';
import { projectAuthorityRemap } from '../src/composition-root/authority-remap.ts';
import type {
  AuthorityRemapPlanIntent,
  AuthorityRemapProjection,
} from '../src/modules/authority/authority-remap-contract.ts';
import { classifyFileRole } from '../src/modules/authority/maintainer-manifest-contracts.ts';
import { loadCapabilityProfileFromTrustBase } from '../src/composition-root/maintainer-manifest-production.ts';
import { parseProtectedCapabilitiesManifestSource } from '../src/adapters/consumer/repository/work-registry/protected-capabilities.ts';
import type { ProtectedCapabilitiesManifestSource } from '../src/adapters/consumer/repository/work-registry/protected-capabilities.ts';
import { runGitBuffer } from '../src/runtime/repository-transaction/git.ts';
import {
  normalizeExactRepositoryPath,
  matchesAllowedPath,
} from '../src/foundation/repository-path/repository-path.ts';

const MAX_MUTATIONS = 64;

export const PROTECTED_CAPABILITIES_PATH =
  'workflow/protected-capabilities.json';

export const BUILT_IN_OUTPUTS = new Set([
  'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
  'packages/workflow-engine/bootstrap/built-in-engine-closure-pin.ts',
]);

export const WORKFLOW_BOOTSTRAP_HOST_OUTPUTS = new Set([
  'packages/workflow-engine/bootstrap/workflow-bootstrap-host.json',
  'packages/workflow-engine/bootstrap/workflow-bootstrap-host-pin.ts',
]);

export const HARNESS_BOOTSTRAP_OUTPUTS = new Set([
  'packages/workflow-engine/bootstrap/harness-bootstrap-dependency-closure.json',
  'packages/workflow-engine/bootstrap/harness-bootstrap-runtime-closure-pin.ts',
]);

export const HARNESS_BOOTSTRAP_RUNTIME_ROOT =
  'packages/workflow-engine/bootstrap/recovery-runtime';

export const ABSENT_BEFORE_DIGEST = sha256(
  canonicalJson({
    kind: 'workflow.authority-remap-absent.v1',
    side: 'before',
  }),
);

export const ABSENT_AFTER_DIGEST = sha256(
  canonicalJson({
    kind: 'workflow.authority-remap-absent.v1',
    side: 'after',
  }),
);

export type AuthorityRemapRequest = Parameters<typeof projectAuthorityRemap>[0];

export type AuthorityRemapMaterializationRequest = AuthorityRemapRequest &
  Readonly<{
    expectedRegenerationDescriptorDigest: `sha256:${string}`;
  }>;

type AuthorityRemapMutation = AuthorityRemapPlanIntent['mutations'][number];

export type ReadyAuthorityRemapProjection = Extract<
  AuthorityRemapProjection,
  { status: 'ready' }
>;

export function assertRegenerationDescriptor(
  descriptor: Exclude<AuthorityRemapProjection['regeneration'], null>,
  expectedDigest: string,
): void {
  const identity = {
    schemaVersion: descriptor.schemaVersion,
    kind: descriptor.kind,
    mechanicalProofDigest: descriptor.mechanicalProofDigest,
    moveTree: descriptor.moveTree,
    materializationCommit: descriptor.materializationCommit,
    materializationTree: descriptor.materializationTree,
    affectedMoves: descriptor.affectedMoves,
    steps: descriptor.steps,
  };
  const recomputed = sha256(canonicalJson(identity));
  if (
    expectedDigest !== descriptor.descriptorDigest ||
    recomputed !== descriptor.descriptorDigest
  ) {
    throw remapInvalid(
      'Authority remap regeneration descriptor does not match the exact caller handoff.',
    );
  }
}

export function applyProjectedTextMutation(
  repositoryRoot: string,
  mutation: {
    path: string;
    expectedBeforeSha256: string;
    content: string;
  },
): void {
  const normalized = normalizeExactRepositoryPath(mutation.path);
  if (normalized !== mutation.path) {
    throw remapInvalid('Authority remap projection contains an unsafe path.');
  }
  const target = path.join(repositoryRoot, ...normalized.split('/'));
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (
    stats === undefined ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1
  ) {
    throw remapInvalid(
      `Authority remap projection target ${normalized} is not safe regular text.`,
    );
  }
  const before = fs.readFileSync(target);
  if (sha256Hex(before) !== mutation.expectedBeforeSha256) {
    throw remapInvalid(
      `Authority remap projection target ${normalized} is stale.`,
    );
  }
  decodeText(before, normalized);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, mutation.content, { mode: stats.mode & 0o777 });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function projectProtectedCapabilityPaths(
  repositoryRoot: string,
  moves: readonly Readonly<{ from: string; to: string }>[],
): void {
  const manifestPath = path.join(repositoryRoot, PROTECTED_CAPABILITIES_PATH);
  const before = readSafeRegularFile(manifestPath, PROTECTED_CAPABILITIES_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeText(before, PROTECTED_CAPABILITIES_PATH));
  } catch {
    throw remapInvalid(`${PROTECTED_CAPABILITIES_PATH} is not valid JSON.`);
  }
  let source: ProtectedCapabilitiesManifestSource;
  try {
    source = parseProtectedCapabilitiesManifestSource(parsed);
  } catch {
    throw remapInvalid(
      `${PROTECTED_CAPABILITIES_PATH} is not a valid landed manifest.`,
    );
  }

  let changed = false;
  const entries = source.entries.map((entry) => {
    let entrypoints = [...entry.entrypoints];
    let dependencies = [...entry.dependencies];
    for (const move of moves) {
      const nextEntrypoints = projectProtectedPathSet(
        entrypoints,
        move.from,
        move.to,
      );
      const nextDependencies = projectProtectedPathSet(
        dependencies,
        move.from,
        move.to,
      );
      changed ||= !sameStrings(entrypoints, nextEntrypoints);
      changed ||= !sameStrings(dependencies, nextDependencies);
      entrypoints = nextEntrypoints;
      dependencies = nextDependencies;
    }
    return { ...entry, entrypoints, dependencies };
  });
  const projected = { ...source, entries };
  try {
    parseProtectedCapabilitiesManifestSource(projected);
  } catch {
    throw remapInvalid(
      `Projected ${PROTECTED_CAPABILITIES_PATH} does not satisfy the landed parser.`,
    );
  }
  if (changed) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(projected, null, 2)}\n`, {
      mode: 0o644,
    });
  }
}

function projectProtectedPathSet(
  paths: readonly string[],
  from: string,
  to: string,
): string[] {
  let exactMoved = false;
  let broadCoveredSource = false;
  const projected = paths.map((candidate) => {
    if (candidate === from) {
      exactMoved = true;
      return to;
    }
    if (matchesAllowedPath(from, candidate)) broadCoveredSource = true;
    return candidate;
  });
  if (
    broadCoveredSource &&
    !projected.some((candidate) => matchesAllowedPath(to, candidate))
  ) {
    projected.push(to);
  }
  if (exactMoved && !projected.includes(to)) projected.push(to);
  return [...new Set(projected)].sort(comparePaths);
}

export function collectStagedTextMutations(
  repositoryRoot: string,
  moveCommit: string,
): AuthorityRemapMutation[] {
  const tokens = splitNul(
    runGitBuffer(repositoryRoot, [
      'diff',
      '--cached',
      '--name-status',
      '--no-renames',
      '-z',
      moveCommit,
      '--',
    ]),
  );
  if (tokens.length % 2 !== 0) {
    throw remapInvalid('Generated authority remap diff is malformed.');
  }
  const changes: Array<{ status: 'A' | 'M' | 'D'; path: string }> = [];
  for (let index = 0; index < tokens.length; index += 2) {
    const status = decodeText(tokens[index]!, 'Git diff status');
    const filePath = decodeText(tokens[index + 1]!, 'Git diff path');
    if (status !== 'A' && status !== 'M' && status !== 'D') {
      throw remapInvalid(
        `Generated authority remap contains unsupported Git status ${status}.`,
      );
    }
    let normalized: string;
    try {
      normalized = normalizeExactRepositoryPath(filePath);
    } catch {
      throw remapInvalid('Generated authority remap contains an unsafe path.');
    }
    if (normalized !== filePath) {
      throw remapInvalid(
        'Generated authority remap contains a non-normalized path.',
      );
    }
    changes.push({ status, path: filePath });
  }
  changes.sort((left, right) => comparePaths(left.path, right.path));
  assertUniquePaths(changes.map(({ path: filePath }) => filePath));
  if (changes.length > MAX_MUTATIONS) {
    throw remapInvalid(
      `Generated authority remap exceeds the ${MAX_MUTATIONS}-file materialization limit.`,
    );
  }

  return changes.map(({ status, path: filePath }) => {
    const beforeEntry = readTreeEntry(repositoryRoot, moveCommit, filePath);
    const afterEntry = readIndexEntry(repositoryRoot, filePath);
    if (status === 'A') {
      if (beforeEntry !== null || afterEntry?.mode !== '100644') {
        throw remapInvalid(
          `Generated addition ${filePath} is not a new 100644 text file.`,
        );
      }
    } else if (status === 'D') {
      if (beforeEntry === null || afterEntry !== null) {
        throw remapInvalid(`Generated deletion ${filePath} is malformed.`);
      }
    } else if (
      beforeEntry === null ||
      afterEntry === null ||
      beforeEntry.mode !== afterEntry.mode
    ) {
      throw remapInvalid(
        `Generated mutation ${filePath} changes or lacks its Git mode.`,
      );
    }
    const before =
      status === 'A'
        ? null
        : runGitBuffer(repositoryRoot, ['show', `${moveCommit}:${filePath}`]);
    const after =
      status === 'D'
        ? null
        : runGitBuffer(repositoryRoot, ['show', `:${filePath}`]);
    const beforeText =
      before === null ? null : decodeText(before, `${filePath} before`);
    const afterText =
      after === null ? null : decodeText(after, `${filePath} after`);
    return Object.freeze({
      path: filePath,
      expectedBeforeSha256: before === null ? null : sha256Hex(before),
      content: afterText,
    });
  });
}

function readTreeEntry(
  repositoryRoot: string,
  commit: string,
  filePath: string,
): { mode: string; objectId: string } | null {
  const output = runGitBuffer(repositoryRoot, [
    'ls-tree',
    '-z',
    commit,
    '--',
    filePath,
  ]);
  if (output.length === 0) return null;
  const records = splitNul(output);
  if (records.length !== 1) {
    throw remapInvalid(`Pinned tree entry ${filePath} is ambiguous.`);
  }
  const record = decodeText(records[0]!, `${filePath} tree entry`);
  const tab = record.indexOf('\t');
  const metadata = tab === -1 ? [] : record.slice(0, tab).split(' ');
  const observedPath = tab === -1 ? '' : record.slice(tab + 1);
  const [mode, type, objectId] = metadata;
  if (
    metadata.length !== 3 ||
    observedPath !== filePath ||
    type !== 'blob' ||
    mode === undefined ||
    objectId === undefined
  ) {
    throw remapInvalid(`Pinned tree entry ${filePath} is unsupported.`);
  }
  return { mode, objectId };
}

function readIndexEntry(
  repositoryRoot: string,
  filePath: string,
): { mode: string; objectId: string } | null {
  const output = runGitBuffer(repositoryRoot, [
    'ls-files',
    '--stage',
    '-z',
    '--',
    filePath,
  ]);
  if (output.length === 0) return null;
  const records = splitNul(output);
  if (records.length !== 1) {
    throw remapInvalid(`Generated index entry ${filePath} is ambiguous.`);
  }
  const record = decodeText(records[0]!, `${filePath} index entry`);
  const tab = record.indexOf('\t');
  const metadata = tab === -1 ? [] : record.slice(0, tab).split(' ');
  const observedPath = tab === -1 ? '' : record.slice(tab + 1);
  const [mode, objectId, stage] = metadata;
  if (
    metadata.length !== 3 ||
    observedPath !== filePath ||
    stage !== '0' ||
    mode === undefined ||
    objectId === undefined
  ) {
    throw remapInvalid(`Generated index entry ${filePath} is unsupported.`);
  }
  return { mode, objectId };
}

export function assertAllowedFinalMutations(
  mutations: readonly AuthorityRemapMutation[],
  baseAuthorityPaths: readonly string[],
  steps: readonly (
    | 'built-in-engine-closure'
    | 'workflow-bootstrap-host'
    | 'harness-bootstrap-runtime'
    | 'protected-capabilities'
  )[],
): void {
  const base = new Set(baseAuthorityPaths);
  const enabled = new Set(steps);
  for (const mutation of mutations) {
    const allowed =
      base.has(mutation.path) ||
      (enabled.has('built-in-engine-closure') &&
        BUILT_IN_OUTPUTS.has(mutation.path)) ||
      (enabled.has('workflow-bootstrap-host') &&
        WORKFLOW_BOOTSTRAP_HOST_OUTPUTS.has(mutation.path)) ||
      (enabled.has('harness-bootstrap-runtime') &&
        (HARNESS_BOOTSTRAP_OUTPUTS.has(mutation.path) ||
          mutation.path.startsWith(`${HARNESS_BOOTSTRAP_RUNTIME_ROOT}/`))) ||
      (enabled.has('protected-capabilities') &&
        mutation.path === PROTECTED_CAPABILITIES_PATH);
    if (!allowed) {
      throw remapInvalid(
        `Generated authority remap changed non-owned path ${mutation.path}.`,
      );
    }
  }
  const observed = new Set(mutations.map(({ path: filePath }) => filePath));
  for (const required of base) {
    if (!observed.has(required)) {
      throw remapInvalid(
        `Generated authority remap lost base authority projection ${required}.`,
      );
    }
  }
}

export function assertPinnedProfileAllowsFinalMutations(
  repositoryRoot: string,
  baseCommit: string,
  profileId: string,
  mutations: readonly AuthorityRemapMutation[],
): void {
  let profile: ReturnType<typeof loadCapabilityProfileFromTrustBase>;
  try {
    profile = loadCapabilityProfileFromTrustBase(
      repositoryRoot,
      baseCommit,
      profileId,
    );
  } catch {
    throw remapInvalid(
      `Authority remap profile ${profileId} is absent or invalid in the pinned trust base.`,
    );
  }
  if (mutations.length > profile.constraints.maximumFiles) {
    throw remapInvalid(
      `Authority remap exceeds profile ${profileId} file limit.`,
    );
  }
  for (const mutation of mutations) {
    const role = classifyFileRole(profile, mutation.path);
    if (role === undefined || role === 'forbidden') {
      throw remapInvalid(
        `Authority remap profile ${profileId} cannot authorize ${mutation.path}.`,
      );
    }
  }
}

function readSafeRegularFile(filePath: string, label: string): Buffer {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    stats === undefined ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1
  ) {
    throw remapInvalid(`${label} is not safe regular text.`);
  }
  return fs.readFileSync(filePath);
}

export function splitNul(output: Buffer): Buffer[] {
  if (output.length === 0) return [];
  if (output[output.length - 1] !== 0) {
    throw remapInvalid('Git returned a malformed NUL-delimited record.');
  }
  const values: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    if (index === start) {
      throw remapInvalid('Git returned an empty NUL-delimited record.');
    }
    values.push(output.subarray(start, index));
    start = index + 1;
  }
  return values;
}

export function splitNulFields(output: Buffer): Buffer[] {
  if (output.length === 0 || output[output.length - 1] !== 0) {
    throw remapInvalid('Git returned malformed NUL-delimited fields.');
  }
  const values: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== 0) continue;
    values.push(output.subarray(start, index));
    start = index + 1;
  }
  return values;
}

export function decodeText(value: Buffer, label: string): string {
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw remapInvalid(`${label} is not UTF-8 text.`);
  }
  if (decoded.includes('\0')) {
    throw remapInvalid(`${label} contains a NUL byte.`);
  }
  return decoded;
}

export function assertUniquePaths(paths: readonly string[]): void {
  if (new Set(paths).size !== paths.length) {
    throw remapInvalid('Authority remap mutations contain duplicate paths.');
  }
  const folded = new Set<string>();
  for (const filePath of paths) {
    const key = filePath.toLocaleLowerCase('en-US');
    if (folded.has(key)) {
      throw remapInvalid(
        'Authority remap mutations contain a case-fold path alias.',
      );
    }
    folded.add(key);
  }
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export function sha256(value: string | Buffer): `sha256:${string}` {
  return `sha256:${sha256Hex(value)}`;
}

function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function remapInvalid(message: string) {
  return workflowError(
    'AUTHORITY_REMAP_INVALID',
    message,
    ExitCode.verification,
  );
}
