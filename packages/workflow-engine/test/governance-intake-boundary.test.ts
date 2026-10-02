import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readModuleReferences } from './support/dependency-graph.ts';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
function readClosure(
  entry: string,
  replace: (file: string, source: string) => string = (_file, source) => source,
) {
  const seen = new Set<string>();
  function visit(file: string) {
    assert.ok(
      !/\/(runtime|composition-root|adapters|entrypoints)\//.test(file),
      `Source/Finding policy depends outward: ${file}`,
    );
    assert.ok(
      !file.endsWith('/governance-intake/work-registry.ts'),
      `Intake policy depends on write hub: ${file}`,
    );
    if (seen.has(file)) return;
    seen.add(file);
    const source = replace(file, fs.readFileSync(file, 'utf8'));
    for (const { specifier: fileName } of readModuleReferences(file, source)) {
      assert.notEqual(
        fileName,
        null,
        `Unresolved computed dependency: ${file}`,
      );
      if (fileName === null) throw new Error('Unresolved computed dependency');
      if (fileName.startsWith('node:')) {
        assert.ok(
          ['node:crypto', 'node:path'].includes(fileName),
          `Source/Finding policy imports effect: ${fileName}`,
        );
      } else if (fileName.startsWith('.'))
        visit(path.resolve(path.dirname(file), fileName));
      else {
        assert.ok(
          fileName.startsWith('@jigwright/core/'),
          `Source/Finding policy imports external implementation: ${fileName}`,
        );
        visit(fileURLToPath(import.meta.resolve(fileName)));
      }
    }
  }
  visit(path.join(sourceRoot, entry));
  return seen;
}

test('Source/Finding policy and use cases have an effect-free, type-inclusive dependency closure', () => {
  for (const entry of [
    'modules/governance-intake/governance-intake.ts',
    'modules/governance-intake/governance-findings.ts',
    'modules/governance-intake/governance-finding-ref.ts',
    'modules/governance-intake/source-aliases.ts',
    'application/governance-intake/governance-findings.ts',
    'application/governance-intake/governance-sources.ts',
    'application/governance-intake/governance-intake-workflow.ts',
    'application/governance-intake/current-governance-intake-counts.ts',
  ]) {
    assert.ok(readClosure(entry).size > 1);
  }
  assert.throws(
    () =>
      readClosure(
        'application/governance-intake/governance-findings.ts',
        (file, source) =>
          file.endsWith('/modules/governance-intake/governance-intake.ts')
            ? `${source}\nimport fs from 'node:fs';`
            : source,
      ),
    /imports effect/,
  );
  assert.throws(
    () =>
      readClosure(
        'modules/governance-intake/governance-findings.ts',
        (file, source) =>
          file.endsWith('/modules/governance-intake/governance-findings.ts')
            ? `${source}\nimport type { WorkRegistryReadTestHooks } from '../../composition-root/governance-findings-production.ts';`
            : source,
      ),
    /depends outward/,
  );
});

for (const entry of [
  'application/governance-intake/governance-intake-workflow.ts',
  'application/governance-intake/current-governance-intake-counts.ts',
]) {
  test(`${entry} rejects introduced physical and production dependencies`, () => {
    for (const injected of [
      "import fs from 'node:fs';",
      "import type { GovernanceIntakeWorkflowOptions } from '../../composition-root/governance-intake-production.ts';",
      "export * from '../../runtime/repository-observation/governance-intake-context.ts';",
      "const delayed = () => import('../../runtime/repository-observation/governance-intake-context.ts');",
      'const computed = (name: string) => import(name);',
    ]) {
      assert.throws(
        () =>
          readClosure(entry, (file, source) =>
            file === path.join(sourceRoot, entry)
              ? `${source}\n${injected}`
              : source,
          ),
        /imports effect|depends outward|Unresolved computed dependency/,
      );
    }
  });
}
