import { productionChangeRoutingInspector } from '../src/composition-root/change-routing-observation-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const renderHandoff = renderHandoffWithContractReader.bind(
  undefined,
  productionChangeRoutingInspector,
  productionChangeContractReader,
);
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveWorkspaceSourceExports } from '../bootstrap/workspace-source-closure.ts';
import { readModuleDependencies } from './support/dependency-graph.ts';
import { readRepositoryDependencyGraph } from './support/repository-dependency-graph.ts';
import { renderBuiltInEngineClosure } from '../bootstrap/generate-built-in-engine-closure.ts';
import { resolveCheckRunner } from '../src/adapters/consumer/repository/work-registry/runner-resolution.ts';
import { renderHandoff as renderHandoffWithContractReader } from '../src/adapters/consumer/repository/handoff/handoff.ts';
import {
  createFixtureRepository,
  git,
  writeReadyV3ExemptChange,
} from './fixture.ts';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory()
      ? sourceFiles(absolute)
      : entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)
        ? [absolute]
        : [];
  });
}

function assertTypeOnlyCoreSource(source: string): void {
  assert.doesNotMatch(
    source,
    /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var|function|class|enum|namespace)\b|^\s*import(?!\s+type\b)|^\s*export\s+(?!type\b)(?:\*|\{)/m,
  );
}

test('core CheckRegistry contract stays type-only and consumer-neutral', () => {
  const coreSource = fs.readFileSync(
    path.join(repositoryRoot, 'packages/core/src/check-registry-port.ts'),
    'utf8',
  );

  assertTypeOnlyCoreSource(coreSource);
  assert.doesNotMatch(
    coreSource,
    /expense-app|openspec|fixture-checks|workflow\/checks\.json|@expense/i,
  );
});

test('repository adapter pins the landed registry DTOs to the public contract', () => {
  const adapterSource = fs.readFileSync(
    path.join(
      repositoryRoot,
      'packages/workflow-engine/src/adapters/consumer/repository/work-registry/check-registry-adapter.ts',
    ),
    'utf8',
  );

  assert.match(
    adapterSource,
    /AssertBidirectionalExact<CheckDefinition, CheckDefinitionV1>/,
  );
  assert.match(
    adapterSource,
    /AssertBidirectionalExact<ChecksConfig, CheckRegistryV1>/,
  );
});

