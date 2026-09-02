import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  assessCurrentJigwrightAdoptionFreshness,
  inspectCurrentJigwrightRepositoryStateFingerprintV1,
  inspectCurrentJigwrightAdoptionFreshness,
  runCurrentJigwrightAdoption,
  verifyCurrentJigwrightAdoptionComparisonV1,
  verifyCurrentJigwrightAdoptionReportV1,
  type CurrentJigwrightAdoptionComparisonV1,
} from '../../../scripts/run-current-jigwright-adoption.ts';

test('current-v3 source and installed facts have a recomputable tamper verifier', () => {
  const comparison = currentComparisonFixture();
  assert.equal(
    verifyCurrentJigwrightAdoptionComparisonV1(comparison).factsDigest,
    comparison.factsDigest,
  );

  const tamperCases: readonly Readonly<{
    name: string;
    mutate(value: any): void;
  }>[] = [
    {
      name: 'payload drift',
      mutate(value) {
        value.source.commands.guide.payload.guide.kind = 'tampered';
      },
    },
    {
      name: 'error drift',
      mutate(value) {
        value.source.init.repeated.payload.error.code = 'TAMPERED';
      },
    },
    {
      name: 'current facts drift',
      mutate(value) {
        value.source.manifestV3.negativeCode = 'TAMPERED';
      },
    },
    {
      name: 'PlanReview separation drift',
      mutate(value) {
        value.source.planReview.manifestDigest = 'd'.repeat(64);
      },
    },
    {
      name: 'Grant approval state-binding drift',
      mutate(value) {
        value.source.centralGrant.stateDigest = sha256('tampered-state');
      },
    },
    {
      name: 'vector drift',
      mutate(value) {
        value.bindings.vectors.fileDigest = sha256('tampered-vector');
      },
    },
    {
      name: 'routed effect drift',
      mutate(value) {
        value.source.routedEffects.requestedGrantTransitions = 1;
      },
    },
    {
      name: 'state fingerprint drift',
      mutate(value) {
        value.source.state.after.refs = sha256('tampered-refs');
      },
    },
    {
      name: 'local Git config fingerprint drift',
      mutate(value) {
        value.source.state.after.localGitConfig = sha256('tampered-config');
      },
    },
    {
      name: 'local Git config fingerprint omission',
      mutate(value) {
        delete value.source.state.after.localGitConfig;
      },
    },
    {
      name: 'ignored working-state fingerprint drift',
      mutate(value) {
        value.source.state.after.ignoredWorkingState = sha256(
          'tampered-ignored-state',
        );
      },
    },
    {
      name: 'ignored working-state fingerprint omission',
      mutate(value) {
        delete value.source.state.after.ignoredWorkingState;
      },
    },
  ];
  for (const { name, mutate } of tamperCases) {
    const tampered = structuredClone(comparison);
    mutate(tampered);
    assert.throws(
      () => verifyCurrentJigwrightAdoptionComparisonV1(tampered),
      /comparison is invalid/u,
      name,
    );
  }
});

test('the public adoption command is current-only and preserves the workspace rehearsal', () => {
  const workspaceManifest = JSON.parse(
    fs.readFileSync(path.resolve('package.json'), 'utf8'),
  ) as { scripts: Record<string, string> };

  assert.equal(
    workspaceManifest.scripts['jigwright:adopt-local'],
    'node --experimental-strip-types scripts/run-current-jigwright-adoption.ts',
  );
});

test('standalone adoption freshness reports only the exact current clean source', () => {
  const source = {
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    dirty: false,
  };
  assert.deepEqual(assessCurrentJigwrightAdoptionFreshness(source, source), {
    schemaVersion: 1,
    kind: 'jigwright-current-local-adoption-freshness.v1',
    status: 'current',
    adoption: source,
    current: source,
    reasons: [],
  });
  assert.deepEqual(
    assessCurrentJigwrightAdoptionFreshness(
      { ...source, dirty: true },
      { ...source, commit: 'c'.repeat(40), tree: 'd'.repeat(40), dirty: true },
    ),
    {
      schemaVersion: 1,
      kind: 'jigwright-current-local-adoption-freshness.v1',
      status: 'stale',
      adoption: { ...source, dirty: true },
      current: {
        ...source,
        commit: 'c'.repeat(40),
        tree: 'd'.repeat(40),
        dirty: true,
      },
      reasons: [
        'adoption-source-dirty',
        'current-source-dirty',
        'source-commit-mismatch',
        'source-tree-mismatch',
      ],
    },
  );
});

