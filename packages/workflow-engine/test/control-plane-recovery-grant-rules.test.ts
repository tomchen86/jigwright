import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  HARNESS_RECOVERY_SIGNATURE_NAMESPACE,
  canonicalDigest,
  type ControlPlaneRecoveryGrantEnvelope,
  type ControlPlaneRecoveryFailure,
} from '../src/modules/authority/control-plane-recovery-grant-values.ts';
import {
  canonicalControlPlaneRecoveryGrantPayload,
  createControlPlaneRecoveryGrantPayload,
  createControlPlaneRecoveryReceipt,
  createControlPlaneRecoveryFailure,
  createControlPlaneRecoveryAuditRecord,
  verifyControlPlaneRecoveryGrant,
} from '../src/modules/authority/control-plane-recovery-grant-records.ts';
import {
  createControlPlaneRecoveryReservation,
  acceptControlPlaneRecoveryReservation,
  prepareControlPlaneRecoveryGrantConsumption,
  consumeControlPlaneRecoveryGrant,
  failControlPlaneRecoveryGrant,
  expireControlPlaneRecoveryGrant,
  validatePersistedControlPlaneRecoveryGrant,
  selectControlPlaneRecoveryGrantForSource,
} from '../src/modules/authority/control-plane-recovery-grant.ts';

const issuedAt = '2026-08-10T10:00:00.000Z';
const completedAt = '2026-08-10T10:01:00.000Z';
const digest = canonicalDigest;
const stale = digest('stale record');

function fixture(
  overrides: Partial<
    Parameters<typeof createControlPlaneRecoveryGrantPayload>[0]
  > = {},
) {
  const payload = createControlPlaneRecoveryGrantPayload({
    repositoryId: 'github:example/repository',
    sourceControlPlaneGrantId: 'source-control-plane-grant',
    previousClosureDigest: digest('previous'),
    currentClosureDigest: digest('current'),
    promotionBundleDigest: digest('promotion'),
    recoveryBundleDigest: digest('recovery'),
    controlPlaneUpdateRecordDigest: digest('update'),
    controlPlaneJournalDigest: digest('journal'),
    supervisorStateDigest: digest('supervisor'),
    supervisorGeneration: 2,
    sourceTransactionState: 'ROLLBACK_REQUIRED',
    externalAuditRoot: '/private/recovery-audit',
    issuedAt,
    humanSigner: 'maintainer@example.test',
    ...overrides,
  });
  const envelope: ControlPlaneRecoveryGrantEnvelope = {
    payload,
    signature: 'human-signature',
  };
  const reserved = createControlPlaneRecoveryReservation(envelope, payload);
  const receipt = createControlPlaneRecoveryReceipt({
    payload,
    poststateDigest: digest('poststate'),
    controlPlaneJournalDigestAfter: digest('journal after'),
    supervisorStateDigestAfter: digest('supervisor after'),
    completedAt,
  });
  const failure = createControlPlaneRecoveryFailure({
    payload,
    errorCode: 'RESTART_PROBE_FAILED',
    selectedClosureDigest: payload.previousClosureDigest,
    selectedArtifactId: 'previous-artifact',
    supervisorStateDigest: digest('failed supervisor'),
    supervisorGeneration: 3,
    controlPlaneJournalDigest: digest('failed journal'),
    failedAt: completedAt,
  });
  const input = {
    recoveryGrantId: payload.grantId,
    expectedRecordDigest: reserved.recordDigest,
  };
  return { payload, envelope, reserved, receipt, failure, input };
}

function rehash<T extends { recordDigest: string }>(value: T): T {
  const { recordDigest, ...body } = value;
  return { ...body, recordDigest: digest(body) } as T;
}

test('recovery verifier binds exact bytes and namespace and returns an immutable independent payload', () => {
  const { payload, envelope } = fixture();
  const calls: unknown[][] = [];
  const verified = verifyControlPlaneRecoveryGrant(envelope, {
    now: new Date(completedAt),
    verifyHumanSignature(...args) {
      calls.push(args);
      return true;
    },
  });
  assert.deepEqual(calls, [
    [
      canonicalJson(payload),
      'human-signature',
      payload.humanSigner,
      HARNESS_RECOVERY_SIGNATURE_NAMESPACE,
    ],
  ]);
  assert.equal(
    canonicalControlPlaneRecoveryGrantPayload(payload),
    canonicalJson(payload),
  );
  assert.equal(
    canonicalControlPlaneRecoveryGrantPayload(payload).endsWith('\n'),
    false,
  );
  assert.notEqual(verified, payload);
  assert.deepEqual(verified, payload);
  assert.equal(Object.isFrozen(verified), true);
});

