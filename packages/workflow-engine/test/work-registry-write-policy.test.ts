import {
  assertPromotionParameters,
  promotionStateBinding,
} from '../src/application/work-registry/work-registry-grant-policy.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '@jigwright/core/canonical-json';
import {
  createGovernanceSourceV1,
  type GovernanceSourceV1,
} from '@jigwright/core/governance-source';
import { createWorkRegistryWriteService } from '../src/application/work-registry/work-registry.ts';
import { createWorkRegistryQueries } from '../src/application/work-registry/work-registry-queries.ts';
import type { WorkRegistryWriteRepository } from '../src/application/work-registry/work-registry-repository.ts';
import type {
  WorkItemV1,
  ChangeOriginV1,
  WorkItemPromotionSurveyV1,
} from '../src/modules/governance-intake/work-registry-contracts.ts';
import type {
  WorkItemRecordChange,
  WorkItemPromotionResult,
} from '../src/modules/governance-intake/work-registry-mutation.ts';
import { workItemDigest } from '../src/modules/governance-intake/work-registry-record.ts';
import { parseWorkRegistryTransitionPolicy } from '../src/modules/governance-intake/work-registry-policy.ts';

const root = '/memory';
const id = 'WORK-01K39R0V000000000000000001';
const now = () => '2026-08-24T03:15:00.000Z';
function memoryRegistry(author: 'maintainer' | 'agent' = 'maintainer') {
  const source = createGovernanceSourceV1({
    semanticAuthor: author,
    capturedBy: 'test',
    capturedAt: now(),
    contextRef: 'direct-human:test/one',
    text: 'Keep the exact original wording.\n',
    supersedes: null,
  });
  const sources = new Map<string, GovernanceSourceV1>([[source.id, source]]);
  const records = new Map<
    string,
    WorkItemV1 | ChangeOriginV1 | WorkItemPromotionSurveyV1
  >();
  const commits: WorkItemRecordChange[] = [];
  const receipts = new Map<string, WorkItemPromotionResult>();
  const directories = new Set([root + '/changes/change-one']);
  let currentHead = 'a'.repeat(40),
    depth = 0;
  const events: string[] = [];
  const items = () =>
    [...records.values()].filter((value): value is WorkItemV1 => 'id' in value);
  const origin = (reference: string) =>
    records.get(reference) as ChangeOriginV1;
  const readSource = (_root: string, id: string) => {
    const value = sources.get(id);
    assert.ok(value, 'Source must exist');
    return value;
  };
  const withRegistry = <T>(_root: string, operation: () => T): T => {
    depth++;
    try {
      return operation();
    } finally {
      depth--;
    }
  };
  const readText = (reference: string) =>
    records.has(reference)
      ? `${canonicalJson(records.get(reference))}\n`
      : null;
  const queries = createWorkRegistryQueries({
    withWorkRegistryPromotionLockWhenAvailable: withRegistry,
    withWorkRegistryPromotionReadLockWhenAvailable: withRegistry,
    readItems: () => items(),
    readItemsUnlocked: () => items(),
    readSource,
    listSources: () => [...sources.values()],
    canonicalRoot: (r) => r,
    hasConsumerConfiguration: () => true,
    listOriginReferences: () =>
      [...records.keys()].filter((p) => p.endsWith('/origin.json')),
    readOrigin: origin,
    originChangeId: (_root, reference) =>
      path.basename(path.dirname(reference)),
    relativeOriginPath: (_root, reference) => path.relative(root, reference),
    readCurrentOrigin: (_root, changeId) =>
      origin(`${root}/changes/${changeId}/origin.json`) ?? null,
  });
  const repository: WorkRegistryWriteRepository = {
    withRegistry,
    withPromotion: (_root, operation) =>
      withRegistry(root, () =>
        operation({
          recover: () => {
            events.push('recover');
          },
          replay: (itemId, changeId) => {
            events.push('replay');
            return receipts.get(itemId + ':' + changeId) ?? null;
          },
          hasReceipt: (itemId, changeId) =>
            receipts.has(itemId + ':' + changeId),
          commit: (change) => {
            assert.ok(
              depth > 0,
              'paired commit requires the registry operation',
            );
            assert.equal(
              readText(change.itemPath),
              change.itemBefore,
              'item CAS binds exact bytes',
            );
            assert.equal(
              readText(change.originPath),
              change.originBefore,
              'origin CAS binds exact bytes',
            );
            commits.push(change);
            records.set(change.itemPath, change.item);
            records.set(change.originPath, change.origin);
            const result = { item: change.item, originPath: change.originPath };
            if (change.sourceUpdate === undefined)
              receipts.set(
                change.item.id + ':' + change.item.changeRefs[0],
                result,
              );
            return result;
          },
        }),
      ),
    layout: () => ({
      adapterId: 'filesystem-work-registry-v1',
      itemRoot: 'items',
      inventoryPath: 'inventory.json',
      backlogPath: 'backlog.md',
      historyRoot: 'history',
      transitionPolicyPath: 'policy.json',
      changeOriginRoot: 'changes',
    }),
    resolvePath: (_root, relative) => path.join(root, relative),
    changeDirectory: (_root, changeId) => {
      const directory = `${root}/changes/${changeId}`;
      assert.ok(directories.has(directory), 'change must exist');
      return directory;
    },
    promotionChangeDirectory: (_root, changeId) =>
      `${root}/changes/${changeId}`,
    observeChangeTarget: (directory) =>
      !directories.has(directory)
        ? { kind: 'absent-change' }
        : {
            kind: 'existing-change',
            directoryMode: 0o755,
            entries: [],
            originDigest: null,
          },
    ensureChangeDirectory: (_root, changeId) => {
      const directory = `${root}/changes/${changeId}`;
      directories.add(directory);
      return directory;
    },
    currentCommit: () => currentHead,
    symbolConsumers: (_root, commit, symbol) => {
      assert.equal(commit, currentHead);
      return symbol === 'Feature' ? ['src/feature.ts'] : [];
    },
    createId: () => id,
    findItem: (_root, itemId) => {
      events.push('find-item');
      const found = [...records].find(
        ([, value]) => 'id' in value && value.id === itemId,
      );
      assert.ok(found);
      return found[0];
    },
    readItem: (reference) => records.get(reference) as WorkItemV1,
    readItemSnapshot: (reference) => ({
      item: records.get(reference) as WorkItemV1,
      serialized: readText(reference)!,
    }),
    createItem: (reference, item) => {
      if (records.has(reference))
        assert.deepEqual(records.get(reference), item);
      records.set(reference, item);
    },
    replaceItem: (reference, item) => {
      records.set(reference, item);
    },
    writeOrigin: (reference, value) => {
      records.set(reference, value);
    },
    writeSurvey: (reference, value) => {
      records.set(reference, value);
    },
    readRecordText: readText,
    readOriginBefore: (reference, allowMissing) => {
      const value = readText(reference);
      if (!allowMissing) assert.notEqual(value, null);
      return value;
    },
  };
  const service = createWorkRegistryWriteService({
    repository,
    queries,
    readSource,
    projections: {
      renderWorkRegistry() {
        throw Error('Archive projection is outside this test.');
      },
    },
  });
  function createReviewed() {
    const created = service.createWorkItem(
      root,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'now',
        title: 'Keep evidence',
        summary: 'Preserve the Source.',
        sourceRefs: [source.id],
      },
      { now },
    );
    const reviewed = service.applyWorkItemReview(
      root,
      id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(created.item),
        summary: 'Approved exact Source.',
      },
      now,
    );
    return reviewed;
  }
  return {
    service,
    source,
    sources,
    records,
    commits,
    events,
    createReviewed,
    queries,
    setHead: (head: string) => {
      currentHead = head;
    },
  };
}

