import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarnessBootstrapDependencies } from '../bootstrap/harness-bootstrap-production.ts';
import type {
  HarnessBootstrapRecoveryCommandBindings,
  HarnessBootstrapRecoveryInput,
  HarnessBootstrapRuntimeOverrides,
} from '../src/application/control-plane/harness-bootstrap-contracts.ts';
import { createHarnessBootstrapRecoveryCommands } from '../src/application/control-plane/harness-bootstrap-recovery-commands.ts';
import { createHarnessBootstrapProduction } from '../src/composition-root/harness-bootstrap-production.ts';
import type {
  RecoveryAuthorityDescriptorV1,
  RecoveryAuthorityExpectations,
} from '../src/modules/authority/recovery-authority-contract.ts';
import {
  createMarker,
  createRecoveryQuarantineEnterGrantPayload,
  type RecoveryQuarantineDependencies,
  type RecoveryQuarantineEnvelope,
  type RecoveryQuarantineMarker,
} from '../src/modules/authority/recovery-quarantine-contract.ts';
import type { RecoveryOperationalTrustRootRestoreDependencies } from '../src/modules/authority/recovery-trust-root-contract.ts';
import { RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE } from '../src/modules/authority/recovery-trust-root-values.ts';
import type { GitState } from '../src/modules/repository-consumer/repository-git-state.ts';
import { readOptionalRecoveryQuarantineMarker } from '../src/runtime/recovery/harness-bootstrap-external-input.ts';
import {
  assertPureApplicationDependencyClosure,
  assertPureDependencyClosure,
} from './support/pure-dependency-closure.ts';
import { readModuleDependencies } from './support/dependency-graph.ts';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';
test('bootstrap and recovery canonical contracts have a complete pure value/type closure', () => {
  for (const name of [
    'authority/intervention-bootstrap-contract',
    'authority/recovery-quarantine-contract',
    'authority/recovery-trust-root-contract',
    'lifecycle/workflow-session-contract',
    'repository-consumer/repository-git-state',
  ]) {
    assertPureDependencyClosure(
      fileURLToPath(new URL(`../src/modules/${name}.ts`, import.meta.url)),
    );
  }
});
test('bootstrap construction preserves lazy signer resolution and override identity', () => {
  const lazy = createHarnessBootstrapDependencies(
    '/nonexistent-bootstrap-repository',
  );
  assert.equal(typeof lazy.maintenanceSigner?.sign, 'function');
  const events: string[] = [];
  const now = () => {
    events.push('clock');
    return new Date('2026-08-01T00:00:00.000Z');
  };
  const dependencies = createHarnessBootstrapDependencies(
    '/nonexistent-bootstrap-repository',
    {
      now,
      maintenanceSigner: {
        assertHumanPresent() {
          events.push('presence');
        },
        identity() {
          events.push('identity');
          return 'signer-a';
        },
        sign(payload, namespace) {
          events.push(`sign:${payload}:${namespace}`);
          return 'signature';
        },
        verify() {
          events.push('verify');
        },
      },
    },
  );
  assert.equal(dependencies.now, now);
  assert.deepEqual(events, []);
  assert.equal(dependencies.maintenanceSigner!.identity(), 'signer-a');
  assert.equal(
    dependencies.maintenanceSigner!.sign('payload', 'namespace'),
    'signature',
  );
  assert.deepEqual(events, ['identity', 'sign:payload:namespace']);
});

