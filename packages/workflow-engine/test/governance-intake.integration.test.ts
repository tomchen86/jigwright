import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  captureGovernanceSource,
  listGovernanceSources,
  readGovernanceSource,
  recordGovernanceFinding,
} from '../src/modules/governance-intake/governance-intake.ts';
import {
  createWorkRegistryPromotionGrantRequest,
  createWorkRegistryReviewGrantRequest,
  workRegistryGrantTransitionDefinitions,
} from '../src/modules/governance-intake/work-registry-grant.ts';
import { dispatchGovernanceIntakeCommand } from '../src/entrypoints/cli/governance-intake-cli.ts';
import { createWorkRegistryFailGrantResult, runCli } from '../src/cli.ts';
import { createGrantChallenge } from '../src/modules/authority/grant-core.ts';
import { createGrantCoordinatorKernel } from '../src/modules/authority/grant-coordinator.ts';
import {
  codeOwnedApprovalModuleRegistry,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import { createTransitionRegistry } from '../src/modules/authority/grant-transition-registry.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from '../src/runtime/storage-journal/grant-store.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { workflowResultNextSteps } from '../src/modules/guidance/next-steps/workflow-guidance.ts';
import { renderHandoff } from '../src/adapters/consumer/repository/handoff/handoff.ts';
import {
  loadRepositoryConsumerConfiguration,
  repositoryConsumerConfigurationExists,
} from '../src/modules/repository-consumer/repository-consumer-config.ts';
import {
  applyWorkItemReview,
  createWorkItem,
  linkSourceToChange,
  inspectWorkRegistry,
  prepareWorkItemPromotionSurvey,
  promoteWorkItem,
  recommendWorkItemPriorities,
  reconcileArchivedWorkItems,
  renderWorkRegistry,
  searchWorkItems,
  showWorkItem,
  traceWorkItem,
  validateWorkRegistry,
  validateWorkRegistryProjections,
  workItemDigest,
} from '../src/modules/governance-intake/work-registry.ts';

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
      name: 'Finding mode differs from the current writer',
      poison(fixture: ReturnType<typeof createGovernancePersistenceFixture>) {
        fs.chmodSync(fixture.finding.path, 0o644);
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
          hasCode('GOVERNANCE_FINDING_COLLISION'),
        );
      },
    },
    {
      name: 'Finding has a second hard link',
      poison(fixture: ReturnType<typeof createGovernancePersistenceFixture>) {
        const target = path.join(fixture.root, 'finding-hardlink.json');
        fs.linkSync(fixture.finding.path, target);
        return [target];
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
          hasCode('GOVERNANCE_FINDING_COLLISION'),
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
      assert.equal(fs.lstatSync(fixture.finding.path).mode & 0o777, 0o600);
      if (typeof process.getuid === 'function') {
        assert.equal(fs.lstatSync(fixture.sourcePath).uid, process.getuid());
        assert.equal(fs.lstatSync(fixture.finding.path).uid, process.getuid());
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
});

test('Source list preserves exact wording without the optional Work Registry', () => {
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

test('configured consumers can disable Work Registry without disabling core Source or lifecycle', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-optional-work-registry-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  const configPath = path.join(
    repositoryRoot,
    'workflow/repository-consumer.json',
  );
  const configured = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
    string,
    unknown
  >;
  configured.workRegistry = null;
  const disabledConfigBytes = `${JSON.stringify(configured)}\n`;
  fs.writeFileSync(configPath, disabledConfigBytes);
  try {
    assert.equal(
      loadRepositoryConsumerConfiguration(repositoryRoot).configuration
        .workRegistry,
      null,
    );

    const source = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:10:30.000Z',
      contextRef: 'direct-human:thread/turn-42',
      text: 'Source capture must not require the Work Registry.\n',
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
    assert.doesNotMatch(handoff, /Work Registry|Work backlog/u);
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
        'optional-registry-change',
        'openspec/changes/archive/2026-08-24-optional-registry-change',
        '2026-08-24T03:11:00.000Z',
      ),
      { closedItemIds: [], outputPaths: [] },
    );
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand('work-item', ['list'], repositoryRoot),
      hasCode('WORK_REGISTRY_UNAVAILABLE'),
    );
    assert.equal(fs.readFileSync(configPath, 'utf8'), disabledConfigBytes);
    assert.equal(fs.readFileSync(sourcePath, 'utf8'), sourceBytes);
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, 'docs/work-registry')),
      false,
    );

    const { workRegistry: _workRegistry, ...missingWorkRegistry } = configured;
    fs.writeFileSync(configPath, `${JSON.stringify(missingWorkRegistry)}\n`);
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repositoryRoot),
      hasCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Source trace only treats an absent repository consumer config as optional', () => {
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

