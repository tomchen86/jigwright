import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  assertPlanningPaths,
  planningSourceObjectPaths,
  type PlanningPathAdmission,
} from '../src/modules/source/planning-paths.ts';
import { readSystemSpecDeltaGroups } from '../src/modules/source/system-spec-deltas.ts';
import type { SystemDescriptionSnapshot } from '../src/modules/source/spec-ownership.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const sourceRef = `SRC-${'a'.repeat(64)}` as const;
const sourcePath = `workflow/source-ledger/objects/sha256/aa/${'a'.repeat(64)}.json`;

test('planning paths and colocated delta grouping have a pure complete type and value closure', () => {
  for (const name of ['planning-paths', 'system-spec-deltas']) {
    assert.ok(
      assertPureDependencyClosure(
        path.resolve(import.meta.dirname, `../src/modules/source/${name}.ts`),
      ).size > 1,
    );
  }
});

test('planning source rules invoke a required alternate provider with exact engine companion paths', () => {
  const observations: Parameters<PlanningPathAdmission>[0][] = [];
  const admit: PlanningPathAdmission = (input) => {
    observations.push(input);
  };
  const changed = ['custom/change/contract.yaml', sourcePath];
  assertPlanningPaths(
    admit,
    'custom',
    'change',
    changed,
    [],
    'schema-one',
    'schema-current',
    [sourceRef],
  );
  assert.deepEqual(observations, [
    {
      changeRoot: 'custom',
      changeId: 'change',
      changedPaths: changed,
      deletedPaths: [],
      schemaName: 'schema-one',
      currentSchemaName: 'schema-current',
      additionalExactPaths: [
        'workflow/change-providers/change.json',
        sourcePath,
      ],
    },
  ]);
  const failure = new Error('provider admission failed');
  assert.throws(
    () =>
      assertPlanningPaths(
        () => {
          throw failure;
        },
        'custom',
        'change',
        changed,
        [],
        'schema-one',
        'schema-current',
      ),
    (error) => error === failure,
  );
});

test('invalid or deleted cited Sources fail before provider admission', () => {
  let calls = 0;
  const admit: PlanningPathAdmission = () => {
    calls += 1;
  };
  assert.deepEqual(planningSourceObjectPaths([sourceRef]), [sourcePath]);
  for (const refs of [[sourceRef, sourceRef], ['SRC-invalid'] as const]) {
    assert.throws(
      () =>
        assertPlanningPaths(
          admit,
          'custom',
          'change',
          [],
          [],
          'current',
          'current',
          refs,
        ),
      {
        code: 'PLANNING_PATHS_INVALID',
        message:
          'Planning Source citations must be identity-valid, canonical, and unique.',
      },
    );
  }
  assert.throws(
    () =>
      assertPlanningPaths(
        admit,
        'custom',
        'change',
        [],
        [sourcePath],
        'current',
        'current',
        [sourceRef],
      ),
    {
      code: 'PLANNING_PATHS_INVALID',
      message: 'Planning cannot delete an immutable cited Source object.',
    },
  );
  assert.equal(calls, 0);
});

function snapshot(
  reads: string[],
  specText:
    | string
    | undefined = 'capabilities: [old-alpha, old-beta]\n\n# Current contract\n',
): SystemDescriptionSnapshot {
  return {
    listPaths() {
      reads.push('list');
      return ['packages/current/spec.md'];
    },
    readText(file) {
      reads.push(`catalog:${file}`);
      return specText;
    },
  };
}

test('alternate delta grammar preserves catalog, sorted capability and per-delta read order', () => {
  const reads: string[] = [];
  const result = readSystemSpecDeltaGroups(
    (file) => {
      reads.push(`capability:${file}`);
      return file === 'a.patch' ? 'old-alpha' : 'old-beta';
    },
    snapshot(reads),
    ['z.patch', 'a.patch'],
    (file) => {
      reads.push(`delta:${file}`);
      return `body:${file}`;
    },
  );
  assert.deepEqual(reads, [
    'list',
    'catalog:packages/current/spec.md',
    'capability:a.patch',
    'delta:a.patch',
    'capability:z.patch',
    'delta:z.patch',
  ]);
  assert.deepEqual(result, [
    {
      capability: 'current',
      baseSpecPath: 'packages/current/spec.md',
      before: 'capabilities: [old-alpha, old-beta]\n\n# Current contract\n',
      deltas: ['body:a.patch', 'body:z.patch'],
    },
  ]);
});

test('empty catalog returns no grouping without consulting provider grammar or delta text', () => {
  const fail = () => {
    throw new Error('must not read');
  };
  assert.equal(
    readSystemSpecDeltaGroups(
      fail,
      { listPaths: () => [], readText: fail },
      ['delta'],
      fail,
    ),
    null,
  );
});

test('an unresolved capability still reads that delta before emitting its original failure', () => {
  const reads: string[] = [];
  assert.throws(
    () =>
      readSystemSpecDeltaGroups(
        (file) => {
          reads.push(`capability:${file}`);
          return undefined;
        },
        snapshot(reads),
        ['a.patch', 'later.patch'],
        (file) => {
          reads.push(`delta:${file}`);
          return 'body';
        },
      ),
    {
      code: 'SYSTEM_SPEC_DELTA_UNRESOLVED',
      message:
        'Resolve a.patch to a colocated spec with a matching capability before archive.',
    },
  );
  assert.deepEqual(reads, [
    'list',
    'catalog:packages/current/spec.md',
    'capability:a.patch',
    'delta:a.patch',
  ]);
});

test('delta observation failure takes precedence over unresolved capability and is retried on the next call', () => {
  const failure = new Error('delta unavailable');
  let reads = 0;
  const read = () => {
    if (++reads === 1) throw failure;
    return undefined;
  };
  const invoke = () =>
    readSystemSpecDeltaGroups(() => undefined, snapshot([]), ['a.patch'], read);
  assert.throws(invoke, (error) => error === failure);
  assert.throws(invoke, { code: 'SYSTEM_SPEC_DELTA_UNRESOLVED' });
  assert.equal(reads, 2);
});
