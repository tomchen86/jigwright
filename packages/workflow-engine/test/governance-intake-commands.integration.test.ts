import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureGovernanceSource,
  listGovernanceSources,
  readGovernanceSource,
} from '../src/composition-root/governance-sources-production.ts';
import { dispatchGovernanceIntakeCommand } from '../src/entrypoints/cli/governance-intake-cli.ts';
import { runCli } from '../src/entrypoints/cli/workflow-cli.ts';
import {
  applyWorkItemReview,
  createWorkItem,
  showWorkItem,
  listWorkItems,
  workItemDigest,
} from '../src/composition-root/work-registry-production.ts';
import {
  snapshotPlainTree,
  createGovernancePersistenceFixture,
  runGitForTest,
  configureRepositoryConsumer,
  hasCode,
} from './governance-intake-fixture.ts';

test('D-019 later and attach preserve original wording only in Sources and converge exactly', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-intent-facade-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const headBefore = runGitForTest(fixture.repositoryRoot, [
      'rev-parse',
      'HEAD',
    ]);
    const refsBefore = runGitForTest(fixture.repositoryRoot, ['show-ref']);
    const original = 'Remember the exact one-command intake wording.';
    const later = dispatchGovernanceIntakeCommand(
      'later',
      [original],
      fixture.repositoryRoot,
      { now: () => '2026-08-24T03:20:00.000Z' },
    ) as {
      action: string;
      originalText: string;
      sourceId: string;
      workItemId: string;
      deduplicated: boolean;
      nextSteps: string[];
    };
    assert.equal(later.action, 'later');
    assert.equal(later.originalText, original);
    assert.equal(later.deduplicated, false);
    assert.match(later.sourceId, /^SRC-[0-9a-f]{64}$/u);
    assert.match(later.workItemId, /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/u);
    assert.deepEqual(later.nextSteps, [
      `pnpm workflow work-item show ${later.workItemId} --json`,
    ]);

    const item = showWorkItem(fixture.repositoryRoot, later.workItemId);
    assert.deepEqual(
      {
        kind: item.kind,
        stage: item.stage,
        lane: item.lane,
        title: item.title,
        interpretation: item.interpretation,
        sourceRefs: item.sourceRefs,
      },
      {
        kind: 'improvement',
        stage: 'inbox',
        lane: null,
        title: `Review captured Source ${later.sourceId}`,
        interpretation: {
          summary: 'Interpret and disposition the linked Source.',
          status: 'agent-derived',
        },
        sourceRefs: [later.sourceId],
      },
    );
    const itemPath = path.join(
      fixture.repositoryRoot,
      'docs/work-registry/items/2026',
      `${later.workItemId}.yaml`,
    );
    assert.doesNotMatch(
      fs.readFileSync(itemPath, 'utf8'),
      new RegExp(original),
    );
    assert.equal(
      readGovernanceSource(fixture.repositoryRoot, later.sourceId).text,
      original,
    );

    const itemTreeBeforeDedupe = snapshotPlainTree(
      path.join(fixture.repositoryRoot, 'docs/work-registry/items'),
    );
    const sourceTreeBeforeDedupe = snapshotPlainTree(fixture.sourceLedgerRoot);
    const duplicate = dispatchGovernanceIntakeCommand(
      'later',
      [original],
      fixture.repositoryRoot,
      { now: () => '2026-08-24T03:21:00.000Z' },
    ) as {
      deduplicated: boolean;
      matches: string[];
      nextSteps: string[];
    };
    assert.equal(duplicate.deduplicated, true);
    assert.deepEqual(duplicate.matches, [later.workItemId]);
    assert.deepEqual(duplicate.nextSteps, [
      `pnpm workflow attach ${later.workItemId} <original-text> --json`,
    ]);
    assert.deepEqual(
      snapshotPlainTree(
        path.join(fixture.repositoryRoot, 'docs/work-registry/items'),
      ),
      itemTreeBeforeDedupe,
    );
    assert.deepEqual(
      snapshotPlainTree(fixture.sourceLedgerRoot),
      sourceTreeBeforeDedupe,
    );

    const supplement = 'Also retain the corrected acceptance boundary.';
    const beforeAttach = showWorkItem(fixture.repositoryRoot, later.workItemId);
    const attached = dispatchGovernanceIntakeCommand(
      'attach',
      [later.workItemId, supplement],
      fixture.repositoryRoot,
      { now: () => '2026-08-24T03:22:00.000Z' },
    ) as {
      action: string;
      originalText: string;
      sourceId: string;
      workItemId: string;
      updated: boolean;
    };
    assert.equal(attached.action, 'attach');
    assert.equal(attached.originalText, supplement);
    assert.equal(attached.workItemId, later.workItemId);
    assert.equal(attached.updated, true);
    const afterAttach = showWorkItem(fixture.repositoryRoot, later.workItemId);
    assert.deepEqual(
      {
        kind: afterAttach.kind,
        stage: afterAttach.stage,
        lane: afterAttach.lane,
        title: afterAttach.title,
      },
      {
        kind: beforeAttach.kind,
        stage: beforeAttach.stage,
        lane: beforeAttach.lane,
        title: beforeAttach.title,
      },
    );
    assert.deepEqual(
      afterAttach.sourceRefs,
      [...afterAttach.sourceRefs].sort(),
    );
    assert.deepEqual(
      afterAttach.sourceRefs,
      [later.sourceId, attached.sourceId].sort(),
    );
    assert.deepEqual(afterAttach.interpretation, {
      summary: `Interpret and disposition linked Sources: ${afterAttach.sourceRefs.join(', ')}.`,
      status: 'agent-derived',
    });
    assert.doesNotMatch(
      fs.readFileSync(itemPath, 'utf8'),
      new RegExp(supplement),
    );

    const afterFirstAttach = fs.readFileSync(itemPath);
    const attachedAgain = dispatchGovernanceIntakeCommand(
      'attach',
      [later.workItemId, supplement],
      fixture.repositoryRoot,
      { now: () => '2026-08-24T03:23:00.000Z' },
    ) as { sourceId: string; updated: boolean };
    assert.equal(attachedAgain.sourceId, attached.sourceId);
    assert.equal(attachedAgain.updated, false);
    assert.deepEqual(fs.readFileSync(itemPath), afterFirstAttach);
    assert.equal(
      runGitForTest(fixture.repositoryRoot, ['rev-parse', 'HEAD']),
      headBefore,
    );
    assert.equal(
      runGitForTest(fixture.repositoryRoot, ['show-ref']),
      refsBefore,
    );

    const topLevelText = 'Route one inline request through the top-level CLI.';
    const originalWrite = process.stdout.write;
    let output = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    try {
      assert.equal(
        runCli(['later', topLevelText, '--json'], fixture.repositoryRoot),
        0,
      );
    } finally {
      process.stdout.write = originalWrite;
    }
    const topLevel = JSON.parse(output) as {
      command: string;
      result: { action: string; originalText: string; nextSteps: string[] };
    };
    assert.equal(topLevel.command, 'later');
    assert.equal(topLevel.result.action, 'later');
    assert.equal(topLevel.result.originalText, topLevelText);
    assert.equal(topLevel.result.nextSteps.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('D-019 now converges exact wording on one Source and stable immediate change after capture crash', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-now-intent-'));
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const sourceCountBefore = listGovernanceSources(
      fixture.repositoryRoot,
    ).length;
    const original =
      'Start this exact immediate change without a parking item.';
    const expectedChangeId = `source-${crypto.createHash('sha256').update(original).digest('hex')}`;
    const crash = new Error('simulated crash after now Source capture');
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'now',
          [original],
          fixture.repositoryRoot,
          {
            now: () => '2026-08-24T03:23:30.000Z',
            afterNowSourceCaptured() {
              throw crash;
            },
            startImmediateChange() {
              assert.fail('crash must precede immediate propose');
            },
          },
        ),
      (error) => error === crash,
    );
    const afterCrashSources = listGovernanceSources(fixture.repositoryRoot);
    assert.equal(afterCrashSources.length, sourceCountBefore + 1);
    const immediateSource = afterCrashSources.find(
      (source) => source.text === original,
    );
    assert.ok(immediateSource);

    const starts: Array<{
      changeId: string;
      intent: Record<string, unknown>;
      immediateSource: unknown;
    }> = [];
    const runNow = () =>
      dispatchGovernanceIntakeCommand(
        'now',
        [original],
        fixture.repositoryRoot,
        {
          now: () => '2026-08-24T03:24:00.000Z',
          startImmediateChange(_cwd, changeId, intent, immediateSource) {
            starts.push({ changeId, intent, immediateSource });
            return { state: 'awaiting-main-terms' };
          },
        },
      ) as {
        action: string;
        sourceId: string;
        changeId: string;
        propose: { state: string };
        originalText: string;
        nextSteps: string[];
      };
    const first = runNow();
    const retry = runNow();
    assert.equal(first.action, 'now');
    assert.equal(first.changeId, expectedChangeId);
    assert.equal(retry.changeId, expectedChangeId);
    assert.equal(first.originalText, original);
    assert.equal(first.sourceId, immediateSource.id);
    assert.equal(retry.sourceId, first.sourceId);
    assert.equal(first.propose.state, 'awaiting-main-terms');
    assert.deepEqual(first.nextSteps, [
      'pnpm workflow now <original-text> --json',
    ]);
    assert.equal(
      listGovernanceSources(fixture.repositoryRoot).length,
      sourceCountBefore + 1,
    );
    assert.equal(starts.length, 2);
    for (const start of starts) {
      assert.equal(start.changeId, expectedChangeId);
      assert.deepEqual(start.intent, {
        schemaVersion: 1,
        summary: `Implement the immediate change cited by ${first.sourceId}.`,
        sourceRefs: [first.sourceId],
        explicitPaths: [],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      });
      assert.deepEqual(start.immediateSource, {
        sourceId: first.sourceId,
        exactText: original,
      });
      assert.doesNotMatch(JSON.stringify(start.intent), new RegExp(original));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('D-019 concurrent later calls converge on at most one Work Item', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-later-concurrency-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const originalText = 'Converge concurrent exact-wording intake.';
    let inner:
      | {
          deduplicated: boolean;
          sourceId: string;
          sourceLinked: boolean;
          workItemId: string;
        }
      | undefined;
    const outer = dispatchGovernanceIntakeCommand(
      'later',
      [originalText],
      fixture.repositoryRoot,
      {
        now: () => '2026-08-24T03:27:00.000Z',
        afterLaterSourceCaptured: () => {
          inner = dispatchGovernanceIntakeCommand(
            'later',
            [originalText],
            fixture.repositoryRoot,
            { now: () => '2026-08-24T03:27:01.000Z' },
          ) as typeof inner;
        },
      },
    ) as {
      deduplicated: boolean;
      sourceId: string;
      sourceLinked: boolean;
      matches: string[];
      nextSteps: string[];
    };
    assert.ok(inner);
    assert.equal(inner.deduplicated, false);
    assert.equal(inner.sourceLinked, true);
    assert.equal(outer.deduplicated, true);
    assert.equal(outer.sourceLinked, false);
    assert.deepEqual(outer.matches, [inner.workItemId]);
    assert.deepEqual(outer.nextSteps, [
      `pnpm workflow attach ${inner.workItemId} <original-text> --json`,
    ]);

    const exactSources = listGovernanceSources(fixture.repositoryRoot).filter(
      ({ text }) => text === originalText,
    );
    assert.equal(exactSources.length, 2);
    assert.deepEqual(
      exactSources.map(({ id }) => id).sort(),
      [inner.sourceId, outer.sourceId].sort(),
    );
    const exactItems = listWorkItems(fixture.repositoryRoot).filter((item) =>
      item.sourceRefs.some(
        (sourceRef) =>
          readGovernanceSource(fixture.repositoryRoot, sourceRef).text ===
          originalText,
      ),
    );
    assert.equal(exactItems.length, 1);
    assert.equal(exactItems[0]!.id, inner.workItemId);
    assert.deepEqual(exactItems[0]!.sourceRefs, [inner.sourceId]);
    assert.equal(exactItems[0]!.sourceRefs.includes(outer.sourceId), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('D-019 now work-item preserves inbox authority, promotes ordinary agent work, and keeps protected refusal mutation-free', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-now-work-'));
  configureRepositoryConsumer(root);
  try {
    runGitForTest(root, ['init', '-b', 'main']);
    runGitForTest(root, ['config', 'user.name', 'Jigwright Test']);
    runGitForTest(root, ['config', 'user.email', 'jigwright@example.test']);
    runGitForTest(root, ['add', '.']);
    runGitForTest(root, ['commit', '-m', 'Initialize current repository']);
    const maintainerSource = captureGovernanceSource(root, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright-intake',
      capturedAt: '2026-08-24T04:47:00.000Z',
      contextRef: 'direct-human:workflow-cli',
      text: 'Promote reviewed maintainer work without a survey.',
      supersedes: null,
    }).source;
    const agentSource = captureGovernanceSource(root, {
      semanticAuthor: 'agent',
      capturedBy: 'jigwright-finding-convert',
      capturedAt: '2026-08-24T04:47:10.000Z',
      contextRef:
        'finding:FND-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      text: 'Promote reviewed agent work with a current survey.',
      supersedes: null,
    }).source;
    const secondSource = captureGovernanceSource(root, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright-intake',
      capturedAt: '2026-08-24T04:47:11.000Z',
      contextRef: 'direct-human:workflow-cli',
      text: 'Preserve the second exact premise.',
      supersedes: null,
    }).source;
    const thirdSource = captureGovernanceSource(root, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright-intake',
      capturedAt: '2026-08-24T04:47:12.000Z',
      contextRef: 'direct-human:workflow-cli',
      text: 'Preserve the third exact premise.',
      supersedes: null,
    }).source;
    const create = (
      id: string,
      lane: 'next' | null,
      sourceRefs: readonly string[],
    ) =>
      createWorkItem(
        root,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane,
          title: `Immediate ${id}`,
          summary: 'Preserve reviewed Work Registry authority.',
          sourceRefs,
        },
        {
          now: () => '2026-08-24T04:47:20.000Z',
          createId: () => id,
        },
      );
    const inbox = create('WORK-01K39R0V00000000000000000R', null, [
      maintainerSource.id,
    ]);
    const inboxBytes = fs.readFileSync(path.join(root, inbox.relativePath));
    const inboxResult = dispatchGovernanceIntakeCommand(
      'now',
      [inbox.item.id],
      root,
    ) as {
      promoted: boolean;
      changeId: string | null;
      nextSteps: string[];
    };
    assert.equal(inboxResult.promoted, false);
    assert.equal(inboxResult.changeId, null);
    assert.deepEqual(inboxResult.nextSteps, [
      `pnpm workflow work-item review ${inbox.item.id} --input <accept-review.json> --json`,
      `pnpm workflow work-item review ${inbox.item.id} --input <prioritize-now-review.json> --json`,
    ]);
    assert.deepEqual(
      fs.readFileSync(path.join(root, inbox.relativePath)),
      inboxBytes,
    );

    const blockerIds = [
      'WORK-01K39R0V00000000000000000V',
      'WORK-01K39R0V00000000000000000W',
      'WORK-01K39R0V00000000000000000X',
      'WORK-01K39R0V00000000000000000Y',
    ] as const;
    for (const blockerId of blockerIds) create(blockerId, null, []);
    const blocked = create('WORK-01K39R0V00000000000000000Z', 'next', [
      maintainerSource.id,
    ]);
    const blockedAccepted = applyWorkItemReview(
      root,
      blocked.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(blocked.item),
        summary: blocked.item.interpretation.summary,
      },
      () => '2026-08-24T04:47:21.000Z',
    );
    const blockedPrioritized = applyWorkItemReview(
      root,
      blocked.item.id,
      {
        action: 'prioritize',
        expectedDigest: workItemDigest(blockedAccepted),
        lane: 'next',
        blockedBy: blockerIds,
      },
      () => '2026-08-24T04:47:22.000Z',
    );
    const blockedBytes = fs.readFileSync(path.join(root, blocked.relativePath));
    const blockedResult = dispatchGovernanceIntakeCommand(
      'now',
      [blocked.item.id],
      root,
    );
    assert.deepEqual(blockedResult.nextSteps, [
      `pnpm workflow work-item show ${blockerIds[0]} --json`,
      `pnpm workflow work-item show ${blockerIds[1]} --json`,
      'pnpm workflow guide --json',
    ]);
    assert.deepEqual(showWorkItem(root, blocked.item.id), blockedPrioritized);
    assert.deepEqual(
      fs.readFileSync(path.join(root, blocked.relativePath)),
      blockedBytes,
    );

    const ordinary = create('WORK-01K39R0V00000000000000000S', 'next', [
      agentSource.id,
      secondSource.id,
      thirdSource.id,
    ]);
    const ordinaryAccepted = applyWorkItemReview(
      root,
      ordinary.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(ordinary.item),
        summary: ordinary.item.interpretation.summary,
      },
      () => '2026-08-24T04:47:30.000Z',
    );
    const ordinaryChangeId = `work-${ordinary.item.id
      .slice('WORK-'.length)
      .toLowerCase()}`;
    const ordinaryResult = dispatchGovernanceIntakeCommand(
      'now',
      [ordinary.item.id],
      root,
      { now: () => '2026-08-24T04:47:40.000Z' },
    ) as {
      promoted: boolean;
      changeId: string;
      sourceRefs: string[];
      originalTexts: string[];
      nextSteps: string[];
    };
    assert.equal(ordinaryResult.promoted, true);
    assert.equal(ordinaryResult.changeId, ordinaryChangeId);
    assert.deepEqual(ordinaryResult.sourceRefs, ordinaryAccepted.sourceRefs);
    assert.deepEqual(
      ordinaryResult.originalTexts,
      ordinaryAccepted.sourceRefs.map(
        (sourceRef) => readGovernanceSource(root, sourceRef).text,
      ),
    );
    assert.deepEqual(ordinaryResult.nextSteps, [
      `pnpm workflow work-item show ${ordinary.item.id} --json`,
      `pnpm workflow source trace ${ordinaryAccepted.sourceRefs[0]} --json`,
      'pnpm workflow guide --json',
    ]);
    assert.equal(showWorkItem(root, ordinary.item.id).stage, 'active');
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(root, 'openspec/changes', ordinaryChangeId, 'origin.json'),
          'utf8',
        ),
      ),
      {
        schemaVersion: 1,
        sourceRefs: ordinaryAccepted.sourceRefs,
        workItemRefs: [ordinary.item.id],
      },
    );
    assert.equal(
      fs.existsSync(
        path.join(root, 'openspec/changes', ordinaryChangeId, 'survey.json'),
      ),
      true,
    );
    const beforeOrdinaryRetry = snapshotPlainTree(root);
    const beforeOrdinaryRetryRefs = runGitForTest(root, ['show-ref']);
    const retriedOrdinary = dispatchGovernanceIntakeCommand(
      'now',
      [ordinary.item.id],
      root,
    );
    assert.deepEqual(retriedOrdinary, ordinaryResult);
    assert.deepEqual(snapshotPlainTree(root), beforeOrdinaryRetry);
    assert.equal(runGitForTest(root, ['show-ref']), beforeOrdinaryRetryRefs);

    const protectedItem = create('WORK-01K39R0V00000000000000000T', 'next', [
      maintainerSource.id,
    ]);
    const protectedAccepted = applyWorkItemReview(
      root,
      protectedItem.item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(protectedItem.item),
        summary: protectedItem.item.interpretation.summary,
      },
      () => '2026-08-24T04:47:50.000Z',
    );
    fs.mkdirSync(path.join(root, 'workflow'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'workflow/work-registry-policy.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        transitions: {
          intake: 'ordinary',
          prioritize: 'ordinary',
          promote: 'central-grant',
        },
      })}\n`,
    );
    const protectedChangeId = `work-${protectedItem.item.id
      .slice('WORK-'.length)
      .toLowerCase()}`;
    const protectedBytes = fs.readFileSync(
      path.join(root, protectedItem.relativePath),
    );
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand('now', [protectedItem.item.id], root),
      hasCode('WORK_REGISTRY_GRANT_REQUIRED'),
    );
    assert.deepEqual(
      fs.readFileSync(path.join(root, protectedItem.relativePath)),
      protectedBytes,
    );
    assert.deepEqual(
      showWorkItem(root, protectedItem.item.id),
      protectedAccepted,
    );
    assert.equal(
      fs.existsSync(path.join(root, 'openspec/changes', protectedChangeId)),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('later --kind bug parks an observation in the inbox without minting a Source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-later-bug-'));
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const sourcesBefore = listGovernanceSources(fixture.repositoryRoot).length;
    const text = 'Group list flashes white when scrolled quickly.';
    const first = dispatchGovernanceIntakeCommand(
      'later',
      [text, '--kind', 'bug'],
      fixture.repositoryRoot,
      { now: () => '2026-09-05T01:00:00.000Z', resolveTaskScope: () => null },
    ) as {
      action: string;
      kind: string;
      sourceId: string | null;
      workItemId: string;
      deduplicated: boolean;
    };
    assert.equal(first.action, 'later');
    assert.equal(first.kind, 'bug');
    assert.equal(first.sourceId, null);
    assert.equal(first.deduplicated, false);
    const item = showWorkItem(fixture.repositoryRoot, first.workItemId);
    assert.deepEqual(
      {
        kind: item.kind,
        stage: item.stage,
        lane: item.lane,
        title: item.title,
        summary: item.interpretation.summary,
        status: item.interpretation.status,
        sourceRefs: item.sourceRefs,
      },
      {
        kind: 'bug',
        stage: 'inbox',
        lane: null,
        title: text,
        summary: text,
        status: 'agent-derived',
        sourceRefs: [],
      },
    );
    assert.equal(
      listGovernanceSources(fixture.repositoryRoot).length,
      sourcesBefore,
      'an observation must not mint a Source',
    );
    const second = dispatchGovernanceIntakeCommand(
      'later',
      [text, '--kind', 'bug'],
      fixture.repositoryRoot,
      { now: () => '2026-09-05T01:00:01.000Z', resolveTaskScope: () => null },
    ) as { deduplicated: boolean; matches: string[]; sourceId: string | null };
    assert.equal(second.deduplicated, true);
    assert.deepEqual(second.matches, [first.workItemId]);
    assert.equal(second.sourceId, null);
    const longText = `${text}\n${'Reproduction detail. '.repeat(12)}Keep this final detail.`;
    let immediateIntent: Record<string, unknown> | undefined;
    const immediate = dispatchGovernanceIntakeCommand(
      'now',
      [longText, '--kind', 'bug'],
      fixture.repositoryRoot,
      {
        startImmediateChange(_cwd, _changeId, intent, source) {
          immediateIntent = intent;
          assert.equal(source, null);
          return { state: 'investigating' };
        },
      },
    ) as { originalText: string; sourceId: string | null };
    assert.equal(immediate.originalText, longText);
    assert.equal(immediate.sourceId, null);
    assert.equal(immediateIntent?.summary, longText);
    assert.deepEqual(immediateIntent?.sourceRefs, []);
    assert.equal(
      listGovernanceSources(fixture.repositoryRoot).length,
      sourcesBefore,
    );
    dispatchGovernanceIntakeCommand(
      'attach',
      [first.workItemId, fixture.source.source.id],
      fixture.repositoryRoot,
    );
    const linkedObservation = showWorkItem(
      fixture.repositoryRoot,
      first.workItemId,
    );
    assert.equal(linkedObservation.interpretation.summary, text);
    assert.deepEqual(linkedObservation.sourceRefs, [fixture.source.source.id]);
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'later',
          [text, '--kind', 'wish'],
          fixture.repositoryRoot,
          { resolveTaskScope: () => null },
        ),
      /Unknown kind/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('attach links an existing Source by id and captures a superseding correction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-attach-src-'));
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const deps = {
      now: () => '2026-09-05T01:10:00.000Z',
      resolveTaskScope: () => null,
    };
    const later = dispatchGovernanceIntakeCommand(
      'later',
      ['Show the inline error under the name field.', '--kind', 'feature'],
      fixture.repositoryRoot,
      deps,
    ) as { workItemId: string; sourceId: `SRC-${string}` };
    assert.match(later.sourceId, /^SRC-[0-9a-f]{64}$/u);
    const sourcesAfterLater = listGovernanceSources(
      fixture.repositoryRoot,
    ).length;
    const linked = dispatchGovernanceIntakeCommand(
      'attach',
      [later.workItemId, fixture.source.source.id],
      fixture.repositoryRoot,
      deps,
    ) as {
      sourceId: `SRC-${string}`;
      supersedes: string | null;
      updated: boolean;
      originalText: string;
    };
    assert.equal(linked.sourceId, fixture.source.source.id);
    assert.equal(linked.supersedes, null);
    assert.equal(linked.updated, true);
    assert.equal(linked.originalText, fixture.source.source.text);
    assert.equal(
      listGovernanceSources(fixture.repositoryRoot).length,
      sourcesAfterLater,
      'linking an existing Source must not mint another',
    );
    assert.deepEqual(
      [
        ...showWorkItem(fixture.repositoryRoot, later.workItemId).sourceRefs,
      ].sort(),
      [later.sourceId, fixture.source.source.id].sort(),
    );
    const corrected = dispatchGovernanceIntakeCommand(
      'attach',
      [
        later.workItemId,
        'Show the inline error under the name field, in red.',
        '--supersedes',
        later.sourceId,
      ],
      fixture.repositoryRoot,
      { ...deps, now: () => '2026-09-05T01:11:00.000Z' },
    ) as { sourceId: `SRC-${string}`; supersedes: string | null };
    assert.equal(corrected.supersedes, later.sourceId);
    assert.equal(
      readGovernanceSource(fixture.repositoryRoot, corrected.sourceId)
        .supersedes,
      later.sourceId,
    );
    assert.ok(
      showWorkItem(
        fixture.repositoryRoot,
        later.workItemId,
      ).sourceRefs.includes(corrected.sourceId),
    );
    const sourcesAfterCorrection = listGovernanceSources(
      fixture.repositoryRoot,
    ).length;
    const repeated = dispatchGovernanceIntakeCommand(
      'attach',
      [
        later.workItemId,
        'Show the inline error under the name field, in red.',
        '--supersedes',
        later.sourceId,
      ],
      fixture.repositoryRoot,
      { ...deps, now: () => '2026-09-05T01:12:00.000Z' },
    ) as { sourceId: string; updated: boolean };
    assert.equal(repeated.sourceId, corrected.sourceId);
    assert.equal(repeated.updated, false);
    assert.equal(
      listGovernanceSources(fixture.repositoryRoot).length,
      sourcesAfterCorrection,
    );
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'attach',
          [
            later.workItemId,
            fixture.source.source.id,
            '--supersedes',
            later.sourceId,
          ],
          fixture.repositoryRoot,
          deps,
        ),
      /cannot also supersede/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
