/**
 * Persists Central Grant challenges, preparations, outcomes, and lifecycle
 * barriers.
 *
 * Invariants:
 * - Challenge publication replays only an identical pending record.
 */
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../repository-transaction/filesystem-safety.ts';
import {
  assertApprovalSubject,
  assertGrantChallenge,
  approvalSubjectDigest,
  createApprovalSubject,
  type ApprovalSubject,
  type GrantChallenge,
} from '../../modules/authority/grant-core.ts';
import {
  assertSshPortableApprovalEvidenceV1,
  sshPortableApprovalEvidenceDigest,
  sshPortableApprovalEvidenceSubjectDigest,
  type GrantProofModuleSummary,
} from '../../modules/authority/grant-approval.ts';
import {
  freezeGrantCanonical,
  GRANT_SHA256_DIGEST,
  GRANT_STABLE_ID,
  GRANT_UUID_V4,
  grantHasExactKeys,
  grantSha256,
  grantSameStrings,
  parseGrantTimestamp,
} from '../../modules/authority/grant-primitives.ts';
import {
  assertGrantParentBindingV1,
  createPreparedGrantDescendantTreeV1,
  type PreparedGrantDescendantNodeV1,
  type PreparedGrantDescendantTreeV1,
} from '../../modules/authority/grant-parent-binding.ts';
import type { TransitionOutcome } from '../../modules/authority/grant-transition-registry.ts';

const MODULE_VERSION = /^[1-9][0-9]*$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const RECORD_FILE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/;
const MAX_FILE_BYTES = 1_048_576;

export type GrantStorePaths = Readonly<{
  root: string;
  records: string;
}>;

export type { GrantProofModuleSummary } from '../../modules/authority/grant-approval.ts';

export type GrantAuditRecord = Readonly<{
  approvalMethod: 'human-presence' | 'ssh';
  authorityClass: 'local-device-owner' | 'ssh-credential';
  identity: string | null;
  identityAssurance: 'not-asserted' | 'policy-trusted-ssh-key';
  presenceAssurance: 'fresh-os-authentication' | 'not-asserted';
  proofModules: readonly string[];
}>;

type GrantRecordBase<TState extends string> = Readonly<{
  schemaVersion: 1;
  kind: 'grant-record.v1';
  state: TState;
  challenge: GrantChallenge;
  recordedAt: string;
}>;

export type PendingGrantRecord = GrantRecordBase<'pending'>;

export type PreparedGrantRecord = GrantRecordBase<'prepared'> &
  Readonly<{
    operationId: string;
    approvalSubject: ApprovalSubject;
    proofModules: readonly GrantProofModuleSummary[];
    preparedAt: string;
  }>;

export type TerminalGrantRecord = Omit<PreparedGrantRecord, 'state'> &
  Readonly<{
    state: 'completed' | 'failed';
    poststateDigest: `sha256:${string}`;
    outcome: TransitionOutcome;
    completedAt: string;
    audit: GrantAuditRecord;
  }>;

export type GrantRecord =
  PendingGrantRecord | PreparedGrantRecord | TerminalGrantRecord;

export function grantStorePaths(runtimeRoot: string): GrantStorePaths {
  const requestedRoot = path.resolve(runtimeRoot);
  const runtimeStats = fs.lstatSync(requestedRoot, { throwIfNoEntry: false });
  if (!runtimeStats?.isDirectory() || runtimeStats.isSymbolicLink()) {
    throw storeUnsafe();
  }
  const root = path.join(fs.realpathSync(requestedRoot), 'grants-v2');
  return Object.freeze({ root, records: path.join(root, 'records') });
}

export function persistGrantChallenge(
  paths: GrantStorePaths,
  candidate: GrantChallenge,
): PendingGrantRecord {
  initializeGrantStore(paths);
  const challenge = storeSafe(() => assertGrantChallenge(candidate));
  const record = freezeGrantCanonical({
    schemaVersion: 1,
    kind: 'grant-record.v1',
    state: 'pending',
    challenge,
    recordedAt: challenge.issuedAt,
  }) as PendingGrantRecord;
  const filePath = grantRecordPath(paths, challenge.challengeId);
  const existing = readOptionalCanonicalFile(filePath, assertGrantRecord);
  if (existing !== null) {
    if (
      existing.state === 'pending' &&
      canonicalJson(existing) === canonicalJson(record)
    ) {
      return existing;
    }
    throw challengeUnavailable(challenge.challengeId);
  }
  createCanonicalFile(filePath, record);
  return record;
}

