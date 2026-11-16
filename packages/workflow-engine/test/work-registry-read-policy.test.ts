import assert from 'node:assert/strict';
import test from 'node:test';
import { createGovernanceSourceV1 } from '@jigwright/core/governance-source';
import {
  createWorkRegistryQueries,
  type WorkRegistryReadCapabilities,
} from '../src/application/work-registry/work-registry-queries.ts';
import {
  createWorkRegistryProjectionOperations,
  type WorkRegistryProjectionStorage,
} from '../src/application/work-registry/work-registry-projections.ts';
import {
  assertNoCycles,
  assertSourceRelations,
  assertWorkItemRelations,
  originChangeIdentity,
} from '../src/modules/governance-intake/work-registry-queries.ts';
import type {
  WorkItemV1,
  ChangeOriginV1,
} from '../src/modules/governance-intake/work-registry-contracts.ts';
import { parseRepositoryConsumerConfiguration } from '../src/modules/repository-consumer/repository-consumer-policy.ts';
import { defaultConsumerSetup } from '../src/modules/adoption/setup-questions.ts';

const source = createGovernanceSourceV1({
  semanticAuthor: 'maintainer',
  capturedBy: 'test',
  capturedAt: '2026-09-08T00:00:00.000Z',
  contextRef: 'direct-human:test',
  text: '  Exact 原話.\r\n\nTrailing spaces.  \n',
  supersedes: null,
});
function item(id = '1', overrides: Partial<WorkItemV1> = {}): WorkItemV1 {
  return {
    schemaVersion: 1,
    id: `WORK-${id.repeat(26)}`,
    createdAt: '2026-09-08T00:00:00.000Z',
    kind: 'feature',
    stage: 'backlog',
    lane: 'next',
    title: `Item ${id}`,
    interpretation: {
      summary: 'An interpretation.',
      status: 'maintainer-confirmed',
    },
    aliases: [`ISS-${id}`],
    sourceRefs: [source.id],
    blockedBy: [],
    changeRefs: [],
    timeline: [
      { at: '2026-09-08T00:00:00.000Z', event: 'created', changeId: null },
    ],
    closure: null,
    ...overrides,
  };
}
function fixture() {
  const events: string[] = [];
  let items = [item()];
  let sources = [source];
  let config: 'absent' | 'valid' | 'invalid' = 'valid';
  let readHook: ((target: string, count: number) => void) | undefined;
  const readCounts = new Map<string, number>();
  const origins = new Map<string, ChangeOriginV1>();
  const files = new Map<string, string>();
  let history: 'absent' | 'directory' | 'unsafe' = 'absent';
  let histories: string[] = [];
  const valid = () => {
    if (config === 'invalid') throw Error('invalid consumer config');
  };
  const ports: WorkRegistryReadCapabilities = {
    withWorkRegistryPromotionLockWhenAvailable(_root, operation) {
      events.push('lock');
      try {
        return operation();
      } finally {
        events.push('unlock');
      }
    },
    withWorkRegistryPromotionReadLockWhenAvailable(_root, operation) {
      events.push('read-lock');
      try {
        return operation();
      } finally {
        events.push('read-unlock');
      }
    },
    readItems() {
      valid();
      events.push('items');
      return [...items];
    },
    readItemsUnlocked() {
      valid();
      events.push('items-unlocked');
      return [...items];
    },
    readSource(_root, id) {
      events.push(`source:${id}`);
      const value = sources.find((s) => s.id === id);
      if (!value) throw Error('missing source');
      return value;
    },
    listSources() {
      events.push('sources');
      return [...sources];
    },
    canonicalRoot() {
      events.push('canonical-root');
      return '/repo';
    },
    hasConsumerConfiguration() {
      events.push('config-presence');
      return config !== 'absent';
    },
    listOriginReferences() {
      valid();
      events.push('origins');
      return [...origins.keys()];
    },
    readOrigin(reference) {
      events.push(`origin:${reference}`);
      return origins.get(reference)!;
    },
    originChangeId(_root, reference) {
      valid();
      events.push(`origin-identity:${reference}`);
      return reference;
    },
    relativeOriginPath: (_root, reference) =>
      `changes/${reference}/origin.json`,
    readCurrentOrigin(_root, changeId) {
      valid();
      events.push(`current-origin:${changeId}`);
      return origins.get(changeId) ?? null;
    },
  };
  const queries = createWorkRegistryQueries(ports);
  const layout = parseRepositoryConsumerConfiguration({
    ...defaultConsumerSetup('repository'),
    documents: {
      adapterId: 'filesystem-documents-v1',
      handoffPath: 'docs/HANDOFF.md',
    },
  }).workRegistry;
  const storage: WorkRegistryProjectionStorage = {
    readLayout() {
      valid();
      events.push('layout');
      return layout;
    },
    resolvePath(_root, p) {
      valid();
      events.push(`resolve:${p}`);
      return `/repo/${p}`;
    },
    read(target) {
      events.push(`read:${target}`);
      const count = (readCounts.get(target) ?? 0) + 1;
      readCounts.set(target, count);
      readHook?.(target, count);
      return files.get(target) ?? null;
    },
    write(target, text) {
      events.push(`write:${target}`);
      files.set(target, text);
    },
    exists: (target) => files.has(target),
    historyState: () => history,
    listHistoryPaths: () => histories,
  };
  const projections = createWorkRegistryProjectionOperations(
    queries,
    storage,
    ports.withWorkRegistryPromotionLockWhenAvailable,
    (root, id) => ports.readSource(root, id).text,
  );
  return {
    queries,
    projections,
    ports,
    storage,
    files,
    origins,
    events,
    onRead: (hook: typeof readHook) => {
      readHook = hook;
    },
    items: (value: WorkItemV1[]) => {
      items = value;
    },
    sources: (value: typeof sources) => {
      sources = value;
    },
    config: (value: typeof config) => {
      config = value;
    },
    history: (value: typeof history, paths: string[] = []) => {
      history = value;
      histories = paths;
    },
  };
}

