import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { canonicalJson } from '@jigwright/core/canonical-json';
import { evaluatePlanningProvider } from '@jigwright/core/planning-provider-port';
import type { RepositoryConsumerConfigurationV1 } from '@jigwright/core/repository-consumer-port';
import {
  createExactLocalPackageInvocation,
  runExactLocalPackageInvocation,
} from '../../fixture-adapter/src/exact-local-package-invocation.ts';
import { readFixtureManagedTransitionLog } from '../../fixture-adapter/src/fixture-managed-transition-reader.ts';
import {
  createPortabilityFixturePlanningProviderV1,
  loadPortabilityFixtureProfile,
} from '../../fixture-adapter/src/portability-profile.ts';
import { createFixtureRepositoryConsumerPortV1 } from '../../fixture-adapter/src/repository-consumer.ts';
import { createFakeArchivePullRequestRemote } from '@jigwright/github-adapter';
import {
  prepareCurrentJigwrightV1ReleaseCandidate,
  type CurrentJigwrightV1ReleaseCandidate,
} from '../../../scripts/prepare-current-jigwright-v1-release.ts';
import {
  discoverArchivePullRequestCandidate,
  openArchivePullRequest,
} from '../src/application/archive/archive-pr-orchestration.ts';
import {
  loadRepositoryConsumerConfiguration,
  repositoryConsumerPath,
} from '../src/modules/repository-consumer/repository-consumer-config.ts';
import { assertDisposableDatabaseForRepository } from '../src/adapters/consumer/repository/work-registry/database-policy.ts';
import { readChangeSchemaName } from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import { createOpenSpecPlanningProviderPort } from '../src/adapters/planning/openspec/documents/openspec-planning-provider.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/modules/assurance/task-diff-review.ts';
import type { TaskDiffReviewSubmission } from '../src/modules/assurance/task-diff-review-artifact.ts';
import type {
  IntegrationDeltaReviewRequest,
  IntegrationDeltaReviewSubmission,
} from '../src/modules/assurance/pre-merge-assurance.ts';
import {
  createWorkItem,
  workItemDigest,
  type WorkItemV1,
} from '../src/modules/governance-intake/work-registry.ts';
import {
  agentRolePlanV2Digest,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  createCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import { agentRolePlanV2Path } from '../src/modules/source/planning-role-policy-paths.ts';
import {
  createFixtureRepository,
  git,
  installFakeOpenSpec,
  prepareCurrentV3IntroductionFixture,
  writeReadyV3ExemptChange,
} from './fixture.ts';

const sourcePackageRoot = path.resolve(import.meta.dirname, '..');
let cliPackageRoot = sourcePackageRoot;
let cliEntrypoint = 'src/cli.ts';
const scenarioReportPath = path.resolve(
  import.meta.dirname,
  '../../fixture-adapter/portability-mvp-scenarios.json',
);

type PortabilityScenarioReport = Readonly<{
  schemaVersion: 4;
  kind: 'jigwright-portability-mvp-scenarios';
  localLifecycleRuns: 2;
  covered: readonly string[];
  realTarball: readonly string[];
  installedCliSeededCurrentV3: readonly string[];
  seamBacked: readonly string[];
  gate6Contracts: readonly string[];
  targetedEvidence: readonly string[];
  status: readonly string[];
  deferred: readonly Readonly<{ scenario: string; reason: string }>[];
}>;

test('a neutral consumer selects schema, documents, work registry, and database policy without expense fallback', () => {
  const repository = createConsumerRepository('orbit-consumer');
  try {
    const fixturePort = createFixtureRepositoryConsumerPortV1(repository, {
      repositoryName: 'orbit-consumer',
      planningSchema: 'orbit-spec-v1',
      documentAdapter: 'fixture-documents-v1',
    });
    assert.equal(
      fixturePort.load(repository).planning.currentSchemaName,
      'orbit-spec-v1',
    );
    assert.equal(
      fixturePort.load(repository).documents.adapterId,
      'fixture-documents-v1',
    );

    const config = orbitConsumerConfiguration();
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      config,
    );

    const metadataPath = path.join(repository, 'plans/demo/.openspec.yaml');
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(
      metadataPath,
      'schema: orbit-spec-v1\ncreated: 2026-08-24\n',
    );
    fs.mkdirSync(path.join(repository, 'openspec/schemas/expense-app'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repository, 'openspec/schemas/expense-app/schema.yaml'),
      'poisoned: true\n',
    );

    const loaded = loadRepositoryConsumerConfiguration(repository);
    assert.equal(loaded.source, 'tracked');
    assert.deepEqual(loaded.configuration, config);
    assert.equal(
      readChangeSchemaName(repository, metadataPath),
      'orbit-spec-v1',
    );
    const created = createWorkItem(
      repository,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'now',
        title: 'Orbit fixture item',
        summary: 'Use the configured Work Registry root.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T00:00:00.000Z',
        createId: () => 'WORK-01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
    );
    assert.equal(
      created.relativePath,
      'state/work/items/2026/WORK-01ARZ3NDEKTSV4RRFFQ69G5FAV.yaml',
    );
    assert.equal(
      fs.existsSync(path.join(repository, created.relativePath)),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(repository, 'docs/work-registry/items')),
      false,
    );
    assert.throws(
      () => assertDisposableDatabaseForRepository(repository, {}),
      hasWorkflowCode('DESTRUCTIVE_DATABASE_POLICY_UNAVAILABLE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the tracked Jigwright package configuration is explicit', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const loaded = loadRepositoryConsumerConfiguration(repositoryRoot);
  assert.equal(loaded.source, 'tracked');
  assert.equal(loaded.configuration.consumerId, 'jigwright');
  assert.equal(loaded.configuration.planning.currentSchemaName, 'jigwright');
  assert.deepEqual(loaded.configuration.planning.managedSchemaNames, [
    'jigwright',
  ]);
  assert.equal(loaded.configuration.databasePolicy.adapterId, 'disabled-v1');
});

test('repository consumer documents accept only adapterId and handoffPath', () => {
  const repository = createConsumerRepository('orbit-consumer');
  try {
    const configuration = orbitConsumerConfiguration();
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      configuration,
    );

    const loaded = loadRepositoryConsumerConfiguration(repository);
    assert.deepEqual(Object.keys(loaded.configuration.documents).sort(), [
      'adapterId',
      'handoffPath',
    ]);
    assert.deepEqual(
      loaded.configuration.workRegistry,
      configuration.workRegistry,
    );

    for (const [legacyKey, legacyPath] of [
      ['issueLogPath', 'notebook/issue-index.md'],
      ['issueSourcePath', 'notebook/issues.json'],
    ] as const) {
      writeJson(path.join(repository, 'workflow/repository-consumer.json'), {
        ...configuration,
        documents: {
          ...configuration.documents,
          [legacyKey]: legacyPath,
        },
      });
      assert.throws(
        () => loadRepositoryConsumerConfiguration(repository),
        hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
      );
    }

    writeJson(path.join(repository, 'workflow/repository-consumer.json'), {
      ...configuration,
      documents: {
        ...configuration.documents,
        handoffPath: configuration.workRegistry.backlogPath,
      },
    });
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('expense-app repositories fail closed without tracked consumer configuration', () => {
  const repository = createConsumerRepository('expense-app');
  try {
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('neutral repositories fail closed on missing, unknown, and escaping configuration', () => {
  const repository = createConsumerRepository('orbit-consumer');
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-consumer-config-outside-'),
  );
  try {
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_MISSING'),
    );

    const unknown =
      orbitConsumerConfiguration() as MutableConsumerConfiguration;
    unknown.documents.adapterId = 'expense-autodetect-v1';
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      unknown,
    );
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_UNSUPPORTED'),
    );

    const unknownPlanning =
      orbitConsumerConfiguration() as MutableConsumerConfiguration;
    unknownPlanning.planning.providerId = 'fixture-plan';
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      unknownPlanning,
    );
    fs.mkdirSync(path.join(repository, 'openspec/schemas/expense-app'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repository, 'openspec/schemas/expense-app/schema.yaml'),
      'poisoned: true\n',
    );
    assert.throws(
      () =>
        createOpenSpecPlanningProviderPort(
          repository,
          loadRepositoryConsumerConfiguration(repository).configuration
            .planning,
        ),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_UNSUPPORTED'),
    );

    const escaping =
      orbitConsumerConfiguration() as MutableConsumerConfiguration;
    escaping.documents.handoffPath = '../handoff.md';
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      escaping,
    );
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );

    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      orbitConsumerConfiguration(),
    );
    fs.symlinkSync(outside, path.join(repository, 'notebook'), 'dir');
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );

    fs.rmSync(path.join(repository, 'notebook'));
    fs.mkdirSync(path.join(repository, 'notebook'));
    const outsideHandoff = path.join(outside, 'handoff.md');
    fs.writeFileSync(outsideHandoff, '# Outside handoff\n');
    fs.symlinkSync(
      outsideHandoff,
      path.join(repository, 'notebook/handoff.md'),
      'file',
    );
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('consumer paths canonicalize a symlinked repository root while remaining contained', () => {
  const repository = createConsumerRepository('orbit-consumer');
  const aliasRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-consumer-alias-'),
  );
  const alias = path.join(aliasRoot, 'repository');
  try {
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      orbitConsumerConfiguration(),
    );
    fs.symlinkSync(repository, alias, 'dir');

    assert.equal(
      repositoryConsumerPath(alias, 'notebook/future/handoff.md'),
      path.join(fs.realpathSync(repository), 'notebook/future/handoff.md'),
    );
  } finally {
    fs.rmSync(aliasRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('tracked portability evidence requires two complete local lifecycles and the current Gate 6 matrix', () => {
  const scenarioReport = readPortabilityScenarioReport();
  assert.equal(scenarioReport.schemaVersion, 4);
  assert.equal(scenarioReport.localLifecycleRuns, 2);
  assert.deepEqual(scenarioReport.covered, [
    'exact-local-package-install',
    'plan-lifecycle',
    'task-lifecycle',
    'routing-blocked-focus',
    'two-worktree-third-refusal',
    'managed-intake-promotion',
    'merge-rebase-update-base',
    'archive-idempotency',
    'fake-remote-archive-pull-request',
    'immutable-commit-object-replay',
  ]);
  assert.deepEqual(scenarioReport.gate6Contracts, [
    'manifest-v3-direct-writer-and-current-validation',
    'manifest-plan-review-execution-authority-non-duplication',
    'central-grant-prepared-recovery',
    'method-agnostic-approval-outcome',
    'trusted-human-decision-only',
    'retired-local-authority-issuance-absent',
    'below-floor-no-local-r007-store',
    'dual-worktree-state-drift-refusal',
    'negative-expense-app-coupling-matrix',
  ]);
  for (const evidencePath of scenarioReport.targetedEvidence) {
    assert.equal(
      fs
        .statSync(path.resolve(sourcePackageRoot, '../..', evidencePath))
        .isFile(),
      true,
      evidencePath,
    );
  }
});

test('installed tarball drives two complete current lifecycles over unrelated seeded v3 consumers', (t) => {
  const scenarioReport = readPortabilityScenarioReport();
  const installed = installSingleJigwrightFixture();
  t.after(installed.dispose);
  const previousPackageRoot = cliPackageRoot;
  const previousEntrypoint = cliEntrypoint;
  cliPackageRoot = installed.packageRoot;
  cliEntrypoint = 'bin/jigwright.mjs';
  t.after(() => {
    cliPackageRoot = previousPackageRoot;
    cliEntrypoint = previousEntrypoint;
  });
  assert.match(
    fs.realpathSync(cliPackageRoot),
    /node_modules\/jigwright$/u,
    'the portability lifecycle must invoke an exact installed tarball',
  );
  assert.equal(
    installed.adoption.release.digest,
    installed.releaseDigest,
    'the clean-consumer adoption must use the exact installed release',
  );
  assert.deepEqual(installed.adoption.install, {
    networkPolicy: 'offline-exact-local-tarball',
    packageManager: 'npm',
    lifecycleScriptsDenied: true,
    lockfileVerified: true,
    publicPackageIdentities: ['jigwright'],
    package: {
      name: 'jigwright',
      version: installed.adoption.release.version,
      digest: installed.releaseDigest,
    },
  });
  assert.equal(installed.adoption.bootstrap.init.status, 'initialized');
  assert.deepEqual(installed.adoption.bootstrap.repeatedInit, {
    exitCode: 12,
    errorClass: 'JIGWRIGHT_INIT_ALREADY_CONFIGURED',
  });
  assert.equal(installed.adoption.bootstrap.guide, 'workflow-command-guide.v1');
  assert.deepEqual(installed.adoption.publicSurfaces, {
    manifestV3: true,
    planReview: true,
    centralGrant: true,
  });
  assert.equal(installed.adoption.consumer.clean, true);
  assert.deepEqual(scenarioReport.realTarball, [
    'strict-clean-source-release-candidate',
    'offline-exact-local-tarball-install',
    'fresh-consumer-init',
    'repeated-init-refusal',
    'installed-guide',
    'installed-public-exports',
  ]);
  assert.deepEqual(scenarioReport.installedCliSeededCurrentV3, [
    'validate-change',
    'plan-commit',
    'open-task',
    'check',
    'review-diff',
    'provider-worker',
    'complete-task',
    'finish',
    'commit',
    'finalize',
    'archive',
  ]);
  assert.deepEqual(scenarioReport.seamBacked, [
    'seeded-current-v3-repository',
    'source-authored-planning-evidence',
    'deterministic-host-provider-wrapper',
    'routing-blocked-focus',
    'two-worktree-third-refusal',
    'managed-intake-promotion',
    'merge-rebase-update-base',
    'fake-remote-archive-pull-request',
    'raw-git-immutable-commit-object-replay',
  ]);
  assert.deepEqual(scenarioReport.status, [
    'implementation-ready',
    'real-pilot-pending',
    'full-gate-pending',
  ]);
  assert.equal(
    scenarioReport.deferred.some(
      ({ scenario }) => scenario === 'real-protected-remote-pilot',
    ),
    true,
  );
  assert.equal(
    scenarioReport.deferred.some(({ scenario }) => scenario === 'full-gate'),
    true,
  );

  const lifecycleStrategies = [
    'preferred-finalize',
    'check-complete-finish-commit',
  ] as const;
  assert.equal(lifecycleStrategies.length, scenarioReport.localLifecycleRuns);
  const repositoryPaths: string[] = [];
  for (const lifecycleStrategy of lifecycleStrategies) {
    const providerHost = createPortableProviderHost();
    const repository = createFixtureRepository();
    repositoryPaths.push(fs.realpathSync(repository));
    try {
      const initialized = runCli(repository, ['init']) as {
        result: {
          kind: string;
          status: string;
          path: string;
          digest: string;
        };
      };
      assert.deepEqual(initialized.result, {
        schemaVersion: 1,
        kind: 'jigwright-init-result.v1',
        status: 'initialized',
        path: 'workflow/jigwright-profile.json',
        digest: initialized.result.digest,
      });
      assert.match(initialized.result.digest, /^sha256:[a-f0-9]{64}$/u);
      configurePortableConsumer(repository, lifecycleStrategy);
      assertNeutralPlanningProvider(repository);

      const help = runPortabilityPackageInvocation(
        createExactLocalPackageInvocation({
          packageRoot: cliPackageRoot,
          entrypoint: cliEntrypoint,
          args: ['help'],
          cwd: repository,
        }),
      );
      assert.match(help, /^Usage:\n/u);

      writePortableDelta(repository);
      const workSourceId = captureSource(repository, 'work-source', {
        semanticAuthor: 'maintainer',
        capturedBy: 'jigwright-portability-fixture',
        capturedAt: '2026-08-24T04:00:00.000Z',
        contextRef: 'direct-human:fixture/source-work-item',
        text: 'Promote this Source through a Work Item.\n',
        supersedes: null,
      });
      const directSourceId = captureSource(repository, 'direct-source', {
        semanticAuthor: 'maintainer',
        capturedBy: 'jigwright-portability-fixture',
        capturedAt: '2026-08-24T04:01:00.000Z',
        contextRef: 'direct-human:fixture/source-direct-change',
        text: 'Link this Source directly to the current change.\n',
        supersedes: null,
      });
      const workItemId = createFixtureWorkItem(repository, {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'now',
        title: 'Portable lifecycle fixture',
        summary: 'Exercise one exact local Jigwright lifecycle.',
        sourceRefs: [workSourceId],
      });
      reviewFixtureWorkItem(repository, workItemId);
      runCli(repository, [
        'source',
        'link-change',
        directSourceId,
        '--change',
        'demo-change',
      ]);
      promoteFixtureWorkItem(repository, workItemId, 'demo-change');
      const direct = readOrigin(repository, 'demo-change');
      assert.deepEqual(
        direct.sourceRefs,
        [directSourceId, workSourceId].sort(),
      );
      assert.deepEqual(direct.workItemRefs, [workItemId]);
      assert.equal(showFixtureWorkItem(repository, workItemId).stage, 'active');

      git(repository, ['add', '.']);
      git(repository, ['commit', '-m', 'Prepare portable provenance fixture']);
      prepareCurrentV3IntroductionFixture(repository, 'demo-change');
      writePortableAgentRolePlan(repository, 'demo-change');
      git(repository, ['branch', '-m', 'changes/demo-change']);
      writeReadyV3ExemptChange(repository);
      const validation = runCli(repository, [
        'validate-change',
        'demo-change',
      ]) as { changeId: string; tasks: unknown[]; contractDigest: string };
      assert.equal(validation.changeId, 'demo-change');
      assert.equal(
        validation.tasks.length,
        lifecycleStrategy === 'check-complete-finish-commit' ? 2 : 1,
      );
      assert.match(validation.contractDigest, /^[0-9a-f]{64}$/u);
      const plan = planCommit(repository, 'demo-change');
      git(repository, ['checkout', 'trunk']);
      git(repository, ['merge', '--ff-only', plan.commitHash]);
      git(repository, ['branch', '-d', 'changes/demo-change']);
      prepareRoutingChangePlans(repository);
      exerciseRouting(repository);
      git(repository, ['checkout', '-b', 'changes/demo-change']);
      const sessionId = openTaskSession(repository, 'demo-change');
      fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
      assert.deepEqual(
        (
          runCli(repository, ['route', 'status']) as {
            result: { result: { primaryChangeId: string | null } };
          }
        ).result.result.primaryChangeId,
        'demo-change',
      );
      let task = finalizePortableTask(
        repository,
        sessionId,
        'Complete portable fixture task',
        'src/feature.ts',
        providerHost,
        lifecycleStrategy,
      );
      const taskCommitHashes = [task.commitHash];
      git(repository, ['checkout', 'trunk']);
      git(repository, ['merge', '--ff-only', task.commitHash]);
      let taskParent = git(repository, [
        'rev-parse',
        `${task.commitHash}^`,
      ]).trim();
      runPortableCi(repository, taskParent, task.commitHash);
      syncProtectedBase(repository);

      if (lifecycleStrategy === 'check-complete-finish-commit') {
        git(repository, ['checkout', 'changes/demo-change']);
        const finalSessionId = (
          runCli(repository, ['open-task', 'demo-change', '--task', '1.2']) as {
            result: { sessionId: string };
          }
        ).result.sessionId;
        fs.writeFileSync(
          path.join(repository, 'src/final-feature.ts'),
          'export {};\n',
        );
        task = finalizePortableTask(
          repository,
          finalSessionId,
          'Complete portable fixture documentation closure',
          'src/final-feature.ts',
          providerHost,
          'preferred-finalize',
        );
        taskCommitHashes.push(task.commitHash);
        git(repository, ['checkout', 'trunk']);
        git(repository, ['merge', '--ff-only', task.commitHash]);
        taskParent = git(repository, [
          'rev-parse',
          `${task.commitHash}^`,
        ]).trim();
        runPortableCi(repository, taskParent, task.commitHash);
        syncProtectedBase(repository);
      }

      exerciseConcurrentWorktreesAndUpdateBase(repository);
      syncProtectedBase(repository);

      const remote = createFakeArchivePullRequestRemote();
      const candidate = discoverArchivePullRequestCandidate(
        repository,
        'demo-change',
      );
      const firstRequest = openArchivePullRequest(candidate, remote);
      const replayedRequest = openArchivePullRequest(candidate, remote);
      assert.deepEqual(replayedRequest, firstRequest);
      assert.equal(remote.requests().length, 1);

      git(repository, ['checkout', '-b', 'changes/archive-demo']);
      const archived = archiveChange(repository, 'demo-change');
      const replayedArchive = archiveChange(repository, 'demo-change');
      assert.equal(archived.status, 'committed');
      assert.equal(replayedArchive.status, 'already-archived');
      assert.equal(replayedArchive.commitHash, archived.commitHash);
      assert.deepEqual(
        JSON.parse(
          fs.readFileSync(
            path.join(repository, archived.archivePath, 'origin.json'),
            'utf8',
          ),
        ),
        direct,
      );

      const allCommits = git(repository, ['rev-list', '--reverse', 'HEAD'])
        .trim()
        .split(/\s+/u);
      for (const commitHash of allCommits) {
        replayImmutableCommit(repository, commitHash);
      }
      const managed = readFixtureManagedTransitionLog(
        allCommits.map((commitHash) => {
          const raw = git(repository, ['cat-file', 'commit', commitHash]);
          return {
            kind: 'jigwright.fixture-commit.v1' as const,
            fixtureCommitId: commitHash,
            message: raw.slice(raw.indexOf('\n\n') + 2).replace(/\n$/u, ''),
          };
        }),
      );
      assert.deepEqual(
        managed.map(({ trailers }) => trailers.kind),
        [
          'plan',
          'plan',
          'plan',
          'plan',
          'plan',
          'route',
          'route',
          'task',
          ...(lifecycleStrategy === 'check-complete-finish-commit'
            ? (['task'] as const)
            : []),
          'route',
          'route',
          'task',
          'task',
          'archive',
        ],
      );
      assert.equal(managed[0]!.fixtureCommitId, plan.commitHash);
      assert.deepEqual(
        managed
          .filter(
            ({ trailers }) =>
              trailers.kind === 'task' && trailers.changeId === 'demo-change',
          )
          .map(({ fixtureCommitId }) => fixtureCommitId),
        taskCommitHashes,
      );
      assert.equal(managed.at(-1)!.fixtureCommitId, archived.commitHash);
    } finally {
      providerHost.dispose();
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
  assert.equal(
    new Set(repositoryPaths).size,
    scenarioReport.localLifecycleRuns,
  );
});

function installSingleJigwrightFixture(): Readonly<{
  packageRoot: string;
  releaseDigest: `sha256:${string}`;
  adoption: CurrentJigwrightV1ReleaseCandidate['adoption'];
  dispose(): void;
}> {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-portable-install-'),
  );
  try {
    const releaseRoot = path.join(scratch, 'release-candidate');
    const candidate = prepareCurrentJigwrightV1ReleaseCandidate(
      path.resolve(import.meta.dirname, '../../..'),
      releaseRoot,
    );
    const artifact = candidate.release;
    assert.equal(artifact.name, 'jigwright');
    assert.equal(artifact.source.dirty, false);
    const consumerRoot = path.join(scratch, 'consumer');
    fs.mkdirSync(consumerRoot);
    writeJson(path.join(consumerRoot, 'package.json'), {
      name: 'jigwright-portability-installer',
      private: true,
      type: 'module',
    });
    const install = spawnSync(
      'npm',
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--package-lock=false',
        path.join(releaseRoot, 'package', artifact.tarball),
      ],
      {
        cwd: consumerRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          npm_config_cache: path.join(scratch, 'npm-cache'),
        },
      },
    );
    assert.equal(install.status, 0, install.stderr);
    const packageRoot = fs.realpathSync(
      path.join(consumerRoot, 'node_modules', 'jigwright'),
    );
    return Object.freeze({
      packageRoot,
      releaseDigest: artifact.digest,
      adoption: candidate.adoption,
      dispose() {
        fs.rmSync(scratch, { recursive: true, force: true });
      },
    });
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

function createPortableProviderHost(): PortableProviderHost {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-portable-provider-')),
  );
  try {
    const wrapperPath = path.join(directory, 'provider-wrapper.mjs');
    fs.copyFileSync(
      path.join(
        import.meta.dirname,
        'fixtures/portability-task-diff-provider-wrapper.mjs',
      ),
      wrapperPath,
    );
    fs.chmodSync(wrapperPath, 0o700);
    const submissionPath = path.join(directory, 'task-diff-submission.json');
    const executable = fs.realpathSync(process.execPath);
    const startArgs = [wrapperPath, 'start', '{request_file}', submissionPath];
    const capabilities = [
      'fresh-session',
      'plan-review',
      'survey',
      'task-diff-review',
      'task-implementation',
    ];
    const configPath = path.join(directory, 'agent-providers.toml');
    fs.writeFileSync(
      configPath,
      [
        'schema_version = 2',
        'global_ranking = ["claude-portable", "codex-portable"]',
        '',
        '[[providers]]',
        'id = "claude-portable"',
        'logical_provider_id = "claude"',
        'family = "claude"',
        `capabilities = ${JSON.stringify(capabilities)}`,
        'trust_tier = "host-wrapper"',
        'enabled = true',
        'protocol = "harness-jsonl-v2"',
        `executable = ${JSON.stringify(executable)}`,
        `start_args = ${JSON.stringify(startArgs)}`,
        'resume_args = []',
        'prompt_input = "stdin"',
        'cancel = "process-group"',
        '',
        '[[providers]]',
        'id = "codex-portable"',
        'logical_provider_id = "codex"',
        'family = "codex"',
        `capabilities = ${JSON.stringify(capabilities)}`,
        'trust_tier = "host-wrapper"',
        'enabled = true',
        'protocol = "harness-jsonl-v2"',
        `executable = ${JSON.stringify(executable)}`,
        `start_args = ${JSON.stringify(startArgs)}`,
        'resume_args = []',
        'prompt_input = "stdin"',
        'cancel = "process-group"',
        '',
        '[provider_preferences]',
        'author = ["claude-portable", "codex-portable"]',
        'builder = ["codex-portable", "claude-portable"]',
        'reviewer = ["claude-portable", "codex-portable"]',
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    fs.chmodSync(configPath, 0o600);
    return Object.freeze({
      configPath: fs.realpathSync(configPath),
      submissionPath,
      dispose() {
        fs.rmSync(directory, { recursive: true, force: true });
      },
    });
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

type ManagedCommit = Readonly<{ commitHash: string }>;
type PortableProviderHost = Readonly<{
  configPath: string;
  submissionPath: string;
  dispose(): void;
}>;
type PortableTaskLifecycleStrategy =
  'preferred-finalize' | 'check-complete-finish-commit';
type ArchiveCommit = Readonly<{
  status: 'committed' | 'already-archived';
  commitHash: string;
  archivePath: string;
}>;
type FixtureWorkItem = WorkItemV1;
type ChangeOrigin = Readonly<{
  schemaVersion: 1;
  sourceRefs: string[];
  workItemRefs: string[];
}>;
type FixtureTaskStatus = Readonly<{
  session: Readonly<{
    repositoryRoot: string;
    branch: string;
    state: string;
    commitHash: string | null;
    baseline: Readonly<{ head: string }>;
    isolation: Readonly<{
      routingRole: string;
      routingWorksetDigest: string;
    }>;
  }>;
}>;

function configurePortableConsumer(
  repository: string,
  lifecycleStrategy: PortableTaskLifecycleStrategy,
): void {
  const configPath = path.join(repository, 'workflow/config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    repositoryName: string;
    protectedBranches: string[];
    branchTemplate: string;
  };
  config.repositoryName = 'orbit-fixture';
  config.protectedBranches = ['trunk'];
  config.branchTemplate = 'changes/{changeId}';
  writeJson(configPath, config);
  const repositoryConsumerPath = path.join(
    repository,
    'workflow/repository-consumer.json',
  );
  const repositoryConsumer = JSON.parse(
    fs.readFileSync(repositoryConsumerPath, 'utf8'),
  ) as {
    consumerId: string;
    planning: { currentSchemaName: string };
  };
  repositoryConsumer.consumerId = 'orbit-fixture';
  writeJson(repositoryConsumerPath, repositoryConsumer);
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/.openspec.yaml'),
    `schema: ${repositoryConsumer.planning.currentSchemaName}\ncreated: 2026-07-15\n`,
  );
  writeJson(path.join(repository, 'workflow/maintainer-policy.json'), {
    schemaVersion: 1,
    repository: {
      id: 'github:R_orbit_fixture',
      origin: 'https://github.com/jigwright/orbit-fixture.git',
    },
    phase: 'bootstrap',
    auditTagPrefix: 'refs/tags/jigwright-grant/',
    signatureNamespace: 'workflow.maintainer-grant.v1',
    maxTtlMinutes: 30,
    maxUses: 1,
    bootstrapEligiblePaths: ['workflow/maintainer-policy.json'],
    sealedImmutablePaths: [],
    requiredChecks: ['text-check'],
    trustedSigners: [
      {
        identity: 'orbit-fixture-maintainer',
        publicKey:
          'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
        fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
      },
    ],
  });

  const manifestPath = path.join(repository, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    name: string;
  };
  manifest.name = 'orbit-fixture';
  writeJson(manifestPath, manifest);
  const checksPath = path.join(repository, 'workflow/checks.json');
  const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8')) as {
    checks: Record<string, unknown>;
  };
  checks.checks['text-check'] = checks.checks.fixture;
  delete checks.checks.fixture;
  writeJson(checksPath, checks);
  const documentPolicyPath = path.join(
    repository,
    'workflow/document-policy.json',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(documentPolicyPath, 'utf8'),
  ) as { documents: Record<string, unknown> };
  documentPolicy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
    mode: 'generated',
    enforcement:
      lifecycleStrategy === 'preferred-finalize' ? 'active' : 'planned',
    transition: 'completion',
  };
  writeJson(documentPolicyPath, documentPolicy);
  writePortableCentralRolePolicy(repository);
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  guard.tasks['1.1']!.requiredChecks = ['text-check'];
  if (lifecycleStrategy === 'check-complete-finish-commit') {
    fs.appendFileSync(
      path.join(repository, 'openspec/changes/demo-change/tasks.md'),
      '\n- [ ] 1.2 Close the portable documentation lifecycle\n',
    );
    guard.tasks['1.2'] = {
      allowedPaths: ['src/**'],
      requiredChecks: ['text-check'],
    };
  }
  writeJson(guardPath, guard);
  writeJson(path.join(repository, 'tooling/portability-profile.json'), {
    schemaVersion: 1,
    kind: 'jigwright.portability-fixture-profile.v1',
    repositoryName: 'orbit-fixture',
    protectedBase: 'trunk',
    branchTemplate: 'changes/{changeId}',
    planningSchema: 'orbit-spec-v1',
    planningRootTemplate: 'plans/{changeId}',
    documentAdapter: 'orbit-notebook-v1',
    requiredDocuments: ['architecture.md', 'brief.md', 'steps.md'],
    requiredChecks: ['text-check'],
  });
  for (const document of ['architecture.md', 'brief.md', 'steps.md']) {
    const documentPath = path.join(repository, 'plans/demo-change', document);
    fs.mkdirSync(path.dirname(documentPath), { recursive: true });
    fs.writeFileSync(documentPath, `# ${document}\n`);
  }
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Configure Orbit portability consumer']);
  git(repository, ['branch', '-m', 'main', 'trunk']);
  syncProtectedBase(repository);
}

function portableCentralRoleProviderDefault() {
  return createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: [
      {
        roles: ['author', 'reviewer'],
        sessionGroups: [['author'], ['reviewer']],
        providerRule: { kind: 'adaptive-author' },
      },
      {
        roles: ['builder'],
        sessionGroups: [['builder']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: null,
        },
      },
    ],
    globalProviderRanking: ['claude', 'codex'],
  });
}

function writePortableCentralRolePolicy(repository: string): void {
  const central = portableCentralRoleProviderDefault();
  fs.writeFileSync(
    path.join(repository, 'workflow/role-provider-default.json'),
    renderCentralRoleProviderDefault(central),
  );
}

function writePortableAgentRolePlan(
  repository: string,
  changeId: string,
): void {
  const central = portableCentralRoleProviderDefault();
  assert.equal(
    fs.readFileSync(
      path.join(repository, 'workflow/role-provider-default.json'),
      'utf8',
    ),
    renderCentralRoleProviderDefault(central),
  );
  const planBody: AgentRolePlanBodyV2 = {
    schemaVersion: 2,
    changeId,
    baseCentralConfigurationDigest: central.configurationDigest,
    roleLanes: [],
    pairwiseRequirements: [],
    customWrapperPolicy: 'allowed-non-protected',
    grantReferences: [],
  };
  const planPath = path.join(repository, agentRolePlanV2Path(changeId));
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(
    planPath,
    renderAgentRolePlanV2({
      ...planBody,
      planDigest: agentRolePlanV2Digest(planBody),
    }),
  );
}

function syncProtectedBase(repository: string): void {
  const tip = git(repository, ['rev-parse', 'trunk']).trim();
  git(repository, ['update-ref', 'refs/remotes/origin/trunk', tip]);
}

function assertNeutralPlanningProvider(repository: string): void {
  const profile = loadPortabilityFixtureProfile(repository);
  const evaluation = evaluatePlanningProvider(
    createPortabilityFixturePlanningProviderV1(repository, profile),
    {
      repositoryRoot: fs.realpathSync(repository),
      planningRoot: 'plans/demo-change',
      changeId: 'demo-change',
      contractName: 'orbit-spec-v1',
      revision: { kind: 'worktree' },
      readOnly: true,
    },
  );
  assert.equal(evaluation.change.readiness, 'ready');
  assert.equal(evaluation.change.valid, true);
  assert.match(evaluation.evaluationDigest, /^[0-9a-f]{64}$/u);
}

function captureSource(
  repository: string,
  name: string,
  input: Record<string, unknown>,
): string {
  const inputPath = `${name}.json`;
  writeJson(path.join(repository, inputPath), input);
  try {
    return (
      runCli(repository, ['source', 'capture', '--input', inputPath]) as {
        result: { sourceId: string };
      }
    ).result.sourceId;
  } finally {
    fs.rmSync(path.join(repository, inputPath), { force: true });
  }
}

function createFixtureWorkItem(
  repository: string,
  input: Record<string, unknown>,
): string {
  const inputPath = 'work-item-input.json';
  writeJson(path.join(repository, inputPath), input);
  try {
    return (
      runCli(repository, ['work-item', 'create', '--input', inputPath]) as {
        result: { workItemId: string };
      }
    ).result.workItemId;
  } finally {
    fs.rmSync(path.join(repository, inputPath), { force: true });
  }
}

function reviewFixtureWorkItem(repository: string, workItemId: string): void {
  const item = showFixtureWorkItem(repository, workItemId);
  const inputPath = 'work-item-review.json';
  writeJson(path.join(repository, inputPath), {
    action: 'accept',
    expectedDigest: workItemDigest(item),
    summary: item.interpretation.summary,
  });
  try {
    runCli(repository, [
      'work-item',
      'review',
      workItemId,
      '--input',
      inputPath,
    ]);
  } finally {
    fs.rmSync(path.join(repository, inputPath), { force: true });
  }
}

function promoteFixtureWorkItem(
  repository: string,
  workItemId: string,
  changeId: string,
): void {
  const inputPath = 'promotion-survey.json';
  writeJson(path.join(repository, inputPath), {
    schemaVersion: 1,
    symbols: [],
    emptyReason: 'The synthetic consumer introduces no shared symbol.',
  });
  try {
    runCli(repository, [
      'work-item',
      'promote-prepare',
      workItemId,
      '--change',
      changeId,
      '--input',
      inputPath,
    ]);
  } finally {
    fs.rmSync(path.join(repository, inputPath), { force: true });
  }
  const item = showFixtureWorkItem(repository, workItemId);
  const expected = `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(item))
    .digest('hex')}`;
  runCli(repository, [
    'work-item',
    'promote',
    workItemId,
    '--change',
    changeId,
    '--expected',
    expected,
  ]);
}

function showFixtureWorkItem(
  repository: string,
  workItemId: string,
): FixtureWorkItem {
  return (
    runCli(repository, ['work-item', 'show', workItemId]) as {
      result: { item: FixtureWorkItem };
    }
  ).result.item;
}

function readOrigin(repository: string, changeId: string): ChangeOrigin {
  return JSON.parse(
    fs.readFileSync(
      path.join(repository, 'openspec/changes', changeId, 'origin.json'),
      'utf8',
    ),
  ) as ChangeOrigin;
}

function planCommit(repository: string, changeId: string): ManagedCommit {
  return (
    runCli(repository, ['plan-commit', changeId]) as {
      result: ManagedCommit;
    }
  ).result;
}

function openTaskSession(repository: string, changeId: string): string {
  return (
    runCli(repository, ['open-task', changeId, '--task', '1.1']) as {
      result: { sessionId: string };
    }
  ).result.sessionId;
}

function checkTask(
  repository: string,
  sessionId: string,
): { passed: boolean; reportId: string } {
  return (
    runCli(repository, ['check', sessionId]) as {
      result: { passed: boolean; reportId: string };
    }
  ).result;
}

function taskStatus(repository: string, sessionId: string): FixtureTaskStatus {
  return runCli(repository, ['status', sessionId]) as FixtureTaskStatus;
}

function readTaskAllowedPaths(repository: string, changeId: string): string[] {
  return (
    JSON.parse(
      fs.readFileSync(
        path.join(repository, 'openspec/changes', changeId, 'guard.json'),
        'utf8',
      ),
    ) as { tasks: Record<string, { allowedPaths: string[] }> }
  ).tasks['1.1']!.allowedPaths;
}

function finalizePortableTask(
  repository: string,
  sessionId: string,
  message: string,
  implementationPath: string,
  providerHost: PortableProviderHost,
  lifecycleStrategy: PortableTaskLifecycleStrategy,
): ManagedCommit {
  const finalizeArgs = ['finalize', sessionId, '--message', message] as const;
  if (lifecycleStrategy === 'check-complete-finish-commit') {
    const checked = checkTask(repository, sessionId);
    assert.equal(checked.passed, true);
    assert.match(checked.reportId, /^[0-9a-f]{64}$/u);
    const completed = runCli(repository, ['complete-task', sessionId]) as {
      result: {
        reportId: string;
        completedTaskIds: string[];
      };
    };
    assert.match(completed.result.reportId, /^[0-9a-f]{64}$/u);
    assert.deepEqual(completed.result.completedTaskIds, ['1.1']);
    const finished = runCli(repository, ['finish', sessionId]) as {
      result: { reportId: string; tree: string };
    };
    assert.match(finished.result.reportId, /^[0-9a-f]{64}$/u);
    assert.match(finished.result.tree, /^[0-9a-f]{40,64}$/u);
    return (
      runCli(repository, ['commit', sessionId, '--message', message]) as {
        result: ManagedCommit;
      }
    ).result;
  }
  assert.throws(
    () => runCli(repository, finalizeArgs),
    hasExactLocalWorkflowCode('TASK_DIFF_REVIEW_REQUIRED'),
  );
  const started = withProviderDispatchDisabled(() =>
    runCli(repository, ['review-diff', sessionId, '--actor', 'codex']),
  ) as {
    result: {
      state: string;
      invocationId: string;
      subject: {
        subjectDigest: string;
        documentationRequirement: { required: boolean } | null;
        transitions: Array<{
          path: string;
          after: { objectId: string } | null;
        }>;
        reviewRequirement: {
          riskPaths: Array<{ path: string; role: string }>;
        };
      };
    };
  };
  assert.equal(started.result.state, 'waiting-for-provider');
  assert.equal(started.result.subject.documentationRequirement?.required, true);
  const reviewedBlobObjectId = started.result.subject.transitions.find(
    ({ path: changedPath }) => changedPath === implementationPath,
  )?.after?.objectId;
  assert.ok(reviewedBlobObjectId);
  const submission = portableTaskDiffSubmission(
    implementationPath,
    reviewedBlobObjectId,
    started.result.subject,
  );
  writePortableProviderSubmission(
    providerHost.submissionPath,
    started.result.invocationId,
    submission,
  );
  const worker = withAgentProviderConfig(providerHost.configPath, () =>
    runCli(repository, ['provider-worker', started.result.invocationId]),
  ) as {
    result: {
      state: string;
      launched: boolean;
      failure: unknown;
      completionReceipt: {
        schemaVersion: number;
        kind: string;
        terminalState: string;
        acceptanceBinding: {
          invocationId: string;
          requestDigest: string;
          executionAttemptId: string;
          bindingDigest: string;
        };
        protocolReceipt: {
          kind: string;
          protocol: string;
          sessionAction: string;
          terminal: string;
          outputSlot: string | null;
        };
        hostExecutionBinding: {
          phase: string;
          assignmentBindingDigest: string;
          assignmentBinding: {
            providerProfileId: string;
            bindingDigest: string;
          };
          probe: {
            invocationId: string;
            requestDigest: string;
            executionAttemptId: string;
            acceptanceBindingDigest: string;
            assignmentBindingDigest: string;
          };
          nativeSessionClaim: {
            invocationId: string;
            requestDigest: string;
            attemptId: string;
          };
          nativeSessionCompletionDigest: string;
        };
      };
    };
  };
  assert.equal(
    worker.result.state,
    'succeeded',
    JSON.stringify(worker.result.failure),
  );
  assert.equal(worker.result.launched, true);
  assert.deepEqual(
    {
      schemaVersion: worker.result.completionReceipt.schemaVersion,
      kind: worker.result.completionReceipt.kind,
      terminalState: worker.result.completionReceipt.terminalState,
      protocolKind: worker.result.completionReceipt.protocolReceipt.kind,
      protocol: worker.result.completionReceipt.protocolReceipt.protocol,
      sessionAction:
        worker.result.completionReceipt.protocolReceipt.sessionAction,
      terminal: worker.result.completionReceipt.protocolReceipt.terminal,
      outputSlot: worker.result.completionReceipt.protocolReceipt.outputSlot,
      acceptanceInvocationId:
        worker.result.completionReceipt.acceptanceBinding.invocationId,
      acceptanceRequestDigest:
        worker.result.completionReceipt.acceptanceBinding.requestDigest,
      acceptanceAttemptId:
        worker.result.completionReceipt.acceptanceBinding.executionAttemptId,
      hostPhase: worker.result.completionReceipt.hostExecutionBinding.phase,
      hostProfile:
        worker.result.completionReceipt.hostExecutionBinding.assignmentBinding
          .providerProfileId,
      hostAssignmentBound:
        worker.result.completionReceipt.hostExecutionBinding
          .assignmentBindingDigest ===
        worker.result.completionReceipt.hostExecutionBinding.assignmentBinding
          .bindingDigest,
      probeInvocationId:
        worker.result.completionReceipt.hostExecutionBinding.probe.invocationId,
      probeRequestDigest:
        worker.result.completionReceipt.hostExecutionBinding.probe
          .requestDigest,
      probeAttemptId:
        worker.result.completionReceipt.hostExecutionBinding.probe
          .executionAttemptId,
      probeAcceptanceBound:
        worker.result.completionReceipt.hostExecutionBinding.probe
          .acceptanceBindingDigest ===
        worker.result.completionReceipt.acceptanceBinding.bindingDigest,
      probeAssignmentBound:
        worker.result.completionReceipt.hostExecutionBinding.probe
          .assignmentBindingDigest ===
        worker.result.completionReceipt.hostExecutionBinding
          .assignmentBindingDigest,
      nativeInvocationId:
        worker.result.completionReceipt.hostExecutionBinding.nativeSessionClaim
          .invocationId,
      nativeRequestDigest:
        worker.result.completionReceipt.hostExecutionBinding.nativeSessionClaim
          .requestDigest,
      nativeAttemptId:
        worker.result.completionReceipt.hostExecutionBinding.nativeSessionClaim
          .attemptId,
      nativeCompletionBound: /^[0-9a-f]{64}$/u.test(
        worker.result.completionReceipt.hostExecutionBinding
          .nativeSessionCompletionDigest,
      ),
    },
    {
      schemaVersion: 4,
      kind: 'agent-runtime-completion-receipt',
      terminalState: 'succeeded',
      protocolKind: 'provider-wrapper-session-protocol-receipt',
      protocol: 'harness-jsonl-v2',
      sessionAction: 'start',
      terminal: 'result',
      outputSlot: 'primary',
      acceptanceInvocationId: started.result.invocationId,
      acceptanceRequestDigest:
        worker.result.completionReceipt.acceptanceBinding.requestDigest,
      acceptanceAttemptId:
        worker.result.completionReceipt.acceptanceBinding.executionAttemptId,
      hostPhase: 'native-terminal',
      hostProfile: 'claude-portable',
      hostAssignmentBound: true,
      probeInvocationId: started.result.invocationId,
      probeRequestDigest:
        worker.result.completionReceipt.acceptanceBinding.requestDigest,
      probeAttemptId:
        worker.result.completionReceipt.acceptanceBinding.executionAttemptId,
      probeAcceptanceBound: true,
      probeAssignmentBound: true,
      nativeInvocationId: started.result.invocationId,
      nativeRequestDigest:
        worker.result.completionReceipt.acceptanceBinding.requestDigest,
      nativeAttemptId:
        worker.result.completionReceipt.acceptanceBinding.executionAttemptId,
      nativeCompletionBound: true,
    },
  );
  const reviewed = runCli(repository, [
    'review-diff',
    sessionId,
    '--actor',
    'codex',
  ]) as { result: { state: string } };
  assert.equal(reviewed.result.state, 'satisfied');
  return (
    runCli(repository, finalizeArgs) as {
      result: ManagedCommit;
    }
  ).result;
}

function portableTaskDiffSubmission(
  implementationPath: string,
  blobObjectId: string,
  subject: Readonly<{
    documentationRequirement: Readonly<{ required: boolean }> | null;
    reviewRequirement: Readonly<{
      riskPaths: readonly Readonly<{ path: string; role: string }>[];
    }>;
  }>,
): TaskDiffReviewSubmission {
  return {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'repository-location',
          path: implementationPath,
          line: 1,
          blobObjectId,
          observation:
            'The exact portable candidate stays inside its reviewed task scope.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    riskPathDispositions: subject.reviewRequirement.riskPaths.map(
      ({ path: riskPath, role }) => ({
        path: riskPath,
        role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
        outcome: 'no-challenge',
      }),
    ),
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact checked portable candidate.',
    documentationAssessment: {
      decision: 'no-impact',
      notes:
        'The synthetic implementation changes no public or operator documentation contract.',
    },
  };
}

function writePortableProviderSubmission(
  submissionPath: string,
  invocationId: string,
  submission: TaskDiffReviewSubmission,
): void {
  fs.writeFileSync(
    submissionPath,
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'portability-task-diff-provider-input.v1',
      invocationId,
      submission,
    })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  fs.chmodSync(submissionPath, 0o600);
}