test('recovery command and consumer contracts depend only on canonical pure owners', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const command = path.join(
    root,
    'packages/workflow-engine/src/application/control-plane/harness-bootstrap-recovery-commands.ts',
  );
  const contracts = path.join(
    path.dirname(command),
    'harness-bootstrap-contracts.ts',
  );
  const reader = readRepositoryDependencies(root);
  function check(additionalSource = '') {
    const result = reader.read(command, additionalSource);
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.effects, []);
    const resolved = new Set(result.edges.map(({ specifier }) => specifier));
    for (const { specifier } of readModuleDependencies(
      command,
      fs.readFileSync(command, 'utf8') + additionalSource,
    )) {
      assert.ok(specifier !== null && resolved.has(specifier));
    }
    for (const edge of result.edges) {
      const target = path.join(root, edge.to);
      if (target === contracts) {
        assertPureApplicationDependencyClosure(target);
      } else {
        assertPureDependencyClosure(target);
      }
    }
  }
  check();
  const contractEdges = reader.read(contracts).edges;
  assert.ok(contractEdges.length > 0);
  assert.ok(
    contractEdges.every(
      ({ typeOnly, to }) =>
        typeOnly && to.startsWith('packages/workflow-engine/src/modules/'),
    ),
  );
  for (const injection of [
    "\nimport fs from 'node:fs';",
    "\nimport type { readRecoveryQuarantineMarker } from '../../runtime/recovery/recovery-quarantine.ts';",
    "\nimport type { HarnessBootstrapProduction } from '../../composition-root/harness-bootstrap-production.ts';",
  ]) {
    assert.throws(() => check(injection), assert.AssertionError);
  }
});

test('command captures each input once and passes the same bare marker reader to optional lookup', () => {
  const fixture = recoveryFixture();
  const reads: string[] = [];
  const original = fixture.bindings.input.readRecoveryQuarantineMarker;
  fixture.bindings.input.readOptionalRecoveryQuarantineMarker = function (
    common,
    readMarker,
  ) {
    assert.equal(this, undefined);
    assert.equal(common, fixture.repository.gitCommonDirectory);
    assert.equal(readMarker, original);
    fixture.events.push('optional');
    return readMarker(fixture.stateRoot);
  };
  const input = fixture.bindings.input;
  for (const key of Object.keys(
    input,
  ) as (keyof HarnessBootstrapRecoveryInput)[]) {
    const value = input[key];
    Object.defineProperty(input, key, {
      configurable: true,
      get() {
        reads.push(key);
        return value;
      },
    });
  }
  Object.defineProperty(fixture.bindings, 'input', {
    get() {
      reads.push('input');
      return input;
    },
  });
  const commands = createHarnessBootstrapRecoveryCommands(fixture.bindings);
  assert.deepEqual(fixture.events, []);
  assert.equal(reads.length, 10);
  assert.equal(new Set(reads).size, 10);
  Object.defineProperty(input, 'readRecoveryQuarantineMarker', {
    get() {
      assert.fail('reader must be captured at construction');
    },
  });
  commands.assertHarnessRecoveryQuarantineRouting([], '/cwd', () =>
    assert.fail('no marker'),
  );
  commands.dispatchRecoveryAuthorityCommand(statusArgs, '/cwd', {});
  assert.equal(reads.length, 10);
  assert.deepEqual(fixture.events, [
    'discover',
    'optional',
    'marker',
    'fence',
    'discover',
    'expectations',
    'require',
    'marker',
    'descriptor',
  ]);
});

test('real optional runtime adapter uses the injected captured reader after private-directory validation', () => {
  const fixture = recoveryFixture();
  const common = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-input-')),
  );
  fixture.repository.gitCommonDirectory = common;
  const stateRoot = path.join(
    common,
    'workflow-engine',
    'recovery-authority-state',
  );
  const failure = new Error('injected marker failure');
  let calls = 0;
  const original = function (this: undefined, root: string) {
    assert.equal(this, undefined);
    assert.equal(root, stateRoot);
    calls++;
    if (calls === 2) throw failure;
    return fixture.marker;
  };
  fixture.bindings.input.readRecoveryQuarantineMarker = original;
  fixture.bindings.input.readOptionalRecoveryQuarantineMarker =
    readOptionalRecoveryQuarantineMarker;
  const commands = createHarnessBootstrapRecoveryCommands(fixture.bindings);
  fixture.bindings.input.readRecoveryQuarantineMarker = () =>
    assert.fail('replacement reader');
  const observed: RecoveryQuarantineMarker[] = [];
  const route = () =>
    commands.assertHarnessRecoveryQuarantineRouting(
      releaseArgs,
      '/cwd',
      ({ marker }) => observed.push(marker),
    );
  try {
    route(); // Missing directory does not call the marker reader.
    assert.equal(calls, 0);
    fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateRoot, 0o700);
    route();
    assert.deepEqual(observed, [fixture.marker]);
    assert.equal(observed[0], fixture.marker);
    assert.throws(route, (error) => error === failure);
    fs.chmodSync(stateRoot, 0o755);
    assert.throws(route, {
      code: 'RECOVERY_AUTHORITY_EXTERNAL_INPUT_UNSAFE',
      exitCode: 12,
    });
    assert.equal(calls, 2);
  } finally {
    fs.rmSync(common, { recursive: true, force: true });
  }
});

