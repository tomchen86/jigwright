import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
const pureOwners = [
  'modules/why-knowledge/implementation-reconciliation.ts',
  'modules/assurance/implementation-term-dispositions.ts',
  'application/reconciliation/implementation-reconciliation.ts',
  'application/reconciliation/investigation-reconciliation.ts',
];
function assertReconciliationBoundary(file: string, source: string) {
  for (const { fileName } of ts.preProcessFile(source, true, true)
    .importedFiles) {
    assert.ok(
      !/^(?:node:)?(?:fs(?:\/promises)?|child_process|net|http|https)$/.test(
        fileName,
      ),
      `${file} imports an effect: ${fileName}`,
    );
    if (!fileName.startsWith('.')) continue;
    const target = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), fileName),
    );
    assert.ok(
      !/^(runtime|adapters|composition-root|entrypoints)\//.test(target),
      `${file} imports outward: ${target}`,
    );
    if (file.startsWith('modules/'))
      assert.ok(
        !target.startsWith('application/'),
        `${file} imports an application use case`,
      );
    if (file.startsWith('modules/why-knowledge/'))
      assert.ok(
        !target.startsWith('modules/investigation/'),
        `${file} couples WHY rules to Manifest authority`,
      );
  }
}

test('reconciliation rules and application use cases have no repository/session/root imports or direct effects', () => {
  for (const file of pureOwners)
    assertReconciliationBoundary(
      file,
      fs.readFileSync(path.join(sourceRoot, file), 'utf8'),
    );
  assert.throws(() =>
    assertReconciliationBoundary(pureOwners[0]!, "import fs from 'node:fs';"),
  );
  assert.throws(() =>
    assertReconciliationBoundary(
      pureOwners[2]!,
      "import {x} from '../../composition-root/lifecycle-context.ts';",
    ),
  );
  assert.throws(() =>
    assertReconciliationBoundary(
      pureOwners[0]!,
      "import type {X} from '../investigation/manifest/investigation-manifest.ts';",
    ),
  );
});

test('all four finalization gates require an injected capability with no default production binding', () => {
  let gates = 0;
  for (const [file, owner] of [
    [
      'runtime/finalization/finalization-service.ts',
      'createFinalizationService',
    ],
    ['runtime/finalization/projected-finalization.ts', 'finalizeTaskUnlocked'],
    [
      'application/execute-task/task-strategy-red-revision.ts',
      'createTaskStrategyRedRevisionService',
    ],
  ]) {
    const source = fs.readFileSync(path.join(sourceRoot, file!), 'utf8');
    const ast = ts.createSourceFile(
      file!,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const factory = ast.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === owner,
    );
    assert.ok(factory);
    assert.ok(
      ast.statements.some(
        (node) =>
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.importClause?.isTypeOnly &&
          path.posix.normalize(
            path.posix.join(
              path.posix.dirname(file!),
              node.moduleSpecifier.text,
            ),
          ) === 'modules/why-knowledge/implementation-reconciliation.ts' &&
          node.importClause.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.some(
            (element) =>
              element.name.text === 'ImplementationReconciliationGate',
          ),
      ),
    );
    const injectedGates = factory.parameters.filter(
      (parameter) =>
        ts.isIdentifier(parameter.name) &&
        parameter.name.text === 'assertCurrentImplementationReconciliation',
    );
    assert.equal(injectedGates.length, 1);
    const gate = injectedGates[0];
    assert.ok(
      gate &&
        ts.isIdentifier(gate.name) &&
        gate.name.text === 'assertCurrentImplementationReconciliation',
    );
    assert.equal(gate.initializer, undefined);
    assert.equal(gate.questionToken, undefined);
    function visit(node: ts.Node) {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'assertCurrentImplementationReconciliation'
      )
        gates += 1;
      ts.forEachChild(node, visit);
    }
    visit(factory);
    for (const node of ast.statements) {
      if (
        !ts.isImportDeclaration(node) ||
        !node.importClause?.namedBindings ||
        !ts.isNamedImports(node.importClause.namedBindings)
      )
        continue;
      assert.equal(
        node.importClause.namedBindings.elements.some(
          (element) =>
            (element.propertyName ?? element.name).text ===
            'assertCurrentImplementationReconciliation',
        ),
        false,
      );
    }
  }
  assert.equal(gates, 4);
});

function whyDependencyClosure(
  read: (relativePath: string) => string = (file) =>
    fs.readFileSync(path.join(sourceRoot, file), 'utf8'),
): string[] {
  const seen = new Set<string>();
  function visit(file: string, chain: string[]) {
    assert.ok(
      !file.startsWith('modules/investigation/'),
      `WHY dependency reaches investigation: ${[...chain, file].join(' -> ')}`,
    );
    if (seen.has(file)) return;
    seen.add(file);
    for (const { fileName } of ts.preProcessFile(read(file), true, true)
      .importedFiles) {
      if (!fileName.startsWith('.')) continue;
      visit(
        path.posix.normalize(
          path.posix.join(path.posix.dirname(file), fileName),
        ),
        [...chain, file],
      );
    }
  }
  visit('modules/why-knowledge/implementation-reconciliation.ts', []);
  return [...seen].sort();
}

test('WHY reconciliation type-inclusive dependency closure uses shared source terms, never investigation authority', () => {
  const closure = whyDependencyClosure();
  assert.ok(closure.includes('modules/source/search-term.ts'));
  assert.ok(
    closure.includes('modules/assurance/implementation-term-dispositions.ts'),
  );
  assert.throws(
    () =>
      whyDependencyClosure((file) => {
        const source = fs.readFileSync(path.join(sourceRoot, file), 'utf8');
        return file === 'modules/assurance/implementation-term-dispositions.ts'
          ? `${source}\nimport type { NormalizedInvestigationTerm } from '../investigation/domain/investigation-terms.ts';\n`
          : source;
      }),
    /WHY dependency reaches investigation/,
  );
});