test('registry writes and promotion replay run from memory without filesystem access', (t) => {
  for (const method of [
    'readFileSync',
    'writeFileSync',
    'lstatSync',
    'realpathSync',
    'mkdirSync',
  ] as const)
    t.mock.method(fs, method, () => {
      throw Error('unexpected filesystem access');
    });
  const model = memoryRegistry();
  const reviewed = model.createReviewed();
  assert.throws(
    () =>
      model.service.applyWorkItemReview(
        root,
        id,
        {
          action: 'accept',
          expectedDigest: 'sha256:' + '0'.repeat(64),
          summary: 'Changed',
        },
        now,
      ),
    { code: 'WORK_REGISTRY_STALE' },
  );
  assert.equal(model.commits.length, 0);
  const promoted = model.service.promoteWorkItem(
    root,
    id,
    'change-one',
    now,
    workItemDigest(reviewed),
  );
  assert.equal(promoted.item.stage, 'active');
  assert.equal(model.commits.length, 1);
  assert.deepEqual(model.commits[0]!.origin.sourceRefs, [model.source.id]);
  model.events.length = 0;
  assert.deepEqual(
    model.service.promoteWorkItem(
      root,
      id,
      'change-one',
      now,
      workItemDigest(reviewed),
    ),
    promoted,
  );
  assert.deepEqual(model.events, ['recover', 'replay']);
  assert.equal(
    model.commits.length,
    1,
    'an exact durable replay must not commit again',
  );
});

