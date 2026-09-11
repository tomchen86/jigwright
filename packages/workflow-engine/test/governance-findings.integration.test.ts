import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  dismissGovernanceFinding,
  listGovernanceFindings,
  recordGovernanceFinding,
  inspectGovernanceIntakeCounts,
} from '../src/composition-root/governance-findings-production.ts';
import { listGovernanceSources } from '../src/composition-root/governance-sources-production.ts';
import { dispatchGovernanceIntakeCommand } from '../src/entrypoints/cli/governance-intake-cli.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  showWorkItem,
  listWorkItems,
} from '../src/composition-root/work-registry-production.ts';
import {
  snapshotPlainTree,
  readFindingRecordForTest,
  snapshotFindingRefForTest,
  changeFindingRecordForTest,
  createGovernancePersistenceFixture,
  runGitForTest,
  configureRepositoryConsumer,
  hasCode,
} from './governance-intake-fixture.ts';

test('finding capture binds active session and Git facts outside task paths', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-finding-'));
  const repositoryRoot = path.join(root, 'repository');
  const runtimeRoot = path.join(root, 'git-common', 'workflow-engine');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  configureRepositoryConsumer(repositoryRoot);
  runGitForTest(repositoryRoot, [
    'init',
    '-b',
    'main',
    '--separate-git-dir',
    path.dirname(runtimeRoot),
  ]);
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
    assert.match(result.path, /^refs\/heads\/jigwright\/findings:findings\//);
    assert.deepEqual(
      JSON.parse(
        readFindingRecordForTest(repositoryRoot, result.path).toString('utf8'),
      ),
      result.finding,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Finding disposition is append-only and runtime-wide counts stay read-only', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-finding-disposition-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const second = recordGovernanceFinding(
      {
        ...fixture.findingContext,
        sessionId: 'session-second-task',
        branch: 'work/second-task',
      },
      {
        schemaVersion: 1,
        text: 'A second pending observation must be counted runtime-wide.',
        sourceRefs: [fixture.source.source.id],
      },
      () => '2026-08-24T03:16:00.000Z',
    );
    const firstRawBytes = readFindingRecordForTest(
      fixture.repositoryRoot,
      fixture.finding.path,
    );
    const secondRawBytes = readFindingRecordForTest(
      fixture.repositoryRoot,
      second.path,
    );
    const trackedBefore = {
      head: runGitForTest(fixture.repositoryRoot, ['rev-parse', 'HEAD']),
      refs: runGitForTest(fixture.repositoryRoot, ['show-ref'])
        .split('\n')
        .filter((line) => !line.endsWith(' refs/heads/jigwright/findings'))
        .join('\n'),
      status: runGitForTest(fixture.repositoryRoot, [
        'status',
        '--porcelain=v1',
        '-z',
      ]),
      items: snapshotPlainTree(
        path.join(fixture.repositoryRoot, 'docs/work-registry/items'),
      ),
      sources: snapshotPlainTree(fixture.sourceLedgerRoot),
    };
    const runtimeDependency = {
      now: () => '2026-08-24T03:17:00.000Z',
      resolveRuntimeRoot: () => fixture.runtimeRoot,
    };

    assert.deepEqual(
      inspectGovernanceIntakeCounts(
        fixture.repositoryRoot,
        fixture.runtimeRoot,
      ),
      { schemaVersion: 1, inbox: 1, pendingFindings: 2, backlog: 0 },
    );
    const pending = dispatchGovernanceIntakeCommand(
      'finding',
      ['list'],
      fixture.repositoryRoot,
      runtimeDependency,
    ) as { action: string; findings: Array<{ id: string }> };
    assert.equal(pending.action, 'list');
    assert.deepEqual(
      pending.findings.map(({ id }) => id),
      [fixture.finding.finding.id, second.finding.id].sort(),
    );
    const findingsBeforeBlankReason = snapshotFindingRefForTest(
      fixture.repositoryRoot,
    );
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'finding',
          ['dismiss', second.finding.id, '--reason', '   '],
          fixture.repositoryRoot,
          runtimeDependency,
        ),
      hasCode('GOVERNANCE_INTAKE_INVALID'),
    );
    assert.deepEqual(
      snapshotFindingRefForTest(fixture.repositoryRoot),
      findingsBeforeBlankReason,
    );

    const dismissed = dispatchGovernanceIntakeCommand(
      'finding',
      [
        'dismiss',
        fixture.finding.finding.id,
        '--reason',
        'Superseded by direct maintainer evidence.',
      ],
      fixture.repositoryRoot,
      runtimeDependency,
    ) as {
      action: string;
      created: boolean;
      finding: {
        id: string;
        disposition: string;
        reason: string | null;
        target: unknown;
        disposedAt: string | null;
      };
    };
    assert.equal(dismissed.action, 'dismiss');
    assert.equal(dismissed.created, true);
    assert.deepEqual(
      {
        id: dismissed.finding.id,
        disposition: dismissed.finding.disposition,
        reason: dismissed.finding.reason,
        target: dismissed.finding.target,
        disposedAt: dismissed.finding.disposedAt,
      },
      {
        id: fixture.finding.finding.id,
        disposition: 'dismissed',
        reason: 'Superseded by direct maintainer evidence.',
        target: null,
        disposedAt: '2026-08-24T03:17:00.000Z',
      },
    );
    assert.equal(
      dismissGovernanceFinding(
        fixture.runtimeRoot,
        fixture.finding.finding.id,
        'Superseded by direct maintainer evidence.',
        () => '2026-08-24T03:18:00.000Z',
      ).created,
      false,
    );

    assert.deepEqual(
      inspectGovernanceIntakeCounts(
        fixture.repositoryRoot,
        fixture.runtimeRoot,
      ),
      { schemaVersion: 1, inbox: 1, pendingFindings: 1, backlog: 0 },
    );
    assert.deepEqual(
      (
        dispatchGovernanceIntakeCommand(
          'finding',
          ['list'],
          fixture.repositoryRoot,
          runtimeDependency,
        ) as { findings: Array<{ id: string }> }
      ).findings.map(({ id }) => id),
      [second.finding.id],
    );
    const all = dispatchGovernanceIntakeCommand(
      'finding',
      ['list', '--all'],
      fixture.repositoryRoot,
      runtimeDependency,
    ) as {
      findings: Array<{ id: string; disposition: string }>;
    };
    assert.deepEqual(
      all.findings.map(({ id, disposition }) => ({ id, disposition })),
      [
        { id: fixture.finding.finding.id, disposition: 'dismissed' },
        { id: second.finding.id, disposition: 'pending' },
      ].sort((left, right) => left.id.localeCompare(right.id)),
    );

    const dispositionPath = path.join(
      path.dirname(fixture.finding.path),
      `${fixture.finding.finding.id}.disposition.json`,
    );
    const dispositionBytes = readFindingRecordForTest(
      fixture.repositoryRoot,
      dispositionPath,
    );
    assert.throws(
      () =>
        dismissGovernanceFinding(
          fixture.runtimeRoot,
          fixture.finding.finding.id,
          'A conflicting terminal reason.',
          () => '2026-08-24T03:19:00.000Z',
        ),
      hasCode('GOVERNANCE_FINDING_DISPOSITION_COLLISION'),
    );
    assert.deepEqual(
      readFindingRecordForTest(fixture.repositoryRoot, fixture.finding.path),
      firstRawBytes,
    );
    assert.deepEqual(
      readFindingRecordForTest(fixture.repositoryRoot, second.path),
      secondRawBytes,
    );
    assert.deepEqual(
      readFindingRecordForTest(fixture.repositoryRoot, dispositionPath),
      dispositionBytes,
    );
    assert.deepEqual(
      {
        head: runGitForTest(fixture.repositoryRoot, ['rev-parse', 'HEAD']),
        refs: runGitForTest(fixture.repositoryRoot, ['show-ref'])
          .split('\n')
          .filter((line) => !line.endsWith(' refs/heads/jigwright/findings'))
          .join('\n'),
        status: runGitForTest(fixture.repositoryRoot, [
          'status',
          '--porcelain=v1',
          '-z',
        ]),
        items: snapshotPlainTree(
          path.join(fixture.repositoryRoot, 'docs/work-registry/items'),
        ),
        sources: snapshotPlainTree(fixture.sourceLedgerRoot),
      },
      trackedBefore,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('finding list and dismiss resolve the repository runtime without a session argument', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-finding-runtime-resolution-'),
  );
  try {
    configureRepositoryConsumer(repositoryRoot);
    runGitForTest(repositoryRoot, ['init', '-b', 'main']);
    runGitForTest(repositoryRoot, ['config', 'user.name', 'Jigwright Test']);
    runGitForTest(repositoryRoot, [
      'config',
      'user.email',
      'jigwright@example.test',
    ]);
    fs.writeFileSync(path.join(repositoryRoot, 'README.md'), 'fixture\n');
    runGitForTest(repositoryRoot, ['add', '.']);
    runGitForTest(repositoryRoot, ['commit', '-m', 'Initialize fixture']);
    const runtimeRoot = path.join(repositoryRoot, '.git', 'jigwright-runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
    const recorded = recordGovernanceFinding(
      {
        repositoryRoot,
        runtimeRoot,
        sessionId: 'session-runtime-resolution',
        changeId: 'runtime-resolution',
        branch: 'main',
        head: runGitForTest(repositoryRoot, ['rev-parse', 'HEAD']),
        tree: runGitForTest(repositoryRoot, ['rev-parse', 'HEAD^{tree}']),
      },
      {
        schemaVersion: 1,
        text: 'Resolve this Finding from the Git-common runtime.',
        sourceRefs: [],
      },
      () => '2026-08-24T03:16:00.000Z',
    );

    const listed = dispatchGovernanceIntakeCommand(
      'finding',
      ['list'],
      repositoryRoot,
    ) as { findings: Array<{ id: string }> };
    assert.deepEqual(
      listed.findings.map(({ id }) => id),
      [recorded.finding.id],
    );
    const dismissed = dispatchGovernanceIntakeCommand(
      'finding',
      [
        'dismiss',
        recorded.finding.id,
        '--reason',
        'Resolved during the current task.',
      ],
      repositoryRoot,
      { now: () => '2026-08-24T03:17:00.000Z' },
    ) as { finding: { disposition: string } };
    assert.equal(dismissed.finding.disposition, 'dismissed');
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('D-019 finding convert resumes one deterministic item before publishing its receipt', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-finding-convert-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const rawFinding = readFindingRecordForTest(
      fixture.repositoryRoot,
      fixture.finding.path,
    );
    const itemCountBefore = listWorkItems(fixture.repositoryRoot).length;
    const sourceCountBefore = listGovernanceSources(
      fixture.repositoryRoot,
    ).length;
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'finding',
          ['convert', fixture.finding.finding.id],
          fixture.repositoryRoot,
          {
            now: () => '2026-08-24T03:24:00.000Z',
            resolveRuntimeRoot: () => fixture.runtimeRoot,
            afterFindingConversionWorkItemPersisted: () => {
              throw new Error('simulated crash after deterministic item');
            },
          },
        ),
      /simulated crash after deterministic item/u,
    );
    const expectedWorkItemId = `WORK-${fixture.finding.finding.id
      .slice('FND-'.length, 'FND-'.length + 26)
      .toUpperCase()}`;
    const itemAfterCrash = showWorkItem(
      fixture.repositoryRoot,
      expectedWorkItemId,
    );
    const itemPath = path.join(
      fixture.repositoryRoot,
      'docs/work-registry/items/2026',
      `${expectedWorkItemId}.yaml`,
    );
    const itemBytesAfterCrash = fs.readFileSync(itemPath);
    assert.equal(
      listWorkItems(fixture.repositoryRoot).length,
      itemCountBefore + 1,
    );
    assert.equal(
      listGovernanceSources(fixture.repositoryRoot).length,
      sourceCountBefore,
    );
    assert.equal(itemAfterCrash.stage, 'inbox');
    assert.deepEqual(
      (
        dispatchGovernanceIntakeCommand(
          'finding',
          ['list'],
          fixture.repositoryRoot,
          { resolveRuntimeRoot: () => fixture.runtimeRoot },
        ) as { findings: Array<{ id: string }> }
      ).findings.map(({ id }) => id),
      [fixture.finding.finding.id],
    );

    const divergent = JSON.parse(itemBytesAfterCrash.toString('utf8')) as {
      title: string;
    };
    divergent.title = 'A divergent deterministic conversion target';
    fs.writeFileSync(itemPath, `${canonicalJson(divergent)}\n`);
    const divergentBytes = fs.readFileSync(itemPath);
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'finding',
          ['convert', fixture.finding.finding.id],
          fixture.repositoryRoot,
          {
            now: () => '2026-08-24T03:24:30.000Z',
            resolveRuntimeRoot: () => fixture.runtimeRoot,
          },
        ),
      hasCode('WORK_REGISTRY_INVALID'),
    );
    assert.deepEqual(fs.readFileSync(itemPath), divergentBytes);
    assert.deepEqual(
      readFindingRecordForTest(fixture.repositoryRoot, fixture.finding.path),
      rawFinding,
    );
    assert.deepEqual(
      (
        dispatchGovernanceIntakeCommand(
          'finding',
          ['list'],
          fixture.repositoryRoot,
          { resolveRuntimeRoot: () => fixture.runtimeRoot },
        ) as { findings: Array<{ id: string }> }
      ).findings.map(({ id }) => id),
      [fixture.finding.finding.id],
    );
    fs.writeFileSync(itemPath, itemBytesAfterCrash);

    const recovered = dispatchGovernanceIntakeCommand(
      'finding',
      ['convert', fixture.finding.finding.id],
      fixture.repositoryRoot,
      {
        now: () => '2026-08-24T03:25:00.000Z',
        resolveRuntimeRoot: () => fixture.runtimeRoot,
      },
    ) as {
      action: string;
      sourceId: string;
      workItemId: string;
      finding: { disposition: string; target: unknown };
      created: boolean;
    };
    assert.equal(recovered.action, 'convert');
    assert.equal(recovered.workItemId, expectedWorkItemId);
    assert.equal(recovered.created, true);
    assert.deepEqual(recovered.finding.target, {
      kind: 'work-item',
      id: expectedWorkItemId,
    });
    assert.equal(recovered.finding.disposition, 'converted');
    assert.equal(
      listWorkItems(fixture.repositoryRoot).length,
      itemCountBefore + 1,
    );
    assert.equal(
      listGovernanceSources(fixture.repositoryRoot).length,
      sourceCountBefore,
    );
    assert.deepEqual(fs.readFileSync(itemPath), itemBytesAfterCrash);
    assert.deepEqual(
      readFindingRecordForTest(fixture.repositoryRoot, fixture.finding.path),
      rawFinding,
    );

    const replay = dispatchGovernanceIntakeCommand(
      'finding',
      ['convert', fixture.finding.finding.id],
      fixture.repositoryRoot,
      {
        now: () => '2026-08-24T03:26:00.000Z',
        resolveRuntimeRoot: () => fixture.runtimeRoot,
      },
    ) as { created: boolean; workItemId: string };
    assert.equal(replay.created, false);
    assert.equal(replay.workItemId, expectedWorkItemId);
    assert.equal(
      listWorkItems(fixture.repositoryRoot).length,
      itemCountBefore + 1,
    );

    let immediateStart:
      | {
          changeId: string;
          intent: Record<string, unknown>;
          source: { sourceId: string; exactText: string } | null;
        }
      | undefined;
    const sourceCountBeforeNow = listGovernanceSources(
      fixture.repositoryRoot,
    ).length;
    const immediate = dispatchGovernanceIntakeCommand(
      'finding',
      ['convert', fixture.finding.finding.id, '--now'],
      fixture.repositoryRoot,
      {
        now: () => '2026-08-24T03:27:00.000Z',
        resolveRuntimeRoot: () => fixture.runtimeRoot,
        startImmediateChange(_cwd, changeId, intent, source) {
          immediateStart = { changeId, intent, source };
          return {
            state: 'awaiting-main-terms',
            investigation: { investigationId: 'investigation-finding-now' },
          };
        },
      },
    ) as {
      originalText: string;
      sourceId: string | null;
      immediateChange: {
        sourceId: string | null;
        changeId: string;
        propose: { state: string };
      };
      nextSteps: string[];
    };
    assert.equal(immediate.originalText, fixture.finding.finding.text);
    assert.equal(immediate.sourceId, null);
    assert.equal(immediate.immediateChange.sourceId, null);
    // An observation starts its change without a Source binding; only the
    // Sources the Finding already cited travel into the intent.
    assert.equal(immediateStart?.source, null);
    assert.deepEqual(
      immediateStart?.intent.sourceRefs,
      fixture.finding.finding.sourceRefs,
    );
    assert.equal(immediateStart?.intent.summary, fixture.finding.finding.text);
    assert.deepEqual(immediate.nextSteps, [
      'pnpm workflow status investigation-finding-now --json',
    ]);
    assert.equal(
      listGovernanceSources(fixture.repositoryRoot).length,
      sourceCountBeforeNow,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('D-019 finding link records only one exact existing change target', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-finding-link-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const linkedChangeRoot = path.join(
      fixture.repositoryRoot,
      'openspec/changes/linked-change',
    );
    fs.mkdirSync(linkedChangeRoot, { recursive: true });
    fs.writeFileSync(
      path.join(linkedChangeRoot, 'origin.json'),
      `${canonicalJson({ schemaVersion: 1, sourceRefs: [], workItemRefs: [] })}\n`,
    );
    fs.writeFileSync(path.join(linkedChangeRoot, 'tasks.md'), '- [ ] T1\n');
    runGitForTest(fixture.repositoryRoot, ['add', '.']);
    runGitForTest(fixture.repositoryRoot, [
      'commit',
      '-m',
      'Track independent change target',
    ]);
    const missing = recordGovernanceFinding(
      {
        ...fixture.findingContext,
        sessionId: 'session-missing-link-target',
      },
      {
        schemaVersion: 1,
        text: 'Do not link this Finding to a missing change.',
        sourceRefs: [fixture.source.source.id],
      },
      () => '2026-08-24T03:16:00.000Z',
    );
    const symlinked = recordGovernanceFinding(
      {
        ...fixture.findingContext,
        sessionId: 'session-symlink-link-target',
      },
      {
        schemaVersion: 1,
        text: 'Do not follow a change-directory symbolic link.',
        sourceRefs: [fixture.source.source.id],
      },
      () => '2026-08-24T03:17:00.000Z',
    );
    const externalChange = path.join(root, 'external-change');
    fs.mkdirSync(externalChange);
    fs.symlinkSync(
      externalChange,
      path.join(fixture.repositoryRoot, 'openspec/changes/symlinked-change'),
    );
    const repositoryBefore = {
      head: runGitForTest(fixture.repositoryRoot, ['rev-parse', 'HEAD']),
      refs: runGitForTest(fixture.repositoryRoot, ['show-ref'])
        .split('\n')
        .filter((line) => !line.endsWith(' refs/heads/jigwright/findings'))
        .join('\n'),
      status: runGitForTest(fixture.repositoryRoot, [
        'status',
        '--porcelain=v1',
        '-z',
      ]),
      change: snapshotPlainTree(linkedChangeRoot),
      sources: snapshotPlainTree(fixture.sourceLedgerRoot),
      items: snapshotPlainTree(
        path.join(fixture.repositoryRoot, 'docs/work-registry/items'),
      ),
    };
    const rawFinding = readFindingRecordForTest(
      fixture.repositoryRoot,
      fixture.finding.path,
    );
    const dependencies = {
      now: () => '2026-08-24T03:18:00.000Z',
      resolveRuntimeRoot: () => fixture.runtimeRoot,
    };

    const linked = dispatchGovernanceIntakeCommand(
      'finding',
      ['link', fixture.finding.finding.id, '--change', 'linked-change'],
      fixture.repositoryRoot,
      dependencies,
    ) as {
      action: string;
      created: boolean;
      finding: { disposition: string; target: unknown; reason: string | null };
    };
    assert.equal(linked.action, 'link');
    assert.equal(linked.created, true);
    assert.deepEqual(linked.finding.target, {
      kind: 'change',
      id: 'linked-change',
    });
    assert.equal(linked.finding.disposition, 'linked');
    assert.equal(
      linked.finding.reason,
      'Linked to one existing change without widening its task scope.',
    );
    assert.deepEqual(
      readFindingRecordForTest(fixture.repositoryRoot, fixture.finding.path),
      rawFinding,
    );
    assert.deepEqual(
      {
        head: runGitForTest(fixture.repositoryRoot, ['rev-parse', 'HEAD']),
        refs: runGitForTest(fixture.repositoryRoot, ['show-ref'])
          .split('\n')
          .filter((line) => !line.endsWith(' refs/heads/jigwright/findings'))
          .join('\n'),
        status: runGitForTest(fixture.repositoryRoot, [
          'status',
          '--porcelain=v1',
          '-z',
        ]),
        change: snapshotPlainTree(linkedChangeRoot),
        sources: snapshotPlainTree(fixture.sourceLedgerRoot),
        items: snapshotPlainTree(
          path.join(fixture.repositoryRoot, 'docs/work-registry/items'),
        ),
      },
      repositoryBefore,
    );
    assert.equal(
      (
        dispatchGovernanceIntakeCommand(
          'finding',
          ['link', fixture.finding.finding.id, '--change', 'linked-change'],
          fixture.repositoryRoot,
          dependencies,
        ) as { created: boolean }
      ).created,
      false,
    );
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'finding',
          [
            'dismiss',
            fixture.finding.finding.id,
            '--reason',
            'Conflicting terminal disposition.',
          ],
          fixture.repositoryRoot,
          dependencies,
        ),
      hasCode('GOVERNANCE_FINDING_DISPOSITION_COLLISION'),
    );

    for (const scenario of [
      { findingId: missing.finding.id, changeId: 'missing-change' },
      { findingId: symlinked.finding.id, changeId: 'symlinked-change' },
    ]) {
      const findingsBefore = snapshotFindingRefForTest(fixture.repositoryRoot);
      assert.throws(
        () =>
          dispatchGovernanceIntakeCommand(
            'finding',
            ['link', scenario.findingId, '--change', scenario.changeId],
            fixture.repositoryRoot,
            dependencies,
          ),
        hasCode('GOVERNANCE_INTAKE_INVALID'),
      );
      assert.deepEqual(
        snapshotFindingRefForTest(fixture.repositoryRoot),
        findingsBefore,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Finding readers report invalid Git records and receipts without repair', () => {
  const cases = [
    {
      name: 'unexpected entry',
      code: 'GOVERNANCE_FINDING_STORE_UNSAFE',
      path: 'findings/session/README.md',
      content: 'poison\n',
    },
    {
      name: 'symbolic-link record',
      code: 'GOVERNANCE_FINDING_STORE_UNSAFE',
      mode: '120000',
      content: '/tmp/another-record',
    },
    {
      name: 'executable record',
      code: 'GOVERNANCE_FINDING_STORE_UNSAFE',
      mode: '100755',
    },
    {
      name: 'Finding identity drift',
      code: 'GOVERNANCE_INTAKE_INVALID',
      content: '{}\n',
    },
    {
      name: 'noncanonical Finding bytes',
      code: 'GOVERNANCE_INTAKE_INVALID',
      pretty: true,
    },
    {
      name: 'receipt payload drift',
      code: 'GOVERNANCE_INTAKE_INVALID',
      receipt: true,
      content: '{}\n',
    },
    {
      name: 'receipt session drift',
      code: 'GOVERNANCE_INTAKE_INVALID',
      receipt: true,
      move: true,
    },
  ];
  for (const scenario of cases) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jigwright-finding-reader-'),
    );
    try {
      const fixture = createGovernancePersistenceFixture(root);
      const record = scenario.receipt
        ? dismissGovernanceFinding(
            fixture.runtimeRoot,
            fixture.finding.finding.id,
            'Resolved.',
            () => '2026-08-24T03:17:00.000Z',
          )
        : fixture.finding;
      const bytes = readFindingRecordForTest(
        fixture.repositoryRoot,
        record.path,
      ).toString('utf8');
      const location =
        scenario.path ??
        (scenario.move
          ? record.path.replace(
              '/session-governance-persistence/',
              '/session-other/',
            )
          : record.path);
      changeFindingRecordForTest(
        fixture.repositoryRoot,
        location,
        scenario.content ??
          (scenario.pretty
            ? JSON.stringify(JSON.parse(bytes), null, 2)
            : bytes),
        scenario.mode,
      );
      if (scenario.move)
        changeFindingRecordForTest(fixture.repositoryRoot, record.path, null);
      const before = snapshotFindingRefForTest(fixture.repositoryRoot);
      assert.throws(
        () => listGovernanceFindings(fixture.runtimeRoot),
        hasCode(scenario.code),
        scenario.name,
      );
      assert.throws(
        () =>
          inspectGovernanceIntakeCounts(
            fixture.repositoryRoot,
            fixture.runtimeRoot,
          ),
        hasCode(scenario.code),
        scenario.name,
      );
      assert.equal(
        snapshotFindingRefForTest(fixture.repositoryRoot),
        before,
        scenario.name,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('source and finding CLI routes parse exact input envelopes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-intake-cli-'));
  const repositoryRoot = path.join(root, 'repository');
  const runtimeRoot = path.join(root, 'git-common', 'runtime');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  configureRepositoryConsumer(repositoryRoot);
  runGitForTest(repositoryRoot, [
    'init',
    '-b',
    'main',
    '--separate-git-dir',
    path.dirname(runtimeRoot),
  ]);
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
        summary: 'Keep the always-available registry path small.',
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

    // An observation made between tasks still has somewhere to go: without a
    // session the note is repository-scoped rather than refused.
    const unsessioned = dispatchGovernanceIntakeCommand(
      'finding',
      ['add', '--input', findingInput],
      repositoryRoot,
      {
        now: () => '2026-08-24T03:16:30.000Z',
        resolveRepositoryScope: () => ({
          repositoryRoot,
          runtimeRoot,
          sessionId: 'repository',
          changeId: 'repository',
          branch: 'work/current-change',
          head: 'a'.repeat(40),
          tree: 'b'.repeat(40),
        }),
      },
    );
    assert.equal(unsessioned.action, 'add');
    assert.equal(unsessioned.sessionId, 'repository');
    const listed = dispatchGovernanceIntakeCommand(
      'finding',
      ['list'],
      repositoryRoot,
      { resolveRuntimeRoot: () => runtimeRoot },
    ) as { findings: Array<{ id: string }> };
    assert.ok(
      listed.findings.some(({ id }) => id === unsessioned.findingId),
      'a repository-scoped note must be listed like any other Finding',
    );

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

test('later inside an active task stages a Finding and convert flushes it to the inbox without a Source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-later-task-'));
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const itemsDirectory = path.join(
      fixture.repositoryRoot,
      'docs/work-registry/items/2026',
    );
    const itemsBefore = fs.readdirSync(itemsDirectory).length;
    const sourcesBefore = listGovernanceSources(fixture.repositoryRoot).length;
    const text = 'The retry path dead-ends after two identical failures.';
    const staged = dispatchGovernanceIntakeCommand(
      'later',
      [text, '--kind', 'bug'],
      fixture.repositoryRoot,
      {
        now: () => '2026-09-05T01:20:00.000Z',
        resolveTaskScope: () => fixture.findingContext,
      },
    ) as {
      staged: string;
      findingId: string;
      sessionId: string;
      kind: string;
      nextSteps: string[];
    };
    assert.equal(staged.staged, 'finding');
    assert.match(staged.findingId, /^FND-[0-9a-f]{64}$/u);
    assert.equal(staged.sessionId, fixture.findingContext.sessionId);
    assert.equal(staged.kind, 'bug');
    assert.deepEqual(staged.nextSteps, [
      `pnpm workflow finding convert ${staged.findingId} --kind bug --json`,
    ]);
    assert.equal(fs.readdirSync(itemsDirectory).length, itemsBefore);
    assert.equal(
      listGovernanceSources(fixture.repositoryRoot).length,
      sourcesBefore,
    );
    const pending = listGovernanceFindings(fixture.runtimeRoot).find(
      ({ id }) => id === staged.findingId,
    );
    assert.equal(pending?.text, text);
    assert.deepEqual(pending?.sourceRefs, []);
    const converted = dispatchGovernanceIntakeCommand(
      'finding',
      ['convert', staged.findingId, '--kind', 'bug'],
      fixture.repositoryRoot,
      {
        now: () => '2026-09-05T01:21:00.000Z',
        resolveRuntimeRoot: () => fixture.runtimeRoot,
      },
    ) as { sourceId: string | null; kind: string; workItemId: string };
    assert.equal(converted.sourceId, null);
    assert.equal(converted.kind, 'bug');
    const item = showWorkItem(fixture.repositoryRoot, converted.workItemId);
    assert.deepEqual(
      {
        kind: item.kind,
        stage: item.stage,
        summary: item.interpretation.summary,
        sourceRefs: item.sourceRefs,
      },
      { kind: 'bug', stage: 'inbox', summary: text, sourceRefs: [] },
    );
    assert.equal(
      listGovernanceSources(fixture.repositoryRoot).length,
      sourcesBefore,
      'converting an observation must not mint a Source',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