test('routing observes active authority before a fresh fence even for allowed release and restore', () => {
  for (const args of [releaseArgs, restoreArgs]) {
    const fixture = recoveryFixture();
    fixture.state.marker = fixture.marker;
    const commands = createHarnessBootstrapRecoveryCommands(fixture.bindings);
    const failure = new Error('observer failure');
    assert.throws(
      () =>
        commands.assertHarnessRecoveryQuarantineRouting(args, '/cwd', () => {
          fixture.events.push('observer');
          throw failure;
        }),
      (error) => error === failure,
    );
    assert.deepEqual(fixture.events, [
      'discover',
      'optional',
      'marker',
      'observer',
    ]);
    fixture.events.length = 0;
    commands.assertHarnessRecoveryQuarantineRouting(
      args,
      '/cwd',
      (authority) => {
        assert.equal(authority.marker, fixture.marker);
        assert.equal(
          authority.repositoryRoot,
          fixture.repository.repositoryRealPath,
        );
        fixture.events.push('observer');
        fixture.state.fence = true;
      },
    );
    assert.deepEqual(fixture.events, [
      'discover',
      'optional',
      'marker',
      'observer',
      'fence',
    ]);
    fixture.events.length = 0;
    fixture.state.fenceError = new Error('fresh fence failure');
    assert.throws(
      () =>
        commands.assertHarnessRecoveryQuarantineRouting(args, '/cwd', () =>
          fixture.events.push('observer'),
        ),
      (error) => error === fixture.state.fenceError,
    );
    assert.deepEqual(fixture.events, [
      'discover',
      'optional',
      'marker',
      'observer',
      'fence',
    ]);
  }
  const fixture = recoveryFixture();
  fixture.state.fence = true;
  const commands = createHarnessBootstrapRecoveryCommands(fixture.bindings);
  commands.assertHarnessRecoveryQuarantineRouting(enterArgs, '/cwd', () =>
    assert.fail('no marker'),
  );
  assert.throws(
    () =>
      commands.assertHarnessRecoveryQuarantineRouting(releaseArgs, '/cwd', () =>
        assert.fail('no marker'),
      ),
    { code: 'RECOVERY_OPERATIONAL_TRUST_NOT_ACTIVATED', exitCode: 10 },
  );
});

