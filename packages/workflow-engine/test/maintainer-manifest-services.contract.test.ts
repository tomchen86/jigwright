import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readModuleReferences } from './support/dependency-graph.ts';
import {
  createMaintainerManifestOperations,
  type MaintainerManifestObservations,
} from '../src/modules/authority/maintainer-manifest.ts';
import { parseCapabilityProfile } from '../src/modules/authority/maintainer-manifest-contracts.ts';

const root = '/memory/repository';
const base = 'a'.repeat(40);
const file = 'packages/demo/src/implementation.ts';
const profile = parseCapabilityProfile({
  id: 'demo',
  version: 1,
  authorityClass: 'ordinary',
  implementationPaths: ['packages/demo/src/**'],
  evidencePaths: ['packages/demo/test/**'],
  policyPaths: [],
  verificationInfrastructurePaths: [],
  forbiddenPaths: ['packages/demo/src/forbidden.ts'],
  constraints: {
    evidenceOnlyGrantForbidden: true,
    samePackageRequired: true,
    evidenceAdditionsAllowed: false,
    maximumFiles: 2,
  },
  requiredChecks: ['fixture'],
  checkDependencies: { fixture: ['source-tree'] },
});
function fixture(overrides: Partial<MaintainerManifestObservations> = {}) {
  const calls: string[] = [];
  const observations: MaintainerManifestObservations = {
    readProfilesAtTrustBase(repositoryRoot, commit) {
      assert.equal(repositoryRoot, root);
      assert.equal(commit, base);
      calls.push('profiles');
      return JSON.stringify({ schemaVersion: 1, profiles: { demo: profile } });
    },
    listChangedPaths(repositoryRoot, commit) {
      assert.equal(repositoryRoot, root);
      assert.equal(commit, base);
      calls.push('changed');
      return [file];
    },
    readTrustBaseTreeEntry(repositoryRoot, commit, filePath) {
      assert.equal(repositoryRoot, root);
      assert.equal(commit, base);
      calls.push(`tree:${filePath}`);
      return `100644 blob ${'b'.repeat(40)}\t${filePath}\0`;
    },
    readWorktreeMetadata(repositoryRoot, filePath) {
      assert.equal(repositoryRoot, root);
      calls.push(`metadata:${filePath}`);
      return { regularFile: true, symbolicLink: false, mode: 0o100644 };
    },
    readWorktreeBytes(repositoryRoot, filePath) {
      assert.equal(repositoryRoot, root);
      calls.push(`bytes:${filePath}`);
      return new TextEncoder().encode('new implementation');
    },
    ...overrides,
  };
  return {
    calls,
    operations: createMaintainerManifestOperations(observations),
  };
}
const request = {
  profile,
  trustBaseCommit: base,
  policyDigest: 'c'.repeat(64),
};
function hasCode(code: string) {
  return (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code;
}

test('manifest rules use memory observations sequentially and reread pinned and worktree facts on every call', () => {
  const f = fixture();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(
    f.operations.loadCapabilityProfileFromTrustBase(root, base, 'demo'),
    profile,
  );
  const manifest = f.operations.buildMaintainerPatchManifest(root, request);
  assert.equal(
    manifest.files[0]?.afterSha256,
    crypto.createHash('sha256').update('new implementation').digest('hex'),
  );
  assert.deepEqual(f.calls, [
    'profiles',
    'changed',
    `tree:${file}`,
    `metadata:${file}`,
    `bytes:${file}`,
  ]);
  f.calls.length = 0;
  f.operations.verifyPatchManifestAgainstWorktree(root, manifest);
  f.operations.validatePatchManifestAgainstProfile(root, manifest, profile);
  f.operations.loadCapabilityProfileFromTrustBase(root, base, 'demo');
  assert.deepEqual(f.calls, [
    'changed',
    `tree:${file}`,
    `metadata:${file}`,
    `bytes:${file}`,
    `tree:${file}`,
    'profiles',
  ]);
});

test('manifest empty, size, role and trust-base guards stop before later observations', () => {
  for (const [paths, code] of [
    [[], 'MAINTAINER_PATCH_EMPTY'],
    [[file, file, file], 'MAINTAINER_PATCH_TOO_LARGE'],
    [['packages/demo/src/forbidden.ts'], 'MAINTAINER_PATH_FORBIDDEN'],
    [['unknown/file.ts'], 'MAINTAINER_PATH_UNCLASSIFIED'],
  ] as const) {
    const f = fixture({ listChangedPaths: () => [...paths] });
    assert.throws(
      () => f.operations.buildMaintainerPatchManifest(root, request),
      hasCode(code),
    );
    assert.deepEqual(f.calls, []);
  }
  const f = fixture({
    readTrustBaseTreeEntry: () => `160000 commit ${'b'.repeat(40)}\t${file}\0`,
  });
  assert.throws(
    () => f.operations.buildMaintainerPatchManifest(root, request),
    hasCode('MAINTAINER_PATH_UNSAFE'),
  );
  assert.deepEqual(f.calls, ['changed']);
});

test('manifest metadata guards precede bytes and preserve exact observation failures', () => {
  for (const metadata of [
    { regularFile: false, symbolicLink: false, mode: 0o040755 },
    { regularFile: false, symbolicLink: true, mode: 0o120777 },
    { regularFile: true, symbolicLink: false, mode: 0o100755 },
  ]) {
    const f = fixture({ readWorktreeMetadata: () => metadata });
    assert.throws(
      () => f.operations.buildMaintainerPatchManifest(root, request),
      hasCode('MAINTAINER_PATH_UNSAFE'),
    );
    assert.deepEqual(f.calls, ['changed', `tree:${file}`]);
  }
  const failure = new Error('worktree read failed');
  const f = fixture({
    readWorktreeBytes: () => {
      throw failure;
    },
  });
  assert.throws(
    () => f.operations.buildMaintainerPatchManifest(root, request),
    (error) => error === failure,
  );
  assert.deepEqual(f.calls, ['changed', `tree:${file}`, `metadata:${file}`]);
});

test('manifest verification checks changed-set and profile identity before reading file observations', () => {
  const manifest = fixture().operations.buildMaintainerPatchManifest(
    root,
    request,
  );
  const f = fixture({ listChangedPaths: () => [] });
  assert.throws(
    () => f.operations.verifyPatchManifestAgainstWorktree(root, manifest),
    hasCode('MAINTAINER_PATCH_DRIFT'),
  );
  assert.deepEqual(f.calls, []);
  assert.throws(
    () =>
      f.operations.validatePatchManifestAgainstProfile(
        root,
        { ...manifest, profileVersion: 2 },
        profile,
      ),
    hasCode('MAINTAINER_PATCH_INVALID'),
  );
  assert.deepEqual(f.calls, []);
  assert.throws(
    () =>
      f.operations.validatePatchManifestAgainstProfile(
        root,
        {
          ...manifest,
          files: [
            { ...manifest.files[0]!, role: 'evidence', afterMode: '100755' },
          ],
        },
        profile,
      ),
    hasCode('MAINTAINER_PATH_UNSAFE'),
  );
  assert.deepEqual(f.calls, []);
});

test('manifest profile loading validates all declared profiles before selection and retains its read-error contract', () => {
  const f = fixture({
    readProfilesAtTrustBase: () =>
      JSON.stringify({
        schemaVersion: 1,
        profiles: { demo: profile, other: { ...profile, id: 'mismatch' } },
      }),
  });
  assert.throws(
    () => f.operations.loadCapabilityProfileFromTrustBase(root, base, 'demo'),
    hasCode('MAINTAINER_PROFILE_INVALID'),
  );
  const failure = new Error('pinned read failed');
  const unavailable = fixture({
    readProfilesAtTrustBase: () => {
      throw failure;
    },
  });
  assert.throws(
    () =>
      unavailable.operations.loadCapabilityProfileFromTrustBase(
        root,
        base,
        'demo',
      ),
    (error) => {
      assert.ok(hasCode('MAINTAINER_PROFILE_INVALID')(error));
      assert.notEqual(error, failure);
      assert.equal(
        (error as Error).message,
        'The trust base does not contain a valid workflow/maintainer-profiles.json.',
      );
      return true;
    },
  );
});

test('manifest domain type and value closure stays in domain, foundation and core owners', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const visited = new Set<string>();
  const pending = [
    'maintainer-manifest.ts',
    'maintainer-manifest-contracts.ts',
  ].map((file) =>
    path.resolve(import.meta.dirname, '../src/modules/authority', file),
  );
  while (pending.length) {
    const source = pending.pop()!;
    if (visited.has(source)) continue;
    visited.add(source);
    const relative = path.relative(repositoryRoot, source);
    assert.ok(
      /^packages\/(?:core\/src\/|workflow-engine\/src\/(?:modules|foundation)\/)/.test(
        relative,
      ),
      relative,
    );
    for (const reference of readModuleReferences(
      source,
      fs.readFileSync(source, 'utf8'),
    )) {
      assert.notEqual(reference.specifier, null, source);
      const specifier = reference.specifier!;
      if (specifier.startsWith('node:')) {
        assert.ok(['node:crypto', 'node:path'].includes(specifier), specifier);
      } else {
        pending.push(
          specifier.startsWith('.')
            ? path.resolve(path.dirname(source), specifier)
            : createRequire(source).resolve(specifier),
        );
      }
    }
  }
});
