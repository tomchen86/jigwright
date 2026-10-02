import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createWorkflowDoctor,
  type WorkflowDoctorOperations,
} from '../src/application/assurance/workflow-doctor.ts';
import type { OpenSpecDiagnosticReport } from '../src/modules/planning-provider/openspec-diagnostics.ts';
import type { SystemDescriptionSnapshot } from '../src/modules/source/spec-ownership.ts';
import type { SystemDocumentIssue } from '../src/modules/source/system-documents.ts';

function observations() {
  const cwd = '/caller/subdirectory';
  const events: string[] = [];
  const projections = {
    rows: [{ status: 'unavailable', guidance: ['restore the projection'] }],
    producerDetail: { retained: true },
  };
  type Operations = WorkflowDoctorOperations<typeof projections>;
  const git: ReturnType<Operations['discoverRepository']> = {
    repositoryRoot: '/repository',
    repositoryRealPath: '/real/repository',
    gitCommonDirectory: '/git-common',
    branch: 'work/doctor',
    head: 'observed-head',
    statusEntries: [],
  };
  const config: ReturnType<Operations['loadWorkflowConfig']> = {
    changeRoot: 'openspec/changes',
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main'],
    branchTemplate: 'work/{changeId}',
  };
  const openspec: OpenSpecDiagnosticReport = {
    expectedVersion: '1.6.0',
    healthy: true,
    installation: {
      ok: true,
      packageName: '@fission-ai/openspec',
      declaredVersion: '1.6.0',
      lockfileVersion: '9.0',
      lockedVersion: '1.6.0',
      integrity: 'fixture-integrity',
      buildScriptsAllowed: false,
      installedVersion: '1.6.0',
      packageDirectory: '/repository/node_modules/@fission-ai/openspec',
      binPath: '/repository/node_modules/@fission-ai/openspec/bin/openspec.js',
    },
    runtime: { ok: true, version: '1.6.0' },
    root: {
      ok: true,
      path: '/repository',
      source: 'nearest',
      healthy: true,
      storeActive: false,
    },
    schemas: [],
    diagnostics: [],
  };
  const paths = ['spec.md', 'src/component/spec.md', 'test/fixtures/spec.md'];
  const issues: SystemDocumentIssue[] = [];
  const sessions: ReturnType<Operations['listSessions']> = [
    { state: 'active' },
    { state: 'revising' },
    { state: 'aborted' },
    { state: 'committed' },
  ];
  const snapshot: SystemDescriptionSnapshot = {
    listPaths() {
      events.push('listPaths');
      return paths;
    },
    readText() {
      assert.fail('doctor must pass the snapshot to its document observer');
    },
  };
  const operations: Operations = {
    discoverRepository(actualCwd) {
      events.push('discover');
      assert.equal(actualCwd, cwd);
      return git;
    },
    loadWorkflowConfig(root) {
      events.push('config');
      assert.equal(root, git.repositoryRoot);
      return config;
    },
    diagnoseOpenSpec(root) {
      events.push('openspec');
      assert.equal(root, git.repositoryRoot);
      return openspec;
    },
    readSystemDescriptionSnapshot(root) {
      events.push('snapshot');
      assert.equal(root, git.repositoryRoot);
      return snapshot;
    },
    inspectRepositorySystemDocuments(root, actualSnapshot, proof) {
      events.push('documents');
      assert.equal(root, git.repositoryRoot);
      assert.equal(actualSnapshot, snapshot);
      assert.equal(proof, false);
      return { report: { issues } };
    },
    existsPath(absolutePath) {
      events.push('exists');
      assert.equal(
        absolutePath,
        path.join(git.repositoryRoot, 'openspec/specs'),
      );
      return true;
    },
    inspectProjectionStatus(root) {
      events.push('projections');
      assert.equal(root, git.repositoryRoot);
      return projections;
    },
    listSessions(actualCwd) {
      events.push('sessions');
      assert.equal(actualCwd, cwd);
      return sessions;
    },
  };
  return {
    cwd,
    events,
    projections,
    git,
    config,
    openspec,
    paths,
    issues,
    sessions,
    snapshot,
    operations,
  };
}

