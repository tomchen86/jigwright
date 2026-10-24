import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '@jigwright/core/canonical-json';

import {
  ProviderDefinitionSnapshotError,
  assertProviderDefinitionSnapshot,
  createProviderDefinitionSnapshot,
} from '../src/provider-definition-snapshot.ts';
import {
  CLAUDE_EXECUTABLE_CANDIDATES,
  CODEX_EXECUTABLE_CANDIDATES,
  assertKnownBuiltInProviderDefinitionSnapshot,
  isBuiltInProviderFamily,
  listBuiltInProviderCapabilityDescriptors,
  listBuiltInProviderFamilies,
  resolveBuiltInProviderDefinitionSnapshot,
} from '../src/built-in-provider-definition.ts';

const definition = {
  definitionId: 'claude-built-in-reviewed',
  definitionRevision: 1,
  providerFamily: 'claude',
  protocol: 'claude-stream-json-v1',
  platform: 'darwin',
  executableCandidates: ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
  commandProfile: 'claude-fixed-read-only-v1',
} as const;

test('agent runtime preserves the shared immutable built-in provider family registry', () => {
  const families = listBuiltInProviderFamilies();

  assert.deepEqual(families, ['codex', 'claude']);
  assert.equal(Object.isFrozen(families), true);
  assert.strictEqual(listBuiltInProviderFamilies(), families);
  assert.equal(isBuiltInProviderFamily('codex'), true);
  assert.equal(isBuiltInProviderFamily('claude'), true);
  assert.equal(isBuiltInProviderFamily('custom/internal'), false);
});

test('agent runtime preserves the shared built-in provider capability policy', () => {
  const descriptors = listBuiltInProviderCapabilityDescriptors();
  const capabilities = [
    { purpose: 'survey', profile: 'repository-read-only' },
    { purpose: 'plan-review', profile: 'repository-read-only' },
    { purpose: 'task-implementation', profile: 'repository-read-only' },
    { purpose: 'task-diff-review', profile: 'repository-read-only' },
  ];

  assert.deepEqual(descriptors, [
    { providerFamily: 'codex', capabilities },
    { providerFamily: 'claude', capabilities },
  ]);
  assert.equal(Object.isFrozen(descriptors), true);
  assert.equal(Object.isFrozen(descriptors[0]), true);
  assert.equal(Object.isFrozen(descriptors[0]?.capabilities), true);
  assert.equal(Object.isFrozen(descriptors[0]?.capabilities[0]), true);
  assert.strictEqual(listBuiltInProviderCapabilityDescriptors(), descriptors);
});

test('provider definition snapshot is deterministic and deeply immutable', () => {
  const first = createProviderDefinitionSnapshot(definition);
  const second = createProviderDefinitionSnapshot({
    ...definition,
    executableCandidates: [...definition.executableCandidates],
  });

  assert.deepEqual(first, second);
  assert.match(first.definitionDigest, /^[0-9a-f]{64}$/u);
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.kind, 'provider-definition-snapshot');
  assert.equal(first.trustTier, 'built-in-reviewed');
  assert.equal(first.enabled, true);
  assert.equal(first.shell, false);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.executableCandidates), true);
  assert.deepEqual(assertProviderDefinitionSnapshot(first), first);
});

test('provider definition snapshot refuses unknown versions and digest tampering', () => {
  const snapshot = createProviderDefinitionSnapshot(definition);

  for (const value of [
    { ...snapshot, schemaVersion: 2 },
    { ...snapshot, protocol: 'host-controlled-protocol' },
    { ...snapshot, extraAuthority: true },
  ]) {
    assert.throws(
      () => assertProviderDefinitionSnapshot(value),
      (error: unknown) =>
        error instanceof ProviderDefinitionSnapshotError &&
        error.code === 'PROVIDER_DEFINITION_SNAPSHOT_INVALID',
    );
  }
});

test('provider definition snapshot accepts only absolute unique executable candidates', () => {
  for (const executableCandidates of [
    ['claude'],
    ['/opt/homebrew/bin/claude', '/opt/homebrew/bin/claude'],
    [],
  ]) {
    assert.throws(
      () =>
        createProviderDefinitionSnapshot({
          ...definition,
          executableCandidates,
        }),
      ProviderDefinitionSnapshotError,
    );
  }
});

