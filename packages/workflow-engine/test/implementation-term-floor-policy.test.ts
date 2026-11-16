import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { createImplementationTermFloor } from '../src/application/reconciliation/implementation-term-floor.ts';
import {
  extractImplementationDeltaTerms,
  buildImplementationTermDelta,
  type ImplementationTermScanObservation,
} from '../src/modules/assurance/implementation-term-floor.ts';
const digest = (value: unknown) =>
  crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
const input = {
  repositoryRoot: '/memory',
  baselineCommit: 'a'.repeat(40),
  productionPaths: ['z.ts', 'a.ts'],
  knownTermIds: [] as string[],
};

test('pure hunk extraction preserves origin unions, aliases, known-term subtraction and exact limits', () => {
  const hunks = [
    `@@ -1,2 +1,2 @@ function outerSymbol() {
-import { oldName as localName } from 'old-value';
+import { newName as localName } from 'new-value';
`,
  ];
  const terms = extractImplementationDeltaTerms(hunks, []);
  const local = terms.find((t) => t.value === 'localName')!;
  assert.deepEqual(local.origins, [
    'added-identifier',
    'alias-one-hop',
    'deleted-identifier',
  ]);
  assert.ok(
    terms
      .find((t) => t.value === 'outerSymbol')!
      .origins.includes('modified-outer-symbol'),
  );
  assert.ok(
    terms
      .find((t) => t.value === 'old-value')!
      .origins.includes('deleted-literal'),
  );
  assert.ok(
    terms
      .find((t) => t.value === 'new-value')!
      .origins.includes('added-literal'),
  );
  assert.equal(
    extractImplementationDeltaTerms(
      hunks,
      terms.map((t) => t.termId),
    ).length,
    0,
  );
  assert.equal(
    extractImplementationDeltaTerms(
      [Array.from({ length: 64 }, (_, i) => `+item${i}`).join('\n')],
      [],
    ).length,
    64,
  );
  assert.throws(
    () =>
      extractImplementationDeltaTerms(
        [Array.from({ length: 65 }, (_, i) => `+item${i}`).join('\n')],
        [],
      ),
    (error: any) =>
      error.code === 'IMPLEMENTATION_TERM_ESCALATION_REQUIRED' &&
      error.details.observed === 65 &&
      error.details.limit === 64,
  );
});

test('memory observation sorts hunk reads, preserves production path order for the tree and skips scans for known terms', () => {
  const events: unknown[] = [];
  const terms = extractImplementationDeltaTerms(['+retainedTerm'], []);
  const derive = createImplementationTermFloor({
    readHunk(root, baseline, path) {
      events.push(['diff', root, baseline, path]);
      return '+retainedTerm';
    },
    materializeTree(request) {
      events.push(['tree', [...request.productionPaths]]);
      return 'b'.repeat(40);
    },
    scanTree() {
      throw new Error('known terms must not scan');
    },
  });
  const result = derive({ ...input, knownTermIds: terms.map((t) => t.termId) });
  assert.deepEqual(events, [
    ['diff', '/memory', input.baselineCommit, 'a.ts'],
    ['diff', '/memory', input.baselineCommit, 'z.ts'],
    ['tree', ['z.ts', 'a.ts']],
  ]);
  assert.deepEqual(result.newTerms, []);
  assert.equal(result.scanEvidenceDigest, digest([]));
  assert.ok(Object.isFrozen(result));
});

test('pure delta projects deduplicated group paths and deterministic zero-hit evidence', () => {
  const terms = extractImplementationDeltaTerms(
      ['+visibleTerm deletedTerm'],
      [],
    ),
    visible = terms.find((t) => t.value === 'visibleTerm')!;
  const facts = { tree: 'b'.repeat(40), hits: ['memory'] };
  const scan: ImplementationTermScanObservation = {
    outcome: 'ready',
    facts,
    groups: [
      {
        key: 'group-memory',
        selector: {
          termId: visible.termId,
          rootId: 'repository',
          extension: { rawBase64: 'dHM=', utf8: 'ts' },
          mutationClass: 'live',
        },
        hits: [
          { path: { rawBase64: 'ei50cw==', utf8: 'z.ts' } },
          { path: { rawBase64: '/w==', utf8: null } },
          { path: { rawBase64: 'ei50cw==', utf8: 'z.ts' } },
        ],
      },
    ],
  };
  const delta = buildImplementationTermDelta({
    baselineCommit: input.baselineCommit,
    implementationTree: 'b'.repeat(40),
    knownTermIds: [],
    newTerms: terms,
    scan,
  });
  assert.equal(delta.scanEvidenceDigest, digest(facts));
  const group = delta.affectedGroups.find((g) => g.groupId === 'group-memory')!;
  assert.equal(group.hitCount, 3);
  assert.deepEqual(group.paths, ['base64:/w==', 'z.ts']);
  const zero = delta.affectedGroups.find((g) => g.termId !== visible.termId)!;
  assert.equal(zero.hitCount, 0);
  assert.equal(zero.extension.utf8, '<zero-hit>');
  assert.equal(
    zero.groupId,
    digest({
      schema: 'implementation-zero-hit-group.v1',
      termId: zero.termId,
      tree: 'b'.repeat(40),
    }),
  );
  assert.ok(Object.isFrozen(group.paths));
  assert.ok(Object.isFrozen(delta.newTerms));
});

test('bounded escalation precedes materialization; scan failure keeps its violations after tree observation', () => {
  const events: string[] = [];
  const derive = createImplementationTermFloor({
    readHunk() {
      return Array.from({ length: 65 }, (_, i) => `+item${i}`).join('\n');
    },
    materializeTree() {
      events.push('tree');
      return 'tree';
    },
    scanTree() {
      events.push('scan');
      return { outcome: 'requires-narrowing', violations: ['bounded'] };
    },
  });
  assert.throws(() => derive(input), /more terms/);
  assert.equal(events.length, 0);
  const scanFail = createImplementationTermFloor({
    readHunk() {
      return '+oneTerm';
    },
    materializeTree() {
      events.push('tree');
      return 'tree';
    },
    scanTree() {
      events.push('scan');
      return { outcome: 'requires-narrowing', violations: ['bounded'] };
    },
  });
  assert.throws(
    () => scanFail(input),
    (error: any) =>
      error.code === 'IMPLEMENTATION_TERM_ESCALATION_REQUIRED' &&
      error.details.violations[0] === 'bounded',
  );
  assert.deepEqual(events, ['tree', 'scan']);
});