test('doctor observes in order, passes one snapshot without proof, and retains complete producer values', () => {
  const fixture = observations();
  const diagnose = createWorkflowDoctor(fixture.operations);
  assert.deepEqual(fixture.events, []);
  const result = diagnose(fixture.cwd);

  assert.deepEqual(fixture.events, [
    'discover',
    'config',
    'openspec',
    'snapshot',
    'listPaths',
    'documents',
    'projections',
    'sessions',
  ]);
  assert.deepEqual(Object.keys(result), [
    'ok',
    'mode',
    'repository',
    'configuration',
    'openspec',
    'systemDocuments',
    'projections',
    'retainedSpectraUsed',
    'activeSessionCount',
    'warnings',
  ]);
  assert.deepEqual(result, {
    ok: true,
    mode: 'diagnostic',
    repository: {
      root: '/real/repository',
      gitCommonDirectory: '/git-common',
      branch: 'work/doctor',
      head: 'observed-head',
      clean: true,
    },
    configuration: {
      path: 'workflow/config.json',
      ...fixture.config,
    },
    openspec: fixture.openspec,
    systemDocuments: {
      configured: true,
      healthy: true,
      specCount: 2,
      diagnostics: [],
    },
    projections: fixture.projections,
    retainedSpectraUsed: false,
    activeSessionCount: 2,
    warnings: [],
  });
  assert.equal(result.openspec, fixture.openspec);
  assert.equal(result.projections, fixture.projections);
  // This access also proves the factory preserves the inferred producer type.
  assert.equal(result.projections.producerDetail.retained, true);
});

test('doctor factories are lazy and independent, and repeated calls observe fresh snapshots', () => {
  const fixture = observations();
  const other = observations();
  const snapshots: SystemDescriptionSnapshot[] = [];
  fixture.operations = {
    ...fixture.operations,
    readSystemDescriptionSnapshot() {
      const snapshot = {
        listPaths: () => ['spec.md'],
        readText: () => undefined,
      };
      snapshots.push(snapshot);
      return snapshot;
    },
    inspectRepositorySystemDocuments(_root, snapshot, proof) {
      assert.equal(snapshot, snapshots.at(-1));
      assert.equal(proof, false);
      return { report: { issues: fixture.issues } };
    },
  };
  const diagnose = createWorkflowDoctor(fixture.operations);
  const diagnoseOther = createWorkflowDoctor(other.operations);
  assert.deepEqual(snapshots, []);
  assert.deepEqual(other.events, []);
  const first = diagnose(fixture.cwd);
  fixture.issues.push({
    code: 'purpose-missing',
    path: 'spec.md',
    message: 'Missing purpose.',
  });
  const second = diagnose(fixture.cwd);
  assert.equal(snapshots.length, 2);
  assert.notEqual(snapshots[0], snapshots[1]);
  assert.equal(first.ok, true);
  assert.deepEqual(first.systemDocuments.diagnostics, []);
  assert.equal(second.ok, false);
  assert.deepEqual(other.events, []);
  assert.equal(diagnoseOther(other.cwd).ok, true);
});

test('doctor filters only missing test proof and preserves other complete issues without mutation', () => {
  const fixture = observations();
  const missingProof = {
    code: 'test-not-passed',
    path: 'test/check.test.ts',
    message: 'No proof.',
  };
  fixture.issues.push(missingProof);
  const diagnose = createWorkflowDoctor(fixture.operations);
  assert.equal(diagnose(fixture.cwd).ok, true);
  assert.deepEqual(fixture.issues, [missingProof]);
  const malformed = {
    code: 'purpose-missing',
    path: 'spec.md',
    message: 'Missing purpose.',
  };
  fixture.issues.push(malformed);
  const result = diagnose(fixture.cwd);
  assert.equal(result.ok, false);
  assert.equal(result.systemDocuments.healthy, false);
  assert.deepEqual(result.systemDocuments.diagnostics, [malformed]);
  assert.equal(result.systemDocuments.diagnostics[0], malformed);
  assert.deepEqual(fixture.issues, [missingProof, malformed]);
});

test('doctor keeps branch, dirt, base-spec and provider warnings in order without changing health', () => {
  for (const branch of [null, 'main']) {
    const fixture = observations();
    fixture.paths.length = 0;
    fixture.git.branch = branch;
    fixture.git.statusEntries.push(' M file.ts', '?? untracked.ts');
    fixture.openspec.diagnostics.push(
      {
        severity: 'warning',
        code: 'SAME_CODE',
        message: 'First warning.',
        target: 'root',
      },
      { severity: 'info', code: 'INFO', message: 'Information.' },
      {
        severity: 'error',
        code: 'SAME_CODE',
        message: 'Second warning.',
        fix: 'A repair.',
      },
    );
    fixture.operations = { ...fixture.operations, existsPath: () => false };
    const result = createWorkflowDoctor(fixture.operations)(fixture.cwd);
    assert.equal(result.ok, true);
    assert.deepEqual(result.systemDocuments, {
      configured: false,
      healthy: true,
      specCount: 0,
      diagnostics: [],
    });
    assert.equal(result.repository.clean, false);
    assert.deepEqual(result.warnings, [
      branch === null
        ? { code: 'DETACHED_HEAD', message: 'HEAD is detached.' }
        : {
            code: 'PROTECTED_BRANCH',
            message:
              'Current branch main is protected; task session activation will fail.',
          },
      {
        code: 'DIRTY_WORKTREE',
        message:
          'Worktree has 2 staged, unstaged, or untracked status entries; task session activation will fail.',
      },
      {
        code: 'NO_BASE_SPECS',
        message:
          'openspec/specs does not exist yet; create the current managed base specifications before planning changes.',
      },
      { code: 'SAME_CODE', message: 'First warning.' },
      { code: 'SAME_CODE', message: 'Second warning.' },
    ]);
    assert.equal(result.openspec.diagnostics.length, 3);
  }
});

