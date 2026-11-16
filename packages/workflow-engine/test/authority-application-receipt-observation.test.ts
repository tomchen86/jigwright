import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
  authorityApplicationReceiptTagRef,
  canonicalAuthorityApplicationReceiptEnvelope,
  canonicalAuthorityApplicationReceiptPayload,
  createAuthorityApplicationReceiptOperations,
  createAuthorityApplicationReceiptPayload,
  type AuthorityApplicationReceiptEnvelope,
  type AuthorityApplicationReceiptObservations,
} from '../src/modules/authority/authority-application-receipt.ts';
import type { MaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../src/modules/authority/maintainer-signer-port.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const root = '/memory/receipt-repository';
const signature =
  '-----BEGIN SSH SIGNATURE-----\nYWJj\n-----END SSH SIGNATURE-----\n';
const policy: MaintainerPolicy = {
  schemaVersion: 1,
  repository: {
    id: 'github:receipt',
    origin: 'https://github.com/test/receipt.git',
  },
  phase: 'bootstrap',
  auditTagPrefix: 'refs/tags/workflow-grant/',
  signatureNamespace: 'workflow.maintainer-grant.v1',
  maxTtlMinutes: 30,
  maxUses: 1,
  bootstrapEligiblePaths: ['src/**'],
  sealedImmutablePaths: [],
  requiredChecks: ['fixture'],
  trustedSigners: [
    {
      identity: 'maintainer',
      publicKey: 'ssh-ed25519 YWJj',
      fingerprint: 'SHA256:receipt',
    },
  ],
};
const digest = 'a'.repeat(64);
const payload = createAuthorityApplicationReceiptPayload({
  grantId: '00000000-0000-4000-8000-000000000001',
  repositoryId: policy.repository.id,
  repositoryOrigin: policy.repository.origin,
  changeId: 'receipt-change',
  signer: 'maintainer',
  grantTagRef: 'refs/tags/workflow-grant/grant',
  grantEnvelopeDigest: `sha256:${digest}`,
  candidateBundleDigest: digest,
  effectsManifestDigest: digest,
  evidenceWaivers: [],
  candidatePatchDigest: digest,
  candidateCommit: 'a'.repeat(40),
  candidateTree: 'b'.repeat(40),
  targetRef: 'refs/heads/main',
  oldRefOid: 'c'.repeat(40),
  oldRefGeneration: 3,
  newRefOid: 'a'.repeat(40),
  newRefGeneration: 4,
  casAt: '2026-01-01T00:00:00.000Z',
  casAuditReceiptDigest: `sha256:${digest}`,
  auditRepositoryId: `sha256:${digest}`,
  poststateVerifiedAt: '2026-01-01T00:00:01.000Z',
  poststateAuditReceiptDigest: `sha256:${digest}`,
  terminalGrantState: 'consumed',
  terminalReservationId: 'reservation',
  terminalCommit: 'a'.repeat(40),
  terminalConsumedAt: '2026-01-01T00:00:02.000Z',
  grantConsumeAuditReceiptDigest: `sha256:${digest}`,
  issuedAt: '2026-01-01T00:00:03.000Z',
});
const envelope: AuthorityApplicationReceiptEnvelope = {
  payload,
  signatureNamespace: AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
  signature,
};
const ref = authorityApplicationReceiptTagRef(policy, payload.grantId);
const tagObject = 'd'.repeat(40);
function annotatedTag(body: string, target = payload.candidateCommit): string {
  return `object ${target}\ntype commit\ntag ${ref.slice('refs/tags/'.length)}\n\n${body}`;
}

function memory() {
  const events: string[] = [];
  const state = {
    existing: '',
    raw: annotatedTag(canonicalAuthorityApplicationReceiptEnvelope(envelope)),
    object: tagObject,
  };
  function location(repositoryRoot: string, actualRef: string) {
    assert.equal(repositoryRoot, root);
    assert.equal(actualRef, ref);
  }
  const observations: AuthorityApplicationReceiptObservations = {
    readReceiptTagRefListing(repositoryRoot, prefix) {
      events.push('list');
      assert.equal(repositoryRoot, root);
      assert.equal(prefix, 'refs/tags/workflow-grant/application-');
      return `${ref}-z\n\n${ref}-a\n`;
    },
    readAnnotatedReceiptTag(repositoryRoot, actualRef) {
      location(repositoryRoot, actualRef);
      events.push('read-tag');
      return state.raw;
    },
    readReceiptTagObjectId(repositoryRoot, actualRef) {
      location(repositoryRoot, actualRef);
      events.push('read-object');
      return state.object;
    },
    resolveReceiptTagRef(repositoryRoot, actualRef) {
      location(repositoryRoot, actualRef);
      events.push('resolve');
      return state.existing;
    },
    createMaintainerAuditTag(
      repositoryRoot,
      commit,
      actualRef,
      bytes,
      identity,
    ) {
      location(repositoryRoot, actualRef);
      events.push('publish');
      assert.equal(commit, payload.candidateCommit);
      assert.equal(
        bytes,
        canonicalAuthorityApplicationReceiptEnvelope(envelope),
      );
      assert.equal(identity, payload.signer);
      state.raw = annotatedTag(bytes);
      state.existing = tagObject;
      return tagObject;
    },
    verifySshDataSignature(
      bytes,
      actualSignature,
      signer,
      namespace,
      errorCode,
    ) {
      events.push('verify-policy');
      assert.equal(bytes, canonicalAuthorityApplicationReceiptPayload(payload));
      assert.equal(actualSignature, signature);
      assert.equal(signer, policy.trustedSigners[0]);
      assert.equal(
        namespace,
        AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      );
      assert.equal(
        errorCode,
        'AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_INVALID',
      );
    },
  };
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {
      assert.fail('Receipt publication must not repeat human admission.');
    },
    identity() {
      events.push('identity');
      return payload.signer;
    },
    sign(bytes, namespace) {
      events.push('sign');
      assert.equal(bytes, canonicalAuthorityApplicationReceiptPayload(payload));
      assert.equal(
        namespace,
        AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      );
      return signature;
    },
    verify(bytes, actualSignature, identity, namespace) {
      events.push('verify-signer');
      assert.equal(bytes, canonicalAuthorityApplicationReceiptPayload(payload));
      assert.equal(actualSignature, signature);
      assert.equal(identity, payload.signer);
      assert.equal(
        namespace,
        AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      );
    },
  };
  return { events, state, observations, signer };
}

