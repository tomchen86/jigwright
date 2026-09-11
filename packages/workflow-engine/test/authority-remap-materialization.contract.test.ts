/** Authority remap regeneration, materialization, and generator boundary contracts. */
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  sourceRepositoryRoot,
  git,
  isWorkflowError,
  createFixtureRepository,
} from './fixture.ts';
import {
  generateBuiltInEngineClosure,
  renderBuiltInEngineClosure,
} from '../bootstrap/generate-built-in-engine-closure.ts';
import {
  generateHarnessBootstrapRuntime,
  renderHarnessBootstrapRuntime,
} from '../bootstrap/generate-harness-bootstrap-runtime.ts';
import { generateProtectedCapabilitiesManifest } from '../bootstrap/generate-protected-capabilities.ts';
import { resolveWorkspaceSourceClosure } from '../bootstrap/workspace-source-closure.ts';
import { projectAuthorityRemap } from '../src/composition-root/authority-remap.ts';
import assert from 'node:assert/strict';
import { materializeAuthorityRemap } from '../bootstrap/authority-remap-materializer.ts';
import {
  head,
  write,
  stageGeneratedRuntimeFixture,
  commitGeneratedRuntimeFixture,
  move,
  commitAll,
  removeFixtureActiveGuard,
  writeMaintainerPolicy,
  writeMaintainerProfiles,
  updatePathRoles,
} from './authority-remap-fixture.ts';

// Cloning HEAD deliberately excludes uncommitted source relocations. Prepare the
// real current bootstrap source closure before committing the fixture's pinned
// base, then let the generators derive every manifest and digest from its bytes.
function copyCurrentBootstrapSources(repository: string): void {
  for (const descriptor of resolveWorkspaceSourceClosure(
    sourceRepositoryRoot,
  )) {
    const source = path.join(sourceRepositoryRoot, descriptor.sourceRoot);
    const target = path.join(repository, descriptor.sourceRoot);
    fs.cpSync(path.join(source, 'src'), path.join(target, 'src'), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(source, 'package.json'),
      path.join(target, 'package.json'),
    );
  }
  // Reviewed source identities must match the current generator's declared
  // verifier composition; generation below recomputes every content digest.
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/protected-capabilities.json'),
    path.join(repository, 'workflow/protected-capabilities.json'),
  );
  const bootstrap = 'packages/workflow-engine/bootstrap';
  for (const entry of fs.readdirSync(
    path.join(sourceRepositoryRoot, bootstrap),
    {
      withFileTypes: true,
    },
  )) {
    if (entry.isFile() && entry.name.endsWith('.ts')) {
      fs.copyFileSync(
        path.join(sourceRepositoryRoot, bootstrap, entry.name),
        path.join(repository, bootstrap, entry.name),
      );
    }
  }
}

