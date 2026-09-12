import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { createFinalizationService } from '../src/application/finalize/lifecycle.ts';
import { finalizeTaskUnlocked } from '../src/application/finalize/projected-finalization.ts';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';

type WithoutLast<T extends unknown[]> = T extends [...infer Prefix, unknown]
  ? Prefix
  : never;
type ProjectedParameters = Parameters<typeof finalizeTaskUnlocked>;
type WithoutDocuments<T extends unknown[]> = T extends [
  infer A,
  infer B,
  infer C,
  infer D,
  infer E,
  unknown,
  ...infer Rest,
]
  ? [A, B, C, D, E, ...Rest]
  : never;
function documentsRemainRequired(
  factoryPrefix: WithoutLast<Parameters<typeof createFinalizationService>>,
  projectedWithoutDocuments: WithoutDocuments<ProjectedParameters>,
) {
  // @ts-expect-error Finalization requires its document capability, without a production fallback.
  createFinalizationService(...factoryPrefix);
  // @ts-expect-error Projected finalization requires the same document capability.
  finalizeTaskUnlocked(...projectedWithoutDocuments);
}
void documentsRemainRequired;

const root = path.resolve(import.meta.dirname, '../../..');
const prefix = 'packages/workflow-engine/src/';
const consumers = [
  ['application/finalize/lifecycle.ts', 'createFinalizationService'],
  ['application/finalize/projected-finalization.ts', 'finalizeTaskUnlocked'],
] as const;

test('both finalization boundaries require the canonical document capability without a default production binding', () => {
  for (const [file, name] of consumers) {
    const text = fs.readFileSync(path.join(root, prefix, file), 'utf8');
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const factory = ast.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.ok(factory);
    const parameter = factory.parameters.find(
      (p) =>
        ts.isIdentifier(p.name) && p.name.text === 'systemDocumentDispositions',
    );
    assert.ok(parameter);
    assert.equal(parameter.questionToken, undefined);
    assert.equal(parameter.initializer, undefined);
    assert.ok(parameter.type && ts.isTypeReferenceNode(parameter.type));
    assert.equal(parameter.type.typeName.getText(ast), 'Pick');
    assert.equal(
      parameter.type.typeArguments?.[0]?.getText(ast),
      'SystemDocumentDispositionService',
    );
    assert.equal(
      parameter.type.typeArguments?.[1]?.getText(ast),
      "'assertSystemDocumentDispositions'",
    );
    const imported = ast.statements.filter(ts.isImportDeclaration);
    assert.ok(
      imported.some(
        (node) =>
          node.importClause?.isTypeOnly &&
          node.moduleSpecifier.getText(ast) ===
            "'./system-document-dispositions.ts'",
      ),
    );
    assert.equal(
      imported.some(
        (node) =>
          node.importClause?.namedBindings &&
          ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.some(
            (e) =>
              (e.propertyName ?? e.name).text === 'systemDocumentDispositions',
          ),
      ),
      false,
    );
  }
});

test('document production wiring has one owner and value or type imports back into consumers are rejected', () => {
  const resolver = readRepositoryDependencies(root);
  const production =
    prefix + 'composition-root/system-document-disposition-production.ts';
  const context = prefix + 'composition-root/lifecycle-context.ts';
  for (const [file] of consumers) {
    const check = (extra = '') => {
      const { edges } = resolver.read(path.join(root, prefix, file), extra);
      assert.equal(
        edges.some((edge) => edge.to === production),
        false,
        file,
      );
    };
    check();
    for (const declaration of [
      "import { systemDocumentDispositions } from '../../composition-root/system-document-disposition-production.ts';",
      "import type { systemDocumentDispositions } from '../../composition-root/system-document-disposition-production.ts';",
    ])
      assert.throws(() => check('\n' + declaration), assert.AssertionError);
  }
  const contextSource = ts.createSourceFile(
    context,
    fs.readFileSync(path.join(root, context), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of contextSource.statements) {
    if (ts.isVariableStatement(statement))
      assert.equal(
        statement.declarationList.declarations.some(
          (d) =>
            ts.isIdentifier(d.name) &&
            d.name.text === 'systemDocumentDispositions',
        ),
        false,
      );
  }
  const checkContext = (extra = '') => {
    const { edges } = resolver.read(path.join(root, context), extra);
    assert.equal(
      edges.some((edge) => edge.to === production),
      false,
    );
  };
  checkContext();
  for (const declaration of [
    "export { systemDocumentDispositions } from './system-document-disposition-production.ts';",
    "export * from './system-document-disposition-production.ts';",
  ])
    assert.throws(
      () => checkContext('\n' + declaration),
      assert.AssertionError,
    );
  for (const caller of [
    'composition-root/finalization-production.ts',
    'composition-root/grant-production.ts',
    'entrypoints/cli/workflow-cli.ts',
  ]) {
    const { edges } = resolver.read(path.join(root, prefix, caller));
    assert.equal(
      edges.filter((edge) => edge.to === production && edge.loadsModule).length,
      1,
      caller,
    );
  }
});
