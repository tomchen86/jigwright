import { planningTransitionExecution as productionPlanningExecution } from '../../src/composition-root/planning-execution-epoch-production.ts';
import { managedDocuments } from '../../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../../src/composition-root/consumer-contract-production.ts';
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );
import {
  createFixtureRepository,
  configureChecks,
  sourceRepositoryRoot,
  git,
  writeReadyV3ExemptChange,
  isWorkflowError,
  builtInProviderExecutableIdentityForTest,
  builtInProviderDefinitionSnapshotForTest,
} from '../fixture.ts';
import path from 'node:path';
import fs from 'node:fs';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../../src/application/propose/planning-transition.ts';
import os from 'node:os';
import { runGitWithEnvironment } from '../../src/runtime/repository-transaction/git.ts';
import { createHash } from 'node:crypto';
import { runProviderWorker } from '../../src/entrypoints/worker/provider-worker.ts';
import { canonicalJson } from '../../src/foundation/canonical-json/canonical-json.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../../src/runtime/provider-execution/provider-runner.ts';
import { spawnSync } from 'node:child_process';
import { type MaintainerSignerProvider } from '../../src/adapters/signing/ssh/maintainer-signer.ts';
import assert from 'node:assert/strict';
import { type CollaborationGrantRequest } from '../../src/modules/authority/collaboration-grant-codec.ts';

export function createCrossAgentFixture(
  failureCategory: 'assertion' | 'syntax',
  strategy: 'cross-agent-tdd' | 'tdd-single-agent' = 'cross-agent-tdd',
  providers: Readonly<{ codex: boolean; claude: boolean }> = {
    codex: true,
    claude: true,
  },
  includeMaintainerPolicy = false,
  includeFailingGreenCheck = false,
): { repository: string; counterPath: string } {
  const repository = createFixtureRepository();
  const counterPath = path.join(repository, '.git', 'red-check-count');
  fs.writeFileSync(
    path.join(repository, 'scripts/red-runner.mjs'),
    [
      "import fs from 'node:fs';",
      'const counterPath = process.argv[2];',
      'const failureCategory = process.argv[3];',
      "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      'fs.writeFileSync(counterPath, String(count + 1));',
      "if (fs.existsSync('src/feature.ts')) process.exit(0);",
      'const result = {',
      '  schemaVersion: 1,',
      "  kind: 'workflow-red-check-result.v1',",
      "  outcome: 'expected-red',",
      '  failureCategory,',
      "  selector: 'feature behavior',",
      "  testPaths: ['test/feature.test.mjs'],",
      '};',
      'process.stdout.write(`WORKFLOW_RED_CHECK_RESULT ${JSON.stringify(result)}\\n`);',
      'process.exit(1);',
      '',
    ].join('\n'),
  );
  if (includeFailingGreenCheck) {
    fs.writeFileSync(
      path.join(repository, 'scripts/green-fail.mjs'),
      [
        "import fs from 'node:fs';",
        "const source = fs.existsSync('src/feature.ts') ? fs.readFileSync('src/feature.ts', 'utf8') : '';",
        "if (!source.includes('corrected = true')) {",
        "  process.stderr.write('implementation remains incorrect\\n');",
        '  process.exit(1);',
        '}',
        '',
      ].join('\n'),
    );
  }
  configureChecks(
    repository,
    {
      red: {
        command: [
          'node',
          'scripts/red-runner.mjs',
          counterPath,
          failureCategory,
        ],
        destructiveDatabase: false,
      },
      ...(includeFailingGreenCheck
        ? {
            'green-fail': {
              command: ['node', 'scripts/green-fail.mjs'],
              destructiveDatabase: false,
            },
          }
        : {}),
    },
    includeFailingGreenCheck ? ['green-fail', 'red'] : ['red'],
  );
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  guard.tasks['1.1']!.allowedPaths = ['src/**', 'test/**'];
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  if (includeMaintainerPolicy) {
    const maintainerPolicyPath = path.join(
      repository,
      'workflow/maintainer-policy.json',
    );
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      maintainerPolicyPath,
    );
    const maintainerPolicy = JSON.parse(
      fs.readFileSync(maintainerPolicyPath, 'utf8'),
    ) as { repository: { origin: string } };
    git(repository, [
      'config',
      'remote.origin.url',
      maintainerPolicy.repository.origin,
    ]);
    git(repository, ['add', 'workflow/maintainer-policy.json']);
    if (
      git(repository, ['diff', '--cached', '--name-only']).trim().length > 0
    ) {
      git(repository, ['commit', '-m', 'Configure fixture maintainer policy']);
    }
  }
  if (!providers.codex || !providers.claude) {
    const providerPolicyPath = path.join(
      repository,
      'workflow/ai-adapter-policy.json',
    );
    const providerPolicy = JSON.parse(
      fs.readFileSync(providerPolicyPath, 'utf8'),
    ) as {
      providers: Record<'codex' | 'claude', { enabled: boolean }>;
    };
    providerPolicy.providers.codex.enabled = providers.codex;
    providerPolicy.providers.claude.enabled = providers.claude;
    fs.writeFileSync(
      providerPolicyPath,
      `${JSON.stringify(providerPolicy, null, 2)}\n`,
    );
    git(repository, ['add', 'workflow/ai-adapter-policy.json']);
    git(repository, [
      'commit',
      '-m',
      'Configure fixture provider availability',
    ]);
  }
  git(repository, ['checkout', '-b', 'work/demo-change']);
  writeReadyV3ExemptChange(repository, 'demo-change', {
    executionTask({ policy }) {
      const common = {
        enforcement: 'planned' as const,
        allowedPaths: policy.allowedPaths,
        requiredChecks: policy.requiredChecks,
        diffReview: 'required' as const,
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Demo succeeds',
          },
        ],
        testPathScopes: ['test/**'],
        fixturePathScopes: ['test/fixtures/**'],
        implementationPathScopes: ['src/**'],
        redCheck: 'red',
        greenChecks: includeFailingGreenCheck ? ['green-fail', 'red'] : ['red'],
      };
      return strategy === 'cross-agent-tdd'
        ? {
            ...common,
            strategy,
            requiredImplementerIndependence: 'session-independent',
          }
        : {
            ...common,
            strategy,
            requiredImplementerIndependence: 'none',
          };
    },
  });
  commitPlanningTransition(repository, 'demo-change');
  return { repository, counterPath };
}

