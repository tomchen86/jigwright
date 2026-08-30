import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  addIssue,
  closeIssue,
  readIssueData,
  renderIssues,
  updateIssue,
  validateIssueLog,
  writeIssueData,
  type IssueData,
} from '../src/adapters/consumer/repository/documents/issues.ts';
import { createFixtureRepository, sourceRepositoryRoot } from './fixture.ts';

test('issue commands preserve structured fields and deterministic rendering', () => {
  const repository = createFixtureRepository();
  const initial: IssueData = {
    schemaVersion: 1,
    lastUpdated: '2026-07-14',
    issues: [
      {
        id: 'ISS-001',
        category: 'feature',
        title: 'First issue',
        status: 'proposed',
        priority: 'Next',
        requirement: null,
        references: ['docs/one.md'],
        notes: 'Keep every field.',
      },
    ],
  };

  try {
    writeIssueData(repository, initial);
    renderIssues(repository);
    validateIssueLog(repository);
    addIssue(repository, {
      id: 'ISS-101',
      category: 'bug',
      title: 'Second issue',
      status: 'in-progress',
      priority: 'Now',
      requirement: {
        label: 'Req: Groups',
        href: 'docs/REQUIREMENT_LOG.md#groups',
      },
      references: ['apps/mobile/app.tsx'],
      notes: 'Fix it.',
    });
    updateIssue(repository, 'ISS-101', 'notes', 'Updated without data loss.');
    closeIssue(repository, 'ISS-101', '2026-07-15', 'Validated fix.');
    renderIssues(repository);
    validateIssueLog(repository);

    const data = readIssueData(repository);
    assert.equal(data.issues.length, 2);
    assert.deepEqual(data.issues[1], {
      id: 'ISS-101',
      category: 'bug',
      title: 'Second issue',
      status: 'done',
      priority: 'Now',
      requirement: {
        label: 'Req: Groups',
        href: 'docs/REQUIREMENT_LOG.md#groups',
      },
      references: ['apps/mobile/app.tsx'],
      notes: 'Updated without data loss.',
      closed: { date: '2026-07-15', notes: 'Validated fix.' },
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('clean package issue seed is empty and renders without drift', () => {
  const data = readIssueData(sourceRepositoryRoot);
  assert.equal(data.issues.length, 0);
  assert.deepEqual(
    Object.fromEntries(
      ['feature', 'bug', 'enhancement'].map((category) => [
        category,
        data.issues.filter((issue) => issue.category === category).length,
      ]),
    ),
    { feature: 0, bug: 0, enhancement: 0 },
  );
  validateIssueLog(sourceRepositoryRoot);
});