export function readGrantRecord(
  paths: GrantStorePaths,
  challengeId: string,
): GrantRecord {
  assertChallengeId(challengeId);
  assertGrantStore(paths);
  const record = readOptionalCanonicalFile(
    grantRecordPath(paths, challengeId),
    assertGrantRecord,
  );
  if (record === null) {
    throw workflowError(
      'GRANT_CHALLENGE_NOT_FOUND',
      `Grant challenge ${challengeId} was not found.`,
      ExitCode.staleState,
    );
  }
  if (record.challenge.challengeId !== challengeId) throw storeUnsafe();
  return record;
}

/** Parse one exact canonical Grant record without consulting a local store. */
export function parseGrantRecord(value: string | unknown): GrantRecord {
  try {
    if (typeof value !== 'string') {
      const canonical = canonicalJson(value);
      if (Buffer.byteLength(canonical, 'utf8') + 1 > MAX_FILE_BYTES) {
        throw storeUnsafe();
      }
      return assertGrantRecord(JSON.parse(canonical) as unknown);
    }
    if (
      Buffer.byteLength(value, 'utf8') > MAX_FILE_BYTES ||
      !value.endsWith('\n')
    ) {
      throw storeUnsafe();
    }
    const record = assertGrantRecord(JSON.parse(value) as unknown);
    if (`${canonicalJson(record)}\n` !== value) throw storeUnsafe();
    return record;
  } catch (error) {
    if (error instanceof Error && 'code' in error) throw error;
    throw storeUnsafe();
  }
}

/** Rebuild the exact prepared ancestor embedded by a terminal record. */
export function projectPreparedGrantRecord(
  candidate: PreparedGrantRecord | TerminalGrantRecord,
): PreparedGrantRecord {
  const record = assertGrantRecord(candidate);
  if (record.state === 'pending') throw storeUnsafe();
  return assertGrantRecord({
    schemaVersion: record.schemaVersion,
    kind: record.kind,
    state: 'prepared',
    challenge: record.challenge,
    recordedAt: record.recordedAt,
    operationId: record.operationId,
    approvalSubject: record.approvalSubject,
    proofModules: record.proofModules,
    preparedAt: record.preparedAt,
  }) as PreparedGrantRecord;
}

export function grantRecordDigest(candidate: GrantRecord): `sha256:${string}` {
  const record = assertGrantRecord(candidate);
  return grantSha256(`workflow.grant-record.v1\n${canonicalJson(record)}`);
}

export function listGrantRecords(
  paths: GrantStorePaths,
): readonly GrantRecord[] {
  assertGrantStore(paths);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(paths.records, { withFileTypes: true });
  } catch {
    throw storeUnsafe();
  }
  const records: GrantRecord[] = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isFile() || entry.isSymbolicLink()) throw storeUnsafe();
    if (!RECORD_FILE.test(entry.name)) {
      if (/\.tmp$/.test(entry.name)) continue;
      throw storeUnsafe();
    }
    const record = readCanonicalFile(
      path.join(paths.records, entry.name),
      assertGrantRecord,
    );
    if (entry.name !== `${record.challenge.challengeId}.json`) {
      throw storeUnsafe();
    }
    records.push(record);
  }
  return Object.freeze(records);
}

export function listPreparedGrantRecords(
  paths: GrantStorePaths,
): readonly PreparedGrantRecord[] {
  return Object.freeze(
    listGrantRecords(paths).filter(
      (record): record is PreparedGrantRecord => record.state === 'prepared',
    ),
  );
}

