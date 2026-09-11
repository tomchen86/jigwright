import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAuthorityAuditOperations } from '../src/application/control-plane/authority-audit.ts';
import { createAuthorityAuditInputReader } from '../src/runtime/repository-observation/authority-audit-input.ts';
import {
  parseArguments,
  auditUsageError,
  inputFileUnsafe,
  destructionGrantFileInvalid,
  protectedConfigurationInputInvalid,
} from '../src/adapters/command-line/authority-audit-input.ts';
import type {
  AuthorityAuditLedgerOperations,
  AuthorityAuditInputOperations,
  AuthorityAuditRepositoryObservations,
  AuthorityAuditInputErrors,
  AuditDestructionGrantEnvelope,
} from '../src/modules/authority/authority-audit-contract.ts';

const errors = {
  auditUsageError,
  inputFileUnsafe,
  destructionGrantFileInvalid,
  protectedConfigurationInputInvalid,
};
const digest = `sha256:${'a'.repeat(64)}` as const;
const instant = new Date('2026-08-03T12:00:00.000Z');
const policy = JSON.parse(
  fs.readFileSync(
    new URL('../../../workflow/maintainer-policy.json', import.meta.url),
    'utf8',
  ),
);
const envelope: AuditDestructionGrantEnvelope = {
  schemaVersion: 1,
  kind: 'audit-destruction-grant-envelope.v1',
  payload: {
    schemaVersion: 1,
    kind: 'audit-destruction-grant.v1',
    domain: 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1',
    grantId: '11111111-1111-4111-8111-111111111111',
    repositoryId: digest,
    profile: 'protected',
    expectedHeadSequence: 1,
    expectedHeadRecordDigest: digest,
    throughSequence: 1,
    throughRecordDigest: digest,
    issuedAt: instant.toISOString(),
    expiresAt: new Date(instant.getTime() + 60_000).toISOString(),
    uses: 1,
    signerIdentity: 'fixture-maintainer',
    reasonDigest: digest,
    remoteAnchorDisposition: 'retain',
  },
  signature: 'fixture-signature',
};

