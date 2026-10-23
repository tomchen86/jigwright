import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );

import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';
import { checkSession } from './support/session-lifecycle-host.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  writeReadyV3ExemptChange,
} from './fixture.ts';

const NOW = new Date('2026-08-04T01:00:00.000Z');

function prepareCurrentChange(repository: string): void {
  writeReadyV3ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
}

test('ordinary checks retain trusted external-state metadata and rerun required checks', () => {
  const repository = fs.realpathSync(createFixtureRepository());
  const countersRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-external-check-fresh-'),
  );
  const externalCounter = path.join(countersRoot, 'external.log');
  const snapshot = bareDigest('external-snapshot-v1');
  let clockCalls = 0;
  const now = () => {
    assert.equal(lineCount(externalCounter), 1, 'read clock after execution');
    clockCalls += 1;
    return NOW;
  };
  const observedGate: typeof productionTaskStrategyExecutionGate = {
    ...productionTaskStrategyExecutionGate,
    assertExecutionAdmitted(...args) {
      assert.equal(
        clockCalls,
        0,
        'construction and admission must not read clock',
      );
      return productionTaskStrategyExecutionGate.assertExecutionAdmitted(
        ...args,
      );
    },
  };
  try {
    installExternalCountingChecks(repository, {
      'external-check': externalCounter,
    });
    installExternalTrustedPolicy(repository, {
      'external-check': 10 * 60 * 1_000,
    });
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);

    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );
    weakenCandidateExternalFreshness(repository, 'external-check', 1);
    assert.throws(
      () =>
        checkSession(
          maintainerManifestOperations,
          observedGate,
          productionChangeContract,
          repository,
          session.sessionId,
          { now },
        ),
      (error) =>
        isWorkflowError(error, 'SESSION_EXTERNAL_STATE_SNAPSHOT_REQUIRED'),
    );
    assert.equal(lineCount(externalCounter), 0);
    assert.equal(
      clockCalls,
      0,
      'missing snapshot must refuse without reading clock',
    );
    const original = checkSession(
      maintainerManifestOperations,
      observedGate,
      productionChangeContract,
      repository,
      session.sessionId,
      {
        now,
        externalSnapshotDigests: { 'external-check': snapshot },
      },
    );
    assert.equal(lineCount(externalCounter), 1);
    assert.equal(clockCalls, 1);
    assert.equal(original.checks[0]!.completedAt, NOW.toISOString());
    assert.equal(original.checks[0]!.externalSnapshotDigest, snapshot);
    assert.equal(original.checks[0]!.maxAgeMs, 10 * 60 * 1_000);

    const reconciled = checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeContract,
      repository,
      session.sessionId,
      {
        now: () => new Date(NOW.getTime() + 2 * 60 * 1_000),
        externalSnapshotDigests: { 'external-check': snapshot },
      },
    );
    assert.deepEqual(reconciled.executedCheckIds, ['external-check']);
    assert.deepEqual(reconciled.reusedCheckIds, []);
    assert.equal(lineCount(externalCounter), 2);
    assert.equal(reconciled.checks[0]!.externalSnapshotDigest, snapshot);
    assert.equal(
      reconciled.checks[0]!.completedAt,
      new Date(NOW.getTime() + 2 * 60 * 1_000).toISOString(),
    );
    assert.equal(reconciled.checks[0]!.maxAgeMs, original.checks[0]!.maxAgeMs);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(countersRoot, { recursive: true, force: true });
  }
});

