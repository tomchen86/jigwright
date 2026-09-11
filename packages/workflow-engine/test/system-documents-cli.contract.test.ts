import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { captureGovernanceSource } from '../src/modules/governance-intake/governance-intake.ts';
import { inspectProjectionStatus } from '../src/composition-root/projection-status-production.ts';
import { readSystemDescriptionSnapshot } from '../src/runtime/repository-transaction/system-description-snapshot.ts';
import { validateManagedDocuments } from '../src/runtime/managed-documents/validation/managed-documents.ts';

test('documents CLI produces proof before validation and renders from the same canonical snapshot', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'system-doc-cli-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    fs.mkdirSync(path.join(root, 'workflow'));
    fs.writeFileSync(
      path.join(root, 'workflow/document-policy.json'),
      JSON.stringify({
        schemaVersion: 1,
        enforcementMode: 'enforced',
        documents: {},
      }),
    );
    const source = captureGovernanceSource(root, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-09-08T00:00:00.000Z',
      contextRef: 'direct-human:system-doc-cli',
      text: 'Keep the original wording exactly.\n',
      supersedes: null,
    }).source;
    fs.writeFileSync(
      path.join(root, 'workflow/source-ledger/aliases.json'),
      JSON.stringify({
        schemaVersion: 1,
        aliases: {
          'R-001': { title: 'Exact original wording', sourceRefs: [source.id] },
        },
      }),
    );
    fs.writeFileSync(
      path.join(root, 'spec.md'),
      [
        '# Sample contract',
        '## Purpose',
        'Preserve exact words.',
        '## Requirements',
        '### Requirement: Exact words',
        `sources: [${source.id}]`,
        'The implementation SHALL preserve words.',
        '#### Scenario: Exact input',
        'covers: #Requirement: Exact words',
        'test: sample.test.mjs#preserves words',
        '- **WHEN** input is given',
        '- **THEN** preserve it',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(root, 'sample.test.mjs'),
      "import test from 'node:test'; import assert from 'node:assert/strict'; test('preserves words', () => assert.equal(' 原話 ', ' 原話 '));\n",
    );
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.invalid',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-qm',
        'Fixture',
      ],
      { cwd: root },
    );
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    const cli = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
          'documents',
          ...args,
          '--json',
        ],
        { cwd: root, env: environment, encoding: 'utf8' },
      );
    assert.notEqual(cli('validate').status, 0);
    const proof = cli('test', '--spec', 'spec.md');
    assert.equal(proof.status, 0, proof.stderr);
    assert.equal(JSON.parse(proof.stdout).tests[0].outcome, 'passed');
    const render = cli('render');
    assert.equal(render.status, 0, render.stderr);
    const validation = cli('validate');
    assert.equal(validation.status, 0, validation.stderr);
    assert.deepEqual(JSON.parse(validation.stdout).validated, [
      'spec.md',
      'docs/SPEC_MAP.md',
      'docs/COVERAGE.md',
      'docs/REQUIREMENTS.md',
    ]);
    const documentStatuses = inspectProjectionStatus(root).filter((row) =>
      row.id.startsWith('documents.'),
    );
    assert.deepEqual(
      Object.fromEntries(documentStatuses.map(({ id, state }) => [id, state])),
      {
        'documents.governance-intake-readme': 'not-configured',
        'documents.authority-readme': 'not-configured',
        'documents.provider-orchestration-readme': 'not-configured',
        'documents.adoption-readme': 'not-configured',
        'documents.assurance-readme': 'not-configured',
        'documents.guidance-readme': 'not-configured',
        'documents.investigation-readme': 'not-configured',
        'documents.lifecycle-readme': 'not-configured',
        'documents.planning-provider-readme': 'not-configured',
        'documents.projection-readme': 'not-configured',
        'documents.repository-consumer-readme': 'not-configured',
        'documents.source-readme': 'not-configured',
        'documents.why-knowledge-readme': 'not-configured',
        'documents.spec-map': 'current',
        'documents.coverage': 'current',
        'documents.requirements': 'current',
      },
    );
    execFileSync('git', ['add', 'docs'], { cwd: root });
    const tree = execFileSync('git', ['write-tree'], {
      cwd: root,
      encoding: 'utf8',
    }).trim();
    const pinned = readSystemDescriptionSnapshot(root, tree);
    const originalSpec = fs.readFileSync(path.join(root, 'spec.md'), 'utf8');
    fs.writeFileSync(
      path.join(root, 'spec.md'),
      originalSpec.replace('Preserve exact words.', 'TBD'),
    );
    assert.deepEqual(
      validateManagedDocuments(root, {
        contracts: [],
        readText: pinned.readText,
        systemDescriptionSnapshot: pinned,
      }),
      JSON.parse(validation.stdout).validated,
    );
    assert.notEqual(cli('validate').status, 0);
    fs.writeFileSync(path.join(root, 'spec.md'), originalSpec);
    assert.ok(
      fs
        .readFileSync(path.join(root, 'docs/REQUIREMENTS.md'), 'utf8')
        .includes('> Keep the original wording exactly.'),
    );
    fs.appendFileSync(
      path.join(root, 'sample.test.mjs'),
      '// changed source\n',
    );
    const stale = cli('validate');
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /stale/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
