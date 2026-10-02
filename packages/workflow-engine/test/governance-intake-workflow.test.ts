import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  createGovernanceIntakeWorkflow,
  createGovernanceIntakeCountInspector,
  GovernanceIntakeTextError,
  type GovernanceIntakeWorkflowOperations,
  type GovernanceIntakeWorkflowOptions,
} from '../src/application/governance-intake/governance-intake-workflow.ts';
import { createCurrentGovernanceIntakeCounts } from '../src/application/governance-intake/current-governance-intake-counts.ts';
import { createGovernanceSourceServices } from '../src/application/governance-intake/governance-sources.ts';
import { createGovernanceFindingServices } from '../src/application/governance-intake/governance-findings.ts';
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';
import type { GovernanceFindingContextV1 } from '../src/modules/governance-intake/governance-intake.ts';
import type {
  WorkItemV1,
  WorkRegistryInventoryV1,
} from '../src/modules/governance-intake/work-registry-contracts.ts';
import { workItemDigest } from '../src/modules/governance-intake/work-registry-record.ts';

const cwd = '/repository';
const timestamp = '2026-10-02T00:00:00.000Z';
const wording = '  Preserve the original\r\nwording.  \n';
const context: GovernanceFindingContextV1 = {
  repositoryRoot: cwd,
  runtimeRoot: '/runtime',
  sessionId: 'session-intake',
  changeId: 'intake',
  branch: 'work/intake',
  head: 'a'.repeat(40),
  tree: 'b'.repeat(40),
};
const changeId = `source-${crypto.createHash('sha256').update(wording).digest('hex')}`;
function item(overrides: Partial<WorkItemV1> = {}): WorkItemV1 {
  return {
    schemaVersion: 1,
    id: 'WORK-00000000000000000000000001',
    createdAt: timestamp,
    kind: 'bug',
    stage: 'inbox',
    lane: null,
    title: 'Observed problem',
    interpretation: { status: 'agent-derived', summary: wording },
    aliases: [],
    sourceRefs: [],
    blockedBy: [],
    changeRefs: [],
    timeline: [{ at: timestamp, event: 'created', changeId: null }],
    closure: null,
    ...overrides,
  };
}
function fixture() {
  const events: string[] = [],
    sources = new Map<string, GovernanceSourceV1>(),
    records = new Map<string, Buffer>();
  const forbidden = (): never => {
    throw new Error('Unexpected capability');
  };
  const sourcesPort = createGovernanceSourceServices({
    readSource(root, id) {
      assert.equal(root, cwd);
      events.push(`source:${id}`);
      const source = sources.get(id);
      assert.ok(source);
      return source;
    },
    listSources(root) {
      assert.equal(root, cwd);
      events.push('sources');
      return [...sources.values()];
    },
    readAliases: forbidden,
    publishSource(root, source) {
      assert.equal(root, cwd);
      events.push('capture');
      const created = !sources.has(source.id);
      sources.set(source.id, source);
      return created;
    },
  });
  const findings = createGovernanceFindingServices({
    readGovernanceSource: sourcesPort.readGovernanceSource,
    findingRef: {
      readFindingRef(root) {
        assert.equal(root, context.runtimeRoot);
        events.push('findings');
        return { records: new Map(records) };
      },
      publishFindingRefRecord(root, p, bytes) {
        assert.equal(root, context.runtimeRoot);
        events.push(p.endsWith('.disposition.json') ? 'receipt' : 'finding');
        records.set(p, bytes);
        return true;
      },
    },
  });
  const operations: GovernanceIntakeWorkflowOperations = {
    sources: sourcesPort,
    findings,
    queries: {
      listWorkItems: forbidden,
      showWorkItem: forbidden,
      findWorkItemsByExactSourceText: forbidden,
    },
    writes: {
      applyWorkItemReview: forbidden,
      attachSourceToWorkItem: forbidden,
      assertOrdinaryWorkRegistryTransition: forbidden,
      createWorkItem: forbidden,
      correctWorkItemSource: forbidden,
      createWorkItemAfterExactSourceTextRecheck: forbidden,
      ensureWorkItemPromotionChangeDirectory: forbidden,
      ensureWorkItemPromotionSurveyBinding: forbidden,
      ensureFindingConversionWorkItem: forbidden,
      hasExactCurrentWorkItemPromotion: forbidden,
      prepareWorkItemPromotionSurvey: forbidden,
      promoteWorkItem: forbidden,
    },
    context: {
      taskScope(root) {
        assert.equal(root, cwd);
        events.push('task');
        return null;
      },
      runtimeRoot(root) {
        assert.equal(root, cwd);
        events.push('runtime');
        return context.runtimeRoot;
      },
      existingChange: forbidden,
    },
    now() {
      events.push('clock');
      return timestamp;
    },
  };
  const capture = (
    text = wording,
    supersedes: GovernanceSourceV1['id'] | null = null,
    capturedAt = timestamp,
  ) =>
    sourcesPort.captureGovernanceSource(cwd, {
      semanticAuthor: 'maintainer',
      capturedBy: 'test',
      capturedAt,
      contextRef: 'direct-human:test',
      text,
      supersedes,
    }).source;
  const workflow = (options: GovernanceIntakeWorkflowOptions = {}) =>
    createGovernanceIntakeWorkflow(operations, options);
  return { events, sources, records, operations, capture, workflow, findings };
}

