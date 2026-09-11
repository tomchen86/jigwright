import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createBoundaryCommand } from '../src/entrypoints/cli/boundary-cli.ts';
import {
  createProviderOperationsCommands,
  type ProviderOperationsServices,
} from '../src/entrypoints/cli/provider-operations-cli.ts';

function unexpectedOperation(): never {
  throw new Error('Unexpected operation');
}
function providerServices(
  overrides: Partial<ProviderOperationsServices> = {},
): ProviderOperationsServices {
  return {
    listExecutionJobs: unexpectedOperation,
    inspectExecutionJob: unexpectedOperation,
    pruneProviderRuntime: unexpectedOperation,
    pumpProviderRetrySchedules: unexpectedOperation,
    listProviderAutomaticRetrySchedules: unexpectedOperation,
    listProviderRetryScheduleReceipts: unexpectedOperation,
    requestExecutionReplacement: unexpectedOperation,
    executeGrantedReplacement: unexpectedOperation,
    previewExecutionJobRetry: unexpectedOperation,
    requestExecutionJobRetry: unexpectedOperation,
    inspectEvidenceRetention: unexpectedOperation,
    runEvidenceRetentionMaintenance: unexpectedOperation,
    pinWorkflowEvidence: unexpectedOperation,
    consumedPlanReviewReplay: {
      verify: unexpectedOperation,
      verifyRoleContextSharing: unexpectedOperation,
    },
    providerDispatcher: unexpectedOperation,
    ...overrides,
  };
}
function invalidUsage(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && error.code === 'INVALID_USAGE'
  );
}

test('operational command construction and invalid routes do not invoke capabilities', () => {
  const boundary = createBoundaryCommand({
    discoverRepository: unexpectedOperation,
    loadWorkflowConformanceVectorsV2: unexpectedOperation,
    projectAuthorityRemap: unexpectedOperation,
  });
  const commands = createProviderOperationsCommands(providerServices());
  assert.equal(boundary.length, 2);
  assert.equal(commands.dispatchExecutionJobCommand.length, 2);
  assert.equal(commands.dispatchRetentionCommand.length, 2);
  assert.throws(() => boundary(['remap'], '/unused'), invalidUsage);
  assert.throws(
    () => boundary(['vectors', '--write'], '/unused'),
    invalidUsage,
  );
  assert.throws(
    () =>
      commands.dispatchExecutionJobCommand(
        ['retry-pump', '--limit', '0'],
        '/unused',
      ),
    invalidUsage,
  );
  assert.throws(
    () =>
      commands.dispatchRetentionCommand(['sweep', '--limit', '0'], '/unused'),
    invalidUsage,
  );
});

test('retry input preserves parse-first failure and the exact replay and dispatcher capabilities', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'operational-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputFile = path.join(directory, 'retry.json');
  fs.writeFileSync(inputFile, '{');
  const injectedFailure = new Error('injected retry publication failure');
  const calls: unknown[][] = [];
  const services = providerServices({
    requestExecutionJobRetry(...args) {
      calls.push(args);
      throw injectedFailure;
    },
  });
  const commands = createProviderOperationsCommands(services);
  assert.throws(
    () =>
      commands.dispatchExecutionJobCommand(
        ['retry-request', 'job-1', '--input', 'retry.json'],
        directory,
      ),
    (error: unknown) =>
      invalidUsage(error) &&
      (error as Error).message ===
        'Retry input must be a readable JSON file from retry-preview.',
  );
  assert.equal(calls.length, 0);
  const input = {
    retryExplanation: { failureReason: 'transient', plannedAction: 'repeat' },
  };
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const originalFlag = process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH;
  t.after(() => {
    if (originalFlag === undefined)
      delete process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH;
    else process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH = originalFlag;
  });
  for (const disabled of [false, true]) {
    if (disabled) process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH = '1';
    else delete process.env.WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH;
    assert.throws(
      () =>
        commands.dispatchExecutionJobCommand(
          ['retry-request', 'job-1', '--input', 'retry.json'],
          directory,
        ),
      (error) => error === injectedFailure,
    );
    assert.deepEqual(calls.at(-1), [
      directory,
      'job-1',
      input,
      {
        collaborationGrantValidation: {
          consumedRoleResultReplay: services.consumedPlanReviewReplay,
          consumedPlanReviewReplay: services.consumedPlanReviewReplay,
        },
        providerDispatcher: disabled ? undefined : services.providerDispatcher,
      },
    ]);
  }
});

test('retention dispatch invokes the injected owner with the original bounded arguments', () => {
  const failure = new Error('injected retention failure');
  const calls: unknown[][] = [];
  const services = providerServices({
    runEvidenceRetentionMaintenance(...args) {
      calls.push(args);
      throw failure;
    },
  });
  const { dispatchRetentionCommand } =
    createProviderOperationsCommands(services);
  assert.throws(
    () => dispatchRetentionCommand(['sweep', '--limit', '3'], '/repository'),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [['/repository', { limit: 3 }]]);
});

test('boundary remap preserves discovery, input validation and projection failure order', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const inputFile = path.join(directory, 'remap.json');
  const calls: unknown[][] = [];
  const failure = new Error('injected projection failure');
  const dispatch = createBoundaryCommand({
    discoverRepository(cwd) {
      calls.push(['discover', cwd]);
      return { repositoryRoot: directory };
    },
    loadWorkflowConformanceVectorsV2: unexpectedOperation,
    projectAuthorityRemap(request) {
      calls.push(['project', request]);
      throw failure;
    },
  });
  assert.throws(
    () => dispatch(['remap', '--input', 'remap.json'], directory),
    invalidUsage,
  );
  assert.deepEqual(calls, [['discover', directory]]);
  const input = {
    schemaVersion: 1,
    kind: 'workflow.authority-remap-request.v1',
    baseCommit: 'base',
    moveCommit: 'move',
    materializationCommit: null,
    renamePairs: [{ from: 'src/before.ts', to: 'src/after.ts' }],
    authorityPlan: {
      changeId: 'change',
      taskId: '1.1',
      profileId: 'profile',
      reason: 'move',
      message: 'Move source',
    },
  };
  fs.writeFileSync(inputFile, JSON.stringify(input));
  assert.throws(
    () => dispatch(['remap', '--input', 'remap.json'], directory),
    (error) => error === failure,
  );
  assert.deepEqual(calls.at(-1), [
    'project',
    {
      repositoryRoot: directory,
      baseCommit: input.baseCommit,
      moveCommit: input.moveCommit,
      renamePairs: input.renamePairs,
      authorityPlan: input.authorityPlan,
    },
  ]);
});