function withProviderDispatchDisabled<T>(operation: () => T): T {
  const previous = process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH;
  process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH = '1';
  try {
    return operation();
  } finally {
    if (previous === undefined) {
      delete process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH;
    } else {
      process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH = previous;
    }
  }
}

function withAgentProviderConfig<T>(configPath: string, operation: () => T): T {
  const previous = process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
  process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG = configPath;
  try {
    return operation();
  } finally {
    if (previous === undefined) {
      delete process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
    } else {
      process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG = previous;
    }
  }
}

function hasExactLocalWorkflowCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && error.message.includes(`\"code\":\"${code}\"`);
}

function archiveChange(repository: string, changeId: string): ArchiveCommit {
  return (
    runCli(repository, ['archive', changeId]) as {
      result: ArchiveCommit;
    }
  ).result;
}

function exerciseRouting(repository: string): void {
  applyRoutingAction(repository, 'routing-block', {
    kind: 'block',
    changeId: 'blocked-change',
    taskId: '1.1',
    reason: 'Wait for the focused unblocking change.',
    blocker: {
      kind: 'change',
      id: 'demo-change',
      resumeCondition: 'done',
    },
  });
  applyRoutingAction(repository, 'routing-focus', {
    kind: 'focus',
    changeId: 'demo-change',
  });
  const status = runCli(repository, ['route', 'status']) as {
    result: {
      result: {
        primaryChangeId: string | null;
        changes: Array<{ changeId: string; state: string }>;
      };
    };
  };
  assert.equal(status.result.result.primaryChangeId, 'demo-change');
  assert.equal(
    status.result.result.changes.find(
      ({ changeId }) => changeId === 'blocked-change',
    )?.state,
    'blocked',
  );
}

