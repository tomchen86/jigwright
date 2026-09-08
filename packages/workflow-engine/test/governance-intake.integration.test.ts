import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureGovernanceSource } from '../src/modules/governance-intake/governance-intake.ts';
import { dispatchGovernanceIntakeCommand } from '../src/entrypoints/cli/governance-intake-cli.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  applyWorkItemReview,
  createWorkItem,
  inspectWorkRegistry,
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
import {
  snapshotPlainTree,
  runGitForTest,
  configureRepositoryConsumer,
  hasCode,
} from './governance-intake-fixture.ts';

test('built-in Work Registry creates one stable item and promotes exact provenance', () => {
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
      text: 'Keep Work Item use not mandatory.\n',
      supersedes: null,
    }).source;
    const created = createWorkItem(
      repositoryRoot,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'next',
        title: 'Always-available Work Registry',
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
