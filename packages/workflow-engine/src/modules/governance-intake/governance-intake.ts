import { createGovernanceFindingOperations } from './governance-findings.ts';
import type { GovernanceFindingRefPort } from './governance-finding-ref.ts';
import {
  createGovernanceSourceV1,
  parseGovernanceSourceV1,
} from '@jigwright/core/governance-source';
import type {
  GovernanceSourceAuthoringV1,
  GovernanceSourceV1,
} from '@jigwright/core/governance-source';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { GOVERNANCE_SOURCE_LEDGER_ROOT } from '@jigwright/core/repository-consumer-port';
import fs from 'node:fs';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import {
  publishCreateOnlyCanonical,
  readStableGovernanceBytes,
} from './governance-intake-storage.ts';

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

export type GovernanceFindingDispositionV1 =
  'pending' | 'converted' | 'linked' | 'dismissed';

export type GovernanceFindingDispositionTargetV1 =
  | Readonly<{ kind: 'work-item'; id: `WORK-${string}` }>
  | Readonly<{ kind: 'change'; id: string }>
  | null;

export type GovernanceFindingDispositionAuthoringV1 = Readonly<{
  schemaVersion: 1;
  disposition: Exclude<GovernanceFindingDispositionV1, 'pending'>;
  reason: string;
  target: GovernanceFindingDispositionTargetV1;
}>;

export type GovernanceFindingReadModelV1 = GovernanceFindingV1 &
  Readonly<{
    disposition: GovernanceFindingDispositionV1;
    reason: string | null;
    target: GovernanceFindingDispositionTargetV1;
    disposedAt: string | null;
  }>;

export type GovernanceFindingDispositionReceiptV1 = Readonly<{
  schemaVersion: 1;
  kind: typeof GOVERNANCE_FINDING_DISPOSITION_KIND;
  findingId: `FND-${string}`;
  disposition: Exclude<GovernanceFindingDispositionV1, 'pending'>;
  reason: string;
  target: GovernanceFindingDispositionTargetV1;
  recordedAt: string;
}>;

const SOURCE_ID = /^SRC-[0-9a-f]{64}$/;

const SOURCE_FILE_MODE = 0o644;

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
    SOURCE_FILE_MODE,
    'GOVERNANCE_SOURCE_COLLISION',
  );
  return { source, relativePath, created };
}

export function readGovernanceSource(
  repositoryRoot: string,
  requestedSourceId: string,
): GovernanceSourceV1 {
  const sourceId = sourceReference(requestedSourceId);
  const relativePath = governanceSourceRelativePath(sourceId);
  const sourcePath = path.join(repositoryRoot, ...relativePath.split('/'));
  const bytes = readStableGovernanceBytes(sourcePath, SOURCE_FILE_MODE, () =>
    intakeInvalid('Governance Source must resolve to one plain record.'),
  );
  let serialized: string;
  let value: unknown;
  try {
    serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(serialized);
  } catch {
    throw intakeInvalid('Governance Source is invalid.');
  }
  const source = parseGovernanceSourceV1(value);
  if (source.id !== sourceId || serialized !== `${canonicalJson(source)}\n`) {
    throw intakeInvalid(
      'Governance Source path, identity, or canonical bytes are invalid.',
    );
  }
  return source;
}

export function listGovernanceSources(
  repositoryRoot: string,
): GovernanceSourceV1[] {
  const ledgerRoot = path.join(
    repositoryRoot,
    ...GOVERNANCE_SOURCE_LEDGER_ROOT.split('/'),
  );
  let rootStats: fs.Stats | undefined;
  try {
    rootStats = fs.lstatSync(ledgerRoot, { throwIfNoEntry: false });
  } catch {
    throw intakeInvalid(
      'Governance Source ledger root must be a plain directory.',
    );
  }
  if (rootStats === undefined) return [];
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw intakeInvalid(
      'Governance Source ledger root must be a plain directory.',
    );
  }
  const sources: GovernanceSourceV1[] = [];
  for (const prefix of fs.readdirSync(ledgerRoot, { withFileTypes: true })) {
    const prefixRoot = path.join(ledgerRoot, prefix.name);
    const prefixStats = fs.lstatSync(prefixRoot);
    if (
      prefix.isSymbolicLink() ||
      !prefix.isDirectory() ||
      prefixStats.isSymbolicLink() ||
      !prefixStats.isDirectory() ||
      !/^[0-9a-f]{2}$/.test(prefix.name)
    ) {
      throw intakeInvalid(
        'Governance Source ledger contains a noncanonical prefix entry.',
      );
    }
    for (const entry of fs.readdirSync(prefixRoot, { withFileTypes: true })) {
      const sourcePath = path.join(prefixRoot, entry.name);
      const sourceStats = fs.lstatSync(sourcePath);
      if (
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        sourceStats.isSymbolicLink() ||
        !sourceStats.isFile() ||
        !/^[0-9a-f]{64}\.json$/.test(entry.name)
      ) {
        throw intakeInvalid(
          'Governance Source ledger contains a noncanonical record entry.',
        );
      }
      const digest = entry.name.slice(0, -'.json'.length);
      if (prefix.name !== digest.slice(0, 2)) {
        throw intakeInvalid('Governance Source path prefix is invalid.');
      }
      sources.push(readGovernanceSource(repositoryRoot, `SRC-${digest}`));
    }
  }
  return sources.sort((left, right) => left.id.localeCompare(right.id));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

function governanceSourceRelativePath(sourceId: `SRC-${string}`): string {
  const digest = sourceId.slice('SRC-'.length);
  return path.posix.join(
    GOVERNANCE_SOURCE_LEDGER_ROOT,
    digest.slice(0, 2),
    `${digest}.json`,
  );
}

function sourceReference(value: string): `SRC-${string}` {
  if (!SOURCE_ID.test(value)) {
    throw intakeInvalid('Governance Source reference is invalid.');
  }
  return value as `SRC-${string}`;
}

function intakeInvalid(message: string) {
  return workflowError('GOVERNANCE_INTAKE_INVALID', message, ExitCode.usage);
}

export type GovernanceFindingOperationBindings = Readonly<{
  findingRef: GovernanceFindingRefPort;
  readGovernanceSource: typeof readGovernanceSource;
  intakeInvalid: typeof intakeInvalid;
  isRecord: typeof isRecord;
  hasExactKeys: typeof hasExactKeys;
  sourceReference: typeof sourceReference;
}>;

export function createGovernanceFindingServices(
  findingRef: GovernanceFindingRefPort,
) {
  return createGovernanceFindingOperations({
    findingRef,
    readGovernanceSource,
    intakeInvalid,
    isRecord,
    hasExactKeys,
    sourceReference,
  });
}
const GOVERNANCE_FINDING_DISPOSITION_KIND = 'governance-finding-disposition.v1';
