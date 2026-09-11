import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