const invalid = { code: 'AUTHORITY_APPLICATION_RECEIPT_INVALID' };
const conflict = { code: 'AUTHORITY_APPLICATION_RECEIPT_CONFLICT' };

test('receipt rules and all type dependencies have a complete pure closure', () => {
  assertPureDependencyClosure(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '../src/modules/authority/authority-application-receipt.ts',
    ),
  );
});

test('construction has no effects and input admission precedes repository observations', () => {
  const m = memory();
  const operations = createAuthorityApplicationReceiptOperations(
    m.observations,
  );
  assert.deepEqual(m.events, []);
  assert.throws(
    () => operations.readAuthorityApplicationReceiptTag(root, '../bad'),
    invalid,
  );
  assert.throws(
    () =>
      operations.publishAuthorityApplicationReceipt(root, policy, {
        ...payload,
        newRefGeneration: 8,
      }),
    invalid,
  );
  assert.deepEqual(m.events, []);
});

test('tag listing is sorted and performs a fresh observation on every call', () => {
  const m = memory();
  const operations = createAuthorityApplicationReceiptOperations(
    m.observations,
  );
  for (let count = 0; count < 2; count++) {
    assert.deepEqual(
      operations.listAuthorityApplicationReceiptTagRefs(root, policy),
      [`${ref}-a`, `${ref}-z`],
    );
  }
  assert.deepEqual(m.events, ['list', 'list']);
});