test('pure relations reject duplicate or missing identities and cycles without storage', () => {
  assert.throws(() => assertSourceRelations([source, source]), /duplicated/);
  assert.throws(
    () =>
      assertWorkItemRelations(
        [item('1', { blockedBy: [item('2').id] })],
        new Set([source.id]),
      ),
    /missing blocker/,
  );
  assert.throws(
    () =>
      assertNoCycles([
        item('1', { blockedBy: [item('2').id] }),
        item('2', { blockedBy: [item('1').id] }),
      ]),
    /cycle/,
  );
  assert.equal(
    originChangeIdentity('archive/2026-09-08-demo/origin.json'),
    'demo',
  );
  assert.throws(
    () => originChangeIdentity('nested/deeper/demo/origin.json'),
    /path is invalid/,
  );
});

test('identity validation precedes item reads; stable ID and aliases select exactly one item', () => {
  const f = fixture();
  assert.throws(
    () => f.queries.showWorkItem('/repo', 'bad'),
    /identity or alias is invalid/,
  );
  assert.deepEqual(f.events, ['lock', 'unlock']);
  assert.equal(f.queries.showWorkItem('/repo', 'ISS-1').id, item().id);
  f.items([item(), item('2', { aliases: ['ISS-1'] })]);
  assert.throws(() => f.queries.showWorkItem('/repo', 'ISS-1'), /exactly one/);
});

test('search includes exact Source wording and caches a shared citation only within one search', () => {
  const f = fixture();
  f.items([item(), item('2')]);
  assert.equal(f.queries.searchWorkItems('/repo', '原話').length, 2);
  assert.equal(
    f.events.filter((event) => event === `source:${source.id}`).length,
    1,
  );
  assert.equal(
    f.queries.findWorkItemsByExactSourceText('/repo', source.text).length,
    2,
  );
  assert.equal(
    f.queries.findWorkItemsByExactSourceText('/repo', source.text.trim())
      .length,
    0,
  );
});

test('Source trace is available without consumer config and rejects present invalid config', () => {
  const f = fixture();
  f.config('absent');
  const trace = f.queries.traceGovernanceSource('/repo', source.id);
  assert.equal(trace.source.text, source.text);
  assert.deepEqual(trace.workItems, []);
  assert.ok(!f.events.includes('items-unlocked'));
  assert.ok(
    f.events.indexOf('canonical-root') < f.events.indexOf('config-presence'),
  );
  f.config('invalid');
  assert.throws(
    () => f.queries.traceGovernanceSource('/repo', source.id),
    /invalid consumer config/,
  );
});

