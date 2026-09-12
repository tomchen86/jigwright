import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createCandidateHarnessEngineDigestReader,
  type CandidateEngineSelectionSources,
} from '../src/modules/authority/candidate-engine-selection.ts';
import type { GitState } from '../src/modules/repository-consumer/repository-git-state.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const repository: GitState = {
  repositoryRoot: '/repo',
  repositoryRealPath: '/real/repo',
  gitCommonDirectory: '/common/git',
  branch: 'work/change-a',
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
  statusEntries: [],
};

function fixture() {
  const events: unknown[] = [];
  const facts: {
    local: ReturnType<
      CandidateEngineSelectionSources['resolveLocalEngineSelection']
    >;
    global: ReturnType<
      CandidateEngineSelectionSources['resolveControlPlaneEngineSelection']
    >;
  } = { local: null, global: null };
  const sources: CandidateEngineSelectionSources = {
    bootstrapInterventionStateRoot(common) {
      events.push(['state-root', common]);
      return '/state';
    },
    resolveLocalEngineSelection(root, identity) {
      events.push(['local', root, identity]);
      return facts.local;
    },
    resolveControlPlaneEngineSelection(root, repositoryId) {
      events.push(['global', root, repositoryId]);
      return facts.global;
    },
    BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST: `sha256:${'c'.repeat(64)}`,
  };
  return { events, facts, sources };
}

test('candidate engine admission has a complete pure value and type closure', () => {
  assertPureDependencyClosure(
    fileURLToPath(
      new URL(
        '../src/modules/authority/candidate-engine-selection.ts',
        import.meta.url,
      ),
    ),
  );
});

test('construction is inert; local verified binding takes precedence over global state', () => {
  const f = fixture();
  const binding = {
    kind: 'local-engine-resume-binding.v1',
    parentChangeId: 'change-a',
    checkpointId: `sha256:${'d'.repeat(64)}`,
    engineDigest: `sha256:${'e'.repeat(64)}`,
  };
  f.facts.local = { resumeBinding: binding };
  const read = createCandidateHarnessEngineDigestReader(f.sources);
  assert.deepEqual(f.events, []);
  assert.equal(
    read(repository, 'repo-a', {
      WORKFLOW_LOCAL_ENGINE_RESUME_BINDING: JSON.stringify(binding, null, 2),
    }),
    'e'.repeat(64),
  );
  assert.deepEqual(f.events, [
    ['state-root', '/common/git'],
    [
      'local',
      '/state',
      { worktreeRoot: '/real/repo', branchRef: 'refs/heads/work/change-a' },
    ],
  ]);
});

test('missing, invalid and mismatched resume bindings stop before global or builtin fallback', () => {
  for (const raw of [
    undefined,
    '{',
    'null',
    '{}',
    JSON.stringify({ engineDigest: 'f'.repeat(64) }),
  ]) {
    const f = fixture();
    f.facts.local = { resumeBinding: { engineDigest: 'd'.repeat(64) } };
    const read = createCandidateHarnessEngineDigestReader(f.sources);
    assert.throws(
      () =>
        read(repository, 'repo-a', {
          WORKFLOW_LOCAL_ENGINE_RESUME_BINDING: raw,
        }),
      { code: 'APPLY_ATTESTATION_ENGINE_BINDING_INVALID' },
    );
    assert.equal(f.events.length, 2);
  }
});

test('each observation rereads selection: global replacement and absence are visible without reconstruction', () => {
  const f = fixture();
  const read = createCandidateHarnessEngineDigestReader(f.sources);
  assert.equal(read(repository, 'repo-a', {}), 'c'.repeat(64));
  f.facts.global = {
    activeArtifact: { closureDigest: `sha256:${'d'.repeat(64)}` },
  };
  assert.equal(read(repository, 'repo-a', {}), 'd'.repeat(64));
  f.facts.global = { activeArtifact: { closureDigest: 'e'.repeat(64) } };
  assert.equal(read(repository, 'repo-a', {}), 'e'.repeat(64));
  f.facts.global = null;
  assert.equal(read(repository, 'repo-a', {}), 'c'.repeat(64));
  assert.deepEqual(
    f.events.filter((e) => (e as unknown[])[0] === 'global'),
    Array.from({ length: 4 }, () => ['global', '/state', 'repo-a']),
  );
});

test('local adoption after construction is observed, and a detached worktree retains its null branch identity', () => {
  const f = fixture();
  const read = createCandidateHarnessEngineDigestReader(f.sources);
  assert.equal(read(repository, 'repo-a', {}), 'c'.repeat(64));
  f.events.length = 0;
  const binding = { engineDigest: 'f'.repeat(64) };
  f.facts.local = { resumeBinding: binding };
  assert.equal(
    read({ ...repository, branch: null }, 'repo-a', {
      WORKFLOW_LOCAL_ENGINE_RESUME_BINDING: JSON.stringify(binding),
    }),
    'f'.repeat(64),
  );
  assert.deepEqual(f.events, [
    ['state-root', '/common/git'],
    ['local', '/state', { worktreeRoot: '/real/repo', branchRef: null }],
  ]);
});

test('state-root and verification failures propagate without fallback', () => {
  for (const failing of [
    'bootstrapInterventionStateRoot',
    'resolveLocalEngineSelection',
    'resolveControlPlaneEngineSelection',
  ] as const) {
    const f = fixture();
    const failure = new Error(failing);
    f.sources[failing] = () => {
      throw failure;
    };
    const read = createCandidateHarnessEngineDigestReader(f.sources);
    assert.throws(
      () => read(repository, 'repo-a', {}),
      (error) => error === failure,
    );
    assert.equal(
      f.events.length,
      [
        'bootstrapInterventionStateRoot',
        'resolveLocalEngineSelection',
        'resolveControlPlaneEngineSelection',
      ].indexOf(failing),
    );
  }
});

test('invalid selected digest is rejected for local, global and builtin sources', () => {
  for (const selected of ['local', 'global', 'builtin'] as const) {
    const f = fixture();
    const environment: NodeJS.ProcessEnv = {};
    if (selected === 'local') {
      const binding = { engineDigest: 'sha256:invalid' };
      f.facts.local = { resumeBinding: binding };
      environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING =
        JSON.stringify(binding);
    } else if (selected === 'global') {
      f.facts.global = { activeArtifact: { closureDigest: 'sha256:invalid' } };
    } else {
      f.sources.BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST = 'sha256:invalid';
    }
    const read = createCandidateHarnessEngineDigestReader(f.sources);
    assert.throws(() => read(repository, 'repo-a', environment), {
      code: 'APPLY_ATTESTATION_ENGINE_BINDING_INVALID',
    });
  }
});