test('workflow construction is lazy and independent; missing immediate start precedes reads and capture', () => {
  const a = fixture(),
    b = fixture();
  a.workflow();
  b.workflow();
  assert.deepEqual(a.events, []);
  assert.deepEqual(b.events, []);
  assert.throws(
    () => a.workflow().startText(cwd, wording, 'improvement'),
    /dependency is unavailable/,
  );
  assert.deepEqual(a.events, []);
  assert.equal(a.sources.size, 0);
  const result = a
    .workflow({
      startImmediateChange(root, id, intent, source) {
        assert.equal(root, cwd);
        assert.equal(id, changeId);
        assert.equal(intent.summary, wording);
        assert.deepEqual(intent.sourceRefs, []);
        assert.equal(source, null);
        return 'started';
      },
    })
    .startText(cwd, wording, 'bug');
  assert.equal(result.originalText, wording);
  assert.equal(result.sourceId, null);
  assert.equal(result.propose, 'started');
  assert.deepEqual(a.events, []);
  assert.deepEqual(b.events, []);
});

test('now captures exact requirement text before start and reuses stable Source after an interruption', () => {
  const f = fixture(),
    interrupted = new Error('after capture');
  assert.throws(
    () =>
      f
        .workflow({
          startImmediateChange: () => assert.fail('must not start'),
          afterNowSourceCaptured() {
            f.events.push('hook');
            throw interrupted;
          },
        })
        .startText(cwd, wording, 'feature'),
    (error) => error === interrupted,
  );
  assert.deepEqual(f.events, ['sources', 'clock', 'capture', 'hook']);
  assert.equal(f.sources.size, 1);
  const source = [...f.sources.values()][0]!;
  assert.equal(source.text, wording);
  assert.equal(source.capturedBy, 'jigwright-intake');
  assert.equal(source.contextRef, 'direct-human:workflow-cli');
  f.events.length = 0;
  const result = f
    .workflow({
      afterNowSourceCaptured: () => assert.fail('reused Source'),
      startImmediateChange(root, id, intent, binding) {
        f.events.push('start');
        assert.equal(root, cwd);
        assert.equal(id, changeId);
        assert.deepEqual(binding, { sourceId: source.id, exactText: wording });
        assert.deepEqual(intent, {
          schemaVersion: 1,
          summary: `Implement the immediate change cited by ${source.id}.`,
          sourceRefs: [source.id],
          explicitPaths: [],
          explicitSymbols: [],
          explicitConfigKeys: [],
          renamePairs: [],
        });
        return 'propose';
      },
    })
    .startText(cwd, wording, 'feature');
  assert.equal(result.sourceId, source.id);
  assert.deepEqual(f.events, ['sources', 'start']);
});

test('now selects the first sorted maintainer non-superseding exact Source', () => {
  const f = fixture();
  const a = f.capture(),
    b = f.capture(wording, null, '2026-10-02T00:00:01.000Z');
  f.capture(wording, a.id);
  f.events.length = 0;
  const result = f
    .workflow({ startImmediateChange: () => null })
    .startText(cwd, wording, 'improvement');
  assert.equal(
    result.sourceId,
    [a.id, b.id].sort((x, y) => x.localeCompare(y))[0],
  );
  assert.deepEqual(f.events, ['sources']);
});