test('recovery signature rejection precedes invalid clock for false and thrown verifiers', () => {
  const { envelope } = fixture();
  for (const verifyHumanSignature of [
    () => false,
    () => {
      throw new Error('verifier unavailable');
    },
  ]) {
    assert.throws(
      () =>
        verifyControlPlaneRecoveryGrant(envelope, {
          now: new Date(Number.NaN),
          verifyHumanSignature,
          enforceLive: false,
        }),
      { code: 'HARNESS_RECOVERY_GRANT_SIGNATURE_INVALID' },
    );
  }
});

test('enforceLive false skips only activation interval while retaining shape TTL signature and clock checks', () => {
  const { envelope, payload } = fixture();
  const verifyHumanSignature = () => true;
  for (const now of [
    new Date(Date.parse(issuedAt) - 1),
    new Date(payload.expiresAt),
  ]) {
    assert.doesNotThrow(() =>
      verifyControlPlaneRecoveryGrant(envelope, {
        now,
        verifyHumanSignature,
        enforceLive: false,
      }),
    );
  }
  assert.throws(
    () =>
      verifyControlPlaneRecoveryGrant(envelope, {
        now: new Date(Date.parse(issuedAt) - 1),
        verifyHumanSignature,
      }),
    { code: 'HARNESS_RECOVERY_GRANT_NOT_YET_VALID' },
  );
  assert.throws(
    () =>
      verifyControlPlaneRecoveryGrant(envelope, {
        now: new Date(payload.expiresAt),
        verifyHumanSignature,
      }),
    { code: 'HARNESS_RECOVERY_GRANT_EXPIRED' },
  );
  assert.throws(
    () =>
      verifyControlPlaneRecoveryGrant(envelope, {
        now: new Date(NaN),
        verifyHumanSignature,
        enforceLive: false,
      }),
    { code: 'HARNESS_RECOVERY_GRANT_CLOCK_INVALID' },
  );
  const extra = { ...envelope, payload: { ...payload, unexpected: true } };
  assert.throws(
    () =>
      verifyControlPlaneRecoveryGrant(extra, {
        now: new Date(issuedAt),
        verifyHumanSignature,
        enforceLive: false,
      }),
    { code: 'HARNESS_RECOVERY_GRANT_INVALID' },
  );
  const excessiveTtl = {
    ...envelope,
    payload: { ...payload, expiresAt: '2026-08-10T10:05:00.001Z' },
  };
  assert.throws(
    () =>
      verifyControlPlaneRecoveryGrant(excessiveTtl, {
        now: new Date(issuedAt),
        verifyHumanSignature,
        enforceLive: false,
      }),
    { code: 'HARNESS_RECOVERY_GRANT_TTL_INVALID' },
  );
});

test('reservation uses signed issuance time, clones input and rejects mismatched envelope before terminal errors', () => {
  const { reserved, payload, envelope, input, receipt } = fixture();
  assert.equal(reserved.createdAt, issuedAt);
  assert.equal(reserved.updatedAt, issuedAt);
  assert.notEqual(reserved.envelope, envelope);
  assert.notEqual(reserved.envelope.payload, payload);
  assert.equal(Object.isFrozen(reserved.envelope.payload), true);
  assert.equal(
    acceptControlPlaneRecoveryReservation(reserved, envelope),
    reserved,
  );
  const pending = prepareControlPlaneRecoveryGrantConsumption(reserved, {
    ...input,
    receipt,
  });
  assert.equal(
    acceptControlPlaneRecoveryReservation(pending, envelope),
    pending,
  );
  const consumed = consumeControlPlaneRecoveryGrant(pending, {
    ...input,
    expectedRecordDigest: pending.recordDigest,
  });
  assert.throws(
    () =>
      acceptControlPlaneRecoveryReservation(consumed, {
        ...envelope,
        signature: 'different',
      }),
    { code: 'HARNESS_RECOVERY_RECORD_CORRUPT' },
  );
  assert.throws(
    () => acceptControlPlaneRecoveryReservation(consumed, envelope),
    { code: 'HARNESS_RECOVERY_GRANT_ALREADY_CONSUMED' },
  );
});