test('finding capture binds active session and Git facts outside task paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-finding-'));
  const repositoryRoot = path.join(root, 'repository');
  const runtimeRoot = path.join(root, 'git-common', 'workflow-engine');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  configureRepositoryConsumer(repositoryRoot);
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  try {
    const result = recordGovernanceFinding(
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
        text: 'The current assumption needs re-validation.',
        sourceRefs: [],
      },
      () => '2026-08-24T03:12:00.000Z',
    );

    assert.match(result.finding.id, /^FND-[0-9a-f]{64}$/);
    assert.equal(result.finding.sessionId, 'session-current-task');
    assert.equal(result.finding.changeId, 'current-change');
    assert.equal(result.finding.head, 'a'.repeat(40));
    assert.equal(result.finding.tree, 'b'.repeat(40));
    assert.equal(result.path.startsWith(repositoryRoot), false);
    assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source and finding CLI routes parse exact input envelopes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-intake-cli-'));
  const repositoryRoot = path.join(root, 'repository');
  const runtimeRoot = path.join(root, 'runtime');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  configureRepositoryConsumer(repositoryRoot);
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  const sourceInput = path.join(root, 'source.json');
  const findingInput = path.join(root, 'finding.json');
  const workItemInput = path.join(root, 'work-item.json');
  fs.writeFileSync(
    sourceInput,
    `${JSON.stringify({
      semanticAuthor: 'agent',
      capturedBy: 'agent',
      capturedAt: '2026-08-24T03:15:00.000Z',
      contextRef: 'session:session-current-task',
      text: 'A bounded implementation finding.',
      supersedes: null,
    })}\n`,
  );
  fs.writeFileSync(
    findingInput,
    `${JSON.stringify({
      schemaVersion: 1,
      text: 'A finding that must survive task-scope rejection.',
      sourceRefs: [],
    })}\n`,
  );
  try {
    const source = dispatchGovernanceIntakeCommand(
      'source',
      ['capture', '--input', sourceInput],
      repositoryRoot,
    );
    assert.equal(source.action, 'capture');
    fs.writeFileSync(
      workItemInput,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'research',
        lane: 'later',
        title: 'Captured CLI work',
        summary: 'Keep the optional registry route small.',
        sourceRefs: [source.sourceId],
      })}\n`,
    );

    const finding = dispatchGovernanceIntakeCommand(
      'finding',
      ['add', '--session', 'session-current-task', '--input', findingInput],
      repositoryRoot,
      {
        now: () => '2026-08-24T03:16:00.000Z',
        resolveSession: () => ({
          repositoryRoot,
          runtimeRoot,
          sessionId: 'session-current-task',
          changeId: 'current-change',
          branch: 'work/current-change',
          head: 'a'.repeat(40),
          tree: 'b'.repeat(40),
        }),
      },
    );
    assert.equal(finding.action, 'add');

    const workItem = dispatchGovernanceIntakeCommand(
      'work-item',
      ['create', '--input', workItemInput],
      repositoryRoot,
      { now: () => '2026-08-24T03:17:00.000Z' },
    );
    assert.equal(workItem.action, 'create');
    assert.deepEqual(
      dispatchGovernanceIntakeCommand(
        'work-item',
        ['validate'],
        repositoryRoot,
      ),
      { action: 'validate', itemCount: 1, sourceCount: 1 },
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('optional Work Registry creates one stable item and promotes exact provenance', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-registry-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    runGitForTest(repositoryRoot, ['init', '-b', 'main']);
    const source = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:20:00.000Z',
      contextRef: 'direct-human:thread/turn-44',
      text: 'Make the Work Registry optional.\n',
      supersedes: null,
    }).source;
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Optional Work Registry',
        summary: 'Ship the smallest Git-native registry.',
        sourceRefs: [source.id],
      },
      {
        now: () => '2026-08-24T03:21:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000000',
      },
    );
    assert.equal(created.item.stage, 'inbox');
    assert.equal(created.item.lane, 'next');
    assert.equal(
      created.relativePath,
      'docs/work-registry/items/2026/WORK-01K39R0V000000000000000000.yaml',
    );

    fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes/registry-mvp'), {
      recursive: true,
    });
    const accepted = applyWorkItemReview(
      repositoryRoot,
      created.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created.item),
        summary: created.item.interpretation.summary,
      },
      () => '2026-08-24T03:21:30.000Z',
    );
    const promoted = promoteWorkItem(
      repositoryRoot,
      accepted.id,
      'registry-mvp',
      () => '2026-08-24T03:22:00.000Z',
      workItemDigest(accepted),
    );
    assert.equal(promoted.item.stage, 'active');
    assert.deepEqual(promoted.item.changeRefs, ['registry-mvp']);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(
            repositoryRoot,
            'openspec/changes/registry-mvp/origin.json',
          ),
          'utf8',
        ),
      ),
      {
        schemaVersion: 1,
        sourceRefs: [source.id],
        workItemRefs: [created.item.id],
      },
    );
    assert.deepEqual(validateWorkRegistry(repositoryRoot), {
      itemCount: 1,
      sourceCount: 1,
    });
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Work Item promotion recovers one exact item-origin transaction after every hard-crash cut', () => {
  const moduleUrl = new URL(
    '../src/modules/governance-intake/work-registry.ts',
    import.meta.url,
  ).href;
  const crashCuts = [
    'afterJournalPersisted',
    'afterOriginPublished',
    'afterItemPublished',
  ] as const;
  const workItemIds = [
    'WORK-01K39R0V000000000000000006',
    'WORK-01K39R0V000000000000000007',
    'WORK-01K39R0V000000000000000008',
  ] as const;

  for (const [index, crashCut] of crashCuts.entries()) {
    const repositoryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), `jigwright-work-promotion-${crashCut}-`),
    );
    configureRepositoryConsumer(repositoryRoot);
    try {
      runGitForTest(repositoryRoot, ['init', '-b', 'main']);
      const workItemId = workItemIds[index]!;
      const changeId = `crash-atomic-promotion-${index + 1}`;
      const created = createWorkItem(
        repositoryRoot,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'next',
          title: `Recover ${index === 0 ? 'é ' : ''}${crashCut}`,
          summary: 'Recover one exact Work Item and change-origin promotion.',
          sourceRefs: [],
        },
        {
          now: () => `2026-08-24T03:2${index}:00.000Z`,
          createId: () => workItemId,
        },
      );
      const accepted = applyWorkItemReview(
        repositoryRoot,
        created.item.id,
        {
          action: 'accept',
          expectedDigest: workItemDigest(created.item),
          summary: created.item.interpretation.summary,
        },
        () => `2026-08-24T03:2${index}:30.000Z`,
      );
      const changeDirectory = path.join(
        repositoryRoot,
        'openspec/changes',
        changeId,
      );
      fs.mkdirSync(changeDirectory, { recursive: true });
      const promotedAt = `2026-08-24T03:3${index}:00.000Z`;
      const childSource = `
        const { promoteWorkItem } = await import(${JSON.stringify(moduleUrl)});
        promoteWorkItem(
          ${JSON.stringify(repositoryRoot)},
          ${JSON.stringify(accepted.id)},
          ${JSON.stringify(changeId)},
          () => ${JSON.stringify(promotedAt)},
          ${JSON.stringify(workItemDigest(accepted))},
          false,
          { ${crashCut}() { process.exit(86); } },
        );
      `;
      const crashed = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          childSource,
        ],
        { cwd: repositoryRoot },
      );
      assert.equal(
        crashed.status,
        86,
        `${crashCut}: ${crashed.stderr || crashed.stdout}`,
      );

      let exactTemporarySnapshot:
        { inode: bigint; ctimeNs: bigint; birthtimeNs: bigint } | undefined;
      if (index === 0) {
        const journalRoot = path.join(
          repositoryRoot,
          '.git/workflow-engine/work-registry/promotion-journals',
        );
        const [journalName] = fs.readdirSync(journalRoot);
        assert.ok(journalName);
        const journalPath = path.join(journalRoot, journalName);
        const journalBytes = fs.readFileSync(journalPath, 'utf8');
        const abandonedJournalTemporaryPath = path.join(
          journalRoot,
          `sha256-${'0'.repeat(64)}.json.1.00000000-0000-4000-8000-000000000000.tmp`,
        );
        const pending = JSON.parse(journalBytes) as {
          operationId: string;
          itemRelativePath: string;
          originRelativePath: string;
          after: { itemContent: string; originContent: string };
        };
        const pendingItemPath = path.join(
          repositoryRoot,
          ...pending.itemRelativePath.split('/'),
        );
        const desiredTemporaryPath = path.join(
          path.dirname(pendingItemPath),
          `.${path.basename(pendingItemPath)}.${pending.operationId.replace(':', '-')}.item-forward.desired.publish.tmp`,
        );
        const desiredItemBytes = Buffer.from(pending.after.itemContent, 'utf8');
        const multibyteStart = desiredItemBytes.indexOf(Buffer.from('é'));
        assert.notEqual(multibyteStart, -1);
        fs.writeFileSync(
          abandonedJournalTemporaryPath,
          desiredItemBytes.subarray(0, multibyteStart + 1),
          { mode: 0o400 },
        );
        assert.equal(
          fs.lstatSync(abandonedJournalTemporaryPath).mode & 0o777,
          0o400,
        );
        fs.writeFileSync(
          desiredTemporaryPath,
          desiredItemBytes.subarray(0, multibyteStart + 1),
          { mode: 0o600 },
        );
        const pendingOriginPath = path.join(
          repositoryRoot,
          ...pending.originRelativePath.split('/'),
        );
        const exactDesiredTemporaryPath = path.join(
          path.dirname(pendingOriginPath),
          `.${path.basename(pendingOriginPath)}.${pending.operationId.replace(':', '-')}.origin-forward.desired.publish.tmp`,
        );
        fs.writeFileSync(
          exactDesiredTemporaryPath,
          pending.after.originContent,
          { encoding: 'utf8', mode: 0o644 },
        );
        const exactTemporaryStats = fs.lstatSync(exactDesiredTemporaryPath, {
          bigint: true,
        });
        exactTemporarySnapshot = {
          inode: exactTemporaryStats.ino,
          ctimeNs: exactTemporaryStats.ctimeNs,
          birthtimeNs: exactTemporaryStats.birthtimeNs,
        };
        const poisoned = JSON.parse(journalBytes) as Record<string, unknown>;
        poisoned.transactionDigest = `sha256:${'f'.repeat(64)}`;
        const poisonedBytes = `${canonicalJson(poisoned)}\n`;
        fs.writeFileSync(journalPath, poisonedBytes);
        const itemPath = path.join(repositoryRoot, created.relativePath);
        const itemBytes = fs.readFileSync(itemPath, 'utf8');
        const originPath = path.join(changeDirectory, 'origin.json');

        assert.throws(
          () => validateWorkRegistry(repositoryRoot),
          hasCode('WORK_REGISTRY_TRANSACTION_INVALID'),
        );
        assert.equal(fs.readFileSync(itemPath, 'utf8'), itemBytes);
        assert.equal(fs.existsSync(originPath), false);
        assert.equal(fs.readFileSync(journalPath, 'utf8'), poisonedBytes);
        assert.equal(fs.existsSync(abandonedJournalTemporaryPath), false);
        fs.writeFileSync(journalPath, journalBytes);
        assert.equal(fs.existsSync(desiredTemporaryPath), true);
        assert.equal(fs.existsSync(exactDesiredTemporaryPath), true);
        assert.equal(fs.existsSync(pendingOriginPath), false);
        assert.notEqual(exactTemporarySnapshot.inode, 0n);
      }

      assert.deepEqual(validateWorkRegistry(repositoryRoot), {
        itemCount: 1,
        sourceCount: 0,
      });
      if (index === 0) {
        const recoveredOriginPath = path.join(changeDirectory, 'origin.json');
        assert.equal(
          fs
            .readdirSync(
              path.dirname(path.join(repositoryRoot, created.relativePath)),
            )
            .some((entry) => entry.endsWith('.desired.publish.tmp')),
          false,
        );
        const originEntries = fs.readdirSync(changeDirectory);
        assert.equal(
          originEntries.some((entry) => entry.endsWith('.desired.publish.tmp')),
          false,
        );
        const recoveredOriginStats = fs.lstatSync(recoveredOriginPath, {
          bigint: true,
        });
        assert.ok(exactTemporarySnapshot);
        assert.notDeepEqual(
          {
            inode: recoveredOriginStats.ino,
            ctimeNs: recoveredOriginStats.ctimeNs,
            birthtimeNs: recoveredOriginStats.birthtimeNs,
          },
          exactTemporarySnapshot,
        );
      }
      const resumed = promoteWorkItem(
        repositoryRoot,
        accepted.id,
        changeId,
        () => promotedAt,
        workItemDigest(accepted),
      );
      const recovered = resumed.item;
      assert.equal(recovered.stage, 'active');
      assert.deepEqual(recovered.changeRefs, [changeId]);
      assert.deepEqual(recovered.timeline.at(-1), {
        at: promotedAt,
        event: 'promoted',
        changeId,
      });
      assert.deepEqual(
        JSON.parse(
          fs.readFileSync(path.join(changeDirectory, 'origin.json'), 'utf8'),
        ),
        {
          schemaVersion: 1,
          sourceRefs: [],
          workItemRefs: [accepted.id],
        },
      );
      const journalRoot = path.join(
        repositoryRoot,
        '.git/workflow-engine/work-registry/promotion-journals',
      );
      assert.deepEqual(fs.readdirSync(journalRoot), []);
      const recoveredRoot = path.join(
        repositoryRoot,
        '.git/workflow-engine/work-registry/recovered-promotions',
      );
      const recoveredReceipts = fs.readdirSync(recoveredRoot);
      assert.equal(recoveredReceipts.length, 1);
      assert.match(recoveredReceipts[0]!, /^sha256-[0-9a-f]{64}\.json$/);
      assert.deepEqual(
        promoteWorkItem(
          repositoryRoot,
          accepted.id,
          changeId,
          () => promotedAt,
          workItemDigest(accepted),
        ),
        resumed,
      );
      assert.deepEqual(fs.readdirSync(recoveredRoot), recoveredReceipts);
      if (index === 0) {
        const archivedDirectory = path.join(
          repositoryRoot,
          'openspec/changes/archive',
          changeId,
        );
        fs.mkdirSync(path.dirname(archivedDirectory), { recursive: true });
        fs.renameSync(changeDirectory, archivedDirectory);
        assert.throws(
          () =>
            promoteWorkItem(
              repositoryRoot,
              accepted.id,
              'unrelated-later-promotion',
            ),
          hasCode('WORK_REGISTRY_PROMOTION_INELIGIBLE'),
        );
        assert.deepEqual(fs.readdirSync(recoveredRoot), recoveredReceipts);
      }
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test('composite Work Registry readers hold the promotion lock across item-origin snapshots', async () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-promotion-read-lock-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    runGitForTest(repositoryRoot, ['init', '-b', 'main']);
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Keep composite readers on one promotion snapshot',
        summary: 'Serialize the item and origin halves of public reads.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T03:39:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000N',
      },
    );
    const accepted = applyWorkItemReview(
      repositoryRoot,
      created.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created.item),
        summary: created.item.interpretation.summary,
      },
      () => '2026-08-24T03:39:30.000Z',
    );
    const changeId = 'promotion-reader-snapshot';
    const changesRoot = path.join(repositoryRoot, 'openspec/changes');
    fs.mkdirSync(path.join(changesRoot, changeId), { recursive: true });
    const moduleUrl = new URL(
      '../src/modules/governance-intake/work-registry.ts',
      import.meta.url,
    ).href;
    const readerAttempts: number[] = [];
    const runCompositeRead = async <T>(
      name: string,
      operation: (afterItemSnapshot: () => void) => T,
    ): Promise<T> => {
      const conflictMarker = path.join(repositoryRoot, `.${name}-conflict`);
      const originMarker = path.join(repositoryRoot, `.${name}-origin`);
      const releaseMarker = path.join(repositoryRoot, `.${name}-release`);
      let writerExit: Promise<number | null> | undefined;
      let writerStderr = '';
      let observedSplitState = false;
      const afterItemSnapshot = (): void => {
        const writerSource = `
          import fs from 'node:fs';
          const { promoteWorkItem } = await import(${JSON.stringify(moduleUrl)});
          try {
            promoteWorkItem(
              ${JSON.stringify(repositoryRoot)},
              ${JSON.stringify(accepted.id)},
              ${JSON.stringify(changeId)},
              () => '2026-08-24T03:40:00.000Z',
              ${JSON.stringify(workItemDigest(accepted))},
              false,
              {
                afterOriginPublished() {
                  fs.writeFileSync(${JSON.stringify(originMarker)}, 'origin');
                  const waitArray = new Int32Array(new SharedArrayBuffer(4));
                  while (!fs.existsSync(${JSON.stringify(releaseMarker)})) {
                    Atomics.wait(waitArray, 0, 0, 10);
                  }
                },
              },
            );
            process.exit(0);
          } catch (error) {
            if (error?.code === 'WORK_REGISTRY_TRANSACTION_CONFLICT') {
              fs.writeFileSync(${JSON.stringify(conflictMarker)}, 'conflict');
              process.exit(73);
            }
            console.error(error);
            process.exit(74);
          }
        `;
        const writer = spawn(
          process.execPath,
          [
            '--experimental-strip-types',
            '--input-type=module',
            '--eval',
            writerSource,
          ],
          { cwd: repositoryRoot },
        );
        writer.stderr.on('data', (chunk) => {
          writerStderr += String(chunk);
        });
        writerExit = new Promise((resolve) => writer.once('close', resolve));
        const waitArray = new Int32Array(new SharedArrayBuffer(4));
        const deadline = Date.now() + 10_000;
        while (
          !fs.existsSync(conflictMarker) &&
          !fs.existsSync(originMarker) &&
          Date.now() < deadline
        ) {
          Atomics.wait(waitArray, 0, 0, 10);
        }
        if (fs.existsSync(originMarker)) {
          observedSplitState = true;
          try {
            assert.equal(
              (
                JSON.parse(
                  fs.readFileSync(
                    path.join(repositoryRoot, created.relativePath),
                    'utf8',
                  ),
                ) as { stage: string }
              ).stage,
              'backlog',
            );
            assert.equal(
              fs.existsSync(path.join(changesRoot, changeId, 'origin.json')),
              true,
            );
          } finally {
            fs.writeFileSync(releaseMarker, 'release');
          }
          return;
        }
        if (!fs.existsSync(conflictMarker)) {
          writer.kill('SIGKILL');
          throw new Error('Concurrent promotion did not reach a test cut.');
        }
      };
      let result: T | undefined;
      let operationError: unknown;
      try {
        result = operation(afterItemSnapshot);
      } catch (error) {
        operationError = error;
      }
      assert.ok(writerExit);
      const exitCode = await writerExit;
      for (const marker of [conflictMarker, originMarker, releaseMarker]) {
        fs.rmSync(marker, { force: true });
      }
      if (operationError !== undefined) throw operationError;
      readerAttempts.push(exitCode ?? -1);
      assert.equal(exitCode, 73, writerStderr);
      assert.equal(observedSplitState, false);
      return result!;
    };

    assert.deepEqual(
      await runCompositeRead('validate-reader', (afterItemSnapshot) =>
        validateWorkRegistry(repositoryRoot, { afterItemSnapshot }),
      ),
      { itemCount: 1, sourceCount: 0 },
    );
    assert.deepEqual(
      await runCompositeRead('trace-reader', (afterItemSnapshot) =>
        traceWorkItem(repositoryRoot, accepted.id, { afterItemSnapshot }),
      ),
      { item: accepted, origins: [], sources: [] },
    );
    assert.deepEqual(readerAttempts, [73, 73]);
    assert.equal(
      fs.existsSync(path.join(changesRoot, changeId, 'origin.json')),
      false,
    );
    assert.equal(showWorkItem(repositoryRoot, accepted.id).stage, 'backlog');
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Work Item promotion resumes durable rollback after hard crashes in either tracked file', () => {
  const moduleUrl = new URL(
    '../src/modules/governance-intake/work-registry.ts',
    import.meta.url,
  ).href;
  const cases = [
    {
      name: 'origin',
      workItemId: 'WORK-01K39R0V00000000000000000P',
      failHook: 'afterOriginPublished',
      crashHook: 'afterOriginRollbackCaptured',
    },
    {
      name: 'item',
      workItemId: 'WORK-01K39R0V00000000000000000Q',
      failHook: 'afterItemPublished',
      crashHook: 'afterItemRollbackCaptured',
    },
  ] as const;

  for (const [index, rollbackCase] of cases.entries()) {
    const repositoryRoot = fs.mkdtempSync(
      path.join(
        os.tmpdir(),
        `jigwright-work-promotion-rollback-${rollbackCase.name}-`,
      ),
    );
    configureRepositoryConsumer(repositoryRoot);
    try {
      runGitForTest(repositoryRoot, ['init', '-b', 'main']);
      const changeId = `rollback-${rollbackCase.name}`;
      const created = createWorkItem(
        repositoryRoot,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'next',
          title: `Recover ${rollbackCase.name} rollback`,
          summary: 'Resume the durable rollback direction after process loss.',
          sourceRefs: [],
        },
        {
          now: () => `2026-08-24T03:5${index}:00.000Z`,
          createId: () => rollbackCase.workItemId,
        },
      );
      const accepted = applyWorkItemReview(
        repositoryRoot,
        created.item.id,
        {
          action: 'accept',
          expectedDigest: workItemDigest(created.item),
          summary: created.item.interpretation.summary,
        },
        () => `2026-08-24T03:5${index}:30.000Z`,
      );
      const changeDirectory = path.join(
        repositoryRoot,
        'openspec/changes',
        changeId,
      );
      fs.mkdirSync(changeDirectory, { recursive: true });
      const itemPath = path.join(repositoryRoot, created.relativePath);
      const itemBefore = fs.readFileSync(itemPath, 'utf8');
      const originPath = path.join(changeDirectory, 'origin.json');
      const childSource = `
        const { promoteWorkItem } = await import(${JSON.stringify(moduleUrl)});
        promoteWorkItem(
          ${JSON.stringify(repositoryRoot)},
          ${JSON.stringify(accepted.id)},
          ${JSON.stringify(changeId)},
          () => ${JSON.stringify(`2026-08-24T03:5${index}:45.000Z`)},
          ${JSON.stringify(workItemDigest(accepted))},
          false,
          {
            ${rollbackCase.failHook}() { throw new Error('force rollback'); },
            ${rollbackCase.crashHook}() { process.exit(87); },
          },
        );
      `;
      const crashed = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--input-type=module',
          '--eval',
          childSource,
        ],
        { cwd: repositoryRoot, encoding: 'utf8' },
      );
      assert.equal(
        crashed.status,
        87,
        `${rollbackCase.name}: ${crashed.stderr || crashed.stdout}`,
      );
      const journalRoot = path.join(
        repositoryRoot,
        '.git/workflow-engine/work-registry/promotion-journals',
      );
      assert.deepEqual(
        fs
          .readdirSync(journalRoot)
          .map((entry) =>
            entry.replace(/^sha256-[0-9a-f]{64}/, 'sha256-<digest>'),
          ),
        ['sha256-<digest>.rollback.json'],
      );
      const concurrentOrigin = `${canonicalJson({
        schemaVersion: 1,
        sourceRefs: [],
        workItemRefs: [],
      })}\n`;
      if (rollbackCase.name === 'origin') {
        assert.equal(fs.existsSync(originPath), false);
        fs.writeFileSync(originPath, concurrentOrigin, {
          encoding: 'utf8',
          mode: 0o644,
        });
      }

      assert.deepEqual(validateWorkRegistry(repositoryRoot), {
        itemCount: 1,
        sourceCount: 0,
      });
      assert.equal(fs.readFileSync(itemPath, 'utf8'), itemBefore);
      assert.equal(showWorkItem(repositoryRoot, accepted.id).stage, 'backlog');
      if (rollbackCase.name === 'origin') {
        assert.equal(fs.readFileSync(originPath, 'utf8'), concurrentOrigin);
      } else {
        assert.equal(fs.existsSync(originPath), false);
      }
      assert.deepEqual(fs.readdirSync(journalRoot), []);

      const retried = promoteWorkItem(
        repositoryRoot,
        accepted.id,
        changeId,
        () => `2026-08-24T03:5${index}:50.000Z`,
        workItemDigest(accepted),
      );
      assert.equal(retried.item.stage, 'active');
      assert.equal(fs.existsSync(originPath), true);
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test('Work Item promotion CAS preserves a concurrent canonical origin update after origin publication', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-promotion-cas-'),
  );
  const externalRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-promotion-external-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    runGitForTest(repositoryRoot, ['init', '-b', 'main']);
    const source = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T03:40:00.000Z',
      contextRef: 'direct-human:thread/work-promotion-cas',
      text: 'Preserve this concurrent canonical origin citation.\n',
      supersedes: null,
    }).source;
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Preserve concurrent origin facts',
        summary: 'Use exact compare-and-swap for promotion provenance.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T03:41:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000009',
      },
    );
    const accepted = applyWorkItemReview(
      repositoryRoot,
      created.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created.item),
        summary: created.item.interpretation.summary,
      },
      () => '2026-08-24T03:41:30.000Z',
    );
    const changeDirectory = path.join(
      repositoryRoot,
      'openspec/changes/promotion-cas',
    );
    fs.mkdirSync(changeDirectory, { recursive: true });
    const originPath = path.join(changeDirectory, 'origin.json');
    const concurrentOrigin = `${canonicalJson({
      schemaVersion: 1,
      sourceRefs: [source.id],
      workItemRefs: [],
    })}\n`;

    assert.throws(
      () =>
        promoteWorkItem(
          repositoryRoot,
          accepted.id,
          'promotion-cas',
          () => '2026-08-24T03:42:00.000Z',
          workItemDigest(accepted),
          false,
          {
            afterOriginPublished() {
              fs.writeFileSync(originPath, concurrentOrigin, {
                encoding: 'utf8',
                mode: 0o644,
              });
            },
          },
        ),
      hasCode('WORK_REGISTRY_TRANSACTION_CONFLICT'),
    );
    assert.equal(fs.readFileSync(originPath, 'utf8'), concurrentOrigin);
    assert.deepEqual(showWorkItem(repositoryRoot, accepted.id), accepted);

    const promoted = promoteWorkItem(
      repositoryRoot,
      accepted.id,
      'promotion-cas',
      () => '2026-08-24T03:42:30.000Z',
      workItemDigest(accepted),
    );
    assert.equal(promoted.item.stage, 'active');
    assert.deepEqual(JSON.parse(fs.readFileSync(originPath, 'utf8')), {
      schemaVersion: 1,
      sourceRefs: [source.id],
      workItemRefs: [accepted.id],
    });

    const capabilityCreated = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Hold the exact origin parent capability',
        summary: 'Never follow a replacement ancestor during durable replay.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T03:43:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000A',
      },
    );
    const capabilityAccepted = applyWorkItemReview(
      repositoryRoot,
      capabilityCreated.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(capabilityCreated.item),
        summary: capabilityCreated.item.interpretation.summary,
      },
      () => '2026-08-24T03:43:30.000Z',
    );
    const capabilityChangeDirectory = path.join(
      repositoryRoot,
      'openspec/changes/promotion-parent-capability',
    );
    const displacedChangeDirectory = path.join(
      externalRoot,
      'promotion-parent-capability',
    );
    fs.mkdirSync(capabilityChangeDirectory, { recursive: true });
    const capabilityItemPath = path.join(
      repositoryRoot,
      capabilityCreated.relativePath,
    );
    const capabilityItemBefore = fs.readFileSync(capabilityItemPath, 'utf8');

    assert.throws(
      () =>
        promoteWorkItem(
          repositoryRoot,
          capabilityAccepted.id,
          'promotion-parent-capability',
          () => '2026-08-24T03:44:00.000Z',
          workItemDigest(capabilityAccepted),
          false,
          {
            afterOriginParentCapabilityAcquired() {
              fs.renameSync(
                capabilityChangeDirectory,
                displacedChangeDirectory,
              );
              fs.symlinkSync(
                externalRoot,
                capabilityChangeDirectory,
                process.platform === 'win32' ? 'junction' : 'dir',
              );
            },
          },
        ),
      hasCode('WORK_REGISTRY_TRANSACTION_INVALID'),
    );
    assert.equal(
      fs.readFileSync(capabilityItemPath, 'utf8'),
      capabilityItemBefore,
    );
    assert.equal(
      fs.existsSync(path.join(displacedChangeDirectory, 'origin.json')),
      false,
    );
    assert.equal(fs.existsSync(path.join(externalRoot, 'origin.json')), false);
    fs.unlinkSync(capabilityChangeDirectory);
    fs.renameSync(displacedChangeDirectory, capabilityChangeDirectory);
    assert.deepEqual(validateWorkRegistry(repositoryRoot), {
      itemCount: 2,
      sourceCount: 1,
    });
    assert.equal(
      showWorkItem(repositoryRoot, capabilityAccepted.id).stage,
      'backlog',
    );
    assert.equal(
      fs.existsSync(path.join(capabilityChangeDirectory, 'origin.json')),
      false,
    );
    assert.equal(fs.existsSync(path.join(externalRoot, 'origin.json')), false);
    const capabilityRetried = promoteWorkItem(
      repositoryRoot,
      capabilityAccepted.id,
      'promotion-parent-capability',
      () => '2026-08-24T03:44:30.000Z',
      workItemDigest(capabilityAccepted),
    );
    assert.equal(capabilityRetried.item.stage, 'active');
    assert.equal(
      fs.existsSync(path.join(capabilityChangeDirectory, 'origin.json')),
      true,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
    fs.rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('persisted Work Item reads reject incoherent state, path identity drift, and noncanonical relation sets without mutation', () => {
  const cases = [
    {
      name: 'closed item without closure or closing timeline event',
      requestedId: 'WORK-01K39R0V000000000000000001',
      poison(item: Record<string, unknown>) {
        item.stage = 'closed';
      },
    },
    {
      name: 'record identity differs from stable filename',
      requestedId: 'WORK-01K39R0V000000000000000002',
      poison(item: Record<string, unknown>) {
        item.id = 'WORK-01K39R0V000000000000000002';
      },
    },
    {
      name: 'Source references are not canonically sorted',
      requestedId: 'WORK-01K39R0V000000000000000001',
      poison(item: Record<string, unknown>) {
        item.sourceRefs = [`SRC-${'b'.repeat(64)}`, `SRC-${'a'.repeat(64)}`];
      },
    },
    {
      name: 'blocker references are duplicated',
      requestedId: 'WORK-01K39R0V000000000000000001',
      poison(item: Record<string, unknown>) {
        item.blockedBy = [
          'WORK-01K39R0V000000000000000002',
          'WORK-01K39R0V000000000000000002',
        ];
      },
    },
  ] as const;

  for (const scenario of cases) {
    const repositoryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jigwright-work-item-read-boundary-'),
    );
    configureRepositoryConsumer(repositoryRoot);
    try {
      const created = createWorkItem(
        repositoryRoot,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'later',
          title: 'Persisted Work Item read boundary',
          summary: 'Reject durable state that no current writer can emit.',
          sourceRefs: [],
        },
        {
          now: () => '2026-08-24T04:20:00.000Z',
          createId: () => 'WORK-01K39R0V000000000000000001',
        },
      );
      const itemPath = path.join(repositoryRoot, created.relativePath);
      const poisoned = JSON.parse(fs.readFileSync(itemPath, 'utf8')) as Record<
        string,
        unknown
      >;
      scenario.poison(poisoned);
      const poisonedBytes = `${canonicalJson(poisoned)}\n`;
      fs.writeFileSync(itemPath, poisonedBytes);
      const entriesBefore = fs.readdirSync(path.dirname(itemPath)).sort();

      assert.throws(
        () => showWorkItem(repositoryRoot, scenario.requestedId),
        hasCode('WORK_REGISTRY_INVALID'),
        scenario.name,
      );
      assert.equal(fs.readFileSync(itemPath, 'utf8'), poisonedBytes);
      assert.deepEqual(
        fs.readdirSync(path.dirname(itemPath)).sort(),
        entriesBefore,
      );
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test('Work Item traversal rejects mismatched year shards and unsafe or noncanonical entries without mutation', () => {
  const itemId = 'WORK-01K39R0V000000000000000001';
  const cases = [
    {
      name: 'created year differs from path shard',
      poison(root: string, itemPath: string): string[] {
        const wrongYear = path.join(
          path.dirname(path.dirname(itemPath)),
          '2025',
        );
        fs.mkdirSync(wrongYear);
        fs.renameSync(itemPath, path.join(wrongYear, path.basename(itemPath)));
        return [];
      },
    },
    {
      name: 'year entry is a symbolic link',
      poison(root: string, itemPath: string): string[] {
        const target = path.join(root, 'unsafe-year-target');
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'sentinel.txt'), 'year target\n');
        fs.symlinkSync(
          target,
          path.join(path.dirname(path.dirname(itemPath)), '2025'),
          'dir',
        );
        return [target];
      },
    },
    {
      name: 'item entry is a symbolic link',
      poison(root: string, itemPath: string): string[] {
        const target = path.join(root, 'unsafe-item-target.json');
        fs.writeFileSync(target, 'item target\n');
        fs.symlinkSync(
          target,
          path.join(
            path.dirname(itemPath),
            'WORK-01K39R0V000000000000000002.yaml',
          ),
        );
        return [target];
      },
    },
    {
      name: 'year entry name is not canonical',
      poison(root: string, itemPath: string): string[] {
        fs.mkdirSync(
          path.join(path.dirname(path.dirname(itemPath)), 'year-2025'),
        );
        return [];
      },
    },
    {
      name: 'item entry name is not canonical',
      poison(root: string, itemPath: string): string[] {
        fs.writeFileSync(
          path.join(path.dirname(itemPath), 'README.md'),
          'poison\n',
        );
        return [];
      },
    },
  ] as const;

  for (const scenario of cases) {
    const repositoryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jigwright-work-item-traversal-'),
    );
    configureRepositoryConsumer(repositoryRoot);
    try {
      const created = createWorkItem(
        repositoryRoot,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'later',
          title: 'Work Item traversal boundary',
          summary: 'Reject unsafe or noncanonical durable item paths.',
          sourceRefs: [],
        },
        {
          now: () => '2026-08-24T04:21:00.000Z',
          createId: () => itemId,
        },
      );
      const itemPath = path.join(repositoryRoot, created.relativePath);
      const rendered = renderWorkRegistry(repositoryRoot);
      runGitForTest(repositoryRoot, ['init', '-b', 'main']);
      runGitForTest(repositoryRoot, ['config', 'user.name', 'Jigwright Test']);
      runGitForTest(repositoryRoot, [
        'config',
        'user.email',
        'jigwright@example.test',
      ]);
      runGitForTest(repositoryRoot, ['add', '.']);
      runGitForTest(repositoryRoot, ['commit', '-m', 'Track Work Registry']);
      const targets = scenario.poison(repositoryRoot, itemPath);
      const itemRoot = path.join(repositoryRoot, 'docs/work-registry/items');
      const snapshot = () => ({
        head: runGitForTest(repositoryRoot, ['rev-parse', 'HEAD']),
        refs: runGitForTest(repositoryRoot, ['show-ref']),
        status: runGitForTest(repositoryRoot, [
          'status',
          '--porcelain=v1',
          '-z',
        ]),
        entries: snapshotPlainTree(itemRoot),
        targets: targets.map((target) => snapshotPlainTree(target)),
        backlog: fs.readFileSync(rendered.backlogPath, 'utf8'),
        inventory: fs.readFileSync(rendered.inventoryPath, 'utf8'),
      });
      const before = snapshot();

      assert.throws(
        () => validateWorkRegistry(repositoryRoot),
        hasCode('WORK_REGISTRY_INVALID'),
        scenario.name,
      );
      assert.deepEqual(snapshot(), before);
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
  }
});

test('persisted Work Item admission requires canonical bytes and one stable writer-owned file without mutation', () => {
  const itemId = 'WORK-01K39R0V000000000000000001';
  const cases = [
    {
      name: 'semantically valid pretty-printed bytes',
      poison(root: string, itemPath: string, bytes: string) {
        fs.writeFileSync(
          itemPath,
          `${JSON.stringify(JSON.parse(bytes), null, 2)}\n`,
        );
        return { targets: [] as string[] };
      },
    },
    {
      name: 'semantically valid noncanonical key order',
      poison(root: string, itemPath: string, bytes: string) {
        const value = JSON.parse(bytes) as Record<string, unknown>;
        fs.writeFileSync(
          itemPath,
          `${JSON.stringify(Object.fromEntries(Object.entries(value).reverse()))}\n`,
        );
        return { targets: [] as string[] };
      },
    },
    {
      name: 'semantically valid CRLF termination',
      poison(root: string, itemPath: string, bytes: string) {
        fs.writeFileSync(itemPath, bytes.replace(/\n$/u, '\r\n'));
        return { targets: [] as string[] };
      },
    },
    {
      name: 'mode differs from the current writer policy',
      poison(root: string, itemPath: string) {
        fs.chmodSync(itemPath, 0o600);
        return { targets: [] as string[] };
      },
    },
    {
      name: 'Work Item has a second hard link',
      poison(root: string, itemPath: string) {
        const target = path.join(root, 'work-item-hardlink-target.yaml');
        fs.linkSync(itemPath, target);
        return { targets: [target] };
      },
    },
  ] as const;

  for (const scenario of cases) {
    const repositoryRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jigwright-work-item-persistence-'),
    );
    configureRepositoryConsumer(repositoryRoot);
    try {
      const created = createWorkItem(
        repositoryRoot,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'later',
          title: 'Work Item persistence boundary',
          summary: 'Admit only the exact current writer representation.',
          sourceRefs: [],
        },
        {
          now: () => '2026-08-24T04:22:00.000Z',
          createId: () => itemId,
          aliases: ['ISS-321'],
        },
      );
      const itemPath = path.join(repositoryRoot, created.relativePath);
      const writerStats = fs.lstatSync(itemPath);
      assert.equal(writerStats.mode & 0o777, 0o644);
      if (typeof process.getuid === 'function') {
        assert.equal(writerStats.uid, process.getuid());
      }
      const canonicalBytes = fs.readFileSync(itemPath, 'utf8');
      const rendered = renderWorkRegistry(repositoryRoot);
      runGitForTest(repositoryRoot, ['init', '-b', 'main']);
      runGitForTest(repositoryRoot, ['config', 'user.name', 'Jigwright Test']);
      runGitForTest(repositoryRoot, [
        'config',
        'user.email',
        'jigwright@example.test',
      ]);
      runGitForTest(repositoryRoot, ['add', '.']);
      runGitForTest(repositoryRoot, ['commit', '-m', 'Track Work Registry']);
      const poisoned = scenario.poison(
        repositoryRoot,
        itemPath,
        canonicalBytes,
      );
      const itemRoot = path.join(repositoryRoot, 'docs/work-registry/items');
      const snapshot = () => ({
        head: runGitForTest(repositoryRoot, ['rev-parse', 'HEAD']),
        refs: runGitForTest(repositoryRoot, ['show-ref']),
        status: runGitForTest(repositoryRoot, [
          'status',
          '--porcelain=v1',
          '-z',
        ]),
        entries: snapshotPlainTree(itemRoot),
        targets: poisoned.targets.map((target) => snapshotPlainTree(target)),
        backlog: fs.readFileSync(rendered.backlogPath, 'utf8'),
        inventory: fs.readFileSync(rendered.inventoryPath, 'utf8'),
      });
      const before = snapshot();
      assert.throws(
        () => validateWorkRegistry(repositoryRoot),
        hasCode('WORK_REGISTRY_INVALID'),
        scenario.name,
      );
      assert.deepEqual(snapshot(), before);
    } finally {
      fs.rmSync(repositoryRoot, { recursive: true, force: true });
    }
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

test('reviewed intake and priority use exact current Work Item digests', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-review-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'improvement',
        lane: null,
        title: 'Review this intake',
        summary: 'Move the exact reviewed item into the backlog.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:30:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000001',
      },
    ).item;
    const accepted = applyWorkItemReview(
      repositoryRoot,
      created.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created),
        summary: 'Confirmed for the reviewed backlog.',
      },
      () => '2026-08-24T04:31:00.000Z',
    );
    assert.equal(accepted.stage, 'backlog');
    assert.equal(accepted.interpretation.status, 'maintainer-confirmed');

    assert.throws(
      () =>
        applyWorkItemReview(
          repositoryRoot,
          created.id,
          {
            action: 'prioritize',
            expectedDigest: workItemDigest(created),
            lane: 'now',
            blockedBy: [],
          },
          () => '2026-08-24T04:32:00.000Z',
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORK_REGISTRY_STALE',
    );

    const prioritized = applyWorkItemReview(
      repositoryRoot,
      created.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(accepted),
        lane: 'now',
        blockedBy: [],
      },
      () => '2026-08-24T04:33:00.000Z',
    );
    assert.equal(prioritized.lane, 'now');
    assert.equal(prioritized.timeline.at(-1)?.event, 'prioritized');
    assert.deepEqual(showWorkItem(repositoryRoot, created.id), prioritized);
    assert.deepEqual(searchWorkItems(repositoryRoot, 'confirmed'), [
      prioritized,
    ]);
    assert.deepEqual(traceWorkItem(repositoryRoot, created.id), {
      item: prioritized,
      origins: [],
      sources: [],
    });
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Work Registry search resolves exact linked Source wording without copying it', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-source-search-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const source = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T04:33:30.000Z',
      contextRef: 'direct-human:thread/turn-source-search',
      text: '保留 Cobalt Finch maintainer 原話作為可追溯依據。\n',
      supersedes: null,
    });
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'research',
        lane: 'next',
        title: 'Search immutable provenance',
        summary: 'Find this item from its linked canonical Source.',
        sourceRefs: [source.source.id],
      },
      {
        now: () => '2026-08-24T04:34:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000020',
      },
    );
    const sourcePath = path.join(repositoryRoot, source.relativePath);
    const itemPath = path.join(repositoryRoot, created.relativePath);
    const before = {
      source: fs.readFileSync(sourcePath),
      item: fs.readFileSync(itemPath),
    };

    assert.deepEqual(searchWorkItems(repositoryRoot, 'cobalt finch'), [
      created.item,
    ]);
    assert.deepEqual(
      dispatchGovernanceIntakeCommand(
        'work-item',
        ['search', 'cobalt finch'],
        repositoryRoot,
      ),
      { action: 'search', items: [created.item] },
    );
    assert.doesNotMatch(fs.readFileSync(itemPath, 'utf8'), /Cobalt Finch/u);
    assert.deepEqual(fs.readFileSync(sourcePath), before.source);
    assert.deepEqual(fs.readFileSync(itemPath), before.item);

    const poisonedSource = JSON.parse(
      fs.readFileSync(sourcePath, 'utf8'),
    ) as Record<string, unknown>;
    poisonedSource.text = 'Poisoned text with a stale identity.\n';
    fs.writeFileSync(sourcePath, `${canonicalJson(poisonedSource)}\n`);
    const poisonedBytes = fs.readFileSync(sourcePath);
    assert.throws(
      () => searchWorkItems(repositoryRoot, 'search immutable provenance'),
      hasCode('GOVERNANCE_SOURCE_IDENTITY_INVALID'),
    );
    assert.deepEqual(fs.readFileSync(sourcePath), poisonedBytes);
    assert.deepEqual(fs.readFileSync(itemPath), before.item);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('priority recommendations are explainable and inventory exposes current intake facts', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-priority-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const blocker = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'chore',
        lane: 'next',
        title: 'Resolve the prerequisite',
        summary: 'This item must close before the dependent item can start.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:34:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000007',
      },
    ).item;
    const dependent = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Use the completed prerequisite',
        summary: 'Keep recommendation reasons explicit and replayable.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:35:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000008',
      },
    ).item;
    const acceptedBlocker = applyWorkItemReview(
      repositoryRoot,
      blocker.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(blocker),
        summary: blocker.interpretation.summary,
      },
      () => '2026-08-24T04:36:00.000Z',
    );
    const acceptedDependent = applyWorkItemReview(
      repositoryRoot,
      dependent.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(dependent),
        summary: dependent.interpretation.summary,
      },
      () => '2026-08-24T04:37:00.000Z',
    );
    const currentBlocker = applyWorkItemReview(
      repositoryRoot,
      blocker.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(acceptedBlocker),
        lane: 'now',
        blockedBy: [],
      },
      () => '2026-08-24T04:38:00.000Z',
    );
    const blockedDependent = applyWorkItemReview(
      repositoryRoot,
      dependent.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(acceptedDependent),
        lane: 'next',
        blockedBy: [blocker.id],
      },
      () => '2026-08-24T04:39:00.000Z',
    );

    assert.deepEqual(
      recommendWorkItemPriorities(repositoryRoot).find(
        ({ workItemId }) => workItemId === dependent.id,
      ),
      {
        workItemId: dependent.id,
        currentLane: 'next',
        suggestedLane: 'later',
        reasons: [`unresolved-blocker:${blocker.id}`],
      },
    );
    assert.deepEqual(inspectWorkRegistry(repositoryRoot), {
      schemaVersion: 1,
      itemCount: 2,
      sourceCount: 0,
      items: [
        {
          id: blocker.id,
          title: blocker.title,
          stage: 'backlog',
          lane: 'now',
          aliases: [],
          blockedBy: [],
        },
        {
          id: dependent.id,
          title: dependent.title,
          stage: 'backlog',
          lane: 'next',
          aliases: [],
          blockedBy: [blocker.id],
        },
      ],
      stages: { inbox: 0, backlog: 2, active: 0, closed: 0 },
      lanes: { now: 1, next: 1, later: 0, icebox: 0, unprioritized: 0 },
      currentItemIds: [currentBlocker.id],
      blockedItemIds: [blockedDependent.id],
    });

    applyWorkItemReview(
      repositoryRoot,
      blocker.id,
      {
        action: 'decline',
        expectedDigest: workItemDigest(currentBlocker),
        outcome: 'obsolete',
      },
      () => '2026-08-24T04:40:00.000Z',
    );
    assert.deepEqual(
      recommendWorkItemPriorities(repositoryRoot).find(
        ({ workItemId }) => workItemId === dependent.id,
      ),
      {
        workItemId: dependent.id,
        currentLane: 'next',
        suggestedLane: 'next',
        reasons: ['maintainer-lane-retained'],
      },
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('promotion requires reviewed backlog priority and satisfied blockers', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-promotion-eligibility-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    runGitForTest(repositoryRoot, ['init', '-b', 'main']);
    const blocker = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'chore',
        lane: 'next',
        title: 'Promotion blocker',
        summary: 'Close this item before promotion.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:41:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000009',
      },
    ).item;
    const candidate = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'later',
        title: 'Promotion candidate',
        summary: 'Promotion must consume reviewed current facts.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:42:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000A',
      },
    ).item;
    fs.mkdirSync(
      path.join(repositoryRoot, 'openspec/changes/eligible-change'),
      {
        recursive: true,
      },
    );

    assert.throws(
      () => promoteWorkItem(repositoryRoot, candidate.id, 'eligible-change'),
      hasCode('WORK_REGISTRY_PROMOTION_INELIGIBLE'),
    );
    const acceptedCandidate = applyWorkItemReview(
      repositoryRoot,
      candidate.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(candidate),
        summary: candidate.interpretation.summary,
      },
      () => '2026-08-24T04:43:00.000Z',
    );
    assert.throws(
      () =>
        promoteWorkItem(
          repositoryRoot,
          candidate.id,
          'eligible-change',
          undefined,
          workItemDigest(acceptedCandidate),
        ),
      hasCode('WORK_REGISTRY_PROMOTION_INELIGIBLE'),
    );
    const acceptedBlocker = applyWorkItemReview(
      repositoryRoot,
      blocker.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(blocker),
        summary: blocker.interpretation.summary,
      },
      () => '2026-08-24T04:44:00.000Z',
    );
    const currentCandidate = applyWorkItemReview(
      repositoryRoot,
      candidate.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(acceptedCandidate),
        lane: 'next',
        blockedBy: [blocker.id],
      },
      () => '2026-08-24T04:45:00.000Z',
    );
    assert.throws(
      () =>
        promoteWorkItem(
          repositoryRoot,
          candidate.id,
          'eligible-change',
          undefined,
          workItemDigest(currentCandidate),
        ),
      hasCode('WORK_REGISTRY_PROMOTION_INELIGIBLE'),
    );
    applyWorkItemReview(
      repositoryRoot,
      blocker.id,
      {
        action: 'decline',
        expectedDigest: workItemDigest(acceptedBlocker),
        outcome: 'obsolete',
      },
      () => '2026-08-24T04:46:00.000Z',
    );
    assert.equal(
      promoteWorkItem(
        repositoryRoot,
        candidate.id,
        'eligible-change',
        () => '2026-08-24T04:47:00.000Z',
        workItemDigest(currentCandidate),
      ).item.stage,
      'active',
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('protected intake produces one exact Central Fail-Grant challenge', async () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-protected-intake-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const item = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Protected intake candidate',
        summary: 'This transition is repository-policy protected.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:48:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000D',
      },
    ).item;
    fs.mkdirSync(path.join(repositoryRoot, 'workflow'), { recursive: true });
    fs.writeFileSync(
      path.join(repositoryRoot, 'workflow/work-registry-policy.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        transitions: {
          intake: 'central-grant',
          prioritize: 'ordinary',
          promote: 'central-grant',
        },
      })}\n`,
    );
    const reviewPath = path.join(repositoryRoot, 'review.json');
    fs.writeFileSync(
      reviewPath,
      `${JSON.stringify({
        action: 'accept',
        expectedDigest: workItemDigest(item),
        summary: item.interpretation.summary,
      })}\n`,
    );

    const args = ['work-item', 'review', item.id, '--input', reviewPath];
    let failure: unknown;
    try {
      dispatchGovernanceIntakeCommand(
        'work-item',
        ['review', item.id, '--input', reviewPath],
        repositoryRoot,
      );
      assert.fail('expected protected Work Registry review to require Grant');
    } catch (error) {
      failure = error;
    }
    assert.ok(hasCode('WORK_REGISTRY_GRANT_REQUIRED')(failure));
    fs.unlinkSync(reviewPath);

    const challengeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const challengeDigest = `sha256:${'b'.repeat(64)}` as const;
    const result = await createWorkRegistryFailGrantResult(
      args,
      repositoryRoot,
      failure,
      {
        async requestReview(cwd, workItemId, review, proposedReason) {
          assert.equal(cwd, repositoryRoot);
          assert.equal(workItemId, item.id);
          assert.deepEqual(review, {
            action: 'accept',
            expectedDigest: workItemDigest(item),
            summary: item.interpretation.summary,
          });
          assert.match(
            proposedReason,
            /exact accept Work Registry transition/u,
          );
          return { challengeId, challengeDigest };
        },
        async requestPromotion() {
          assert.fail('review must not request a promotion Grant');
        },
      },
    );
    assert.deepEqual(result, {
      command: 'work-item',
      ok: true,
      result: {
        schemaVersion: 1,
        kind: 'workflow-fail-grant-required.v1',
        workItemId: item.id,
        transition: 'intake',
        state: 'human-action-required',
        nextAction: 'human-action',
        failure: {
          code: 'WORK_REGISTRY_GRANT_REQUIRED',
          message:
            'Repository policy requires Central Grant for the intake transition.',
          details: {
            schemaVersion: 1,
            kind: 'work-registry-grant-required.v1',
            operation: 'review',
            transition: 'intake',
            workItemId: item.id,
            review: {
              action: 'accept',
              expectedDigest: workItemDigest(item),
              summary: item.interpretation.summary,
            },
          },
        },
        grant: { challengeId, challengeDigest },
        transitionAppliesOnDecision: true,
        inputSchema: {
          schemaVersion: 1,
          kind: 'central-grant-resolution.v1',
          inspectCommand: `pnpm workflow grant human inspect ${challengeId} --json`,
          decisionCommand: `pnpm workflow grant human decide ${challengeId} --json`,
          recoveryCommand: `pnpm workflow grant human recover ${challengeId} --json`,
          observeAfterDecision: `pnpm workflow work-item show ${item.id} --json`,
        },
      },
    });
    assert.deepEqual(
      workflowResultNextSteps(result!, args).map(({ command }) => command),
      [
        `pnpm workflow grant human inspect ${challengeId} --json`,
        `pnpm workflow grant human decide ${challengeId} --json`,
        `pnpm workflow work-item show ${item.id} --json`,
      ],
    );
    assert.equal(showWorkItem(repositoryRoot, item.id).stage, 'inbox');
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Work Registry Fail-Grant mapper preserves exact transition semantics', async () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-fail-grant-map-'),
  );
  try {
    const workItemId = 'WORK-01K39R0V00000000000000000F';
    const digest = `sha256:${'c'.repeat(64)}`;
    const challengeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const challengeDigest = `sha256:${'d'.repeat(64)}` as const;
    const calls: unknown[][] = [];
    const dependencies = {
      async requestReview(...values: unknown[]) {
        calls.push(['review', ...values]);
        return { challengeId, challengeDigest };
      },
      async requestPromotion(...values: unknown[]) {
        calls.push(['promote', ...values]);
        return { challengeId, challengeDigest };
      },
    };
    const cases = [
      {
        transition: 'intake',
        args: ['work-item', 'review', workItemId, '--input', 'accept.json'],
        details: {
          schemaVersion: 1,
          kind: 'work-registry-grant-required.v1',
          operation: 'review',
          transition: 'intake',
          workItemId,
          review: { action: 'accept', expectedDigest: digest, summary: 'Keep' },
        },
        requestKind: 'review',
      },
      {
        transition: 'intake',
        args: ['work-item', 'review', workItemId, '--input', 'decline.json'],
        details: {
          schemaVersion: 1,
          kind: 'work-registry-grant-required.v1',
          operation: 'review',
          transition: 'intake',
          workItemId,
          review: {
            action: 'decline',
            expectedDigest: digest,
            outcome: 'obsolete',
          },
        },
        requestKind: 'review',
      },
      {
        transition: 'prioritize',
        args: ['work-item', 'review', workItemId, '--input', 'prioritize.json'],
        details: {
          schemaVersion: 1,
          kind: 'work-registry-grant-required.v1',
          operation: 'review',
          transition: 'prioritize',
          workItemId,
          review: {
            action: 'prioritize',
            expectedDigest: digest,
            lane: 'next',
            blockedBy: [],
          },
        },
        requestKind: 'review',
      },
      {
        transition: 'promote',
        args: [
          'work-item',
          'promote',
          workItemId,
          '--change',
          'promoted-change',
          '--expected',
          digest,
        ],
        details: {
          schemaVersion: 1,
          kind: 'work-registry-grant-required.v1',
          operation: 'promote',
          transition: 'promote',
          workItemId,
          changeId: 'promoted-change',
          expectedDigest: digest,
        },
        requestKind: 'promote',
      },
    ] as const;

    for (const entry of cases) {
      calls.length = 0;
      const result = await createWorkRegistryFailGrantResult(
        entry.args,
        repositoryRoot,
        workflowError(
          'WORK_REGISTRY_GRANT_REQUIRED',
          'Central Grant is required.',
          ExitCode.guard,
          { details: entry.details },
        ),
        dependencies,
      );
      assert.equal(
        (result?.result as { transition: string }).transition,
        entry.transition,
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.[0], entry.requestKind);
      assert.equal(calls[0]?.[1], repositoryRoot);
      assert.equal(calls[0]?.[2], workItemId);
      if (entry.details.operation === 'review') {
        assert.deepEqual(calls[0]?.[3], entry.details.review);
        assert.match(
          String(calls[0]?.[4]),
          new RegExp(`exact ${entry.details.review.action}`),
        );
      } else {
        assert.equal(calls[0]?.[3], entry.details.changeId);
        assert.equal(calls[0]?.[4], entry.details.expectedDigest);
        assert.match(String(calls[0]?.[5]), /exact Work Registry promotion/u);
      }
    }

    let requestCount = 0;
    const mustNotRequest = {
      async requestReview() {
        requestCount += 1;
        return { challengeId, challengeDigest };
      },
      async requestPromotion() {
        requestCount += 1;
        return { challengeId, challengeDigest };
      },
    };
    assert.equal(
      await createWorkRegistryFailGrantResult(
        ['work-item', 'review', workItemId, '--input', 'review.json'],
        repositoryRoot,
        workflowError(
          'WORK_REGISTRY_GRANT_REQUIRED',
          'Central Grant is required.',
          ExitCode.guard,
          {
            details: {
              ...cases[0].details,
              unexpected: true,
            },
          },
        ),
        mustNotRequest,
      ),
      null,
    );
    assert.equal(
      await createWorkRegistryFailGrantResult(
        [
          'work-item',
          'promote',
          workItemId,
          '--change',
          'other-change',
          '--expected',
          digest,
        ],
        repositoryRoot,
        workflowError(
          'WORK_REGISTRY_GRANT_REQUIRED',
          'Central Grant is required.',
          ExitCode.guard,
          { details: cases[3].details },
        ),
        mustNotRequest,
      ),
      null,
    );
    assert.equal(requestCount, 0);

    const sentinel = new Error('policy changed before challenge creation');
    await assert.rejects(
      createWorkRegistryFailGrantResult(
        cases[0].args,
        repositoryRoot,
        workflowError(
          'WORK_REGISTRY_GRANT_REQUIRED',
          'Central Grant is required.',
          ExitCode.guard,
          { details: cases[0].details },
        ),
        {
          async requestReview() {
            throw sentinel;
          },
          async requestPromotion() {
            assert.fail('review must not request promotion');
          },
        },
      ),
      (error) => error === sentinel,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('registered Central Grant review transition applies the exact reviewed item once', async () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-grant-transition-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const item = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Grant-routed intake candidate',
        summary: 'Central Grant executes only this exact reviewed mutation.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:49:00.000Z',
        createId: () => 'WORK-01K39R0V00000000000000000E',
      },
    ).item;
    const review = {
      action: 'accept' as const,
      expectedDigest: workItemDigest(item),
      summary: item.interpretation.summary,
    };
    const definitions = workRegistryGrantTransitionDefinitions(
      repositoryRoot,
      () => '2026-08-24T04:50:00.000Z',
    );
    const registry = createTransitionRegistry(definitions);
    const request = createWorkRegistryReviewGrantRequest({
      repositoryRoot,
      workItemId: item.id,
      review,
      proposedReason: 'Approve the exact reviewed intake transition.',
    });
    const challenge = createGrantChallenge(request, registry, {
      challengeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      now: new Date('2026-08-24T04:49:30.000Z'),
      expiresAt: '2026-08-24T05:09:30.000Z',
    });
    assert.equal(challenge.choices[0]?.transitionId, 'work-registry.review.v1');
    const definition = registry.resolve('work-registry.review.v1');
    const parameters = definition.validateParameters(
      challenge.choices[0]?.parameters,
    );
    const outcome = await definition.execute({
      parameters,
      approvalSubject: {} as never,
      approvalSubjectDigest: `sha256:${'a'.repeat(64)}`,
      challengeId: challenge.challengeId,
      operationId: 'operation-work-registry-review',
      recovered: false,
      assertLifecycleOwned() {},
    });
    assert.equal(outcome.outcome, 'completed');
    assert.equal(showWorkItem(repositoryRoot, item.id).stage, 'backlog');
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('registered Central Grant promotion applies one current surveyed linkage and rejects replay or stale survey without mutation', async () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-grant-promotion-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    runGitForTest(repositoryRoot, ['init', '-b', 'main']);
    runGitForTest(repositoryRoot, ['config', 'user.name', 'Jigwright Test']);
    runGitForTest(repositoryRoot, [
      'config',
      'user.email',
      'jigwright@example.test',
    ]);
    const prepareCandidate = (
      workItemId: string,
      changeId: string,
      createdAt: string,
      acceptedAt: string,
    ) => {
      const created = createWorkItem(
        repositoryRoot,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'next',
          title: `Grant promotion for ${changeId}`,
          summary: 'Central Grant applies one exact surveyed promotion.',
          sourceRefs: [],
        },
        {
          now: () => createdAt,
          createId: () => workItemId,
        },
      );
      const accepted = applyWorkItemReview(
        repositoryRoot,
        created.item.id,
        {
          action: 'accept',
          expectedDigest: workItemDigest(created.item),
          summary: created.item.interpretation.summary,
        },
        () => acceptedAt,
      );
      const changeDirectory = path.join(
        repositoryRoot,
        'openspec/changes',
        changeId,
      );
      fs.mkdirSync(changeDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(changeDirectory, 'proposal.md'),
        `# ${changeId}\n`,
      );
      return { created, accepted, changeDirectory };
    };
    const createPromotionChallenge = (
      workItemId: string,
      changeId: string,
      expectedDigest: string,
      challengeId: string,
      promotedAt: string,
    ) => {
      const registry = createTransitionRegistry(
        workRegistryGrantTransitionDefinitions(
          repositoryRoot,
          () => promotedAt,
        ),
      );
      const request = createWorkRegistryPromotionGrantRequest({
        repositoryRoot,
        workItemId,
        changeId,
        expectedDigest,
        proposedReason: 'Approve this exact surveyed Work Registry promotion.',
      });
      const challenge = createGrantChallenge(request, registry, {
        challengeId,
        now: new Date('2026-08-24T05:02:00.000Z'),
        expiresAt: '2026-08-24T05:22:00.000Z',
      });
      assert.equal(
        challenge.choices[0]?.transitionId,
        'work-registry.promote.v1',
      );
      const definition = registry.resolve('work-registry.promote.v1');
      return {
        challengeId,
        definition,
        parameters: definition.validateParameters(
          challenge.choices[0]?.parameters,
        ),
      };
    };
    const executePromotion = (
      transition: ReturnType<typeof createPromotionChallenge>,
      operationId: string,
      recovered = false,
      assertLifecycleOwned: () => void = () => undefined,
    ) =>
      transition.definition.execute({
        parameters: transition.parameters,
        approvalSubject: {} as never,
        approvalSubjectDigest: `sha256:${'a'.repeat(64)}`,
        challengeId: transition.challengeId,
        operationId,
        recovered,
        assertLifecycleOwned,
      });
    const snapshotPromotion = (
      itemPath: string,
      originPath: string,
      surveyPath: string,
    ) => ({
      item: fs.readFileSync(itemPath, 'utf8'),
      origin: fs.existsSync(originPath)
        ? fs.readFileSync(originPath, 'utf8')
        : null,
      survey: fs.readFileSync(surveyPath, 'utf8'),
      head: runGitForTest(repositoryRoot, ['rev-parse', 'HEAD']),
      refs: runGitForTest(repositoryRoot, ['show-ref']),
      status: runGitForTest(repositoryRoot, ['status', '--porcelain=v1', '-z']),
    });

    const current = prepareCandidate(
      'WORK-01K39R0V00000000000000000G',
      'grant-promoted-current',
      '2026-08-24T04:58:00.000Z',
      '2026-08-24T04:59:00.000Z',
    );
    runGitForTest(repositoryRoot, ['add', '.']);
    runGitForTest(repositoryRoot, [
      'commit',
      '-m',
      'Prepare current promotion',
    ]);
    const currentSurvey = prepareWorkItemPromotionSurvey(
      repositoryRoot,
      current.accepted.id,
      'grant-promoted-current',
      {
        schemaVersion: 1,
        symbols: [],
        emptyReason: 'No load-bearing symbols for this local acceptance.',
      },
    );
    const currentTransition = createPromotionChallenge(
      current.accepted.id,
      'grant-promoted-current',
      workItemDigest(current.accepted),
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '2026-08-24T05:03:00.000Z',
    );
    const outcome = await executePromotion(
      currentTransition,
      'operation-work-registry-promotion',
    );
    assert.deepEqual(outcome, {
      outcome: 'completed',
      details: {
        action: 'promote',
        workItemId: current.accepted.id,
        changeId: 'grant-promoted-current',
      },
    });
    const currentItemPath = path.join(
      repositoryRoot,
      current.created.relativePath,
    );
    const currentOriginPath = path.join(current.changeDirectory, 'origin.json');
    const currentSurveyPath = path.join(
      repositoryRoot,
      currentSurvey.relativePath,
    );
    assert.deepEqual(showWorkItem(repositoryRoot, current.accepted.id), {
      ...current.accepted,
      stage: 'active',
      changeRefs: ['grant-promoted-current'],
      timeline: [
        ...current.accepted.timeline,
        {
          at: '2026-08-24T05:03:00.000Z',
          event: 'promoted',
          changeId: 'grant-promoted-current',
        },
      ],
    });
    assert.deepEqual(JSON.parse(fs.readFileSync(currentOriginPath, 'utf8')), {
      schemaVersion: 1,
      sourceRefs: [],
      workItemRefs: [current.accepted.id],
    });
    const afterCurrentPromotion = snapshotPromotion(
      currentItemPath,
      currentOriginPath,
      currentSurveyPath,
    );
    const promotionReceiptRoot = path.join(
      repositoryRoot,
      '.git/workflow-engine/work-registry/recovered-promotions',
    );
    const [currentReceiptName] = fs.readdirSync(promotionReceiptRoot);
    assert.ok(currentReceiptName);
    const currentReceipt = JSON.parse(
      fs.readFileSync(
        path.join(promotionReceiptRoot, currentReceiptName),
        'utf8',
      ),
    ) as { grantBinding: unknown };
    assert.deepEqual(currentReceipt.grantBinding, {
      schemaVersion: 1,
      challengeId: currentTransition.challengeId,
      operationId: 'operation-work-registry-promotion',
      approvalSubjectDigest: `sha256:${'a'.repeat(64)}`,
      surveyDigest: (currentTransition.parameters as { surveyDigest: string })
        .surveyDigest,
    });
    await assert.rejects(
      executePromotion(
        currentTransition,
        'operation-work-registry-promotion-replay',
        true,
      ),
      hasCode('WORK_REGISTRY_GRANT_STALE'),
    );
    await assert.rejects(
      executePromotion(
        {
          ...currentTransition,
          challengeId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        },
        'operation-work-registry-promotion',
        true,
      ),
      hasCode('WORK_REGISTRY_GRANT_STALE'),
    );
    await assert.rejects(
      executePromotion(
        {
          ...currentTransition,
          parameters: {
            ...(currentTransition.parameters as Record<string, unknown>),
            surveyDigest: `sha256:${'9'.repeat(64)}`,
          },
        },
        'operation-work-registry-promotion',
        true,
      ),
      hasCode('WORK_REGISTRY_GRANT_STALE'),
    );
    assert.deepEqual(
      snapshotPromotion(currentItemPath, currentOriginPath, currentSurveyPath),
      afterCurrentPromotion,
    );

    const stale = prepareCandidate(
      'WORK-01K39R0V00000000000000000H',
      'grant-promoted-stale',
      '2026-08-24T05:04:00.000Z',
      '2026-08-24T05:05:00.000Z',
    );
    runGitForTest(repositoryRoot, ['add', '.']);
    runGitForTest(repositoryRoot, ['commit', '-m', 'Prepare stale promotion']);
    const staleSurvey = prepareWorkItemPromotionSurvey(
      repositoryRoot,
      stale.accepted.id,
      'grant-promoted-stale',
      {
        schemaVersion: 1,
        symbols: [],
        emptyReason: 'No load-bearing symbols for this stale acceptance.',
      },
    );
    const staleTransition = createPromotionChallenge(
      stale.accepted.id,
      'grant-promoted-stale',
      workItemDigest(stale.accepted),
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      '2026-08-24T05:06:00.000Z',
    );
    fs.writeFileSync(
      path.join(repositoryRoot, 'head-advance.txt'),
      'Advance HEAD after the exact survey.\n',
    );
    runGitForTest(repositoryRoot, ['add', 'head-advance.txt']);
    runGitForTest(repositoryRoot, ['commit', '-m', 'Advance after survey']);
    const staleItemPath = path.join(repositoryRoot, stale.created.relativePath);
    const staleOriginPath = path.join(stale.changeDirectory, 'origin.json');
    const staleSurveyPath = path.join(repositoryRoot, staleSurvey.relativePath);
    const beforeStaleRefusal = snapshotPromotion(
      staleItemPath,
      staleOriginPath,
      staleSurveyPath,
    );
    await assert.rejects(
      executePromotion(
        staleTransition,
        'operation-work-registry-promotion-stale',
      ),
      hasCode('WORK_REGISTRY_GRANT_STALE'),
    );
    assert.deepEqual(
      snapshotPromotion(staleItemPath, staleOriginPath, staleSurveyPath),
      beforeStaleRefusal,
    );

    const changedSurvey = prepareCandidate(
      'WORK-01K39R0V00000000000000000K',
      'grant-promoted-changed-survey',
      '2026-08-24T05:06:10.000Z',
      '2026-08-24T05:06:20.000Z',
    );
    runGitForTest(repositoryRoot, ['add', '.']);
    runGitForTest(repositoryRoot, [
      'commit',
      '-m',
      'Prepare survey-binding promotion',
    ]);
    const changedSurveyRecord = prepareWorkItemPromotionSurvey(
      repositoryRoot,
      changedSurvey.accepted.id,
      'grant-promoted-changed-survey',
      {
        schemaVersion: 1,
        symbols: [],
        emptyReason: 'No load-bearing symbols before exact Grant approval.',
      },
    );
    const changedSurveyTransition = createPromotionChallenge(
      changedSurvey.accepted.id,
      'grant-promoted-changed-survey',
      workItemDigest(changedSurvey.accepted),
      'ffffffff-ffff-4fff-8fff-ffffffffffff',
      '2026-08-24T05:06:30.000Z',
    );
    const changedSurveyPath = path.join(
      repositoryRoot,
      changedSurveyRecord.relativePath,
    );
    const changedSurveyBytes = JSON.parse(
      fs.readFileSync(changedSurveyPath, 'utf8'),
    ) as Record<string, unknown>;
    changedSurveyBytes.emptyReason =
      'Different canonical survey facts after exact Grant approval.';
    const changedSurveyContent = `${canonicalJson(changedSurveyBytes)}\n`;
    const changedSurveyItemPath = path.join(
      repositoryRoot,
      changedSurvey.created.relativePath,
    );
    const changedSurveyOriginPath = path.join(
      changedSurvey.changeDirectory,
      'origin.json',
    );
    const beforeChangedSurveyRefusal = snapshotPromotion(
      changedSurveyItemPath,
      changedSurveyOriginPath,
      changedSurveyPath,
    );
    let lifecycleAssertions = 0;
    await assert.rejects(
      executePromotion(
        changedSurveyTransition,
        'operation-work-registry-promotion-changed-survey',
        false,
        () => {
          lifecycleAssertions += 1;
          if (lifecycleAssertions === 2) {
            fs.writeFileSync(changedSurveyPath, changedSurveyContent);
          }
        },
      ),
      hasCode('WORK_REGISTRY_GRANT_STALE'),
    );
    assert.deepEqual(
      snapshotPromotion(
        changedSurveyItemPath,
        changedSurveyOriginPath,
        changedSurveyPath,
      ),
      {
        ...beforeChangedSurveyRefusal,
        survey: changedSurveyContent,
      },
    );

    const recoverable = prepareCandidate(
      'WORK-01K39R0V00000000000000000J',
      'grant-promoted-recovered',
      '2026-08-24T05:07:00.000Z',
      '2026-08-24T05:08:00.000Z',
    );
    runGitForTest(repositoryRoot, ['add', '.']);
    runGitForTest(repositoryRoot, [
      'commit',
      '-m',
      'Prepare recoverable promotion',
    ]);
    prepareWorkItemPromotionSurvey(
      repositoryRoot,
      recoverable.accepted.id,
      'grant-promoted-recovered',
      {
        schemaVersion: 1,
        symbols: [],
        emptyReason: 'No load-bearing symbols for this recovery acceptance.',
      },
    );
    const recoverableExpectedDigest = workItemDigest(recoverable.accepted);
    const grantRuntimeRoot = path.join(repositoryRoot, '.git/workflow-engine');
    const challengeId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const operationId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const crash = new Error(
      'simulated crash after exact promotion receipt publication',
    );
    const createCoordinator = (options: {
      challengeId: string;
      operationId: string;
      crashAfterCommit?: Error;
      crashAfterPrepare?: Error;
    }) => {
      const ids = [options.challengeId, options.operationId];
      return createGrantCoordinatorKernel({
        paths: grantStorePaths(grantRuntimeRoot),
        registry: createTransitionRegistry(
          workRegistryGrantTransitionDefinitions(
            repositoryRoot,
            () => '2026-08-24T05:09:00.000Z',
            options.crashAfterCommit
              ? {
                  afterTransactionCommitted() {
                    throw options.crashAfterCommit;
                  },
                }
              : {},
          ),
        ),
        policy: workRegistryGrantPolicy(),
        now: () => new Date('2026-08-24T05:08:30.000Z'),
        randomUUID: () => ids.shift()!,
        openApprovalSession(presentation) {
          return {
            async collectDecision() {
              return {
                choiceId: presentation.choices[0]!.choiceId,
                approvalMethod: 'human-presence' as const,
                reasonCode: 'approve-work-registry-transition',
                reason: 'Approve and recover this exact Work Item promotion.',
                sessionNonce: 'nonce-77777777777777777777777777777777',
              };
            },
            async authenticate({ approvalSubjectDigest }) {
              return [
                {
                  moduleId: 'human-gate-macos',
                  version: '1',
                  claims: ['fresh-local-device-owner'] as const,
                  approvalSubjectDigest,
                  proofDigest: `sha256:${'7'.repeat(64)}` as const,
                  verifiedAt: '2026-08-24T05:08:30.000Z',
                  identity: null,
                  portableEvidence: null,
                },
              ];
            },
            async close() {},
          };
        },
        async withLifecycleOperation(_requestedChallengeId, operation) {
          let assertions = 0;
          return operation(() => {
            assertions += 1;
            if (assertions === 3 && options.crashAfterPrepare) {
              throw options.crashAfterPrepare;
            }
          });
        },
      });
    };
    const crashingCoordinator = createCoordinator({
      challengeId,
      operationId,
      crashAfterCommit: crash,
    });
    const recoverableGrantRequest = createWorkRegistryPromotionGrantRequest({
      repositoryRoot,
      workItemId: recoverable.accepted.id,
      changeId: 'grant-promoted-recovered',
      expectedDigest: recoverableExpectedDigest,
      proposedReason: 'Approve this exact recoverable promotion.',
    });
    const requested = await crashingCoordinator.requestGrant(
      recoverableGrantRequest,
    );
    assert.equal(requested.challengeId, challengeId);
    await assert.rejects(
      crashingCoordinator.resolveChallenge(challengeId),
      (error) => error === crash,
    );
    assert.equal(
      readGrantRecord(grantStorePaths(grantRuntimeRoot), challengeId).state,
      'prepared',
    );
    assert.equal(
      showWorkItem(repositoryRoot, recoverable.accepted.id).stage,
      'active',
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          repositoryRoot,
          '.git/workflow-engine/work-registry/promotion-journals',
        ),
      ),
      [],
    );
    const recoverableReceipt = (
      fs
        .readdirSync(promotionReceiptRoot)
        .map((entry) =>
          JSON.parse(
            fs.readFileSync(path.join(promotionReceiptRoot, entry), 'utf8'),
          ),
        ) as Array<{
        workItemId: string;
        grantBinding: {
          schemaVersion: number;
          challengeId: string;
          operationId: string;
          approvalSubjectDigest: string;
          surveyDigest: string;
        } | null;
      }>
    ).find((entry) => entry.workItemId === recoverable.accepted.id);
    assert.equal(recoverableReceipt?.grantBinding?.schemaVersion, 1);
    assert.equal(recoverableReceipt?.grantBinding?.challengeId, challengeId);
    assert.equal(recoverableReceipt?.grantBinding?.operationId, operationId);
    assert.match(
      recoverableReceipt?.grantBinding?.approvalSubjectDigest ?? '',
      /^sha256:[0-9a-f]{64}$/,
    );
    assert.match(
      recoverableReceipt?.grantBinding?.surveyDigest ?? '',
      /^sha256:[0-9a-f]{64}$/,
    );
    const recoverableReceiptBytes = fs
      .readdirSync(promotionReceiptRoot)
      .map((entry) => ({
        entry,
        bytes: fs.readFileSync(path.join(promotionReceiptRoot, entry), 'utf8'),
      }))
      .find(({ bytes }) =>
        bytes.includes(`"workItemId":"${recoverable.accepted.id}"`),
      );
    assert.ok(recoverableReceiptBytes);
    const archivedRecoverableRoot =
      'openspec/changes/archive/2026-08-24-grant-promoted-recovered';
    fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes/archive'), {
      recursive: true,
    });
    fs.renameSync(
      recoverable.changeDirectory,
      path.join(repositoryRoot, archivedRecoverableRoot),
    );
    assert.deepEqual(
      reconcileArchivedWorkItems(
        repositoryRoot,
        'grant-promoted-recovered',
        archivedRecoverableRoot,
        '2026-08-24T05:09:30.000Z',
      ).closedItemIds,
      [recoverable.accepted.id],
    );
    assert.equal(
      showWorkItem(repositoryRoot, recoverable.accepted.id).stage,
      'closed',
    );
    const archivedRecoverableDirectory = path.join(
      repositoryRoot,
      archivedRecoverableRoot,
    );
    const archivedRecoverableOriginPath = path.join(
      archivedRecoverableDirectory,
      'origin.json',
    );
    const archivedRecoverableSurveyPath = path.join(
      archivedRecoverableDirectory,
      'survey.json',
    );
    const recoverableItemPath = path.join(
      repositoryRoot,
      recoverable.created.relativePath,
    );
    const laterStateBytes = {
      item: fs.readFileSync(recoverableItemPath, 'utf8'),
      origin: fs.readFileSync(archivedRecoverableOriginPath, 'utf8'),
      survey: fs.readFileSync(archivedRecoverableSurveyPath, 'utf8'),
    };
    const observationRegistry = createTransitionRegistry(
      workRegistryGrantTransitionDefinitions(repositoryRoot),
    );
    const observationDefinition = observationRegistry.resolve(
      'work-registry.promote.v1',
    );
    const actualCurrentPoststate = await observationDefinition.observeState(
      observationDefinition.validateParameters(
        recoverableGrantRequest.candidates[0]?.parameters,
      ),
    );

    const recoveryCoordinator = createCoordinator({
      challengeId,
      operationId,
    });
    const recoveredResult =
      await recoveryCoordinator.recoverChallenge(challengeId);
    assert.equal(recoveredResult.recovered, true);
    assert.equal(recoveredResult.outcome, 'completed');
    assert.equal(
      recoveredResult.poststateDigest,
      actualCurrentPoststate.digest,
    );
    const completedRecoveryRecord = readGrantRecord(
      grantStorePaths(grantRuntimeRoot),
      challengeId,
    );
    assert.equal(completedRecoveryRecord.state, 'completed');
    assert.equal(
      completedRecoveryRecord.poststateDigest,
      recoveredResult.poststateDigest,
    );
    assert.equal(
      fs.readFileSync(
        path.join(promotionReceiptRoot, recoverableReceiptBytes.entry),
        'utf8',
      ),
      recoverableReceiptBytes.bytes,
    );
    assert.deepEqual(
      {
        item: fs.readFileSync(recoverableItemPath, 'utf8'),
        origin: fs.readFileSync(archivedRecoverableOriginPath, 'utf8'),
        survey: fs.readFileSync(archivedRecoverableSurveyPath, 'utf8'),
      },
      laterStateBytes,
    );
    assert.equal(fs.existsSync(recoverable.changeDirectory), false);

    const terminal = prepareCandidate(
      'WORK-01K39R0V00000000000000000M',
      'grant-promoted-terminal-drift',
      '2026-08-24T05:10:00.000Z',
      '2026-08-24T05:10:10.000Z',
    );
    runGitForTest(repositoryRoot, ['add', '.']);
    runGitForTest(repositoryRoot, [
      'commit',
      '-m',
      'Prepare terminal survey drift',
    ]);
    const terminalSurvey = prepareWorkItemPromotionSurvey(
      repositoryRoot,
      terminal.accepted.id,
      'grant-promoted-terminal-drift',
      {
        schemaVersion: 1,
        symbols: [],
        emptyReason: 'No load-bearing symbols for the prepared Grant.',
      },
    );
    const terminalChallengeId = '11111111-1111-4111-8111-111111111111';
    const terminalOperationId = '22222222-2222-4222-8222-222222222222';
    const crashAfterPrepare = new Error(
      'simulated crash after durable Grant prepare',
    );
    const terminalCrashingCoordinator = createCoordinator({
      challengeId: terminalChallengeId,
      operationId: terminalOperationId,
      crashAfterPrepare,
    });
    await terminalCrashingCoordinator.requestGrant(
      createWorkRegistryPromotionGrantRequest({
        repositoryRoot,
        workItemId: terminal.accepted.id,
        changeId: 'grant-promoted-terminal-drift',
        expectedDigest: workItemDigest(terminal.accepted),
        proposedReason: 'Approve the exact survey before recovery drift.',
      }),
    );
    await assert.rejects(
      terminalCrashingCoordinator.resolveChallenge(terminalChallengeId),
      (error) => error === crashAfterPrepare,
    );
    assert.equal(
      readGrantRecord(grantStorePaths(grantRuntimeRoot), terminalChallengeId)
        .state,
      'prepared',
    );
    const terminalSurveyPath = path.join(
      repositoryRoot,
      terminalSurvey.relativePath,
    );
    const terminalSurveyValue = JSON.parse(
      fs.readFileSync(terminalSurveyPath, 'utf8'),
    ) as Record<string, unknown>;
    terminalSurveyValue.emptyReason =
      'Different current survey facts before prepared Grant recovery.';
    fs.writeFileSync(
      terminalSurveyPath,
      `${canonicalJson(terminalSurveyValue)}\n`,
    );
    const terminalItemBeforeRecovery = fs.readFileSync(
      path.join(repositoryRoot, terminal.created.relativePath),
      'utf8',
    );
    const terminalOriginPath = path.join(
      terminal.changeDirectory,
      'origin.json',
    );
    const terminalRecoveryCoordinator = createCoordinator({
      challengeId: terminalChallengeId,
      operationId: terminalOperationId,
    });
    const terminalResult =
      await terminalRecoveryCoordinator.recoverChallenge(terminalChallengeId);
    assert.equal(terminalResult.recovered, true);
    assert.equal(terminalResult.outcome, 'failed');
    assert.equal(
      readGrantRecord(grantStorePaths(grantRuntimeRoot), terminalChallengeId)
        .state,
      'failed',
    );
    assert.equal(
      fs.readFileSync(
        path.join(repositoryRoot, terminal.created.relativePath),
        'utf8',
      ),
      terminalItemBeforeRecovery,
    );
    assert.equal(fs.existsSync(terminalOriginPath), false);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('registry render is deterministic and validates blocking cycles', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-render-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    const source = captureGovernanceSource(repositoryRoot, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T04:33:00.000Z',
      contextRef: 'direct-human:thread/turn-46',
      text: 'Keep source provenance reachable from the backlog.\n',
      supersedes: null,
    }).source;
    const first = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'First item',
        summary: 'First summary',
        sourceRefs: [source.id],
      },
      {
        now: () => '2026-08-24T04:34:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000002',
      },
    ).item;
    const second = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'later',
        title: 'Second item',
        summary: 'Second summary',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:35:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000003',
      },
    ).item;
    const reviewedFirst = applyWorkItemReview(
      repositoryRoot,
      first.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(first),
        summary: first.interpretation.summary,
      },
      () => '2026-08-24T04:36:00.000Z',
    );
    const reviewedSecond = applyWorkItemReview(
      repositoryRoot,
      second.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(second),
        summary: second.interpretation.summary,
      },
      () => '2026-08-24T04:37:00.000Z',
    );
    applyWorkItemReview(
      repositoryRoot,
      reviewedSecond.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(reviewedSecond),
        lane: 'later',
        blockedBy: [reviewedFirst.id],
      },
      () => '2026-08-24T04:38:00.000Z',
    );
    assert.deepEqual(validateWorkRegistry(repositoryRoot), {
      itemCount: 2,
      sourceCount: 1,
    });
    const rendered = renderWorkRegistry(repositoryRoot);
    const firstBacklog = fs.readFileSync(rendered.backlogPath, 'utf8');
    assert.match(firstBacklog, /First item/);
    assert.match(firstBacklog, /Second item/);
    assert.match(
      firstBacklog,
      new RegExp(
        `\\[${source.id}\\]\\(\\.\\.\\/workflow\\/source-ledger\\/objects\\/sha256\\/${source.id.slice(4, 6)}\\/${source.id.slice(4)}\\.json\\)`,
      ),
    );
    assert.deepEqual(
      JSON.parse(fs.readFileSync(rendered.inventoryPath, 'utf8')),
      inspectWorkRegistry(repositoryRoot),
    );
    assert.deepEqual(renderWorkRegistry(repositoryRoot), rendered);
    assert.equal(fs.readFileSync(rendered.backlogPath, 'utf8'), firstBacklog);
    assert.deepEqual(validateWorkRegistryProjections(repositoryRoot), {
      projectionCount: 2,
    });
    fs.writeFileSync(rendered.backlogPath, `${firstBacklog}\n`);
    assert.throws(
      () => validateWorkRegistryProjections(repositoryRoot),
      hasCode('WORK_REGISTRY_PROJECTION_DRIFT'),
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('archive reconciliation rejects a one-sided Work Item link before mutation', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-archive-invalid-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    runGitForTest(repositoryRoot, ['init', '-b', 'main']);
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'now',
        title: 'Keep archive provenance bidirectional',
        summary: 'Reject a change origin that disagrees with its Work Item.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:43:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000006',
      },
    );
    fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes/demo-change'), {
      recursive: true,
    });
    const accepted = applyWorkItemReview(
      repositoryRoot,
      created.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created.item),
        summary: created.item.interpretation.summary,
      },
      () => '2026-08-24T04:43:30.000Z',
    );
    promoteWorkItem(
      repositoryRoot,
      accepted.id,
      'demo-change',
      () => '2026-08-24T04:44:00.000Z',
      workItemDigest(accepted),
    );
    const archiveRoot = 'openspec/changes/archive/2026-08-24-demo-change';
    fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes/archive'), {
      recursive: true,
    });
    fs.renameSync(
      path.join(repositoryRoot, 'openspec/changes/demo-change'),
      path.join(repositoryRoot, archiveRoot),
    );
    const itemPath = path.join(repositoryRoot, created.relativePath);
    const oneSided = {
      ...JSON.parse(fs.readFileSync(itemPath, 'utf8')),
      changeRefs: [],
    };
    fs.writeFileSync(itemPath, `${JSON.stringify(oneSided)}\n`);
    const before = fs.readFileSync(itemPath, 'utf8');

    assert.throws(
      () =>
        reconcileArchivedWorkItems(
          repositoryRoot,
          'demo-change',
          archiveRoot,
          '2026-08-24T04:45:00.000Z',
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORK_REGISTRY_INVALID',
    );
    assert.equal(fs.readFileSync(itemPath, 'utf8'), before);
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, 'docs/BACKLOG.md')),
      false,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Work Registry rejects retired migration and invalid provenance while preserving aliases', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-work-migration-'),
  );
  configureRepositoryConsumer(repositoryRoot);
  try {
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'work-item',
          ['migrate-issues', '--at', '2026-08-24T04:40:00.000Z'],
          repositoryRoot,
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'GOVERNANCE_INTAKE_INVALID',
    );

    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'bug',
        lane: 'next',
        title: 'Current Work Item',
        summary: 'Current provenance remains explicit.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:40:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000099',
        aliases: ['ISS-101'],
      },
    );
    assert.equal(showWorkItem(repositoryRoot, 'ISS-101').id, created.item.id);
    assert.equal(showWorkItem(repositoryRoot, 'ISS-101').lane, 'next');

    const itemPath = path.join(repositoryRoot, created.relativePath);
    const legacy = JSON.parse(fs.readFileSync(itemPath, 'utf8')) as {
      interpretation: { status: string };
    };
    legacy.interpretation.status = 'unsupported';
    fs.writeFileSync(itemPath, `${JSON.stringify(legacy)}\n`);
    assert.throws(
      () => validateWorkRegistry(repositoryRoot),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORK_REGISTRY_INVALID',
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('Work Registry CLI exposes reviewed read and render surfaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-work-cli-'));
  configureRepositoryConsumer(root);
  try {
    const consumerPath = path.join(root, 'workflow/repository-consumer.json');
    const consumer = JSON.parse(fs.readFileSync(consumerPath, 'utf8')) as {
      documents: { handoffPath: string };
    };
    consumer.documents.handoffPath = 'notebook/handoff.md';
    fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);
    const created = createWorkItem(
      root,
      {
        schemaVersion: 1,
        kind: 'chore',
        lane: null,
        title: 'CLI review surface',
        summary: 'Exercise production registry commands.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:41:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000004',
      },
    ).item;
    const reviewPath = path.join(root, 'review.json');
    fs.writeFileSync(
      reviewPath,
      `${JSON.stringify({
        action: 'accept',
        expectedDigest: workItemDigest(created),
        summary: 'Confirmed from the CLI review route.',
      })}\n`,
    );
    const reviewed = dispatchGovernanceIntakeCommand(
      'work-item',
      ['review', created.id, '--input', reviewPath],
      root,
      { now: () => '2026-08-24T04:42:00.000Z' },
    );
    assert.equal((reviewed.item as { stage: string }).stage, 'backlog');
    assert.equal(
      (
        dispatchGovernanceIntakeCommand('work-item', ['show', created.id], root)
          .item as { id: string }
      ).id,
      created.id,
    );
    assert.equal(
      (
        dispatchGovernanceIntakeCommand(
          'work-item',
          ['search', 'confirmed'],
          root,
        ).items as unknown[]
      ).length,
      1,
    );
    assert.equal(
      dispatchGovernanceIntakeCommand('work-item', ['trace', created.id], root)
        .action,
      'trace',
    );
    assert.equal(
      (
        dispatchGovernanceIntakeCommand('work-item', ['recommend'], root)
          .recommendations as unknown[]
      ).length,
      1,
    );
    assert.equal(
      (
        dispatchGovernanceIntakeCommand('work-item', ['inventory'], root)
          .inventory as { itemCount: number }
      ).itemCount,
      1,
    );
    assert.deepEqual(
      dispatchGovernanceIntakeCommand('work-item', ['render'], root),
      {
        action: 'render',
        backlogPath: 'docs/BACKLOG.md',
        inventoryPath: 'docs/work-registry/inventory.json',
        handoffPath: 'notebook/handoff.md',
        historyPaths: [],
      },
    );
    assert.equal(fs.existsSync(path.join(root, 'notebook/handoff.md')), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('promotion recomputes immutable consumers and rejects poisoned same-head survey facts before mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-survey-'));
  configureRepositoryConsumer(root);
  try {
    runGitForTest(root, ['init', '-b', 'main']);
    runGitForTest(root, ['config', 'user.name', 'Jigwright Test']);
    runGitForTest(root, ['config', 'user.email', 'jigwright@example.test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src/first.ts'),
      'export const sharedAuthority = true;\n',
    );
    fs.writeFileSync(
      path.join(root, 'src/second.ts'),
      'import { sharedAuthority } from "./first";\n',
    );
    runGitForTest(root, ['add', 'src']);
    runGitForTest(root, ['commit', '-m', 'Add survey facts']);

    const item = createWorkItem(
      root,
      {
        schemaVersion: 1,
        kind: 'research',
        lane: 'next',
        title: 'Survey current consumers',
        summary: 'Inspect current consumers before promotion.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T04:43:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000005',
      },
    ).item;
    const accepted = applyWorkItemReview(
      root,
      item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(item),
        summary: item.interpretation.summary,
      },
      () => '2026-08-24T04:43:30.000Z',
    );
    fs.mkdirSync(path.join(root, 'openspec/changes/survey-change'), {
      recursive: true,
    });
    assert.throws(
      () =>
        promoteWorkItem(
          root,
          accepted.id,
          'survey-change',
          () => '2026-08-24T04:44:00.000Z',
          workItemDigest(accepted),
          true,
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORK_REGISTRY_SURVEY_REQUIRED',
    );
    const survey = prepareWorkItemPromotionSurvey(
      root,
      accepted.id,
      'survey-change',
      {
        schemaVersion: 1,
        symbols: ['sharedAuthority'],
        emptyReason: null,
      },
    );
    assert.deepEqual(survey.survey.symbols, [
      {
        symbol: 'sharedAuthority',
        consumerPaths: ['src/first.ts', 'src/second.ts'],
      },
    ]);
    const surveyPath = path.join(root, survey.relativePath);
    const surveyBytes = fs.readFileSync(surveyPath, 'utf8');
    const poisonedSurvey = {
      ...(JSON.parse(surveyBytes) as Record<string, unknown>),
      symbols: [
        {
          symbol: 'sharedAuthority',
          consumerPaths: [],
        },
      ],
    };
    const poisonedSurveyBytes = `${canonicalJson(poisonedSurvey)}\n`;
    fs.writeFileSync(surveyPath, poisonedSurveyBytes);
    const itemPath = path.join(
      root,
      'docs/work-registry/items/2026',
      `${accepted.id}.yaml`,
    );
    const itemBytes = fs.readFileSync(itemPath, 'utf8');
    const originPath = path.join(
      root,
      'openspec/changes/survey-change/origin.json',
    );

    assert.throws(
      () =>
        promoteWorkItem(
          root,
          accepted.id,
          'survey-change',
          () => '2026-08-24T04:44:00.000Z',
          workItemDigest(accepted),
          true,
        ),
      hasCode('WORK_REGISTRY_SURVEY_REQUIRED'),
    );
    assert.equal(fs.readFileSync(surveyPath, 'utf8'), poisonedSurveyBytes);
    assert.equal(fs.readFileSync(itemPath, 'utf8'), itemBytes);
    assert.equal(fs.existsSync(originPath), false);

    fs.writeFileSync(surveyPath, surveyBytes);
    const promoted = promoteWorkItem(
      root,
      accepted.id,
      'survey-change',
      () => '2026-08-24T04:44:00.000Z',
      workItemDigest(accepted),
      true,
    );
    assert.equal(promoted.item.stage, 'active');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function snapshotPlainTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (target: string, relativePath: string): void => {
    const stats = fs.lstatSync(target);
    const identity = `${stats.dev}:${stats.ino}:${stats.uid}:${stats.gid}:${stats.mode & 0o777}:${stats.nlink}:${stats.size}`;
    if (stats.isSymbolicLink()) {
      entries.push(
        `link:${relativePath}:${identity}:${fs.readlinkSync(target)}`,
      );
      return;
    }
    if (stats.isFile()) {
      entries.push(
        `file:${relativePath}:${identity}:${fs.readFileSync(target).toString('base64')}`,
      );
      return;
    }
    if (!stats.isDirectory()) {
      entries.push(`other:${relativePath}`);
      return;
    }
    entries.push(`directory:${relativePath}:${identity}`);
    for (const name of fs.readdirSync(target).sort()) {
      visit(path.join(target, name), path.posix.join(relativePath, name));
    }
  };
  visit(root, '.');
  return entries;
}

