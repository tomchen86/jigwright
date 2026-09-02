import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  evaluatePlanningProvider,
  PlanningProviderContractError,
} from '@jigwright/core/planning-provider-port';

import {
  createPortabilityFixturePlanningProviderV1,
  loadPortabilityFixtureProfile,
  renderPortabilityFixtureDocumentIndex,
  resolvePortabilityFixtureBranch,
} from '../src/portability-profile.ts';
import { createFixtureRepositoryConsumerPortV1 } from '../src/repository-consumer.ts';

const packageRoot = path.resolve(import.meta.dirname, '..');

test('@jigwright/fixture-adapter has one-way public package dependencies', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
  ) as {
    name: string;
    dependencies?: Record<string, string>;
    exports?: Record<string, string>;
  };
  assert.equal(manifest.name, '@jigwright/fixture-adapter');
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).sort(), [
    '@jigwright/core',
  ]);
  assert.deepEqual(Object.keys(manifest.exports ?? {}).sort(), [
    '.',
    './agent-runtime',
    './evidence-node',
    './exact-local-package-invocation',
    './managed-transition-reader',
    './markdown-outline',
    './portability-profile',
    './repository-consumer',
    './runtime-paths',
    './session-runtime-layout',
    './tracked-object-reader',
  ]);

  for (const file of fs.readdirSync(path.join(packageRoot, 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(packageRoot, 'src', file), 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/gu)) {
      const specifier = match[1]!;
      assert.equal(
        /workflow-engine|@jigwright\/(?:agent-runtime|grants|openspec-adapter)|expense/iu.test(
          specifier,
        ),
        false,
        `${file} imports forbidden implementation authority ${specifier}`,
      );
      assert.equal(
        specifier.startsWith('.') ||
          specifier.startsWith('node:') ||
          specifier.startsWith('@jigwright/core/'),
        true,
        `${file} imports undeclared package ${specifier}`,
      );
    }
  }
});