export function inspectPreparedGrantDescendantTree(
  paths: GrantStorePaths,
  candidateRoot: PreparedGrantRecord,
): PreparedGrantDescendantTreeV1 {
  const root = assertGrantRecord(candidateRoot);
  if (root.state !== 'prepared') throw storeUnsafe();
  const remaining = new Map(
    listPreparedGrantRecords(paths)
      .filter(
        ({ challenge }) => challenge.challengeId !== root.challenge.challengeId,
      )
      .map((record) => [record.challenge.challengeId, record]),
  );
  const known = new Map<
    string,
    Readonly<{ record: PreparedGrantRecord; depth: number }>
  >([[root.challenge.challengeId, { record: root, depth: 0 }]]);
  const nodes: PreparedGrantDescendantNodeV1[] = [];
  let found = true;
  while (found) {
    found = false;
    for (const [challengeId, record] of [...remaining]) {
      const facts = record.challenge.facts;
      if (!isRecord(facts) || !Object.hasOwn(facts, 'parentGrantBinding')) {
        continue;
      }
      const binding = assertGrantParentBindingV1(facts.parentGrantBinding);
      const parent = known.get(binding.parentChallengeId);
      if (parent === undefined) continue;
      assertExactPreparedGrantParentBinding(parent.record, binding);
      const node = Object.freeze({
        schemaVersion: 1 as const,
        kind: 'prepared-grant-descendant.v1' as const,
        depth: parent.depth + 1,
        challengeId,
        challengeDigest: record.challenge.challengeDigest,
        operationId: record.operationId,
        approvalSubjectDigest: approvalSubjectDigest(record.approvalSubject),
        stateBindingDigest: record.challenge.stateBinding.digest,
        preparedRecordDigest: grantRecordDigest(record),
        parentBinding: binding,
      });
      nodes.push(node);
      known.set(challengeId, { record, depth: node.depth });
      remaining.delete(challengeId);
      found = true;
    }
  }
  return createPreparedGrantDescendantTreeV1({
    schemaVersion: 1,
    kind: 'prepared-grant-descendant-tree.v1',
    rootChallengeId: root.challenge.challengeId,
    rootPreparedRecordDigest: grantRecordDigest(root),
    nodes,
  });
}

function assertExactPreparedGrantParentBinding(
  parent: PreparedGrantRecord,
  binding: ReturnType<typeof assertGrantParentBindingV1>,
): void {
  const choice = parent.challenge.choices.find(
    ({ choiceId }) => choiceId === parent.approvalSubject.choiceId,
  );
  if (
    choice === undefined ||
    binding.parentChallengeId !== parent.challenge.challengeId ||
    binding.parentChallengeDigest !== parent.challenge.challengeDigest ||
    binding.parentOperationId !== parent.operationId ||
    binding.parentApprovalSubjectDigest !==
      approvalSubjectDigest(parent.approvalSubject) ||
    binding.parentStateBindingDigest !== parent.challenge.stateBinding.digest ||
    binding.parentParametersDigest !==
      grantSha256(canonicalJson(choice.parameters)) ||
    binding.parentPreparedRecordDigest !== grantRecordDigest(parent)
  ) {
    throw storeUnsafe();
  }
}

export function prepareGrantTransition(
  paths: GrantStorePaths,
  input: Readonly<{
    operationId: string;
    challenge: GrantChallenge;
    subject: ApprovalSubject;
    proofModules: readonly GrantProofModuleSummary[];
    createdAt: string;
  }>,
): PreparedGrantRecord {
  initializeGrantStore(paths);
  const challenge = storeSafe(() => assertGrantChallenge(input.challenge));
  assertChallengeId(challenge.challengeId);
  if (!GRANT_UUID_V4.test(input.operationId)) throw storeUnsafe();
  const subject = assertSubjectForChallenge(challenge, input.subject);
  const preparedAt = parseGrantTimestamp(input.createdAt);
  if (
    preparedAt === null ||
    preparedAt.getTime() < new Date(challenge.issuedAt).getTime() ||
    preparedAt.getTime() > new Date(challenge.expiresAt).getTime()
  ) {
    throw storeUnsafe();
  }
  const proofModules = assertProofModules(input.proofModules, subject);
  assertProofMethod(subject, proofModules);
  const filePath = grantRecordPath(paths, challenge.challengeId);
  const current = readGrantRecord(paths, challenge.challengeId);
  if (
    current.state !== 'pending' ||
    canonicalJson(current.challenge) !== canonicalJson(challenge)
  ) {
    throw challengeUnavailable(challenge.challengeId);
  }
  const prepared = freezeGrantCanonical({
    ...current,
    state: 'prepared',
    operationId: input.operationId,
    approvalSubject: subject,
    proofModules,
    preparedAt: preparedAt.toISOString(),
  }) as PreparedGrantRecord;
  replaceCanonicalRecord(filePath, current, prepared, challenge.challengeId);
  return prepared;
}