test('tag header admission precedes object observation while envelope admission follows it', () => {
  const m = memory();
  const operations = createAuthorityApplicationReceiptOperations(
    m.observations,
  );
  m.state.raw = 'not an annotated tag';
  assert.throws(
    () => operations.readAuthorityApplicationReceiptTag(root, ref),
    invalid,
  );
  assert.deepEqual(m.events, ['read-tag']);
  m.events.length = 0;
  m.state.raw = annotatedTag('{}\n');
  assert.throws(
    () => operations.readAuthorityApplicationReceiptTag(root, ref),
    invalid,
  );
  assert.deepEqual(m.events, ['read-tag', 'read-object']);
});

test('tag bytes and object identity are reobserved without a ref cache', () => {
  const m = memory();
  const operations = createAuthorityApplicationReceiptOperations(
    m.observations,
  );
  assert.equal(
    operations.readAuthorityApplicationReceiptTag(root, ref).tagObject,
    tagObject,
  );
  m.state.object = 'e'.repeat(40);
  assert.equal(
    operations.readAuthorityApplicationReceiptTag(root, ref).tagObject,
    m.state.object,
  );
  m.state.raw = annotatedTag('{}\n');
  assert.throws(
    () => operations.readAuthorityApplicationReceiptTag(root, ref),
    invalid,
  );
  assert.deepEqual(m.events, [
    'read-tag',
    'read-object',
    'read-tag',
    'read-object',
    'read-tag',
    'read-object',
  ]);
});

for (const phase of ['read-tag', 'read-object'] as const) {
  test(`repository failure at ${phase} is mapped to the receipt error without later reads`, () => {
    const m = memory();
    const failure = () => {
      m.events.push(phase);
      throw new Error('repository unavailable');
    };
    if (phase === 'read-tag') m.observations.readAnnotatedReceiptTag = failure;
    else m.observations.readReceiptTagObjectId = failure;
    const operations = createAuthorityApplicationReceiptOperations(
      m.observations,
    );
    assert.throws(
      () => operations.readAuthorityApplicationReceiptTag(root, ref),
      invalid,
    );
    assert.deepEqual(
      m.events,
      phase === 'read-tag' ? ['read-tag'] : ['read-tag', 'read-object'],
    );
  });
}

test('existing exact receipt uses pinned verification without requiring a signer', () => {
  const m = memory();
  m.state.existing = tagObject;
  const operations = createAuthorityApplicationReceiptOperations(
    m.observations,
  );
  assert.deepEqual(
    operations.publishAuthorityApplicationReceipt(root, policy, payload)
      .envelope,
    envelope,
  );
  assert.deepEqual(m.events, [
    'resolve',
    'read-tag',
    'read-object',
    'verify-policy',
  ]);
});

test('existing exact receipt uses an explicit signer only for verification', () => {
  const m = memory();
  m.state.existing = tagObject;
  const operations = createAuthorityApplicationReceiptOperations(
    m.observations,
  );
  operations.publishAuthorityApplicationReceipt(
    root,
    policy,
    payload,
    m.signer,
  );
  assert.deepEqual(m.events, [
    'resolve',
    'read-tag',
    'read-object',
    'verify-signer',
  ]);
});

for (const mismatch of ['target', 'payload'] as const) {
  test(`existing receipt with a conflicting ${mismatch} fails before signature verification`, () => {
    const m = memory();
    m.state.existing = tagObject;
    m.state.raw =
      mismatch === 'target'
        ? annotatedTag(
            canonicalAuthorityApplicationReceiptEnvelope(envelope),
            'f'.repeat(40),
          )
        : annotatedTag(
            canonicalAuthorityApplicationReceiptEnvelope({
              ...envelope,
              payload: { ...payload, changeId: 'another-change' },
            }),
          );
    const operations = createAuthorityApplicationReceiptOperations(
      m.observations,
    );
    assert.throws(
      () =>
        operations.publishAuthorityApplicationReceipt(
          root,
          policy,
          payload,
          m.signer,
        ),
      conflict,
    );
    assert.deepEqual(m.events, ['resolve', 'read-tag', 'read-object']);
  });
}