function exerciseConcurrentWorktreesAndUpdateBase(repository: string): void {
  const fixtures: ConcurrentFixture[] = [];
  try {
    applyRoutingAction(repository, 'parallel-focus', {
      kind: 'focus',
      changeId: 'parallel-one',
    });
    applyRoutingAction(repository, 'parallel-concurrent', {
      kind: 'set-concurrent',
      changeId: 'parallel-two',
    });
    for (const changeId of ['parallel-one', 'parallel-two', 'parallel-three']) {
      fixtures.push(prepareConcurrentWorktree(repository, changeId));
    }
    const [first, second, third] = fixtures as [
      ConcurrentFixture,
      ConcurrentFixture,
      ConcurrentFixture,
    ];
    const firstSessionId = openTaskSession(first.worktree, first.changeId);
    const secondSessionId = openTaskSession(second.worktree, second.changeId);
    const firstStatus = taskStatus(first.worktree, firstSessionId);
    const secondStatus = taskStatus(second.worktree, secondSessionId);
    assert.notEqual(
      firstStatus.session.repositoryRoot,
      secondStatus.session.repositoryRoot,
    );
    assert.notEqual(firstStatus.session.branch, secondStatus.session.branch);
    assert.equal(firstStatus.session.isolation.routingRole, 'primary');
    assert.equal(secondStatus.session.isolation.routingRole, 'concurrent');
    assert.equal(
      firstStatus.session.isolation.routingWorksetDigest,
      secondStatus.session.isolation.routingWorksetDigest,
    );
    assert.deepEqual(readTaskAllowedPaths(first.worktree, first.changeId), [
      'src/parallel-one/**',
    ]);
    assert.deepEqual(readTaskAllowedPaths(third.worktree, third.changeId), [
      'src/parallel-one/**',
    ]);
    assert.throws(
      () => openTaskSession(third.worktree, third.changeId),
      (error: unknown) =>
        error instanceof Error &&
        /CHANGE_ROUTING_REQUIRED/u.test(error.message),
    );

    const secondGuard = path.join(
      second.worktree,
      'openspec/changes',
      second.changeId,
      'guard.json',
    );
    const guardPreimage = fs.readFileSync(secondGuard);
    fs.appendFileSync(secondGuard, '\n');
    assert.throws(
      () => checkTask(second.worktree, secondSessionId),
      (error: unknown) =>
        error instanceof Error && /ARTIFACTS_CHANGED/u.test(error.message),
    );
    fs.writeFileSync(secondGuard, guardPreimage);

    const firstTaskPath = path.join(
      first.worktree,
      'src/parallel-one/feature.ts',
    );
    fs.mkdirSync(path.dirname(firstTaskPath), { recursive: true });
    fs.writeFileSync(
      firstTaskPath,
      'export const parallelOneFeature = true;\n',
    );
    const firstTask = (
      runCli(first.worktree, [
        'finalize',
        firstSessionId,
        '--message',
        'Complete first portable concurrent task',
      ]) as { result: ManagedCommit }
    ).result;

    const secondTaskPath = path.join(
      second.worktree,
      'src/parallel-two/feature.ts',
    );
    fs.mkdirSync(path.dirname(secondTaskPath), { recursive: true });
    fs.writeFileSync(
      secondTaskPath,
      'export const parallelTwoFeature = true;\n',
    );
    const secondTask = (
      runCli(second.worktree, [
        'finalize',
        secondSessionId,
        '--message',
        'Complete second portable concurrent task',
      ]) as { result: ManagedCommit }
    ).result;

    git(repository, ['merge', '--ff-only', firstTask.commitHash]);
    syncProtectedBase(repository);
    const ontoCommit = git(repository, ['rev-parse', 'trunk']).trim();
    const update = runCli(second.worktree, [
      'update-base',
      second.changeId,
      '--onto',
      'trunk',
    ]) as {
      result: {
        changeId: string;
        ontoCommit: string;
        oldHead: string;
        newHead: string;
        revalidated: {
          planningGenerationId: string;
          allowedPaths: string[];
        };
        assurance: {
          base: string;
          head: string;
          checkIds: string[];
        };
      };
    };
    assert.equal(update.result.changeId, second.changeId);
    assert.equal(update.result.ontoCommit, ontoCommit);
    assert.equal(update.result.oldHead, secondTask.commitHash);
    assert.notEqual(update.result.oldHead, update.result.newHead);
    assert.match(
      update.result.revalidated.planningGenerationId,
      /^[a-f0-9]{64}$/u,
    );
    assert.deepEqual(update.result.revalidated.allowedPaths, [
      'src/parallel-two/**',
    ]);
    assert.deepEqual(update.result.assurance, {
      base: ontoCommit,
      head: update.result.newHead,
      checkIds: ['text-check'],
    });
    const status = taskStatus(second.worktree, secondSessionId);
    assert.equal(status.session.state, 'committed');
    assert.equal(status.session.commitHash, secondTask.commitHash);
    assert.equal(
      git(second.worktree, ['rev-parse', 'HEAD']).trim(),
      update.result.newHead,
    );
    git(repository, ['merge', '--ff-only', update.result.newHead]);
    assert.equal(
      git(repository, ['rev-parse', 'trunk']).trim(),
      update.result.newHead,
    );
    syncProtectedBase(repository);
  } finally {
    for (const fixture of fixtures.reverse()) {
      git(repository, ['worktree', 'remove', '--force', fixture.worktree]);
      fs.rmSync(fixture.parent, { recursive: true, force: true });
    }
  }
}