function memory() {
  const calls: string[] = [];
  const faults = new Map<string, Error>();
  function observe(name: string) {
    calls.push(name);
    const fault = faults.get(name);
    if (fault) throw fault;
  }
  const backend = {
    backendId: 'memory',
    publish: () => 'receipt',
    verify: () => true,
  };
  const signatureVerifier = () => true;
  const scan = {
    repositoryId: digest,
    profile: 'protected' as const,
    recordCount: 1,
    prunedRecordCount: 0,
    headSequence: 1,
    headRecordDigest: digest,
    records: [],
  };
  const verified = {
    ...scan,
    ok: true,
    projectedEventCount: 1,
    legacyUnprojectedCount: 0,
    events: [],
  };
  const anchor = {
    receiptDigest: digest,
    receiptPath: '/anchor',
    receipt: {
      schemaVersion: 1 as const,
      kind: 'authority-audit-anchor-receipt.v1' as const,
      repositoryId: digest,
      profile: 'protected' as const,
      policyDigest: digest,
      headSequence: 1,
      headRecordDigest: digest,
      anchoredAt: instant.toISOString(),
      backendId: 'memory',
      backendReceipt: 'receipt',
    },
  };
  const ledger: AuthorityAuditLedgerOperations = {
    scanAuthorityAuditLedger(observed) {
      observe('scan');
      assert.equal(observed.externalAuditRoot, '/audit');
      return scan;
    },
    showAuthorityAuditTask(observed, task) {
      observe('show');
      assert.equal(observed.externalAuditRoot, '/audit');
      assert.equal(task, 'task');
      return verified;
    },
    verifyAuthorityAuditEvents(observed) {
      observe('verify');
      assert.equal(observed.externalAuditRoot, '/audit');
      return verified;
    },
    configureProtectedAuthorityAuditLedger(observed, configuration) {
      observe('configure');
      assert.equal(observed.externalAuditRoot, '/audit');
      assert.deepEqual(configuration, {
        backendRoot: '/backend',
        destructionPublicKeyPem: 'key',
      });
      return {
        schemaVersion: 1,
        kind: 'authority-audit-protected-configuration.v1',
        repositoryId: digest,
        backendId: 'filesystem-worm.v1',
        ...configuration,
        destructionPublicKeyDigest: digest,
        configurationDigest: digest,
      };
    },
    createPinnedAuthorityAuditAnchorBackend() {
      observe('backend');
      return backend;
    },
    createPinnedAuditDestructionSignatureVerifier() {
      observe('signature-verifier');
      return signatureVerifier;
    },
    anchorProtectedAuthorityAuditLedger(_observed, input) {
      observe('anchor');
      assert.equal(input.backend, backend);
      assert.equal(input.anchoredAt, instant.toISOString());
      return anchor;
    },
    verifyProtectedAuthorityAuditAnchors(_observed, backends) {
      observe('verify-anchors');
      assert.deepEqual(backends, [backend]);
      return {
        schemaVersion: 1,
        kind: 'authority-audit-anchor-verification.v1',
        repositoryId: digest,
        ok: true,
        currentHeadAnchored: true,
        receipts: [anchor],
      };
    },
    destroyProtectedAuthorityAuditLedger(_observed, grant, input) {
      observe('destroy');
      assert.equal(grant, envelope);
      assert.equal(input.now, instant.toISOString());
      assert.equal(input.verifyHumanSignature, signatureVerifier);
      return {
        schemaVersion: 1,
        kind: 'authority-audit-compaction.v1',
        profile: 'protected',
        pruned: 1,
        retained: 0,
        prunedThroughSequence: 1,
        prunedThroughRecordDigest: digest,
        checkpointDigest: digest,
      };
    },
  };
  const repository: AuthorityAuditRepositoryObservations = {
    discoverRepository(cwd) {
      observe('discover');
      assert.equal(cwd, '/cwd');
      return {
        repositoryRoot: '/repository',
        repositoryRealPath: '/repository',
        gitCommonDirectory: '/git',
        branch: 'main',
        head: 'a'.repeat(40),
        tree: 'b'.repeat(40),
        statusEntries: [],
      };
    },
    readPolicyAtHead(repositoryRoot, head) {
      observe('policy');
      assert.equal(repositoryRoot, '/repository');
      assert.equal(head, 'a'.repeat(40));
      return JSON.stringify(policy);
    },
  };
  const input: AuthorityAuditInputOperations = {
    assertExternalAuditRoot(value) {
      observe('audit-root');
      assert.equal(value, '/audit');
      return value;
    },
    assertProtectedBackendRootInput(value) {
      observe('backend-root');
      assert.equal(value, '/backend');
    },
    readPrivateInputFile(value, label) {
      observe('private-key');
      assert.equal(value, '/key');
      assert.equal(label, 'destruction public key');
      return 'key';
    },
    readCanonicalAuditDestructionGrant(value) {
      observe('grant');
      assert.equal(value, '/grant');
      return envelope;
    },
    assertControllingTerminal() {
      observe('tty');
    },
    exactRuntimeNow() {
      observe('clock');
      return instant;
    },
  };
  const operations = createAuthorityAuditOperations(
    ledger,
    repository,
    input,
    errors,
  );
  return {
    calls,
    faults,
    operations,
    input,
    repository,
    run(argv: string[]) {
      return operations.execute(parseArguments(argv), '/cwd');
    },
  };
}

const resolved = ['discover', 'audit-root', 'policy'];

test('audit construction and rejected grammar perform no observations', () => {
  const value = memory();
  assert.deepEqual(value.calls, []);
  assert.throws(() => value.run(['verify', 'repo']), {
    code: 'AUTHORITY_AUDIT_USAGE',
  });
  assert.deepEqual(value.calls, []);
});

