import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '@jigwright/core/canonical-json';
import {
  createGovernanceSourceV1,
  parseGovernanceSourceV1,
  type GovernanceSourceAuthoringV1,
  type GovernanceSourceV1,
} from '@jigwright/core/governance-source';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type GovernanceFindingAuthoringV1 = Readonly<{
  schemaVersion: 1;
  text: string;
  sourceRefs: readonly string[];
}>;

export type GovernanceFindingContextV1 = Readonly<{
  repositoryRoot: string;
  runtimeRoot: string;
  sessionId: string;
  changeId: string;
  branch: string;
  head: string;
  tree: string;
}>;

export type GovernanceFindingV1 = Readonly<{
  schemaVersion: 1;
  id: `FND-${string}`;
  createdAt: string;
  sessionId: string;
  changeId: string;
  repositoryRoot: string;
  branch: string;
  head: string;
  tree: string;
  text: string;
  sourceRefs: readonly `SRC-${string}`[];
}>;

const SOURCE_LEDGER_ROOT = 'workflow/source-ledger/objects/sha256';
const SOURCE_ID = /^SRC-[0-9a-f]{64}$/;

export function captureGovernanceSource(
  repositoryRoot: string,
  input: GovernanceSourceAuthoringV1,
): {
  source: GovernanceSourceV1;
  relativePath: string;
  created: boolean;
} {
  const source = createGovernanceSourceV1(input);
  if (source.supersedes !== null) {
    readGovernanceSource(repositoryRoot, source.supersedes);
  }
  const relativePath = governanceSourceRelativePath(source.id);
  const created = publishCreateOnlyCanonical(
    path.join(repositoryRoot, ...relativePath.split('/')),
    source,
    0o644,
    'GOVERNANCE_SOURCE_COLLISION',
  );
  return { source, relativePath, created };
}

export function readGovernanceSource(
  repositoryRoot: string,
  requestedSourceId: string,
  sourceRoot: string = SOURCE_LEDGER_ROOT,
): GovernanceSourceV1 {
  const sourceId = sourceReference(requestedSourceId);
  const relativePath = governanceSourceRelativePath(sourceId, sourceRoot);
  const sourcePath = path.join(repositoryRoot, ...relativePath.split('/'));
  const stats = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw intakeInvalid('Governance Source must resolve to one plain record.');
  }
  let serialized: string;
  try {
    serialized = fs.readFileSync(sourcePath, 'utf8');
  } catch {
    throw intakeInvalid('Governance Source cannot be read.');
  }
  let source: GovernanceSourceV1;
  try {
    source = parseGovernanceSourceV1(JSON.parse(serialized));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw intakeInvalid('Governance Source is invalid.');
    }
    throw error;
  }
  if (source.id !== sourceId || serialized !== `${canonicalJson(source)}\n`) {
    throw intakeInvalid(
      'Governance Source path, identity, or canonical bytes are invalid.',
    );
  }
  return source;
}

export function listGovernanceSources(
  repositoryRoot: string,
  sourceRoot: string = SOURCE_LEDGER_ROOT,
): GovernanceSourceV1[] {
  const ledgerRoot = path.join(repositoryRoot, ...sourceRoot.split('/'));
  const rootStats = fs.lstatSync(ledgerRoot, { throwIfNoEntry: false });
  if (rootStats === undefined) return [];
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw intakeInvalid(
      'Governance Source ledger root must be a plain directory.',
    );
  }
  const sources: GovernanceSourceV1[] = [];
  for (const prefix of fs.readdirSync(ledgerRoot, { withFileTypes: true })) {
    if (prefix.isSymbolicLink()) {
      throw intakeInvalid('Governance Source ledger cannot contain links.');
    }
    if (!prefix.isDirectory() || !/^[0-9a-f]{2}$/.test(prefix.name)) {
      continue;
    }
    const prefixRoot = path.join(ledgerRoot, prefix.name);
    for (const entry of fs.readdirSync(prefixRoot, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw intakeInvalid('Governance Source ledger cannot contain links.');
      }
      if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
        continue;
      }
      const digest = entry.name.slice(0, -'.json'.length);
      if (prefix.name !== digest.slice(0, 2)) {
        throw intakeInvalid('Governance Source path prefix is invalid.');
      }
      sources.push(
        readGovernanceSource(repositoryRoot, `SRC-${digest}`, sourceRoot),
      );
    }
  }
  return sources.sort((left, right) => left.id.localeCompare(right.id));
}

