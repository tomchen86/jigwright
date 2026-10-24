/** Pure Finding identity, canonical byte admission and append-only read projection. */
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  intakeInvalid,
  isRecord,
  hasExactKeys,
  sourceReference,
  GOVERNANCE_FINDING_DISPOSITION_KIND,
} from './governance-intake.ts';
import type {
  GovernanceFindingContextV1,
  GovernanceFindingAuthoringV1,
  GovernanceFindingV1,
  GovernanceFindingReadModelV1,
  GovernanceFindingDispositionAuthoringV1,
  GovernanceFindingDispositionReceiptV1,
  GovernanceFindingDispositionV1,
  GovernanceFindingDispositionTargetV1,
} from './governance-intake.ts';
const FINDING_ID = /^FND-[0-9a-f]{64}$/;
const FINDING_RECORD_NAME = /^(FND-[0-9a-f]{64})\.json$/;
const FINDING_DISPOSITION_RECORD_NAME =
  /^(FND-[0-9a-f]{64})\.disposition\.json$/;
const FINDING_KEYS = [
  'branch',
  'changeId',
  'createdAt',
  'head',
  'id',
  'repositoryRoot',
  'schemaVersion',
  'sessionId',
  'sourceRefs',
  'text',
  'tree',
] as const;
const FINDING_DISPOSITION_KEYS = [
  'disposition',
  'findingId',
  'kind',
  'reason',
  'recordedAt',
  'schemaVersion',
  'target',
] as const;

function readGovernanceFindingStore(
  records: ReadonlyMap<string, Buffer>,
): Readonly<{
  findings: Map<
    `FND-${string}`,
    Readonly<{ finding: GovernanceFindingV1; path: string }>
  >;
  dispositions: Map<
    `FND-${string}`,
    Readonly<{ receipt: GovernanceFindingDispositionReceiptV1; path: string }>
  >;
}> {
  const findings = new Map<
    `FND-${string}`,
    Readonly<{ finding: GovernanceFindingV1; path: string }>
  >();
  const dispositions = new Map<
    `FND-${string}`,
    Readonly<{ receipt: GovernanceFindingDispositionReceiptV1; path: string }>
  >();
  for (const [recordPath, bytes] of records) {
    const [, session, name] = recordPath.split('/');
    const dispositionMatch = FINDING_DISPOSITION_RECORD_NAME.exec(name!);
    if (dispositionMatch !== null) {
      const findingId = findingReference(dispositionMatch[1]!);
      if (dispositions.has(findingId))
        throw intakeInvalid('Governance Finding disposition is ambiguous.');
      const receipt = readGovernanceFindingDispositionReceipt(bytes, findingId);
      dispositions.set(findingId, { receipt, path: recordPath });
      continue;
    }
    const findingId = findingReference(FINDING_RECORD_NAME.exec(name!)![1]!);
    if (findings.has(findingId))
      throw intakeInvalid('Governance Finding identity is ambiguous.');
    const finding = readGovernanceFindingRecord(bytes, findingId);
    if (finding.sessionId !== session)
      throw intakeInvalid('Governance Finding session and path do not agree.');
    findings.set(findingId, { finding, path: recordPath });
  }
  return { findings, dispositions };
}

function readGovernanceFindingRecord(
  bytes: Buffer,
  expectedFindingId: `FND-${string}`,
): GovernanceFindingV1 {
  let serialized: string;
  let value: unknown;
  try {
    serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(serialized);
  } catch {
    throw intakeInvalid('Governance Finding is invalid.');
  }
  const finding = parseGovernanceFinding(value);
  if (
    finding.id !== expectedFindingId ||
    serialized !== `${canonicalJson(finding)}\n`
  ) {
    throw intakeInvalid(
      'Governance Finding path, identity, or canonical bytes are invalid.',
    );
  }
  return finding;
}

function readGovernanceFindingDispositionReceipt(
  bytes: Buffer,
  expectedFindingId: `FND-${string}`,
): GovernanceFindingDispositionReceiptV1 {
  let serialized: string;
  let value: unknown;
  try {
    serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(serialized);
  } catch {
    throw intakeInvalid('Governance Finding disposition is invalid.');
  }
  const receipt = parseGovernanceFindingDispositionReceipt(value);
  if (
    receipt.findingId !== expectedFindingId ||
    serialized !== `${canonicalJson(receipt)}\n`
  ) {
    throw intakeInvalid(
      'Governance Finding disposition path or canonical bytes are invalid.',
    );
  }
  return receipt;
}