test('audit discovery precedes path validation and exact HEAD policy read', () => {
  const value = memory();
  const failure = new Error('repository discovery failed');
  value.faults.set('discover', failure);
  assert.throws(
    () => value.run(['show', 'task', '--audit-root', 'relative']),
    (error) => error === failure,
  );
  assert.deepEqual(value.calls, ['discover']);
  const readFailure = memory();
  readFailure.faults.set('policy', failure);
  assert.throws(
    () => readFailure.run(['show', 'task', '--audit-root', '/audit']),
    { code: 'AUTHORITY_AUDIT_TRUST_BASE_MISSING' },
  );
  assert.deepEqual(readFailure.calls, resolved);
});

test('audit identity mismatch precedes ledger verification', () => {
  const value = memory();
  assert.throws(
    () => value.run(['verify', 'wrong', '--audit-root', '/audit']),
    { code: 'AUTHORITY_AUDIT_REPOSITORY_MISMATCH' },
  );
  assert.deepEqual(value.calls, resolved);
});

test('protected audit profile resolves TTY, backend and private key before configure and scan', () => {
  const value = memory();
  const argv = [
    'profile',
    'protected',
    '--audit-root',
    '/audit',
    '--backend-root',
    '/backend',
    '--destruction-public-key',
    '/key',
  ];
  assert.equal(value.run(argv).verified, true);
  assert.deepEqual(value.calls, [
    ...resolved,
    'tty',
    'backend-root',
    'private-key',
    'configure',
    'scan',
  ]);
  const blocked = memory();
  const sentinel = new Error('TTY unavailable');
  blocked.faults.set('tty', sentinel);
  assert.throws(
    () => blocked.run(argv),
    (error) => error === sentinel,
  );
  assert.deepEqual(blocked.calls, [...resolved, 'tty']);
});

test('development, show and verify do not observe clock or TTY', () => {
  for (const [argv, last] of [
    [['profile', 'development', '--audit-root', '/audit'], 'scan'],
    [['show', 'task', '--audit-root', '/audit'], 'show'],
    [['verify', policy.repository.id, '--audit-root', '/audit'], 'verify'],
  ] as const) {
    const value = memory();
    value.run([...argv]);
    assert.deepEqual(value.calls, [...resolved, last]);
  }
});

test('anchor reads clock before pinned backend and verification does not read clock', () => {
  const value = memory();
  value.run(['anchor', '--audit-root', '/audit']);
  assert.deepEqual(value.calls, [...resolved, 'clock', 'backend', 'anchor']);
  const blocked = memory();
  const sentinel = new Error('clock unavailable');
  blocked.faults.set('clock', sentinel);
  assert.throws(
    () => blocked.run(['anchor', '--audit-root', '/audit']),
    (error) => error === sentinel,
  );
  assert.deepEqual(blocked.calls, [...resolved, 'clock']);
  const verification = memory();
  verification.run(['verify-anchors', '--audit-root', '/audit']);
  assert.deepEqual(verification.calls, [
    ...resolved,
    'backend',
    'verify-anchors',
  ]);
});

test('destroy parses exact grant before clock, pinned verifier and ledger mutation', () => {
  const argv = ['destroy', '--grant-file', '/grant', '--audit-root', '/audit'];
  const value = memory();
  value.run(argv);
  assert.deepEqual(value.calls, [
    ...resolved,
    'grant',
    'clock',
    'signature-verifier',
    'destroy',
  ]);
  const blocked = memory();
  const sentinel = new Error('grant invalid');
  blocked.faults.set('grant', sentinel);
  assert.throws(
    () => blocked.run(argv),
    (error) => error === sentinel,
  );
  assert.deepEqual(blocked.calls, [...resolved, 'grant']);
  const mutation = memory();
  mutation.faults.set('destroy', sentinel);
  assert.throws(
    () => mutation.run(argv),
    (error) => error === sentinel,
  );
});

