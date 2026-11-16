/** Canonical Grant records, evidence validation and exact record projections. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertApprovalSubject,
  assertGrantChallenge,
  approvalSubjectDigest,
  createApprovalSubject,
  type ApprovalSubject,
  type GrantChallenge,
} from './grant-core.ts';
import {
  assertSshPortableApprovalEvidenceV1,
  sshPortableApprovalEvidenceDigest,
  sshPortableApprovalEvidenceSubjectDigest,
  type GrantProofModuleSummary,
} from './grant-approval.ts';
import {
  freezeGrantCanonical,
  GRANT_SHA256_DIGEST,
  GRANT_STABLE_ID,
  GRANT_UUID_V4,
  grantHasExactKeys,
  grantSha256,
  grantSameStrings,
  parseGrantTimestamp,
} from './grant-primitives.ts';
import { assertGrantParentBindingV1 } from './grant-parent-binding.ts';
import type { TransitionOutcome } from './grant-transition-registry.ts';

const MODULE_VERSION = /^[1-9][0-9]*$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
export const MAX_GRANT_RECORD_BYTES = 1_048_576;

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

/** Parse one exact canonical Grant record without consulting a local store. */
export function parseGrantRecord(value: string | unknown): GrantRecord {
  try {
    if (typeof value !== 'string') {
      const canonical = canonicalJson(value);
      if (Buffer.byteLength(canonical, 'utf8') + 1 > MAX_GRANT_RECORD_BYTES) {
        throw storeUnsafe();
      }
      return assertGrantRecord(JSON.parse(canonical) as unknown);
    }
    if (
      Buffer.byteLength(value, 'utf8') > MAX_GRANT_RECORD_BYTES ||
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

export function assertExactPreparedGrantParentBinding(
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

export function assertGrantRecord(value: unknown): GrantRecord {
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

export function assertSubjectForChallenge(
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

export function assertProofModules(
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

export function assertProofMethod(
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

export function assertTransitionOutcome(value: unknown): TransitionOutcome {
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

export function assertGrantAuditRecord(
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

export function assertChallengeId(value: string): void {
  if (typeof value !== 'string' || !GRANT_UUID_V4.test(value)) {
    throw storeUnsafe();
  }
}

export function storeSafe<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw storeUnsafe();
  }
}

export function challengeUnavailable(challengeId: string) {
  return workflowError(
    'GRANT_CHALLENGE_UNAVAILABLE',
    `Grant challenge ${challengeId} is not available.`,
    ExitCode.staleState,
  );
}

export function storeUnsafe() {
  return workflowError(
    'GRANT_STORE_UNSAFE',
    'Grant challenge storage is unsafe or malformed.',
    ExitCode.unsafeEnvironment,
  );
}

/** Validate the exact lifecycle recovery allowance before consulting storage. */
export function assertAllowedGrantChallengeIds(
  allowedChallengeIds: readonly string[],
): ReadonlySet<string> {
  const allowed = new Set<string>();
  for (const challengeId of allowedChallengeIds) {
    assertChallengeId(challengeId);
    if (allowed.has(challengeId)) throw storeUnsafe();
    allowed.add(challengeId);
  }
  return allowed;
}

export function assertNoBlockingPreparedGrants(
  records: readonly PreparedGrantRecord[],
  allowed: ReadonlySet<string>,
): void {
  for (const record of records) {
    if (!allowed.has(record.challenge.challengeId)) {
      throw workflowError(
        'GRANT_TRANSITION_RECOVERY_REQUIRED',
        `Prepared grant ${record.challenge.challengeId} must be recovered before another repository lifecycle operation.`,
        ExitCode.staleState,
      );
    }
  }
}
