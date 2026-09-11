import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAttemptAcceptanceBindingV1 } from '@jigwright/core/job-attempt-runtime';

import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  assertAttemptResult,
  canonicalAttemptResult,
  parseAttemptResult,
} from '../src/modules/provider-orchestration/execution-core.ts';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

test('execution-core keeps its public error facade while consuming the core acceptance DTO', () => {
  const result = createAttemptAcceptanceBindingV1({
    workflowId: 'workflow-a',
    epoch: 4,
    contextDigest: digest('a'),
    jobId: 'job-a',
    attemptId: 'attempt-a',
    outputDigest: digest('b'),
    acceptance: 'accepted',
    completedAt: '2026-08-20T02:00:00.000Z',
  });
  assert.deepEqual(assertAttemptResult(result), result);
  assert.equal(
    canonicalAttemptResult(result),
    `{"acceptance":"accepted","attemptId":"attempt-a","completedAt":"2026-08-20T02:00:00.000Z","contextDigest":"${digest('a')}","epoch":4,"jobId":"job-a","outputDigest":"${digest('b')}","resultId":"sha256:4d67878084f62d4fc8d184439808d5cc44c0afe9e3c4286d1dbfea951fd31dd2","schemaVersion":1,"workflowId":"workflow-a"}\n`,
  );
  assert.deepEqual(parseAttemptResult(canonicalAttemptResult(result)), result);
  assert.throws(
    () => assertAttemptResult({ ...result, resultId: digest('f') }),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'EXECUTION_RECORD_INVALID',
  );
});

test('partial extraction leaves execution-store as the sole aggregate transition authority', () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, 'packages/core/package.json'),
      'utf8',
    ),
  ) as { exports?: Record<string, unknown> };
  assert.equal(
    manifest.exports?.['./job-attempt-runtime'],
    './src/job-attempt-runtime.ts',
  );

  const core = fs.readFileSync(
    path.join(repositoryRoot, 'packages/core/src/job-attempt-runtime.ts'),
    'utf8',
  );
  assert.doesNotMatch(
    core,
    /expense-app|openspec|provider|mandate|workflowError/i,
  );

  const workflowConsumer = fs.readFileSync(
    path.join(
      repositoryRoot,
      'packages/workflow-engine/src/modules/provider-orchestration/execution-attempts.ts',
    ),
    'utf8',
  );
  assert.match(
    workflowConsumer,
    /from '@jigwright\/core\/job-attempt-runtime'/,
  );
  const executionStore = [
    'execution-store.ts',
    'execution-provider-projection.ts',
    'execution-state-contract.ts',
    'execution-state-files.ts',
    'execution-state-values.ts',
  ]
    .map((file) =>
      fs.readFileSync(
        path.join(
          repositoryRoot,
          'packages/workflow-engine/src/runtime/storage-journal',
          file,
        ),
        'utf8',
      ),
    )
    .join('\n');
  assert.doesNotMatch(executionStore, /@jigwright\/core\/job-attempt-runtime/);
  assert.doesNotMatch(
    core,
    /JOB_TRANSITIONS|ATTEMPT_TRANSITIONS|JobAttemptAggregate|assertJobAttemptMutation|sourceProjection/,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        repositoryRoot,
        'packages/fixture-adapter/src/fixture-job-attempt-lifecycle.ts',
      ),
    ),
    false,
  );
});

test('current provider Job and Attempt runtime has no legacy projection surface', () => {
  const sourceFamilies: Readonly<Record<string, readonly string[]>> = {
    'execution-core.ts': [
      'execution-attempts.ts',
      'execution-record-types.ts',
      'execution-records.ts',
      'execution-retry.ts',
      'execution-values.ts',
    ],
    'execution-store.ts': [
      'execution-provider-projection.ts',
      'execution-state-contract.ts',
      'execution-state-files.ts',
      'execution-state-values.ts',
    ],
    'execution-runtime.ts': ['provider-execution-projection.ts'],
    'provider-invocation-store.ts': [
      'provider-invocation-artifacts.ts',
      'provider-invocation-common.ts',
      'provider-invocation-completion.ts',
      'provider-invocation-policy.ts',
      'provider-invocation-reservations.ts',
      'provider-invocation-state.ts',
      'provider-invocation-validation.ts',
      'provider-invocation-manifest-validation.ts',
      'provider-invocation-output-validation.ts',
      'provider-invocation-workers.ts',
    ],
  };
  const sources = [
    [
      'execution-core.ts',
      /projectLegacyProviderInvocation|legacyInvocation|legacyAttempt|legacyRevision/u,
    ],
    ['provider-retry-decision.ts', /failedLegacyRevision/u],
    [
      'execution-store.ts',
      /LegacyProviderExecutionEntry|decideLegacyExecutionFailure|materializeLegacyProviderExecutionJob|acceptLegacyProviderAttemptResult|reconcileLegacyProviderExecutionJob|legacyProjection|expectedLegacyRevision/u,
    ],
    [
      'execution-runtime.ts',
      /LegacyReplacement|LegacyProjection|prepareLegacyReplacement|previewLegacyReplacementGrantDelta|inspectLegacyExecutionJobSource|authorizeLegacyReplacement|authorizeProviderReplacement|legacyExecutionPolicy|legacyRetryPolicy|legacyEnvironmentDigest/u,
    ],
    [
      'provider-invocation-store.ts',
      /LegacyProviderExecutionEntry|materializeLegacyProviderExecutionJob|acceptLegacyProviderAttemptResult|expectedLegacyRevision|legacyRevision/u,
    ],
  ] as const;

  for (const [file, retiredSurface] of sources) {
    const sourcePath =
      file === 'execution-core.ts' || file === 'provider-retry-decision.ts'
        ? path.join(
            repositoryRoot,
            'packages/workflow-engine/src/modules/provider-orchestration',
            file,
          )
        : file === 'execution-runtime.ts'
          ? path.join(
              repositoryRoot,
              'packages/workflow-engine/src/runtime/provider-execution',
              file,
            )
          : path.join(
              repositoryRoot,
              'packages/workflow-engine/src/runtime/storage-journal',
              file,
            );
    const source = [
      sourcePath,
      ...(sourceFamilies[file] ?? []).map((name) =>
        path.join(path.dirname(sourcePath), name),
      ),
    ]
      .map((filePath) => fs.readFileSync(filePath, 'utf8'))
      .join('\n');
    assert.doesNotMatch(source, retiredSurface, file);
  }
});