test('runtime audit input preserves error factory identity and invalid clock diagnostics', () => {
  const sentinel = auditUsageError();
  const custom: AuthorityAuditInputErrors = {
    ...errors,
    auditUsageError: () => sentinel,
  };
  const reader = createAuthorityAuditInputReader(custom);
  assert.throws(
    () => reader.assertExternalAuditRoot('relative'),
    (error) => error === sentinel,
  );
  assert.throws(
    () => reader.readPrivateInputFile('relative', 'key'),
    (error) => error === sentinel,
  );
  assert.throws(() => reader.exactRuntimeNow({ now: new Date('invalid') }), {
    code: 'AUTHORITY_AUDIT_CLOCK_INVALID',
  });
  assert.throws(
    () =>
      reader.assertControllingTerminal({
        stdinIsTTY: false,
        stdoutIsTTY: true,
      }),
    { code: 'AUTHORITY_AUDIT_CONTROLLING_TERMINAL_REQUIRED' },
  );
  reader.assertControllingTerminal({ stdinIsTTY: true, stdoutIsTTY: true });
});

test('private input reads preserve descriptor ordering and close the descriptor after read failure', (t) => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'audit-input-order-')),
  );
  const file = path.join(directory, 'key');
  fs.writeFileSync(file, 'key', { mode: 0o600 });
  const calls: string[] = [];
  let descriptor: number | undefined;
  let failRead = false;
  const originals = {
    realpathSync: fs.realpathSync,
    lstatSync: fs.lstatSync,
    openSync: fs.openSync,
    fstatSync: fs.fstatSync,
    readFileSync: fs.readFileSync,
    closeSync: fs.closeSync,
  };
  t.mock.method(fs, 'realpathSync', (input: fs.PathLike) => {
    if (input === file) calls.push('realpath');
    return originals.realpathSync(input);
  });
  t.mock.method(fs, 'lstatSync', (input: fs.PathLike) => {
    if (input === file) calls.push('lstat');
    return originals.lstatSync(input);
  });
  t.mock.method(
    fs,
    'openSync',
    (input: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
      const opened = originals.openSync(input, flags, mode);
      if (input === file) {
        calls.push('open');
        descriptor = opened;
      }
      return opened;
    },
  );
  t.mock.method(fs, 'fstatSync', (input: number) => {
    if (input === descriptor) calls.push('fstat');
    return originals.fstatSync(input);
  });
  t.mock.method(
    fs,
    'readFileSync',
    (
      input: fs.PathOrFileDescriptor,
      options?: Parameters<typeof fs.readFileSync>[1],
    ) => {
      if (input === descriptor) {
        calls.push('read');
        if (failRead) throw new Error('read fault');
      }
      return originals.readFileSync(input, options);
    },
  );
  t.mock.method(fs, 'closeSync', (input: number) => {
    if (input === descriptor) calls.push('close');
    return originals.closeSync(input);
  });
  const sentinel = inputFileUnsafe('public key');
  const reader = createAuthorityAuditInputReader({
    ...errors,
    inputFileUnsafe: () => sentinel,
  });
  try {
    assert.equal(reader.readPrivateInputFile(file, 'public key'), 'key');
    assert.deepEqual(calls, [
      'realpath',
      'lstat',
      'open',
      'fstat',
      'read',
      'fstat',
      'close',
    ]);
    calls.length = 0;
    failRead = true;
    assert.throws(
      () => reader.readPrivateInputFile(file, 'public key'),
      (error) => error === sentinel,
    );
    assert.deepEqual(calls, [
      'realpath',
      'lstat',
      'open',
      'fstat',
      'read',
      'close',
    ]);
    assert.throws(() => originals.fstatSync(descriptor!), { code: 'EBADF' });
  } finally {
    t.mock.restoreAll();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
