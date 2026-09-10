/**
 * Stores and transitions role context sharing grants through reservation
 * and consumption.
 *
 * Invariants:
 * - A consumed use must match the reserved role, session, and provider
 *   bindings.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  executeRoleContextSharingGrantTransitionV1,
  type RoleContextSharingEligibilityPortV1,
} from '../../modules/authority/role-context-sharing-grant.ts';
import {
  bindingFromRoleContextSharingGrantPayloadV1,
  canonicalRoleContextSharingGrantEnvelopeV1,
  GRANT_LIFECYCLE_AUDIT_RECEIPT_KIND_V1,
  ROLE_CONTEXT_SHARING_ROLE_PAIRS_V1,
  type GrantLifecycleAuditReceiptV1,
  type GrantLifecycleState,
  type RoleContextSharingGrantEnvelopeV1,
  type RoleContextSharingGrantExpectedBindingV1,
  type RoleContextSharingRolePairV1,
} from '../../modules/authority/optional-grants-package.ts';
import type { MaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import {
  assertAuthoritativeRoleContextSharingGrantVerifier,
  type AuthoritativeRoleContextSharingGrantVerifier,
} from '../../modules/authority/role-context-sharing-grant-verifier-port.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';
import { replaceTextAtomic } from '../repository-transaction/atomic-text.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../session-workspace/session-store.ts';

const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const DIGEST = /^[0-9a-f]{64}$/u;
const MAX_RECORD_BYTES = 256 * 1024;
const MAX_ID_BYTES = 256;
const RECORD_KEYS = [
  'envelope',
  'expectedBinding',
  'grantId',
  'kind',
  'recordDigest',
  'receipts',
  'receiptDigests',
  'reservation',
  'schemaVersion',
  'state',
  'transitionDigest',
  'use',
] as const;
const BINDING_KEYS = [
  'baselineCommit',
  'baselineTree',
  'changeId',
  'changeOverrideDigest',
  'centralRoleConfigurationDigest',
  'contextGeneration',
  'eligibilityPolicyDigest',
  'lifecyclePhase',
  'planningGeneration',
  'policyBlob',
  'providerDefinitionDigest',
  'providerRegistryDigest',
  'reason',
  'repositoryId',
  'repositoryOrigin',
  'roleContextSharingPolicyDigest',
  'rolePairs',
  'sessionGeneration',
  'sharedEngineSessionId',
  'subjectDigest',
  'targetDigest',
  'taskId',
] as const;
const RECEIPT_KEYS = [
  'fromState',
  'grantId',
  'kind',
  'lifecycleContractVersion',
  'occurredAt',
  'reason',
  'schemaVersion',
  'toState',
  'transitionDigest',
] as const;
const USE_KEYS = [
  'admissionDigest',
  'assignmentDigest',
  'contextGeneration',
  'invocationId',
  'providerDefinitionDigest',
  'providerId',
  'requestDigest',
  'rolePairs',
  'sessionGeneration',
  'sessionId',
  'sharedEngineSessionId',
] as const;
const RESERVATION_KEYS = ['reservedAt', 'reservationDigest'] as const;

export class RoleContextSharingJournalError extends Error {
  readonly code:
    | 'ROLE_CONTEXT_SHARING_JOURNAL_INVALID'
    | 'ROLE_CONTEXT_SHARING_JOURNAL_UNAVAILABLE'
    | 'ROLE_CONTEXT_SHARING_JOURNAL_BINDING_MISMATCH';

  constructor(code: RoleContextSharingJournalError['code'], message: string) {
    super(message);
    this.name = 'RoleContextSharingJournalError';
    this.code = code;
  }
}

export type RoleContextSharingUseV1 = Readonly<{
  rolePairs: readonly RoleContextSharingRolePairV1[];
  providerId: string;
  sessionId: string;
  sharedEngineSessionId: string;
  contextGeneration: number;
  sessionGeneration: number;
  providerDefinitionDigest: string;
  invocationId: string;
  requestDigest: string;
  assignmentDigest: string;
  admissionDigest: string;
}>;

export type RoleContextSharingJournalRecord = Readonly<{
  schemaVersion: 1;
  kind: 'role-context-sharing-journal.v1';
  grantId: string;
  state: GrantLifecycleState;
  envelope: RoleContextSharingGrantEnvelopeV1;
  expectedBinding: RoleContextSharingGrantExpectedBindingV1 | null;
  transitionDigest: string | null;
  receipts: readonly GrantLifecycleAuditReceiptV1[];
  receiptDigests: readonly string[];
  reservation: Readonly<{
    reservedAt: string;
    reservationDigest: string;
  }> | null;
  use: RoleContextSharingUseV1 | null;
  recordDigest: string;
}>;

export type RoleContextSharingTransitionOptions = Readonly<{
  now?: Date;
  expected: RoleContextSharingGrantExpectedBindingV1;
  policy: MaintainerPolicy;
  verifier: AuthoritativeRoleContextSharingGrantVerifier;
  eligibility: RoleContextSharingEligibilityPortV1;
}>;

export type RoleContextSharingConsumeOptions =
  RoleContextSharingTransitionOptions &
    Readonly<{ use: RoleContextSharingUseV1 }>;

export type RoleContextSharingConsumeOrReadExactOptions = Readonly<{
  expected: RoleContextSharingGrantExpectedBindingV1;
  use: RoleContextSharingUseV1;
}> &
  Partial<
    Pick<
      RoleContextSharingTransitionOptions,
      'now' | 'policy' | 'verifier' | 'eligibility'
    >
  >;

export function roleContextSharingStorePaths(gitCommonDirectory: string) {
  const runtime = runtimePaths(gitCommonDirectory, 'workflow-engine');
  const root = path.join(runtime.root, 'role-context-sharing');
  return { runtime, root, records: path.join(root, 'records') };
}

export function storeAvailableRoleContextSharingGrant(
  gitCommonDirectory: string,
  envelope: RoleContextSharingGrantEnvelopeV1,
): RoleContextSharingJournalRecord {
  const canonical = canonicalRoleContextSharingGrantEnvelopeV1(envelope);
  const parsed = JSON.parse(canonical) as RoleContextSharingGrantEnvelopeV1;
  const grantId = assertGrantId(parsed.payload.grantId);
  const paths = roleContextSharingStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    ensureRecordDirectory(paths.records);
    const target = recordPath(paths.records, grantId);
    if (fs.existsSync(target)) throw unavailable(grantId);
    const record = materializeRecord({
      schemaVersion: 1,
      kind: 'role-context-sharing-journal.v1',
      grantId,
      state: 'available',
      envelope: parsed,
      expectedBinding: null,
      transitionDigest: null,
      receipts: [],
      receiptDigests: [],
      reservation: null,
      use: null,
    });
    assertOwned();
    writeRecord(target, record, false);
    return record;
  });
}

export function readRoleContextSharingRecord(
  gitCommonDirectory: string,
  grantId: string,
): RoleContextSharingJournalRecord {
  const paths = roleContextSharingStorePaths(gitCommonDirectory);
  return readRecord(recordPath(paths.records, assertGrantId(grantId)));
}

export function listRoleContextSharingRecords(
  gitCommonDirectory: string,
): RoleContextSharingJournalRecord[] {
  const paths = roleContextSharingStorePaths(gitCommonDirectory);
  const stats = fs.lstatSync(paths.records, { throwIfNoEntry: false });
  if (!stats) return [];
  assertRecordDirectory(paths.records, stats);
  return fs
    .readdirSync(paths.records)
    .sort()
    .map((entry) => {
      if (!RECORD_FILE.test(entry)) throw invalid('Unexpected journal entry.');
      return readRecord(path.join(paths.records, entry));
    });
}

export function reserveRoleContextSharingGrant(
  gitCommonDirectory: string,
  grantId: string,
  options: RoleContextSharingTransitionOptions,
): RoleContextSharingJournalRecord {
  const paths = roleContextSharingStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    reserveRoleContextSharingGrantUnderLifecycleLock(
      paths,
      assertGrantId(grantId),
      options,
      assertOwned,
    ),
  );
}

export function reserveOrReadExactRoleContextSharingGrant(
  gitCommonDirectory: string,
  grantId: string,
  options: RoleContextSharingTransitionOptions,
): RoleContextSharingJournalRecord {
  const paths = roleContextSharingStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    reserveOrReadExactRoleContextSharingGrantUnderLifecycleLock(
      paths,
      assertGrantId(grantId),
      options,
      assertOwned,
    ),
  );
}

export function reserveOrReadExactRoleContextSharingGrantUnderLifecycleLock(
  paths: ReturnType<typeof roleContextSharingStorePaths>,
  grantId: string,
  options: RoleContextSharingTransitionOptions,
  assertOwned: () => void,
): RoleContextSharingJournalRecord {
  assertOwned();
  const current = readRecord(recordPath(paths.records, assertGrantId(grantId)));
  if (current.state === 'available') {
    return reserveRoleContextSharingGrantUnderLifecycleLock(
      paths,
      grantId,
      options,
      assertOwned,
    );
  }
  if (current.state === 'reserved') {
    assertCurrentTransitionAuthority(options);
    assertExpectedBinding(current, options.expected);
    return current;
  }
  throw unavailable(grantId);
}

export function reserveRoleContextSharingGrantUnderLifecycleLock(
  paths: ReturnType<typeof roleContextSharingStorePaths>,
  grantId: string,
  options: RoleContextSharingTransitionOptions,
  assertOwned: () => void,
): RoleContextSharingJournalRecord {
  assertOwned();
  assertCurrentTransitionAuthority(options);
  const current = readRecord(recordPath(paths.records, assertGrantId(grantId)));
  if (current.state !== 'available') throw unavailable(grantId);
  assertExpectedBinding(current, options.expected);
  const now = exactNow(options.now);
  const transition = executeRoleContextSharingGrantTransitionV1(
    {
      envelope: current.envelope,
      policy: options.policy,
      options: { ...options, now },
      event: 'reserve',
    },
    {
      clock: { now: () => now },
      storage: {
        readState: () => current.state,
        applyTransition(input) {
          if (
            input.receipt.toState !== 'reserved' ||
            input.validation === undefined
          ) {
            throw unavailable(grantId);
          }
          const next = materializeRecord({
            ...current,
            state: 'reserved',
            expectedBinding: options.expected,
            transitionDigest: input.receipt.transitionDigest,
            receipts: [...current.receipts, input.receipt],
            receiptDigests: [...current.receiptDigests, input.receiptDigest],
            reservation: {
              reservedAt: input.receipt.occurredAt,
              reservationDigest: input.receiptDigest,
            },
          });
          assertOwned();
          writeRecord(recordPath(paths.records, grantId), next, true);
          return next;
        },
      },
    },
  );
  return transition.value;
}

export function consumeRoleContextSharingGrant(
  gitCommonDirectory: string,
  grantId: string,
  options: RoleContextSharingConsumeOptions,
): RoleContextSharingJournalRecord {
  const paths = roleContextSharingStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    consumeRoleContextSharingGrantUnderLifecycleLock(
      paths,
      assertGrantId(grantId),
      options,
      assertOwned,
    ),
  );
}

export function consumeOrReadExactRoleContextSharingGrant(
  gitCommonDirectory: string,
  grantId: string,
  options: RoleContextSharingConsumeOrReadExactOptions,
): RoleContextSharingJournalRecord {
  const paths = roleContextSharingStorePaths(gitCommonDirectory);
  return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
    consumeOrReadExactRoleContextSharingGrantUnderLifecycleLock(
      paths,
      assertGrantId(grantId),
      options,
      assertOwned,
    ),
  );
}

export function consumeOrReadExactRoleContextSharingGrantUnderLifecycleLock(
  paths: ReturnType<typeof roleContextSharingStorePaths>,
  grantId: string,
  options: RoleContextSharingConsumeOrReadExactOptions,
  assertOwned: () => void,
): RoleContextSharingJournalRecord {
  assertOwned();
  const current = readRecord(recordPath(paths.records, assertGrantId(grantId)));
  if (current.state === 'consumed') {
    assertExpectedBinding(current, options.expected);
    assertUseMatches(current, options.use);
    return current;
  }
  if (current.state !== 'reserved') throw unavailable(grantId);
  if (!hasConsumeTransitionAuthority(options)) {
    throw unavailable(grantId);
  }
  return consumeRoleContextSharingGrantUnderLifecycleLock(
    paths,
    grantId,
    options,
    assertOwned,
  );
}

export function consumeRoleContextSharingGrantUnderLifecycleLock(
  paths: ReturnType<typeof roleContextSharingStorePaths>,
  grantId: string,
  options: RoleContextSharingConsumeOptions,
  assertOwned: () => void,
): RoleContextSharingJournalRecord {
  assertOwned();
  assertCurrentTransitionAuthority(options);
  const current = readRecord(recordPath(paths.records, assertGrantId(grantId)));
  if (current.state !== 'reserved' || current.expectedBinding === null) {
    throw unavailable(grantId);
  }
  assertExpectedBinding(current, options.expected);
  assertUseMatches(current, options.use);
  const now = exactNow(options.now);
  const transition = executeRoleContextSharingGrantTransitionV1(
    {
      envelope: current.envelope,
      policy: options.policy,
      options: { ...options, now },
      event: 'consume',
    },
    {
      clock: { now: () => now },
      storage: {
        readState: () => current.state,
        applyTransition(input) {
          const next = materializeRecord({
            ...current,
            state: input.receipt.toState,
            transitionDigest: input.receipt.transitionDigest,
            receipts: [...current.receipts, input.receipt],
            receiptDigests: [...current.receiptDigests, input.receiptDigest],
            use: input.receipt.toState === 'consumed' ? options.use : null,
          });
          assertOwned();
          writeRecord(recordPath(paths.records, grantId), next, true);
          return next;
        },
      },
    },
  );
  return transition.value;
}

function assertExpectedBinding(
  record: RoleContextSharingJournalRecord,
  expected: RoleContextSharingGrantExpectedBindingV1,
): void {
  const envelopeBinding = bindingFromRoleContextSharingGrantPayloadV1(
    record.envelope.payload,
  );
  if (canonicalJson(envelopeBinding) !== canonicalJson(expected)) {
    throw new RoleContextSharingJournalError(
      'ROLE_CONTEXT_SHARING_JOURNAL_BINDING_MISMATCH',
      'Role-context-sharing journal does not match the exact expected binding.',
    );
  }
  if (
    record.expectedBinding !== null &&
    canonicalJson(record.expectedBinding) !== canonicalJson(expected)
  ) {
    throw new RoleContextSharingJournalError(
      'ROLE_CONTEXT_SHARING_JOURNAL_BINDING_MISMATCH',
      'Role-context-sharing journal reservation binding changed.',
    );
  }
}

function assertUseMatches(
  record: RoleContextSharingJournalRecord,
  use: RoleContextSharingUseV1,
): void {
  const payload = record.envelope.payload;
  if (
    (record.use !== null && canonicalJson(record.use) !== canonicalJson(use)) ||
    canonicalJson(use.rolePairs) !== canonicalJson(payload.rolePairs) ||
    !isBoundedId(use.providerId) ||
    !isBoundedId(use.sessionId) ||
    !isBoundedId(use.sharedEngineSessionId) ||
    !isBoundedId(use.invocationId) ||
    !DIGEST.test(use.providerDefinitionDigest) ||
    !DIGEST.test(use.requestDigest) ||
    !DIGEST.test(use.assignmentDigest) ||
    !DIGEST.test(use.admissionDigest) ||
    !Number.isSafeInteger(use.contextGeneration) ||
    use.contextGeneration < 0 ||
    !Number.isSafeInteger(use.sessionGeneration) ||
    use.sessionGeneration < 0 ||
    use.sharedEngineSessionId !== payload.sharedEngineSessionId ||
    use.contextGeneration !== payload.contextGeneration ||
    use.sessionGeneration !== payload.sessionGeneration ||
    use.providerDefinitionDigest !== payload.providerDefinitionDigest
  ) {
    throw new RoleContextSharingJournalError(
      'ROLE_CONTEXT_SHARING_JOURNAL_BINDING_MISMATCH',
      'Role-context-sharing use does not match the reserved grant.',
    );
  }
}

function hasConsumeTransitionAuthority(
  options: RoleContextSharingConsumeOrReadExactOptions,
): options is RoleContextSharingConsumeOptions {
  return (
    options.policy !== undefined &&
    options.verifier !== undefined &&
    options.eligibility !== undefined
  );
}

function assertCurrentTransitionAuthority(
  options: Pick<RoleContextSharingTransitionOptions, 'verifier'>,
): void {
  assertAuthoritativeRoleContextSharingGrantVerifier(options.verifier);
  options.verifier.assertCurrent();
}

function readRecord(filePath: string): RoleContextSharingJournalRecord {
  const directory = path.dirname(filePath);
  const directoryStats = fs.lstatSync(directory, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    !directoryStats ||
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    (directoryStats.mode & 0o777n) !== 0o700n ||
    fs.realpathSync(directory) !== directory
  ) {
    throw invalid('Role-context-sharing journal directory is unsafe.');
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollowFlag());
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      throw unavailable(path.basename(filePath, '.json'));
    }
    throw invalid('Role-context-sharing journal cannot be opened safely.');
  }
  let raw: string;
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    assertStableRecordFile(before);
    const bytes = fs.readFileSync(descriptor);
    if (bytes.length > MAX_RECORD_BYTES)
      throw invalid('Role-context-sharing journal is oversized.');
    try {
      raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw invalid('Role-context-sharing journal is not valid UTF-8.');
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    const current = fs.lstatSync(filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const currentDirectory = fs.lstatSync(directory, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      !current ||
      !currentDirectory ||
      !sameRecordIdentity(before, after) ||
      !sameRecordIdentity(before, current) ||
      !sameDirectoryIdentity(directoryStats, currentDirectory) ||
      fs.realpathSync(directory) !== directory
    ) {
      throw invalid('Role-context-sharing journal changed during read.');
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return parseRoleContextSharingJournalRecord(raw);
}

/**
 * Parse the same canonical terminal projection from an immutable audit tag as
 * from the cooperative Git-common-dir journal. This parser grants no lifecycle
 * authority: it only authenticates the complete record shape and digest before
 * a purpose-specific historical verifier decides replay admission.
 */