test('memory dispatch preserves verification, inactivity and argv error precedence', () => {
  const fixture = recoveryFixture();
  const commands = createHarnessBootstrapRecoveryCommands(fixture.bindings);
  assert.equal(
    commands.dispatchRecoveryAuthorityCommand(importArgs, '/cwd', {}),
    fixture.descriptor,
  );
  assert.deepEqual(fixture.events, [
    'discover',
    'expectations',
    'raw',
    'verify',
    'ensure',
    'marker',
    'import',
  ]);
  fixture.events.length = 0;
  fixture.state.verifyError = new Error('descriptor verification failed');
  assert.throws(
    () => commands.dispatchRecoveryAuthorityCommand(importArgs, '/cwd', {}),
    (error) => error === fixture.state.verifyError,
  );
  assert.deepEqual(fixture.events, [
    'discover',
    'expectations',
    'raw',
    'verify',
  ]);
  fixture.events.length = 0;
  fixture.state.marker = fixture.marker;
  assert.throws(
    () => commands.dispatchRecoveryAuthorityCommand(statusArgs, '/cwd', {}),
    { code: 'WORKFLOW_RECOVERY_QUARANTINED', exitCode: 10 },
  );
  assert.deepEqual(fixture.events, [
    'discover',
    'expectations',
    'require',
    'marker',
  ]);
  fixture.events.length = 0;
  assert.throws(
    () => commands.dispatchRecoveryQuarantineCommand(enterArgs, '/cwd', {}),
    { code: 'WORKFLOW_RECOVERY_QUARANTINED', exitCode: 10 },
  );
  assert.deepEqual(fixture.events, [
    'discover',
    'expectations',
    'require',
    'descriptor',
    'envelope',
    'quarantine-deps',
    'marker',
  ]);
  fixture.events.length = 0;
  assert.throws(
    () => commands.dispatchRecoveryQuarantineCommand(releaseArgs, '/cwd', {}),
    (error) => error === fixture.executed,
  );
  assert.deepEqual(fixture.events, [
    'discover',
    'expectations',
    'require',
    'descriptor',
    'envelope',
    'quarantine-deps',
    'release',
  ]);
  fixture.events.length = 0;
  fixture.state.marker = null;
  assert.throws(
    () => commands.dispatchRecoveryQuarantineCommand(enterArgs, '/cwd', {}),
    (error) => error === fixture.executed,
  );
  assert.deepEqual(fixture.events, [
    'discover',
    'expectations',
    'require',
    'descriptor',
    'envelope',
    'quarantine-deps',
    'marker',
    'enter',
  ]);
  for (const authority of [true, false]) {
    fixture.events.length = 0;
    assert.throws(
      () =>
        authority
          ? commands.dispatchRecoveryAuthorityCommand(
              ['recovery-authority', 'invalid'],
              '/cwd',
              {},
            )
          : commands.dispatchRecoveryQuarantineCommand(
              [...releaseArgs, '--extra'],
              '/cwd',
              {},
            ),
      { code: 'HARNESS_RECOVERY_COMMAND_UNSUPPORTED', exitCode: 2 },
    );
    assert.deepEqual(fixture.events, authority ? ['discover'] : []);
  }
});

test('restore checks every marker binding again after the hook and rejects digest substitution', () => {
  const changes: (Partial<RecoveryQuarantineMarker> | null)[] = [
    null,
    { markerDigest: `sha256:${'b'.repeat(64)}` },
    { repositoryId: 'different' },
    { authorityDescriptorDigest: `sha256:${'b'.repeat(64)}` },
    { authorityGeneration: 2 },
    { recoveryRuntimeDigest: `sha256:${'b'.repeat(64)}` },
    { externalAuditRoot: '/different-audit' },
  ];
  for (const phase of ['initial', 'final'] as const) {
    for (const change of [...changes, {}]) {
      // The first read establishes the digest; only a final substitution differs.
      if (phase === 'initial' && change?.markerDigest) continue;
      const fixture = recoveryFixture();
      const changed = change === null ? null : { ...fixture.marker, ...change };
      fixture.state.marker = phase === 'initial' ? changed : fixture.marker;
      const overrides: HarnessBootstrapRuntimeOverrides = {
        beforeRecoveryTrustRootExecute() {
          assert.equal(this, overrides);
          fixture.events.push('hook');
          if (phase === 'final') fixture.state.marker = changed;
        },
      };
      fixture.state.overrides = overrides;
      const commands = createHarnessBootstrapRecoveryCommands(fixture.bindings);
      const successful = change !== null && Object.keys(change).length === 0;
      const call = () =>
        commands.dispatchRecoveryAuthorityCommand(
          restoreArgs,
          '/cwd',
          overrides,
        );
      if (successful) {
        assert.throws(call, (error) => error === fixture.executed);
      } else {
        assert.throws(call, {
          code:
            change === null
              ? 'RECOVERY_TRUST_ROOT_QUARANTINE_REQUIRED'
              : 'RECOVERY_TRUST_ROOT_QUARANTINE_MISMATCH',
          exitCode: change === null ? 10 : 13,
        });
      }
      assert.deepEqual(
        fixture.events,
        [
          'discover',
          'expectations',
          'require',
          'descriptor',
          'audit-root',
          'marker',
          ...(phase === 'final' || successful
            ? ['restore-deps', 'hook', 'marker']
            : []),
          ...(successful ? ['restore'] : []),
        ],
        `${phase}: ${JSON.stringify(change)}`,
      );
    }
  }
});