export function recordGrantTransitionOutcome(
  paths: GrantStorePaths,
  input: Readonly<{
    challengeId: string;
    operationId: string;
    poststateDigest: `sha256:${string}`;
    outcome: TransitionOutcome;
    completedAt: string;
    audit: GrantAuditRecord;
  }>,
): TerminalGrantRecord {
  assertChallengeId(input.challengeId);
  if (
    !GRANT_UUID_V4.test(input.operationId) ||
    !GRANT_SHA256_DIGEST.test(input.poststateDigest)
  ) {
    throw storeUnsafe();
  }
  const outcome = assertTransitionOutcome(input.outcome);
  const completedAt = parseGrantTimestamp(input.completedAt);
  if (completedAt === null) throw storeUnsafe();
  const current = readGrantRecord(paths, input.challengeId);
  if (current.state === 'completed' || current.state === 'failed') {
    if (
      current.operationId === input.operationId &&
      current.poststateDigest === input.poststateDigest &&
      canonicalJson(current.outcome) === canonicalJson(outcome) &&
      current.completedAt === completedAt.toISOString() &&
      canonicalJson(current.audit) === canonicalJson(input.audit)
    ) {
      return current;
    }
    throw challengeUnavailable(input.challengeId);
  }
  if (
    current.state !== 'prepared' ||
    current.operationId !== input.operationId ||
    completedAt.getTime() < new Date(current.preparedAt).getTime()
  ) {
    throw challengeUnavailable(input.challengeId);
  }
  const audit = assertGrantAuditRecord(input.audit, current);
  const terminal = freezeGrantCanonical({
    ...current,
    state: outcome.outcome,
    poststateDigest: input.poststateDigest,
    outcome,
    completedAt: completedAt.toISOString(),
    audit,
  }) as TerminalGrantRecord;
  replaceCanonicalRecord(
    grantRecordPath(paths, input.challengeId),
    current,
    terminal,
    input.challengeId,
  );
  return terminal;
}

export function assertGrantLifecycleBarrier(
  runtimeRoot: string,
  allowedChallengeIds: readonly string[] = [],
): void {
  const allowed = new Set<string>();
  for (const challengeId of allowedChallengeIds) {
    assertChallengeId(challengeId);
    if (allowed.has(challengeId)) throw storeUnsafe();
    allowed.add(challengeId);
  }
  const root = path.join(path.resolve(runtimeRoot), 'grants-v2');
  const rootStats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (rootStats === undefined) return;
  const paths = grantStorePaths(runtimeRoot);
  for (const record of listPreparedGrantRecords(paths)) {
    if (!allowed.has(record.challenge.challengeId)) {
      throw workflowError(
        'GRANT_TRANSITION_RECOVERY_REQUIRED',
        `Prepared grant ${record.challenge.challengeId} must be recovered before another repository lifecycle operation.`,
        ExitCode.staleState,
      );
    }
  }
}