test('later samples time before task scope; active task only records a Finding with its own clock', () => {
  const f = fixture();
  let calls = 0;
  f.operations.context.taskScope = () => {
    f.events.push('task');
    return context;
  };
  const result = f
    .workflow({
      now() {
        f.events.push('clock');
        calls++;
        return calls === 1 ? timestamp : '2026-10-02T00:00:01.000Z';
      },
    })
    .deferText(cwd, wording, 'bug');
  assert.equal(result.outcome, 'finding');
  assert.equal(result.originalText, wording);
  assert.equal(calls, 2);
  assert.deepEqual(f.events, ['clock', 'task', 'clock', 'findings', 'finding']);
  assert.equal(f.sources.size, 0);
});

test('later observation reuses only open exact summaries and creates no Source', () => {
  const f = fixture(),
    matched = item(),
    closed = item({ id: 'WORK-00000000000000000000000002', stage: 'closed' });
  f.operations.queries.listWorkItems = () => {
    f.events.push('items');
    return [
      closed,
      matched,
      item({
        interpretation: { status: 'agent-derived', summary: 'different' },
      }),
    ];
  };
  const result = f.workflow().deferText(cwd, wording, 'research');
  assert.equal(result.outcome, 'observation-match');
  if (result.outcome !== 'observation-match') assert.fail();
  assert.deepEqual(result.matches, [matched.id]);
  assert.deepEqual(f.events, ['clock', 'task', 'items']);
  assert.equal(f.sources.size, 0);
  f.operations.queries.listWorkItems = () => [];
  f.operations.writes.createWorkItem = (root, input, options) => {
    assert.equal(root, cwd);
    assert.deepEqual(input.sourceRefs, []);
    assert.equal(input.summary, wording);
    assert.equal(input.title, 'Preserve the original wording.');
    assert.equal(options?.now?.(), timestamp);
    return { item: matched, relativePath: 'item' };
  };
  assert.equal(
    f.workflow().deferText(cwd, wording, 'chore').outcome,
    'created',
  );
  assert.equal(f.sources.size, 0);
});

test('later requirement delegates atomic recheck and retains the captured losing-race Source', () => {
  const f = fixture(),
    matched = item();
  let firstMatch = false;
  f.operations.queries.findWorkItemsByExactSourceText = () => {
    f.events.push('exact');
    return firstMatch ? [matched] : [];
  };
  f.operations.writes.createWorkItemAfterExactSourceTextRecheck = (
    root,
    text,
    input,
    options,
  ) => {
    f.events.push('locked-recheck');
    assert.equal(root, cwd);
    assert.equal(text, wording);
    assert.equal(input.sourceRefs.length, 1);
    assert.equal(options?.now?.(), timestamp);
    return { created: false, matches: [matched] };
  };
  const result = f
    .workflow({
      afterLaterSourceCaptured() {
        f.events.push('hook');
      },
    })
    .deferText(cwd, wording, 'feature');
  assert.equal(result.outcome, 'requirement-match');
  if (result.outcome !== 'requirement-match') assert.fail();
  assert.ok(result.sourceId);
  assert.equal(result.sourceLinked, false);
  assert.deepEqual(result.matches, [matched.id]);
  assert.deepEqual(f.events, [
    'clock',
    'task',
    'exact',
    'capture',
    'hook',
    'locked-recheck',
  ]);
  assert.equal(f.sources.size, 1);
  f.events.length = 0;
  firstMatch = true;
  const reused = f.workflow().deferText(cwd, wording, 'feature');
  assert.equal(reused.sourceId, null);
  assert.deepEqual(f.events, ['clock', 'task', 'exact']);
});