test('ordinary signer stays captured while verifier overrides remain invocation-time member calls', () => {
  const events: string[] = [];
  const signer = {
    assertHumanPresent() {
      assert.equal(this, signer);
      events.push('presence');
    },
    identity() {
      assert.equal(this, signer);
      events.push('identity');
      return 'signer';
    },
    sign() {
      assert.equal(this, signer);
      events.push('sign');
      return 'signature';
    },
    verify() {
      assert.equal(this, signer);
      events.push('verify');
    },
  };
  let verifier: HarnessBootstrapRuntimeOverrides['verifyHumanSignature'];
  const overrides: HarnessBootstrapRuntimeOverrides = {
    get maintenanceSigner() {
      events.push('signer-get');
      return signer;
    },
    get verifyHumanSignature() {
      events.push('verifier-get');
      return verifier;
    },
  };
  const deps = createHarnessBootstrapDependencies(
    '/not-a-repository',
    overrides,
  );
  assert.deepEqual(events, ['signer-get']);
  Object.defineProperty(overrides, 'maintenanceSigner', {
    get() {
      assert.fail('signer was already captured');
    },
  });
  deps.maintenanceSigner!.assertHumanPresent();
  deps.maintenanceSigner!.identity();
  deps.maintenanceSigner!.sign('payload', 'namespace');
  deps.maintenanceSigner!.verify('payload', 'signature', 'signer', 'namespace');
  assert.deepEqual(events, [
    'signer-get',
    'presence',
    'identity',
    'sign',
    'verify',
  ]);
  events.length = 0;
  assert.equal(
    deps.verifyHumanSignature!('payload', 'signature', 'signer', 'namespace'),
    true,
  );
  assert.deepEqual(events, ['verifier-get', 'verify']);
  events.length = 0;
  verifier = function (this: HarnessBootstrapRuntimeOverrides) {
    assert.equal(this, overrides);
    events.push('override');
    return false;
  };
  assert.equal(
    deps.verifyHumanSignature!('payload', 'signature', 'signer', 'namespace'),
    false,
  );
  assert.deepEqual(events, ['verifier-get', 'verifier-get', 'override']);
  const failure = new Error('override throws');
  verifier = function (this: HarnessBootstrapRuntimeOverrides) {
    assert.equal(this, overrides);
    throw failure;
  };
  assert.throws(
    () =>
      deps.verifyHumanSignature!('payload', 'signature', 'signer', 'namespace'),
    (error) => error === failure,
  );
});

test('recovery composition preserves clock and audit getter order, identity and receiver', () => {
  const fixture = recoveryFixture();
  const production = createHarnessBootstrapProduction();
  for (const kind of ['quarantine', 'restore'] as const) {
    const events: string[] = [];
    const now = new Date('2026-08-10T13:00:00.000Z');
    let receiver: unknown;
    const append = function (this: unknown) {
      receiver = this;
    };
    const sink = {
      get append() {
        events.push('append-get');
        return append;
      },
    };
    const overrides: HarnessBootstrapRuntimeOverrides = {
      get now() {
        events.push('clock-get');
        return function (this: HarnessBootstrapRuntimeOverrides) {
          assert.equal(this, overrides);
          events.push('clock');
          return now;
        };
      },
      get recoveryQuarantineAuditSink() {
        events.push('sink-get');
        return sink;
      },
      get recoveryTrustRootAuditSink() {
        events.push('sink-get');
        return sink;
      },
    };
    const envelope: RecoveryQuarantineEnvelope = {
      ...fixture.envelope,
      payload: {
        ...fixture.envelope.payload,
        get externalAuditRoot() {
          events.push('audit-root-get');
          return '/audit';
        },
      },
    };
    for (let call = 0; call < 2; call++) {
      events.length = 0;
      const dependencies =
        kind === 'quarantine'
          ? production.recoveryQuarantineDependencies(
              fixture.descriptor,
              fixture.expectations,
              envelope,
              '/repository',
              overrides,
            )
          : production.recoveryOperationalTrustRootDependencies(
              fixture.descriptor,
              fixture.expectations,
              '/audit',
              '/repository',
              overrides,
            );
      assert.deepEqual(events, [
        ...(kind === 'quarantine' ? ['audit-root-get'] : []),
        'clock-get',
        'clock',
        'sink-get',
        'append-get',
      ]);
      assert.equal(dependencies.authorityDescriptor, fixture.descriptor);
      assert.equal(dependencies.authorityExpectations, fixture.expectations);
      assert.equal(dependencies.now, now);
      assert.equal(dependencies.appendAudit, append);
      // Receiver is the dependency object, not the original sink.
      Reflect.apply(dependencies.appendAudit, dependencies, []);
      assert.equal(receiver, dependencies);
    }
  }
});