function createGovernancePersistenceFixture(root: string) {
  const repositoryRoot = path.join(root, 'repository');
  const runtimeRoot = path.join(root, 'git-common', 'workflow-engine');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  configureRepositoryConsumer(repositoryRoot);
  const sourceInput = {
    semanticAuthor: 'maintainer' as const,
    capturedBy: 'jigwright',
    capturedAt: '2026-08-24T03:13:00.000Z',
    contextRef: 'direct-human:thread/turn-44',
    text: 'Preserve this exact Source across every admission path.\n',
    supersedes: null,
  };
  const source = captureGovernanceSource(repositoryRoot, sourceInput);
  const findingContext = {
    repositoryRoot,
    runtimeRoot,
    sessionId: 'session-governance-persistence',
    changeId: 'governance-persistence',
    branch: 'work/governance-persistence',
    head: 'a'.repeat(40),
    tree: 'b'.repeat(40),
  };
  const findingInput = {
    schemaVersion: 1 as const,
    text: 'The Source persistence boundary needs a durable observation.',
    sourceRefs: [source.source.id],
  };
  const findingNow = () => '2026-08-24T03:14:00.000Z';
  const finding = recordGovernanceFinding(
    findingContext,
    findingInput,
    findingNow,
  );
  const item = createWorkItem(
    repositoryRoot,
    {
      schemaVersion: 1,
      kind: 'chore',
      lane: 'later',
      title: 'Governance persistence boundary',
      summary: 'Keep Source and Finding evidence immutable.',
      sourceRefs: [source.source.id],
    },
    {
      now: () => '2026-08-24T03:15:00.000Z',
      createId: () => 'WORK-01K39R0V000000000000000001',
      aliases: ['ISS-321'],
    },
  );
  const rendered = renderWorkRegistry(repositoryRoot);
  runGitForTest(repositoryRoot, ['init', '-b', 'main']);
  runGitForTest(repositoryRoot, ['config', 'user.name', 'Jigwright Test']);
  runGitForTest(repositoryRoot, [
    'config',
    'user.email',
    'jigwright@example.test',
  ]);
  runGitForTest(repositoryRoot, ['add', '.']);
  runGitForTest(repositoryRoot, ['commit', '-m', 'Track governance state']);
  return {
    root,
    repositoryRoot,
    runtimeRoot,
    sourceInput,
    source,
    sourcePath: path.join(repositoryRoot, source.relativePath),
    sourceLedgerRoot: path.join(
      repositoryRoot,
      'workflow/source-ledger/objects/sha256',
    ),
    findingContext,
    findingInput,
    findingNow,
    finding,
    item,
    rendered,
  };
}

