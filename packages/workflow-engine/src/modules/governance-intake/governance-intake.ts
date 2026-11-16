/** Canonical intake DTOs and Source byte admission; no repository access. */
import path from 'node:path';
import { canonicalJson } from '@jigwright/core/canonical-json';
import {
  parseGovernanceSourceV1,
  type GovernanceSourceV1,
} from '@jigwright/core/governance-source';
import { GOVERNANCE_SOURCE_LEDGER_ROOT } from '@jigwright/core/repository-consumer-port';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
export const GOVERNANCE_FINDING_DISPOSITION_KIND =
  'governance-finding-disposition.v1';
const SOURCE_ID = /^SRC-[0-9a-f]{64}$/;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === expected[index])
  );
}

export function governanceSourceRelativePath(
  sourceId: `SRC-${string}`,
): string {
  const digest = sourceId.slice('SRC-'.length);
  return path.posix.join(
    GOVERNANCE_SOURCE_LEDGER_ROOT,
    digest.slice(0, 2),
    `${digest}.json`,
  );
}

export function sourceReference(value: string): `SRC-${string}` {
  if (!SOURCE_ID.test(value)) {
    throw intakeInvalid('Governance Source reference is invalid.');
  }
  return value as `SRC-${string}`;
}

export function intakeInvalid(message: string) {
  return workflowError('GOVERNANCE_INTAKE_INVALID', message, ExitCode.usage);
}

export function parseGovernanceSourceBytes(
  bytes: Uint8Array,
  sourceId: `SRC-${string}`,
): GovernanceSourceV1 {
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