function parseGovernanceFinding(value: unknown): GovernanceFindingV1 {
  if (!isRecord(value) || !hasExactKeys(value, FINDING_KEYS)) {
    throw intakeInvalid('Governance Finding is invalid.');
  }
  if (
    typeof value.id !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.branch !== 'string' ||
    typeof value.head !== 'string' ||
    typeof value.tree !== 'string'
  ) {
    throw intakeInvalid('Governance Finding is invalid.');
  }
  const sourceRefs = findingSourceReferences(value.sourceRefs, true);
  const finding: GovernanceFindingV1 = {
    schemaVersion: value.schemaVersion as 1,
    id: findingReference(value.id),
    createdAt: canonicalTimestamp(value.createdAt),
    sessionId: boundedIdentifier(value.sessionId, 'session'),
    changeId: boundedIdentifier(value.changeId, 'change'),
    repositoryRoot: canonicalRepositoryRoot(value.repositoryRoot),
    branch: boundedIdentifier(value.branch, 'branch'),
    head: gitOid(value.head),
    tree: gitOid(value.tree),
    text: findingText(value.text),
    sourceRefs,
  };
  if (finding.schemaVersion !== 1) {
    throw intakeInvalid('Governance Finding is invalid.');
  }
  const { id: _id, ...payload } = finding;
  if (finding.id !== `FND-${digestHex(canonicalJson(payload))}`) {
    throw intakeInvalid('Governance Finding identity is invalid.');
  }
  return finding;
}

function parseGovernanceFindingDispositionReceipt(
  value: unknown,
): GovernanceFindingDispositionReceiptV1 {
  if (!isRecord(value) || !hasExactKeys(value, FINDING_DISPOSITION_KEYS)) {
    throw intakeInvalid('Governance Finding disposition is invalid.');
  }
  if (
    typeof value.findingId !== 'string' ||
    typeof value.disposition !== 'string' ||
    typeof value.reason !== 'string' ||
    typeof value.recordedAt !== 'string'
  ) {
    throw intakeInvalid('Governance Finding disposition is invalid.');
  }
  const normalized = normalizeFindingDispositionInput({
    schemaVersion: value.schemaVersion as 1,
    disposition: value.disposition as Exclude<
      GovernanceFindingDispositionV1,
      'pending'
    >,
    reason: value.reason,
    target: value.target as GovernanceFindingDispositionTargetV1,
  });
  if (value.kind !== GOVERNANCE_FINDING_DISPOSITION_KIND) {
    throw intakeInvalid('Governance Finding disposition is invalid.');
  }
  return {
    schemaVersion: 1,
    kind: GOVERNANCE_FINDING_DISPOSITION_KIND,
    findingId: findingReference(value.findingId),
    disposition: normalized.disposition,
    reason: normalized.reason,
    target: normalized.target,
    recordedAt: canonicalTimestamp(value.recordedAt),
  };
}

function toGovernanceFindingReadModel(
  finding: GovernanceFindingV1,
  receipt: GovernanceFindingDispositionReceiptV1 | null,
): GovernanceFindingReadModelV1 {
  return receipt === null
    ? {
        ...finding,
        disposition: 'pending',
        reason: null,
        target: null,
        disposedAt: null,
      }
    : {
        ...finding,
        disposition: receipt.disposition,
        reason: receipt.reason,
        target: receipt.target,
        disposedAt: receipt.recordedAt,
      };
}

export function normalizeFindingDispositionInput(
  input: GovernanceFindingDispositionAuthoringV1,
): GovernanceFindingDispositionAuthoringV1 {
  if (
    input.schemaVersion !== 1 ||
    !['converted', 'linked', 'dismissed'].includes(input.disposition)
  ) {
    throw intakeInvalid('Governance Finding disposition input is invalid.');
  }
  const reason = findingReason(input.reason);
  const target = findingDispositionTarget(input.target);
  if (
    (input.disposition === 'dismissed' && target !== null) ||
    (input.disposition === 'converted' && target?.kind !== 'work-item') ||
    (input.disposition === 'linked' && target === null)
  ) {
    throw intakeInvalid('Governance Finding disposition target is invalid.');
  }
  return {
    schemaVersion: 1,
    disposition: input.disposition,
    reason,
    target,
  };
}

