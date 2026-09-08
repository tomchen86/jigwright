/** Frozen module map, exact dependency identities, import direction, and migration topology contracts. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  moduleMap,
  EXPECTED_MAP_ROWS,
  moduleMapSource,
  EXPECTED_FROZEN_MAP_DIGEST,
  baseline,
  EXPECTED_FROZEN_EDGE_COUNT,
  EXPECTED_FROZEN_IDENTITY_DIGEST,
  EXPECTED_ACTIVE_EDGE_COUNT,
  parseFrozenModuleMap,
  parseModuleMap,
  classifyLogicalEdge,
  SRC_PREFIX,
  cloneBaseline,
  compareBaselineEdges,
  assertBaselineShape,
  observedEdge,
  compareObservedEdges,
  assertObservedMatchesBaseline,
  readRepositorySnapshot,
  scanViolations,
  withGreenOrganizedSource,
  mappedRelativeSpecifier,
  buildMigratedSnapshot,
} from './module-dependency-fixture.ts';
import { digestText, repositoryRoot } from './boundary-contract-fixture.ts';

test('module map and exact dependency baseline are frozen', () => {
  assert.equal(moduleMap.length, EXPECTED_MAP_ROWS);
  assert.equal(digestText(moduleMapSource), EXPECTED_FROZEN_MAP_DIGEST);
  assert.equal(baseline.edges.length, EXPECTED_FROZEN_EDGE_COUNT);
  assert.equal(baseline.frozenIdentityDigest, EXPECTED_FROZEN_IDENTITY_DIGEST);
  assert.equal(
    baseline.edges.filter((edge) => edge.status === 'active').length,
    EXPECTED_ACTIVE_EDGE_COUNT,
  );
});

test('module map target and disposition mutations fail closed', () => {
  const targetMutation = moduleMapSource.replace(
    'foundation/canonical-json/canonical-json.ts',
    'foundation/canonical-json/canonical-json-renamed.ts',
  );
  assert.notEqual(targetMutation, moduleMapSource);
  assert.throws(
    () => parseFrozenModuleMap(targetMutation),
    /module map identity digest/i,
  );

  const allowedDispositionMutation = moduleMapSource.replace(
    '\tMOVE\n',
    '\tMOVE_PRIMARY_OWNER_MIXED\n',
  );
  assert.notEqual(allowedDispositionMutation, moduleMapSource);
  assert.throws(
    () => parseFrozenModuleMap(allowedDispositionMutation),
    /module map identity digest/i,
  );

  const unknownDispositionMutation = moduleMapSource.replace(
    '\tMOVE\n',
    '\tMOVE_UNKNOWN\n',
  );
  assert.notEqual(unknownDispositionMutation, moduleMapSource);
  assert.throws(
    () => parseModuleMap(unknownDispositionMutation),
    /unknown module map disposition/i,
  );
});

test('direction classifier accepts inward edges and rejects every protected reverse form', () => {
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}composition-root/root.ts`,
      `${SRC_PREFIX}application/propose/use-case.ts`,
    ),
    null,
  );
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}modules/investigation/domain/query.ts`,
      `${SRC_PREFIX}modules/why-knowledge/answer.ts`,
    ),
    null,
  );
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}modules/investigation/domain/query.ts`,
      `${SRC_PREFIX}runtime/storage-journal/store.ts`,
    ),
    'module-to-runtime',
  );
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}modules/why-knowledge/answer.ts`,
      `${SRC_PREFIX}modules/investigation/domain/query.ts`,
    ),
    'why-to-investigation',
  );
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}adapters/consumer/repository/reader.ts`,
      `${SRC_PREFIX}adapters/planning/openspec/writer.ts`,
    ),
    'cross-adapter',
  );
  assert.equal(
    classifyLogicalEdge(
      `${SRC_PREFIX}entrypoints/cli/run.ts`,
      `${SRC_PREFIX}modules/lifecycle/state.ts`,
    ),
    'entrypoint-bypass-composition-root',
  );
});

test('baseline rejects growth, replacement, duplicate identities, and wildcard paths', () => {
  const duplicate = cloneBaseline(baseline);
  duplicate.edges.push(structuredClone(duplicate.edges[0]!));
  duplicate.edges.sort(compareBaselineEdges);
  assert.throws(
    () => assertBaselineShape(duplicate),
    /duplicate baseline edge/i,
  );

  const growth = cloneBaseline(baseline);
  const reasonId = growth.edges[0]!.reasonId;
  const reason = growth.reasonCatalog[reasonId]!;
  growth.edges.push({
    from: `${SRC_PREFIX}modules/source/new-importer.ts`,
    to: `${SRC_PREFIX}runtime/storage-journal/new-target.ts`,
    rule: 'module-to-runtime',
    reasonId,
    retirementPhase: reason.retirementPhase,
    status: 'active',
  });
  growth.edges.sort(compareBaselineEdges);
  assert.throws(() => assertBaselineShape(growth), /frozen edge count/i);

  const replacement = cloneBaseline(baseline);
  replacement.edges[0]!.to = `${SRC_PREFIX}runtime/storage-journal/replacement.ts`;
  replacement.edges.sort(compareBaselineEdges);
  assert.throws(
    () => assertBaselineShape(replacement),
    /frozen identity digest/i,
  );

  const wildcard = cloneBaseline(baseline);
  wildcard.edges[0]!.from = `${SRC_PREFIX}modules/**/*.ts`;
  assert.throws(() => assertBaselineShape(wildcard), /exact TypeScript path/i);
});

test('matching rejects unlisted, stale, and retired-reappearing violations', () => {
  const observed = baseline.edges
    .filter((edge) => edge.status === 'active')
    .map(observedEdge);

  const unlisted = [
    ...observed,
    {
      from: `${SRC_PREFIX}modules/source/new-importer.ts`,
      to: `${SRC_PREFIX}runtime/storage-journal/new-target.ts`,
      rule: 'module-to-runtime',
    },
  ].sort(compareObservedEdges);
  assert.throws(
    () => assertObservedMatchesBaseline(unlisted, baseline),
    /unlisted dependency violation/i,
  );

  assert.throws(
    () => assertObservedMatchesBaseline(observed.slice(1), baseline),
    /stale active baseline edge/i,
  );

  const retired = cloneBaseline(baseline);
  const newlyRetired = retired.edges.find((edge) => edge.status === 'active');
  assert.ok(newlyRetired);
  newlyRetired.status = 'retired';
  assertBaselineShape(retired);
  assert.throws(
    () => assertObservedMatchesBaseline(observed, retired),
    /retired baseline edge reappeared/i,
  );
});

test('current repository matches the exact active dependency baseline', () => {
  const current = readRepositorySnapshot(repositoryRoot);
  const violations = scanViolations(current, moduleMap, {
    requireFinal: false,
  });
  assert.equal(violations.length, EXPECTED_ACTIVE_EDGE_COUNT);
  assertObservedMatchesBaseline(violations, baseline);
});

test('application and runtime immutable reads do not invert into CI entrypoints', () => {
  for (const file of [
    'packages/workflow-engine/src/application/execute-task/open-task.ts',
    'packages/workflow-engine/src/application/finalize/lifecycle.ts',
    'packages/workflow-engine/src/runtime/repository-transaction/archive-delta-verifier.ts',
  ]) {
    const source = fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
    assert.match(source, /\breadFileAtCommit\b/u, file);
    assert.doesNotMatch(source, /entrypoints\/ci\/ci-git\.ts/u, file);
  }
});

test('a new file under a recognized organized root is scanned with self identity', () => {
  const current = withGreenOrganizedSource(
    readRepositorySnapshot(repositoryRoot),
  );
  const violations = scanViolations(current, moduleMap, {
    requireFinal: false,
  });
  assert.equal(violations.length, EXPECTED_ACTIVE_EDGE_COUNT);
  assertObservedMatchesBaseline(violations, baseline);
});

test('new flat sources and unknown organized roots fail topology validation', () => {
  const current = readRepositorySnapshot(repositoryRoot);

  const flat = new Map(current);
  flat.set(`${SRC_PREFIX}new-unmapped-flat.ts`, 'export const value = true;\n');
  assert.throws(
    () => scanViolations(flat, moduleMap, { requireFinal: false }),
    /unknown flat top-level source/i,
  );

  const unknownRoot = new Map(current);
  unknownRoot.set(
    `${SRC_PREFIX}unrecognized-root/new-source.ts`,
    'export const value = true;\n',
  );
  assert.throws(
    () => scanViolations(unknownRoot, moduleMap, { requireFinal: false }),
    /unknown organized source root/i,
  );
});

test('a forbidden edge from a new organized file is unlisted and fails closed', () => {
  const current = new Map(readRepositorySnapshot(repositoryRoot));
  const forbiddenSource = `${SRC_PREFIX}modules/source/generated-forbidden-edge.ts`;
  const sessionStoreSpecifier = mappedRelativeSpecifier(
    current,
    forbiddenSource,
    `${SRC_PREFIX}session-store.ts`,
  );
  current.set(
    forbiddenSource,
    [
      `import { runtimePaths } from "${sessionStoreSpecifier}";`,
      'export { runtimePaths };',
      '',
    ].join('\n'),
  );
  const violations = scanViolations(current, moduleMap, {
    requireFinal: false,
  });
  assert.equal(violations.length, EXPECTED_ACTIVE_EDGE_COUNT + 1);
  assert.throws(
    () => assertObservedMatchesBaseline(violations, baseline),
    /unlisted dependency violation.*generated-forbidden-edge.*module-to-runtime/i,
  );
});

test('partial migration canonicalizes old and new physical paths to the same graph', () => {
  const current = withGreenOrganizedSource(
    readRepositorySnapshot(repositoryRoot),
  );
  const expected = scanViolations(current, moduleMap, { requireFinal: false });
  const partial = buildMigratedSnapshot(
    current,
    moduleMap,
    (row, index) => row.source !== row.target && index % 2 === 0,
  );
  const observed = scanViolations(partial, moduleMap, { requireFinal: false });
  assert.deepEqual(observed, expected);
  assertObservedMatchesBaseline(observed, baseline);
});

test('fully moved snapshot preserves the canonical graph and exact baseline', () => {
  const current = withGreenOrganizedSource(
    readRepositorySnapshot(repositoryRoot),
  );
  const expected = scanViolations(current, moduleMap, { requireFinal: false });
  const moved = buildMigratedSnapshot(
    current,
    moduleMap,
    (row) => row.source !== row.target,
  );
  const observed = scanViolations(moved, moduleMap, { requireFinal: true });
  assert.deepEqual(observed, expected);
  assertObservedMatchesBaseline(observed, baseline);
});
