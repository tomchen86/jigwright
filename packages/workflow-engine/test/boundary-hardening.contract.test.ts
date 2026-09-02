import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runCli } from '../src/cli.ts';
import { renderHandoff } from '../src/adapters/consumer/repository/handoff/handoff.ts';
import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import { withChangeTransitionAuthority } from '../src/runtime/session-workspace/planning-lock.ts';
import { assertCompletionTaskIds } from '../src/runtime/storage-journal/report-validation.ts';
import {
  readImmutableReport,
  writeImmutableReport,
  type WorkflowReport,
} from '../src/runtime/storage-journal/report-store.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../src/runtime/session-workspace/session-store.ts';
import {
  createFixtureRepository,
  writeReadyV3ExemptChange,
} from './fixture.ts';

const SESSION_ID = 'session-report-boundary-hardening';

test('report writes reject a symlinked root before creating outside it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-root-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'report-outside-'));
  const reportsRoot = path.join(root, 'reports');
  try {
    fs.symlinkSync(outside, reportsRoot, 'dir');

    assert.throws(
      () => writeImmutableReport(reportsRoot, report()),
      (error) => isWorkflowError(error, 'REPORT_DIRECTORY_UNSAFE'),
    );
    assert.equal(fs.existsSync(path.join(outside, SESSION_ID)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('report writes and reads reject a symlinked ancestor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-ancestor-'));
  const outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'report-outside-')),
  );
  const alias = path.join(root, 'alias');
  const reportsRoot = path.join(alias, 'reports');
  try {
    fs.symlinkSync(outside, alias, 'dir');

    assert.throws(
      () => writeImmutableReport(reportsRoot, report()),
      (error) => isWorkflowError(error, 'REPORT_DIRECTORY_UNSAFE'),
    );
    assert.equal(fs.existsSync(path.join(outside, 'reports')), false);

    const canonicalReports = path.join(outside, 'reports');
    const reportId = writeImmutableReport(canonicalReports, report());
    assert.throws(
      () => readImmutableReport(reportsRoot, SESSION_ID, reportId),
      (error) => isWorkflowError(error, 'REPORT_DIRECTORY_UNSAFE'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('report writes and reads reject a symlinked report file', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'report-file-link-')),
  );
  const outside = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'report-outside-')),
  );
  const reportsRoot = path.join(root, 'reports');
  try {
    const reportId = writeImmutableReport(outside, report());
    const outsideReport = path.join(outside, SESSION_ID, `${reportId}.json`);
    const sessionDirectory = path.join(reportsRoot, SESSION_ID);
    fs.mkdirSync(sessionDirectory, { recursive: true, mode: 0o700 });
    fs.symlinkSync(
      outsideReport,
      path.join(sessionDirectory, `${reportId}.json`),
    );

    assert.throws(
      () => writeImmutableReport(reportsRoot, report()),
      (error) => isWorkflowError(error, 'REPORT_FILE_UNSAFE'),
    );
    assert.throws(
      () => readImmutableReport(reportsRoot, SESSION_ID, reportId),
      (error) => isWorkflowError(error, 'REPORT_FILE_UNSAFE'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('task reports require explicit planning assurance while authority reports omit it', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'report-current-shapes-')),
  );
  const reportsRoot = path.join(root, 'reports');
  try {
    const taskReport = report();
    delete taskReport.planningAssurance;
    const taskReportId = writeImmutableReport(reportsRoot, taskReport);
    assert.throws(
      () => readImmutableReport(reportsRoot, SESSION_ID, taskReportId),
      (error) => isWorkflowError(error, 'REPORT_INVALID'),
    );

    const authorityReport = report();
    authorityReport.kind = 'authority-check';
    authorityReport.taskId = 'authority-maintenance';
    delete authorityReport.planningAssurance;
    const authorityReportId = writeImmutableReport(
      reportsRoot,
      authorityReport,
    );
    assert.equal(
      readImmutableReport(reportsRoot, SESSION_ID, authorityReportId)
        .planningAssurance,
      undefined,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tracked report schema admits only current planning-assurance forms including R-007', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      new URL('../../../workflow/schemas/report.schema.json', import.meta.url),
      'utf8',
    ),
  ) as {
    $defs: {
      planningAssurance: {
        anyOf: Array<{
          properties?: { reviewRoleResultForm: { enum: string[] } };
        }>;
      };
    };
  };
  assert.deepEqual(
    schema.$defs.planningAssurance.anyOf[1]?.properties?.reviewRoleResultForm
      .enum,
    [
      'ordinary-provider',
      'granted-same-provider',
      'granted-role-context-sharing',
      'granted-caller-supplied',
      'direct-human-attestation',
    ],
  );
});