function applyRoutingAction(
  repository: string,
  name: string,
  action: Record<string, unknown>,
): void {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), `jigwright-portable-${name}-`),
  );
  const intent = path.join(scratch, 'intent.json');
  const review = path.join(scratch, 'review.json');
  try {
    writeJson(intent, { schemaVersion: 1, action });
    runCli(repository, [
      'route',
      'prepare',
      '--intent',
      intent,
      '--output',
      review,
    ]);
    runCli(repository, ['route', 'apply', review]);
    syncProtectedBase(repository);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function prepareRoutingChangePlans(repository: string): void {
  const changes = [
    ['blocked-change', 'src/blocked/**'],
    ['parallel-one', 'src/parallel-one/**'],
    ['parallel-two', 'src/parallel-two/**'],
    ['parallel-three', 'src/parallel-one/**'],
  ] as const;
  syncProtectedBase(repository);

  for (const [changeId, allowedPath] of changes) {
    const planningBranch = `changes/${changeId}`;
    git(repository, ['checkout', '-b', planningBranch]);
    addChangeSkeleton(repository, changeId, allowedPath);
    writeReadyV3ExemptChange(repository, changeId);
    const plan = planCommit(repository, changeId);
    git(repository, ['checkout', 'trunk']);
    git(repository, ['merge', '--ff-only', plan.commitHash]);
    git(repository, ['branch', '-d', planningBranch]);
    syncProtectedBase(repository);
  }
}

type ConcurrentFixture = Readonly<{
  parent: string;
  worktree: string;
  changeId: string;
}>;

function prepareConcurrentWorktree(
  repository: string,
  changeId: string,
): ConcurrentFixture {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-portable-'));
  const worktree = path.join(parent, changeId);
  git(repository, [
    'worktree',
    'add',
    '--quiet',
    '-b',
    `changes/${changeId}`,
    worktree,
    'trunk',
  ]);
  installFakeOpenSpec(worktree);
  return { parent, worktree, changeId };
}

function addChangeSkeleton(
  repository: string,
  changeId: string,
  allowedPath: string,
): void {
  const source = path.join(repository, 'openspec/changes/demo-change');
  const target = path.join(repository, 'openspec/changes', changeId);
  fs.cpSync(source, target, { recursive: true });
  const guardPath = path.join(target, 'guard.json');
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    changeId: string;
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  guard.changeId = changeId;
  guard.tasks['1.1']!.allowedPaths = [allowedPath];
  if (changeId === 'parallel-one' || changeId === 'parallel-two') {
    if (guard.tasks['1.2'] === undefined) {
      fs.appendFileSync(
        path.join(target, 'tasks.md'),
        '\n- [ ] 1.2 Complete the post-refresh follow-up\n',
      );
    }
    guard.tasks['1.2'] = {
      allowedPaths: [allowedPath],
      requiredChecks: [...guard.tasks['1.1']!.requiredChecks],
    };
  }
  writeJson(guardPath, guard);
  fs.rmSync(path.join(target, 'origin.json'), { force: true });
  fs.rmSync(path.join(target, 'survey.json'), { force: true });
  addChangeProviderBinding(repository, changeId);
}

function addChangeProviderBinding(repository: string, changeId: string): void {
  const bindingPath = path.join(
    repository,
    'workflow/change-providers',
    `${changeId}.json`,
  );
  const binding = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/change-providers/demo-change.json'),
      'utf8',
    ),
  ) as { changeId: string; planningRoot: string };
  binding.changeId = changeId;
  binding.planningRoot = `openspec/changes/${changeId}`;
  writeJson(bindingPath, binding);
}

