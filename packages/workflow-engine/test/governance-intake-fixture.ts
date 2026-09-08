/** Shared governance-intake fixtures; this module registers no tests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { captureGovernanceSource } from '../src/modules/governance-intake/governance-intake.ts';
import { recordGovernanceFinding } from '../src/composition-root/governance-findings-production.ts';
import {
  codeOwnedApprovalModuleRegistry,
  HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
  parseGrantPolicyV2,
} from '../src/modules/authority/grant-policy.ts';
import {
  createWorkItem,
  renderWorkRegistry,
} from '../src/modules/governance-intake/work-registry.ts';

export function snapshotPlainTree(root: string): string[] {
  const entries: string[] = [];
  const visit = (target: string, relativePath: string): void => {
    const stats = fs.lstatSync(target);
    const identity = `${stats.dev}:${stats.ino}:${stats.uid}:${stats.gid}:${stats.mode & 0o777}:${stats.nlink}:${stats.size}`;
    if (stats.isSymbolicLink()) {
      entries.push(
        `link:${relativePath}:${identity}:${fs.readlinkSync(target)}`,
      );
      return;
    }
    if (stats.isFile()) {
      entries.push(
        `file:${relativePath}:${identity}:${fs.readFileSync(target).toString('base64')}`,
      );
      return;
    }
    if (!stats.isDirectory()) {
      entries.push(`other:${relativePath}`);
      return;
    }
    entries.push(`directory:${relativePath}:${identity}`);
    for (const name of fs.readdirSync(target).sort()) {
      visit(path.join(target, name), path.posix.join(relativePath, name));
    }
  };
  visit(root, '.');
  return entries;
}

export function createGovernancePersistenceFixture(root: string) {
  const repositoryRoot = path.join(root, 'repository');
  const runtimeRoot = path.join(root, 'git-common', 'workflow-engine');
  fs.mkdirSync(repositoryRoot, { recursive: true });
  runGitForTest(repositoryRoot, [
    'init',
    '-b',
    'main',
    '--separate-git-dir',
    path.join(root, 'git-common'),
  ]);
  fs.mkdirSync(runtimeRoot, { recursive: true, mode: 0o700 });
  configureRepositoryConsumer(repositoryRoot);
  const sourceInput = {
    semanticAuthor: 'maintainer' as const,
    capturedBy: 'jigwright',
    capturedAt: '2026-08-24T03:13:00.000Z',
    contextRef: 'direct-human:thread/turn-44',
    text: 'Preserve this exact Source across every admission path.\n',
    supersedes: null,
  };
  const source = captureGovernanceSource(repositoryRoot, sourceInput);
  const findingContext = {
    repositoryRoot,
    runtimeRoot,
    sessionId: 'session-governance-persistence',
    changeId: 'governance-persistence',
    branch: 'work/governance-persistence',
    head: 'a'.repeat(40),
    tree: 'b'.repeat(40),
  };
  const findingInput = {
    schemaVersion: 1 as const,
    text: 'The Source persistence boundary needs a durable observation.',
    sourceRefs: [source.source.id],
  };
  const findingNow = () => '2026-08-24T03:14:00.000Z';
  const finding = recordGovernanceFinding(
    findingContext,
    findingInput,
    findingNow,
  );
  const item = createWorkItem(
    repositoryRoot,
    {
      schemaVersion: 1,
      kind: 'chore',
      lane: 'later',
      title: 'Governance persistence boundary',
      summary: 'Keep Source and Finding evidence immutable.',
      sourceRefs: [source.source.id],
    },
    {
      now: () => '2026-08-24T03:15:00.000Z',
      createId: () => 'WORK-01K39R0V000000000000000001',
      aliases: ['ISS-321'],
    },
  );
  const rendered = renderWorkRegistry(repositoryRoot);
  runGitForTest(repositoryRoot, ['config', 'user.name', 'Jigwright Test']);
  runGitForTest(repositoryRoot, [
    'config',
    'user.email',
    'jigwright@example.test',
  ]);
  runGitForTest(repositoryRoot, ['add', '.']);
  runGitForTest(repositoryRoot, ['commit', '-m', 'Track governance state']);
  return {
    root,
    repositoryRoot,
    runtimeRoot,
    sourceInput,
    source,
    sourcePath: path.join(repositoryRoot, source.relativePath),
    sourceLedgerRoot: path.join(
      repositoryRoot,
      'workflow/source-ledger/objects/sha256',
    ),
    findingContext,
    findingInput,
    findingNow,
    finding,
    item,
    rendered,
  };
}

export function snapshotGovernancePersistence(
  fixture: ReturnType<typeof createGovernancePersistenceFixture>,
  targets: readonly string[] = [],
) {
  return {
    head: runGitForTest(fixture.repositoryRoot, ['rev-parse', 'HEAD']),
    refs: runGitForTest(fixture.repositoryRoot, ['show-ref']),
    status: runGitForTest(fixture.repositoryRoot, [
      'status',
      '--porcelain=v1',
      '-z',
    ]),
    sources: snapshotPlainTree(fixture.sourceLedgerRoot),
    findings: snapshotFindingRefForTest(fixture.repositoryRoot),
    items: snapshotPlainTree(
      path.join(fixture.repositoryRoot, 'docs/work-registry/items'),
    ),
    targets: targets.map((target) => snapshotPlainTree(target)),
    backlog: fs.readFileSync(fixture.rendered.backlogPath, 'utf8'),
    inventory: fs.readFileSync(fixture.rendered.inventoryPath, 'utf8'),
  };
}

export function runGitForTest(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export function configureRepositoryConsumer(repositoryRoot: string): void {
  const workflowRoot = path.join(repositoryRoot, 'workflow');
  fs.mkdirSync(workflowRoot, { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, 'openspec/changes'), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(workflowRoot, 'config.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      repositoryName: 'fixture',
      changeRoot: 'openspec/changes',
      runtimeDirectory: 'jigwright-runtime',
      protectedBranches: ['main'],
      branchTemplate: 'changes/{changeId}',
    })}\n`,
  );
  fs.writeFileSync(
    path.join(workflowRoot, 'repository-consumer.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      adapterId: 'configured-repository-v1',
      consumerId: 'fixture',
      planning: {
        providerId: 'openspec',
        packageSchemaNames: ['spec-driven'],
        requiredSchemaNames: ['spec-driven', 'fixture'],
        supportedSchemaNames: ['spec-driven', 'fixture'],
        managedSchemaNames: ['fixture'],
        currentSchemaName: 'fixture',
      },
      documents: {
        adapterId: 'filesystem-documents-v1',
        handoffPath: 'docs/CURRENT_AND_NEXT_STEPS.md',
      },
      workRegistry: {
        adapterId: 'filesystem-work-registry-v1',
        itemRoot: 'docs/work-registry/items',
        inventoryPath: 'docs/work-registry/inventory.json',
        backlogPath: 'docs/BACKLOG.md',
        historyRoot: 'docs/work-history',
        transitionPolicyPath: 'workflow/work-registry-policy.json',
        changeOriginRoot: 'openspec/changes',
      },
      databasePolicy: { adapterId: 'disabled-v1' },
    })}\n`,
  );
}

export function workRegistryGrantPolicy() {
  return parseGrantPolicyV2(
    {
      schemaVersion: 2,
      defaultProfile: 'local-presence',
      profiles: {
        'local-presence': {
          requiredClaims: ['fresh-local-device-owner'],
        },
      },
      approvalModules: [
        {
          moduleId: 'human-gate-macos',
          version: '1',
          allowedClaims: ['fresh-local-device-owner'],
          configurationDigest: HUMAN_GATE_MACOS_V1_CONFIGURATION_DIGEST,
        },
      ],
    },
    { registry: codeOwnedApprovalModuleRegistry() },
  );
}

export function hasCode(expectedCode: string): (error: unknown) => boolean {
  return (error: unknown) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === expectedCode;
}

export function readFindingRecordForTest(
  repositoryRoot: string,
  location: string,
): Buffer {
  const result = spawnSync('git', ['show', location], { cwd: repositoryRoot });
  assert.equal(result.status, 0, result.stderr?.toString());
  return result.stdout;
}

export function snapshotFindingRefForTest(repositoryRoot: string): string {
  return runGitForTest(repositoryRoot, [
    'rev-parse',
    'refs/heads/jigwright/findings',
  ]);
}

/** Build fixture corruption with an isolated Git index, leaving task files alone. */
export function changeFindingRecordForTest(
  repositoryRoot: string,
  location: string,
  content: string | null,
  mode = '100644',
): void {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-finding-object-'),
  );
  const recordPath = location.slice(location.indexOf(':') + 1);
  const ref = 'refs/heads/jigwright/findings';
  const git = (args: string[], input?: string): string => {
    const result = spawnSync('git', args, {
      cwd: repositoryRoot,
      encoding: 'utf8',
      input,
      env: { ...process.env, GIT_INDEX_FILE: path.join(temporary, 'index') },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    git(['read-tree', ref]);
    if (content === null) git(['update-index', '--force-remove', recordPath]);
    else {
      const blob = git(['hash-object', '-w', '--stdin'], content);
      git(['update-index', '--add', '--cacheinfo', mode, blob, recordPath]);
    }
    const head = git([
      'commit-tree',
      git(['write-tree']),
      '-p',
      ref,
      '-m',
      'Fixture Finding record',
    ]);
    git(['update-ref', ref, head]);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