export function parseRoleContextSharingJournalRecord(
  raw: string,
): RoleContextSharingJournalRecord {
  if (
    typeof raw !== 'string' ||
    Buffer.byteLength(raw) > MAX_RECORD_BYTES ||
    !raw.endsWith('\n')
  ) {
    throw invalid('Role-context-sharing journal bytes are invalid.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid('Role-context-sharing journal is not JSON.');
  }
  const record = assertRecord(parsed);
  if (raw !== `${canonicalJson(record)}\n`) {
    throw invalid('Role-context-sharing journal is not canonical.');
  }
  if (record.recordDigest !== digestRecord(record)) {
    throw invalid('Role-context-sharing journal digest drifted.');
  }
  return record;
}

function assertRecord(value: unknown): RoleContextSharingJournalRecord {
  if (!value || typeof value !== 'object')
    throw invalid('Role-context-sharing journal is invalid.');
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, RECORD_KEYS) ||
    record.schemaVersion !== 1 ||
    record.kind !== 'role-context-sharing-journal.v1' ||
    typeof record.grantId !== 'string' ||
    !GRANT_ID.test(record.grantId) ||
    !record.envelope ||
    !Array.isArray(record.receipts) ||
    !Array.isArray(record.receiptDigests) ||
    !DIGEST.test(String(record.recordDigest)) ||
    !['available', 'reserved', 'consumed', 'failed'].includes(
      String(record.state),
    ) ||
    (record.transitionDigest !== null &&
      !DIGEST.test(String(record.transitionDigest)))
  )
    throw invalid('Role-context-sharing journal shape is invalid.');
  const envelope = record.envelope as RoleContextSharingGrantEnvelopeV1;
  canonicalRoleContextSharingGrantEnvelopeV1(envelope);
  if (envelope.payload.grantId !== record.grantId)
    throw invalid('Grant id does not match envelope.');
  assertBinding(record.expectedBinding, envelope);
  assertReceipts(record);
  assertReservationAndUse(record, envelope);
  return record as unknown as RoleContextSharingJournalRecord;
}

