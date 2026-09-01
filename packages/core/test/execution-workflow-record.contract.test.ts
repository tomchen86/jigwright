import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  EXECUTION_WORKFLOW_BLOCKER_KINDS_V2,
  EXECUTION_WORKFLOW_RECORD_CONTRACT_VERSION_V2,
  EXECUTION_WORKFLOW_STATUSES_V2,
  ExecutionWorkflowRecordCodecError,
  assertExecutionWorkflowRecordV2,
  type ExecutionWorkflowRecordV2,
} from '../src/execution-workflow-record.ts';

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const NOW = '2026-08-03T00:00:00.000Z';

const RECORD: ExecutionWorkflowRecordV2 = {
  schemaVersion: 2,
  workflowId: 'change-a',
  currentEpoch: 4,
  contractVersion: 2,
  contextDigest: digest('a'),
  checkpoint: 'plan-review',
  status: 'active',
  blocker: null,
  engineBinding: digest('e'),
};

const BLOCKED_RECORD: ExecutionWorkflowRecordV2 = {
  ...RECORD,
  blocker: {
    kind: 'retry-delay',
    since: NOW,
    jobId: 'job-a',
    retryAt: '2026-08-03T00:01:00.000Z',
    detailsDigest: digest('d'),
    checkpointId: 'checkpoint-a',
    blockedBy: 'dependency-a',
  },
};

test('core publishes and snapshots the exact current execution WorkflowRecord', () => {
  assert.equal(
    EXECUTION_WORKFLOW_RECORD_CONTRACT_VERSION_V2,
    'jigwright.execution-workflow-record.v2',
  );
  assert.deepEqual(EXECUTION_WORKFLOW_STATUSES_V2, [
    'active',
    'completed',
    'cancelled',
    'superseded',
  ]);
  assert.deepEqual(EXECUTION_WORKFLOW_BLOCKER_KINDS_V2, [
    'retry-delay',
    'provider-capacity',
    'human-grant',
    'human-input',
    'configuration',
    'dependency',
    'manual-reconciliation',
    'harness-intervention',
  ]);
  const manifest = JSON.parse(
    fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, unknown> };
  assert.equal(
    manifest.exports?.['./execution-workflow-record'],
    './src/execution-workflow-record.ts',
  );

  const input = structuredClone(BLOCKED_RECORD) as ExecutionWorkflowRecordV2 & {
    blocker: { detailsDigest: string };
  };
  const snapshot = assertExecutionWorkflowRecordV2(input);
  input.blocker.detailsDigest = digest('f');
  assert.deepEqual(snapshot, BLOCKED_RECORD);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.blocker), true);
});

test('execution WorkflowRecord admits every current blocker kind', () => {
  for (const kind of EXECUTION_WORKFLOW_BLOCKER_KINDS_V2) {
    assert.equal(
      assertExecutionWorkflowRecordV2({
        ...RECORD,
        blocker: { kind, since: NOW },
      }).blocker?.kind,
      kind,
    );
  }
});

test('execution WorkflowRecord codec preserves exact root and blocker failures', () => {
  const candidates: ReadonlyArray<readonly [unknown, string]> = [
    [
      Object.assign(Object.create({ inherited: true }), RECORD),
      'Workflow record is invalid.',
    ],
    [{ ...RECORD, unknown: true }, 'Workflow record is invalid.'],
    [{ ...RECORD, schemaVersion: 1 }, 'Workflow record is invalid.'],
    [{ ...RECORD, status: 'paused' }, 'Workflow record is invalid.'],
    [{ ...RECORD, workflowId: 'Change A' }, 'workflowId is invalid.'],
    [
      { ...RECORD, currentEpoch: 0 },
      'currentEpoch must be a positive integer.',
    ],
    [
      { ...RECORD, contractVersion: 0 },
      'contractVersion must be a positive integer.',
    ],
    [{ ...RECORD, contextDigest: 'a'.repeat(64) }, 'Digest is invalid.'],
    [{ ...RECORD, engineBinding: 'e'.repeat(64) }, 'Digest is invalid.'],
    [{ ...RECORD, checkpoint: 'Plan Review' }, 'checkpoint is invalid.'],
    [{ ...RECORD, blocker: [] }, 'Workflow blocker is invalid.'],
    [
      { ...RECORD, blocker: { kind: 'unknown', since: NOW } },
      'Workflow blocker is invalid.',
    ],
    [
      { ...RECORD, blocker: { kind: 'dependency', since: NOW, extra: true } },
      'Workflow blocker is invalid.',
    ],
    [
      { ...RECORD, blocker: { kind: 'dependency', since: '2026-08-03' } },
      'Timestamp is invalid.',
    ],
    [
      {
        ...RECORD,
        blocker: { kind: 'dependency', since: NOW, jobId: 'Job A' },
      },
      'blocker.jobId is invalid.',
    ],
    [
      {
        ...RECORD,
        blocker: { kind: 'retry-delay', since: NOW, retryAt: 'later' },
      },
      'Timestamp is invalid.',
    ],
    [
      {
        ...RECORD,
        blocker: { kind: 'dependency', since: NOW, detailsDigest: 'bad' },
      },
      'Digest is invalid.',
    ],
    [
      {
        ...RECORD,
        blocker: {
          kind: 'dependency',
          since: NOW,
          checkpointId: 'Checkpoint A',
        },
      },
      'blocker.checkpointId is invalid.',
    ],
    [
      {
        ...RECORD,
        blocker: { kind: 'dependency', since: NOW, blockedBy: 'Dependency A' },
      },
      'blocker.blockedBy is invalid.',
    ],
  ];
  for (const [candidate, message] of candidates) {
    assert.throws(
      () => assertExecutionWorkflowRecordV2(candidate),
      (error) =>
        error instanceof ExecutionWorkflowRecordCodecError &&
        error.code === 'EXECUTION_WORKFLOW_RECORD_INVALID' &&
        error.message === message,
      message,
    );
  }
});

test('execution WorkflowRecord codec contains no aggregate transition authority', () => {
  const source = fs.readFileSync(
    new URL('../src/execution-workflow-record.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(
    source,
    /workflow-engine|workflowError|ExitCode|execution-store|TransitionRegistry|GrantRequest|writeFile|renameSync|compare-and-swap/i,
  );
});