test('repository state fingerprint binds local Git config and ignored non-runtime consumer state without leaking values', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-adoption-fingerprint-'),
  );
  try {
    const runGit = (args: string[]) => {
      const result = spawnSync('git', args, {
        cwd: repositoryRoot,
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
    };
    runGit(['init', '-b', 'main']);
    runGit(['config', 'user.email', 'jigwright@example.test']);
    runGit(['config', 'user.name', 'Jigwright Adoption']);
    fs.writeFileSync(
      path.join(repositoryRoot, '.gitignore'),
      '.consumer-local/\nnode_modules/\n',
    );
    fs.writeFileSync(path.join(repositoryRoot, 'tracked.txt'), 'tracked\n');
    fs.mkdirSync(path.join(repositoryRoot, '.consumer-local'));
    fs.writeFileSync(
      path.join(repositoryRoot, '.consumer-local', 'state.txt'),
      'consumer-owned local state\n',
    );
    runGit(['add', '--', '.gitignore', 'tracked.txt']);
    runGit(['commit', '-m', 'Create fingerprint fixture']);

    const before =
      inspectCurrentJigwrightRepositoryStateFingerprintV1(repositoryRoot);
    const secretValue =
      'https://fixture-user:fixture-value@example.test/private.git';
    runGit(['config', '--local', 'adoption.test-url', secretValue]);
    const configChanged =
      inspectCurrentJigwrightRepositoryStateFingerprintV1(repositoryRoot);
    assert.notEqual(configChanged.localGitConfig, before.localGitConfig);
    assert.equal(configChanged.refs, before.refs);
    assert.equal(configChanged.tracked, before.tracked);
    assert.equal(configChanged.privateRuntime, before.privateRuntime);
    assert.equal(configChanged.ignoredWorkingState, before.ignoredWorkingState);
    assert.equal(JSON.stringify(configChanged).includes(secretValue), false);

    runGit(['config', '--local', '--unset-all', 'adoption.test-url']);
    fs.writeFileSync(
      path.join(repositoryRoot, '.consumer-local', 'state.txt'),
      'consumer-owned local state changed\n',
    );
    const ignoredChanged =
      inspectCurrentJigwrightRepositoryStateFingerprintV1(repositoryRoot);
    assert.equal(ignoredChanged.localGitConfig, before.localGitConfig);
    assert.equal(ignoredChanged.refs, before.refs);
    assert.equal(ignoredChanged.tracked, before.tracked);
    assert.equal(ignoredChanged.privateRuntime, before.privateRuntime);
    assert.notEqual(
      ignoredChanged.ignoredWorkingState,
      before.ignoredWorkingState,
    );

    fs.mkdirSync(path.join(repositoryRoot, 'node_modules'));
    fs.writeFileSync(
      path.join(repositoryRoot, 'node_modules', 'expected-install.txt'),
      'expected installation output\n',
    );
    const installOutputChanged =
      inspectCurrentJigwrightRepositoryStateFingerprintV1(repositoryRoot);
    assert.equal(
      installOutputChanged.ignoredWorkingState,
      ignoredChanged.ignoredWorkingState,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('one exact Jigwright tarball binds a synthetic local CLI and hook cutover with a read-only status', async (t) => {
  const adoptionRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-current-adoption-'),
  );
  try {
    const report = runCurrentJigwrightAdoption(process.cwd(), adoptionRoot, {
      allowDirty: true,
    });

    const persistedReportPath = path.join(adoptionRoot, 'report.json');
    assert.deepEqual(
      JSON.parse(fs.readFileSync(persistedReportPath, 'utf8')),
      report,
    );
    const expectedFreshness = inspectCurrentJigwrightAdoptionFreshness(
      process.cwd(),
      adoptionRoot,
    );
    const status = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.resolve('scripts/run-current-jigwright-adoption.ts'),
        '--status',
        adoptionRoot,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(JSON.parse(status.stdout), expectedFreshness);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(persistedReportPath, 'utf8')),
      report,
    );

    const persistedReportBytes = fs.readFileSync(persistedReportPath);
    const tamperedReport = JSON.parse(persistedReportBytes.toString('utf8'));
    tamperedReport.release.tarball = '../../outside.tgz';
    fs.writeFileSync(persistedReportPath, JSON.stringify(tamperedReport));
    assert.throws(
      () =>
        inspectCurrentJigwrightAdoptionFreshness(process.cwd(), adoptionRoot),
      /adoption report is invalid/u,
    );
    assert.deepEqual(
      fs.readFileSync(persistedReportPath),
      Buffer.from(JSON.stringify(tamperedReport)),
    );
    fs.writeFileSync(persistedReportPath, persistedReportBytes);

    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, 'jigwright-current-local-adoption-report.v1');
    assert.deepEqual(
      {
        kind: report.release.kind,
        name: report.release.name,
        version: report.release.version,
      },
      {
        kind: 'jigwright-single-package.v1',
        name: 'jigwright',
        version: '0.1.0',
      },
    );
    assert.match(report.release.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.deepEqual(report.install.publicPackageIdentities, ['jigwright']);
    assert.equal(report.install.networkPolicy, 'offline-exact-local-tarball');
    assert.equal(report.install.lifecycleScriptsDenied, true);
    assert.equal(report.install.lockfileVerified, true);
    assert.equal(report.install.lockfile.path, 'package-lock.json');
    assert.match(report.install.lockfile.digest, /^sha256:[a-f0-9]{64}$/u);
    assert.match(report.install.lockfile.integrity, /^sha512-/u);
    assert.equal(report.install.lockfile.integrityVerified, true);
    assert.deepEqual(report.install.package, {
      name: 'jigwright',
      version: '0.1.0',
      digest: report.release.digest,
    });

    assert.equal(report.bootstrap.init.kind, 'jigwright-init-result.v1');
    assert.equal(report.bootstrap.init.status, 'initialized');
    const consumerConfig = JSON.parse(
      fs.readFileSync(
        path.join(adoptionRoot, 'consumer', 'workflow', 'config.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    assert.deepEqual(consumerConfig.taskAuthorization, {
      pathRoleRegistry: 'workflow/path-roles.json',
      mandateRequiredRoles: ['control-plane'],
    });
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(adoptionRoot, 'consumer', 'workflow', 'path-roles.json'),
          'utf8',
        ),
      ),
      {
        schemaVersion: 1,
        kind: 'path-role-registry',
        roles: {
          'control-plane': ['workflow/**'],
          ordinary: ['docs/**', 'openspec/**', 'package.json'],
        },
      },
    );
    assert.equal(
      report.bootstrap.repeatedInit.errorClass,
      'JIGWRIGHT_INIT_ALREADY_CONFIGURED',
    );
    assert.equal(report.bootstrap.policyUnchanged, true);
    assert.equal(report.bootstrap.guide, 'workflow-command-guide.v1');
    assert.deepEqual(report.publicSurfaces, {
      manifestV3: true,
      planReview: true,
      centralGrant: true,
    });
    assert.deepEqual(report.currentOnly, {
      historicalRuntimeState: 'unsupported',
      dualRun: 'retired',
      rollback: 'revert-consumer-cutover-commit',
    });
    assert.deepEqual(report.operationalGates, {
      implementation: 'implementation-ready',
      realPilot: 'real-pilot-pending',
      fullGate: 'full-gate-pending',
    });
    assert.equal('parity' in report, false);
    assert.equal('downgrade' in report, false);
    assert.equal(report.consumer.clean, true);
    assert.match(report.consumer.commit, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    assert.match(report.consumer.tree, /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
    assert.deepEqual(report.consumer.history.cutover, {
      commit: report.consumer.commit,
      tree: report.consumer.tree,
    });
    assert.notEqual(
      report.consumer.history.baseline.commit,
      report.consumer.history.dependency.commit,
    );
    assert.notEqual(
      report.consumer.history.dependency.commit,
      report.consumer.history.cutover.commit,
    );
    assert.deepEqual(report.consumer.rollback.revertedCommits, [
      report.consumer.history.cutover.commit,
      report.consumer.history.dependency.commit,
    ]);
    assert.equal(
      report.consumer.rollback.tree,
      report.consumer.history.baseline.tree,
    );
    assert.equal(report.consumer.rollback.baselineTreeMatched, true);
    assert.equal(report.comparison.exact, true);
    assert.equal(
      report.comparison.bindings.releaseDigest,
      report.release.digest,
    );
    assert.deepEqual(report.comparison.bindings.source, {
      commit: report.release.source.commit,
      tree: report.release.source.tree,
    });
    assert.deepEqual(report.comparison.bindings.consumer, {
      commit: report.consumer.commit,
      tree: report.consumer.tree,
    });
    assert.deepEqual(report.comparison.source, report.comparison.installed);
    assert.equal(report.comparison.source.state.unchanged, true);
    assert.deepEqual(report.comparison.source.routedEffects, {
      scope: 'selected-current-v3-read-only-probes',
      requestedGrantTransitions: 0,
      humanGateCommands: 0,
      externalEffectCommands: 0,
      observedStateMutation: 0,
    });
    assert.equal(report.comparison.source.manifestV3.readerOutcome, 'verified');
    assert.equal(
      report.comparison.source.manifestV3.negativeOutcome,
      'blocked',
    );
    assert.deepEqual(report.comparison.source.planReview, {
      subjectSchemaVersion: 1,
      subjectDigest: report.comparison.source.planReview.subjectDigest,
      manifestDigest: report.comparison.source.manifestV3.manifestDigest,
      investigationTargetDigest:
        report.comparison.source.manifestV3.investigationTargetDigest,
      readerOutcome: 'verified',
      negativeOutcome: 'blocked',
      negativeCode: 'PLAN_REVIEW_INVALID',
    });
    assert.match(
      report.comparison.source.planReview.subjectDigest,
      /^[a-f0-9]{64}$/u,
    );
    assert.equal(report.comparison.source.centralGrant.recordState, 'pending');
    assert.deepEqual(report.comparison.source.centralGrant.approvalMethods, [
      'human-presence',
      'ssh',
    ]);
    const centralGrantVector = (
      JSON.parse(
        fs.readFileSync(
          path.resolve(
            'packages/core/conformance/workflow-conformance-v2.json',
          ),
          'utf8',
        ),
      ) as {
        domains: {
          'central-grant': Array<{
            challengeDigest: string;
            request: { stateBinding: { digest: string } };
          }>;
        };
      }
    ).domains['central-grant'][0]!;
    assert.equal(
      report.comparison.source.centralGrant.challengeDigest,
      centralGrantVector.challengeDigest,
    );
    assert.equal(
      report.comparison.source.centralGrant.stateDigest,
      centralGrantVector.request.stateBinding.digest,
    );
    assert.match(
      report.comparison.source.centralGrant.approvalSubjectDigest,
      /^sha256:[a-f0-9]{64}$/u,
    );
    assert.equal(
      report.comparison.source.centralGrant.negativeOutcome,
      'blocked',
    );
    assert.equal(
      report.comparison.source.centralGrant.negativeCode,
      'GRANT_APPROVAL_SUBJECT_INVALID',
    );
    assert.deepEqual(
      {
        kind: report.consumer.localCutover.kind,
        environment: report.consumer.localCutover.environment,
        realPilot: report.consumer.localCutover.realPilot,
        notEvaluated: report.consumer.localCutover.notEvaluated,
      },
      {
        kind: 'jigwright-synthetic-local-cutover.v1',
        environment: 'synthetic-local',
        realPilot: false,
        notEvaluated: [
          'managed-lifecycle',
          'grant-transitions',
          'human-gates',
          'expense-app-consumer',
          'publication',
          'full-gate',
        ],
      },
    );
    assert.deepEqual(report.consumer.localCutover.rootWorkflow, {
      script: 'jigwright',
      invocation: 'npm run --silent workflow --',
      packageName: 'jigwright',
      packageExecutable: 'node_modules/jigwright/bin/jigwright.mjs',
      packageExecutableDigest:
        report.consumer.localCutover.rootWorkflow.binDigest,
      bin: 'node_modules/.bin/jigwright',
      binTarget: '../jigwright/bin/jigwright.mjs',
      binDigest: report.consumer.localCutover.rootWorkflow.binDigest,
      lockfileDigest: report.install.lockfile.digest,
      lockfileIntegrity: report.install.lockfile.integrity,
      guide: report.comparison.installed.commands.guide,
    });
    assert.deepEqual(report.consumer.localCutover.hooks.state, {
      before: report.consumer.localCutover.hooks.state.after,
      after: report.consumer.localCutover.hooks.state.after,
      unchanged: true,
    });
    assert.deepEqual(
      report.consumer.localCutover.hooks.observations.preCommit.payload.result,
      { hook: 'pre-commit', changes: [], documents: [] },
    );
    assert.equal(
      commandErrorCode(
        report.consumer.localCutover.hooks.observations.malformedCommitMessage
          .payload,
      ),
      'COMMIT_MESSAGE_INVALID',
    );
    assert.equal(
      commandErrorCode(
        report.consumer.localCutover.hooks.observations
          .prePushWithoutTransaction.payload,
      ),
      'PUBLISH_TRANSACTION_REQUIRED',
    );
    assert.deepEqual(
      report.consumer.localCutover.hooks.observations.postMerge.payload.result,
      { hook: 'post-merge', changes: [], documents: [] },
    );

    const consumerRoot = path.join(adoptionRoot, 'consumer');
    const consumerManifest = JSON.parse(
      fs.readFileSync(path.join(consumerRoot, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    assert.deepEqual(consumerManifest.scripts, { workflow: 'jigwright' });
    assert.equal(
      fs.realpathSync(
        path.join(consumerRoot, report.consumer.localCutover.rootWorkflow.bin),
      ),
      fs.realpathSync(
        path.join(
          consumerRoot,
          report.consumer.localCutover.rootWorkflow.packageExecutable,
        ),
      ),
    );
    for (const proxy of report.consumer.localCutover.hooks.proxies) {
      const proxyPath = path.join(consumerRoot, proxy.path);
      assert.equal(fs.readFileSync(proxyPath, 'utf8'), proxy.content);
      assert.notEqual(fs.statSync(proxyPath).mode & 0o111, 0);
    }

    await t.test(
      'persisted adoption rejects repository-local Git config drift without exposing config values',
      () => {
        const secretValue =
          'https://fixture-user:fixture-value@example.test/private.git';
        const reportBytes = fs.readFileSync(persistedReportPath);
        try {
          const configured = spawnSync(
            'git',
            ['config', '--local', 'adoption.test-url', secretValue],
            { cwd: consumerRoot, encoding: 'utf8' },
          );
          assert.equal(configured.status, 0, configured.stderr);
          assert.throws(
            () =>
              inspectCurrentJigwrightAdoptionFreshness(
                process.cwd(),
                adoptionRoot,
              ),
            /state fingerprint is invalid/u,
          );
          assert.deepEqual(fs.readFileSync(persistedReportPath), reportBytes);
          assert.equal(reportBytes.includes(secretValue), false);
        } finally {
          spawnSync(
            'git',
            ['config', '--local', '--unset-all', 'adoption.test-url'],
            { cwd: consumerRoot, encoding: 'utf8' },
          );
        }
      },
    );

    await t.test(
      'persisted adoption rejects ignored non-runtime consumer file content drift',
      () => {
        const ignoredRoot = path.join(consumerRoot, '.consumer-local');
        const ignoredPath = path.join(ignoredRoot, 'state.txt');
        const originalBytes = fs.readFileSync(ignoredPath);
        const reportBytes = fs.readFileSync(persistedReportPath);
        try {
          fs.writeFileSync(ignoredPath, 'consumer-owned local state changed\n');
          assert.throws(
            () =>
              inspectCurrentJigwrightAdoptionFreshness(
                process.cwd(),
                adoptionRoot,
              ),
            /state fingerprint is invalid/u,
          );
          assert.deepEqual(fs.readFileSync(persistedReportPath), reportBytes);
        } finally {
          fs.writeFileSync(ignoredPath, originalBytes);
        }
      },
    );

    await t.test(
      'persisted adoption rejects unstaged tracked byte drift without changing injected bytes or report',
      () => {
        const trackedPath = path.join(consumerRoot, 'docs', 'adoption.md');
        const originalBytes = fs.readFileSync(trackedPath);
        const injectedBytes = Buffer.from('# Injected tracked drift\n');
        const reportBytes = fs.readFileSync(persistedReportPath);
        try {
          fs.writeFileSync(trackedPath, injectedBytes);
          assert.throws(
            () =>
              inspectCurrentJigwrightAdoptionFreshness(
                process.cwd(),
                adoptionRoot,
              ),
            /Current Jigwright consumer history is invalid\./u,
          );
          assert.deepEqual(fs.readFileSync(trackedPath), injectedBytes);
          assert.deepEqual(fs.readFileSync(persistedReportPath), reportBytes);
        } finally {
          fs.writeFileSync(trackedPath, originalBytes);
        }
        assert.deepEqual(
          inspectCurrentJigwrightAdoptionFreshness(process.cwd(), adoptionRoot),
          expectedFreshness,
        );
      },
    );

    const falsePilot = structuredClone(report) as any;
    falsePilot.consumer.localCutover.realPilot = true;
    assert.throws(
      () => verifyCurrentJigwrightAdoptionReportV1(falsePilot, report.release),
      /adoption report is invalid/u,
    );
  } finally {
    fs.rmSync(adoptionRoot, { recursive: true, force: true });
  }
});

function commandErrorCode(payload: Record<string, unknown>): unknown {
  const error = payload.error;
  return error !== null && typeof error === 'object' && !Array.isArray(error)
    ? (error as Record<string, unknown>).code
    : undefined;
}

function currentComparisonFixture(): CurrentJigwrightAdoptionComparisonV1 {
  const command = (
    payload: Record<string, unknown>,
    exitCode = 0,
    stream: 'stdout' | 'stderr' = 'stdout',
  ) => ({ exitCode, stream, payload, payloadDigest: digestJson(payload) });
  const state = {
    refs: sha256('refs'),
    tracked: sha256('tracked'),
    localGitConfig: sha256('local-git-config'),
    ignoredWorkingState: sha256('ignored-working-state'),
    privateRuntime: sha256('private-runtime'),
  };
  const facts = {
    init: {
      fresh: command({
        ok: true,
        result: {
          kind: 'jigwright-init-result.v1',
          status: 'initialized',
          path: 'workflow/jigwright-profile.json',
          digest: sha256('profile'),
        },
      }),
      repeated: command(
        {
          ok: false,
          error: {
            code: 'JIGWRIGHT_INIT_ALREADY_CONFIGURED',
            message: 'Jigwright init never rewrites policy.',
          },
        },
        12,
        'stderr',
      ),
      profileDigest: sha256('profile'),
    },
    commands: {
      guide: command({
        command: 'guide',
        ok: true,
        guide: { kind: 'workflow-command-guide.v1' },
      }),
      doctor: command({ command: 'doctor', ok: true }),
      status: command({ command: 'status', ok: true, sessions: [] }),
      jobList: command({
        command: 'job',
        action: 'list',
        ok: true,
        jobs: [],
      }),
    },
    manifestV3: {
      schemaVersion: 3,
      kind: 'manifest-first-investigation',
      writerOutcome: 'sealed',
      readerOutcome: 'verified',
      manifestDigest: 'a'.repeat(64),
      investigationTargetDigest: 'b'.repeat(64),
      negativeOutcome: 'blocked',
      negativeCode: 'RECONSTRUCTION_MISMATCH',
    },
    planReview: {
      subjectSchemaVersion: 1,
      subjectDigest: 'c'.repeat(64),
      manifestDigest: 'a'.repeat(64),
      investigationTargetDigest: 'b'.repeat(64),
      readerOutcome: 'verified',
      negativeOutcome: 'blocked',
      negativeCode: 'PLAN_REVIEW_INVALID',
    },
    centralGrant: {
      policySchemaVersion: 2,
      policyDigest: sha256('policy'),
      recordKind: 'grant-record.v1',
      recordState: 'pending',
      challengeDigest: sha256('challenge'),
      stateDigest: sha256('state'),
      approvalMethods: ['human-presence', 'ssh'],
      approvalSubjectDigest: sha256('approval-subject'),
      recordDigest: sha256('record'),
      publicReadKind: 'grant-record.v1',
      negativeOutcome: 'blocked',
      negativeCode: 'GRANT_APPROVAL_SUBJECT_INVALID',
    },
    state: { before: state, after: state, unchanged: true },
    routedEffects: {
      scope: 'selected-current-v3-read-only-probes',
      requestedGrantTransitions: 0,
      humanGateCommands: 0,
      externalEffectCommands: 0,
      observedStateMutation: 0,
    },
  } as const;
  const bindings = {
    releaseDigest: sha256('release'),
    source: { commit: '1'.repeat(40), tree: '2'.repeat(40) },
    consumer: { commit: '3'.repeat(40), tree: '4'.repeat(40) },
    vectors: {
      path: 'facts/workflow-conformance-v2.json',
      fileDigest: sha256('vectors'),
      vectorSetDigest: sha256('vector-set'),
    },
  } as const;
  return {
    schemaVersion: 1,
    kind: 'jigwright-current-v3-source-installed-comparison.v1',
    bindings,
    source: facts,
    installed: facts,
    factsDigest: digestJson({ bindings, source: facts, installed: facts }),
    exact: true,
  };
}

function digestJson(value: unknown): `sha256:${string}` {
  return sha256(canonicalJson(value));
}

function sha256(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  throw new Error('non-JSON fixture');
}