test('now reads all original Sources before replay shortcut and does not apply fresh promotion guards to replay', () => {
  const f = fixture(),
    a = f.capture(' one\n'),
    b = f.capture(' two\r\n');
  const current = item({ stage: 'closed', sourceRefs: [a.id, b.id] });
  f.events.length = 0;
  f.operations.queries.showWorkItem = () => {
    f.events.push('item');
    return current;
  };
  f.operations.writes.hasExactCurrentWorkItemPromotion = (root, id, change) => {
    f.events.push('exact-promotion');
    assert.equal(root, cwd);
    assert.equal(id, current.id);
    assert.equal(change, `work-${id.slice(5).toLowerCase()}`);
    return true;
  };
  const result = f
    .workflow()
    .startWorkItem(cwd, current.id, () => assert.fail('no guard'));
  assert.equal(result.outcome, 'promoted');
  assert.deepEqual(result.originalTexts, [' one\n', ' two\r\n']);
  assert.deepEqual(f.events, [
    'item',
    `source:${a.id}`,
    `source:${b.id}`,
    'exact-promotion',
  ]);
});

test('now refuses or reports review, priority and blockers before mutation; allowed promotion preserves primitive order', () => {
  const f = fixture();
  let current = item();
  f.operations.queries.showWorkItem = (_root, id) => {
    f.events.push(`item:${id}`);
    return id === current.id
      ? current
      : item({ id: id as WorkItemV1['id'], stage: 'backlog' });
  };
  f.operations.writes.hasExactCurrentWorkItemPromotion = () => false;
  assert.equal(
    f.workflow().startWorkItem(cwd, current.id, () => assert.fail()).outcome,
    'needs-review',
  );
  current = item({ stage: 'active' });
  assert.throws(
    () => f.workflow().startWorkItem(cwd, current.id, () => assert.fail()),
    /current unpromoted backlog/,
  );
  current = item({
    stage: 'backlog',
    interpretation: { status: 'maintainer-confirmed', summary: wording },
  });
  assert.equal(
    f.workflow().startWorkItem(cwd, current.id, () => assert.fail()).outcome,
    'needs-priority',
  );
  current = {
    ...current,
    lane: 'now',
    blockedBy: ['WORK-00000000000000000000000002'],
  };
  const blocked = f
    .workflow()
    .startWorkItem(cwd, current.id, () => assert.fail());
  assert.equal(blocked.outcome, 'blocked');
  if (blocked.outcome !== 'blocked') assert.fail();
  assert.deepEqual(blocked.blockingWorkItemIds, current.blockedBy);
  current = { ...current, blockedBy: [] };
  f.events.length = 0;
  const stopped = new Error('grant');
  f.operations.writes.assertOrdinaryWorkRegistryTransition = () => {
    f.events.push('guard');
    throw stopped;
  };
  assert.throws(
    () => f.workflow().startWorkItem(cwd, current.id, () => 'guidance'),
    (error) => error === stopped,
  );
  assert.deepEqual(f.events, [`item:${current.id}`, 'guard']);
  f.events.length = 0;
  f.operations.writes.assertOrdinaryWorkRegistryTransition = (
    root,
    transition,
    guidance,
    details,
  ) => {
    f.events.push('guard');
    assert.equal(root, cwd);
    assert.equal(transition, 'promote');
    assert.equal(guidance, 'guidance');
    assert.deepEqual(details, {
      schemaVersion: 1,
      kind: 'work-registry-grant-required.v1',
      operation: 'promote',
      transition: 'promote',
      workItemId: current.id,
      changeId: `work-${current.id.slice(5).toLowerCase()}`,
      expectedDigest: workItemDigest(current),
    });
  };
  f.operations.writes.ensureWorkItemPromotionChangeDirectory = () => {
    f.events.push('directory');
    return '/change';
  };
  f.operations.writes.ensureWorkItemPromotionSurveyBinding = () => {
    f.events.push('survey');
    return {
      schemaVersion: 1,
      kind: 'current-survey',
      digest: `sha256:${'a'.repeat(64)}`,
    };
  };
  f.operations.writes.promoteWorkItem = (root, id, change, now, digest) => {
    f.events.push('promote');
    assert.equal(digest, workItemDigest(current));
    assert.equal(now, undefined);
    return { item: current, originPath: 'origin', created: true };
  };
  assert.equal(
    f.workflow().startWorkItem(cwd, current.id, () => 'guidance').outcome,
    'promoted',
  );
  assert.deepEqual(f.events, [
    `item:${current.id}`,
    'guard',
    'directory',
    'survey',
    'promote',
  ]);
});