test('recovery verifiers ignore ordinary overrides after passing identity, fingerprint and namespace guards', () => {
  const fixture = recoveryFixture();
  const production = createHarnessBootstrapProduction();
  let publicKeyReads = 0;
  const descriptor = {
    ...fixture.descriptor,
    signer: {
      ...fixture.descriptor.signer,
      get publicKey() {
        publicKeyReads++;
        return fixture.descriptor.signer.publicKey;
      },
    },
  };
  const overrides: HarnessBootstrapRuntimeOverrides = {
    now: () => new Date('2026-08-10T13:00:00.000Z'),
    recoveryQuarantineAuditSink: { append() {} },
    recoveryTrustRootAuditSink: { append() {} },
    get verifyHumanSignature(): never {
      return assert.fail(
        'ordinary verifier must not be consulted for recovery',
      );
    },
  };
  const quarantine = production.recoveryQuarantineDependencies(
    descriptor,
    fixture.expectations,
    fixture.envelope,
    '/repository',
    overrides,
  );
  const restore = production.recoveryOperationalTrustRootDependencies(
    descriptor,
    fixture.expectations,
    '/audit',
    '/repository',
    overrides,
  );
  for (const [dependencies, namespace] of [
    [quarantine, 'HARNESS_RECOVERY_ENTER_QUARANTINE_V1'],
    [restore, RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE],
  ] as const) {
    assert.equal(
      dependencies.verifyHumanSignature(
        'payload',
        'invalid-signature',
        descriptor.signer.identity,
        namespace,
      ),
      false,
    );
  }
  // Both paths reached the actual descriptor-key verifier and caught its rejection.
  assert.equal(publicKeyReads, 2);
  assert.equal(
    restore.verifyHumanSignature(
      'payload',
      'invalid-signature',
      descriptor.signer.identity,
      'different-namespace',
    ),
    false,
  );
  assert.equal(publicKeyReads, 2);
  assert.equal(
    quarantine.verifyHumanSignature(
      'payload',
      'invalid-signature',
      descriptor.signer.identity,
      'different-namespace',
    ),
    false,
  );
  assert.equal(publicKeyReads, 3); // Quarantine forwards the namespace; restore guards it first.
});

const importArgs = [
  'recovery-authority',
  'import',
  '/external/descriptor.json',
  '--expectations',
  '/external/expectations.json',
];
const statusArgs = [
  'recovery-authority',
  'status',
  '--expectations',
  '/external/expectations.json',
];
const enterArgs = [
  'recovery-quarantine',
  'enter',
  '/external/envelope.json',
  '--expectations',
  '/external/expectations.json',
];
const releaseArgs = [
  'recovery-quarantine',
  'release',
  '/external/envelope.json',
  '--expectations',
  '/external/expectations.json',
];
const restoreArgs = [
  'recovery-authority',
  'restore-trust-root',
  '/external/envelope.json',
  '--expectations',
  '/external/expectations.json',
];

