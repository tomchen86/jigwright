import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  createPreparedOpenTaskJournal,
  advanceOpenTaskJournalPhase,
} from '../src/modules/lifecycle/open-task-journal.ts';
import {
  readOpenTaskJournalAtRoot,
  listOpenTaskJournalsAtRoot,
  publishPreparedJournal,
  replaceJournal,
} from '../src/runtime/storage-journal/open-task-journal.ts';

function fixture(t: TestContext) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'open-task-journal-')),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journal = createPreparedOpenTaskJournal({
    changeId: 'demo-change',
    taskId: '1.1',
    mandateTaskId: null,
    mandateBinding: null,
    authorizationPolicyDigest: 'sha256:' + 'a'.repeat(64),
    repositoryRoot: '/repository',
    gitCommonDirectory: '/repository/.git',
    worktree: '/repository',
    branch: 'work/demo-change',
    parentCommit: '1'.repeat(40),
    parentTree: '2'.repeat(40),
    planningCommit: '3'.repeat(40),
    baselineTree: '4'.repeat(40),
    reportId: 'b'.repeat(64),
    changedPaths: ['openspec/changes/demo-change/tasks.md'],
    sessionId: 'session-one',
    createdAt: '2026-10-24T10:00:00.000Z',
  });
  const directory = path.join(root, 'open-task', 'transactions');
  const file = path.join(directory, 'demo-change.1.1.json');
  return { root, journal, directory, file };
}

test('open-task store reads absence without creating directories and publishes exact private bytes', (t) => {
  const { root, journal, directory, file } = fixture(t);
  assert.equal(readOpenTaskJournalAtRoot(root, 'demo-change', '1.1'), null);
  assert.deepEqual(listOpenTaskJournalsAtRoot(root), []);
  assert.equal(fs.existsSync(path.dirname(directory)), false);
  publishPreparedJournal(root, journal);
  assert.equal(fs.readFileSync(file, 'utf8'), canonicalJson(journal) + '\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  for (const folder of [path.dirname(directory), directory]) {
    assert.equal(fs.statSync(folder).mode & 0o777, 0o700);
  }
  assert.deepEqual(
    readOpenTaskJournalAtRoot(root, 'demo-change', '1.1'),
    journal,
  );
  assert.deepEqual(listOpenTaskJournalsAtRoot(root), [journal]);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});

test('open-task publication reuses exact EEXIST and rejects a different transaction without clobbering', (t) => {
  const { root, journal, directory, file } = fixture(t);
  publishPreparedJournal(root, journal);
  const bytes = fs.readFileSync(file);
  const inode = fs.statSync(file).ino;
  publishPreparedJournal(root, journal);
  assert.equal(fs.statSync(file).ino, inode);
  const different = createPreparedOpenTaskJournal({
    ...journal,
    sessionId: 'different-session',
  });
  assert.throws(() => publishPreparedJournal(root, different), {
    code: 'OPEN_TASK_TRANSACTION_CONFLICT',
    exitCode: 11,
    message: 'A different durable open-task transaction already exists.',
  });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).ino, inode);
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});

test('open-task replacement compares the previous record before publishing the next phase', (t) => {
  const { root, journal, directory, file } = fixture(t);
  publishPreparedJournal(root, journal);
  const committed = advanceOpenTaskJournalPhase(journal, 'plan-committed');
  replaceJournal(root, journal, committed);
  const bytes = fs.readFileSync(file);
  const inode = fs.statSync(file).ino;
  const active = advanceOpenTaskJournalPhase(committed, 'session-active');
  assert.throws(() => replaceJournal(root, journal, active), {
    code: 'OPEN_TASK_JOURNAL_CORRUPT',
    exitCode: 14,
    message: 'Open-task journal changed before phase advancement.',
  });
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).ino, inode);
  replaceJournal(root, committed, active);
  assert.equal(fs.readFileSync(file, 'utf8'), canonicalJson(active) + '\n');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    readOpenTaskJournalAtRoot(root, 'demo-change', '1.1'),
    active,
  );
  assert.deepEqual(fs.readdirSync(directory), [path.basename(file)]);
});

test('open-task store rejects noncanonical bytes including a missing or extra terminal LF', (t) => {
  const { root, journal, file } = fixture(t);
  publishPreparedJournal(root, journal);
  for (const bytes of [
    canonicalJson(journal),
    canonicalJson(journal) + '\n\n',
    JSON.stringify(journal, null, 2) + '\n',
  ]) {
    fs.writeFileSync(file, bytes);
    assert.throws(() => readOpenTaskJournalAtRoot(root, 'demo-change', '1.1'), {
      code: 'OPEN_TASK_JOURNAL_CORRUPT',
      exitCode: 14,
      message: 'Open-task journal bytes are not canonical.',
    });
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
});

test('open-task store rejects symlinks without changing their targets', (t) => {
  const { root, journal, file } = fixture(t);
  publishPreparedJournal(root, journal);
  const target = path.join(root, 'target.json');
  fs.renameSync(file, target);
  const bytes = fs.readFileSync(target);
  fs.symlinkSync(target, file);
  assert.throws(() => readOpenTaskJournalAtRoot(root, 'demo-change', '1.1'), {
    code: 'OPEN_TASK_JOURNAL_CORRUPT',
    exitCode: 14,
    message: 'Open-task journal file is unsafe.',
  });
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true);
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test('open-task store rejects oversize records and nonprivate file or directory modes', (t) => {
  const { root, journal, directory, file } = fixture(t);
  publishPreparedJournal(root, journal);
  fs.writeFileSync(file, ' '.repeat(128 * 1024 + 1));
  assert.throws(() => readOpenTaskJournalAtRoot(root, 'demo-change', '1.1'), {
    code: 'OPEN_TASK_JOURNAL_CORRUPT',
    exitCode: 14,
    message: 'Open-task journal file is unsafe.',
  });
  fs.writeFileSync(file, canonicalJson(journal) + '\n');
  fs.chmodSync(file, 0o644);
  assert.throws(() => readOpenTaskJournalAtRoot(root, 'demo-change', '1.1'), {
    code: 'OPEN_TASK_JOURNAL_CORRUPT',
    exitCode: 14,
    message: 'Open-task journal file is unsafe.',
  });
  fs.chmodSync(file, 0o600);
  fs.chmodSync(directory, 0o755);
  assert.throws(() => readOpenTaskJournalAtRoot(root, 'demo-change', '1.1'), {
    code: 'OPEN_TASK_JOURNAL_CORRUPT',
    exitCode: 14,
    message: 'Open-task runtime directory is unsafe.',
  });
});
