import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeContentRecord } from '../src/runtime/storage-journal/content-record-store.ts';
import {
  readPlanningTransitionReport,
  writePlanningTransitionReport,
} from '../src/runtime/storage-journal/planning-report.ts';

const BASE_REPORT = {
  schemaVersion: 1 as const,
  reportVersion: 3 as const,
  kind: 'planning-transition' as const,
  createdAt: '2026-08-04T00:00:00.000Z',
  changeId: 'demo-change',
  transition: 'plan' as const,
  transitionKind: 'introduction' as const,
  subject: 'Plan demo-change',
  message: 'Plan demo-change\n\nChange: demo-change\nTransition: plan',
  trailers: ['Change: demo-change', 'Transition: plan'] as [string, string],
  branch: 'work/demo-change',
  headRef: 'refs/heads/work/demo-change',
  parent: { head: 'a'.repeat(40), tree: 'b'.repeat(40) },
  tree: 'c'.repeat(40),
  commitHash: 'd'.repeat(40),
  changedPaths: ['openspec/changes/demo-change/proposal.md'],
  planningPaths: ['openspec/changes/demo-change/proposal.md'],
  engineProjectionPaths: [],
  artifactDigests: {
    'openspec/changes/demo-change/proposal.md': 'e'.repeat(64),
  },
  fingerprint: 'f'.repeat(64),
  tasks: { before: null, after: [], reopened: [] },
  openspec: {
    version: '1.6.0' as const,
    schemaName: 'expense-app',
    statusComplete: true as const,
    validationValid: true as const,
  },
  planningAssurance: null,
  amendment: null,
  archiveApplicability: {
    status: 'passed' as const,
    validatedAt: '2026-08-04T00:00:00.000Z',
    validatedBaseCommit: 'a'.repeat(40),
    validatedBaseSpecDigests: {},
    validatorVersion: 'spec-delta-preflight-v1',
  },
};

function directory(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'planning-report-')),
  );
}

test('a plan records the base its preflight was checked against', () => {
  const root = directory();
  const record = {
    status: 'passed' as const,
    validatedAt: '2026-08-04T00:00:00.000Z',
    validatedBaseCommit: 'a'.repeat(40),
    validatedBaseSpecDigests: {
      'openspec/specs/workflow-assurance/spec.md': '1'.repeat(64),
    },
    validatorVersion: 'spec-delta-preflight-v1',
  };
  const id = writePlanningTransitionReport(root, {
    ...BASE_REPORT,
    archiveApplicability: record,
  });
  assert.deepEqual(
    readPlanningTransitionReport(root, id).archiveApplicability,
    record,
  );
});

test('current planning reports reject pre-v3 fields instead of projecting them', () => {
  const root = directory();
  const {
    reportVersion: _reportVersion,
    planningPaths: _planningPaths,
    engineProjectionPaths: _engineProjectionPaths,
    amendment: _amendment,
    archiveApplicability: _archiveApplicability,
    ...legacy
  } = BASE_REPORT;
  const id = writeContentRecord(root, legacy);
  assert.throws(
    () => readPlanningTransitionReport(root, id),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'PLANNING_REPORT_INVALID',
  );
});

test('current v3 reader rejects a missing tasks.reopened own key without rewriting immutable bytes', () => {
  const root = directory();
  const { reopened: _reopened, ...tasks } = BASE_REPORT.tasks;
  const id = writeContentRecord(root, { ...BASE_REPORT, tasks });
  const recordPath = path.join(root, `${id}.json`);
  const before = fs.readFileSync(recordPath);

  assert.throws(
    () => readPlanningTransitionReport(root, id),
    (error: unknown) =>
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'PLANNING_REPORT_INVALID',
  );
  assert.deepEqual(fs.readFileSync(recordPath), before);
});

test('a version 3 report requires an exact disjoint planning/projection partition', () => {
  const root = directory();
  assert.throws(() =>
    writePlanningTransitionReport(root, {
      ...BASE_REPORT,
      reportVersion: 3,
      planningPaths: [...BASE_REPORT.changedPaths],
      engineProjectionPaths: [...BASE_REPORT.changedPaths],
    }),
  );
  assert.throws(() =>
    writePlanningTransitionReport(root, {
      ...BASE_REPORT,
      reportVersion: 3,
      planningPaths: [...BASE_REPORT.changedPaths],
      engineProjectionPaths: ['docs/UNKNOWN.md'],
      changedPaths: [...BASE_REPORT.changedPaths, 'docs/UNKNOWN.md'].sort(),
    }),
  );
  assert.throws(() =>
    writePlanningTransitionReport(root, {
      ...BASE_REPORT,
      reportVersion: 3,
      planningPaths: [
        ...BASE_REPORT.changedPaths,
        'docs/CURRENT_AND_NEXT_STEPS.md',
      ].sort(),
      engineProjectionPaths: [],
      changedPaths: [
        ...BASE_REPORT.changedPaths,
        'docs/CURRENT_AND_NEXT_STEPS.md',
      ].sort(),
    }),
  );
});

test('a passed record missing its provenance is refused', () => {
  const root = directory();
  for (const broken of [
    { status: 'passed' },
    {
      status: 'passed',
      validatedAt: 'not-a-date',
      validatedBaseCommit: 'a'.repeat(40),
      validatedBaseSpecDigests: {},
      validatorVersion: 'v1',
    },
    {
      status: 'passed',
      validatedAt: '2026-08-04T00:00:00.000Z',
      validatedBaseCommit: 'not-a-commit',
      validatedBaseSpecDigests: {},
      validatorVersion: 'v1',
    },
    {
      status: 'passed',
      validatedAt: '2026-08-04T00:00:00.000Z',
      validatedBaseCommit: 'a'.repeat(40),
      validatedBaseSpecDigests: {},
      validatorVersion: '',
    },
  ]) {
    assert.throws(
      () =>
        writePlanningTransitionReport(root, {
          ...BASE_REPORT,
          archiveApplicability: broken as never,
        }),
      JSON.stringify(broken),
    );
  }
});
