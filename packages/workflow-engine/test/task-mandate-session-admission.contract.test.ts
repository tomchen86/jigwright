import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { readPinnedAgentRuntimePathRoleSource } from '../src/composition-root/change-role-assignment-production.ts';
import { startMandatedSession as startMandatedSessionWithMandate } from '../src/application/execute-task/session.ts';
import { getSession } from '../src/runtime/repository-observation/workflow-session-context.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';

import { resolveTaskAuthorizationRequirement } from '../src/adapters/consumer/repository/work-registry/task-authorization-policy.ts';
import {
  git,
  prepareCurrentV3IntroductionFixture,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import {
  TASK_ID,
  CHANGE_ID,
  MANDATE_ID,
  ISSUED_AT,
  externalAuditRoot,
  cleanupRepository,
  prepareRepository,
  enableConditionalTaskAuthorization,
  request,
  fakeSigner,
  generateSigningKey,
} from './task-mandate-fixture.ts';

test('managed session activation binds the exact top-level mandate without conflating the OpenSpec task ID', () => {
  const repository = prepareRepository();
  const signed: string[] = [];
  const signer = fakeSigner(signed);
  try {
    authorizeTaskMandate(repository, request(), {
      mandateId: MANDATE_ID,
      externalAuditRoot: externalAuditRoot(repository),
      now: ISSUED_AT,
      signer,
    });
    prepareCurrentV3IntroductionFixture(repository, CHANGE_ID);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, CHANGE_ID);
    const session = startMandatedSession(
      productionChangeContract,
      repository,
      CHANGE_ID,
      '1.1',
      TASK_ID,
      { now: new Date('2026-08-03T10:00:00.000Z'), signer },
    );
    assert.equal(session.taskId, '1.1');
    assert.equal(session.mandateBinding?.mandateTaskId, TASK_ID);
    assert.equal(session.mandateBinding?.changeId, CHANGE_ID);
    assert.equal(session.mandateBinding?.mandateId, MANDATE_ID);
    assert.match(session.mandateBinding?.mandateDigest ?? '', /^[0-9a-f]{64}$/);
  } finally {
    cleanupRepository(repository);
  }
});