test('attach observes current/closed before wording, supersedes and canonical Source checks', () => {
  const f = fixture();
  let current = item({ stage: 'closed' });
  f.operations.queries.showWorkItem = () => {
    f.events.push('item');
    return current;
  };
  for (const request of [
    { kind: 'wording' as const, value: ' ' },
    { kind: 'existing' as const, value: `SRC-${'a'.repeat(64)}` },
  ])
    assert.throws(
      () => f.workflow().attachSource(cwd, current.id, request, 'bad'),
      /closed Work Item/,
    );
  assert.deepEqual(f.events, ['item', 'item']);
  current = item();
  f.events.length = 0;
  assert.throws(
    () =>
      f
        .workflow()
        .attachSource(cwd, current.id, { kind: 'wording', value: ' ' }, 'bad'),
    GovernanceIntakeTextError,
  );
  assert.throws(
    () =>
      f
        .workflow()
        .attachSource(
          cwd,
          current.id,
          { kind: 'wording', value: wording },
          'bad',
        ),
    /supersedes needs/,
  );
  assert.deepEqual(f.events, ['item', 'item']);
  const source = f.capture();
  f.events.length = 0;
  f.operations.writes.attachSourceToWorkItem = (_root, id, ref) => {
    f.events.push('attach');
    assert.equal(id, current.id);
    assert.equal(ref, source.id);
    return { item: current, updated: true };
  };
  const result = f
    .workflow()
    .attachSource(
      cwd,
      current.id,
      { kind: 'existing', value: source.id },
      null,
    );
  assert.equal(result.originalText, wording);
  assert.equal(result.sourceId, source.id);
  assert.deepEqual(f.events, ['item', `source:${source.id}`, 'attach']);
});

test('attach wording reuses only a matching attached supersession; correction hook and CAS digest survive replay', () => {
  const f = fixture(),
    old = f.capture('old'),
    other = f.capture(wording, old.id),
    attached = f.capture(wording, old.id, '2026-10-02T00:00:01.000Z');
  const current = item({ sourceRefs: [attached.id] });
  f.operations.queries.showWorkItem = () => {
    f.events.push('item');
    return current;
  };
  f.operations.queries.findWorkItemsByExactSourceText = () => [current];
  f.operations.writes.attachSourceToWorkItem = (_root, _id, ref) => {
    assert.equal(ref, attached.id);
    return { item: current, updated: false };
  };
  f.events.length = 0;
  assert.equal(
    f
      .workflow()
      .attachSource(
        cwd,
        current.id,
        { kind: 'wording', value: wording },
        old.id,
      ).sourceId,
    attached.id,
  );
  assert.ok(!f.events.includes('capture'));
  f.operations.writes.correctWorkItemSource = (
    _root,
    id,
    replaced,
    ref,
    digest,
  ) => {
    f.events.push('correct');
    assert.equal(id, current.id);
    assert.equal(replaced, old.id);
    assert.equal(ref, attached.id);
    assert.notEqual(ref, other.id);
    assert.equal(digest, workItemDigest(current));
    return { item: current, updated: false };
  };
  f.events.length = 0;
  const corrected = f
    .workflow({
      afterCorrectSourceCaptured() {
        f.events.push('hook');
      },
    })
    .correctSource(cwd, current.id, old.id, wording);
  assert.equal(corrected.sourceId, attached.id);
  assert.equal(corrected.updated, false);
  assert.deepEqual(f.events, [
    'item',
    `source:${old.id}`,
    'sources',
    'hook',
    'correct',
  ]);
});

