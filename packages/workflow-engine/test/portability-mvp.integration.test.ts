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
import { buildSingleJigwrightPackage } from '../../../scripts/build-single-jigwright-package.ts';
import {
  discoverArchivePullRequestCandidate,
  openArchivePullRequest,
} from '../src/application/archive/archive-pr-orchestration.ts';
import { readIssueData } from '../src/adapters/consumer/expense-app/documents/issues.ts';
import {
  loadRepositoryConsumerConfiguration,
  repositoryConsumerPath,
} from '../src/modules/repository-consumer/repository-consumer-config.ts';
import { assertDisposableDatabaseForRepository } from '../src/adapters/consumer/expense-app/work-registry/database-policy.ts';
import { readChangeSchemaName } from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { createOpenSpecPlanningProviderPort } from '../src/adapters/planning/openspec/documents/openspec-planning-provider.ts';
import {
  createWorkItem,
  workItemDigest,
  type WorkItemV1,
} from '../src/modules/governance-intake/work-registry.ts';
import {
  createFixtureRepository,
  git,
  installFakeOpenSpec,
  writeReadyV3ExemptChange,
} from './fixture.ts';

const sourcePackageRoot = path.resolve(import.meta.dirname, '..');
let cliPackageRoot = sourcePackageRoot;
let cliEntrypoint = 'src/cli.ts';
const scenarioReportPath = path.resolve(
  import.meta.dirname,
  '../../fixture-adapter/portability-mvp-scenarios.json',
);

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

    writeJson(path.join(repository, 'docs/issues/issues.yaml'), {
      poisonedExpenseFallback: true,
    });
    writeJson(path.join(repository, 'notebook/issues.json'), {
      schemaVersion: 1,
      lastUpdated: '2026-08-24',
      issues: [],
    });
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
    assert.deepEqual(readIssueData(repository), {
      schemaVersion: 1,
      lastUpdated: '2026-08-24',
      issues: [],
    });
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
    const outsideIssueSource = path.join(outside, 'issues.json');
    fs.writeFileSync(outsideIssueSource, '{}\n');
    fs.symlinkSync(
      outsideIssueSource,
      path.join(repository, 'notebook/issues.json'),
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

test('portable fixture completes all ten local scenarios twice', (t) => {
  const installed = installSingleJigwrightFixture();
  const previousPackageRoot = cliPackageRoot;
  const previousEntrypoint = cliEntrypoint;
  cliPackageRoot = installed.packageRoot;
  cliEntrypoint = 'bin/jigwright.mjs';
  t.after(() => {
    cliPackageRoot = previousPackageRoot;
    cliEntrypoint = previousEntrypoint;
    installed.dispose();
  });
  assert.match(
    fs.realpathSync(cliPackageRoot),
    /node_modules\/jigwright$/u,
    'the portability lifecycle must invoke an exact installed tarball',
  );
  for (let remainingRuns = 2; remainingRuns > 0; remainingRuns -= 1) {
    const repository = createFixtureRepository();
    try {
      configurePortableConsumer(repository);
      assertNeutralPlanningProvider(repository);
      const scenarioReport = JSON.parse(
        fs.readFileSync(scenarioReportPath, 'utf8'),
      ) as {
        schemaVersion: number;
        covered: string[];
        gate6Contracts: string[];
        targetedEvidence: string[];
        status: string[];
        deferred: Array<{ scenario: string; reason: string }>;
      };
      assert.equal(scenarioReport.schemaVersion, 2);
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
        'manifest-v3-direct-writer-and-validation',
        'authority-ownership-non-duplication',
        'central-grant-prepared-recovery',
        'method-agnostic-approval-outcome',
        'trusted-human-decision-only',
        'legacy-ssh-read-only',
        'below-floor-no-local-r007-store',
        'dual-worktree-state-drift-refusal',
        'negative-expense-app-coupling-matrix',
      ]);
      assert.deepEqual(scenarioReport.targetedEvidence, [
        'packages/workflow-engine/test/local-adoption.contract.test.ts',
        'packages/workflow-engine/test/portability-mvp.integration.test.ts',
        'packages/workflow-engine/test/investigation-manifest-v3.test.ts',
        'packages/workflow-engine/test/committed-investigation-manifest.contract.test.ts',
        'packages/workflow-engine/test/grant-coordinator.contract.test.ts',
        'packages/workflow-engine/test/grant-store.contract.test.ts',
        'packages/workflow-engine/test/grant-core.contract.test.ts',
        'packages/workflow-engine/test/grant-approval.contract.test.ts',
        'packages/workflow-engine/test/grant-policy.contract.test.ts',
        'packages/workflow-engine/test/human-grant-cli.contract.test.ts',
        'packages/workflow-engine/test/human-gate-macos.contract.test.ts',
        'packages/workflow-engine/test/grant-proof-ssh.contract.test.ts',
        'packages/workflow-engine/test/role-context-sharing-plan-review.integration.test.ts',
        'packages/workflow-engine/test/change-role-assignment-record.contract.test.ts',
        'packages/workflow-engine/test/change-role-assignment-store.contract.test.ts',
        'packages/workflow-engine/test/provider-native-session.contract.test.ts',
        'packages/workflow-engine/test/provider-native-session-store.contract.test.ts',
        'packages/fixture-adapter/test/package-boundary.contract.test.ts',
      ]);
      assert.deepEqual(scenarioReport.status, [
        'implementation-ready',
        'real-pilot-pending',
        'full-gate-pending',
      ]);
      for (const evidencePath of scenarioReport.targetedEvidence) {
        assert.equal(
          fs
            .statSync(path.resolve(sourcePackageRoot, '../..', evidencePath))
            .isFile(),
          true,
        );
      }
      assert.equal(
        scenarioReport.deferred.some(
          ({ scenario }) => scenario === 'real-protected-remote-pilot',
        ),
        true,
      );
      assert.equal(
        scenarioReport.deferred.some(
          ({ scenario }) => scenario === 'full-gate',
        ),
        true,
      );

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
      git(repository, ['checkout', '-b', 'changes/demo-change']);
      writeReadyV3ExemptChange(repository);
      const validation = runCli(repository, [
        'validate-change',
        'demo-change',
      ]) as { changeId: string; tasks: unknown[]; contractDigest: string };
      assert.equal(validation.changeId, 'demo-change');
      assert.equal(validation.tasks.length, 1);
      assert.match(validation.contractDigest, /^[0-9a-f]{64}$/u);
      const plan = planCommit(repository, 'demo-change');
      git(repository, ['checkout', 'trunk']);
      git(repository, ['merge', '--ff-only', plan.commitHash]);
      git(repository, ['branch', '-d', 'changes/demo-change']);
      prepareRoutingChangePlans(repository);
      exerciseRouting(repository);
      git(repository, ['checkout', '-b', 'changes/demo-change']);
      const sessionId = startTask(repository, 'demo-change');
      fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');
      assert.equal(checkTask(repository, sessionId).passed, true);
      assert.deepEqual(
        (
          runCli(repository, ['route', 'status']) as {
            result: { result: { primaryChangeId: string | null } };
          }
        ).result.result.primaryChangeId,
        'demo-change',
      );
      runCli(repository, ['complete-task', sessionId]);
      runCli(repository, ['finish', sessionId]);
      const task = commitTask(
        repository,
        sessionId,
        'Complete portable fixture task',
      );
      git(repository, ['checkout', 'trunk']);
      git(repository, ['merge', '--ff-only', task.commitHash]);
      syncProtectedBase(repository);

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
          'route',
          'route',
          'archive',
        ],
      );
      assert.equal(managed[0]!.fixtureCommitId, plan.commitHash);
      assert.equal(
        managed.find(({ trailers }) => trailers.kind === 'task')!
          .fixtureCommitId,
        task.commitHash,
      );
      assert.equal(managed.at(-1)!.fixtureCommitId, archived.commitHash);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

function installSingleJigwrightFixture(): Readonly<{
  packageRoot: string;
  dispose(): void;
}> {
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-portable-install-'),
  );
  try {
    const releaseRoot = path.join(scratch, 'release');
    const artifact = buildSingleJigwrightPackage(
      path.resolve(import.meta.dirname, '../../..'),
      releaseRoot,
      { allowDirty: true },
    );
    assert.equal(artifact.name, 'jigwright');
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
        path.join(releaseRoot, artifact.tarball),
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
      dispose() {
        fs.rmSync(scratch, { recursive: true, force: true });
      },
    });
  } catch (error) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw error;
  }
}

