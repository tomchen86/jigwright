import { readModuleReferences } from './support/dependency-graph.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
function readClosure(
  entry: string,
  replace: (file: string, source: string) => string = (_file, source) => source,
) {
  const seen = new Set<string>();
  function visit(file: string) {
    assert.ok(
      !/\/(runtime|composition-root|adapters|entrypoints)\//.test(file),
      `Intent and blind-survey DTO policy depends outward: ${file}`,
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
          `Intent and blind-survey DTO policy imports effect: ${fileName}`,
        );
      } else if (fileName.startsWith('.'))
        visit(path.resolve(path.dirname(file), fileName));
      else {
        assert.ok(
          fileName.startsWith('@jigwright/core/'),
          `Intent and blind-survey DTO policy imports external implementation: ${fileName}`,
        );
        visit(fileURLToPath(import.meta.resolve(fileName)));
      }
    }
  }
  visit(path.join(sourceRoot, entry));
  return seen;
}

test('intent and blind-survey DTOs have an effect-free, type-inclusive dependency closure', () => {
  for (const entry of [
    'modules/source/change-intent.ts',
    'modules/investigation/manifest/blind-survey-manifest.ts',
  ]) {
    assert.ok(readClosure(entry).size >= 1);
  }
  assert.throws(
    () =>
      readClosure(
        'modules/investigation/manifest/blind-survey-manifest.ts',
        (file, source) =>
          file.endsWith('/modules/source/change-intent.ts')
            ? `${source}\nimport fs from 'node:fs';`
            : source,
      ),
    /imports effect/,
  );
  assert.throws(
    () =>
      readClosure('modules/source/change-intent.ts', (file, source) =>
        file.endsWith('/modules/source/change-intent.ts')
          ? `${source}\nimport type { CreateProviderInvocationInput } from '../../runtime/storage-journal/provider-invocation-state.ts';`
          : source,
      ),
    /depends outward/,
  );
});

test('invocation DTO owners contain only type declarations and no legacy runtime type facade remains', () => {
  const canonicalTypeOwners = [
    [
      'ProviderInvocationManifest',
      'modules/assurance/provider-invocation-manifest.ts',
    ],
    [
      'CreateProviderInvocationInput',
      'runtime/storage-journal/provider-invocation-state.ts',
    ],
    [
      'ProviderInvocationSupersessionCrashPhase',
      'runtime/storage-journal/provider-invocation-supersession.ts',
    ],
  ] as const;
  for (const entry of [
    'modules/source/change-intent.ts',
    'modules/investigation/manifest/blind-survey-manifest.ts',
    'modules/assurance/provider-review-manifests.ts',
    'modules/provider-orchestration/provider-invocation-reservations.ts',
    'modules/provider-orchestration/provider-execution-policy-snapshot.ts',
    'modules/provider-orchestration/provider-invocation-lifecycle.ts',
  ]) {
    const source = ts.createSourceFile(
      entry,
      fs.readFileSync(path.join(sourceRoot, entry), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      assert.ok(
        ts.isTypeAliasDeclaration(statement) ||
          (ts.isImportDeclaration(statement) &&
            statement.importClause?.isTypeOnly),
        `${entry} contains executable or value-imported content`,
      );
      assert.ok(
        !ts.isTypeAliasDeclaration(statement) ||
          !canonicalTypeOwners.some(([name]) => name === statement.name.text),
        `${entry} duplicates a declaration owned by another module`,
      );
    }
  }
  for (const [name, owner] of canonicalTypeOwners) {
    const source = ts.createSourceFile(
      owner,
      fs.readFileSync(path.join(sourceRoot, owner), 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    const declarations = source.statements.filter(
      (statement) =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
    );
    assert.equal(declarations.length, 1, `${name} has one canonical owner`);
    assert.ok(
      (declarations[0] as ts.TypeAliasDeclaration).modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ),
      `${name} is exported by ${owner}`,
    );
  }
  assert.equal(
    fs.existsSync(
      path.join(
        sourceRoot,
        'modules/provider-orchestration/provider-invocation-manifest.ts',
      ),
    ),
    false,
  );
  assert.equal(
    fs.existsSync(
      path.join(
        sourceRoot,
        'runtime/storage-journal/provider-invocation-types.ts',
      ),
    ),
    false,
  );
});
