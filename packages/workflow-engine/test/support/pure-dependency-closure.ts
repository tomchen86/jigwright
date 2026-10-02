import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readModuleDependencies } from './dependency-graph.ts';
import { readRepositoryDependencies } from './repository-dependency-graph.ts';

/** Follow every value and type edge with the permanent guard's ownership policy. */
export function assertPureDependencyClosure(
  entry: string,
  additionalSource = '',
): ReadonlySet<string> {
  const start = fs.realpathSync(entry);
  let root = path.dirname(start);
  while (!fs.existsSync(path.join(root, 'packages'))) {
    const parent = path.dirname(root);
    assert.notEqual(parent, root, `Workspace not found for: ${start}`);
    root = parent;
  }
  const reader = readRepositoryDependencies(root);
  const seen = new Set<string>();
  function visit(file: string) {
    if (seen.has(file)) return;
    seen.add(file);
    const result = reader.read(file, file === start ? additionalSource : '');
    assert.ok(result.pure, `Outward pure dependency: ${file}`);
    for (const problem of result.problems) {
      const label = problem.rule.endsWith('external-effect')
        ? 'Effect import'
        : problem.rule === 'unresolved-computed-dependency'
          ? 'Unresolved computed dependency'
          : problem.rule.endsWith('integration-implementation') ||
              problem.rule.endsWith('unresolved-external')
            ? 'Implementation dependency'
            : 'Outward pure dependency';
      assert.fail(
        `${label}: ${problem.from}:${problem.line} ${problem.rule} → ${problem.to ?? ''}`,
      );
    }
    for (const edge of result.edges) visit(path.join(root, edge.to));
  }
  visit(start);
  return seen;
}

/** Check an application entry with the permanent resolver, then its pure dependencies. */
export function assertPureApplicationDependencyClosure(
  entry: string,
  additionalSource = '',
): ReadonlySet<string> {
  let root = path.dirname(entry);
  while (!fs.existsSync(path.join(root, 'packages'))) {
    const parent = path.dirname(root);
    assert.notEqual(parent, root, `Workspace not found for: ${entry}`);
    root = parent;
  }
  const result = readRepositoryDependencies(root).read(entry, additionalSource);
  assert.deepEqual(result.problems, [], 'Outward pure dependency');
  assert.deepEqual(result.effects, [], 'Effect import');
  const resolved = new Set(result.edges.map(({ specifier }) => specifier));
  for (const { specifier } of readModuleDependencies(
    entry,
    fs.readFileSync(entry, 'utf8') + additionalSource,
  )) {
    assert.notEqual(specifier, null, 'Unresolved computed dependency');
    assert.ok(
      specifier !== null &&
        (resolved.has(specifier) ||
          ['crypto', 'node:crypto', 'path', 'node:path'].includes(specifier)),
      `Implementation dependency: ${specifier}`,
    );
  }
  const closure = new Set([entry]);
  for (const edge of result.edges) {
    for (const file of assertPureDependencyClosure(path.join(root, edge.to)))
      closure.add(file);
  }
  return closure;
}