test('active Source corrections commit their own paired effect and retain exact prestate bytes', () => {
  const model = memoryRegistry();
  const reviewed = model.createReviewed();
  model.service.promoteWorkItem(
    root,
    id,
    'change-one',
    now,
    workItemDigest(reviewed),
  );
  const corrected = createGovernanceSourceV1({
    semanticAuthor: 'maintainer',
    capturedBy: 'test',
    capturedAt: now(),
    contextRef: 'direct-human:test/two',
    text: 'The corrected wording.\n',
    supersedes: model.source.id,
  });
  model.sources.set(corrected.id, corrected);
  const result = model.service.correctWorkItemSource(
    root,
    id,
    model.source.id,
    corrected.id,
  );
  assert.equal(result.updated, true);
  assert.deepEqual(result.item.sourceRefs, [corrected.id]);
  const change = model.commits.at(-1)!;
  assert.equal(change.grantBinding, null);
  assert.equal(change.sourceUpdate?.replaces, model.source.id);
  assert.deepEqual(change.origin.sourceRefs, [corrected.id]);
  assert.match(change.itemBefore, new RegExp(model.source.id));
});

test('agent promotion survey binds current commit and exact symbol consumers before promotion', () => {
  const model = memoryRegistry('agent');
  const reviewed = model.createReviewed();
  assert.throws(
    () =>
      model.service.promoteWorkItem(
        root,
        id,
        'change-one',
        now,
        workItemDigest(reviewed),
      ),
    { code: 'WORK_REGISTRY_SURVEY_REQUIRED' },
  );
  assert.equal(model.commits.length, 0);
  const survey = model.service.prepareWorkItemPromotionSurvey(
    root,
    id,
    'change-one',
    { schemaVersion: 1, symbols: ['Feature'], emptyReason: null },
  );
  assert.deepEqual(survey.survey.symbols, [
    { symbol: 'Feature', consumerPaths: ['src/feature.ts'] },
  ]);
  model.setHead('b'.repeat(40));
  assert.throws(
    () =>
      model.service.promoteWorkItem(
        root,
        id,
        'change-one',
        now,
        workItemDigest(reviewed),
      ),
    { code: 'WORK_REGISTRY_SURVEY_REQUIRED' },
  );
  assert.equal(model.commits.length, 0);
});

test('transition policy defaults only on absence and rejects malformed or unsupported policy', () => {
  assert.deepEqual(parseWorkRegistryTransitionPolicy(null), {
    schemaVersion: 1,
    transitions: {
      intake: 'ordinary',
      prioritize: 'ordinary',
      promote: 'ordinary',
    },
  });
  for (const source of [
    '',
    '{}',
    '{"schemaVersion":1,"transitions":{"intake":"ordinary","prioritize":"ordinary","promote":"skip"}}',
  ])
    assert.throws(() => parseWorkRegistryTransitionPolicy(source), {
      code: 'WORK_REGISTRY_INVALID',
    });
});

test('Grant promotion parameters reject dot path segments even with a matching state digest', () => {
  const digest = `sha256:${'a'.repeat(64)}` as const;
  for (const entryPath of [
    'safe/file',
    '.',
    '..',
    '../escape',
    './file',
    'nested/../escape',
    'nested/./file',
  ]) {
    const preparationBinding = {
      schemaVersion: 1,
      sourceRefsDigest: digest,
      changeTarget: {
        kind: 'existing-change',
        directoryMode: 0o755,
        entries: [{ kind: 'directory', path: entryPath, mode: 0o755 }],
        originDigest: null,
      },
      surveyPreparation: {
        kind: 'not-required',
        binding: {
          schemaVersion: 1,
          kind: 'not-required',
          reason: 'pure-maintainer-sources',
          sourceRefsDigest: digest,
        },
      },
    } as const;
    const input = {
      schemaVersion: 1,
      workItemId: id,
      changeId: 'sample',
      expectedDigest: digest,
      preparationBinding,
      stateBindingDigest: promotionStateBinding(digest, preparationBinding)
        .digest,
    };
    if (entryPath === 'safe/file')
      assert.doesNotThrow(() => assertPromotionParameters(input));
    else
      assert.throws(
        () => assertPromotionParameters(input),
        { code: 'WORK_REGISTRY_GRANT_PARAMETERS_INVALID' },
        entryPath,
      );
  }
});