function assertGrantRecord(value: unknown): GrantRecord {
  return storeSafe(() => {
    if (!isRecord(value) || typeof value.state !== 'string') {
      throw storeUnsafe();
    }
    const state = value.state;
    const preparedKeys = [
      'operationId',
      'approvalSubject',
      'proofModules',
      'preparedAt',
    ];
    const terminalKeys = ['poststateDigest', 'outcome', 'completedAt', 'audit'];
    const extraKeys =
      state === 'pending'
        ? []
        : state === 'prepared'
          ? preparedKeys
          : state === 'completed' || state === 'failed'
            ? [...preparedKeys, ...terminalKeys]
            : null;
    if (
      extraKeys === null ||
      !grantHasExactKeys(value, [
        'schemaVersion',
        'kind',
        'state',
        'challenge',
        'recordedAt',
        ...extraKeys,
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'grant-record.v1' ||
      typeof value.recordedAt !== 'string'
    ) {
      throw storeUnsafe();
    }
    const challenge = assertGrantChallenge(value.challenge);
    if (value.recordedAt !== challenge.issuedAt) throw storeUnsafe();
    const base = {
      schemaVersion: 1 as const,
      kind: 'grant-record.v1' as const,
      state: 'pending' as const,
      challenge,
      recordedAt: challenge.issuedAt,
    };
    if (state === 'pending') {
      return freezeGrantCanonical(base) as PendingGrantRecord;
    }
    const prepared = assertPreparedFields(value, base);
    if (state === 'prepared') return prepared;
    if (
      typeof value.poststateDigest !== 'string' ||
      !GRANT_SHA256_DIGEST.test(value.poststateDigest) ||
      typeof value.completedAt !== 'string'
    ) {
      throw storeUnsafe();
    }
    const completedAt = parseGrantTimestamp(value.completedAt);
    if (
      completedAt === null ||
      completedAt.getTime() < new Date(prepared.preparedAt).getTime()
    ) {
      throw storeUnsafe();
    }
    const outcome = assertTransitionOutcome(value.outcome);
    if (outcome.outcome !== state) throw storeUnsafe();
    return freezeGrantCanonical({
      ...prepared,
      state,
      poststateDigest: value.poststateDigest,
      outcome,
      completedAt: completedAt.toISOString(),
      audit: assertGrantAuditRecord(value.audit, prepared),
    }) as TerminalGrantRecord;
  });
}

function assertPreparedFields(
  value: Record<string, unknown>,
  base: PendingGrantRecord,
): PreparedGrantRecord {
  if (
    typeof value.operationId !== 'string' ||
    !GRANT_UUID_V4.test(value.operationId) ||
    !Array.isArray(value.proofModules) ||
    typeof value.preparedAt !== 'string'
  ) {
    throw storeUnsafe();
  }
  const subject = assertSubjectForChallenge(
    base.challenge,
    value.approvalSubject,
  );
  const proofModules = assertProofModules(value.proofModules, subject);
  const preparedAt = parseGrantTimestamp(value.preparedAt);
  if (
    preparedAt === null ||
    preparedAt.getTime() < new Date(base.challenge.issuedAt).getTime() ||
    preparedAt.getTime() > new Date(base.challenge.expiresAt).getTime()
  ) {
    throw storeUnsafe();
  }
  assertProofMethod(subject, proofModules);
  return freezeGrantCanonical({
    ...base,
    state: 'prepared',
    operationId: value.operationId,
    approvalSubject: subject,
    proofModules,
    preparedAt: preparedAt.toISOString(),
  }) as PreparedGrantRecord;
}

function assertSubjectForChallenge(
  challenge: GrantChallenge,
  value: unknown,
): ApprovalSubject {
  const subject = storeSafe(() => assertApprovalSubject(value));
  const recreated = storeSafe(() =>
    createApprovalSubject(
      challenge,
      {
        choiceId: subject.choiceId,
        approvalMethod: subject.approvalMethod,
        reasonCode: subject.reasonCode,
        reason: subject.reason,
        sessionNonce: subject.sessionNonce,
      },
      { now: new Date(challenge.issuedAt) },
    ),
  );
  if (canonicalJson(subject) !== canonicalJson(recreated)) throw storeUnsafe();
  return subject;
}

function assertProofModules(
  value: unknown,
  subject: ApprovalSubject,
): readonly GrantProofModuleSummary[] {
  if (!Array.isArray(value) || value.length < 1) throw storeUnsafe();
  const identities = new Set<string>();
  return freezeGrantCanonical(
    value.map((candidate) => {
      if (
        !isRecord(candidate) ||
        !grantHasExactKeys(candidate, [
          'moduleId',
          'version',
          'claim',
          'proofDigest',
          'identity',
          'portableEvidence',
        ]) ||
        typeof candidate.moduleId !== 'string' ||
        !GRANT_STABLE_ID.test(candidate.moduleId) ||
        typeof candidate.version !== 'string' ||
        !MODULE_VERSION.test(candidate.version) ||
        (candidate.claim !== 'fresh-local-device-owner' &&
          candidate.claim !== 'ssh-signature') ||
        typeof candidate.proofDigest !== 'string' ||
        !GRANT_SHA256_DIGEST.test(candidate.proofDigest) ||
        !(
          candidate.identity === null ||
          (typeof candidate.identity === 'string' &&
            IDENTITY.test(candidate.identity))
        )
      ) {
        throw storeUnsafe();
      }
      const identity = `${candidate.moduleId}@${candidate.version}:${candidate.claim}`;
      if (identities.has(identity)) throw storeUnsafe();
      identities.add(identity);
      const portableEvidence =
        candidate.portableEvidence === null
          ? null
          : storeSafe(() =>
              assertSshPortableApprovalEvidenceV1(candidate.portableEvidence),
            );
      const isSshProof =
        candidate.moduleId === 'grant-proof-ssh' &&
        candidate.version === '1' &&
        candidate.claim === 'ssh-signature';
      if (
        isSshProof
          ? portableEvidence === null ||
            candidate.identity !== portableEvidence.identity ||
            candidate.proofDigest !==
              sshPortableApprovalEvidenceDigest(portableEvidence) ||
            approvalSubjectDigest(subject) !==
              sshPortableApprovalEvidenceSubjectDigest(portableEvidence)
          : portableEvidence !== null
      ) {
        throw storeUnsafe();
      }
      return {
        moduleId: candidate.moduleId,
        version: candidate.version,
        claim: candidate.claim,
        proofDigest: candidate.proofDigest as `sha256:${string}`,
        identity: candidate.identity,
        portableEvidence,
      };
    }),
  );
}

function assertProofMethod(
  subject: ApprovalSubject,
  proofs: readonly GrantProofModuleSummary[],
): void {
  if (proofs.length !== 1) throw storeUnsafe();
  const proof = proofs[0]!;
  if (
    subject.approvalMethod === 'human-presence'
      ? proof.claim !== 'fresh-local-device-owner' ||
        proof.identity !== null ||
        proof.portableEvidence !== null
      : proof.moduleId !== 'grant-proof-ssh' ||
        proof.version !== '1' ||
        proof.claim !== 'ssh-signature' ||
        typeof proof.identity !== 'string' ||
        proof.portableEvidence === null
  ) {
    throw storeUnsafe();
  }
}

function assertTransitionOutcome(value: unknown): TransitionOutcome {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, ['outcome', 'details']) ||
    (value.outcome !== 'completed' && value.outcome !== 'failed')
  ) {
    throw storeUnsafe();
  }
  return freezeGrantCanonical({
    outcome: value.outcome,
    details: value.details,
  });
}