function assertBinding(
  value: unknown,
  envelope: RoleContextSharingGrantEnvelopeV1,
): void {
  if (value === null) return;
  if (
    !value ||
    typeof value !== 'object' ||
    !hasExactKeys(value as Record<string, unknown>, BINDING_KEYS)
  ) {
    throw invalid('Role-context-sharing expected binding is invalid.');
  }
  const expected = bindingFromRoleContextSharingGrantPayloadV1(
    envelope.payload,
  );
  if (canonicalJson(value) !== canonicalJson(expected)) {
    throw invalid('Role-context-sharing expected binding drifted.');
  }
}

function assertReceipts(record: Record<string, unknown>): void {
  const receipts = record.receipts as unknown[];
  const receiptDigests = record.receiptDigests as unknown[];
  if (receiptDigests.length !== receipts.length)
    throw invalid('Journal receipt digest count is invalid.');
  let prior: GrantLifecycleState = 'available';
  for (let index = 0; index < receipts.length; index += 1) {
    const value = receipts[index];
    if (
      !value ||
      typeof value !== 'object' ||
      !hasExactKeys(value as Record<string, unknown>, RECEIPT_KEYS)
    ) {
      throw invalid('Journal receipt shape is invalid.');
    }
    const receipt = value as Record<string, unknown>;
    if (
      receipt.schemaVersion !== 1 ||
      receipt.kind !== GRANT_LIFECYCLE_AUDIT_RECEIPT_KIND_V1 ||
      receipt.lifecycleContractVersion !== 'jigwright.grant-lifecycle.v1' ||
      receipt.grantId !== record.grantId ||
      receipt.fromState !== prior ||
      !['reserved', 'consumed', 'failed'].includes(String(receipt.toState)) ||
      typeof receipt.reason !== 'string' ||
      !isBoundedId(receipt.reason) ||
      !isCanonicalIso(receipt.occurredAt) ||
      (receipt.transitionDigest !== null &&
        !DIGEST.test(String(receipt.transitionDigest))) ||
      typeof receiptDigests[index] !== 'string' ||
      !DIGEST.test(receiptDigests[index] as string) ||
      sha256(
        `${JSON.stringify({
          schemaVersion: receipt.schemaVersion,
          kind: receipt.kind,
          lifecycleContractVersion: receipt.lifecycleContractVersion,
          grantId: receipt.grantId,
          transitionDigest: receipt.transitionDigest,
          fromState: receipt.fromState,
          toState: receipt.toState,
          occurredAt: receipt.occurredAt,
          reason: receipt.reason,
        })}\n`,
      ) !== receiptDigests[index]
    ) {
      throw invalid('Journal receipt contents are invalid.');
    }
    prior = receipt.toState as GrantLifecycleState;
  }
  const state = record.state as GrantLifecycleState;
  if (state === 'available' && receipts.length !== 0)
    throw invalid('Available journal has receipts.');
  if (state === 'reserved' && (receipts.length !== 1 || prior !== 'reserved'))
    throw invalid('Reserved journal receipt chain is invalid.');
  if (
    (state === 'consumed' || state === 'failed') &&
    (receipts.length !== 2 || prior !== state)
  )
    throw invalid('Terminal journal receipt chain is invalid.');
  const last = receipts.at(-1) as Record<string, unknown> | undefined;
  if ((record.transitionDigest ?? null) !== (last?.transitionDigest ?? null))
    throw invalid('Journal transition digest is incoherent.');
}