test('doctor checks the configured base-spec path only when colocated specs are absent', () => {
  for (const [changeRoot, baseRoot] of [
    ['plans', 'specs'],
    ['openspec/changes', 'openspec/specs'],
  ]) {
    for (const present of [true, false]) {
      const fixture = observations();
      fixture.paths.splice(
        0,
        fixture.paths.length,
        'docs/spec.md',
        'test/fixtures/spec.md',
      );
      fixture.config.changeRoot = changeRoot!;
      fixture.operations = {
        ...fixture.operations,
        inspectRepositorySystemDocuments() {
          assert.fail('no colocated specs');
        },
        existsPath(absolutePath) {
          fixture.events.push('exists');
          assert.equal(absolutePath, path.join('/repository', baseRoot!));
          return present;
        },
      };
      const result = createWorkflowDoctor(fixture.operations)(fixture.cwd);
      assert.deepEqual(fixture.events, [
        'discover',
        'config',
        'openspec',
        'snapshot',
        'listPaths',
        'exists',
        'projections',
        'sessions',
      ]);
      assert.equal(
        result.warnings.some(({ code }) => code === 'NO_BASE_SPECS'),
        !present,
      );
    }
  }
  const fixture = observations();
  fixture.operations = {
    ...fixture.operations,
    existsPath() {
      assert.fail('colocated specs suppress base-spec observation');
    },
  };
  assert.equal(createWorkflowDoctor(fixture.operations)(fixture.cwd).ok, true);
});

test('doctor continues later observations for an unhealthy OpenSpec report', () => {
  const fixture = observations();
  fixture.openspec.healthy = false;
  const result = createWorkflowDoctor(fixture.operations)(fixture.cwd);
  assert.equal(result.ok, false);
  assert.equal(result.systemDocuments.healthy, true);
  assert.equal(result.openspec, fixture.openspec);
  assert.deepEqual(fixture.events.slice(-2), ['projections', 'sessions']);
});

test('doctor catches only document inspection and issue filtering, retaining String(error)', () => {
  for (const failure of [
    new Error('broken contracts'),
    'non-Error failure',
    null,
  ]) {
    for (const during of ['inspection', 'filter']) {
      const fixture = observations();
      fixture.operations = {
        ...fixture.operations,
        inspectRepositorySystemDocuments() {
          if (during === 'inspection') throw failure;
          return {
            report: {
              issues: [
                {
                  get code(): string {
                    throw failure;
                  },
                  path: 'spec.md',
                  message: 'unreadable issue',
                },
              ],
            },
          };
        },
      };
      const result = createWorkflowDoctor(fixture.operations)(fixture.cwd);
      assert.equal(result.ok, false);
      assert.deepEqual(result.systemDocuments, {
        configured: true,
        healthy: false,
        specCount: 2,
        diagnostics: [
          { code: 'SYSTEM_DOCUMENTS_INVALID', message: String(failure) },
        ],
      });
      assert.deepEqual(fixture.events.slice(-2), ['projections', 'sessions']);
    }
  }
});

test('doctor preserves error identity and stops observation outside the document catch', () => {
  const steps = [
    ['discoverRepository', []],
    ['loadWorkflowConfig', ['discover']],
    ['diagnoseOpenSpec', ['discover', 'config']],
    ['readSystemDescriptionSnapshot', ['discover', 'config', 'openspec']],
    ['existsPath', ['discover', 'config', 'openspec', 'snapshot', 'listPaths']],
    [
      'inspectProjectionStatus',
      ['discover', 'config', 'openspec', 'snapshot', 'listPaths', 'exists'],
    ],
    [
      'listSessions',
      [
        'discover',
        'config',
        'openspec',
        'snapshot',
        'listPaths',
        'exists',
        'projections',
      ],
    ],
  ] as const;
  for (const [step, before] of steps) {
    const fixture = observations();
    fixture.paths.length = 0;
    const failure = new Error(`failure in ${step}`);
    const diagnose = createWorkflowDoctor({
      ...fixture.operations,
      [step]: () => {
        throw failure;
      },
    });
    assert.throws(
      () => diagnose(fixture.cwd),
      (error) => error === failure,
    );
    assert.deepEqual(fixture.events, before, step);
  }
  const fixture = observations();
  const failure = new Error('snapshot list failure');
  const diagnose = createWorkflowDoctor({
    ...fixture.operations,
    readSystemDescriptionSnapshot: () => ({
      listPaths() {
        throw failure;
      },
      readText: () => undefined,
    }),
  });
  assert.throws(
    () => diagnose(fixture.cwd),
    (error) => error === failure,
  );
  assert.deepEqual(fixture.events, ['discover', 'config', 'openspec']);
});