test('a missing receipt requires the exact signer after resolving the deterministic ref', () => {
  const m = memory();
  const operations = createAuthorityApplicationReceiptOperations(
    m.observations,
  );
  const signerRequired = {
    code: 'AUTHORITY_APPLICATION_RECEIPT_SIGNER_REQUIRED',
  };
  assert.throws(
    () => operations.publishAuthorityApplicationReceipt(root, policy, payload),
    signerRequired,
  );
  assert.deepEqual(m.events, ['resolve']);
  m.events.length = 0;
  assert.throws(
    () =>
      operations.publishAuthorityApplicationReceipt(root, policy, payload, {
        ...m.signer,
        identity() {
          m.events.push('identity');
          return 'other';
        },
      }),
    signerRequired,
  );
  assert.deepEqual(m.events, ['resolve', 'identity']);
});

test('new publication verifies exact signed bytes before writing and rereads after writing', () => {
  const m = memory();
  const operations = createAuthorityApplicationReceiptOperations(
    m.observations,
  );
  assert.deepEqual(
    operations.publishAuthorityApplicationReceipt(
      root,
      policy,
      payload,
      m.signer,
    ),
    { ref, target: payload.candidateCommit, tagObject, envelope },
  );
  assert.deepEqual(m.events, [
    'resolve',
    'identity',
    'sign',
    'verify-signer',
    'publish',
    'read-tag',
    'read-object',
  ]);
});

for (const phase of ['sign', 'verify-signer', 'publish'] as const) {
  test(`${phase} failure retains its original identity and prevents all later publication phases`, () => {
    const m = memory();
    const error = new Error(`failure at ${phase}`);
    const failure = () => {
      m.events.push(phase);
      throw error;
    };
    if (phase === 'sign') m.signer.sign = failure;
    else if (phase === 'verify-signer') m.signer.verify = failure;
    else m.observations.createMaintainerAuditTag = failure;
    const operations = createAuthorityApplicationReceiptOperations(
      m.observations,
    );
    assert.throws(
      () =>
        operations.publishAuthorityApplicationReceipt(
          root,
          policy,
          payload,
          m.signer,
        ),
      (value) => value === error,
    );
    const sequence = [
      'resolve',
      'identity',
      'sign',
      'verify-signer',
      'publish',
    ];
    assert.deepEqual(m.events, sequence.slice(0, sequence.indexOf(phase) + 1));
  });
}

test('publication rejects a different envelope observed after the audit write', () => {
  const m = memory();
  const publish = m.observations.createMaintainerAuditTag;
  m.observations.createMaintainerAuditTag = (...args) => {
    const object = publish(...args);
    m.state.raw = annotatedTag(
      canonicalAuthorityApplicationReceiptEnvelope({
        ...envelope,
        signature: signature.replace('YWJj', 'ZGVm'),
      }),
    );
    return object;
  };
  const operations = createAuthorityApplicationReceiptOperations(
    m.observations,
  );
  assert.throws(
    () =>
      operations.publishAuthorityApplicationReceipt(
        root,
        policy,
        payload,
        m.signer,
      ),
    conflict,
  );
  assert.deepEqual(m.events, [
    'resolve',
    'identity',
    'sign',
    'verify-signer',
    'publish',
    'read-tag',
    'read-object',
  ]);
});

test('untrusted signer rejection precedes payload validation and retains the caller error code', () => {
  const m = memory();
  const operations = createAuthorityApplicationReceiptOperations(
    m.observations,
  );
  assert.throws(
    () =>
      operations.verifyAuthorityApplicationReceiptSignature(
        {
          ...envelope,
          payload: { ...payload, signer: 'untrusted', newRefGeneration: 100 },
        },
        policy,
        'CI_RECEIPT_SIGNATURE',
      ),
    { code: 'CI_RECEIPT_SIGNATURE' },
  );
  assert.deepEqual(m.events, []);
});
