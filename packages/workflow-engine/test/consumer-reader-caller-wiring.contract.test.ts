import { productionChangeRoutingInspector } from '../src/composition-root/change-routing-observation-production.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { readModuleReferences } from './support/dependency-graph.ts';

const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url));
const consumers = [
  'adapters/planning/openspec/documents/managed-change-contract.ts',
  'adapters/planning/openspec/documents/planning-contract.ts',
  'adapters/consumer/repository/handoff/handoff.ts',
  'application/execute-task/open-task.ts',
  'application/execute-task/update-base.ts',
  'application/revise/task-revision.ts',
  'application/propose/planning-transition.ts',
];

function calls(file: string, expression: string): number {
  const filename = path.join(sourceRoot, file);
  const source = ts.createSourceFile(
    filename,
    fs.readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let count = 0;
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === expression
    )
      count++;
    ts.forEachChild(node, visit);
  }
  visit(source);
  return count;
}

test('consumer readers are supplied by callers, without a low-level production import in consumers', () => {
  for (const relative of consumers) {
    const filename = path.join(sourceRoot, relative);
    const source = fs.readFileSync(filename, 'utf8');
    for (const reference of readModuleReferences(filename, source)) {
      assert.equal(
        reference.specifier?.endsWith('/work-registry/contracts.ts'),
        false,
        relative,
      );
      assert.equal(
        reference.specifier?.endsWith('/consumer-contract-production.ts'),
        false,
        relative,
      );
      assert.equal(
        reference.specifier?.endsWith('/change-contract-reader.ts'),
        false,
        relative,
      );
    }
  }
});

test('managed validation and open-task preserve their distinct live observation sites', () => {
  assert.equal(calls(consumers[0]!, 'inspectSnapshot'), 2);
  assert.equal(calls(consumers[0]!, 'loadChangeContract'), 1);
  assert.equal(calls(consumers[3]!, 'ports.loadChangeContract'), 1);
  assert.equal(calls(consumers[3]!, 'loadChangeContract'), 3);
  assert.equal(calls(consumers[4]!, 'readers.loadCommittedChangeContract'), 1);
  // 01ecb73 moved this onto the injected ChangeContractServices object, which
  // is the shape the injection-cost criterion asks for.
  assert.equal(
    calls(consumers[4]!, 'changeContract.loadStableValidatedChangeContract'),
    1,
  );
});

// Exercise the live branch independently from managed-document composition.
import {
  renderHandoffFromTrackedFacts,
  validateHandoff,
} from '../src/adapters/consumer/repository/handoff/handoff.ts';
import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import {
  createFixtureRepository,
  writeReadyV3ExemptChange,
} from './fixture.ts';

test('tracked handoff invokes the supplied live reader for every active directory on every render', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    const contract = loadChangeContract(repository, 'demo-change');
    fs.mkdirSync(
      path.join(repository, contract.config.changeRoot, 'other-change'),
    );
    fs.mkdirSync(path.join(repository, contract.config.changeRoot, 'archive'), {
      recursive: true,
    });
    const observations: string[] = [];
    const read = (root: string, changeId: string) => {
      assert.equal(root, repository);
      observations.push(changeId);
      return {
        ...contract,
        changeId,
        tasks: contract.tasks.map((task) => ({ ...task, completed: true })),
      };
    };
    const first = renderHandoffFromTrackedFacts(
      productionChangeRoutingInspector,
      read,
      repository,
    );
    assert.deepEqual([...observations].sort(), ['demo-change', 'other-change']);
    observations.length = 0;
    assert.equal(
      renderHandoffFromTrackedFacts(
        productionChangeRoutingInspector,
        read,
        repository,
      ),
      first,
    );
    assert.deepEqual([...observations].sort(), ['demo-change', 'other-change']);
    validateHandoff(
      productionChangeRoutingInspector,
      () => {
        throw new Error('tracked validation must not use live authority');
      },
      repository,
      {
        contracts: ['demo-change', 'other-change'].map((changeId) => ({
          changeId,
          tasks: contract.tasks.map((task) => ({ ...task, completed: true })),
        })),
        readText: (relativePath) => {
          const file = path.join(repository, relativePath);
          return fs.existsSync(file)
            ? fs.readFileSync(file, 'utf8')
            : undefined;
        },
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