function runCli(repository: string, args: readonly string[]): unknown {
  const stdout = runPortabilityPackageInvocation(
    createExactLocalPackageInvocation({
      packageRoot: cliPackageRoot,
      entrypoint: cliEntrypoint,
      args: [...args, '--json'],
      cwd: repository,
    }),
  );
  return JSON.parse(stdout) as unknown;
}

function runPortableCi(
  repository: string,
  baseCommit: string,
  headCommit: string,
): unknown {
  let request: IntegrationDeltaReviewRequest;
  try {
    runCli(repository, ['ci', '--base', baseCommit, '--head', headCommit]);
    assert.fail('portable CI must request exact uncovered integration review');
  } catch (error) {
    request = integrationReviewRequest(error);
  }
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-portable-integration-review-'),
  );
  const inputPath = path.join(scratch, 'submission.json');
  try {
    const submission: IntegrationDeltaReviewSubmission = {
      schemaVersion: 1,
      kind: 'integration-delta-review-submission.v1',
      requiredCoverageDigest: request.requiredCoverageDigest,
      uncoveredEntryDigests: request.uncoveredEntries.map(
        ({ entryDigest }) => entryDigest,
      ),
      integrationSubjectDigest: request.integrationSubjectDigest,
      reviewer: {
        principalId: 'provider:claude',
        providerId: 'claude',
        achievedIndependence: 'provider-independent',
        degradedForm: null,
        grantUseDigest: null,
      },
      verdict: 'advisory-approve',
      challenges: [],
      residualRisk:
        'The synthetic portability review covers the exact local integration subject.',
    };
    writeJson(inputPath, submission);
    return runCli(repository, [
      'ci',
      '--base',
      baseCommit,
      '--head',
      headCommit,
      '--input',
      inputPath,
    ]);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function integrationReviewRequest(
  error: unknown,
): IntegrationDeltaReviewRequest {
  const prefix = 'Exact local package invocation failed: ';
  assert.ok(error instanceof Error && error.message.startsWith(prefix));
  const payload = JSON.parse(error.message.slice(prefix.length).trim()) as {
    ok: boolean;
    error: {
      code: string;
      details: { request: IntegrationDeltaReviewRequest };
    };
  };
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'PRE_MERGE_INTEGRATION_REVIEW_REQUIRED');
  return payload.error.details.request;
}