function assertGrantAuditRecord(
  value: unknown,
  prepared: PreparedGrantRecord,
): GrantAuditRecord {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'approvalMethod',
      'authorityClass',
      'identity',
      'identityAssurance',
      'presenceAssurance',
      'proofModules',
    ]) ||
    value.approvalMethod !== prepared.approvalSubject.approvalMethod ||
    !Array.isArray(value.proofModules) ||
    !value.proofModules.every(
      (module) =>
        typeof module === 'string' &&
        /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*@[1-9][0-9]*$/.test(module),
    ) ||
    !grantSameStrings(
      value.proofModules,
      prepared.proofModules.map(
        ({ moduleId, version }) => `${moduleId}@${version}`,
      ),
    ) ||
    !auditAssuranceMatchesMethod(value, prepared)
  ) {
    throw storeUnsafe();
  }
  return freezeGrantCanonical(value) as unknown as GrantAuditRecord;
}

function auditAssuranceMatchesMethod(
  value: Record<string, unknown>,
  prepared: PreparedGrantRecord,
): boolean {
  if (value.approvalMethod === 'human-presence') {
    return (
      value.authorityClass === 'local-device-owner' &&
      value.identity === null &&
      value.identityAssurance === 'not-asserted' &&
      value.presenceAssurance === 'fresh-os-authentication'
    );
  }
  const sshIdentity = prepared.proofModules[0]?.identity;
  return (
    value.approvalMethod === 'ssh' &&
    value.authorityClass === 'ssh-credential' &&
    typeof value.identity === 'string' &&
    value.identity === sshIdentity &&
    IDENTITY.test(value.identity) &&
    value.identityAssurance === 'policy-trusted-ssh-key' &&
    value.presenceAssurance === 'not-asserted'
  );
}