function recoveryFixture() {
  const events: string[] = [];
  const digest = `sha256:${'a'.repeat(64)}` as const;
  const descriptor: RecoveryAuthorityDescriptorV1 = {
    kind: 'harness-recovery-authority.v1',
    repositoryIdentity: {
      repositoryId: 'github:recovery-fixture',
      origin: 'https://github.com/example/recovery.git',
      gitObjectFormat: 'sha1',
    },
    repositoryIdentityDigest: digest,
    generation: 1,
    signer: {
      identity: 'recovery-signer',
      publicKey:
        'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
      fingerprint: `SHA256:${'A'.repeat(43)}`,
    },
    allowedDomains: ['HARNESS_RECOVERY_ENTER_QUARANTINE_V1'],
    sealedRuntime: {
      artifactId: digest,
      executableDigest: digest,
      closureDigest: digest,
      protocolVersion: 1,
    },
    auditLedger: { ledgerId: 'recovery-audit', rootBindingDigest: digest },
    createdAt: '2026-08-10T12:00:00.000Z',
    descriptorDigest: digest,
  };
  const expectations: RecoveryAuthorityExpectations = {
    repositoryIdentity: descriptor.repositoryIdentity,
    generation: descriptor.generation,
    signerFingerprint: descriptor.signer.fingerprint,
    sealedRuntime: descriptor.sealedRuntime,
    auditLedger: descriptor.auditLedger,
    descriptorDigest: descriptor.descriptorDigest,
  };
  const envelope: RecoveryQuarantineEnvelope = {
    payload: createRecoveryQuarantineEnterGrantPayload({
      repositoryId: descriptor.repositoryIdentity.repositoryId,
      authorityDescriptorDigest: descriptor.descriptorDigest,
      authorityGeneration: descriptor.generation,
      recoveryRuntimeDigest: descriptor.sealedRuntime.closureDigest,
      externalAuditRoot: '/audit',
      humanSigner: descriptor.signer.identity,
      signerFingerprint: descriptor.signer.fingerprint,
      issuedAt: '2026-08-10T13:00:00.000Z',
    }),
    signature: 'fixture-signature',
  };
  assert.equal(envelope.payload.operation, 'enter-quarantine');
  const marker = createMarker(envelope.payload, digest);
  const repository: GitState = {
    repositoryRoot: '/alias',
    repositoryRealPath: '/repository',
    gitCommonDirectory: '/git-common',
    branch: 'main',
    head: 'head',
    tree: 'tree',
    statusEntries: [],
  };
  const stateRoot = '/git-common/workflow-engine/recovery-authority-state';
  const boundary = {
    repositoryWorktreeRoot: repository.repositoryRealPath,
    gitCommonDirectory: repository.gitCommonDirectory,
  };
  const state = {
    marker: null as RecoveryQuarantineMarker | null,
    fence: false,
    fenceError: null as Error | null,
    verifyError: null as Error | null,
    overrides: undefined as HarnessBootstrapRuntimeOverrides | undefined,
  };
  const executed = new Error('executor reached');
  const dependencies: RecoveryQuarantineDependencies &
    RecoveryOperationalTrustRootRestoreDependencies = {
    authorityDescriptor: descriptor,
    authorityExpectations: expectations,
    externalAuditRoot: '/audit',
    now: new Date('2026-08-10T13:00:00.000Z'),
    verifyHumanSignature: () => false,
    appendAudit() {
      assert.fail('fake must not audit');
    },
  };
  const bindings: HarnessBootstrapRecoveryCommandBindings = {
    input: {
      readExternalRecoveryExpectations(file, actualBoundary) {
        assert.equal(file, '/external/expectations.json');
        assert.deepEqual(actualBoundary, boundary);
        events.push('expectations');
        return expectations;
      },
      readExternalRecoveryInput(file, actualBoundary) {
        assert.equal(file, '/external/descriptor.json');
        assert.deepEqual(actualBoundary, boundary);
        events.push('raw');
        return descriptor;
      },
      readExternalRecoveryEnvelope(file, actualBoundary) {
        assert.equal(file, '/external/envelope.json');
        assert.deepEqual(actualBoundary, boundary);
        events.push('envelope');
        return envelope;
      },
      readExternalRecoveryTrustRootAuditRoot(file, actualBoundary) {
        assert.equal(file, '/external/envelope.json');
        assert.deepEqual(actualBoundary, boundary);
        events.push('audit-root');
        return '/audit';
      },
      ensureRecoveryAuthorityStateRoot(common) {
        assert.equal(common, repository.gitCommonDirectory);
        events.push('ensure');
        return stateRoot;
      },
      requireRecoveryAuthorityStateRoot(common) {
        assert.equal(common, repository.gitCommonDirectory);
        events.push('require');
        return stateRoot;
      },
      readOptionalRecoveryQuarantineMarker(common, readMarker) {
        assert.equal(common, repository.gitCommonDirectory);
        events.push('optional');
        return readMarker(stateRoot);
      },
      hasRecoveryOperationalTrustRootFence(common) {
        assert.equal(common, repository.gitCommonDirectory);
        events.push('fence');
        if (state.fenceError) throw state.fenceError;
        return state.fence;
      },
      readRecoveryQuarantineMarker: function (this: undefined, root) {
        assert.equal(this, undefined);
        assert.equal(root, stateRoot);
        events.push('marker');
        return state.marker;
      },
    },
    discoverRepository(cwd) {
      assert.equal(cwd, '/cwd');
      events.push('discover');
      return repository;
    },
    bootstrapInterventionUsage: () => 'fixture usage',
    verifyRecoveryAuthorityDescriptor(value, expected) {
      assert.equal(value, descriptor);
      assert.equal(expected, expectations);
      events.push('verify');
      if (state.verifyError) throw state.verifyError;
      return descriptor;
    },
    importRecoveryAuthorityDescriptor(file, root, expected, actualBoundary) {
      assert.equal(file, '/external/descriptor.json');
      assert.equal(root, stateRoot);
      assert.equal(expected, expectations);
      assert.deepEqual(actualBoundary, boundary);
      events.push('import');
      return descriptor;
    },
    readRecoveryAuthorityDescriptor(root, expected, actualBoundary) {
      assert.equal(root, stateRoot);
      assert.equal(expected, expectations);
      assert.deepEqual(actualBoundary, boundary);
      events.push('descriptor');
      return descriptor;
    },
    recoveryQuarantineDependencies(
      actualDescriptor,
      expected,
      actualEnvelope,
      root,
    ) {
      assert.equal(actualDescriptor, descriptor);
      assert.equal(expected, expectations);
      assert.equal(actualEnvelope, envelope);
      assert.equal(root, repository.repositoryRealPath);
      events.push('quarantine-deps');
      return dependencies;
    },
    recoveryOperationalTrustRootDependencies(
      actualDescriptor,
      expected,
      auditRoot,
      root,
      overrides,
    ) {
      assert.equal(actualDescriptor, descriptor);
      assert.equal(expected, expectations);
      assert.equal(auditRoot, '/audit');
      assert.equal(root, repository.repositoryRealPath);
      assert.equal(overrides, state.overrides);
      events.push('restore-deps');
      return dependencies;
    },
    executeRecoveryQuarantineEnter(root, actualEnvelope, deps) {
      assert.equal(root, stateRoot);
      assert.equal(actualEnvelope, envelope);
      assert.equal(deps, dependencies);
      events.push('enter');
      throw executed;
    },
    executeRecoveryQuarantineRelease(root, actualEnvelope, deps) {
      assert.equal(root, stateRoot);
      assert.equal(actualEnvelope, envelope);
      assert.equal(deps, dependencies);
      events.push('release');
      throw executed;
    },
    executeRecoveryOperationalTrustRootRestore(
      file,
      root,
      actualBoundary,
      deps,
    ) {
      assert.equal(file, '/external/envelope.json');
      assert.equal(root, stateRoot);
      assert.deepEqual(actualBoundary, boundary);
      assert.equal(deps, dependencies);
      events.push('restore');
      throw executed;
    },
  };
  return {
    events,
    bindings,
    repository,
    stateRoot,
    descriptor,
    expectations,
    envelope,
    marker,
    state,
    executed,
  };
}
