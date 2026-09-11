/** Package roles impose source obligations; they never hide dependency edges. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { repositoryRoot } from './boundary-contract-fixture.ts';
import { findDependencyCycles } from './support/dependency-graph.ts';
import {
  dependencyOwner,
  readRepositoryDependencyGraph,
} from './support/repository-dependency-graph.ts';

const domain = { role: 'domain-library' };
const consumer = 'packages/workflow-engine/src/modules/example/consumer.ts';
const library = 'packages/geometry/src/public.ts';

function manifest(
  name: string,
  architecture: unknown = domain,
  exports: unknown = { './public': './src/public.ts' },
): string {
  return JSON.stringify({ name, type: 'module', architecture, exports });
}

function write(root: string, files: Record<string, string>): void {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}

function fixture(t: TestContext, files: Record<string, string> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-library-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, {
    'packages/core/package.json': manifest('@jigwright/core'),
    'packages/core/src/public.ts':
      'export type Count = number; export const zero = 0;',
    'packages/geometry/package.json': manifest('@example/geometry'),
    [library]:
      'export type Point = { x: number }; export const origin = { x: 0 };',
    'packages/policy/package.json': manifest('@other/policy'),
    'packages/policy/src/public.ts':
      'export type Rule = boolean; export const allowed = true;',
    'packages/workflow-engine/package.json': manifest(
      'jigwright',
      { role: 'integration' },
      {
        './runtime': './src/runtime/store.ts',
      },
    ),
    'packages/workflow-engine/src/runtime/store.ts':
      'export type Store = {}; export const store = {};',
    'packages/fixture-adapter/package.json': JSON.stringify({
      name: '@example/fixture-adapter',
      type: 'module',
      exports: { './public': './src/public.ts' },
    }),
    'packages/fixture-adapter/src/public.ts':
      'export type Store = {}; export const store = {};',
    ...files,
  });
  return root;
}

function expectRule(root: string, from: string, expected: string): void {
  const { problems } = readRepositoryDependencyGraph(root);
  assert.ok(
    problems.some(
      (problem) => problem.from === from && problem.rule === expected,
    ),
    `Expected ${String(expected)} at ${from}: ${JSON.stringify(problems)}`,
  );
}

test('arbitrary domain libraries expose public type and value contracts without losing edges', (t) => {
  const root = fixture(t, {
    [consumer]:
      "import { origin } from '@example/geometry/public'; export type { Rule } from '@other/policy/public';",
    [library]:
      "import { zero } from '@jigwright/core/public'; import { coordinate } from './private.ts'; export const origin = coordinate(zero);",
    'packages/geometry/src/private.ts':
      "import { createHash } from 'node:crypto'; import 'crypto'; import 'node:path'; import { posix } from 'path'; export const coordinate = (x: number) => ({ x, digest: createHash('sha256').update(posix.normalize('.')).digest('hex') });",
    'packages/policy/src/public.ts':
      "export type { Point as Rule } from '@example/geometry/types';",
    'packages/geometry/package.json': manifest('@example/geometry', domain, {
      './public': './src/public.ts',
      './types': './src/types.ts',
      './retired': null,
    }),
    'packages/geometry/src/types.ts':
      "import type { Count } from '@jigwright/core/public'; export type Point = { x: Count };",
  });
  const graph = readRepositoryDependencyGraph(root);
  assert.deepEqual(graph.problems, []);
  assert.ok(
    graph.edges.some(
      ({ from, to, typeOnly }) =>
        from === consumer && to === 'packages/policy/src/public.ts' && typeOnly,
    ),
  );
  assert.ok(
    graph.edges.some(
      ({ from, to, typeOnly }) =>
        from === library &&
        to === 'packages/geometry/src/private.ts' &&
        !typeOnly,
    ),
  );
  assert.deepEqual(
    findDependencyCycles(graph.edges.map(({ from, to }) => [from, to])),
    [],
  );
});

test('canonical Grants branded public type stays owned by the real verifier source', (t) => {
  const root = fixture(t, {
    [consumer]:
      "export type { VerifiedGrantCapabilityV1 } from '@jigwright/grants/grant-envelope-verifier';",
  });
  for (const name of ['core', 'grants']) {
    const target = path.join(root, 'packages', name);
    fs.rmSync(target, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(
      path.join(repositoryRoot, 'packages', name, 'src'),
      path.join(target, 'src'),
      { recursive: true },
    );
    const value = JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot, 'packages', name, 'package.json'),
        'utf8',
      ),
    );
    value.architecture = domain;
    fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify(value));
  }
  const graph = readRepositoryDependencyGraph(root);
  assert.deepEqual(graph.problems, []);
  assert.ok(
    graph.edges.some(
      ({ from, to, typeOnly }) =>
        from === consumer &&
        to === 'packages/grants/src/grant-envelope-verifier.ts' &&
        typeOnly,
    ),
  );
});

for (const role of [undefined, { role: 'integration' }]) {
  test(`an otherwise pure library with ${role ? 'integration' : 'no'} role remains integration`, (t) => {
    const value = JSON.parse(manifest('@example/geometry'));
    if (role) value.architecture = role;
    else delete value.architecture;
    const root = fixture(t, {
      'packages/geometry/package.json': JSON.stringify(value),
      [consumer]: "import '@example/geometry/public';",
    });
    expectRule(root, consumer, 'domain-integration-implementation');
  });
}

test('an ordinary fixture adapter public export is not a domain contract', (t) => {
  const root = fixture(t, {
    [consumer]: "export type { Store } from '@example/fixture-adapter/public';",
  });
  expectRule(root, consumer, 'domain-integration-implementation');
});

for (const target of ['jigwright/runtime', '@example/fixture-adapter/public']) {
  for (const [kind, content] of Object.entries({
    value: `import { store } from '${target}'; export const value = store;`,
    type: `import type { Store } from '${target}'; export type Value = Store;`,
    reexport: `export { store } from '${target}';`,
    'type reexport': `export type { Store } from '${target}';`,
    'import type expression': `export type Value = import('${target}').Store;`,
  })) {
    test(`domain library rejects ${kind} dependency on ${target}`, (t) => {
      const root = fixture(t, { [library]: content });
      const graph = readRepositoryDependencyGraph(root);
      expectRule(root, library, 'domain-integration-implementation');
      assert.ok(
        graph.edges.some(
          ({ from, specifier }) => from === library && specifier === target,
        ),
      );
    });
  }
}

for (const [kind, content, paths] of [
  [
    'relative runtime',
    "import '../../workflow-engine/src/runtime/store.ts';",
    {},
  ],
  [
    'aliased runtime type',
    "export type { Store } from '@host/store';",
    { '@host/store': ['../workflow-engine/src/runtime/store.ts'] },
  ],
  ['relative fixture', "import '../../fixture-adapter/src/public.ts';", {}],
  [
    'aliased fixture',
    "import '@fixture/store';",
    { '@fixture/store': ['../fixture-adapter/src/public.ts'] },
  ],
] as const) {
  test(`domain library rejects ${kind} by resolved ownership`, (t) => {
    const root = fixture(t, {
      [library]: content,
      'packages/geometry/tsconfig.json': JSON.stringify({
        compilerOptions: { paths },
      }),
    });
    expectRule(root, library, 'domain-integration-implementation');
  });
}

for (const layer of ['application', 'entrypoints', 'adapters']) {
  test(`domain library cannot consume engine ${layer} source`, (t) => {
    const root = fixture(t, {
      [library]: `export type { Input } from '../../workflow-engine/src/${layer}/input.ts';`,
      [`packages/workflow-engine/src/${layer}/input.ts`]:
        'export type Input = string;',
    });
    expectRule(root, library, 'domain-integration-implementation');
  });
}

test('every unconsumed public and private domain source is checked', (t) => {
  const root = fixture(t, {
    'packages/geometry/package.json': manifest('@example/geometry', domain, {
      './public': './src/public.ts',
      './unused': './src/unused.ts',
    }),
    'packages/geometry/src/unused.ts': "import 'node:fs';",
    'packages/geometry/src/private.ts':
      "import type { Store } from 'jigwright/runtime';",
  });
  expectRule(root, 'packages/geometry/src/unused.ts', 'domain-external-effect');
  expectRule(
    root,
    'packages/geometry/src/private.ts',
    'domain-integration-implementation',
  );
});

test('transitive type-only and value closures remain visible with no engine consumer', (t) => {
  const root = fixture(t, {
    [library]:
      "export type { Store } from './types.ts'; export { read } from './values.ts';",
    'packages/geometry/src/types.ts':
      "export type { Store } from 'jigwright/runtime';",
    'packages/geometry/src/values.ts':
      "import fs from 'node:fs'; export const read = fs.readFileSync;",
  });
  const graph = readRepositoryDependencyGraph(root);
  expectRule(
    root,
    'packages/geometry/src/types.ts',
    'domain-integration-implementation',
  );
  expectRule(root, 'packages/geometry/src/values.ts', 'domain-external-effect');
  assert.ok(
    graph.edges.some(
      ({ from, to, typeOnly }) =>
        from === library && to === 'packages/geometry/src/types.ts' && typeOnly,
    ),
  );
  const witness = graph.problems.find(
    ({ from, rule }) =>
      from === library && rule === 'pure-transitive-external-effect',
  );
  assert.deepEqual(witness?.via, [
    library,
    'packages/geometry/src/values.ts',
    'node:fs',
  ]);
});

for (const specifier of [
  'node:module',
  'module',
  'node:process',
  'node:perf_hooks',
  'node:worker_threads',
  'node:buffer',
]) {
  test(`domain library rejects unapproved builtin ${specifier}`, (t) => {
    const root = fixture(t, { [library]: `import '${specifier}';` });
    expectRule(root, library, 'domain-external-effect');
  });
}

for (const [owner, prefix] of [
  [library, 'domain'],
  ['packages/core/src/public.ts', 'domain'],
  ['packages/workflow-engine/src/foundation/value.ts', 'foundation'],
] as const) {
  for (const [kind, content] of Object.entries({
    type: "import type { Result } from 'unreviewed-third-party'; export type Value = Result;",
    value: "import 'unreviewed-third-party';",
    'unknown node name': "import 'node:not_a_real_builtin';",
  })) {
    test(`${owner} rejects unknown external ${kind} dependencies`, (t) => {
      const root = fixture(t, { [owner]: content });
      expectRule(root, owner, `${prefix}-unresolved-external`);
    });
  }
}

for (const [kind, content] of Object.entries({
  import: 'const target = "./private.ts"; import(target);',
  require: 'require(target);',
  'require alias': 'const load = require; load(target);',
  'createRequire alias':
    "import { createRequire as make } from 'node:module'; const load = make(import.meta.url); load(target);",
  'CommonJS namespace':
    "import Module = require('node:module'); const load = Module.createRequire(__filename); load(target);",
})) {
  test(`domain library rejects unresolved computed ${kind}`, (t) => {
    const root = fixture(t, { [library]: content });
    expectRule(root, library, 'unresolved-computed-dependency');
  });
}

test('literal createRequire loading cannot hide an outward value owner', (t) => {
  const root = fixture(t, {
    [library]:
      "import { createRequire } from 'node:module'; const load = createRequire(import.meta.url); load('jigwright/runtime');",
  });
  expectRule(root, library, 'domain-external-effect');
  expectRule(root, library, 'domain-integration-implementation');
});

test('lexically shadowed CommonJS-looking callbacks are not imports', (t) => {
  const root = fixture(t, {
    [library]:
      'export function apply(require: (name: string) => string, target: string) { const load = require; return load(target); } export function local(module: { require: (name: string) => string }, target: string) { return module.require(target); }',
  });
  assert.deepEqual(readRepositoryDependencyGraph(root).problems, []);
});

for (const [label, target, rule] of [
  [
    'own bootstrap',
    '../bootstrap/init.ts',
    'domain-integration-implementation',
  ],
  ['own test helper', '../test/helper.ts', 'unresolved-workspace-dependency'],
] as const) {
  test(`domain library cannot import ${label}`, (t) => {
    const root = fixture(t, {
      [library]: `import '${target}';`,
      [`packages/geometry/${target.slice(3)}`]: 'export {};',
    });
    expectRule(root, library, rule);
  });
}

for (const [label, exports] of Object.entries({
  'missing file': { './public': './src/missing.ts' },
  'directory target': { './public': './src/folder' },
  'another package': { './public': './../policy/src/public.ts' },
  'private runtime target': {
    './public': './../workflow-engine/src/runtime/store.ts',
  },
  'own bootstrap target': { './public': './bootstrap/init.ts' },
  'source traversal': { './public': './src/../../policy/src/public.ts' },
  'conditional export': {
    './public': { import: './src/public.ts', types: './src/public.ts' },
  },
  'wildcard subpath': { './*': './src/public.ts' },
  'wildcard target': { './public': './src/*.ts' },
  'non-source file': { './public': './src/config.json' },
})) {
  test(`domain role rejects unconsumed ${label} export`, (t) => {
    const root = fixture(t, {
      'packages/geometry/package.json': manifest(
        '@example/geometry',
        domain,
        exports,
      ),
      'packages/geometry/src/folder/value.ts': 'export {};',
      'packages/geometry/bootstrap/init.ts': 'export {};',
      'packages/geometry/src/config.json': '{}',
    });
    assert.throws(() => readRepositoryDependencyGraph(root), /export|source/i);
  });
}

for (const exports of [42, true, []]) {
  test(`domain role rejects unsupported top-level exports ${JSON.stringify(exports)}`, (t) => {
    const root = fixture(t, {
      'packages/geometry/package.json': manifest(
        '@example/geometry',
        domain,
        exports,
      ),
    });
    assert.throws(() => readRepositoryDependencyGraph(root), /export/i);
  });
}

for (const kind of ['file', 'directory'] as const) {
  test(`domain public export cannot traverse a symlink ${kind}`, (t) => {
    const root = fixture(t, {
      'packages/geometry/package.json': manifest('@example/geometry', domain, {
        './public': kind === 'file' ? './src/link.ts' : './src/link/public.ts',
      }),
    });
    fs.symlinkSync(
      path.join(
        root,
        'packages/policy/src',
        ...(kind === 'file' ? ['public.ts'] : []),
      ),
      path.join(
        root,
        'packages/geometry/src',
        kind === 'file' ? 'link.ts' : 'link',
      ),
      kind === 'file' ? 'file' : 'dir',
    );
    assert.throws(
      () => readRepositoryDependencyGraph(root),
      /symlink|source|export/i,
    );
  });
}

for (const architecture of [
  { role: 'domain' },
  { role: 1 },
  { role: {} },
  'domain-library',
  null,
]) {
  test(`invalid architecture metadata ${JSON.stringify(architecture)} fails explicitly`, (t) => {
    const root = fixture(t, {
      'packages/geometry/package.json': manifest(
        '@example/geometry',
        architecture,
      ),
    });
    assert.throws(
      () => readRepositoryDependencyGraph(root),
      /architecture|role/i,
    );
  });
}

test('core must explicitly carry the domain-library role', (t) => {
  const value = JSON.parse(manifest('@jigwright/core'));
  delete value.architecture;
  const root = fixture(t, {
    'packages/core/package.json': JSON.stringify(value),
  });
  assert.throws(
    () => readRepositoryDependencyGraph(root),
    /core|domain-library|role/i,
  );
});

test('duplicate workspace names cannot replace the public owner', (t) => {
  const root = fixture(t, {
    'packages/policy/package.json': manifest('@example/geometry'),
  });
  assert.throws(
    () => readRepositoryDependencyGraph(root),
    /duplicate.*(?:package|name)|(?:package|name).*duplicate/i,
  );
});

for (const specifier of [
  '@example/geometry/private',
  '../../../../geometry/src/private.ts',
]) {
  test(`domain role does not legalize private import ${specifier}`, (t) => {
    const root = fixture(t, {
      [consumer]: `import '${specifier}';`,
      'packages/geometry/src/private.ts': 'export {};',
    });
    expectRule(root, consumer, 'private-package-import');
  });
}

test('TS aliases cannot impersonate a declared domain public export', (t) => {
  const root = fixture(t, {
    [consumer]: "import '@example/geometry/public';",
    'packages/workflow-engine/tsconfig.json': JSON.stringify({
      compilerOptions: {
        paths: { '@example/geometry/public': ['src/runtime/store.ts'] },
      },
    }),
  });
  expectRule(root, consumer, 'workspace-export-resolution-mismatch');
  expectRule(root, consumer, 'module-to-runtime');
});

test('a private package spelling stays private even when aliased to a public source', (t) => {
  const root = fixture(t, {
    [consumer]: "import '@example/geometry/private';",
    'packages/workflow-engine/tsconfig.json': JSON.stringify({
      compilerOptions: {
        paths: { '@example/geometry/private': ['../geometry/src/public.ts'] },
      },
    }),
  });
  expectRule(root, consumer, 'private-package-import');
});

for (const [owner, rule] of [
  ['packages/core/src/public.ts', 'core-outward-dependency'],
  [
    'packages/workflow-engine/src/foundation/value.ts',
    'foundation-integration-implementation',
  ],
] as const) {
  for (const name of ['@example/geometry', '@jigwright/grants']) {
    test(`${owner} retains its narrower boundary toward ${name}`, (t) => {
      const root = fixture(t, {
        'packages/geometry/package.json': manifest(name),
        [owner]: `export type { Point } from '${name}/public';`,
      });
      expectRule(root, owner, rule);
    });
  }
}

test('domain role preserves file and owner cycles including type-only edges', (t) => {
  const root = fixture(t, {
    [library]:
      "import type { Rule } from '@other/policy/public'; export type Point = { rule: Rule };",
    'packages/policy/src/public.ts':
      "import type { Point } from '@example/geometry/public'; export type Rule = { point?: Point };",
  });
  const graph = readRepositoryDependencyGraph(root);
  assert.deepEqual(graph.problems, []);
  assert.deepEqual(
    findDependencyCycles(graph.edges.map(({ from, to }) => [from, to])),
    [[library, 'packages/policy/src/public.ts']],
  );
  assert.deepEqual(
    findDependencyCycles(
      graph.edges.map(({ from, to }) => [
        dependencyOwner(from),
        dependencyOwner(to),
      ]),
    ),
    [['packages/geometry/src', 'packages/policy/src']],
  );
});

test('TS aliases cannot replace one clean domain public owner with another', (t) => {
  const root = fixture(t, {
    [consumer]: "import '@example/geometry/public';",
    'packages/workflow-engine/tsconfig.json': JSON.stringify({
      compilerOptions: {
        paths: { '@example/geometry/public': ['../policy/src/public.ts'] },
      },
    }),
  });
  expectRule(root, consumer, 'workspace-export-resolution-mismatch');
});

test('domain owner cycles remain visible without a file loading cycle', (t) => {
  const root = fixture(t, {
    [library]: "export type { Rule } from '@other/policy/public';",
    'packages/geometry/package.json': manifest('@example/geometry', domain, {
      './public': './src/public.ts',
      './types': './src/types.ts',
    }),
    'packages/geometry/src/types.ts': 'export type Point = { x: number };',
    'packages/policy/src/private.ts':
      "export type { Point } from '@example/geometry/types';",
  });
  const graph = readRepositoryDependencyGraph(root);
  assert.deepEqual(graph.problems, []);
  assert.deepEqual(
    findDependencyCycles(graph.edges.map(({ from, to }) => [from, to])),
    [],
  );
  assert.deepEqual(
    findDependencyCycles(
      graph.edges.map(({ from, to }) => [
        dependencyOwner(from),
        dependencyOwner(to),
      ]),
    ),
    [['packages/geometry/src', 'packages/policy/src']],
  );
});

test('a package-root symlink cannot remove unconsumed dirty domain sources from the graph', (t) => {
  const root = fixture(t, {
    'packages/geometry/src/private.ts': "import 'node:fs';",
  });
  assert.ok(
    readRepositoryDependencyGraph(root).problems.some(
      (p) =>
        p.from.endsWith('/geometry/src/private.ts') &&
        p.rule === 'domain-external-effect',
    ),
  );
  fs.renameSync(
    path.join(root, 'packages/geometry'),
    path.join(root, 'linked-geometry'),
  );
  fs.symlinkSync(
    path.join(root, 'linked-geometry'),
    path.join(root, 'packages/geometry'),
    'dir',
  );
  assert.throws(
    () => readRepositoryDependencyGraph(root),
    /Architecture package cannot be a symlink/,
  );
});

test('an integration export cannot make another package private source public', (t) => {
  const root = fixture(t, {
    [consumer]: "import '../../../../geometry/src/private.ts';",
    'packages/geometry/src/private.ts': 'export const hidden = 1;',
    'packages/adapter/package.json': manifest('@example/adapter', {
      role: 'integration',
    }),
    'packages/adapter/src/public.ts': 'export const adapter = 1;',
  });
  assert.ok(
    readRepositoryDependencyGraph(root).problems.some(
      (p) => p.rule === 'private-package-import',
    ),
  );
  write(root, {
    'packages/adapter/package.json': manifest(
      '@example/adapter',
      { role: 'integration' },
      { './public': './../geometry/src/private.ts' },
    ),
  });
  assert.throws(
    () => readRepositoryDependencyGraph(root),
    /Unsupported workspace source export/,
  );
});

for (const target of [
  './src/../src/public.ts',
  './src/./public.ts',
  './src/%2e%2e/src/public.ts',
  './src/node_modules/public.ts',
  './src\\public.ts',
]) {
  test(`source exports reject invalid target grammar even when normalization could hide it: ${target}`, (t) => {
    const root = fixture(t, {
      'packages/geometry/package.json': manifest('@example/geometry', domain, {
        './public': target,
      }),
      [consumer]: "import '@example/geometry/public';",
    });
    assert.throws(
      () => readRepositoryDependencyGraph(root),
      /Unsupported workspace source export/,
    );
  });
}

test('a symlinked packages container cannot hide source ownership', (t) => {
  const root = fixture(t, {
    'packages/geometry/src/private.ts': "import 'node:fs';",
  });
  fs.renameSync(
    path.join(root, 'packages'),
    path.join(root, 'linked-packages'),
  );
  fs.symlinkSync(
    path.join(root, 'linked-packages'),
    path.join(root, 'packages'),
    'dir',
  );
  assert.throws(
    () => readRepositoryDependencyGraph(root),
    /Architecture packages directory cannot be a symlink/,
  );
});