test('ordinary checks refresh stale and snapshot-changed external-state evidence', () => {
  const repository = fs.realpathSync(createFixtureRepository());
  const countersRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-external-check-stale-'),
  );
  const changedCounter = path.join(countersRoot, 'changed.log');
  const staleCounter = path.join(countersRoot, 'stale.log');
  const snapshotV1 = bareDigest('external-snapshot-v1');
  const snapshotV2 = bareDigest('external-snapshot-v2');
  try {
    installExternalCountingChecks(repository, {
      'changed-check': changedCounter,
      'stale-check': staleCounter,
    });
    installExternalTrustedPolicy(repository, {
      'changed-check': 10 * 60 * 1_000,
      'stale-check': 60 * 1_000,
    });
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);

    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, 'src/feature.ts'),
      'export const feature = true;\n',
    );
    weakenCandidateExternalFreshness(
      repository,
      'stale-check',
      24 * 60 * 60 * 1_000,
    );
    checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeContract,
      repository,
      session.sessionId,
      {
        now: () => NOW,
        externalSnapshotDigests: {
          'changed-check': snapshotV1,
          'stale-check': snapshotV1,
        },
      },
    );
    assert.deepEqual(
      [lineCount(changedCounter), lineCount(staleCounter)],
      [1, 1],
    );

    const reconciledAt = new Date(NOW.getTime() + 2 * 60 * 1_000);
    const reconciled = checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeContract,
      repository,
      session.sessionId,
      {
        now: () => reconciledAt,
        externalSnapshotDigests: {
          'changed-check': snapshotV2,
          'stale-check': snapshotV1,
        },
      },
    );
    assert.deepEqual(reconciled.executedCheckIds, [
      'changed-check',
      'stale-check',
    ]);
    assert.deepEqual(reconciled.reusedCheckIds, []);
    assert.deepEqual(
      [lineCount(changedCounter), lineCount(staleCounter)],
      [2, 2],
    );
    assert.deepEqual(
      reconciled.checks.map((evidence) => ({
        checkId: evidence.checkId,
        completedAt: evidence.completedAt,
        externalSnapshotDigest: evidence.externalSnapshotDigest,
        maxAgeMs: evidence.maxAgeMs,
      })),
      [
        {
          checkId: 'changed-check',
          completedAt: reconciledAt.toISOString(),
          externalSnapshotDigest: snapshotV2,
          maxAgeMs: 10 * 60 * 1_000,
        },
        {
          checkId: 'stale-check',
          completedAt: reconciledAt.toISOString(),
          externalSnapshotDigest: snapshotV1,
          maxAgeMs: 60 * 1_000,
        },
      ],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(countersRoot, { recursive: true, force: true });
  }
});

function installExternalCountingChecks(
  repository: string,
  counters: Record<string, string>,
): void {
  const counterScript = path.join(repository, 'scripts/count-check.mjs');
  fs.writeFileSync(
    counterScript,
    [
      "import fs from 'node:fs';",
      'fs.appendFileSync(process.argv[2], "passed\\n");',
      '',
    ].join('\n'),
  );
  const checkIds = Object.keys(counters).sort();
  configureChecks(
    repository,
    Object.fromEntries(
      checkIds.map((checkId) => [
        checkId,
        {
          command: ['node', 'scripts/count-check.mjs', counters[checkId]!],
          destructiveDatabase: false,
        },
      ]),
    ),
    checkIds,
  );
}

function installExternalTrustedPolicy(
  repository: string,
  maxAgeByCheck: Record<string, number>,
): void {
  const checkIds = Object.keys(maxAgeByCheck).sort();
  const profilesPath = path.join(
    repository,
    'workflow/maintainer-profiles.json',
  );
  writeJson(profilesPath, {
    schemaVersion: 1,
    profiles: {
      'external-check-fixture': {
        id: 'external-check-fixture',
        version: 1,
        authorityClass: 'ordinary',
        implementationPaths: ['src/**'],
        evidencePaths: [],
        policyPaths: ['workflow/**'],
        verificationInfrastructurePaths: ['scripts/**'],
        forbiddenPaths: [],
        constraints: {
          evidenceOnlyGrantForbidden: true,
          samePackageRequired: true,
          evidenceAdditionsAllowed: true,
          maximumFiles: 10,
        },
        requiredChecks: checkIds,
        checkDependencies: Object.fromEntries(
          checkIds.map((checkId) => [checkId, ['external-state', 'runner']]),
        ),
        externalStateFreshness: Object.fromEntries(
          checkIds.map((checkId) => [
            checkId,
            { maxAgeMs: maxAgeByCheck[checkId] },
          ]),
        ),
      },
    },
  });
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { allowedPaths: string[] }>;
  };
  guard.tasks['1.1']!.allowedPaths = [
    'src/**',
    'workflow/maintainer-profiles.json',
  ];
  writeJson(guardPath, guard);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Declare external check freshness']);
}

function weakenCandidateExternalFreshness(
  repository: string,
  checkId: string,
  maxAgeMs: number,
): void {
  const profilesPath = path.join(
    repository,
    'workflow/maintainer-profiles.json',
  );
  const value = JSON.parse(fs.readFileSync(profilesPath, 'utf8')) as {
    profiles: Record<
      string,
      { externalStateFreshness: Record<string, { maxAgeMs: number }> }
    >;
  };
  value.profiles['external-check-fixture']!.externalStateFreshness[
    checkId
  ]!.maxAgeMs = maxAgeMs;
  writeJson(profilesPath, value);
}

function lineCount(filePath: string): number {
  return fs.existsSync(filePath)
    ? fs.readFileSync(filePath, 'utf8').trim().split('\n').filter(Boolean)
        .length
    : 0;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function bareDigest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