function initializeGrantStore(paths: GrantStorePaths): void {
  for (const directory of [paths.root, paths.records]) {
    try {
      ensurePlainDirectory(directory);
    } catch {
      throw storeUnsafe();
    }
  }
  assertGrantStore(paths);
}

function assertGrantStore(paths: GrantStorePaths): void {
  try {
    if (
      path.dirname(paths.records) !== paths.root ||
      path.basename(paths.records) !== 'records'
    ) {
      throw storeUnsafe();
    }
    for (const directory of [paths.root, paths.records]) {
      const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (
        !stats?.isDirectory() ||
        stats.isSymbolicLink() ||
        fs.realpathSync(directory) !== path.resolve(directory)
      ) {
        throw storeUnsafe();
      }
    }
  } catch {
    throw storeUnsafe();
  }
}

function createCanonicalFile(filePath: string, value: unknown): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, `${canonicalJson(value)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } catch {
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(filePath));
}

function replaceCanonicalRecord(
  filePath: string,
  expected: GrantRecord,
  replacement: GrantRecord,
  challengeId: string,
): void {
  const temporary = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    createCanonicalFile(temporary, replacement);
    const current = readCanonicalFile(filePath, assertGrantRecord);
    if (canonicalJson(current) !== canonicalJson(expected)) {
      throw challengeUnavailable(challengeId);
    }
    fs.renameSync(temporary, filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch (error) {
    removeTemporaryFile(temporary);
    if (error instanceof Error && 'code' in error) throw error;
    throw storeUnsafe();
  }
}

function readOptionalCanonicalFile<T>(
  filePath: string,
  validate: (value: unknown) => T,
): T | null {
  if (!fs.lstatSync(filePath, { throwIfNoEntry: false })) return null;
  return readCanonicalFile(filePath, validate);
}

function readCanonicalFile<T>(
  filePath: string,
  validate: (value: unknown) => T,
): T {
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!isPrivatePlainFile(before) || before.size > MAX_FILE_BYTES) {
      throw storeUnsafe();
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !isPrivatePlainFile(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAX_FILE_BYTES
    ) {
      throw storeUnsafe();
    }
    const document = fs.readFileSync(descriptor, 'utf8');
    const validated = validate(JSON.parse(document) as unknown);
    if (document !== `${canonicalJson(validated)}\n`) throw storeUnsafe();
    return validated;
  } catch {
    throw storeUnsafe();
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isPrivatePlainFile(stats: fs.Stats | undefined): stats is fs.Stats {
  return Boolean(
    stats?.isFile() &&
    !stats.isSymbolicLink() &&
    stats.nlink === 1 &&
    (stats.mode & 0o777) === 0o600,
  );
}

function removeTemporaryFile(filePath: string): void {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined) return;
  if (!isPrivatePlainFile(stats)) throw storeUnsafe();
  fs.unlinkSync(filePath);
}

function grantRecordPath(paths: GrantStorePaths, challengeId: string): string {
  assertChallengeId(challengeId);
  return path.join(paths.records, `${challengeId}.json`);
}

function assertChallengeId(value: string): void {
  if (typeof value !== 'string' || !GRANT_UUID_V4.test(value)) {
    throw storeUnsafe();
  }
}

function fsyncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function storeSafe<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw storeUnsafe();
  }
}

function challengeUnavailable(challengeId: string) {
  return workflowError(
    'GRANT_CHALLENGE_UNAVAILABLE',
    `Grant challenge ${challengeId} is not available.`,
    ExitCode.staleState,
  );
}

function storeUnsafe() {
  return workflowError(
    'GRANT_STORE_UNSAFE',
    'Grant challenge storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}
