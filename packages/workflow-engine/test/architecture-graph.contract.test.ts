/** Dependency checks use the current tree, without migration identities or exceptions. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import {
  classifyLayerDependency,
  findDependencyCycles,
  readModuleReferences,
} from './support/dependency-graph.ts';
import {
  dependencyOwner,
  readRepositoryDependencyGraph,
  type DependencyEdge,
} from './support/repository-dependency-graph.ts';
import { repositoryRoot } from './boundary-contract-fixture.ts';

function loadedFileCycles(edges: readonly DependencyEdge[]): string[][] {
  return findDependencyCycles(
    edges.filter(({ typeOnly }) => !typeOnly).map(({ from, to }) => [from, to]),
  );
}

function fixture(t: TestContext, additions: Record<string, string>): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'architecture-graph-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const files = {
    'packages/core/package.json': JSON.stringify({
      name: '@jigwright/core',
      architecture: { role: 'domain-library' },
      type: 'module',
      exports: { './value': './src/value.ts' },
    }),
    'packages/core/src/value.ts': 'export const value = 1;',
    'packages/core/src/private.ts': 'export const internal = 1;',
    'packages/workflow-engine/package.json': JSON.stringify({
      name: 'jigwright',
      type: 'module',
      imports: { '#runtime': './src/runtime/store.ts' },
    }),
    'packages/workflow-engine/tsconfig.json': JSON.stringify({
      compilerOptions: {
        paths: {
          '@runtime/*': ['src/runtime/*'],
          '@jigwright/core/private': ['../core/src/value.ts'],
        },
      },
    }),
    'packages/workflow-engine/src/runtime/store.ts': 'export const store = 1;',
    ...additions,
  };
  for (const [file, text] of Object.entries(files)) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  return directory;
}

test('architecture scanner recognizes static, type, re-export, dynamic and CommonJS dependencies', () => {
  const references = readModuleReferences(
    'example.ts',
    [
      "import type { Policy } from './policy.ts';",
      "export { run } from './runner.ts';",
      "const worker = import('./worker.ts');",
      "const store = require('./store.cjs');",
      "type Result = import('./result.ts').Result;",
      "// import './ignored.ts';",
      'const text = "require(\'./also-ignored.ts\')";',
    ].join('\n'),
  );
  assert.deepEqual(
    references.map(({ specifier }) => specifier),
    ['./policy.ts', './runner.ts', './worker.ts', './store.cjs', './result.ts'],
  );
  assert.deepEqual(
    references.map(({ line }) => line),
    [1, 2, 3, 4, 5],
  );
});

test('architecture scanner retains a type import after a regex containing a backtick', () => {
  const source = "const x = /`/;\nimport type { X } from './target.ts';";
  assert.deepEqual(readModuleReferences('/fixture/source.ts', source), [
    { specifier: './target.ts', line: 2, typeOnly: true },
  ]);
});

test('architecture scanner exposes computed imports instead of silently omitting them', () => {
  assert.deepEqual(
    readModuleReferences('example.ts', 'const value = import(target);').map(
      ({ specifier }) => specifier,
    ),
    [null],
  );
});

test('architecture scanner follows loader aliases and respects lexical shadowing', () => {
  const references = readModuleReferences(
    'example.ts',
    [
      "import { createRequire as createLoader } from 'node:module';",
      'const load = createLoader(import.meta.url);',
      "load('./runtime.ts');",
      'const alias = require;',
      "alias('./legacy.cjs');",
      "module['require']('./another.cjs');",
      "function local(require) { require('./not-an-import.ts'); }",
      "function localModule(module) { module.require('./also-not-an-import.ts'); }",
      'load(target);',
    ].join('\n'),
  );
  assert.deepEqual(
    references.map(({ specifier }) => specifier),
    ['node:module', './runtime.ts', './legacy.cjs', './another.cjs', null],
  );
});

test('architecture scanner distinguishes explicit type dependencies without discarding them', () => {
  const references = readModuleReferences(
    'example.ts',
    [
      "import type { A } from './a.ts';",
      "import { type B } from './b.ts';",
      "export type { C } from './c.ts';",
      "export { type D } from './d.ts';",
      "type E = import('./e.ts').E;",
      "import { type F, run } from './f.ts';",
      "const g = import('./g.ts');",
    ].join('\n'),
  );
  assert.deepEqual(
    references.map(({ typeOnly }) => typeOnly),
    [true, true, true, true, true, false, false],
  );
});

test('architecture rules preserve inward direction and detect missing source ownership', () => {
  const root = 'packages/workflow-engine/src/';
  assert.equal(
    classifyLayerDependency(
      root + 'application/run.ts',
      root + 'modules/lifecycle/state.ts',
    ),
    null,
  );
  assert.equal(
    classifyLayerDependency(
      root + 'application/run.ts',
      root + 'runtime/git.ts',
    ),
    'application-to-runtime',
  );
  assert.equal(
    classifyLayerDependency(
      root + 'modules/lifecycle/state.ts',
      root + 'adapters/store.ts',
    ),
    'module-to-adapters',
  );
  assert.equal(
    classifyLayerDependency(
      root + 'entrypoints/cli/run.ts',
      root + 'modules/lifecycle/state.ts',
    ),
    'entrypoint-bypass-composition-root',
  );
  assert.equal(
    classifyLayerDependency(
      root + 'foundation/helper.ts',
      root + 'modules/source/value.ts',
    ),
    'foundation-outward',
  );
  assert.equal(
    classifyLayerDependency(
      root + 'unknown/helper.ts',
      root + 'foundation/errors.ts',
    ),
    'unclassified-source-layer',
  );
  assert.equal(
    classifyLayerDependency(
      root + 'modules/source/value.ts',
      'packages/workflow-engine/bootstrap/helper.ts',
    ),
    'src-to-bootstrap',
  );
});

test('architecture rules detect cycles within a layer and across module boundaries', () => {
  assert.deepEqual(
    findDependencyCycles([
      ['source', 'why-knowledge'],
      ['why-knowledge', 'source'],
      ['investigation', 'why-knowledge'],
      ['entrypoint', 'composition'],
      ['composition', 'application'],
    ]),
    [['source', 'why-knowledge']],
  );
  assert.deepEqual(
    findDependencyCycles([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
      ['d', 'e'],
      ['e', 'd'],
    ]),
    [
      ['a', 'b', 'c'],
      ['d', 'e'],
    ],
  );
  assert.deepEqual(
    findDependencyCycles([
      ['a', 'b'],
      ['a', 'c'],
      ['b', 'c'],
    ]),
    [],
  );
});

test('architecture scanner resolves public workspace contracts and retains type edges', (t) => {
  const root = fixture(t, {
    'packages/workflow-engine/src/modules/source/consumer.mts':
      "export type { value } from '@jigwright/core/value';",
  });
  const graph = readRepositoryDependencyGraph(root);
  assert.deepEqual(graph.problems, []);
  assert.equal(graph.edges[0].to, 'packages/core/src/value.ts');
  assert.equal(graph.edges[0].typeOnly, true);
});

test('architecture scanner rejects package private aliases and resolves paths and package imports', (t) => {
  const root = fixture(t, {
    'packages/workflow-engine/src/modules/source/consumer.ts': [
      "import { value } from '@jigwright/core/private';",
      "import { store } from '#runtime';",
      "import { store as other } from '@runtime/store.ts';",
      "import { internal } from '../../../../core/src/private.ts';",
    ].join('\n'),
  });
  const graph = readRepositoryDependencyGraph(root);
  assert.equal(
    graph.problems.filter(({ rule }) => rule === 'private-package-import')
      .length,
    2,
  );
  assert.equal(
    graph.problems.filter(({ rule }) => rule === 'module-to-runtime').length,
    2,
  );
  assert.equal(
    graph.problems.filter(
      ({ rule }) => rule === 'unresolved-workspace-dependency',
    ).length,
    0,
  );
});

test('architecture scanner rejects direct domain effects and computed loader dependencies', (t) => {
  const root = fixture(t, {
    'packages/workflow-engine/src/modules/source/consumer.ts': [
      "import fs from 'node:fs';",
      "import { createRequire } from 'node:module';",
      'const load = createRequire(import.meta.url);',
      'load(target);',
    ].join('\n'),
  });
  assert.deepEqual(
    readRepositoryDependencyGraph(root).problems.map(({ rule }) => rule),
    [
      'domain-external-effect',
      'domain-external-effect',
      'unresolved-computed-dependency',
    ],
  );
});

test('architecture scanner reports unresolved configured aliases', (t) => {
  const root = fixture(t, {
    'packages/workflow-engine/src/modules/source/consumer.ts':
      "import '@runtime/missing.ts';",
  });
  assert.deepEqual(
    readRepositoryDependencyGraph(root).problems.map(({ rule }) => rule),
    ['unresolved-workspace-dependency'],
  );
});

test('architecture scanner applies domain rules to resolved package ownership', (t) => {
  const root = fixture(t, {
    'packages/grants/package.json': JSON.stringify({
      name: '@jigwright/grants',
      type: 'module',
      exports: { './public': './src/public.ts' },
    }),
    'packages/grants/src/public.ts': 'export const grant = 1;',
    'packages/workflow-engine/tsconfig.json': JSON.stringify({
      compilerOptions: {
        paths: { '@jigwright/core/value': ['../grants/src/public.ts'] },
      },
    }),
    'packages/workflow-engine/src/modules/authority/consumer.ts':
      "import '../../../../grants/src/public.ts'; import '@jigwright/core/value';",
  });
  const { problems } = readRepositoryDependencyGraph(root);
  assert.equal(
    problems.filter(({ rule }) => rule === 'domain-integration-implementation')
      .length,
    2,
  );
  assert.equal(
    problems.filter(
      ({ rule }) => rule === 'workspace-export-resolution-mismatch',
    ).length,
    1,
  );
});

test('architecture scanner only excludes the actual generated recovery root', (t) => {
  const root = fixture(t, {
    'packages/workflow-engine/bootstrap/recovery-runtime/generated.ts':
      "import 'node:fs';",
    'packages/workflow-engine/src/modules/source/recovery-runtime/a.ts':
      "import 'node:fs';",
  });
  const graph = readRepositoryDependencyGraph(root);
  assert.equal(
    graph.files.some((file) => file.endsWith('/generated.ts')),
    false,
  );
  assert.equal(
    graph.problems.filter(({ rule }) => rule === 'domain-external-effect')
      .length,
    1,
  );
});

test('architecture scanner reports computed dependencies outside the domain and CommonJS import-equals loaders', (t) => {
  const root = fixture(t, {
    'packages/workflow-engine/src/adapters/consumer/a.ts': 'import(target);',
    'packages/workflow-engine/src/modules/source/a.ts':
      "import Module = require('node:module'); const load = Module.createRequire(__filename); load('node:fs');",
  });
  assert.deepEqual(
    readRepositoryDependencyGraph(root).problems.map(({ rule }) => rule),
    [
      'unresolved-computed-dependency',
      'domain-external-effect',
      'domain-external-effect',
    ],
  );
});

test('architecture scanner refuses unsupported source export formats explicitly', (t) => {
  for (const exports of [
    { './value': { types: './src/value.ts', import: './src/private.ts' } },
    { './*': './src/*.ts' },
  ]) {
    const root = fixture(t, {
      'packages/core/package.json': JSON.stringify({
        name: '@jigwright/core',
        architecture: { role: 'domain-library' },
        type: 'module',
        exports,
      }),
    });
    assert.throws(
      () => readRepositoryDependencyGraph(root),
      /Unsupported workspace source export: @jigwright\/core/,
    );
  }
});

test('architecture scanner finds module ownership cycles without a file-loading cycle', (t) => {
  const root = fixture(t, {
    'packages/workflow-engine/src/modules/source/a.ts':
      "import '../projection/a.ts';",
    'packages/workflow-engine/src/modules/source/b.ts': 'export {};',
    'packages/workflow-engine/src/modules/projection/a.ts': 'export {};',
    'packages/workflow-engine/src/modules/projection/b.ts':
      "import '../source/b.ts';",
  });
  const { edges } = readRepositoryDependencyGraph(root);
  assert.deepEqual(
    findDependencyCycles(edges.map(({ from, to }) => [from, to])),
    [],
  );
  assert.deepEqual(
    findDependencyCycles(
      edges.map(({ from, to }) => [dependencyOwner(from), dependencyOwner(to)]),
    ),
    [
      [
        'packages/workflow-engine/src/modules/projection',
        'packages/workflow-engine/src/modules/source',
      ],
    ],
  );
});

test('architecture file-cycle guard detects a same-owner loading cycle separately from erased types', (t) => {
  const root = fixture(t, {
    'packages/workflow-engine/src/runtime/cyclic/first.ts':
      "import { second } from './second.ts'; export const first = () => second;",
    'packages/workflow-engine/src/runtime/cyclic/second.ts':
      "import { first } from './first.ts'; export const second = () => first;",
    'packages/workflow-engine/src/modules/records/left.ts':
      "import type { Right } from './right.ts'; export type Left = { right?: Right };",
    'packages/workflow-engine/src/modules/records/right.ts':
      "import type { Left } from './left.ts'; export type Right = { left?: Left };",
  });
  const { edges } = readRepositoryDependencyGraph(root);
  assert.deepEqual(
    findDependencyCycles(
      edges.map(({ from, to }) => [dependencyOwner(from), dependencyOwner(to)]),
    ),
    [],
  );
  assert.deepEqual(loadedFileCycles(edges), [
    [
      'packages/workflow-engine/src/runtime/cyclic/first.ts',
      'packages/workflow-engine/src/runtime/cyclic/second.ts',
    ],
  ]);
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

test('current repository has no architecture exceptions', () => {
  const { problems } = readRepositoryDependencyGraph(repositoryRoot);
  assert.equal(
    problems.length,
    0,
    `${problems.length} architecture violations:\n` +
      problems
        .slice(0, 30)
        .map(
          ({ from, to, line, rule }) =>
            `${from}:${line} ${rule}${to ? ` → ${to}` : ''}`,
        )
        .join('\n'),
  );
});

test('current repository has no cycles between module owners', () => {
  const { edges } = readRepositoryDependencyGraph(repositoryRoot);
  const cycles = findDependencyCycles(
    edges.map(({ from, to }) => [dependencyOwner(from), dependencyOwner(to)]),
  );
  assert.deepEqual(cycles, []);
});

test('current repository has no file-loading cycles', () => {
  const { edges } = readRepositoryDependencyGraph(repositoryRoot);
  assert.deepEqual(loadedFileCycles(edges), []);
});

test('architecture purity follows value dependencies through foundation and public package exports', (t) => {
  const root = fixture(t, {
    'packages/workflow-engine/src/modules/rules/direct.ts':
      "import { read } from '../../foundation/direct.ts'; export const rule = read;",
    'packages/workflow-engine/src/foundation/direct.ts':
      "import fs from 'node:fs'; export const read = fs.readFileSync;",
    'packages/workflow-engine/src/modules/rules/indirect.ts':
      "export { read } from '../../foundation/indirect.ts';",
    'packages/workflow-engine/src/foundation/indirect.ts':
      "export { read } from '@jigwright/io/read';",
    'packages/io/package.json': JSON.stringify({
      name: '@jigwright/io',
      type: 'module',
      exports: { './read': './src/read.ts' },
    }),
    'packages/io/src/read.ts':
      "import fs from 'node:fs/promises'; export const read = fs.readFile;",
  });
  const { problems } = readRepositoryDependencyGraph(root);
  for (const name of ['direct', 'indirect']) {
    const problem = problems.find(
      ({ from, rule }) =>
        from.endsWith(`/modules/rules/${name}.ts`) &&
        rule === 'pure-transitive-external-effect',
    );
    assert.ok(problem, name);
    assert.deepEqual(
      problem.via,
      name === 'direct'
        ? [
            'packages/workflow-engine/src/modules/rules/direct.ts',
            'packages/workflow-engine/src/foundation/direct.ts',
            'node:fs',
          ]
        : [
            'packages/workflow-engine/src/modules/rules/indirect.ts',
            'packages/workflow-engine/src/foundation/indirect.ts',
            'packages/io/src/read.ts',
            'node:fs/promises',
          ],
    );
  }
  assert.ok(problems.some(({ rule }) => rule === 'foundation-external-effect'));
  assert.ok(
    problems.some(
      ({ rule }) => rule === 'foundation-integration-implementation',
    ),
  );
});

test('architecture purity does not treat an explicit type-only edge as a loaded effect', (t) => {
  const root = fixture(t, {
    'packages/workflow-engine/src/modules/rules/value.ts':
      "import type { Input } from '../../foundation/types.ts'; export const result = (input: Input) => input.count;",
    'packages/workflow-engine/src/foundation/types.ts':
      "import fs from 'node:fs'; export type Input = { count: number }; export const read = fs.readFileSync;",
  });
  const { problems } = readRepositoryDependencyGraph(root);
  assert.deepEqual(
    problems.filter(({ from }) => from.endsWith('/modules/rules/value.ts')),
    [],
  );
  assert.ok(problems.some(({ rule }) => rule === 'foundation-external-effect'));
});