function runPortabilityPackageInvocation(
  invocation: ReturnType<typeof createExactLocalPackageInvocation>,
): string {
  return runExactLocalPackageInvocation(invocation, {
    timeoutMs: cliEntrypoint === 'bin/jigwright.mjs' ? 120_000 : 30_000,
  });
}

function orbitConsumerConfiguration(): RepositoryConsumerConfigurationV1 & {
  readonly workRegistry: NonNullable<
    RepositoryConsumerConfigurationV1['workRegistry']
  >;
} {
  return {
    schemaVersion: 1,
    adapterId: 'configured-repository-v1',
    consumerId: 'orbit-consumer',
    planning: {
      providerId: 'openspec',
      packageSchemaNames: [],
      requiredSchemaNames: ['orbit-spec-v1'],
      supportedSchemaNames: ['orbit-spec-v1'],
      managedSchemaNames: ['orbit-spec-v1'],
      currentSchemaName: 'orbit-spec-v1',
    },
    documents: {
      adapterId: 'filesystem-documents-v1',
      handoffPath: 'notebook/handoff.md',
    },
    workRegistry: {
      adapterId: 'filesystem-work-registry-v1',
      itemRoot: 'state/work/items',
      inventoryPath: 'state/work/inventory.json',
      backlogPath: 'notebook/backlog.md',
      historyRoot: 'notebook/history',
      sourceRoot: 'state/sources',
      transitionPolicyPath: 'state/work/policy.json',
      changeOriginRoot: 'plans',
    },
    databasePolicy: { adapterId: 'disabled-v1' },
  };
}