test('completion preparation replay retains the first receipt before CAS and rejects a replacement receipt', () => {
  const { reserved, input, receipt, payload } = fixture();
  const pending = prepareControlPlaneRecoveryGrantConsumption(reserved, {
    ...input,
    receipt,
  });
  assert.equal(pending.createdAt, issuedAt);
  assert.equal(pending.updatedAt, completedAt);
  assert.equal(pending.state, 'completion-pending');
  assert.equal(Object.isFrozen(pending.receipt), true);
  assert.equal(
    prepareControlPlaneRecoveryGrantConsumption(pending, {
      ...input,
      expectedRecordDigest: stale,
      receipt: structuredClone(receipt),
    }),
    pending,
  );
  const otherReceipt = createControlPlaneRecoveryReceipt({
    payload,
    poststateDigest: digest('different'),
    controlPlaneJournalDigestAfter: receipt.controlPlaneJournalDigestAfter,
    supervisorStateDigestAfter: receipt.supervisorStateDigestAfter,
    completedAt,
  });
  assert.throws(
    () =>
      prepareControlPlaneRecoveryGrantConsumption(pending, {
        ...input,
        expectedRecordDigest: stale,
        receipt: otherReceipt,
      }),
    { code: 'HARNESS_RECOVERY_RECEIPT_INVALID' },
  );
  assert.throws(
    () =>
      prepareControlPlaneRecoveryGrantConsumption(reserved, {
        ...input,
        expectedRecordDigest: stale,
        receipt,
      }),
    { code: 'HARNESS_RECOVERY_RECORD_CAS_MISMATCH' },
  );
});

test('consumption requires a durable receipt before CAS and cannot replay consumed authority', () => {
  const { reserved, input, receipt } = fixture();
  assert.throws(
    () =>
      consumeControlPlaneRecoveryGrant(reserved, {
        ...input,
        expectedRecordDigest: stale,
      }),
    { code: 'HARNESS_RECOVERY_CONSUMPTION_NOT_PREPARED' },
  );
  const pending = prepareControlPlaneRecoveryGrantConsumption(reserved, {
    ...input,
    receipt,
  });
  assert.throws(
    () =>
      consumeControlPlaneRecoveryGrant(pending, {
        ...input,
        expectedRecordDigest: stale,
      }),
    { code: 'HARNESS_RECOVERY_RECORD_CAS_MISMATCH' },
  );
  const consumed = consumeControlPlaneRecoveryGrant(pending, {
    ...input,
    expectedRecordDigest: pending.recordDigest,
  });
  assert.equal(consumed.state, 'consumed');
  assert.equal(consumed.createdAt, issuedAt);
  assert.equal(consumed.updatedAt, receipt.completedAt);
  assert.equal(consumed.receipt, pending.receipt);
  assert.throws(
    () =>
      consumeControlPlaneRecoveryGrant(consumed, {
        ...input,
        expectedRecordDigest: stale,
      }),
    { code: 'HARNESS_RECOVERY_GRANT_ALREADY_CONSUMED' },
  );
});

test('failed replay ignores replacement failure and stale CAS while a new failure checks CAS first', () => {
  const { reserved, input, failure, receipt, envelope } = fixture();
  const malformed = { invalid: true } as unknown as ControlPlaneRecoveryFailure;
  assert.throws(
    () =>
      failControlPlaneRecoveryGrant(reserved, {
        ...input,
        expectedRecordDigest: stale,
        failure: malformed,
      }),
    { code: 'HARNESS_RECOVERY_RECORD_CAS_MISMATCH' },
  );
  const failed = failControlPlaneRecoveryGrant(reserved, { ...input, failure });
  assert.equal(failed.updatedAt, failure.failedAt);
  assert.equal(failed.createdAt, issuedAt);
  assert.equal(
    failControlPlaneRecoveryGrant(failed, {
      ...input,
      expectedRecordDigest: stale,
      failure: malformed,
    }),
    failed,
  );
  assert.throws(() => consumeControlPlaneRecoveryGrant(failed, input), {
    code: 'HARNESS_RECOVERY_GRANT_FAILED',
  });
  assert.throws(
    () =>
      prepareControlPlaneRecoveryGrantConsumption(failed, {
        ...input,
        receipt,
      }),
    { code: 'HARNESS_RECOVERY_GRANT_FAILED' },
  );
  assert.throws(() => acceptControlPlaneRecoveryReservation(failed, envelope), {
    code: 'HARNESS_RECOVERY_GRANT_FAILED',
  });
  const pending = prepareControlPlaneRecoveryGrantConsumption(reserved, {
    ...input,
    receipt,
  });
  assert.throws(
    () =>
      failControlPlaneRecoveryGrant(pending, { ...input, failure: malformed }),
    { code: 'HARNESS_RECOVERY_FAILURE_STATE_INVALID' },
  );
});