test('fixture adapter depends only on public contracts and shared repository I/O', () => {
  const fixtureSource = sourceFiles(
    path.join(repositoryRoot, 'packages/fixture-adapter/src'),
  )
    .map((file) => fs.readFileSync(file, 'utf8'))
    .join('\n');
  const nonNodeImports = [
    ...new Set(
      [...fixtureSource.matchAll(/from\s+['"]([^'"]+)['"]/g)]
        .map((match) => match[1]!)
        .filter((specifier) => !specifier.startsWith('node:')),
    ),
  ];

  assert.deepEqual(nonNodeImports.sort(), [
    '@jigwright/core/agent-runtime-port',
    '@jigwright/core/canonical-json',
    '@jigwright/core/check-command',
    '@jigwright/core/check-registry-port',
    '@jigwright/core/evidence-node',
    '@jigwright/core/managed-transition-trailers',
    '@jigwright/core/markdown-sections',
    '@jigwright/core/planning-provider-port',
    '@jigwright/core/repository-consumer-port',
    '@jigwright/core/repository-path',
    '@jigwright/core/runtime-path-kernel',
    '@jigwright/core/session-runtime-layout-port',
    '@jigwright/core/tracked-object-reader-port',
    '@jigwright/core/workflow-identifiers',
    '@jigwright/repository-runtime/paths',
  ]);
  assert.match(
    fixtureSource,
    /import\s+\{\s*parseCheckCommand\s*\}\s+from\s+['"]@jigwright\/core\/check-command['"]/,
  );
  assert.match(
    fixtureSource,
    /import\s+type\s+\{[^}]+\}\s+from\s+['"]@jigwright\/core\/check-registry-port['"]/s,
  );
});

test('workflow-engine source never imports the fixture adapter', () => {
  const offenders = sourceFiles(
    path.join(repositoryRoot, 'packages/workflow-engine/src'),
  ).filter((file) =>
    /@jigwright\/fixture-adapter|packages\/fixture-adapter/.test(
      fs.readFileSync(file, 'utf8'),
    ),
  );

  assert.deepEqual(offenders, []);
});

test('workflow-engine value-imports core only through the sealed runtime closure', () => {
  const graph = readRepositoryDependencyGraph(repositoryRoot);
  const closure = renderBuiltInEngineClosure(repositoryRoot).manifest;
  const core = closure.packages.find(({ name }) => name === '@jigwright/core');
  assert.ok(core);
  const sealedPaths = new Set(
    closure.files.map(({ path: filePath }) => filePath),
  );
  assert.ok(sealedPaths.has(path.posix.join(core.closureRoot, 'package.json')));
  const publicExports = new Map(
    resolveWorkspaceSourceExports(repositoryRoot, core).map((entry) => [
      entry.subpath === '.'
        ? core.name
        : `${core.name}/${entry.subpath.slice(2)}`,
      {
        source: path.posix.join(core.sourceRoot, entry.sourcePath),
        sealed: path.posix.join(core.closureRoot, entry.sourcePath),
      },
    ]),
  );
  function assertCoreImports(
    file: string,
    source: string,
    edges = graph.edges,
    sealed = sealedPaths,
  ) {
    for (const reference of readModuleDependencies(file, source)) {
      if (!reference.loadsModule) continue;
      const edge = edges.find(
        (candidate) =>
          candidate.from === file &&
          candidate.line === reference.line &&
          candidate.specifier === reference.specifier,
      );
      const publicSpecifier =
        reference.specifier === core!.name ||
        reference.specifier?.startsWith(`${core!.name}/`);
      if (edge?.to.startsWith(`${core!.sourceRoot}/`)) {
        assert.ok(
          publicSpecifier,
          `${file}: core imports must use public exports`,
        );
      }
      if (!publicSpecifier) continue;
      const declared = publicExports.get(reference.specifier!);
      assert.ok(
        declared,
        `${file}: undeclared core export ${reference.specifier}`,
      );
      assert.equal(
        edge?.to,
        declared.source,
        `${file}: core export resolved elsewhere`,
      );
      assert.ok(
        sealed.has(declared.sealed),
        `${file}: core target is not sealed`,
      );
    }
  }
  for (const file of graph.files.filter((file) =>
    file.startsWith('packages/workflow-engine/src/'),
  )) {
    assertCoreImports(
      file,
      fs.readFileSync(path.join(repositoryRoot, file), 'utf8'),
    );
  }

  const probeFile = 'packages/workflow-engine/src/core-boundary-probe.ts';
  const publicSpecifier = '@jigwright/core/runtime-path-kernel';
  const target = publicExports.get(publicSpecifier)!;
  assert.ok(target);
  const probe = (
    source: string,
    resolved = target.source,
    sealed = sealedPaths,
  ) =>
    assertCoreImports(
      probeFile,
      source,
      readModuleDependencies(probeFile, source)
        .filter((reference) => reference.specifier !== null)
        .map((reference) => ({
          from: probeFile,
          to: resolved,
          specifier: reference.specifier!,
          line: reference.line,
          typeOnly: reference.typeOnly,
          loadsModule: reference.loadsModule,
        })),
      sealed,
    );
  for (const source of [
    "import { value } from '@jigwright/core/private';",
    "import { type Value } from '@jigwright/core/private';",
    "import '@jigwright/core/private';",
    "export { value } from '@jigwright/core/private';",
    "export { type Value } from '@jigwright/core/private';",
    "export * from '@jigwright/core/private';",
    "void import('@jigwright/core/private');",
    "require('@jigwright/core/private');",
  ])
    assert.throws(() => probe(source), /undeclared core export/);
  assert.throws(
    () =>
      probe("import { value } from '../../core/src/runtime-path-kernel.ts';"),
    /must use public exports/,
  );
  const publicSource = `import * as core from '${publicSpecifier}';`;
  assert.throws(
    () => probe(publicSource, 'packages/core/src/private.ts'),
    /resolved elsewhere/,
  );
  assert.throws(
    () => probe(publicSource, target.source, new Set()),
    /not sealed/,
  );
  probe(
    `import type { Value } from '${publicSpecifier}';`,
    target.source,
    new Set(),
  );
  probe(
    `// import '${publicSpecifier}';\nconst text = "import '${publicSpecifier}';";`,
  );

  const closurePaths = [...sealedPaths];
  assert.ok(
    closurePaths.includes('node_modules/@jigwright/core/src/check-command.ts'),
  );
  assert.ok(
    closurePaths.includes(
      'node_modules/@jigwright/core/src/agent-runtime-port.ts',
    ),
  );
  assert.ok(
    closurePaths.includes(
      'node_modules/@jigwright/core/src/contract-values.ts',
    ),
  );
  assert.ok(
    closurePaths.includes('node_modules/@jigwright/core/src/canonical-json.ts'),
  );
  assert.ok(
    closurePaths.includes(
      'node_modules/@jigwright/core/src/job-attempt-runtime.ts',
    ),
  );
  assert.ok(
    closurePaths.includes(
      'node_modules/@jigwright/core/src/repository-path.ts',
    ),
  );
  for (const coreModule of [
    'built-in-provider-catalog',
    'conformance-vectors',
    'evidence-node',
    'governance-source',
    'managed-transition-trailers',
    'markdown-sections',
    'planning-provider-binding',
    'planning-provider-port',
    'runtime-path-kernel',
    'session-runtime-layout-port',
    'workflow-identifiers',
    'workflow-namespace',
  ]) {
    assert.ok(
      closurePaths.includes(
        `node_modules/@jigwright/core/src/${coreModule}.ts`,
      ),
      coreModule,
    );
  }
  assert.ok(
    closurePaths.includes(
      'node_modules/@jigwright/repository-runtime/src/paths.ts',
    ),
  );
});

test('registered OpenSpec asset validation runs the read-only authority without an alternate formatter', () => {
  const registry = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'workflow/checks.json'), 'utf8'),
  );
  const definition = registry.checks['openspec-assets'];
  assert.deepEqual(definition.command, [
    'node',
    'packages/workflow-engine/src/adapters/planning/openspec/documents/openspec-planning-assets.ts',
  ]);
  assert.equal(definition.destructiveDatabase, false);
  const before = spawnSync('git', ['status', '--porcelain=v1'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(before.status, 0, before.stderr);
  const resolved = resolveCheckRunner(
    repositoryRoot,
    'openspec-assets',
    definition,
  );
  const executed = spawnSync(resolved.executable, resolved.args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(executed.status, 0, executed.stderr);
  const result = JSON.parse(executed.stdout);
  assert.equal(result.command, 'openspec-assets');
  assert.equal(result.ok, true);
  assert.equal(result.result.valid, true);
  assert.ok(
    result.result.assetPaths.includes('.codex/skills/workflow-engine/SKILL.md'),
  );
  const after = spawnSync('git', ['status', '--porcelain=v1'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
  });
  assert.equal(after.status, 0, after.stderr);
  assert.equal(after.stdout, before.stdout);
});

test('required-check runners remain pinned across workflow CLI edits', () => {
  const definitions = (
    JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot, 'workflow/checks.json'),
        'utf8',
      ),
    ) as {
      checks: Record<
        string,
        { command: string[]; destructiveDatabase: boolean }
      >;
    }
  ).checks;
  const expectedChecks = {
    'managed-documents': {
      command: 'documents',
      entrypoint:
        'packages/workflow-engine/src/entrypoints/ci/managed-documents.ts',
    },
    'openspec-assets': {
      command: 'openspec-assets',
      entrypoint:
        'packages/workflow-engine/src/adapters/planning/openspec/documents/openspec-planning-assets.ts',
    },
  } as const;
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-check-runner-'),
  );
  const managedRepository = createFixtureRepository();
  try {
    fs.writeFileSync(
      path.join(managedRepository, 'workflow/document-policy.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          enforcementMode: 'enforced',
          documents: {
            'docs/CURRENT_AND_NEXT_STEPS.md': {
              mode: 'generated',
              enforcement: 'active',
              transition: 'completion',
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    writeReadyV3ExemptChange(managedRepository);
    renderHandoff(managedRepository);
    git(managedRepository, ['add', '-A']);
    git(managedRepository, [
      'commit',
      '-m',
      'Prepare the active managed-document runner fixture',
    ]);
    assert.equal(git(managedRepository, ['status', '--porcelain=v1']), '');
    for (const [checkId, expected] of Object.entries(expectedChecks)) {
      const definition = definitions[checkId];
      assert.ok(definition);
      assert.deepEqual(definition.command, ['node', expected.entrypoint]);

      const resolved = resolveCheckRunner(repositoryRoot, checkId, definition);
      const executed = spawnSync(resolved.executable, resolved.args, {
        cwd:
          checkId === 'managed-documents' ? managedRepository : repositoryRoot,
        encoding: 'utf8',
      });
      assert.equal(executed.status, 0, executed.stderr);
      assert.deepEqual(JSON.parse(executed.stdout), {
        command: expected.command,
        ok: true,
        ...(checkId === 'managed-documents'
          ? {
              validated: ['docs/CURRENT_AND_NEXT_STEPS.md'],
            }
          : {
              result: {
                valid: true,
                assetPaths: [
                  '.codex/skills/openspec-explore/SKILL.md',
                  '.codex/skills/openspec-propose/SKILL.md',
                  '.codex/skills/workflow-engine/SKILL.md',
                  '.claude/skills/openspec-explore/SKILL.md',
                  '.claude/skills/openspec-propose/SKILL.md',
                  '.claude/skills/workflow-engine/SKILL.md',
                  '.agents/skills/openspec-explore/SKILL.md',
                  '.agents/skills/openspec-propose/SKILL.md',
                  '.agents/skills/workflow-engine/SKILL.md',
                  'workflow/openspec-assets/prompts/opsx-explore.md',
                  'workflow/openspec-assets/prompts/opsx-propose.md',
                ],
              },
            }),
      });

      const scratchEntrypoint = path.join(scratch, expected.entrypoint);
      fs.mkdirSync(path.dirname(scratchEntrypoint), { recursive: true });
      fs.copyFileSync(
        path.join(repositoryRoot, expected.entrypoint),
        scratchEntrypoint,
      );
    }

    const scratchCli = path.join(
      scratch,
      'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
    );
    fs.mkdirSync(path.dirname(scratchCli), { recursive: true });
    fs.copyFileSync(
      path.join(
        repositoryRoot,
        'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
      ),
      scratchCli,
    );
    const before = Object.fromEntries(
      Object.keys(expectedChecks).map((checkId) => [
        checkId,
        resolveCheckRunner(scratch, checkId, definitions[checkId]!).digest,
      ]),
    );
    for (const runnerDigest of Object.values(before)) {
      assert.match(runnerDigest, /^[0-9a-f]{64}$/);
    }
    fs.appendFileSync(scratchCli, '\n// unrelated CLI update\n');
    const after = Object.fromEntries(
      Object.keys(expectedChecks).map((checkId) => [
        checkId,
        resolveCheckRunner(scratch, checkId, definitions[checkId]!).digest,
      ]),
    );
    assert.deepEqual(after, before);

    for (const [checkId, expected] of Object.entries(expectedChecks)) {
      fs.appendFileSync(
        path.join(scratch, expected.entrypoint),
        '\n// changed check entrypoint\n',
      );
      assert.notEqual(
        resolveCheckRunner(scratch, checkId, definitions[checkId]!).digest,
        before[checkId],
      );
    }
  } finally {
    fs.rmSync(managedRepository, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
