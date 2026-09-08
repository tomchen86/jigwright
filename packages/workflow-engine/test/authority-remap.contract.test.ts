/** Exact move proofs and authority-policy projection contracts. */
import test from 'node:test';
import {
  createFixtureRepository,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';
import {
  verifyMechanicalMovePhase,
  projectAuthorityRemap,
  projectAuthorityRemapPathRoles,
  projectAuthorityRemapChecks,
  projectAuthorityRemapGuards,
  projectAuthorityRemapMaintainerPolicy,
  projectAuthorityRemapProfiles,
} from '../src/composition-root/authority-remap.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  parsePathRoleRegistry,
  resolvePathRole,
} from '../src/modules/source/path-role-registry.ts';
import { parseMaintainerPolicy } from '../src/modules/authority/maintainer-policy.ts';
import {
  parseCapabilityProfile,
  classifyFileRole,
} from '../src/modules/authority/maintainer-manifest.ts';
import { execFileSync } from 'node:child_process';
import {
  write,
  commitAll,
  head,
  move,
  removeFixtureActiveGuard,
  writeMaintainerPolicy,
  writeMaintainerProfiles,
  updatePathRoles,
  updateChecks,
  writeGuard,
} from './authority-remap-fixture.ts';

test('mechanical move proof binds one exact adjacent commit range and ignores later worktree state', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'export const value = 1;\n');
    commitAll(repository, 'Add legacy source');
    const baseCommit = head(repository);
    const objectId = git(repository, [
      'rev-parse',
      `${baseCommit}:src/legacy.ts`,
    ]).trim();

    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move legacy source');
    const moveCommit = head(repository);
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
    } as const;

    const proof = verifyMechanicalMovePhase(request);
    assert.deepEqual(proof.moves, [
      {
        from: 'src/legacy.ts',
        to: 'packages/core/src/legacy.ts',
        objectId,
        mode: '100644',
      },
    ]);
    assert.equal(
      proof.baseTree,
      git(repository, ['rev-parse', `${baseCommit}^{tree}`]).trim(),
    );
    assert.equal(
      proof.moveTree,
      git(repository, ['rev-parse', `${moveCommit}^{tree}`]).trim(),
    );
    assert.match(proof.proofDigest, /^sha256:[0-9a-f]{64}$/);

    write(repository, 'worktree-only.ts', 'ignored\n');
    assert.deepEqual(verifyMechanicalMovePhase(request), proof);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('mechanical move proof reads the raw commit parent instead of caller grafts', () => {
  const repository = createFixtureRepository();
  try {
    const from = 'src/grafted-parent.ts';
    const to = 'packages/core/src/grafted-parent.ts';
    const intermediate = 'src/intermediate-only.ts';
    write(repository, from, 'export const graftedParent = true;\n');
    commitAll(repository, 'Add source before grafted move');
    const baseCommit = head(repository);

    write(repository, intermediate, 'temporary history only\n');
    commitAll(repository, 'Add intermediate history state');
    const actualParent = head(repository);
    move(repository, from, to);
    fs.rmSync(path.join(repository, intermediate));
    commitAll(repository, 'Move source after intermediate history');
    const moveCommit = head(repository);
    assert.equal(
      git(repository, ['rev-parse', `${moveCommit}^`]).trim(),
      actualParent,
    );
    fs.writeFileSync(
      path.join(repository, '.git/info/grafts'),
      `${moveCommit} ${baseCommit}\n`,
    );

    assert.throws(
      () =>
        verifyMechanicalMovePhase({
          repositoryRoot: repository,
          baseCommit,
          moveCommit,
          renamePairs: [{ from, to }],
        }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('exactly the base commit as its parent'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reviewed content boundary reads the raw commit parent instead of caller grafts', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from = 'src/grafted-content.ts';
    const to = 'packages/core/src/grafted-content.ts';
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**', 'src/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**', 'src/**'],
    });
    write(repository, from, 'export const graftedContent = 1;\n');
    commitAll(repository, 'Add source before grafted content');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move source before grafted content');
    const moveCommit = head(repository);

    write(repository, to, 'export const graftedContent = 2;\n');
    commitAll(repository, 'Add intermediate content history');
    const actualParent = head(repository);
    write(repository, to, 'export const graftedContent = 3;\n');
    commitAll(repository, 'Add final reviewed content');
    const contentCommit = head(repository);
    assert.equal(
      git(repository, ['rev-parse', `${contentCommit}^`]).trim(),
      actualParent,
    );
    fs.writeFileSync(
      path.join(repository, '.git/info/grafts'),
      `${contentCommit} ${moveCommit}\n`,
    );

    assert.throws(
      () =>
        projectAuthorityRemap({
          repositoryRoot: repository,
          baseCommit,
          moveCommit,
          materializationCommit: contentCommit,
          renamePairs: [{ from, to }],
          authorityPlan: {
            changeId: 'reject-grafted-content-parent',
            taskId: '1.1',
            profileId: 'remap-profile',
            reason: 'Reject caller-local grafts in reviewed content ancestry.',
            message: 'Reject grafted content parent',
          },
        }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('single direct reviewed-content child'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('declared pairs own duplicate-blob mapping instead of Git rename similarity', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/a.ts', 'same bytes\n');
    write(repository, 'src/b.ts', 'same bytes\n');
    commitAll(repository, 'Add duplicate blobs');
    const baseCommit = head(repository);

    move(repository, 'src/a.ts', 'packages/core/src/x.ts');
    move(repository, 'src/b.ts', 'packages/core/src/y.ts');
    commitAll(repository, 'Move duplicate blobs');
    const moveCommit = head(repository);

    const proof = verifyMechanicalMovePhase({
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [
        { from: 'src/a.ts', to: 'packages/core/src/y.ts' },
        { from: 'src/b.ts', to: 'packages/core/src/x.ts' },
      ],
    });
    assert.deepEqual(
      proof.moves.map(({ from, to }) => ({ from, to })),
      [
        { from: 'src/a.ts', to: 'packages/core/src/y.ts' },
        { from: 'src/b.ts', to: 'packages/core/src/x.ts' },
      ],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('path-role projection makes a risky exact role follow the moved blob', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'export const value = 1;\n');
    updatePathRoles(repository, (roles) => {
      roles.grant = ['src/legacy.ts'];
    });
    commitAll(repository, 'Add role-classified legacy source');
    const baseCommit = head(repository);

    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move role-classified source');
    const moveCommit = head(repository);
    const projected = projectAuthorityRemapPathRoles({
      repositoryRoot: repository,
      baseCommit,
      moveCommit,
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
    });

    assert.deepEqual(projected.roles, [
      {
        from: 'src/legacy.ts',
        to: 'packages/core/src/legacy.ts',
        role: 'grant',
        beforePattern: 'src/legacy.ts',
        afterPattern: 'packages/core/src/legacy.ts',
      },
    ]);
    assert.equal(projected.mutation?.path, 'workflow/path-roles.json');
    assert.match(
      projected.mutation?.expectedBeforeSha256 ?? '',
      /^[0-9a-f]{64}$/,
    );
    assert.match(projected.mutation?.content ?? '', /packages\/core\/src/);
    const registry = parsePathRoleRegistry(
      JSON.parse(projected.mutation!.content!),
    );
    assert.deepEqual(resolvePathRole(registry, 'packages/core/src/legacy.ts'), {
      registered: true,
      role: 'grant',
      pattern: 'packages/core/src/legacy.ts',
    });
    const projectedSource = JSON.parse(projected.mutation!.content!) as {
      roles: Record<string, string[]>;
    };
    assert.equal(
      Object.values(projectedSource.roles).some((patterns) =>
        patterns.includes('src/legacy.ts'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('path-role projection emits no mutation when one broad role already follows the move', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'ordinary\n');
    commitAll(repository, 'Add ordinary legacy source');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move ordinary source');

    const projected = projectAuthorityRemapPathRoles({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
    });
    assert.equal(projected.mutation, null);
    assert.deepEqual(projected.roles, [
      {
        from: 'src/legacy.ts',
        to: 'packages/core/src/legacy.ts',
        role: 'ordinary',
        beforePattern: 'src/**',
        afterPattern: 'packages/**',
      },
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('path-role projection rejects unregistered sources and exact destination conflicts', () => {
  for (const scenario of ['unregistered', 'conflict'] as const) {
    const repository = createFixtureRepository();
    try {
      const from =
        scenario === 'unregistered' ? 'unknown/source.ts' : 'src/legacy.ts';
      const to =
        scenario === 'unregistered'
          ? 'unknown-target/source.ts'
          : 'packages/core/src/legacy.ts';
      write(repository, from, `${scenario}\n`);
      if (scenario === 'conflict') {
        updatePathRoles(repository, (roles) => {
          roles.grant = [from];
          roles.lifecycle = [to];
        });
      }
      commitAll(repository, `Add ${scenario} source`);
      const baseCommit = head(repository);
      move(repository, from, to);
      commitAll(repository, `Move ${scenario} source`);

      assert.throws(
        () =>
          projectAuthorityRemapPathRoles({
            repositoryRoot: repository,
            baseCommit,
            moveCommit: head(repository),
            renamePairs: [{ from, to }],
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        scenario,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('check projection rewrites only parser-valid exact argv path tokens', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy-check.ts', 'export {};\n');
    updateChecks(repository, (checks) => {
      checks['moved-check'] = {
        command: ['node', 'src/legacy-check.ts'],
        destructiveDatabase: false,
      };
    });
    commitAll(repository, 'Add legacy check entrypoint');
    const baseCommit = head(repository);
    move(
      repository,
      'src/legacy-check.ts',
      'packages/core/src/legacy-check.ts',
    );
    commitAll(repository, 'Move check entrypoint');

    const projected = projectAuthorityRemapChecks({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        {
          from: 'src/legacy-check.ts',
          to: 'packages/core/src/legacy-check.ts',
        },
      ],
    });
    assert.deepEqual(projected.checks, [
      {
        checkId: 'moved-check',
        from: 'src/legacy-check.ts',
        to: 'packages/core/src/legacy-check.ts',
      },
    ]);
    assert.equal(projected.mutation?.path, 'workflow/checks.json');
    const source = JSON.parse(projected.mutation!.content!) as {
      checks: Record<string, { command: string[] }>;
    };
    assert.deepEqual(source.checks['moved-check']?.command, [
      'node',
      'packages/core/src/legacy-check.ts',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('check projection is empty without a moved argv token and rejects embedded guesses', () => {
  for (const scenario of ['unchanged', 'embedded'] as const) {
    const repository = createFixtureRepository();
    try {
      write(repository, 'src/legacy-check.ts', 'export {};\n');
      if (scenario === 'embedded') {
        updateChecks(repository, (checks) => {
          checks['embedded-check'] = {
            command: [
              'node',
              'scripts/pass.mjs',
              '--config=src/legacy-check.ts',
            ],
            destructiveDatabase: false,
          };
        });
      }
      commitAll(repository, `Add ${scenario} check source`);
      const baseCommit = head(repository);
      move(
        repository,
        'src/legacy-check.ts',
        'packages/core/src/legacy-check.ts',
      );
      commitAll(repository, `Move ${scenario} check source`);
      const request = {
        repositoryRoot: repository,
        baseCommit,
        moveCommit: head(repository),
        renamePairs: [
          {
            from: 'src/legacy-check.ts',
            to: 'packages/core/src/legacy-check.ts',
          },
        ],
      } as const;

      if (scenario === 'unchanged') {
        assert.equal(projectAuthorityRemapChecks(request).mutation, null);
      } else {
        assert.throws(
          () => projectAuthorityRemapChecks(request),
          (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        );
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('check projection rejects equivalent and delimited embedded path spellings', () => {
  for (const embedded of [
    './src/legacy-check.ts',
    'other,src/legacy-check.ts',
  ]) {
    const repository = createFixtureRepository();
    try {
      write(repository, 'src/legacy-check.ts', 'export {};\n');
      updateChecks(repository, (checks) => {
        checks['embedded-alias-check'] = {
          command: ['node', 'scripts/pass.mjs', '--config', embedded],
          destructiveDatabase: false,
        };
      });
      commitAll(repository, 'Add embedded alias check source');
      const baseCommit = head(repository);
      move(
        repository,
        'src/legacy-check.ts',
        'packages/core/src/legacy-check.ts',
      );
      commitAll(repository, 'Move embedded alias check source');

      assert.throws(
        () =>
          projectAuthorityRemapChecks({
            repositoryRoot: repository,
            baseCommit,
            moveCommit: head(repository),
            renamePairs: [
              {
                from: 'src/legacy-check.ts',
                to: 'packages/core/src/legacy-check.ts',
              },
            ],
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        embedded,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('check projection rejects an invalid pinned registry before rewriting one valid command', () => {
  for (const scenario of ['invalid-id', 'invalid-field'] as const) {
    const repository = createFixtureRepository();
    try {
      write(repository, 'src/legacy-check.ts', 'export {};\n');
      const checksPath = path.join(repository, 'workflow/checks.json');
      const source = JSON.parse(fs.readFileSync(checksPath, 'utf8')) as {
        checks: Record<string, Record<string, unknown>>;
      };
      source.checks['moved-check'] = {
        command: ['node', 'src/legacy-check.ts'],
        destructiveDatabase: false,
      };
      if (scenario === 'invalid-id') {
        source.checks.BAD_ID = {
          command: ['node', 'scripts/pass.mjs'],
          destructiveDatabase: false,
        };
      } else {
        source.checks.fixture!.destructiveDatabase = 'false';
      }
      fs.writeFileSync(checksPath, `${JSON.stringify(source, null, 2)}\n`);
      commitAll(repository, `Add ${scenario} check registry`);
      const baseCommit = head(repository);
      move(
        repository,
        'src/legacy-check.ts',
        'packages/core/src/legacy-check.ts',
      );
      commitAll(repository, `Move ${scenario} check source`);

      assert.throws(
        () =>
          projectAuthorityRemapChecks({
            repositoryRoot: repository,
            baseCommit,
            moveCommit: head(repository),
            renamePairs: [
              {
                from: 'src/legacy-check.ts',
                to: 'packages/core/src/legacy-check.ts',
              },
            ],
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        scenario,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('guard projection rewrites active allowedPaths and never touches archive or dot history', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    write(repository, 'src/legacy.ts', 'guarded\n');
    writeGuard(
      repository,
      'openspec/changes/live-remap/guard.json',
      'live-remap',
      'src/legacy.ts',
    );
    writeGuard(
      repository,
      'openspec/changes/archive/2026-08-20-live-remap/guard.json',
      'live-remap',
      'src/legacy.ts',
    );
    writeGuard(
      repository,
      'openspec/changes/.draft/guard.json',
      '.draft',
      'src/legacy.ts',
    );
    commitAll(repository, 'Add active and historical guards');
    const baseCommit = head(repository);
    const archivePath = path.join(
      repository,
      'openspec/changes/archive/2026-08-20-live-remap/guard.json',
    );
    const archiveBytes = fs.readFileSync(archivePath, 'utf8');
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move guarded source');

    const projected = projectAuthorityRemapGuards({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
    });
    assert.deepEqual(
      projected.guards.map(({ path: guardPath, replacements }) => ({
        path: guardPath,
        replacements,
      })),
      [
        {
          path: 'openspec/changes/live-remap/guard.json',
          replacements: [
            {
              taskId: '1.1',
              from: 'src/legacy.ts',
              to: 'packages/core/src/legacy.ts',
            },
          ],
        },
      ],
    );
    assert.deepEqual(
      (
        JSON.parse(projected.mutations[0]!.content!) as {
          tasks: Record<string, { allowedPaths: string[] }>;
        }
      ).tasks['1.1']?.allowedPaths,
      ['packages/core/src/legacy.ts'],
    );
    assert.equal(fs.readFileSync(archivePath, 'utf8'), archiveBytes);
    assert.equal(
      projected.mutations.some(({ path: mutationPath }) =>
        mutationPath.includes('/archive/'),
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('guard projection emits no mutations when no active guard references a move', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    write(repository, 'src/legacy.ts', 'unguarded\n');
    commitAll(repository, 'Add unguarded source');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move unguarded source');

    const projected = projectAuthorityRemapGuards({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
    });
    assert.deepEqual(projected.guards, []);
    assert.deepEqual(projected.mutations, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('maintainer policy projection preserves exact and broad authority-path semantics', () => {
  for (const scenario of [
    'exact',
    'broad-cross-root',
    'broad-covered',
  ] as const) {
    const repository = createFixtureRepository();
    try {
      const from =
        scenario === 'broad-covered' ? 'src/legacy/entry.ts' : 'src/legacy.ts';
      const to =
        scenario === 'broad-covered'
          ? 'src/relocated/entry.ts'
          : 'packages/core/src/legacy.ts';
      write(repository, from, `${scenario}\n`);
      writeMaintainerPolicy(repository, (policy) => {
        policy.bootstrapEligiblePaths =
          scenario === 'exact' ? [from] : ['src/**'];
        policy.sealedImmutablePaths =
          scenario === 'exact' ? [from] : ['src/**'];
      });
      commitAll(repository, `Add ${scenario} authority path`);
      const baseCommit = head(repository);
      move(repository, from, to);
      commitAll(repository, `Move ${scenario} authority path`);

      const projected = projectAuthorityRemapMaintainerPolicy({
        repositoryRoot: repository,
        baseCommit,
        moveCommit: head(repository),
        renamePairs: [{ from, to }],
      });

      if (scenario === 'broad-covered') {
        assert.equal(projected.mutation, null);
        continue;
      }
      const policy = parseMaintainerPolicy(
        JSON.parse(projected.mutation!.content),
      );
      const expected = scenario === 'exact' ? [to] : [to, 'src/**'].sort();
      assert.deepEqual(policy.bootstrapEligiblePaths, expected);
      assert.deepEqual(policy.sealedImmutablePaths, expected);
      assert.deepEqual(projected.paths, [
        {
          field: 'bootstrapEligiblePaths',
          from,
          to,
        },
        {
          field: 'sealedImmutablePaths',
          from,
          to,
        },
      ]);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('maintainer policy projection rejects path-authority expansion at the destination', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'not eligible\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    commitAll(repository, 'Add non-authority source');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move source into authority scope');

    assert.throws(
      () =>
        projectAuthorityRemapMaintainerPolicy({
          repositoryRoot: repository,
          baseCommit,
          moveCommit: head(repository),
          renamePairs: [
            {
              from: 'src/legacy.ts',
              to: 'packages/core/src/legacy.ts',
            },
          ],
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('maintainer profile projection preserves effective allow and forbidden roles', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'implementation\n');
    write(repository, 'secret/legacy.ts', 'forbidden\n');
    writeMaintainerProfiles(repository, {
      implementationPaths: ['src/**'],
      forbiddenPaths: ['secret/legacy.ts'],
    });
    commitAll(repository, 'Add profile-classified sources');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    move(repository, 'secret/legacy.ts', 'relocated/secret.ts');
    commitAll(repository, 'Move profile-classified sources');

    const projected = projectAuthorityRemapProfiles({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
        { from: 'secret/legacy.ts', to: 'relocated/secret.ts' },
      ],
    });
    const document = JSON.parse(projected.mutation!.content) as {
      profiles: Record<string, unknown>;
    };
    const profile = parseCapabilityProfile(document.profiles['remap-profile']);
    assert.deepEqual(profile.implementationPaths, [
      'packages/core/src/legacy.ts',
      'src/**',
    ]);
    assert.deepEqual(profile.forbiddenPaths, ['relocated/secret.ts']);
    assert.equal(
      classifyFileRole(profile, 'packages/core/src/legacy.ts'),
      'implementation',
    );
    assert.equal(classifyFileRole(profile, 'relocated/secret.ts'), 'forbidden');
    assert.deepEqual(
      projected.profiles.map(
        ({ profileId, from, to, beforeRole, afterRole }) => ({
          profileId,
          from,
          to,
          beforeRole,
          afterRole,
        }),
      ),
      [
        {
          profileId: 'remap-profile',
          from: 'secret/legacy.ts',
          to: 'relocated/secret.ts',
          beforeRole: 'forbidden',
          afterRole: 'forbidden',
        },
        {
          profileId: 'remap-profile',
          from: 'src/legacy.ts',
          to: 'packages/core/src/legacy.ts',
          beforeRole: 'implementation',
          afterRole: 'implementation',
        },
      ],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority remap composes one manifest and one existing authority-plan intent without ceremony fields', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    write(repository, 'src/legacy.ts', 'composed\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**', 'src/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**', 'src/**'],
      policyPaths: [
        'openspec/changes/live-remap/guard.json',
        'workflow/maintainer-policy.json',
        'workflow/maintainer-profiles.json',
        'workflow/path-roles.json',
      ],
    });
    updatePathRoles(repository, (roles) => {
      roles.grant = ['src/legacy.ts'];
    });
    updateChecks(repository, (checks) => {
      checks['moved-check'] = {
        command: ['node', 'src/legacy.ts'],
        destructiveDatabase: false,
      };
    });
    writeGuard(
      repository,
      'openspec/changes/live-remap/guard.json',
      'live-remap',
      'src/legacy.ts',
    );
    commitAll(repository, 'Add composed remap fixture');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move composed remap fixture');
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
      authorityPlan: {
        changeId: 'live-remap',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason: 'Project exact live authority paths for one move phase.',
        message: 'Project authority paths for mechanical move',
      },
    } as const;

    const projected = projectAuthorityRemap(request);
    assert.deepEqual(projectAuthorityRemap(request), projected);
    assert.equal(
      projected.manifest.kind,
      'workflow.authority-remap-manifest.v1',
    );
    assert.match(projected.manifest.manifestDigest, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(
      projected.manifest.projections.map(
        ({ path: projectedPath }) => projectedPath,
      ),
      [
        'openspec/changes/live-remap/guard.json',
        'workflow/checks.json',
        'workflow/path-roles.json',
      ],
    );
    assert.deepEqual(projected.manifest.moves[0]?.role, {
      name: 'grant',
      beforePattern: 'src/legacy.ts',
      afterPattern: 'packages/core/src/legacy.ts',
    });
    assert.deepEqual(
      projected.intent?.mutations.map(({ path: mutationPath }) => mutationPath),
      projected.manifest.projections.map(
        ({ path: projectedPath }) => projectedPath,
      ),
    );
    assert.deepEqual(projected.intent?.externalEffects, []);
    assert.deepEqual(projected.intent?.evidenceWaivers, []);
    assert.equal('grant' in (projected.intent ?? {}), false);

    const inputPath = path.join(repository, 'authority-remap-request.json');
    fs.writeFileSync(
      inputPath,
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'workflow.authority-remap-request.v1',
        baseCommit: request.baseCommit,
        moveCommit: request.moveCommit,
        materializationCommit: null,
        renamePairs: request.renamePairs,
        authorityPlan: request.authorityPlan,
      })}\n`,
    );
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--experimental-strip-types',
          path.join(
            sourceRepositoryRoot,
            'packages/workflow-engine/src/cli.ts',
          ),
          'boundary',
          'remap',
          '--input',
          inputPath,
          '--json',
        ],
        { cwd: repository, encoding: 'utf8' },
      ),
    ) as { ok: boolean; result: typeof projected };
    assert.equal(cli.ok, true);
    assert.deepEqual(cli.result, projected);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority remap does not mint an empty authority intent for a policy-neutral move', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    write(repository, 'src/legacy.ts', 'neutral\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**', 'src/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**', 'src/**'],
    });
    commitAll(repository, 'Add policy-neutral source');
    const baseCommit = head(repository);
    move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
    commitAll(repository, 'Move policy-neutral source');

    const projected = projectAuthorityRemap({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [
        { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
      ],
      authorityPlan: {
        changeId: 'neutral-remap',
        taskId: '1.1',
        profileId: 'workflow-engine-root-one-shot',
        reason: 'Prove one policy-neutral mechanical move phase.',
        message: 'Prove policy-neutral mechanical move',
      },
    });
    assert.deepEqual(projected.manifest.projections, []);
    assert.equal(projected.manifest.authorityPlanIntentDigest, null);
    assert.equal(projected.intent, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('engine source moves require the ordered closure regeneration chain instead of appearing policy-neutral', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from = 'packages/workflow-engine/src/legacy.ts';
    const to = 'packages/workflow-engine/src/modules/legacy.ts';
    write(repository, from, 'export const legacy = true;\n');
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**'],
    });
    commitAll(repository, 'Add engine source before remap');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move engine source mechanically');
    const request = {
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'engine-source-remap',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason:
          'Regenerate exact protected closures after an engine source move.',
        message: 'Regenerate authority closures after source move',
      },
    } as const;

    const projected = projectAuthorityRemap(request);
    assert.equal(projected.status, 'requires-regeneration');
    assert.equal(projected.intent, null);
    assert.deepEqual(projected.regeneration?.steps, [
      'built-in-engine-closure',
      'harness-bootstrap-runtime',
      'protected-capabilities',
    ]);
    assert.equal(
      projected.regeneration?.mechanicalProofDigest,
      projected.manifest.mechanicalProofDigest,
    );
    assert.equal(projected.regeneration?.moveTree, projected.manifest.moveTree);
    assert.equal(
      projected.manifest.regenerationDescriptorDigest,
      projected.regeneration?.descriptorDigest,
    );
    assert.match(
      projected.regeneration?.descriptorDigest ?? '',
      /^sha256:[0-9a-f]{64}$/,
    );

    write(repository, 'dirty-worktree-only.ts', 'ignored\n');
    assert.deepEqual(projectAuthorityRemap(request), projected);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workspace package source moves use the pinned v2 closure roots for regeneration', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from = 'packages/core/src/legacy.ts';
    const to = 'packages/core/src/modules/legacy.ts';
    write(repository, from, 'export const legacy = true;\n');
    write(
      repository,
      'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
      `${JSON.stringify({
        kind: 'built-in-engine-closure-manifest.v2',
        entrypoint: 'src/cli.ts',
        scope: 'workspace-runtime-source-closure',
        packages: [
          {
            name: 'jigwright',
            sourceRoot: 'packages/workflow-engine',
            closureRoot: '.',
          },
          {
            name: '@jigwright/core',
            sourceRoot: 'packages/core',
            closureRoot: 'node_modules/@jigwright/core',
          },
        ],
        files: [],
      })}\n`,
    );
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**'],
    });
    commitAll(repository, 'Add workspace package source before remap');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move workspace package source mechanically');

    const projected = projectAuthorityRemap({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'workspace-source-remap',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason: 'Regenerate exact workspace source closures after a move.',
        message: 'Regenerate workspace source closures',
      },
    });
    assert.equal(projected.status, 'requires-regeneration');
    assert.deepEqual(projected.regeneration?.steps, [
      'built-in-engine-closure',
      'harness-bootstrap-runtime',
      'protected-capabilities',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('authority remap rejects retired V1 closure metadata at the pinned base', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from = 'packages/core/src/legacy.ts';
    const to = 'packages/core/src/modules/legacy.ts';
    write(repository, from, 'export const legacy = true;\n');
    write(
      repository,
      'packages/workflow-engine/bootstrap/built-in-engine-closure.json',
      `${JSON.stringify({
        kind: 'built-in-engine-closure-manifest.v1',
        entrypoint: 'src/cli.ts',
        scope: 'package-json-and-all-src-typescript',
        files: [],
      })}\n`,
    );
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**'],
    });
    commitAll(repository, 'Install retired closure metadata');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move workspace source mechanically');

    assert.throws(
      () =>
        projectAuthorityRemap({
          repositoryRoot: repository,
          baseCommit,
          moveCommit: head(repository),
          renamePairs: [{ from, to }],
          authorityPlan: {
            changeId: 'retired-closure-remap',
            taskId: '1.1',
            profileId: 'remap-profile',
            reason: 'Reject retired closure metadata before source remap.',
            message: 'Reject retired closure metadata',
          },
        }),
      (error) =>
        error instanceof Error &&
        isWorkflowError(error, 'AUTHORITY_REMAP_INVALID') &&
        error.message.includes('unsupported version'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('protected closure member moves require regeneration even when they are outside engine src', () => {
  const repository = createFixtureRepository();
  try {
    removeFixtureActiveGuard(repository);
    const from =
      'packages/workflow-engine/bootstrap/generate-protected-capabilities.ts';
    const to =
      'packages/workflow-engine/bootstrap/generate-protected-capabilities-v2.ts';
    write(repository, from, 'export const generator = true;\n');
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/protected-capabilities.json'),
      path.join(repository, 'workflow/protected-capabilities.json'),
    );
    writeMaintainerPolicy(repository, (policy) => {
      policy.bootstrapEligiblePaths = ['packages/**'];
      policy.sealedImmutablePaths = [];
    });
    writeMaintainerProfiles(repository, {
      implementationPaths: ['packages/**'],
    });
    commitAll(repository, 'Add protected closure member before remap');
    const baseCommit = head(repository);
    move(repository, from, to);
    commitAll(repository, 'Move protected closure member mechanically');

    const projected = projectAuthorityRemap({
      repositoryRoot: repository,
      baseCommit,
      moveCommit: head(repository),
      renamePairs: [{ from, to }],
      authorityPlan: {
        changeId: 'protected-closure-remap',
        taskId: '1.1',
        profileId: 'remap-profile',
        reason: 'Regenerate exact protected closure membership after a move.',
        message: 'Regenerate protected closure membership',
      },
    });
    assert.equal(projected.status, 'requires-regeneration');
    assert.deepEqual(projected.regeneration?.affectedMoves, [{ from, to }]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('reviewed content boundary rejects authority artifacts and non-edit statuses', () => {
  for (const variant of ['authority-artifact', 'added-file'] as const) {
    const repository = createFixtureRepository();
    try {
      removeFixtureActiveGuard(repository);
      const from = 'packages/workflow-engine/src/content-boundary-source.ts';
      const to =
        'packages/workflow-engine/src/modules/content-boundary-source.ts';
      write(repository, from, 'export const contentBoundary = true;\n');
      writeMaintainerPolicy(repository, (policy) => {
        policy.bootstrapEligiblePaths = ['packages/**'];
        policy.sealedImmutablePaths = [];
      });
      writeMaintainerProfiles(repository, {
        implementationPaths: ['packages/**'],
      });
      commitAll(repository, 'Add reviewed-content boundary fixture');
      const baseCommit = head(repository);
      move(repository, from, to);
      commitAll(repository, 'Move reviewed-content boundary fixture');
      const moveCommit = head(repository);
      if (variant === 'authority-artifact') {
        updatePathRoles(repository, (roles) => {
          roles.ordinary = [...(roles.ordinary ?? []), 'docs/**'];
        });
      } else {
        write(
          repository,
          'packages/workflow-engine/src/content-boundary-added.ts',
          'export const added = true;\n',
        );
      }
      commitAll(repository, `Add invalid ${variant} content boundary`);

      assert.throws(
        () =>
          projectAuthorityRemap({
            repositoryRoot: repository,
            baseCommit,
            moveCommit,
            materializationCommit: head(repository),
            renamePairs: [{ from, to }],
            authorityPlan: {
              changeId: `reject-${variant}`,
              taskId: '1.1',
              profileId: 'remap-profile',
              reason: 'Reject an invalid reviewed-content boundary commit.',
              message: 'Reject invalid reviewed content',
            },
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('authority remap fails closed when a move hits a code-owned projection endpoint', () => {
  for (const endpoint of ['source', 'target', 'protected-loader'] as const) {
    const repository = createFixtureRepository();
    try {
      removeFixtureActiveGuard(repository);
      const from =
        endpoint === 'source'
          ? 'docs/CURRENT_AND_NEXT_STEPS.md'
          : endpoint === 'protected-loader'
            ? 'packages/workflow-engine/src/adapters/consumer/repository/work-registry/protected-capabilities.ts'
            : 'docs/source-handoff.md';
      const to =
        endpoint === 'source'
          ? 'docs/relocated-handoff.md'
          : endpoint === 'protected-loader'
            ? 'packages/workflow-engine/src/adapters/consumer/repository/work-registry/protected-capabilities-relocated.ts'
            : 'docs/CURRENT_AND_NEXT_STEPS.md';
      write(repository, from, 'generated handoff\n');
      commitAll(repository, `Add ${endpoint} projection endpoint`);
      const baseCommit = head(repository);
      move(repository, from, to);
      commitAll(repository, `Move ${endpoint} projection endpoint`);

      assert.throws(
        () =>
          projectAuthorityRemap({
            repositoryRoot: repository,
            baseCommit,
            moveCommit: head(repository),
            renamePairs: [{ from, to }],
            authorityPlan: {
              changeId: 'projection-remap',
              taskId: '1.1',
              profileId: 'unused-profile',
              reason: 'Reject an unsupported engine projection remap endpoint.',
              message: 'Reject projection registry remap',
            },
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        endpoint,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('mechanical move proof rejects content edits and executable-bit changes', () => {
  for (const mutation of ['content', 'mode'] as const) {
    const repository = createFixtureRepository();
    try {
      write(repository, 'src/legacy.ts', 'original\n');
      commitAll(repository, 'Add legacy source');
      const baseCommit = head(repository);
      move(repository, 'src/legacy.ts', 'packages/core/src/legacy.ts');
      if (mutation === 'content') {
        fs.appendFileSync(
          path.join(repository, 'packages/core/src/legacy.ts'),
          'edited\n',
        );
      } else {
        fs.chmodSync(
          path.join(repository, 'packages/core/src/legacy.ts'),
          0o755,
        );
      }
      commitAll(repository, `Move with ${mutation} mutation`);

      assert.throws(
        () =>
          verifyMechanicalMovePhase({
            repositoryRoot: repository,
            baseCommit,
            moveCommit: head(repository),
            renamePairs: [
              { from: 'src/legacy.ts', to: 'packages/core/src/legacy.ts' },
            ],
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        mutation,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('mechanical move proof rejects a target that aliases an untouched tree path by case', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/legacy.ts', 'same bytes\n');
    write(repository, 'packages/Core.ts', 'untouched\n');
    commitAll(repository, 'Add case-alias fixture');
    const baseCommit = head(repository);
    const objectId = git(repository, [
      'rev-parse',
      `${baseCommit}:src/legacy.ts`,
    ]).trim();
    git(repository, ['config', 'core.ignorecase', 'false']);
    git(repository, ['read-tree', baseCommit]);
    git(repository, ['update-index', '--force-remove', 'src/legacy.ts']);
    git(repository, [
      'update-index',
      '--add',
      '--cacheinfo',
      `100644,${objectId},packages/core.ts`,
    ]);
    const moveTree = git(repository, ['write-tree']).trim();
    const moveCommit = git(repository, [
      'commit-tree',
      moveTree,
      '-p',
      baseCommit,
      '-m',
      'Move into a case-alias collision',
    ]).trim();

    assert.throws(
      () =>
        verifyMechanicalMovePhase({
          repositoryRoot: repository,
          baseCommit,
          moveCommit,
          renamePairs: [{ from: 'src/legacy.ts', to: 'packages/core.ts' }],
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('mechanical move proof rejects undeclared or non-move changes', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/a.ts', 'a\n');
    write(repository, 'src/b.ts', 'b\n');
    commitAll(repository, 'Add legacy sources');
    const baseCommit = head(repository);

    move(repository, 'src/a.ts', 'packages/core/src/a.ts');
    move(repository, 'src/b.ts', 'packages/core/src/b.ts');
    fs.appendFileSync(path.join(repository, 'package.json'), ' \n');
    commitAll(repository, 'Mix moves with another edit');
    const moveCommit = head(repository);

    assert.throws(
      () =>
        verifyMechanicalMovePhase({
          repositoryRoot: repository,
          baseCommit,
          moveCommit,
          renamePairs: [{ from: 'src/a.ts', to: 'packages/core/src/a.ts' }],
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('mechanical move proof rejects symbolic, abbreviated, stale, colliding, and unsafe inputs', () => {
  const repository = createFixtureRepository();
  try {
    write(repository, 'src/a.ts', 'a\n');
    write(repository, 'src/b.ts', 'b\n');
    commitAll(repository, 'Add legacy sources');
    const baseCommit = head(repository);
    move(repository, 'src/a.ts', 'packages/core/src/a.ts');
    commitAll(repository, 'Move one source');
    const moveCommit = head(repository);
    const validPair = {
      from: 'src/a.ts',
      to: 'packages/core/src/a.ts',
    };
    const invalidRequests = [
      { baseCommit: 'HEAD', moveCommit, renamePairs: [validPair] },
      {
        baseCommit: baseCommit.slice(0, 12),
        moveCommit,
        renamePairs: [validPair],
      },
      { baseCommit, moveCommit: baseCommit, renamePairs: [validPair] },
      {
        baseCommit,
        moveCommit,
        renamePairs: [validPair, { ...validPair, to: 'other/a.ts' }],
      },
      {
        baseCommit,
        moveCommit,
        renamePairs: [validPair, { from: 'src/b.ts', to: validPair.to }],
      },
      {
        baseCommit,
        moveCommit,
        renamePairs: [
          { from: 'src/a.ts', to: 'src/b.ts' },
          { from: 'src/b.ts', to: 'packages/core/src/b.ts' },
        ],
      },
      {
        baseCommit,
        moveCommit,
        renamePairs: [{ from: '../src/a.ts', to: validPair.to }],
      },
      {
        baseCommit,
        moveCommit,
        renamePairs: [{ from: validPair.from, to: '.git/config' }],
      },
      {
        baseCommit,
        moveCommit,
        renamePairs: [{ from: 'src/*.ts', to: validPair.to }],
      },
    ];

    for (const invalid of invalidRequests) {
      assert.throws(
        () =>
          verifyMechanicalMovePhase({
            repositoryRoot: repository,
            ...invalid,
          }),
        (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
        JSON.stringify(invalid),
      );
    }

    write(repository, 'later.txt', 'later\n');
    commitAll(repository, 'Advance beyond move commit');
    assert.throws(
      () =>
        verifyMechanicalMovePhase({
          repositoryRoot: repository,
          baseCommit,
          moveCommit: head(repository),
          renamePairs: [validPair],
        }),
      (error) => isWorkflowError(error, 'AUTHORITY_REMAP_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