export function hasCode(code: string): (error: unknown) => boolean {
  return (error) => isWorkflowError(error, code);
}

export function hasCodeAndRecovery(
  code: string,
  recovery: string,
): (error: unknown) => boolean {
  return (error) =>
    hasCode(code)(error) &&
    typeof error === 'object' &&
    error !== null &&
    'recovery' in error &&
    error.recovery === recovery;
}

export function diffAgainstTree(
  repository: string,
  tree: string,
  paths: string[],
): Buffer {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-strategy-test-patch-'),
  );
  const environment = {
    GIT_INDEX_FILE: path.join(temporaryDirectory, 'index'),
  };
  const literals = paths.map((entry) => `:(literal)${entry}`);
  try {
    runGitWithEnvironment(repository, ['read-tree', tree], environment);
    runGitWithEnvironment(
      repository,
      ['add', '-A', '--', ...literals],
      environment,
    );
    return Buffer.from(
      runGitWithEnvironment(
        repository,
        [
          'diff',
          '--cached',
          '--binary',
          '--full-index',
          '--no-renames',
          tree,
          '--',
          ...literals,
        ],
        environment,
      ),
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function sha256Buffer(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function taskImplementationOutput(
  sessionId: string,
  sourceTree: string,
  patch: Buffer,
) {
  return {
    schemaVersion: 1 as const,
    kind: 'task-strategy-patch-output.v1' as const,
    sessionId,
    sourceTree,
    patchBase64: patch.toString('base64'),
    patchDigest: sha256Buffer(patch),
  };
}

export function completeTaskImplementationProvider(
  repository: string,
  invocationId: string,
  providerId: 'codex' | 'claude',
  output: ReturnType<typeof taskImplementationOutput>,
) {
  return runProviderWorker(repository, invocationId, {
    runner(input) {
      return {
        invocationId,
        providerId,
        purpose: 'task-implementation',
        requestDigest: input.request.requestDigest,
        semanticOutput: output,
        semanticOutputDigest: sha256Buffer(Buffer.from(canonicalJson(output))),
        assurance: 'unchanged-governed-projection',
        projection: {
          unchanged: true,
          changedCategories: [],
          beforeDigest: '7'.repeat(64),
          afterDigest: '7'.repeat(64),
        },
        sameUserProcessConfined: false,
        residuals: [...PROVIDER_RUNNER_RESIDUALS],
        executable: builtInProviderExecutableIdentityForTest(input.providerId),
        elapsedMs: 8,
        providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
          input.providerId,
        ),
      };
    },
  });
}

export function runWorkflowCli(
  repository: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(
        sourceRepositoryRoot,
        'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
      ),
      ...args,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    },
  );
}

