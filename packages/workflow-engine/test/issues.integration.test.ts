import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
} from '../src/adapters/consumer/expense-app/documents/issues.ts';
import { dispatchIssueCommand } from '../src/entrypoints/cli/issue-cli.ts';
import { renderHandoff } from '../src/adapters/consumer/expense-app/handoff/handoff.ts';
import {
  createFixtureRepository,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';

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

test('managed issue CLI uses configured document paths without touching expense defaults', () => {
  const repository = createFixtureRepository();
  try {
    const configPath = path.join(
      repository,
      'workflow/repository-consumer.json',
    );
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      documents: {
        adapterId: string;
        handoffPath: string;
        issueSourcePath: string;
        issueLogPath: string;
      };
    };
    config.documents = {
      adapterId: 'filesystem-documents-v1',
      handoffPath: 'notebook/handoff.md',
      issueSourcePath: 'notebook/issues.json',
      issueLogPath: 'notebook/issue-index.md',
    };
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    fs.mkdirSync(path.join(repository, 'docs/issues'), { recursive: true });
    fs.writeFileSync(
      path.join(repository, 'docs/issues/issues.yaml'),
      'poisoned expense issue source\n',
    );
    fs.writeFileSync(
      path.join(repository, 'docs/ISSUE_LOG.md'),
      'poisoned expense issue log\n',
    );
    fs.writeFileSync(
      path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
      'poisoned expense handoff\n',
    );
    const defaultIssueSource = fs.readFileSync(
      path.join(repository, 'docs/issues/issues.yaml'),
    );
    const defaultIssueLog = fs.readFileSync(
      path.join(repository, 'docs/ISSUE_LOG.md'),
    );
    const defaultHandoff = fs.readFileSync(
      path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
    );

    writeIssueData(repository, {
      schemaVersion: 1,
      lastUpdated: '2026-08-24',
      issues: [],
    });
    renderIssues(repository);
    writeReadyV3ExemptChange(repository);
    renderHandoff(repository);
    const result = dispatchIssueCommand(
      [
        'add',
        '--id',
        'ISS-199',
        '--category',
        'bug',
        '--title',
        'Configured projection',
        '--status',
        'blocked',
        '--priority',
        'Now',
        '--notes',
        'Use only consumer-managed document paths.',
      ],
      repository,
    );

    assert.equal(result.action, 'add');
    assert.match(
      fs.readFileSync(path.join(repository, 'notebook/issue-index.md'), 'utf8'),
      /ISS-199[\s\S]*Configured projection/,
    );
    assert.match(
      fs.readFileSync(path.join(repository, 'notebook/handoff.md'), 'utf8'),
      /ISS-199[^\n]*Configured projection/,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(repository, 'docs/issues/issues.yaml')),
      defaultIssueSource,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(repository, 'docs/ISSUE_LOG.md')),
      defaultIssueLog,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md')),
      defaultHandoff,
    );
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

test('managed issue mutations refresh issue and handoff projections together', () => {
  const repository = createFixtureRepository();
  try {
    writeIssueData(repository, {
      schemaVersion: 1,
      lastUpdated: '2026-08-14',
      issues: [],
    });
    renderIssues(repository);
    writeReadyV3ExemptChange(repository);
    renderHandoff(repository);

    dispatchIssueCommand(
      [
        'add',
        '--id',
        'ISS-199',
        '--category',
        'bug',
        '--title',
        'Projected blocker',
        '--status',
        'blocked',
        '--priority',
        'Now',
        '--notes',
        'The handoff must surface this blocker.',
      ],
      repository,
    );

    assert.match(
      fs.readFileSync(path.join(repository, 'docs/ISSUE_LOG.md'), 'utf8'),
      /ISS-199[\s\S]*Projected blocker/,
    );
    assert.match(
      fs.readFileSync(
        path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md'),
        'utf8',
      ),
      /## Known Blockers[\s\S]*ISS-199[^\n]*Projected blocker/,
    );
    validateIssueLog(repository);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed issue mutations roll back every projection after a caught refresh failure', () => {
  const repository = createFixtureRepository();
  const sourcePath = path.join(repository, 'docs/issues/issues.yaml');
  const issueLogPath = path.join(repository, 'docs/ISSUE_LOG.md');
  const handoffPath = path.join(repository, 'docs/CURRENT_AND_NEXT_STEPS.md');
  try {
    writeIssueData(repository, {
      schemaVersion: 1,
      lastUpdated: '2026-08-14',
      issues: [],
    });
    renderIssues(repository);
    writeReadyV3ExemptChange(repository);
    renderHandoff(repository);
    const before = new Map(
      [sourcePath, issueLogPath, handoffPath].map((filePath) => [
        filePath,
        fs.readFileSync(filePath),
      ]),
    );
    const command = [
      'add',
      '--id',
      'ISS-199',
      '--category',
      'bug',
      '--title',
      'Transactional blocker',
      '--status',
      'blocked',
      '--priority',
      'Now',
      '--notes',
      'No partial managed projection may survive.',
    ];

    for (const hooks of [
      {
        afterSourceWrite: () => {
          throw new Error('simulated source-write interruption');
        },
      },
      {
        afterIssueLogWrite: () => {
          throw new Error('simulated issue-log interruption');
        },
      },
    ]) {
      assert.throws(
        () => dispatchIssueCommand(command, repository, hooks),
        /simulated (source-write|issue-log) interruption/,
      );
      for (const [filePath, expected] of before) {
        assert.deepEqual(fs.readFileSync(filePath), expected);
      }
      validateIssueLog(repository);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