test('regeneration materializes one exact ready intent and rejects a stale handoff', async () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'authority-remap-materializer-contract-'),
  );
  const repository = path.join(container, 'repository');
  try {
    execFileSync(
      'git',
      [
        'clone',
        '--quiet',
        '--shared',
        '--no-checkout',
        sourceRepositoryRoot,
        repository,
      ],
      { encoding: 'utf8' },
    );
    git(repository, [
      'checkout',
      '--quiet',
      '--detach',
      head(sourceRepositoryRoot),
    ]);
    git(repository, ['config', 'user.email', 'workflow@example.test']);
    git(repository, ['config', 'user.name', 'Workflow Test']);
    copyCurrentBootstrapSources(repository);
    const from =
      'packages/workflow-engine/src/modules/t3-materializer-fixture.ts';
    const to =
      'packages/workflow-engine/src/modules/source/t3-materializer-fixture.ts';
    write(repository, from, 'export const t3MaterializerFixture = true;\n');
    const harnessBootstrapPath = path.join(
      repository,
      'packages/workflow-engine/src/entrypoints/cli/harness-bootstrap-cli.ts',
    );
    fs.appendFileSync(
      harnessBootstrapPath,
      "export { t3MaterializerFixture } from '../../modules/t3-materializer-fixture.ts';\n",
    );
    const regeneratedOutput =
      'packages/workflow-engine/bootstrap/recovery-runtime/src/modules/source/t3-materializer-fixture.js';
    generateBuiltInEngineClosure(repository, '--write');
    generateHarnessBootstrapRuntime(repository, '--write');
    stageGeneratedRuntimeFixture(repository);
    await generateProtectedCapabilitiesManifest(repository, '--write');
    commitGeneratedRuntimeFixture(
      repository,
      'Add generated-current materializer fixture',
    );
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move materializer fixture mechanically');
    const moveCommit = head(repository);
    fs.writeFileSync(
      harnessBootstrapPath,
      fs
        .readFileSync(harnessBootstrapPath, 'utf8')
        .replace(
          '../../modules/t3-materializer-fixture.ts',
          '../../modules/source/t3-materializer-fixture.ts',
        ),
    );
    commitAll(repository, 'Review materializer fixture import rewrite');
    const materializationCommit = head(repository);
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      materializationCommit,
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'materialize-remap',
        taskId: '1.1',
        profileId: 'workflow-engine-root-one-shot',
        reason: 'Materialize exact generated artifacts for one move phase.',
        message: 'Materialize authority remap artifacts',
      },
    } as const;
    const pending = projectAuthorityRemap(request);
    assert.equal(pending.status, 'requires-regeneration');

    const materializationRequest = {
      ...request,
      authorityPlan: { ...request.authorityPlan },
      expectedRegenerationDescriptorDigest:
        pending.regeneration!.descriptorDigest,
    };
    const materialization = materializeAuthorityRemap(materializationRequest);
    const mutableAuthorityPlan = materializationRequest.authorityPlan as {
      changeId: string;
      taskId: string;
      profileId: string;
      reason: string;
      message: string;
    };
    mutableAuthorityPlan.changeId = 'INVALID';
    mutableAuthorityPlan.taskId = 'bad';
    mutableAuthorityPlan.reason = '';
    mutableAuthorityPlan.message = '';
    const materialized = await materialization;
    assert.equal(materialized.status, 'ready');
    assert.equal(materialized.regeneration, null);
    assert.equal(
      materialized.manifest.regenerationDescriptorDigest,
      pending.regeneration!.descriptorDigest,
    );
    assert.equal(
      materialized.manifest.authorityPlanIntentDigest === null,
      false,
    );
    assert.match(
      materialized.manifest.authorityPlanIntentDigest ?? '',
      /^sha256:[0-9a-f]{64}$/,
    );
    const mutationPaths = materialized.intent!.mutations.map(
      ({ path }) => path,
    );
    assert.deepEqual(mutationPaths, [...mutationPaths].sort());
    assert.ok(
      mutationPaths.includes(
        'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
      ),
    );
    assert.ok(
      mutationPaths.includes(
        'packages/workflow-engine/bootstrap/built-in-engine-closure-pin.ts',
      ),
    );
    assert.ok(mutationPaths.includes(regeneratedOutput));
    assert.ok(mutationPaths.includes('workflow/protected-capabilities.json'));
    assert.equal(materialized.intent!.changeId, 'materialize-remap');
    assert.equal(materialized.intent!.taskId, '1.1');
    assert.equal(
      materialized.intent!.reason,
      'Materialize exact generated artifacts for one move phase.',
    );
    assert.equal(git(repository, ['status', '--porcelain']), '');

    git(repository, ['commit', '--allow-empty', '-m', 'Advance after move']);
    await assert.rejects(
      materializeAuthorityRemap({
        ...request,
        expectedRegenerationDescriptorDigest:
          pending.regeneration!.descriptorDigest,
      }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('caller HEAD'),
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('regeneration rejects generated recovery outputs ignored by tracked rules', async () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'authority-remap-ignored-output-contract-'),
  );
  const repository = path.join(container, 'repository');
  try {
    execFileSync(
      'git',
      [
        'clone',
        '--quiet',
        '--shared',
        '--no-checkout',
        sourceRepositoryRoot,
        repository,
      ],
      { encoding: 'utf8' },
    );
    git(repository, [
      'checkout',
      '--quiet',
      '--detach',
      head(sourceRepositoryRoot),
    ]);
    git(repository, ['config', 'user.email', 'workflow@example.test']);
    git(repository, ['config', 'user.name', 'Workflow Test']);
    copyCurrentBootstrapSources(repository);
    const from =
      'packages/workflow-engine/src/modules/t3-ignored-output-fixture.ts';
    const to =
      'packages/workflow-engine/src/modules/source/t3-ignored-output-fixture.ts';
    const ignoredOutput =
      'packages/workflow-engine/bootstrap/recovery-runtime/src/modules/source/t3-ignored-output-fixture.js';
    write(repository, from, 'export const t3IgnoredOutputFixture = true;\n');
    const harnessBootstrapPath = path.join(
      repository,
      'packages/workflow-engine/src/entrypoints/cli/harness-bootstrap-cli.ts',
    );
    fs.appendFileSync(
      harnessBootstrapPath,
      "export { t3IgnoredOutputFixture } from '../../modules/t3-ignored-output-fixture.ts';\n",
    );
    generateBuiltInEngineClosure(repository, '--write');
    generateHarnessBootstrapRuntime(repository, '--write');
    stageGeneratedRuntimeFixture(repository);
    await generateProtectedCapabilitiesManifest(repository, '--write');
    commitGeneratedRuntimeFixture(
      repository,
      'Add generated-current ignored-output fixture',
    );
    // The base must first carry current generated bytes. Marking a tracked
    // output ignored afterwards isolates the materializer's ignore-rule check
    // instead of failing earlier for unrelated generated drift.
    fs.appendFileSync(
      path.join(repository, '.gitignore'),
      `/${ignoredOutput}\n`,
    );
    commitAll(repository, 'Mark generated recovery fixture ignored');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move ignored-output fixture mechanically');
    const moveCommit = head(repository);
    fs.writeFileSync(
      harnessBootstrapPath,
      fs
        .readFileSync(harnessBootstrapPath, 'utf8')
        .replace(
          '../../modules/t3-ignored-output-fixture.ts',
          '../../modules/source/t3-ignored-output-fixture.ts',
        ),
    );
    commitAll(repository, 'Review ignored-output fixture import rewrite');
    const materializationCommit = head(repository);
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      materializationCommit,
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'reject-ignored-generated-output',
        taskId: '1.1',
        profileId: 'workflow-engine-root-one-shot',
        reason: 'Reject generated output omitted by tracked ignore rules.',
        message: 'Reject ignored generated output',
      },
    } as const;
    const pending = projectAuthorityRemap(request);
    assert.equal(pending.status, 'requires-regeneration');

    await assert.rejects(
      materializeAuthorityRemap({
        ...request,
        expectedRegenerationDescriptorDigest:
          pending.regeneration!.descriptorDigest,
      }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes(ignoredOutput),
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('regeneration rejects pre-existing generated drift in the pinned base commit', async () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'authority-remap-stale-base-contract-'),
  );
  const repository = path.join(container, 'repository');
  try {
    execFileSync(
      'git',
      [
        'clone',
        '--quiet',
        '--shared',
        '--no-checkout',
        sourceRepositoryRoot,
        repository,
      ],
      { encoding: 'utf8' },
    );
    git(repository, [
      'checkout',
      '--quiet',
      '--detach',
      head(sourceRepositoryRoot),
    ]);
    git(repository, ['config', 'user.email', 'workflow@example.test']);
    git(repository, ['config', 'user.name', 'Workflow Test']);

    const stale =
      'packages/workflow-engine/src/modules/t3-unrelated-stale-base.ts';
    const from = 'packages/workflow-engine/src/modules/t3-stale-base-move.ts';
    const to =
      'packages/workflow-engine/src/modules/source/t3-stale-base-move.ts';
    write(repository, stale, 'export const unrelatedStaleBase = true;\n');
    write(repository, from, 'export const staleBaseMove = true;\n');
    commitAll(repository, 'Create intentionally stale generated base');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move fixture without laundering stale base');
    const moveCommit = head(repository);
    const pending = projectAuthorityRemap({
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'reject-stale-generated-base',
        taskId: '1.1',
        profileId: 'workflow-engine-root-one-shot',
        reason:
          'Reject unrelated generated drift before remap materialization.',
        message: 'Reject stale generated base',
      },
    });
    assert.equal(pending.status, 'requires-regeneration');

    await assert.rejects(
      materializeAuthorityRemap({
        repositoryRoot: repository,
        baseCommit,
        moveCommit,
        renamePairs: [{ from, to }],
        authorityPlan: {
          changeId: 'reject-stale-generated-base',
          taskId: '1.1',
          profileId: 'workflow-engine-root-one-shot',
          reason:
            'Reject unrelated generated drift before remap materialization.',
          message: 'Reject stale generated base',
        },
        expectedRegenerationDescriptorDigest:
          pending.regeneration!.descriptorDigest,
      }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('pinned base generated artifacts are stale'),
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('regeneration rejects tracked attributes that can transform pinned blob bytes', async () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from = 'packages/workflow-engine/src/attribute-source.ts';
    const to = 'packages/workflow-engine/src/modules/attribute-source.ts';
    write(repository, '.gitattributes', '*.ts filter=audit text eol=crlf\n');
    write(repository, from, 'export const attributeSource = true;\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**'],
    });
    commitAll(repository, 'Add transforming attributes before remap');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move source under transforming attributes');
    const moveCommit = head(repository);
    const marker = path.join(path.dirname(repository), 'filter-executed');
    const filterScript = path.join(path.dirname(repository), 'filter.mjs');
    fs.writeFileSync(
      filterScript,
      [
        "import fs from 'node:fs';",
        `fs.writeFileSync(${JSON.stringify(marker)}, 'executed\\n');`,
        'process.stdin.pipe(process.stdout);',
        '',
      ].join('\n'),
    );
    git(repository, [
      'config',
      'filter.audit.clean',
      `${process.execPath} ${filterScript}`,
    ]);
    git(repository, ['config', 'filter.audit.required', 'true']);
    const movedPath = path.join(repository, to);
    const movedStats = fs.statSync(movedPath);
    fs.utimesSync(
      movedPath,
      movedStats.atime,
      new Date(movedStats.mtimeMs + 1_000),
    );
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'reject-transforming-attributes',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason: 'Reject worktree byte transforms during exact materialization.',
        message: 'Reject transforming Git attributes',
      },
    } as const;
    const pending = projectAuthorityRemap(request);
    assert.equal(pending.status, 'requires-regeneration');

    await assert.rejects(
      materializeAuthorityRemap({
        ...request,
        expectedRegenerationDescriptorDigest:
          pending.regeneration!.descriptorDigest,
      }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('tracked .gitattributes'),
    );
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('regeneration rejects hidden caller index flags before reading materialization inputs', async () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from = 'packages/workflow-engine/src/hidden-index-source.ts';
    const to = 'packages/workflow-engine/src/modules/hidden-index-source.ts';
    write(repository, from, 'export const hiddenIndexSource = true;\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**'],
    });
    commitAll(repository, 'Add source before hidden-index remap');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move source before hidden-index remap');
    const moveCommit = head(repository);
    git(repository, [
      'update-index',
      '--assume-unchanged',
      'workflow/path-roles.json',
    ]);
    assert.equal(git(repository, ['status', '--porcelain']), '');
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'reject-hidden-index-flags',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason: 'Reject hidden caller index state before materialization.',
        message: 'Reject hidden index flags',
      },
    } as const;
    const pending = projectAuthorityRemap(request);
    assert.equal(pending.status, 'requires-regeneration');

    await assert.rejects(
      materializeAuthorityRemap({
        ...request,
        expectedRegenerationDescriptorDigest:
          pending.regeneration!.descriptorDigest,
      }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('hidden index flags'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('closure generators reject symlinked package boundaries without writing or deleting outside them', () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'closure-generator-boundary-contract-'),
  );
  try {
    const candidate = path.join(container, 'candidate');
    const packageRoot = path.join(candidate, 'packages/workflow-engine');
    const externalBootstrap = path.join(container, 'external-bootstrap');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.mkdirSync(externalBootstrap, { recursive: true });
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'packages/workflow-engine/package.json'),
      path.join(packageRoot, 'package.json'),
    );
    fs.symlinkSync(
      path.join(sourceRepositoryRoot, 'packages/workflow-engine/src'),
      path.join(packageRoot, 'src'),
      'dir',
    );
    fs.symlinkSync(
      externalBootstrap,
      path.join(packageRoot, 'bootstrap'),
      'dir',
    );
    const sentinel = path.join(
      externalBootstrap,
      'recovery-runtime.previous/sentinel',
    );
    write(candidate, path.relative(candidate, sentinel), 'preserve\n');

    assert.throws(() => renderBuiltInEngineClosure(candidate));
    assert.throws(() => generateBuiltInEngineClosure(candidate, '--write'));
    assert.throws(() => generateHarnessBootstrapRuntime(candidate, '--write'));
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve\n');
    assert.equal(
      fs.existsSync(
        path.join(externalBootstrap, 'built-in-engine-closure.json'),
      ),
      false,
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('harness renderer never executes a candidate-owned compiler and returns immutable encodings', () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'closure-generator-toolchain-contract-'),
  );
  try {
    const packageRoot = path.join(container, 'packages/workflow-engine');
    fs.mkdirSync(path.join(packageRoot, 'src'), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, 'bootstrap'), { recursive: true });
    write(
      container,
      'packages/workflow-engine/package.json',
      '{"name":"jigwright","type":"module"}\n',
    );
    write(
      container,
      'packages/workflow-engine/src/entrypoints/cli/harness-bootstrap-cli.ts',
      'export const fixture = true;\n',
    );
    generateBuiltInEngineClosure(container, '--write');
    const marker = path.join(container, 'candidate-tsc-executed');
    const preloadMarker = path.join(container, 'node-options-executed');
    const preload = path.join(container, 'poisoned-node-options.cjs');
    fs.writeFileSync(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(preloadMarker)}, 'executed\\n');\n`,
    );
    const fakeTsc = path.join(container, 'node_modules/.bin/tsc');
    write(
      container,
      'node_modules/.bin/tsc',
      `#!/bin/sh\ntouch '${marker}'\nexit 1\n`,
    );
    fs.chmodSync(fakeTsc, 0o755);

    let rendered: ReturnType<typeof renderHarnessBootstrapRuntime> | null =
      null;
    const originalNodeOptions = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = `--require=${preload}`;
      rendered = renderHarnessBootstrapRuntime(container);
    } finally {
      if (originalNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = originalNodeOptions;
    }
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(preloadMarker), false);
    assert.notEqual(rendered, null);
    const first = rendered!.runtimeFiles[0] as unknown as {
      contentBase64?: unknown;
    };
    assert.equal(typeof first.contentBase64, 'string');
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('harness generator rejects linked metadata outputs without overwriting external bytes', () => {
  const container = fs.mkdtempSync(
    path.join(os.tmpdir(), 'closure-generator-output-contract-'),
  );
  try {
    fs.mkdirSync(path.join(container, 'packages/workflow-engine/src'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(container, 'packages/workflow-engine/bootstrap'), {
      recursive: true,
    });
    write(
      container,
      'packages/workflow-engine/package.json',
      '{"name":"jigwright","type":"module"}\n',
    );
    write(
      container,
      'packages/workflow-engine/src/entrypoints/cli/harness-bootstrap-cli.ts',
      'export const fixture = true;\n',
    );
    generateBuiltInEngineClosure(container, '--write');
    const external = path.join(container, 'external-manifest-sentinel');
    fs.writeFileSync(external, 'preserve-external-bytes\n');
    fs.symlinkSync(
      external,
      path.join(
        container,
        'packages/workflow-engine/bootstrap/harness-bootstrap-dependency-closure.json',
      ),
    );

    assert.throws(
      () => generateHarnessBootstrapRuntime(container, '--write'),
      /Harness-bootstrap output is unsafe: .*harness-bootstrap-dependency-closure\.json/,
    );
    assert.equal(
      fs.readFileSync(external, 'utf8'),
      'preserve-external-bytes\n',
    );
  } finally {
    fs.rmSync(container, { recursive: true, force: true });
  }
});

test('authority remap rejects an intent that its pinned trust-base profile cannot authorize', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    write(repository, 'src/legacy.ts', 'restricted\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**', 'src/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**', 'src/**'],
    });
    updatePathRoles(repository, (roles) => {
      roles.grant = ['src/legacy.ts'];
    });
    commitAll(repository, 'Add insufficient remap profile');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move restricted path');

    assert.throws(
      () =>
        projectAuthorityRemap({
          repositoryRoot: repository,
          baseCommit,
          moveCommit: head(repository),
          renamePairs: [
            { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
          ],
          authorityPlan: {
            changeId: 'restricted-remap',
            taskId: '1.1',
            profileId: 'remap-profile',
            reason: 'Reject an authority projection outside its trust profile.',
            message: 'Reject unauthorized authority projection',
          },
        }),
      (error: unknown) =>
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error instanceof Error &&
        error.message.includes('workflow/path-roles.json'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