type ManagedCommit = Readonly<{ commitHash: string }>;
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

function configurePortableConsumer(repository: string): void {
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
  ) as { consumerId: string };
  repositoryConsumer.consumerId = 'orbit-fixture';
  writeJson(repositoryConsumerPath, repositoryConsumer);

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
    enforcement: 'active',
    transition: 'completion',
  };
  writeJson(documentPolicyPath, documentPolicy);
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { requiredChecks: string[] }>;
  };
  guard.tasks['1.1']!.requiredChecks = ['text-check'];
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

function startTask(repository: string, changeId: string): string {
  return (
    runCli(repository, ['start', changeId, '--task', '1.1']) as {
      session: { sessionId: string };
    }
  ).session.sessionId;
}

function checkTask(repository: string, sessionId: string): { passed: boolean } {
  return (
    runCli(repository, ['check', sessionId]) as {
      result: { passed: boolean };
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

function commitTask(
  repository: string,
  sessionId: string,
  message: string,
): ManagedCommit {
  return (
    runCli(repository, ['commit', sessionId, '--message', message]) as {
      result: ManagedCommit;
    }
  ).result;
}

function abortTask(repository: string, sessionId: string): void {
  runCli(repository, [
    'abort',
    sessionId,
    '--reason',
    'Portability fixture complete.',
  ]);
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
    const firstSessionId = startTask(first.worktree, first.changeId);
    const secondSessionId = startTask(second.worktree, second.changeId);
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
      () => startTask(third.worktree, third.changeId),
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

    const secondTaskPath = path.join(
      second.worktree,
      'src/parallel-two/feature.ts',
    );
    fs.mkdirSync(path.dirname(secondTaskPath), { recursive: true });
    fs.writeFileSync(
      secondTaskPath,
      'export const parallelTwoFeature = true;\n',
    );
    assert.equal(checkTask(second.worktree, secondSessionId).passed, true);
    runCli(second.worktree, ['complete-task', secondSessionId]);
    runCli(second.worktree, ['finish', secondSessionId]);
    const secondTask = commitTask(
      second.worktree,
      secondSessionId,
      'Complete second portable concurrent task',
    );

    fs.writeFileSync(
      path.join(repository, 'src/portable-base-update.ts'),
      'export const portableBaseUpdate = true;\n',
    );
    git(repository, ['add', 'src/portable-base-update.ts']);
    git(repository, ['commit', '-m', 'Advance portable fixture base']);
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
      };
    };
    assert.equal(update.result.changeId, second.changeId);
    assert.equal(update.result.ontoCommit, ontoCommit);
    assert.equal(update.result.oldHead, secondTask.commitHash);
    assert.notEqual(update.result.oldHead, update.result.newHead);
    const status = taskStatus(second.worktree, secondSessionId);
    assert.equal(status.session.state, 'committed');
    assert.equal(status.session.commitHash, secondTask.commitHash);
    assert.equal(
      git(second.worktree, ['rev-parse', 'HEAD']).trim(),
      update.result.newHead,
    );

    abortTask(first.worktree, firstSessionId);
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
    tasks: Record<string, { allowedPaths: string[] }>;
  };
  guard.changeId = changeId;
  guard.tasks['1.1']!.allowedPaths = [allowedPath];
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

function runPortabilityPackageInvocation(
  invocation: ReturnType<typeof createExactLocalPackageInvocation>,
): string {
  return runExactLocalPackageInvocation(invocation, {
    timeoutMs: cliEntrypoint === 'bin/jigwright.mjs' ? 120_000 : 30_000,
  });
}

function orbitConsumerConfiguration(): RepositoryConsumerConfigurationV1 {
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
      issueSourcePath: 'notebook/issues.json',
      issueLogPath: 'notebook/issue-index.md',
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