function findingDispositionTarget(
  value: GovernanceFindingDispositionTargetV1,
): GovernanceFindingDispositionTargetV1 {
  if (value === null) return null;
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'kind'])) {
    throw intakeInvalid('Governance Finding disposition target is invalid.');
  }
  if (
    value.kind === 'work-item' &&
    typeof value.id === 'string' &&
    /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(value.id)
  ) {
    return { kind: 'work-item', id: value.id as `WORK-${string}` };
  }
  if (
    value.kind === 'change' &&
    typeof value.id === 'string' &&
    /^[a-z0-9][a-z0-9-]{0,127}$/.test(value.id)
  ) {
    return { kind: 'change', id: value.id };
  }
  throw intakeInvalid('Governance Finding disposition target is invalid.');
}

export function findingReference(value: string): `FND-${string}` {
  if (!FINDING_ID.test(value)) {
    throw intakeInvalid('Governance Finding reference is invalid.');
  }
  return value as `FND-${string}`;
}

function findingText(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > 8_192 ||
    value.includes('\0')
  ) {
    throw intakeInvalid('Governance Finding input is invalid.');
  }
  return value;
}

function findingReason(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, 'utf8') > 2_000 ||
    value.includes('\0')
  ) {
    throw intakeInvalid('Governance Finding disposition reason is invalid.');
  }
  return value;
}

function findingSourceReferences(
  value: unknown,
  requireCanonicalOrder: boolean,
): `SRC-${string}`[] {
  if (!Array.isArray(value)) {
    throw intakeInvalid('Governance Finding Source references are invalid.');
  }
  const sourceRefs = value.map((sourceRef) => {
    if (typeof sourceRef !== 'string') {
      throw intakeInvalid('Governance Finding Source reference is invalid.');
    }
    return sourceReference(sourceRef);
  });
  if (new Set(sourceRefs).size !== sourceRefs.length) {
    throw intakeInvalid('Governance Finding Source references are duplicated.');
  }
  const canonical = [...sourceRefs].sort();
  if (
    requireCanonicalOrder &&
    JSON.stringify(sourceRefs) !== JSON.stringify(canonical)
  ) {
    throw intakeInvalid(
      'Governance Finding Source references are not canonical.',
    );
  }
  return canonical;
}

function canonicalRepositoryRoot(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw intakeInvalid('Governance Finding repository root is invalid.');
  }
  return value;
}

export function normalizeFindingInput(input: GovernanceFindingAuthoringV1): {
  text: string;
  sourceRefs: `SRC-${string}`[];
} {
  if (input.schemaVersion !== 1) {
    throw intakeInvalid('Governance Finding input is invalid.');
  }
  return {
    text: findingText(input.text),
    sourceRefs: findingSourceReferences(input.sourceRefs, false),
  };
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

export function canonicalTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
    throw intakeInvalid('Governance Finding timestamp is invalid.');
  }
  return value;
}

function digestHex(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

export function findingDispositionCollision() {
  return workflowError(
    'GOVERNANCE_FINDING_DISPOSITION_COLLISION',
    'Governance Finding already has a different terminal disposition.',
    ExitCode.conflict,
  );
}

export function projectGovernanceFindings(
  records: ReadonlyMap<string, Buffer>,
): GovernanceFindingReadModelV1[] {
  const store = readGovernanceFindingStore(records);
  const findings: GovernanceFindingReadModelV1[] = [];
  for (const [findingId, stored] of store.findings) {
    const storedDisposition = store.dispositions.get(findingId) ?? null;
    if (
      storedDisposition !== null &&
      path.dirname(storedDisposition.path) !== path.dirname(stored.path)
    ) {
      throw intakeInvalid(
        'Governance Finding disposition and Finding paths do not agree.',
      );
    }
    const receipt = storedDisposition?.receipt ?? null;
    if (
      receipt !== null &&
      Date.parse(receipt.recordedAt) < Date.parse(stored.finding.createdAt)
    ) {
      throw intakeInvalid(
        'Governance Finding disposition predates its immutable Finding.',
      );
    }
    findings.push(toGovernanceFindingReadModel(stored.finding, receipt));
  }
  for (const findingId of store.dispositions.keys()) {
    if (!store.findings.has(findingId)) {
      throw intakeInvalid(
        'Governance Finding disposition has no immutable Finding.',
      );
    }
  }
  return findings.sort((left, right) => left.id.localeCompare(right.id));
}

export function createGovernanceFinding(
  context: GovernanceFindingContextV1,
  normalized: ReturnType<typeof normalizeFindingInput>,
  timestamp: string,
): GovernanceFindingV1 {
  const payload = {
    schemaVersion: 1 as const,
    createdAt: canonicalTimestamp(timestamp),
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

  return finding;
}