test('ordinary open-task CLI needs no task mandate', () => {
  const repository = prepareRepository();
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
  );
  try {
    enableConditionalTaskAuthorization(repository);
    prepareCurrentV3IntroductionFixture(repository, CHANGE_ID);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, CHANGE_ID);

    const ordinary = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'open-task',
        CHANGE_ID,
        '--task',
        '1.1',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(ordinary.status, 0, ordinary.stderr);
    const ordinaryOutput = JSON.parse(ordinary.stdout) as {
      result: { sessionId: string };
    };
    assert.equal(
      getSession(repository, ordinaryOutput.result.sessionId).mandateBinding,
      undefined,
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('unclassified task scope remains ordinary unless policy explicitly protects it', () => {
  const repository = prepareRepository();
  try {
    enableConditionalTaskAuthorization(repository);

    const requirement = resolveTaskAuthorizationRequirement(
      repository,
      {
        taskAuthorization: {
          pathRoleRegistry: 'workflow/path-roles.json',
          mandateRequiredRoles: ['lifecycle'],
        },
      },
      ['apps/mobile/**'],
    );

    assert.equal(requirement.unclassifiedScope, true);
    assert.equal(requirement.requiresMandate, false);
    assert.deepEqual(requirement.roles, []);
    assert.deepEqual(requirement.matchedPatterns, []);
  } finally {
    cleanupRepository(repository);
  }
});

test('AgentRuntime rejects a symlinked path-role registry in its immutable baseline', () => {
  const repository = prepareRepository();
  try {
    enableConditionalTaskAuthorization(repository);
    const registryPath = 'workflow/path-roles.json';
    const registryTargetPath = 'path-roles-target.json';
    fs.copyFileSync(
      path.join(repository, registryPath),
      path.join(repository, registryTargetPath),
    );
    fs.rmSync(path.join(repository, registryPath));
    fs.symlinkSync(
      `../${registryTargetPath}`,
      path.join(repository, registryPath),
    );
    git(repository, ['add', registryPath, registryTargetPath]);
    git(repository, ['commit', '-m', 'Link the path-role baseline fixture']);
    assert.equal(
      (
        JSON.parse(
          fs.readFileSync(path.join(repository, registryPath), 'utf8'),
        ) as { kind: string }
      ).kind,
      'path-role-registry',
    );

    assert.throws(
      () =>
        readPinnedAgentRuntimePathRoleSource(
          repository,
          git(repository, ['rev-parse', 'HEAD']).trim(),
        ),
      (error) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_CURRENT_MANIFEST_REQUIRED',
    );
  } finally {
    cleanupRepository(repository);
  }
});

test('open-task selects the next incomplete task for an already committed plan', () => {
  const keyDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-mandate-open-key-'),
  );
  const { privateKey, trustedSigner } = generateSigningKey(keyDirectory);
  const repository = prepareRepository(trustedSigner);
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
  );
  const changeId = CHANGE_ID;
  try {
    enableConditionalTaskAuthorization(repository);
    prepareCurrentV3IntroductionFixture(repository, CHANGE_ID);
    writeReadyV3ExemptChange(repository);
    const governingPlan = commitPlanningTransition(repository, CHANGE_ID);
    const governingCommit = governingPlan.commitHash;
    const opened = spawnSync(
      process.execPath,
      ['--experimental-strip-types', cli, 'open-task', changeId, '--json'],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(opened.status, 0, opened.stderr);
    const output = JSON.parse(opened.stdout) as {
      result: {
        taskId: string;
        sessionId: string;
        planningCommit: string;
      };
    };
    assert.equal(output.result.taskId, '1.1');
    assert.equal(output.result.planningCommit, governingCommit);
    assert.equal(getSession(repository, output.result.sessionId).taskId, '1.1');
  } finally {
    cleanupRepository(repository);
    fs.rmSync(keyDirectory, { recursive: true, force: true });
  }
});

test('ordinary propose CLI starts without a task mandate', () => {
  const repository = prepareRepository();
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ordinary-propose-input-'),
  );
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
  );
  const changeId = 'ordinary-propose';
  const intentPath = path.join(inputDirectory, 'intent.json');
  try {
    enableConditionalTaskAuthorization(repository);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    fs.writeFileSync(
      intentPath,
      `${canonicalJson({
        schemaVersion: 1,
        summary: 'Plan an ordinary source-only change.',
        sourceRefs: [],
        explicitPaths: ['src/.gitkeep'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      })}\n`,
      'utf8',
    );
    const started = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'propose',
        changeId,
        '--intent',
        intentPath,
        '--actor',
        'codex',
        '--json',
      ],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT: undefined,
          CLAUDECODE: undefined,
          CLAUDE_CODE_ENTRYPOINT: undefined,
          CODEX_SANDBOX: undefined,
          WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
        },
      },
    );
    assert.equal(started.status, 0, started.stderr);
    assert.equal(
      (JSON.parse(started.stdout) as { result: { changeId: string } }).result
        .changeId,
      changeId,
    );
  } finally {
    cleanupRepository(repository);
    fs.rmSync(inputDirectory, { recursive: true, force: true });
  }
});

test('protected propose CLI requires a task mandate before durable planning', () => {
  const repository = prepareRepository();
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'protected-propose-input-'),
  );
  const cli = path.join(
    sourceRepositoryRoot,
    'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
  );
  const changeId = 'protected-propose';
  const intentPath = path.join(inputDirectory, 'intent.json');
  try {
    enableConditionalTaskAuthorization(repository);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    fs.writeFileSync(
      intentPath,
      `${canonicalJson({
        schemaVersion: 1,
        summary: 'Change protected workflow lifecycle behavior.',
        sourceRefs: [],
        explicitPaths: [
          'packages/workflow-engine/src/application/finalize/lifecycle.ts',
        ],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      })}\n`,
      'utf8',
    );
    const started = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cli,
        'propose',
        changeId,
        '--intent',
        intentPath,
        '--actor',
        'codex',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.notEqual(started.status, 0, started.stderr);
    assert.match(
      `${started.stdout}\n${started.stderr}`,
      /TASK_MANDATE_REQUIRED/,
    );
    assert.equal(fs.existsSync(runtimeRoot(repository)), false);
  } finally {
    cleanupRepository(repository);
    fs.rmSync(inputDirectory, { recursive: true, force: true });
  }
});

import { taskMandateOperations } from '../src/composition-root/task-mandate-production.ts';
const { authorizeTaskMandate } = taskMandateOperations;

const startMandatedSession = startMandatedSessionWithMandate.bind(
  undefined,
  taskMandateOperations,
);