export function redRevisionInput(input: {
  sessionId: string;
  expectedTransactionDigest: string;
  reason: string;
}): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-strategy-red-revision-input-'),
  );
  const filePath = path.join(directory, 'input.json');
  fs.writeFileSync(
    filePath,
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'task-strategy-red-revision-request',
      ...input,
    })}\n`,
    { mode: 0o600 },
  );
  return filePath;
}

function executableIdentity() {
  return {
    candidatePath: '/opt/homebrew/bin/claude',
    realPath: '/opt/homebrew/bin/claude',
    device: '1',
    inode: '2',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 1024,
    mtimeNs: '123456789',
    sha256: 'b'.repeat(64),
  };
}

export function collaborationSigner(
  identity: string,
): MaintainerSignerProvider {
  return {
    assertHumanPresent() {},
    identity() {
      return identity;
    },
    sign(payload, namespace) {
      assert.ok(namespace);
      return collaborationSignature(payload, namespace);
    },
    verify(payload, signature, observedIdentity, namespace) {
      assert.ok(namespace);
      if (
        observedIdentity !== identity ||
        signature !== collaborationSignature(payload, namespace)
      ) {
        const error = new Error('invalid collaboration signature') as Error & {
          code: string;
        };
        error.code = 'MAINTAINER_SIGNATURE_INVALID';
        throw error;
      }
    },
  };
}

export function callerImplementationGrantRequest(
  session: Readonly<{ baseline: Readonly<{ head: string; tree: string }> }>,
  subjectDigest: string,
  callerId: string,
): CollaborationGrantRequest {
  return {
    changeId: 'demo-change',
    taskId: '1.1',
    baselineCommit: session.baseline.head,
    baselineTree: session.baseline.tree,
    targetDigest: subjectDigest,
    lifecyclePhase: 'task-implementation',
    rolePair: {
      authorRole: 'red-author',
      conflictingRole: 'task-implementer',
    },
    availableActor: {
      kind: 'caller',
      callerId,
      assurance: 'self-declared',
    },
    degradedForm: 'caller-supplied',
    reason:
      'No callable task implementation provider is enabled for this exact sealed RED subject.',
    ttlMinutes: 30,
    maxUses: 1,
  };
}

function collaborationSignature(payload: string, namespace: string): string {
  const encoded = createHash('sha256')
    .update(`${namespace}\0${payload}`)
    .digest('base64');
  return [
    '-----BEGIN SSH SIGNATURE-----',
    encoded,
    '-----END SSH SIGNATURE-----',
    '',
  ].join('\n');
}

export function snapshotTree(root: string): Array<{
  path: string;
  kind: 'directory' | 'file';
  ino: number;
  mode: number;
  mtimeMs: number;
  content: string | null;
}> {
  const entries: Array<{
    path: string;
    kind: 'directory' | 'file';
    ino: number;
    mode: number;
    mtimeMs: number;
    content: string | null;
  }> = [];
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stats = fs.lstatSync(absolute);
      const relative = path.relative(root, absolute);
      if (stats.isDirectory()) {
        entries.push({
          path: relative,
          kind: 'directory',
          ino: stats.ino,
          mode: stats.mode,
          mtimeMs: stats.mtimeMs,
          content: null,
        });
        visit(absolute);
      } else if (stats.isFile()) {
        entries.push({
          path: relative,
          kind: 'file',
          ino: stats.ino,
          mode: stats.mode,
          mtimeMs: stats.mtimeMs,
          content: fs.readFileSync(absolute, 'utf8'),
        });
      }
    }
  };
  visit(root);
  return entries;
}

export function snapshotPersistentTree(
  root: string,
): ReturnType<typeof snapshotTree> {
  return snapshotTree(root).map((entry) =>
    entry.kind === 'directory' && path.basename(entry.path) === 'locks'
      ? { ...entry, mtimeMs: 0 }
      : entry,
  );
}
