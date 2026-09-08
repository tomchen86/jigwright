import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureGovernanceSource,
  listGovernanceSources,
  readGovernanceSource,
} from '../src/modules/governance-intake/governance-intake.ts';
import { recordGovernanceFinding } from '../src/composition-root/governance-findings-production.ts';
import { dispatchGovernanceIntakeCommand } from '../src/entrypoints/cli/governance-intake-cli.ts';
import { runCli } from '../src/cli.ts';
import { workflowResultNextSteps } from '../src/modules/guidance/next-steps/workflow-guidance.ts';
import { renderHandoff } from '../src/adapters/consumer/repository/handoff/handoff.ts';
import {
  loadRepositoryConsumerConfiguration,
  repositoryConsumerConfigurationExists,
} from '../src/modules/repository-consumer/repository-consumer-config.ts';
import {
  linkSourceToChange,
  reconcileArchivedWorkItems,
  validateWorkRegistry,
} from '../src/modules/governance-intake/work-registry.ts';
import {
  createGovernancePersistenceFixture,
  changeFindingRecordForTest,
  readFindingRecordForTest,
  snapshotGovernancePersistence,
  runGitForTest,
  configureRepositoryConsumer,
  hasCode,
} from './governance-intake-fixture.ts';

test('source capture is content-addressed, append-only, and idempotent', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-source-ledger-'),
  );
  try {
    const input = {
      semanticAuthor: 'maintainer' as const,
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:10:00.000Z',
      contextRef: 'direct-human:thread/turn-43',
      text: 'Keep every coherent MVP slice committed.\n',
      supersedes: null,
    };

    const first = captureGovernanceSource(repositoryRoot, input);
    const second = captureGovernanceSource(repositoryRoot, input);
    assert.deepEqual(second.source, first.source);
    assert.equal(second.relativePath, first.relativePath);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.match(
      first.relativePath,
      /^workflow\/source-ledger\/objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/,
    );
    const bytes = fs.readFileSync(
      path.join(repositoryRoot, first.relativePath),
      'utf8',
    );
    assert.equal(`${JSON.stringify(JSON.parse(bytes))}\n`, bytes);
    assert.equal(JSON.parse(bytes).text, input.text);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Source ledger list and configured registry validation reject every noncanonical entry without mutation', () => {
  const cases = [
    {
      name: 'noncanonical entry at the ledger root',
      poison(fixture: ReturnType<typeof createGovernancePersistenceFixture>) {
        fs.writeFileSync(
          path.join(fixture.sourceLedgerRoot, 'README.md'),
          'poison\n',
        );
      },
    },
    {
      name: 'noncanonical prefix directory',
      poison(fixture: ReturnType<typeof createGovernancePersistenceFixture>) {
        const prefix = path.join(fixture.sourceLedgerRoot, 'zz');
        fs.mkdirSync(prefix);
        fs.writeFileSync(path.join(prefix, 'sentinel.txt'), 'poison\n');
      },
    },
    {
      name: 'noncanonical entry inside a valid prefix',
      poison(fixture: ReturnType<typeof createGovernancePersistenceFixture>) {
        fs.writeFileSync(
          path.join(path.dirname(fixture.sourcePath), 'README.md'),
          'poison\n',
        );
      },
    },
  ] as const;

  for (const scenario of cases) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jigwright-source-ledger-traversal-'),
    );
    try {
      const fixture = createGovernancePersistenceFixture(root);
      scenario.poison(fixture);
      const before = snapshotGovernancePersistence(fixture);

      assert.throws(
        () => listGovernanceSources(fixture.repositoryRoot),
        hasCode('GOVERNANCE_INTAKE_INVALID'),
        `source list: ${scenario.name}`,
      );
      assert.throws(
        () => validateWorkRegistry(fixture.repositoryRoot),
        hasCode('GOVERNANCE_INTAKE_INVALID'),
        `configured registry: ${scenario.name}`,
      );
      assert.deepEqual(snapshotGovernancePersistence(fixture), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('current Source and Finding create-only admission rejects unsafe identities without mutation', () => {
  const cases = [
    {
      name: 'Source mode differs from the current writer',
      poison(fixture: ReturnType<typeof createGovernancePersistenceFixture>) {
        fs.chmodSync(fixture.sourcePath, 0o600);
        return [] as string[];
      },
      assertRejected(
        fixture: ReturnType<typeof createGovernancePersistenceFixture>,
      ) {
        assert.throws(
          () =>
            readGovernanceSource(
              fixture.repositoryRoot,
              fixture.source.source.id,
            ),
          hasCode('GOVERNANCE_INTAKE_INVALID'),
        );
        assert.throws(
          () =>
            captureGovernanceSource(
              fixture.repositoryRoot,
              fixture.sourceInput,
            ),
          hasCode('GOVERNANCE_SOURCE_COLLISION'),
        );
      },
    },
    {
      name: 'Source has a second hard link',
      poison(fixture: ReturnType<typeof createGovernancePersistenceFixture>) {
        const target = path.join(fixture.root, 'source-hardlink.json');
        fs.linkSync(fixture.sourcePath, target);
        return [target];
      },
      assertRejected(
        fixture: ReturnType<typeof createGovernancePersistenceFixture>,
      ) {
        assert.throws(
          () =>
            readGovernanceSource(
              fixture.repositoryRoot,
              fixture.source.source.id,
            ),
          hasCode('GOVERNANCE_INTAKE_INVALID'),
        );
        assert.throws(
          () =>
            captureGovernanceSource(
              fixture.repositoryRoot,
              fixture.sourceInput,
            ),
          hasCode('GOVERNANCE_SOURCE_COLLISION'),
        );
      },
    },
    {
      name: 'Finding is an executable Git blob',
      poison(fixture: ReturnType<typeof createGovernancePersistenceFixture>) {
        changeFindingRecordForTest(
          fixture.repositoryRoot,
          fixture.finding.path,
          readFindingRecordForTest(
            fixture.repositoryRoot,
            fixture.finding.path,
          ).toString('utf8'),
          '100755',
        );
        return [] as string[];
      },
      assertRejected(
        fixture: ReturnType<typeof createGovernancePersistenceFixture>,
      ) {
        assert.throws(
          () =>
            recordGovernanceFinding(
              fixture.findingContext,
              fixture.findingInput,
              fixture.findingNow,
            ),
          hasCode('GOVERNANCE_FINDING_STORE_UNSAFE'),
        );
      },
    },
    {
      name: 'Finding canonical identity drift',
      poison(fixture: ReturnType<typeof createGovernancePersistenceFixture>) {
        changeFindingRecordForTest(
          fixture.repositoryRoot,
          fixture.finding.path,
          '{}\n',
        );
        return [] as string[];
      },
      assertRejected(
        fixture: ReturnType<typeof createGovernancePersistenceFixture>,
      ) {
        assert.throws(
          () =>
            recordGovernanceFinding(
              fixture.findingContext,
              fixture.findingInput,
              fixture.findingNow,
            ),
          hasCode('GOVERNANCE_INTAKE_INVALID'),
        );
      },
    },
  ] as const;

  for (const scenario of cases) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jigwright-governance-create-only-'),
    );
    try {
      const fixture = createGovernancePersistenceFixture(root);
      assert.equal(fs.lstatSync(fixture.sourcePath).mode & 0o777, 0o644);
      if (typeof process.getuid === 'function') {
        assert.equal(fs.lstatSync(fixture.sourcePath).uid, process.getuid());
      }
      assert.equal(
        captureGovernanceSource(fixture.repositoryRoot, fixture.sourceInput)
          .created,
        false,
      );
      assert.equal(
        recordGovernanceFinding(
          fixture.findingContext,
          fixture.findingInput,
          fixture.findingNow,
        ).created,
        false,
      );
      const targets = scenario.poison(fixture);
      const before = snapshotGovernancePersistence(fixture, targets);

      scenario.assertRejected(fixture);
      assert.deepEqual(snapshotGovernancePersistence(fixture, targets), before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('top-level help advertises every current Governance Source command', () => {
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
    /pnpm workflow source <capture [^\n]+\|link-change [^\n]+\|list\|show <source-id>\|trace <source-id>> \[--json\]/u,
  );
  assert.match(
    output,
    /pnpm workflow now <original-text> \[--kind <kind>\] \[--json\]/u,
  );
  assert.match(output, /pnpm workflow now <work-item-id> \[--json\]/u);
  assert.match(
    output,
    /pnpm workflow later <original-text> \[--kind <kind>\] \[--json\]/u,
  );
  assert.match(
    output,
    /pnpm workflow attach <work-item-id> <original-text>\|<SRC-id> \[--supersedes <SRC-id>\] \[--json\]/u,
  );
  assert.match(
    output,
    /pnpm workflow finding <[^\n]*convert <finding-id> \[--kind <kind>\] \[--now\][^\n]*> \[--json\]/u,
  );
});

test('Source capture projects exact ownerless show and trace next steps', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-source-capture-next-steps-'),
  );
  const inputPath = path.join(repositoryRoot, 'source.json');
  const originalWrite = process.stdout.write;
  let output = '';
  try {
    runGitForTest(repositoryRoot, ['init', '-b', 'main']);
    runGitForTest(repositoryRoot, ['config', 'user.name', 'Jigwright Test']);
    runGitForTest(repositoryRoot, [
      'config',
      'user.email',
      'jigwright@example.test',
    ]);
    fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'fixture\n');
    runGitForTest(repositoryRoot, ['add', 'README.md']);
    runGitForTest(repositoryRoot, ['commit', '-m', 'Initialize fixture']);
    fs.writeFileSync(
      inputPath,
      `${JSON.stringify({
        semanticAuthor: 'maintainer',
        capturedBy: 'jigwright',
        capturedAt: '2026-08-24T03:10:00.000Z',
        contextRef: 'direct-human:thread/turn-43',
        text: 'Keep every coherent MVP slice committed.\n',
        supersedes: null,
      })}\n`,
    );
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;

    assert.equal(
      runCli(
        ['source', 'capture', '--input', inputPath, '--json'],
        repositoryRoot,
      ),
      0,
    );
  } finally {
    process.stdout.write = originalWrite;
  }
  try {
    const parsed = JSON.parse(output) as {
      result: Record<string, unknown> & { sourceId: string };
      nextSteps: Array<{ command: string; why: string }>;
    };
    const sourceId = parsed.result.sourceId;
    assert.match(sourceId, /^SRC-[0-9a-f]{64}$/u);
    assert.deepEqual(
      parsed.nextSteps.map(({ command }) => command),
      [
        `pnpm workflow source show ${sourceId} --json`,
        `pnpm workflow source trace ${sourceId} --json`,
        'pnpm workflow guide --json',
      ],
    );
    for (const poisoned of [
      {
        ...parsed.result,
        sourceId: 'SRC-not-a-canonical-identity --unsafe',
      },
      { ...parsed.result, sourceId: `SRC-${'a'.repeat(64)}` },
      { ...parsed.result, path: 'workflow/source-ledger/objects/wrong.json' },
      { ...parsed.result, unexpected: 'field' },
      { ...parsed.result, action: 'unknown' },
    ]) {
      assert.deepEqual(
        workflowResultNextSteps({ command: 'source', result: poisoned }).map(
          ({ command }) => command,
        ),
        ['pnpm workflow guide --json'],
      );
    }
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Source list preserves exact wording before repository consumer configuration exists', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-source-core-list-'),
  );
  try {
    const first = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:09:00.000Z',
      contextRef: 'direct-human:thread/turn-42',
      text: 'Preserve the maintainer wording exactly.\n',
      supersedes: null,
    }).source;
    const second = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'agent',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:10:00.000Z',
      contextRef: 'session:source-list-audit',
      text: 'Keep this agent interpretation visibly distinct.\n',
      supersedes: null,
    }).source;
    const expected = [first, second].sort((left, right) =>
      left.id.localeCompare(right.id),
    );

    assert.equal(repositoryConsumerConfigurationExists(repositoryRoot), false);
    assert.deepEqual(
      dispatchGovernanceIntakeCommand('source', ['list'], repositoryRoot),
      { action: 'list', sources: expected },
    );

    const poisonedPath = path.join(
      repositoryRoot,
      'workflow/source-ledger/objects/sha256',
      expected[0]!.id.slice(4, 6),
      `${expected[0]!.id.slice(4)}.json`,
    );
    const poisonedValue = JSON.parse(fs.readFileSync(poisonedPath, 'utf8')) as {
      text: string;
    };
    poisonedValue.text = `${poisonedValue.text}drift`;
    const poisonedBytes = `${JSON.stringify(poisonedValue)}\n`;
    fs.writeFileSync(poisonedPath, poisonedBytes);

    assert.throws(
      () => dispatchGovernanceIntakeCommand('source', ['list'], repositoryRoot),
      hasCode('GOVERNANCE_SOURCE_IDENTITY_INVALID'),
    );
    assert.equal(fs.readFileSync(poisonedPath, 'utf8'), poisonedBytes);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('configured consumers keep Work Registry available and the Source ledger engine-owned', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-built-in-work-registry-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  const configPath = path.join(
    repositoryRoot,
    'workflow/repository-consumer.json',
  );
  const configured = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  > & { workRegistry: Record<string, unknown> };
  const currentConfigBytes = `${JSON.stringify(configured)}\n`;
  fs.writeFileSync(configPath, currentConfigBytes);
  try {
    const workRegistry =
      loadRepositoryConsumerConfiguration(repositoryRoot).configuration
        .workRegistry;
    assert.deepEqual(Object.keys(workRegistry).sort(), [
      'adapterId',
      'backlogPath',
      'changeOriginRoot',
      'historyRoot',
      'inventoryPath',
      'itemRoot',
      'transitionPolicyPath',
    ]);

    const source = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:10:30.000Z',
      contextRef: 'direct-human:thread/turn-42',
      text: 'Source capture uses the fixed core-owned ledger.\n',
      supersedes: null,
    }).source;
    assert.deepEqual(
      dispatchGovernanceIntakeCommand('source', ['list'], repositoryRoot),
      { action: 'list', sources: [source] },
    );
    assert.deepEqual(
      dispatchGovernanceIntakeCommand(
        'source',
        ['trace', source.id],
        repositoryRoot,
      ),
      {
        action: 'trace',
        source,
        supersedes: null,
        supersededBy: [],
        workItems: [],
        origins: [],
      },
    );

    const handoff = renderHandoff(repositoryRoot);
    assert.match(handoff, /Git-native Work Registry/u);
    assert.match(handoff, /\[Work backlog\]\(BACKLOG\.md\)/u);
    assert.deepEqual(
      dispatchGovernanceIntakeCommand('work-item', ['list'], repositoryRoot),
      { action: 'list', items: [] },
    );
    const sourcePath = path.join(
      repositoryRoot,
      'workflow/source-ledger/objects/sha256',
      source.id.slice(4, 6),
      `${source.id.slice(4)}.json`,
    );
    const sourceBytes = fs.readFileSync(sourcePath, 'utf8');
    assert.deepEqual(
      reconcileArchivedWorkItems(
        repositoryRoot,
        'zero-work-item-change',
        'openspec/changes/archive/2026-08-24-zero-work-item-change',
        '2026-08-24T03:11:00.000Z',
      ),
      { closedItemIds: [], outputPaths: [] },
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), currentConfigBytes);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceBytes);
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, 'docs/work-registry')),
      false,
    );

    fs.writeFileSync(
      configPath,
      `${JSON.stringify({ ...configured, workRegistry: null })}\n`,
    );
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repositoryRoot),
      (error) =>
        hasCode('REPOSITORY_CONSUMER_CONFIG_INVALID')(error) &&
        error instanceof Error &&
        /D-018/u.test(error.message),
    );
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceBytes);

    fs.writeFileSync(
      configPath,
      `${JSON.stringify({
        ...configured,
        workRegistry: {
          ...configured.workRegistry,
          sourceRoot: 'state/sources',
        },
      })}\n`,
    );
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repositoryRoot),
      hasCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceBytes);

    const { workRegistry: _workRegistry, ...defaultedConfiguration } =
      configured;
    fs.writeFileSync(configPath, `${JSON.stringify(defaultedConfiguration)}\n`);
    assert.deepEqual(
      loadRepositoryConsumerConfiguration(repositoryRoot).configuration
        .workRegistry,
      configured.workRegistry,
    );
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceBytes);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Source trace stays core-only before repository consumer configuration exists', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-source-core-trace-'),
  );
  try {
    const original = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:10:00.000Z',
      contextRef: 'direct-human:thread/turn-43',
      text: 'Preserve this exact original wording.\n',
      supersedes: null,
    }).source;
    const correction = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:11:00.000Z',
      contextRef: 'maintainer-confirmation:thread/turn-44',
      text: 'Preserve this exact corrected wording.\n',
      supersedes: original.id,
    }).source;

    assert.equal(repositoryConsumerConfigurationExists(repositoryRoot), false);
    assert.deepEqual(
      dispatchGovernanceIntakeCommand(
        'source',
        ['show', correction.id],
        repositoryRoot,
      ),
      { action: 'show', source: correction },
    );
    assert.deepEqual(
      dispatchGovernanceIntakeCommand(
        'source',
        ['trace', correction.id],
        repositoryRoot,
      ),
      {
        action: 'trace',
        source: correction,
        supersedes: original,
        supersededBy: [],
        workItems: [],
        origins: [],
      },
    );
    assert.deepEqual(
      dispatchGovernanceIntakeCommand(
        'source',
        ['trace', original.id],
        repositoryRoot,
      ),
      {
        action: 'trace',
        source: original,
        supersedes: null,
        supersededBy: [correction],
        workItems: [],
        origins: [],
      },
    );

    const configPath = path.join(
      repositoryRoot,
      'workflow/repository-consumer.json',
    );
    fs.writeFileSync(configPath, '{}\n');
    assert.equal(repositoryConsumerConfigurationExists(repositoryRoot), true);
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'source',
          ['trace', original.id],
          repositoryRoot,
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'REPOSITORY_CONSUMER_CONFIG_INVALID',
    );

    fs.rmSync(configPath);
    const unsafeTarget = path.join(
      repositoryRoot,
      'workflow/unsafe-repository-consumer.json',
    );
    fs.writeFileSync(unsafeTarget, '{}\n');
    fs.symlinkSync(unsafeTarget, configPath);
    assert.equal(repositoryConsumerConfigurationExists(repositoryRoot), true);
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'source',
          ['trace', original.id],
          repositoryRoot,
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'REPOSITORY_CONSUMER_CONFIG_INVALID',
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('a Source can link directly to a change without a parking Work Item', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-source-change-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const source = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:30:00.000Z',
      contextRef: 'direct-human:thread/turn-45',
      text: 'Create this change immediately.\n',
      supersedes: null,
    }).source;
    fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes/direct-change'), {
      recursive: true,
    });

    const first = linkSourceToChange(
      repositoryRoot,
      source.id,
      'direct-change',
    );
    const second = linkSourceToChange(
      repositoryRoot,
      source.id,
      'direct-change',
    );

    assert.deepEqual(second.origin, first.origin);
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.deepEqual(first.origin, {
      schemaVersion: 1,
      sourceRefs: [source.id],
      workItemRefs: [],
    });
    assert.deepEqual(
      dispatchGovernanceIntakeCommand(
        'source',
        ['link-change', source.id, '--change', 'direct-change'],
        repositoryRoot,
      ),
      {
        action: 'link-change',
        originalText: source.text,
        sourceId: source.id,
        changeId: 'direct-change',
        path: 'openspec/changes/direct-change/origin.json',
        created: false,
      },
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Source CLI show and trace preserve exact wording and refuse dangling citations', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-source-trace-'),
  );
  const repositoryRoot = path.join(root, 'repository');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  configureRepositoryConsumer(repositoryRoot);
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  try {
    const original = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:31:00.000Z',
      contextRef: 'direct-human:thread/turn-45',
      text: '保留這段 maintainer 原話。\n',
      supersedes: null,
    }).source;
    const correction = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:32:00.000Z',
      contextRef: 'direct-human:thread/turn-45',
      text: '修正後仍保留原話的獨立來源。\n',
      supersedes: original.id,
    }).source;
    fs.mkdirSync(
      path.join(repositoryRoot, 'openspec/changes/direct-source-trace'),
      { recursive: true },
    );
    dispatchGovernanceIntakeCommand(
      'source',
      ['link-change', correction.id, '--change', 'direct-source-trace'],
      repositoryRoot,
    );

    assert.deepEqual(
      dispatchGovernanceIntakeCommand(
        'source',
        ['show', correction.id],
        repositoryRoot,
      ),
      { action: 'show', source: correction },
    );
    assert.deepEqual(
      dispatchGovernanceIntakeCommand(
        'source',
        ['trace', correction.id],
        repositoryRoot,
      ),
      {
        action: 'trace',
        source: correction,
        supersedes: original,
        supersededBy: [],
        workItems: [],
        origins: ['openspec/changes/direct-source-trace/origin.json'],
      },
    );

    const missingSourceId = `SRC-${'f'.repeat(64)}` as `SRC-${string}`;
    assert.throws(
      () =>
        captureGovernanceSource(repositoryRoot, {
          semanticAuthor: 'agent',
          capturedBy: 'jigwright',
          capturedAt: '2026-08-24T03:33:00.000Z',
          contextRef: 'session:session-current-task',
          text: 'A correction cannot cite an absent Source.\n',
          supersedes: missingSourceId,
        }),
      hasCode('GOVERNANCE_INTAKE_INVALID'),
    );
    assert.throws(
      () =>
        recordGovernanceFinding(
          {
            repositoryRoot,
            runtimeRoot,
            sessionId: 'session-current-task',
            changeId: 'current-change',
            branch: 'work/current-change',
            head: 'a'.repeat(40),
            tree: 'b'.repeat(40),
          },
          {
            schemaVersion: 1,
            text: 'A Finding cannot cite an absent Source.',
            sourceRefs: [missingSourceId],
          },
          () => '2026-08-24T03:34:00.000Z',
        ),
      hasCode('GOVERNANCE_INTAKE_INVALID'),
    );
    fs.mkdirSync(
      path.join(repositoryRoot, 'openspec/changes/poisoned-source'),
      {
        recursive: true,
      },
    );
    fs.writeFileSync(
      path.join(repositoryRoot, 'openspec/changes/poisoned-source/origin.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        sourceRefs: [missingSourceId],
        workItemRefs: [],
      })}\n`,
    );
    const poisonedOriginPath = path.join(
      repositoryRoot,
      'openspec/changes/poisoned-source/origin.json',
    );
    const poisonedOriginBytes = fs.readFileSync(poisonedOriginPath, 'utf8');
    assert.throws(
      () =>
        linkSourceToChange(repositoryRoot, correction.id, 'poisoned-source'),
      hasCode('GOVERNANCE_INTAKE_INVALID'),
    );
    assert.equal(
      fs.readFileSync(poisonedOriginPath, 'utf8'),
      poisonedOriginBytes,
    );
    assert.throws(
      () => validateWorkRegistry(repositoryRoot),
      hasCode('WORK_REGISTRY_INVALID'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