test('repository lifecycle cleanup preserves operation and release failures', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'repository-lock-errors-')),
  );
  const runtime = runtimePaths(root, 'workflow-engine');
  const operationError = new Error('sentinel repository operation failure');
  try {
    assert.throws(
      () =>
        withRepositoryLifecycleOperation(runtime, () => {
          fs.unlinkSync(
            path.join(runtime.operations, 'repository-lifecycle.lock'),
          );
          throw operationError;
        }),
      (error) =>
        aggregateContains(
          error,
          operationError,
          'REPOSITORY_LIFECYCLE_LOCK_INVALID',
        ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('change lifecycle cleanup preserves operation and release failures', () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'change-lock-errors-')),
  );
  const runtime = runtimePaths(root, 'workflow-engine');
  const operationError = new Error('sentinel change operation failure');
  try {
    assert.throws(
      () =>
        withChangeTransitionAuthority(runtime, 'demo-change', 'plan', () => {
          fs.unlinkSync(path.join(runtime.locks, 'demo-change.lock'));
          throw operationError;
        }),
      (error) =>
        aggregateContains(error, operationError, 'PLANNING_LOCK_INVALID'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the global JSON flag is accepted once at the terminal argv position', () => {
  const repository = createFixtureRepository();
  try {
    assert.equal(runCli(['status', '--json'], repository), 0);
    assert.equal(
      runCli(['status', '--json', '--json'], repository),
      ExitCode.usage,
    );
    assert.equal(
      runCli(
        ['propose', 'demo-change', '--resume', '--input', '--json'],
        repository,
      ),
      ExitCode.usage,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('help omits retired Work Registry, Issue, and raw maintenance commands', () => {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(runCli(['--help']), 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.doesNotMatch(output, /\bmigrate-issues\b/);
  assert.doesNotMatch(output, /pnpm workflow issue\b/);
  assert.match(
    output,
    /pnpm workflow finding <[^\n]*link <finding-id> --change <change-id>/,
  );
  assert.doesNotMatch(
    output,
    /pnpm workflow intervention (?:checkpoint|worktree|prepare-adoption|adopt)\b/,
  );
  assert.match(output, /pnpm workflow intervention status <parent-change-id>/);
  assert.match(output, /pnpm workflow intervention recover <tx-id>/);
});

test('global help exposes the executable local after-merge command without a retired authorization input', () => {
  const originalWrite = process.stdout.write;
  let output = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    output += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(runCli(['--help']), 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(
    output,
    /^  pnpm workflow after-merge <change-id> \[--workspace-parent <absolute-path>\] \[--json\]$/m,
  );
  assert.doesNotMatch(
    output,
    /pnpm workflow after-merge[^\n]*--authorization\b/,
  );
});

test('retired Issue commands fail before mutation while Work Registry remains available', () => {
  const repository = createFixtureRepository();
  const legacyIssueSourcePath = path.join(
    repository,
    'docs/issues/issues.yaml',
  );
  const legacyIssueLogPath = path.join(repository, 'docs/ISSUE_LOG.md');
  fs.mkdirSync(path.dirname(legacyIssueSourcePath), { recursive: true });
  fs.writeFileSync(legacyIssueSourcePath, Buffer.from([0xff, 0x00, 0x49]));
  fs.writeFileSync(legacyIssueLogPath, Buffer.from([0x00, 0xfe, 0x4c]));
  writeReadyV3ExemptChange(repository);
  renderHandoff(repository);
  const managedPaths = [
    'docs/issues/issues.yaml',
    'docs/ISSUE_LOG.md',
    'docs/CURRENT_AND_NEXT_STEPS.md',
  ].map((relativePath) => path.join(repository, relativePath));
  const before = new Map(
    managedPaths.map((filePath) => [
      filePath,
      {
        bytes: fs.readFileSync(filePath),
        mode: fs.statSync(filePath).mode & 0o777,
      },
    ]),
  );
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  let stdout = '';
  let stderr = '';
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const issueExitCode = runCli(
      [
        'issue',
        'add',
        '--id',
        'ISS-199',
        '--category',
        'bug',
        '--title',
        'Retired command',
        '--status',
        'blocked',
        '--priority',
        'Now',
        '--notes',
        'This command must not mutate repository state.',
        '--json',
      ],
      repository,
    );
    assert.equal(issueExitCode, ExitCode.usage);
    assert.equal(
      (JSON.parse(stderr) as { error: { code: string } }).error.code,
      'INVALID_USAGE',
    );
    for (const [filePath, expected] of before) {
      assert.deepEqual(fs.readFileSync(filePath), expected.bytes);
      assert.equal(fs.statSync(filePath).mode & 0o777, expected.mode);
    }

    stdout = '';
    stderr = '';
    assert.equal(runCli(['work-item', 'list', '--json'], repository), 0);
    assert.equal(
      (JSON.parse(stdout) as { command: string }).command,
      'work-item',
    );
    assert.equal(stderr, '');
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('a terminal JSON-looking option value is not consumed as output mode', () => {
  const repository = createFixtureRepository();
  try {
    assert.equal(
      runCli(
        ['abort', 'session-does-not-exist', '--reason', '--json'],
        repository,
      ),
      ExitCode.staleState,
    );
    assert.equal(
      runCli(
        ['abort', 'session-does-not-exist', '--reason', '--json', '--json'],
        repository,
      ),
      ExitCode.staleState,
    );
    for (const trailingOutputFlag of [false, true]) {
      assert.equal(
        runCli(
          [
            'document-refresh',
            'review',
            '--proposal',
            '0'.repeat(64),
            '--decision',
            'approve',
            '--reviewer',
            '--json',
            ...(trailingOutputFlag ? ['--json'] : []),
          ],
          repository,
        ),
        ExitCode.staleState,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('completion report validation rejects a task absent from the baseline', () => {
  const completionReport = {
    ...report(),
    completedTaskIds: ['9.9'],
  };
  assert.throws(
    () =>
      assertCompletionTaskIds(
        completionReport,
        {
          baselineTasks: '# Tasks\n\n- [ ] 1.1 Existing task\n',
          session: { taskId: '9.9' },
        } as never,
        'REPORT_TASK_SCOPE_STALE',
      ),
    (error) => isWorkflowError(error, 'REPORT_TASK_SCOPE_STALE'),
  );
});

function report(): WorkflowReport {
  return {
    schemaVersion: 1,
    kind: 'check',
    sessionId: SESSION_ID,
    changeId: 'demo-change',
    taskId: '1.1',
    createdAt: '2026-01-01T00:00:00.000Z',
    planningAssurance: null,
  };
}

function aggregateContains(
  error: unknown,
  operationError: Error,
  releaseCode: string,
): boolean {
  return (
    error instanceof AggregateError &&
    error.errors.includes(operationError) &&
    error.errors.some(
      (nested) =>
        nested instanceof WorkflowError && nested.code === releaseCode,
    )
  );
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