test('conversion writes the deterministic inbox item before receipt and immediate-start availability; retry does not mint Sources', () => {
  const f = fixture();
  const found = f.findings.recordGovernanceFinding(
    context,
    { schemaVersion: 1, text: wording, sourceRefs: [] },
    () => timestamp,
  ).finding;
  const convertedItem = item({
    id: `WORK-${found.id.slice(4, 30).toUpperCase()}`,
  });
  let ensured = false;
  f.operations.writes.ensureFindingConversionWorkItem = (
    root,
    id,
    input,
    createdAt,
  ) => {
    f.events.push('ensure');
    assert.equal(root, cwd);
    assert.equal(id, found.id);
    assert.equal(createdAt, found.createdAt);
    assert.equal(input.summary, wording);
    assert.deepEqual(input.sourceRefs, []);
    const created = !ensured;
    ensured = true;
    return { item: convertedItem, relativePath: 'item', created };
  };
  f.events.length = 0;
  assert.throws(
    () =>
      f
        .workflow({
          afterFindingConversionWorkItemPersisted() {
            f.events.push('hook');
          },
        })
        .convertFinding(cwd, found.id, 'bug', true),
    /dependency is unavailable/,
  );
  assert.deepEqual(f.events, [
    'runtime',
    'findings',
    'ensure',
    'hook',
    'findings',
    'receipt',
    'findings',
  ]);
  assert.equal(f.sources.size, 0);
  const refBefore = new Map(f.records);
  f.events.length = 0;
  const result = f
    .workflow({
      startImmediateChange(root, id, intent, binding) {
        f.events.push('start');
        assert.equal(root, cwd);
        assert.equal(id, changeId);
        assert.equal(intent.summary, wording);
        assert.deepEqual(intent.sourceRefs, []);
        assert.equal(binding, null);
        return 'started';
      },
    })
    .convertFinding(cwd, found.id, 'bug', true);
  assert.equal(result.outcome, 'started');
  assert.equal(result.workItemCreated, false);
  assert.equal(result.created, false);
  assert.deepEqual(f.records, refBefore);
  assert.equal(f.sources.size, 0);
  assert.deepEqual(f.events, [
    'runtime',
    'findings',
    'ensure',
    'findings',
    'start',
  ]);
});

test('conversion validates sorted unique cited Sources before deterministic write and preserves primitive failures', () => {
  const f = fixture(),
    a = f.capture('a'),
    b = f.capture('b');
  const found = f.findings.recordGovernanceFinding(
    context,
    { schemaVersion: 1, text: wording, sourceRefs: [b.id, a.id] },
    () => timestamp,
  ).finding;
  const stopped = new Error('item conflict');
  f.operations.writes.ensureFindingConversionWorkItem = (_root, _id, input) => {
    f.events.push('ensure');
    assert.deepEqual(input.sourceRefs, [a.id, b.id].sort());
    throw stopped;
  };
  f.events.length = 0;
  assert.throws(
    () => f.workflow().convertFinding(cwd, found.id, 'bug', false),
    (e) => e === stopped,
  );
  assert.deepEqual(f.events, [
    'runtime',
    'findings',
    ...[a.id, b.id].sort().map((id) => `source:${id}`),
    'ensure',
  ]);
  f.findings.linkGovernanceFinding(
    context.runtimeRoot,
    found.id,
    'existing',
    () => timestamp,
  );
  f.events.length = 0;
  assert.throws(
    () => f.workflow().convertFinding(cwd, found.id, 'bug', false),
    /different terminal disposition/,
  );
  assert.deepEqual(f.events, ['runtime', 'findings']);
});

test('Finding links resolve canonical Work Item or safe change before runtime and receipt', () => {
  for (const kind of ['work-item', 'change'] as const) {
    const f = fixture(),
      found = f.findings.recordGovernanceFinding(
        context,
        { schemaVersion: 1, text: wording, sourceRefs: [] },
        () => timestamp,
      ).finding;
    f.operations.queries.showWorkItem = () => {
      f.events.push('item');
      return item();
    };
    f.operations.context.existingChange = (_root, id) => {
      f.events.push('change');
      assert.equal(id, 'existing');
      return id;
    };
    f.events.length = 0;
    const result = f.workflow().linkFinding(cwd, found.id, {
      kind,
      id: kind === 'change' ? 'existing' : item().id,
    });
    assert.equal(result.originalText, wording);
    assert.deepEqual(f.events, [
      kind === 'change' ? 'change' : 'item',
      'runtime',
      'findings',
      'receipt',
      'findings',
    ]);
    assert.deepEqual(result.finding.target, {
      kind,
      id: kind === 'change' ? 'existing' : item().id,
    });
  }
});