test('composite reads hold the lock across the item snapshot hook and later origin observation', () => {
  const f = fixture();
  f.items([item('1', { changeRefs: ['demo'] })]);
  f.origins.set('demo', {
    schemaVersion: 1,
    sourceRefs: [source.id],
    workItemRefs: [item().id],
  });
  const result = f.queries.validateWorkRegistry('/repo', {
    afterItemSnapshot() {
      f.events.push('hook');
    },
  });
  assert.deepEqual(result, { itemCount: 1, sourceCount: 1 });
  assert.ok(f.events.indexOf('items-unlocked') < f.events.indexOf('hook'));
  assert.ok(f.events.indexOf('hook') < f.events.indexOf('origins'));
  assert.equal(f.events.at(-1), 'unlock');
  f.events.length = 0;
  assert.throws(
    () =>
      f.queries.traceWorkItem('/repo', item().id, {
        afterItemSnapshot() {
          f.events.push('hook');
          f.config('invalid');
        },
      }),
    /invalid consumer config/,
  );
  assert.equal(f.events.at(-1), 'unlock');
});

test('bidirectional origin validation re-reads the linked origin rather than accepting a cached inventory', () => {
  const f = fixture();
  f.items([item('1', { changeRefs: ['demo'] })]);
  f.origins.set('demo', {
    schemaVersion: 1,
    sourceRefs: [source.id],
    workItemRefs: [],
  });
  assert.throws(
    () => f.queries.validateWorkRegistry('/repo'),
    /Work Item and change origin links differ/,
  );
  assert.ok(f.events.includes('origin-identity:demo'));
});

test('recommendations and inventory retain stage/lane meaning and read-only lock choice', () => {
  const f = fixture();
  f.items([
    item('2', { lane: 'now', blockedBy: [item().id] }),
    item('1', { stage: 'inbox', lane: null }),
  ]);
  const priorities = f.queries.recommendWorkItemPriorities('/repo');
  assert.equal(priorities[0]!.suggestedLane, null);
  assert.equal(priorities[1]!.suggestedLane, 'later');
  f.events.length = 0;
  const inventory = f.queries.inspectWorkRegistry('/repo');
  assert.equal(inventory.stages.inbox, 1);
  assert.deepEqual(inventory.blockedItemIds, [item('2').id]);
  assert.equal(f.events[0], 'read-lock');
  assert.equal(f.events.at(-1), 'read-unlock');
});

test('projection uses exact Source lines and repeated validated query/layout observations without status writes', () => {
  const f = fixture();
  assert.ok(
    f.projections
      .inspectWorkRegistryProjectionStatus('/repo')
      .every((row) => row.state === 'missing'),
  );
  assert.equal(
    f.events.some((event) => event.startsWith('write:')),
    false,
  );
  f.events.length = 0;
  const rendered = f.projections.renderWorkRegistry('/repo');
  const backlog = f.files.get(rendered.backlogPath)!;
  assert.ok(backlog.includes('>   Exact 原話.\r\n>\n> Trailing spaces.  \n>'));
  assert.ok(f.events.filter((event) => event === 'sources').length >= 2);
  assert.ok(f.events.some((event) => event.startsWith('resolve:')));
  assert.equal(f.events.at(-1), 'unlock');
  f.events.length = 0;
  assert.ok(
    f.projections
      .inspectWorkRegistryProjectionStatus('/repo')
      .every((row) => row.state === 'current'),
  );
  assert.equal(
    f.events.some((event) => event.startsWith('write:')),
    false,
  );
});

test('projection retains shared pre-write CAS and refuses stale or unsafe history', () => {
  const f = fixture();
  f.onRead((target, count) => {
    if (target.endsWith('/BACKLOG.md') && count === 2)
      f.files.set(target, 'Concurrent edit.');
  });
  assert.throws(() => f.projections.renderWorkRegistry('/repo'));
  assert.equal(
    f.events.some((event) => event.startsWith('write:')),
    false,
  );
  const g = fixture();
  g.history('unsafe');
  assert.throws(
    () => g.projections.inspectWorkRegistryProjectionStatus('/repo'),
    /history root is unsafe/,
  );
  const h = fixture();
  h.projections.renderWorkRegistry('/repo');
  h.history('directory', ['/repo/docs/work-history/2025.md']);
  assert.ok(
    h.projections
      .inspectWorkRegistryProjectionStatus('/repo')
      .some((row) => row.state === 'unexpected'),
  );
  assert.throws(
    () => h.projections.validateWorkRegistryProjections('/repo'),
    /history projection is stale/,
  );
});