test('provider definition snapshot evaluates paths using its recorded platform', () => {
  assert.throws(
    () =>
      createProviderDefinitionSnapshot({
        ...definition,
        executableCandidates: ['C:\\Program Files\\Claude\\claude.exe'],
      }),
    ProviderDefinitionSnapshotError,
  );
  assert.throws(
    () =>
      createProviderDefinitionSnapshot({
        ...definition,
        platform: 'win32',
        executableCandidates: ['/opt/homebrew/bin/claude'],
      }),
    ProviderDefinitionSnapshotError,
  );

  const windows = createProviderDefinitionSnapshot({
    ...definition,
    platform: 'win32',
    executableCandidates: ['C:\\Program Files\\Claude\\claude.exe'],
  });
  assert.equal(windows.platform, 'win32');

  const platformTampered = {
    ...createProviderDefinitionSnapshot(definition),
    platform: 'win32',
  };
  const platformTamperedPayload = { ...platformTampered };
  delete (platformTamperedPayload as { definitionDigest?: string })
    .definitionDigest;
  platformTampered.definitionDigest = crypto
    .createHash('sha256')
    .update(canonicalJson(platformTamperedPayload))
    .digest('hex');
  assert.throws(
    () => assertProviderDefinitionSnapshot(platformTampered),
    ProviderDefinitionSnapshotError,
  );
});

test('built-in provider definitions preserve the exact reviewed snapshot bytes', () => {
  const claude = resolveBuiltInProviderDefinitionSnapshot('claude', 'darwin');
  const codex = resolveBuiltInProviderDefinitionSnapshot('codex', 'darwin');

  assert.deepEqual(claude, {
    schemaVersion: 1,
    kind: 'provider-definition-snapshot',
    definitionId: 'claude-built-in-reviewed',
    definitionRevision: 1,
    providerFamily: 'claude',
    trustTier: 'built-in-reviewed',
    enabled: true,
    protocol: 'claude-stream-json-v1',
    platform: 'darwin',
    executableCandidates: ['/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
    commandProfile: 'claude-fixed-read-only-v1',
    shell: false,
    definitionDigest:
      '8f572435003d7250189498ac6f465c24058cc3c8e9a6be068f0e1960b72736e3',
  });
  assert.deepEqual(codex, {
    schemaVersion: 1,
    kind: 'provider-definition-snapshot',
    definitionId: 'codex-built-in-reviewed',
    definitionRevision: 1,
    providerFamily: 'codex',
    trustTier: 'built-in-reviewed',
    enabled: true,
    protocol: 'codex-jsonl-v1',
    platform: 'darwin',
    executableCandidates: [
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
    ],
    commandProfile: 'codex-fixed-read-only-v1',
    shell: false,
    definitionDigest:
      'f6d9dc08fa4461e48f1f1a41ab241e0fe0311f6145722a3bcc30b4b1f365db8b',
  });
  assert.deepEqual(
    claude?.executableCandidates,
    CLAUDE_EXECUTABLE_CANDIDATES.darwin,
  );
  assert.deepEqual(
    codex?.executableCandidates,
    CODEX_EXECUTABLE_CANDIDATES.darwin,
  );
  assert.equal(resolveBuiltInProviderDefinitionSnapshot('claude', 'aix'), null);
});

test('built-in admission rejects a self-consistent caller-authored definition', () => {
  const reviewed = resolveBuiltInProviderDefinitionSnapshot(
    'claude',
    'darwin',
  )!;
  const tampered = {
    ...reviewed,
    commandProfile: 'caller-authored-command-profile-v1',
  };
  const payload = { ...tampered };
  delete (payload as { definitionDigest?: string }).definitionDigest;
  tampered.definitionDigest = crypto
    .createHash('sha256')
    .update(canonicalJson(payload))
    .digest('hex');

  assert.throws(
    () => assertKnownBuiltInProviderDefinitionSnapshot(tampered),
    ProviderDefinitionSnapshotError,
  );
  assert.throws(
    () =>
      assertKnownBuiltInProviderDefinitionSnapshot(reviewed, {
        providerId: 'codex',
      }),
    ProviderDefinitionSnapshotError,
  );
  assert.deepEqual(
    assertKnownBuiltInProviderDefinitionSnapshot(reviewed, {
      providerId: 'claude',
      platform: 'darwin',
      executableCandidatePath: '/opt/homebrew/bin/claude',
    }),
    reviewed,
  );
});