test('a neutral consumer binds a different base, branch, planning schema, document adapter, and check', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-orbit-fixture-'),
  );
  try {
    const profilePath = path.join(
      repositoryRoot,
      'tooling/portability-profile.json',
    );
    fs.mkdirSync(path.dirname(profilePath), { recursive: true });
    fs.writeFileSync(
      profilePath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'jigwright.portability-fixture-profile.v1',
        repositoryName: 'orbit-fixture',
        protectedBase: 'trunk',
        branchTemplate: 'changes/{changeId}',
        planningSchema: 'orbit-spec-v1',
        planningRootTemplate: 'plans/{changeId}',
        documentAdapter: 'orbit-notebook-v1',
        requiredDocuments: ['steps.md', 'architecture.md', 'brief.md'],
        requiredChecks: ['text-check'],
      })}\n`,
    );
    const planningRoot = path.join(repositoryRoot, 'plans/vector-change');
    fs.mkdirSync(planningRoot, { recursive: true });
    for (const document of ['architecture.md', 'brief.md', 'steps.md']) {
      fs.writeFileSync(path.join(planningRoot, document), `# ${document}\n`);
    }

    const profile = loadPortabilityFixtureProfile(repositoryRoot);
    const repositoryConsumer = createFixtureRepositoryConsumerPortV1(
      repositoryRoot,
      profile,
    ).load(repositoryRoot);
    assert.equal(repositoryConsumer.consumerId, 'orbit-fixture');
    assert.equal(
      repositoryConsumer.planning.currentSchemaName,
      'orbit-spec-v1',
    );
    assert.equal(repositoryConsumer.documents.adapterId, 'orbit-notebook-v1');
    assert.equal(repositoryConsumer.databasePolicy.adapterId, 'disabled-v1');
    assert.equal(profile.protectedBase, 'trunk');
    assert.deepEqual(profile.requiredDocuments, [
      'architecture.md',
      'brief.md',
      'steps.md',
    ]);
    assert.deepEqual(profile.requiredChecks, ['text-check']);
    assert.equal(
      resolvePortabilityFixtureBranch(profile, 'vector-change'),
      'changes/vector-change',
    );
    const context = {
      repositoryRoot: fs.realpathSync(repositoryRoot),
      planningRoot: 'plans/vector-change',
      changeId: 'vector-change',
      contractName: 'orbit-spec-v1',
      revision: { kind: 'worktree' as const },
      readOnly: true as const,
    };
    const evaluation = evaluatePlanningProvider(
      createPortabilityFixturePlanningProviderV1(repositoryRoot, profile),
      context,
    );
    assert.equal(evaluation.change.readiness, 'ready');
    assert.equal(evaluation.change.valid, true);
    assert.match(evaluation.evaluationDigest, /^[0-9a-f]{64}$/u);
    assert.equal(
      renderPortabilityFixtureDocumentIndex(profile, 'vector-change'),
      [
        '# orbit-fixture planning index',
        '',
        'Schema: `orbit-spec-v1`',
        'Adapter: `orbit-notebook-v1`',
        'Change: `vector-change`',
        'Branch: `changes/vector-change`',
        'Protected base: `trunk`',
        '',
        '- `architecture.md`',
        '- `brief.md`',
        '- `steps.md`',
        '',
      ].join('\n'),
    );

    fs.rmSync(path.join(planningRoot, 'brief.md'));
    assert.throws(
      () =>
        evaluatePlanningProvider(
          createPortabilityFixturePlanningProviderV1(repositoryRoot, profile),
          context,
        ),
      PlanningProviderContractError,
    );
    assert.throws(
      () =>
        evaluatePlanningProvider(
          createPortabilityFixturePlanningProviderV1(repositoryRoot, profile),
          { ...context, contractName: 'expense-app-v2' },
        ),
      /Portability fixture profile is invalid/u,
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('the public fixture repository-consumer port exposes only current document keys', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-fixture-port-documents-'),
  );
  try {
    const configuration = createFixtureRepositoryConsumerPortV1(
      repositoryRoot,
      {
        repositoryName: 'orbit-fixture',
        planningSchema: 'orbit-spec-v1',
        documentAdapter: 'orbit-notebook-v1',
      },
    ).load(repositoryRoot);

    assert.deepEqual(configuration.documents, {
      adapterId: 'orbit-notebook-v1',
      handoffPath: 'notebook/handoff.md',
    });
    assert.deepEqual(Object.keys(configuration.documents).sort(), [
      'adapterId',
      'handoffPath',
    ]);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('the public fixture repository-consumer port exposes only current Work Registry keys', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-fixture-port-work-registry-'),
  );
  try {
    const configuration = createFixtureRepositoryConsumerPortV1(
      repositoryRoot,
      {
        repositoryName: 'orbit-fixture',
        planningSchema: 'orbit-spec-v1',
        documentAdapter: 'orbit-notebook-v1',
      },
    ).load(repositoryRoot);

    assert.deepEqual(Object.keys(configuration.workRegistry).sort(), [
      'adapterId',
      'backlogPath',
      'changeOriginRoot',
      'historyRoot',
      'inventoryPath',
      'itemRoot',
      'transitionPolicyPath',
    ]);
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});

test('consumer-neutral package sources reject every known expense-app coupling class', () => {
  const sourceRoots = [
    path.resolve(packageRoot, '../core/src'),
    path.resolve(packageRoot, '../agent-runtime/src'),
    path.resolve(packageRoot, '../openspec-adapter/src'),
    path.resolve(packageRoot, '../github-adapter/src'),
    path.join(packageRoot, 'src'),
  ];
  const forbidden = [
    { id: 'product-identity', pattern: /expense-app/iu },
    { id: 'application-path', pattern: /apps\/(?:api|mobile)/iu },
    { id: 'planning-schema', pattern: /expense-app-v2/iu },
    {
      id: 'curated-document',
      pattern: /(?:CURRENT_AND_NEXT_STEPS|ISSUE_LOG)\.md/iu,
    },
    { id: 'legacy-issue-identity', pattern: /\bISS-[0-9]+\b/iu },
    {
      id: 'database-check',
      pattern: /(?:api-database-policy-test|TEST_DATABASE_URL)/u,
    },
  ];

  for (const sourceRoot of sourceRoots) {
    for (const filePath of listTypeScriptFiles(sourceRoot)) {
      const source = fs.readFileSync(filePath, 'utf8');
      for (const coupling of forbidden) {
        assert.equal(
          coupling.pattern.test(source),
          false,
          `${path.relative(packageRoot, filePath)} contains ${coupling.id}`,
        );
      }
    }
  }
});

function listTypeScriptFiles(root: string): string[] {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) return listTypeScriptFiles(entryPath);
      return entry.isFile() && entry.name.endsWith('.ts') ? [entryPath] : [];
    })
    .sort();
}