export function recordGovernanceFinding(
  context: GovernanceFindingContextV1,
  input: GovernanceFindingAuthoringV1,
  now: () => string = () => new Date().toISOString(),
): { finding: GovernanceFindingV1; path: string; created: boolean } {
  const normalized = normalizeFindingInput(input);
  for (const sourceRef of normalized.sourceRefs) {
    readGovernanceSource(context.repositoryRoot, sourceRef);
  }
  const payload = {
    schemaVersion: 1 as const,
    createdAt: canonicalTimestamp(now()),
    sessionId: boundedIdentifier(context.sessionId, 'session'),
    changeId: boundedIdentifier(context.changeId, 'change'),
    repositoryRoot: path.resolve(context.repositoryRoot),
    branch: boundedIdentifier(context.branch, 'branch'),
    head: gitOid(context.head),
    tree: gitOid(context.tree),
    text: normalized.text,
    sourceRefs: normalized.sourceRefs,
  };
  const finding: GovernanceFindingV1 = {
    ...payload,
    id: `FND-${digestHex(canonicalJson(payload))}`,
  };
  const directory = path.join(
    context.runtimeRoot,
    'findings',
    finding.sessionId,
  );
  ensurePrivateFindingDirectory(context.runtimeRoot, directory);
  const findingPath = path.join(directory, `${finding.id}.json`);
  const created = publishCreateOnlyCanonical(
    findingPath,
    finding,
    0o600,
    'GOVERNANCE_FINDING_COLLISION',
  );
  return { finding, path: findingPath, created };
}

function normalizeFindingInput(input: GovernanceFindingAuthoringV1): {
  text: string;
  sourceRefs: `SRC-${string}`[];
} {
  if (
    input.schemaVersion !== 1 ||
    typeof input.text !== 'string' ||
    input.text.length === 0 ||
    Buffer.byteLength(input.text, 'utf8') > 8_192 ||
    input.text.includes('\0') ||
    !Array.isArray(input.sourceRefs)
  ) {
    throw intakeInvalid('Governance Finding input is invalid.');
  }
  const sourceRefs = input.sourceRefs.map((sourceRef) => {
    if (
      typeof sourceRef !== 'string' ||
      !/^SRC-[0-9a-f]{64}$/.test(sourceRef)
    ) {
      throw intakeInvalid('Governance Finding Source reference is invalid.');
    }
    return sourceRef as `SRC-${string}`;
  });
  if (new Set(sourceRefs).size !== sourceRefs.length) {
    throw intakeInvalid('Governance Finding Source references are duplicated.');
  }
  sourceRefs.sort();
  return { text: input.text, sourceRefs };
}

function governanceSourceRelativePath(
  sourceId: `SRC-${string}`,
  sourceRoot: string = SOURCE_LEDGER_ROOT,
): string {
  const digest = sourceId.slice('SRC-'.length);
  return path.posix.join(sourceRoot, digest.slice(0, 2), `${digest}.json`);
}

function sourceReference(value: string): `SRC-${string}` {
  if (!SOURCE_ID.test(value)) {
    throw intakeInvalid('Governance Source reference is invalid.');
  }
  return value as `SRC-${string}`;
}

function ensurePrivateFindingDirectory(
  runtimeRoot: string,
  targetDirectory: string,
): void {
  const resolvedRoot = path.resolve(runtimeRoot);
  const resolvedTarget = path.resolve(targetDirectory);
  if (
    resolvedTarget !== resolvedRoot &&
    !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  ) {
    throw intakeInvalid('Governance Finding path escapes its runtime root.');
  }
  fs.mkdirSync(resolvedTarget, { recursive: true, mode: 0o700 });
  let current = resolvedRoot;
  for (const segment of path
    .relative(resolvedRoot, resolvedTarget)
    .split(path.sep)) {
    if (segment.length > 0) current = path.join(current, segment);
    const stats = fs.lstatSync(current);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (stats.mode & 0o077) !== 0
    ) {
      throw workflowError(
        'GOVERNANCE_FINDING_STORE_UNSAFE',
        'Governance Finding storage must use private plain directories.',
        ExitCode.unsafeEnvironment,
      );
    }
  }
}

function publishCreateOnlyCanonical(
  filePath: string,
  value: unknown,
  mode: number,
  collisionCode: string,
): boolean {
  const content = `${canonicalJson(value)}\n`;
  fs.mkdirSync(path.dirname(filePath), {
    recursive: true,
    mode: mode === 0o600 ? 0o700 : 0o755,
  });
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing) {
    if (
      existing.isFile() &&
      !existing.isSymbolicLink() &&
      existing.nlink === 1 &&
      fs.readFileSync(filePath, 'utf8') === content
    ) {
      return false;
    }
    throw workflowError(
      collisionCode,
      'A different immutable governance record already owns this identity.',
      ExitCode.conflict,
    );
  }

  const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporaryPath, 'wx', mode);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    try {
      fs.linkSync(temporaryPath, filePath);
    } catch (error) {
      if (
        isNodeError(error) &&
        error.code === 'EEXIST' &&
        fs.readFileSync(filePath, 'utf8') === content
      ) {
        return false;
      }
      throw error;
    }
    fsyncDirectory(path.dirname(filePath));
    return true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function boundedIdentifier(value: string, kind: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,511}$/.test(value)) {
    throw intakeInvalid(`Governance Finding ${kind} identity is invalid.`);
  }
  return value;
}

function gitOid(value: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
    throw intakeInvalid('Governance Finding Git identity is invalid.');
  }
  return value;
}

function canonicalTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw intakeInvalid('Governance Finding timestamp is invalid.');
  }
  return value;
}

function digestHex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function intakeInvalid(message: string) {
  return workflowError('GOVERNANCE_INTAKE_INVALID', message, ExitCode.usage);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
