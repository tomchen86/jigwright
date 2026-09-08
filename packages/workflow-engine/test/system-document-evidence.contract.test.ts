import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  observeSystemDocumentTests,
  systemDocumentTestOutcomes,
} from '../src/runtime/managed-documents/validation/system-test-evidence.ts';
import { workingSystemDescriptionSnapshot } from '../src/runtime/managed-documents/validation/system-document-snapshot.ts';
import {
  createFullGateIdentity,
  createFullGateReceipt,
  validateFullGateCoverage,
} from '../../../scripts/full-gate-progress.ts';
import { digestWorkflowTestFileSet } from '../../../scripts/workflow-test-inventory.ts';
import { serializeFullGateTelemetryRecord } from '../../../scripts/full-gate-reporter.ts';

test('bounded documents tests retain exact native outcomes and reject stale source evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'system-doc-evidence-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    fs.writeFileSync(
      path.join(root, 'example.test.mjs'),
      "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport fs from 'node:fs';\nif (fs.existsSync(new URL('.git/stop', import.meta.url))) throw new Error('module failed before tests');\ntest('pass exactly', () => {});\ntest.skip('skip honestly', () => {});\ntest('fail honestly', () => { throw new Error('expected failure'); });\ntest('repository working directory', () => assert.equal(fs.realpathSync(process.cwd()), fs.realpathSync(import.meta.dirname)));\ntest('duplicate name', () => {});\ntest('duplicate name', () => { throw new Error('second case failed'); });\n",
    );
    const selected = [
      { file: 'example.test.mjs', name: 'pass exactly' },
      { file: 'example.test.mjs', name: 'skip honestly' },
      { file: 'example.test.mjs', name: 'fail honestly' },
      { file: 'example.test.mjs', name: 'repository working directory' },
      { file: 'example.test.mjs', name: 'duplicate name' },
    ];
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    const entry = new URL(
      '../src/runtime/managed-documents/validation/system-test-evidence.ts',
      import.meta.url,
    ).href;
    const runner = path.join(root, '.git/observe.mjs');
    fs.writeFileSync(
      runner,
      `import { observeSystemDocumentTests } from ${JSON.stringify(entry)}; process.stdout.write(JSON.stringify(await observeSystemDocumentTests(process.argv[2], ${JSON.stringify(selected)})));`,
    );
    const observation = JSON.parse(
      execFileSync(process.execPath, [runner, root], {
        cwd: path.join(root, '.git'),
        env: environment,
        encoding: 'utf8',
      }),
    );
    assert.equal(observation.tests.length, 6);
    let outcomes = systemDocumentTestOutcomes(
      root,
      workingSystemDescriptionSnapshot(root),
    );
    assert.equal(outcomes('example.test.mjs', 'pass exactly'), 'passed');
    assert.equal(outcomes('example.test.mjs', 'skip honestly'), 'skipped');
    assert.equal(outcomes('example.test.mjs', 'fail honestly'), 'not-passed');
    assert.equal(
      outcomes('example.test.mjs', 'repository working directory'),
      'passed',
    );
    assert.equal(outcomes('example.test.mjs', 'duplicate name'), 'not-passed');
    assert.equal(outcomes('example.test.mjs', 'invented name'), 'missing');
    fs.writeFileSync(
      path.join(root, 'spec.md'),
      '# Contract metadata changes\n',
    );
    outcomes = systemDocumentTestOutcomes(
      root,
      workingSystemDescriptionSnapshot(root),
    );
    assert.equal(outcomes('example.test.mjs', 'pass exactly'), 'stale');
    fs.unlinkSync(path.join(root, 'spec.md'));
    fs.writeFileSync(path.join(root, '.git/stop'), 'stop');
    execFileSync(process.execPath, [runner, root], {
      cwd: root,
      env: environment,
    });
    outcomes = systemDocumentTestOutcomes(
      root,
      workingSystemDescriptionSnapshot(root),
    );
    assert.notEqual(outcomes('example.test.mjs', 'pass exactly'), 'passed');
    fs.appendFileSync(
      path.join(root, 'example.test.mjs'),
      '\n// changed source\n',
    );
    outcomes = systemDocumentTestOutcomes(
      root,
      workingSystemDescriptionSnapshot(root),
    );
    assert.equal(outcomes('example.test.mjs', 'pass exactly'), 'stale');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('nested native proof falls back once while preserving exact selection and all non-passing facts', async () => {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'nested-doc-evidence-')),
  );
  const file = 'nested.test.mjs';
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    fs.writeFileSync(path.join(root, 'source-input.json'), '{"version":0}\n');
    fs.writeFileSync(
      path.join(root, file),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "import fs from 'node:fs';",
        "const privateFile = name => new URL('.git/' + name, import.meta.url);",
        "const counter = privateFile('runs');",
        "const run = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 1;",
        'fs.writeFileSync(counter, String(run));',
        "if (fs.existsSync(privateFile('stop')) || (run === 2 && fs.existsSync(privateFile('stop-fallback')))) throw new Error('module failed before registering tests');",
        "if (fs.existsSync(privateFile('mutate-source'))) fs.writeFileSync(new URL('source-input.json', import.meta.url), '{\"version\":' + (run === 1 ? '1' : '0') + '}\\n');",
        "test('top exact', () => {});",
        "test('top initially fails', () => assert.ok(run > 1));",
        "test('top initially skips', { skip: run === 1 }, () => {});",
        "test('outer', async t => {",
        "  await t.test('nested pass', () => {});",
        "  await t.test('nested fail', () => assert.fail('real child failure'));",
        "  await t.test('nested skip', { skip: true }, () => {});",
        "  await t.test('nested duplicate', () => {});",
        "  await t.test('nested duplicate', () => assert.fail('second child failed'));",
        '});',
        "test('unrelated', () => fs.writeFileSync(privateFile('unrelated-ran'), 'ran'));",
        '',
      ].join('\n'),
    );
    const observe = (names: string[]) =>
      observeSystemDocumentTests(
        root,
        names.map((name) => ({ file, name })),
      );
    const outcomes = () =>
      systemDocumentTestOutcomes(root, workingSystemDescriptionSnapshot(root));
    const runCount = () =>
      Number(fs.readFileSync(path.join(root, '.git/runs'), 'utf8'));

    const exact = await observe(['top exact', 'top initially skips']);
    assert.equal(exact.sourceStable, true);
    assert.equal(runCount(), 1);
    assert.deepEqual(
      exact.tests.map((record) => [record.name, record.outcome]),
      [
        ['top exact', 'passed'],
        ['top initially skips', 'skipped'],
      ],
    );
    assert.equal(fs.existsSync(path.join(root, '.git/unrelated-ran')), false);

    fs.writeFileSync(path.join(root, '.git/runs'), '0');
    const nested = await observe([
      'top initially fails',
      'top initially skips',
      'nested pass',
      'nested fail',
      'nested skip',
      'nested duplicate',
      'missing forever',
    ]);
    assert.equal(nested.sourceStable, true);
    assert.equal(outcomes()(file, 'nested pass'), 'passed');
    assert.equal(runCount(), 2, 'Only one complete-file fallback may run');
    assert.equal(outcomes()(file, 'nested fail'), 'not-passed');
    assert.equal(outcomes()(file, 'nested skip'), 'skipped');
    assert.equal(outcomes()(file, 'nested duplicate'), 'not-passed');
    assert.equal(outcomes()(file, 'missing forever'), 'missing');
    assert.deepEqual(
      nested.tests
        .filter((record) => record.name === 'top initially fails')
        .map((record) => record.outcome),
      ['not-passed', 'passed'],
    );
    assert.deepEqual(
      nested.tests
        .filter((record) => record.name === 'top initially skips')
        .map((record) => record.outcome),
      ['skipped', 'passed'],
    );
    assert.equal(outcomes()(file, 'top initially fails'), 'not-passed');
    assert.equal(outcomes()(file, 'top initially skips'), 'skipped');
    assert.equal(fs.existsSync(path.join(root, '.git/unrelated-ran')), true);

    fs.writeFileSync(path.join(root, '.git/runs'), '0');
    fs.writeFileSync(path.join(root, '.git/stop-fallback'), 'stop');
    await observe(['top exact', 'nested pass']);
    assert.equal(runCount(), 2);
    assert.equal(outcomes()(file, 'top exact'), 'not-passed');
    assert.equal(outcomes()(file, 'nested pass'), 'not-passed');
    fs.unlinkSync(path.join(root, '.git/stop-fallback'));

    fs.writeFileSync(path.join(root, '.git/runs'), '0');
    fs.writeFileSync(path.join(root, '.git/stop'), 'stop');
    await observe(['nested pass', 'missing forever']);
    assert.equal(
      runCount(),
      1,
      'A whole-file failure must not trigger a second attempt',
    );
    assert.equal(outcomes()(file, 'nested pass'), 'not-passed');
    fs.unlinkSync(path.join(root, '.git/stop'));

    fs.writeFileSync(path.join(root, '.git/runs'), '0');
    fs.writeFileSync(path.join(root, '.git/mutate-source'), 'mutate');
    const drifted = await observe(['nested pass']);
    assert.equal(drifted.sourceStable, false);
    assert.equal(
      runCount(),
      1,
      'Changed source must not be retried against another snapshot',
    );
    assert.equal(outcomes()(file, 'nested pass'), 'stale');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('documents reuse native full-gate telemetry only at the matching source snapshot', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'system-doc-gate-evidence-'),
  );
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(root, 'packages/workflow-engine/test'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(root, 'native-fixture.bin'),
      Buffer.from([0xff, 0xfe, 0, 42]),
    );
    fs.writeFileSync(
      path.join(root, 'packages/workflow-engine/test/example.test.ts'),
      "import test from 'node:test'; test('existing proof', () => {});\n",
    );
    git(
      'add',
      'packages/workflow-engine/test/example.test.ts',
      'native-fixture.bin',
    );
    const tree = git('write-tree');
    const identity = createFullGateIdentity({
      projectedTreeOid: tree,
      generatedArtifactsDigest: `sha256:${'a'.repeat(64)}`,
      command: ['node', '--test'],
      workingDirectory: '.',
      nodeVersion: process.version,
      platform: process.platform,
    });
    const records = [
      {
        kind: 'workflow-full-gate-test-telemetry.v1' as const,
        sequence: 1,
        testNumber: 1,
        file: 'packages/workflow-engine/test/example.test.ts',
        line: 1,
        name: 'existing proof',
        nesting: 0,
        outcome: 'passed' as const,
        durationMs: 1,
      },
    ];
    const telemetry = Buffer.from(
      records.map(serializeFullGateTelemetryRecord).join('') +
        serializeFullGateTelemetryRecord({
          kind: 'workflow-full-gate-test-telemetry-end.v1',
          recordCount: 1,
        }),
    );
    const stdout = Buffer.from(
      'TAP version 13\nok 1 - existing proof\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n',
    );
    const runId = 'run-20260908000000000-11111111-1111-1111-1111-111111111111';
    const receipt = createFullGateReceipt({
      runId,
      identity,
      headCommit: 'b'.repeat(40),
      completedHeadCommit: 'b'.repeat(40),
      completedIdentityDigest: identity.digest,
      identityStable: true,
      reason: null,
      exitCode: 0,
      signal: null,
      rawLog: stdout,
      coverage: validateFullGateCoverage(telemetry, {
        inventoryDigest: `sha256:${'c'.repeat(64)}`,
        expectedFiles: ['packages/workflow-engine/test/example.test.ts'],
        expectedFileSetDigest: digestWorkflowTestFileSet([
          'packages/workflow-engine/test/example.test.ts',
        ]),
      }),
      completedAt: '2026-09-08T00:00:00.000Z',
    });
    const state = path.join(root, '.git/workflow-engine/full-gate');
    const run = path.join(state, 'runs', runId);
    fs.mkdirSync(run, { recursive: true });
    fs.mkdirSync(path.join(state, 'receipts'), { recursive: true });
    fs.writeFileSync(path.join(run, 'test-telemetry.jsonl'), telemetry);
    fs.writeFileSync(path.join(run, 'stdout.log'), stdout);
    fs.writeFileSync(path.join(run, 'stderr.log'), '');
    fs.writeFileSync(
      path.join(state, 'receipts', `${runId}.json`),
      JSON.stringify(receipt),
    );
    assert.equal(
      systemDocumentTestOutcomes(root, workingSystemDescriptionSnapshot(root))(
        'packages/workflow-engine/test/example.test.ts',
        'existing proof',
      ),
      'passed',
    );
    fs.appendFileSync(
      path.join(root, 'packages/workflow-engine/test/example.test.ts'),
      '// new source\n',
    );
    assert.equal(
      systemDocumentTestOutcomes(root, workingSystemDescriptionSnapshot(root))(
        'packages/workflow-engine/test/example.test.ts',
        'existing proof',
      ),
      'stale',
    );
    fs.appendFileSync(path.join(run, 'test-telemetry.jsonl'), '{}\n');
    assert.equal(
      systemDocumentTestOutcomes(root, workingSystemDescriptionSnapshot(root))(
        'packages/workflow-engine/test/example.test.ts',
        'existing proof',
      ),
      'missing',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