function snapshotGovernancePersistence(
  fixture: ReturnType<typeof createGovernancePersistenceFixture>,
  targets: readonly string[] = [],
) {
  return {
    head: runGitForTest(fixture.repositoryRoot, ['rev-parse', 'HEAD']),
    refs: runGitForTest(fixture.repositoryRoot, ['show-ref']),
    status: runGitForTest(fixture.repositoryRoot, [
      'status',
      '--porcelain=v1',
      '-z',
    ]),
    sources: snapshotPlainTree(fixture.sourceLedgerRoot),
    findings: snapshotPlainTree(path.join(fixture.runtimeRoot, 'findings')),
    items: snapshotPlainTree(
      path.join(fixture.repositoryRoot, 'docs/work-registry/items'),
    ),
    targets: targets.map((target) => snapshotPlainTree(target)),
    backlog: fs.readFileSync(fixture.rendered.backlogPath, 'utf8'),
    inventory: fs.readFileSync(fixture.rendered.inventoryPath, 'utf8'),
  };
}

function runGitForTest(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function configureRepositoryConsumer(repositoryRoot: string): void {
  const workflowRoot = path.join(repositoryRoot, 'workflow');
  fs.mkdirSync(workflowRoot, { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(workflowRoot, 'config.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      repositoryName: 'fixture',
      changeRoot: 'openspec/changes',
      runtimeDirectory: 'jigwright-runtime',
      protectedBranches: ['main'],
      branchTemplate: 'changes/{changeId}',
    })}\n`,
  );
  fs.writeFileSync(
    path.join(workflowRoot, 'repository-consumer.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      adapterId: 'configured-repository-v1',
      consumerId: 'fixture',
      planning: {
        providerId: 'openspec',
        packageSchemaNames: ['spec-driven'],
        requiredSchemaNames: ['spec-driven', 'fixture'],
        supportedSchemaNames: ['spec-driven', 'fixture'],
        managedSchemaNames: ['fixture'],
        currentSchemaName: 'fixture',
      },
      documents: {
        adapterId: 'filesystem-documents-v1',
        handoffPath: 'docs/CURRENT_AND_NEXT_STEPS.md',
      },
      workRegistry: {
        adapterId: 'filesystem-work-registry-v1',
        itemRoot: 'docs/work-registry/items',
        inventoryPath: 'docs/work-registry/inventory.json',
        backlogPath: 'docs/BACKLOG.md',
        historyRoot: 'docs/work-history',
        sourceRoot: 'workflow/source-ledger/objects/sha256',
        transitionPolicyPath: 'workflow/work-registry-policy.json',
        changeOriginRoot: 'openspec/changes',
      },
      databasePolicy: { adapterId: 'disabled-v1' },
    })}\n`,
  );
}

function workRegistryGrantPolicy() {
  return parseGrantPolicyV2(
    {
      schemaVersion: 2,
      defaultProfile: 'local-presence',
      profiles: {
        'local-presence': {
          requiredClaims: ['fresh-local-device-owner'],
        },
      },
      approvalModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          allowedClaims: ['fresh-local-device-owner'],
          configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
        },
      ],
    },
    { registry: codeOwnedApprovalModuleRegistry() },
  );
}

function hasCode(expectedCode: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expectedCode;
}