type MutableConsumerConfiguration = {
  -readonly [
    Key in keyof RepositoryConsumerConfigurationV1
  ]: RepositoryConsumerConfigurationV1[Key] extends Readonly<
    Record<string, unknown>
  >
    ? {
        -readonly [
          Nested in keyof RepositoryConsumerConfigurationV1[Key]
        ]: RepositoryConsumerConfigurationV1[Key][Nested];
      }
    : RepositoryConsumerConfigurationV1[Key];
};

function createConsumerRepository(repositoryName: string): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-consumer-config-'),
  );
  writeJson(path.join(repository, 'workflow/config.json'), {
    schemaVersion: 1,
    repositoryName,
    changeRoot: 'plans',
    runtimeDirectory: 'jigwright-runtime',
    protectedBranches: ['trunk'],
    branchTemplate: 'changes/{changeId}',
  });
  return repository;
}

function hasWorkflowCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: unknown }).code === expected;
}

function readPortabilityScenarioReport(): PortabilityScenarioReport {
  return JSON.parse(
    fs.readFileSync(scenarioReportPath, 'utf8'),
  ) as PortabilityScenarioReport;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writePortableDelta(repository: string): void {
  fs.writeFileSync(
    path.join(repository, 'openspec/changes/demo-change/specs/demo/spec.md'),
    [
      '# Delta',
      '',
      '## ADDED Requirements',
      '',
      '### Requirement: Portable lifecycle',
      'The fixture SHALL complete one local package lifecycle.',
      '',
      '#### Scenario: Lifecycle reaches an idempotent archive',
      '',
      '- **WHEN** a locally invoked plan and task complete',
      '- **THEN** archive and archive-PR identities remain deterministic',
      '',
    ].join('\n'),
  );
}

function replayImmutableCommit(repository: string, commitHash: string): void {
  assert.equal(
    git(repository, ['cat-file', '-t', commitHash]).trim(),
    'commit',
  );
  const raw = git(repository, ['cat-file', 'commit', commitHash]);
  const treeLine = raw.split('\n', 1)[0]!;
  assert.match(treeLine, /^tree [0-9a-f]{40}$/u);
  assert.equal(
    git(repository, ['cat-file', '-t', treeLine.slice('tree '.length)]).trim(),
    'tree',
  );
  for (const parentLine of raw
    .slice(0, raw.indexOf('\n\n'))
    .split('\n')
    .filter((line) => line.startsWith('parent '))) {
    assert.equal(
      git(repository, [
        'cat-file',
        '-t',
        parentLine.slice('parent '.length),
      ]).trim(),
      'commit',
    );
  }
}