test('expiry replay retains the first timestamp before CAS while pending completion cannot expire', () => {
  const { reserved, payload, input, receipt, envelope } = fixture();
  assert.throws(
    () =>
      expireControlPlaneRecoveryGrant(reserved, {
        ...input,
        expectedRecordDigest: stale,
        expiredAt: 'invalid',
      }),
    { code: 'HARNESS_RECOVERY_RECORD_CAS_MISMATCH' },
  );
  assert.throws(
    () =>
      expireControlPlaneRecoveryGrant(reserved, {
        ...input,
        expiredAt: completedAt,
      }),
    { code: 'HARNESS_RECOVERY_GRANT_NOT_EXPIRED' },
  );
  const expired = expireControlPlaneRecoveryGrant(reserved, {
    ...input,
    expiredAt: payload.expiresAt,
  });
  assert.equal(expired.updatedAt, payload.expiresAt);
  assert.equal(expired.createdAt, issuedAt);
  assert.equal(
    expireControlPlaneRecoveryGrant(expired, {
      ...input,
      expectedRecordDigest: stale,
      expiredAt: 'invalid',
    }),
    expired,
  );
  assert.throws(() => consumeControlPlaneRecoveryGrant(expired, input), {
    code: 'HARNESS_RECOVERY_GRANT_EXPIRED',
  });
  assert.throws(
    () =>
      prepareControlPlaneRecoveryGrantConsumption(expired, {
        ...input,
        receipt,
      }),
    { code: 'HARNESS_RECOVERY_GRANT_EXPIRED' },
  );
  assert.throws(
    () => acceptControlPlaneRecoveryReservation(expired, envelope),
    { code: 'HARNESS_RECOVERY_GRANT_EXPIRED' },
  );
  const pending = prepareControlPlaneRecoveryGrantConsumption(reserved, {
    ...input,
    receipt,
  });
  assert.throws(
    () =>
      expireControlPlaneRecoveryGrant(pending, {
        ...input,
        expectedRecordDigest: stale,
        expiredAt: 'invalid',
      }),
    { code: 'HARNESS_RECOVERY_COMPLETION_OBLIGATORY' },
  );
});

test('persisted record validation rejects cross-bound receipts even with recomputed canonical digests', () => {
  const { reserved, input, receipt, payload } = fixture();
  const pending = prepareControlPlaneRecoveryGrantConsumption(reserved, {
    ...input,
    receipt,
  });
  const loaded = validatePersistedControlPlaneRecoveryGrant(
    pending,
    payload.grantId,
  );
  assert.notEqual(loaded, pending);
  assert.notEqual(loaded.receipt, pending.receipt);
  assert.equal(Object.isFrozen(loaded.receipt), true);
  for (const key of [
    'recoveryGrantId',
    'sourceControlPlaneGrantId',
    'repositoryId',
    'previousClosureDigest',
    'currentClosureDigest',
    'controlPlaneJournalDigestBefore',
    'supervisorStateDigestBefore',
    'prestateDigest',
  ] as const) {
    const alteredReceipt = {
      ...receipt,
      [key]: key.includes('Digest')
        ? digest('other')
        : key === 'recoveryGrantId'
          ? `recovery-${'a'.repeat(64)}`
          : 'another-identity',
    };
    const { receiptDigest, ...body } = alteredReceipt;
    const corrupt = rehash({
      ...pending,
      receipt: { ...body, receiptDigest: digest(body) },
    });
    assert.throws(
      () =>
        validatePersistedControlPlaneRecoveryGrant(corrupt, payload.grantId),
      { code: 'HARNESS_RECOVERY_RECORD_CORRUPT' },
      key,
    );
  }
});