function assertReservationAndUse(
  record: Record<string, unknown>,
  envelope: RoleContextSharingGrantEnvelopeV1,
): void {
  const state = record.state as RoleContextSharingJournalRecord['state'];
  const reservation = record.reservation;
  const use = record.use;
  if (state === 'available') {
    if (
      record.expectedBinding !== null ||
      record.transitionDigest !== null ||
      reservation !== null ||
      use !== null
    ) {
      throw invalid('Available journal contains reserved or consumed fields.');
    }
    return;
  }
  if (
    !record.expectedBinding ||
    !reservation ||
    typeof reservation !== 'object' ||
    !hasExactKeys(reservation as Record<string, unknown>, RESERVATION_KEYS) ||
    !isCanonicalIso((reservation as Record<string, unknown>).reservedAt) ||
    !DIGEST.test(
      String((reservation as Record<string, unknown>).reservationDigest),
    )
  ) {
    throw invalid('Journal reservation is invalid.');
  }
  const receiptDigests = record.receiptDigests as string[];
  if (
    receiptDigests[0] !==
    (reservation as Record<string, unknown>).reservationDigest
  ) {
    throw invalid('Journal reservation digest is incoherent.');
  }
  if (state === 'reserved' || state === 'failed') {
    if (use !== null)
      throw invalid('Non-consumed journal contains a use projection.');
    return;
  }
  if (
    !use ||
    typeof use !== 'object' ||
    !hasExactKeys(use as Record<string, unknown>, USE_KEYS)
  ) {
    throw invalid('Consumed journal use projection is invalid.');
  }
  assertUseShape(use as Record<string, unknown>, envelope);
}