test('explicit promotion and review keep guard before mutation; prepare observes title after preparation', () => {
  const f = fixture(),
    current = item();
  f.operations.writes.assertOrdinaryWorkRegistryTransition = (
    _root,
    transition,
    guidance,
    details,
  ) => {
    f.events.push(`guard:${transition}`);
    assert.equal(guidance, 'guidance');
    assert.equal(details?.workItemId, current.id);
  };
  f.operations.writes.ensureWorkItemPromotionSurveyBinding = () => {
    f.events.push('survey');
    return {
      schemaVersion: 1,
      kind: 'current-survey',
      digest: `sha256:${'a'.repeat(64)}`,
    };
  };
  f.operations.writes.promoteWorkItem = (_root, id, change, now, digest) => {
    f.events.push('promote');
    assert.equal(digest, 'expected');
    return { item: current, originPath: 'origin', created: true };
  };
  f.workflow().promote(cwd, current.id, 'existing', 'expected', 'guidance');
  assert.deepEqual(f.events, ['guard:promote', 'survey', 'promote']);
  f.operations.writes.applyWorkItemReview = (_root, _id, review) => {
    f.events.push('review');
    assert.equal(review.action, 'prioritize');
    return current;
  };
  f.events.length = 0;
  assert.equal(
    f.workflow().reviewWorkItem(
      cwd,
      current.id,
      {
        action: 'prioritize',
        expectedDigest: 'expected',
        lane: 'now',
        blockedBy: [],
      },
      'guidance',
    ),
    current,
  );
  assert.deepEqual(f.events, ['guard:prioritize', 'review']);
  f.operations.writes.prepareWorkItemPromotionSurvey = (_root, id, change) => {
    f.events.push('prepare');
    return {
      relativePath: 'survey',
      survey: {
        schemaVersion: 1,
        workItemId: id as WorkItemV1['id'],
        changeId: change,
        surveyedCommit: 'a'.repeat(40),
        symbols: [],
        emptyReason: 'none',
      },
    };
  };
  f.operations.queries.showWorkItem = () => {
    f.events.push('item');
    return current;
  };
  f.events.length = 0;
  assert.equal(
    f.workflow().preparePromotion(cwd, current.id, 'existing', {
      schemaVersion: 1,
      symbols: [],
      emptyReason: 'none',
    }).title,
    current.title,
  );
  assert.deepEqual(f.events, ['prepare', 'item']);
});

test('count query observes once then inspects inventory before Findings; errors preserve identity and stop later steps', () => {
  const f = fixture();
  f.findings.recordGovernanceFinding(
    context,
    { schemaVersion: 1, text: wording, sourceRefs: [] },
    () => timestamp,
  );
  f.events.length = 0;
  const inventory: WorkRegistryInventoryV1 = {
    schemaVersion: 1,
    itemCount: 5,
    sourceCount: 0,
    items: [],
    stages: { inbox: 2, backlog: 3, active: 0, closed: 0 },
    lanes: { now: 0, next: 0, later: 0, icebox: 0, unprioritized: 5 },
    currentItemIds: [],
    blockedItemIds: [],
  };
  const inspect = createGovernanceIntakeCountInspector({
    queries: {
      inspectWorkRegistry(root) {
        f.events.push('inventory');
        assert.equal(root, cwd);
        return inventory;
      },
    },
    findings: f.findings,
  });
  const query = createCurrentGovernanceIntakeCounts({
    observe(root) {
      assert.equal(root, '/caller');
      f.events.push('observe');
      return { repositoryRoot: cwd, runtimeRoot: context.runtimeRoot };
    },
    inspect,
  });
  assert.deepEqual(f.events, []);
  assert.deepEqual(query('/caller'), {
    schemaVersion: 1,
    inbox: 2,
    backlog: 3,
    pendingFindings: 1,
  });
  assert.deepEqual(f.events, ['observe', 'inventory', 'findings']);
  const stopped = new Error('observation');
  assert.throws(
    () =>
      createCurrentGovernanceIntakeCounts({
        observe() {
          throw stopped;
        },
        inspect,
      })('/caller'),
    (e) => e === stopped,
  );
  assert.throws(
    () =>
      createGovernanceIntakeCountInspector({
        queries: {
          inspectWorkRegistry() {
            throw stopped;
          },
        },
        findings: {
          listGovernanceFindings() {
            assert.fail('must not inspect Findings');
          },
        },
      })(cwd, context.runtimeRoot),
    (e) => e === stopped,
  );
});