test('persisted record validation retains state envelope timestamp and failure bindings', () => {
  const { reserved, input, payload, failure } = fixture();
  const failed = failControlPlaneRecoveryGrant(reserved, { ...input, failure });
  for (const corrupt of [
    rehash({ ...reserved, unexpected: true }),
    rehash({ ...reserved, envelopeDigest: stale }),
    rehash({ ...reserved, prestateDigest: stale }),
    rehash({ ...reserved, updatedAt: '2026-08-10T09:59:59.000Z' }),
    rehash({ ...reserved, state: 'consumed' as const }),
    rehash({ ...failed, state: 'reserved' as const }),
    rehash({ ...failed, failure: null }),
  ])
    assert.throws(
      () =>
        validatePersistedControlPlaneRecoveryGrant(corrupt, payload.grantId),
      { code: 'HARNESS_RECOVERY_RECORD_CORRUPT' },
    );
  for (const fields of [
    { sourceControlPlaneGrantId: 'other-source' },
    { selectedClosureDigest: payload.currentClosureDigest },
    { failedAt: '2026-08-10T09:59:59.000Z' },
  ]) {
    const altered = { ...failure, ...fields };
    const { failureDigest, ...body } = altered;
    const corrupt = rehash({
      ...failed,
      failure: { ...body, failureDigest: digest(body) },
    });
    assert.throws(
      () =>
        validatePersistedControlPlaneRecoveryGrant(corrupt, payload.grantId),
      { code: 'HARNESS_RECOVERY_RECORD_CORRUPT' },
    );
  }
});

test('source selection treats consumed as active and rejects competing active records', () => {
  const first = fixture();
  const second = fixture({ humanSigner: 'second@example.test' });
  const pending = prepareControlPlaneRecoveryGrantConsumption(first.reserved, {
    ...first.input,
    receipt: first.receipt,
  });
  const consumed = consumeControlPlaneRecoveryGrant(pending, {
    ...first.input,
    expectedRecordDigest: pending.recordDigest,
  });
  const expired = expireControlPlaneRecoveryGrant(second.reserved, {
    ...second.input,
    expiredAt: second.payload.expiresAt,
  });
  const source = first.payload.sourceControlPlaneGrantId;
  assert.equal(
    selectControlPlaneRecoveryGrantForSource([expired, consumed], source),
    consumed,
  );
  assert.throws(
    () =>
      selectControlPlaneRecoveryGrantForSource(
        [consumed, second.reserved],
        source,
      ),
    { code: 'HARNESS_RECOVERY_RECORD_CORRUPT' },
  );
  assert.equal(
    selectControlPlaneRecoveryGrantForSource([consumed], 'absent'),
    null,
  );
});

test('source selection uses descending terminal time then Grant identity without mutating input order', () => {
  const first = fixture();
  const second = fixture({ humanSigner: 'second@example.test' });
  const failed = failControlPlaneRecoveryGrant(first.reserved, {
    ...first.input,
    failure: first.failure,
  });
  const expired = expireControlPlaneRecoveryGrant(second.reserved, {
    ...second.input,
    expiredAt: second.payload.expiresAt,
  });
  const records = [failed, expired];
  const source = first.payload.sourceControlPlaneGrantId;
  assert.equal(
    selectControlPlaneRecoveryGrantForSource(records, source),
    expired,
  );
  assert.deepEqual(records, [failed, expired]);
  const tied = rehash({ ...failed, updatedAt: expired.updatedAt });
  const winner =
    tied.envelope.payload.grantId > expired.envelope.payload.grantId
      ? tied
      : expired;
  assert.equal(
    selectControlPlaneRecoveryGrantForSource([tied, expired], source),
    winner,
  );
  assert.equal(
    selectControlPlaneRecoveryGrantForSource([expired, tied], source),
    winner,
  );
});

test('audit identity and sequence remain stable while exact event content retains its own digest', () => {
  const { payload, envelope, receipt } = fixture();
  const sequences = {
    authorized: 0,
    'rolled-back': 1,
    expired: 1,
    failed: 1,
    consumed: 2,
  } as const;
  for (const [event, sequence] of Object.entries(sequences)) {
    const input = {
      payload,
      envelopeDigest: digest(envelope),
      event: event as keyof typeof sequences,
      poststateDigest: receipt.poststateDigest,
      receiptDigest: receipt.receiptDigest,
      recordedAt: completedAt,
    };
    const record = createControlPlaneRecoveryAuditRecord(input);
    assert.equal(record.sequence, sequence);
    assert.equal(record.prestateDigest, receipt.prestateDigest);
    assert.equal(Object.isFrozen(record), true);
    const retry = createControlPlaneRecoveryAuditRecord({
      ...input,
      recordedAt: '2026-08-10T10:02:00.000Z',
    });
    assert.equal(retry.recordId, record.recordId);
    assert.notEqual(retry.recordDigest, record.recordDigest);
  }
});