function assertUseShape(
  value: Record<string, unknown>,
  envelope: RoleContextSharingGrantEnvelopeV1,
): void {
  if (
    !Array.isArray(value.rolePairs) ||
    value.rolePairs.some(
      (pair) =>
        !ROLE_CONTEXT_SHARING_ROLE_PAIRS_V1.includes(
          pair as RoleContextSharingRolePairV1,
        ),
    ) ||
    canonicalJson(value.rolePairs) !==
      canonicalJson(envelope.payload.rolePairs) ||
    !isBoundedId(value.providerId) ||
    !isBoundedId(value.sessionId) ||
    !isBoundedId(value.sharedEngineSessionId) ||
    !isBoundedId(value.invocationId) ||
    !DIGEST.test(String(value.providerDefinitionDigest)) ||
    !DIGEST.test(String(value.requestDigest)) ||
    !DIGEST.test(String(value.assignmentDigest)) ||
    !DIGEST.test(String(value.admissionDigest)) ||
    !Number.isSafeInteger(value.contextGeneration) ||
    (value.contextGeneration as number) < 0 ||
    !Number.isSafeInteger(value.sessionGeneration) ||
    (value.sessionGeneration as number) < 0 ||
    value.sharedEngineSessionId !== envelope.payload.sharedEngineSessionId ||
    value.contextGeneration !== envelope.payload.contextGeneration ||
    value.sessionGeneration !== envelope.payload.sessionGeneration ||
    value.providerDefinitionDigest !== envelope.payload.providerDefinitionDigest
  )
    throw invalid(
      'Consumed journal use projection does not match the envelope.',
    );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

function isBoundedId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= MAX_ID_BYTES &&
    value.trim() === value
  );
}

function isCanonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
}

function assertStableRecordFile(stats: fs.BigIntStats): void {
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1n ||
    stats.size < 2n ||
    stats.size > BigInt(MAX_RECORD_BYTES) ||
    (stats.mode & 0o777n) !== 0o600n
  )
    throw invalid(
      'Role-context-sharing journal file mode or identity is unsafe.',
    );
}

function sameRecordIdentity(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameDirectoryIdentity(
  left: fs.BigIntStats,
  right: fs.BigIntStats,
): boolean {
  return (
    left.isDirectory() &&
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function materializeRecord(
  record: Omit<RoleContextSharingJournalRecord, 'recordDigest'>,
): RoleContextSharingJournalRecord {
  return { ...record, recordDigest: digestRecord(record) };
}

function digestRecord(
  record:
    | Omit<RoleContextSharingJournalRecord, 'recordDigest'>
    | RoleContextSharingJournalRecord,
): string {
  const { recordDigest: _ignored, ...withoutDigest } =
    record as RoleContextSharingJournalRecord;
  return crypto
    .createHash('sha256')
    .update(canonicalJson(withoutDigest))
    .digest('hex');
}

function writeRecord(
  filePath: string,
  record: RoleContextSharingJournalRecord,
  replace: boolean,
): void {
  replaceTextAtomic(filePath, `${canonicalJson(record)}\n`, {
    allowCreate: !replace,
    defaultMode: 0o600,
  });
}

function ensureRecordDirectory(directory: string): void {
  ensurePlainDirectory(directory);
  fs.chmodSync(directory, 0o700);
  assertRecordDirectory(directory, fs.lstatSync(directory));
}

function assertRecordDirectory(directory: string, stats: fs.Stats): void {
  if (
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    fs.realpathSync(directory) !== path.resolve(directory)
  ) {
    throw invalid('Role-context-sharing journal directory is unsafe.');
  }
}

function recordPath(directory: string, grantId: string): string {
  return path.join(directory, `${assertGrantId(grantId)}.json`);
}

function assertGrantId(value: string): string {
  if (!GRANT_ID.test(value))
    throw invalid('Role-context-sharing grant id is invalid.');
  return value;
}

function exactNow(value: Date | undefined): Date {
  const now = value ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw invalid('Role-context-sharing clock value is invalid.');
  }
  return new Date(now.getTime());
}

function unavailable(grantId: string): RoleContextSharingJournalError {
  return new RoleContextSharingJournalError(
    'ROLE_CONTEXT_SHARING_JOURNAL_UNAVAILABLE',
    `Role-context-sharing grant ${grantId} is unavailable.`,
  );
}

function invalid(message: string): RoleContextSharingJournalError {
  return new RoleContextSharingJournalError(
    'ROLE_CONTEXT_SHARING_JOURNAL_INVALID',
    message,
  );
}
