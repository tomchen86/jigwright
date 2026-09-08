import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGovernanceSourceV1 } from '@jigwright/core/governance-source';
import { systemDocumentContext } from '../src/modules/source/system-document-context.ts';
import { taskSystemDocumentContext } from '../src/runtime/managed-documents/validation/task-system-document-context.ts';

test('task context resolves ancestor contracts and exact Source wording without opaque metadata', () => {
  const source = createGovernanceSourceV1({
    semanticAuthor: 'maintainer',
    capturedBy: 'jigwright',
    capturedAt: '2026-09-08T00:00:00.000Z',
    contextRef: 'direct-human:context-test',
    text: '  Keep every word.\r\nAnd every line.  ',
    supersedes: null,
  });
  const files = new Map([
    ['spec.md', '# Shared contract\n## Purpose\nShared promise.\n'],
    [
      'src/modules/a/spec.md',
      `# Capture\n## Purpose\nKeep words.\n## Requirements\n### Requirement: Exact wording\nsources: [${source.id}]\nThe capture SHALL preserve wording.\n#### Scenario: Verbatim\ncovers: file.ts#Invariants[1]\ntest: test/a.test.ts#verbatim\n- **THEN** unchanged\n`,
    ],
    [
      'src/modules/a/file.ts',
      '/** Capture wording.\n * Invariants:\n * - Whitespace stays intact.\n */\nexport const value = 1;',
    ],
    ['src/modules/ab/spec.md', '# Unrelated\n## Purpose\nSibling.\n'],
    [
      `workflow/source-ledger/objects/sha256/${source.id.slice(4, 6)}/${source.id.slice(4)}.json`,
      JSON.stringify(source),
    ],
  ]);
  const context = systemDocumentContext(
    { listPaths: () => [...files.keys()], readText: (p) => files.get(p) },
    ['src/modules/a/**'],
  );
  assert.deepEqual(
    context.contracts.map((d) => d.path),
    ['spec.md', 'src/modules/a/spec.md'],
  );
  assert.equal(context.sources[0]?.originalText, source.text);
  assert.equal(context.files[0]?.invariants[0], 'Whitespace stays intact.');
  assert.match(context.contracts[1]!.text, /SHALL preserve wording/);
  assert.doesNotMatch(
    JSON.stringify(context),
    /SRC-[0-9a-f]{64}|sources:|covers:|test:/,
  );
  const future = systemDocumentContext(
    { listPaths: () => [...files.keys()], readText: (p) => files.get(p) },
    ['src/modules/new/file.ts'],
  );
  assert.deepEqual(
    future.contracts.map((d) => d.path),
    ['spec.md'],
  );
});

test('task context uses committed baseline bytes after working documents change', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-task-context-'),
  );
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    git(['init', '-q']);
    fs.writeFileSync(
      path.join(root, 'spec.md'),
      '# Baseline\n## Purpose\nOriginal contract.\n',
    );
    git(['add', '.']);
    git([
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'Baseline',
    ]);
    const baseline = {
      head: git(['rev-parse', 'HEAD']),
      tree: git(['rev-parse', 'HEAD^{tree}']),
    };
    fs.writeFileSync(path.join(root, 'spec.md'), '# MUTABLE CHECKOUT\n');
    const context = taskSystemDocumentContext({
      repositoryRoot: root,
      baseline,
      allowedPaths: ['src/future.ts'],
    });
    assert.match(context.contracts[0]!.text, /Original contract/);
    assert.doesNotMatch(context.contracts[0]!.text, /MUTABLE/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
