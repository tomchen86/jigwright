import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { productionChangeRoutingInspector } from '../src/composition-root/change-routing-observation-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const renderHandoff = renderHandoffWithContractReader.bind(
  undefined,
  productionChangeRoutingInspector,
  productionChangeContractReader,
);
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );
/** Shared task-diff-review-inspection fixtures; this module registers no tests. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { loadWorkflowConfig } from '../src/runtime/repository-observation/workflow-configuration.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { renderHandoff as renderHandoffWithContractReader } from '../src/adapters/consumer/repository/handoff/handoff.ts';
import {
  verifySshSignatureWithPublicKey,
  type MaintainerSignerProvider,
} from '../src/adapters/signing/ssh/maintainer-signer.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';
import { readProviderInvocationRequest } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  inspectTaskDiffReviewStatus,
  inspectTaskDiffReviewSubject,
} from '../src/composition-root/task-diff-review-production.ts';
import type { TaskDiffReviewSubmission } from '../src/modules/assurance/task-diff-review-artifact-record.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from '../src/modules/assurance/task-diff-review.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';

export function createReviewFixture(
  options: {
    configurePathRoles?: (registry: {
      roles: Record<string, string[]>;
    }) => void;
    configureAdapterPolicy?: (policy: {
      providers: Record<'codex' | 'claude', { enabled: boolean }>;
    }) => void;
    configureMaintainerPolicy?: (policy: {
      trustedSigners: Array<{
        identity: string;
        publicKey: string;
        fingerprint: string;
      }>;
    }) => void;
    additionalAllowedPaths?: readonly string[];
    forceDiffReviewRequired?: boolean;
  } = {},
): {
  repository: string;
  counterPath: string;
} {
  const repository = createFixtureRepository();
  const counterPath = path.join(repository, '.git', 'review-diff-count');
  writeReadyV3ExemptChange(repository);
  const documentPolicyPath = path.join(
    repository,
    'workflow/document-policy.json',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(documentPolicyPath, 'utf8'),
  ) as { documents: Record<string, unknown> };
  documentPolicy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
    mode: 'generated',
    enforcement: 'active',
    transition: 'completion',
  };
  fs.writeFileSync(
    documentPolicyPath,
    `${JSON.stringify(documentPolicy, null, 2)}\n`,
  );
  fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
  renderHandoff(repository);
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/path-roles.json'),
    path.join(repository, 'workflow/path-roles.json'),
  );
  if (options.configurePathRoles) {
    const registryPath = path.join(repository, 'workflow/path-roles.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as {
      roles: Record<string, string[]>;
    };
    options.configurePathRoles(registry);
    fs.writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
  }
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
    path.join(repository, 'workflow/maintainer-policy.json'),
  );
  if (options.configureMaintainerPolicy) {
    const policyPath = path.join(repository, 'workflow/maintainer-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      trustedSigners: Array<{
        identity: string;
        publicKey: string;
        fingerprint: string;
      }>;
    };
    options.configureMaintainerPolicy(policy);
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  }
  if (options.configureAdapterPolicy) {
    const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
      providers: Record<'codex' | 'claude', { enabled: boolean }>;
    };
    options.configureAdapterPolicy(policy);
    fs.writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
  }
  configureCountingCheck(repository, counterPath);
  git(repository, ['checkout', '-b', 'work/demo-change']);
  if (options.additionalAllowedPaths !== undefined) {
    const guardPath = path.join(
      repository,
      'openspec/changes/demo-change/guard.json',
    );
    const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
      tasks: Record<string, { allowedPaths: string[] }>;
    };
    for (const policy of Object.values(guard.tasks)) {
      policy.allowedPaths = [
        ...new Set([...policy.allowedPaths, ...options.additionalAllowedPaths]),
      ];
    }
    fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  }
  writeReadyV3ExemptChange(
    repository,
    'demo-change',
    options.forceDiffReviewRequired === true
      ? { diffReview: 'required' }
      : undefined,
  );
  commitPlanningTransition(repository, 'demo-change');
  return { repository, counterPath };
}

export function configureCountingCheck(
  repository: string,
  counterPath: string,
): void {
  fs.writeFileSync(
    path.join(repository, 'scripts/count-review-diff.mjs'),
    [
      "import fs from 'node:fs';",
      'const counterPath = process.argv[2];',
      "const current = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
      'fs.writeFileSync(counterPath, String(current + 1));',
      '',
    ].join('\n'),
  );
  configureChecks(
    repository,
    {
      counted: {
        command: ['node', 'scripts/count-review-diff.mjs', counterPath],
        destructiveDatabase: false,
      },
    },
    ['counted'],
  );
}

export function investigationRuntime(repository: string) {
  const repo = discoverRepository(repository);
  const config = loadWorkflowConfig(repo.repositoryRoot);
  return investigationRuntimePaths(
    repo.gitCommonDirectory,
    config.runtimeDirectory,
  );
}

export function validTaskDiffSubmission(
  blobObjectId: string,
  subject: ReturnType<typeof inspectTaskDiffReviewStatus>['subject'],
): TaskDiffReviewSubmission {
  return {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...TASK_DIFF_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'repository-location',
          path: 'src/feature.ts',
          line: 1,
          blobObjectId,
          observation: 'The exact candidate preserves the declared invariant.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    riskPathDispositions: subject.reviewRequirement.riskPaths.map(
      ({ path, role }) => ({
        path,
        role: role as TaskDiffReviewSubmission['riskPathDispositions'][number]['role'],
        outcome: 'no-challenge',
      }),
    ),
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact canonical candidate.',
    ...(subject.documentationRequirement?.required === true
      ? {
          documentationAssessment: {
            decision: 'no-impact' as const,
            notes:
              'The synthetic candidate changes no public or operator documentation contract.',
          },
        }
      : {}),
  };
}

export function challengedTaskDiffSubmission(
  blobObjectId: string,
  subject: ReturnType<typeof inspectTaskDiffReviewStatus>['subject'],
): TaskDiffReviewSubmission {
  const base = validTaskDiffSubmission(blobObjectId, subject);
  const evidence =
    base.scopeAssessment.kind === 'no-challenge'
      ? base.scopeAssessment.evidence
      : [];
  return {
    ...base,
    verdict: 'advisory-reject',
    scopeAssessment: { kind: 'challenges' },
    findings: [
      {
        kind: 'challenge',
        severity: 'high',
        category: 'correctness-and-invariants',
        currentChangeImpact: 'required',
        summary: 'The changed branch may violate the task invariant.',
        evidence,
      },
    ],
    riskPathDispositions: base.riskPathDispositions.map((entry) => ({
      ...entry,
      outcome: 'challenge-raised',
    })),
  };
}

export function executableIdentity() {
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

export function writeFixtureProviderRuntime(
  invocationDirectory: string,
  semanticOutput: unknown,
): void {
  const runtime = path.join(invocationDirectory, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', '{}\n'],
    ['schema.json', '{}\n'],
    ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
  ] as const) {
    fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
  }
}

export function snapshotTree(root: string): readonly string[] {
  if (!fs.existsSync(root)) return [];
  const visit = (directory: string): string[] =>
    fs
      .readdirSync(directory)
      .sort()
      .flatMap((name) => {
        const target = path.join(directory, name);
        const relative = path.relative(root, target);
        const stat = fs.lstatSync(target);
        if (stat.isDirectory()) {
          return [`d:${relative}:${stat.mode}`, ...visit(target)];
        }
        return [
          `f:${relative}:${stat.mode}:${stat.size}:${fs.readFileSync(target).toString('base64')}`,
        ];
      });
  return visit(root);
}

export function providerWireResult(
  request: ReturnType<typeof readProviderInvocationRequest>,
  output: unknown,
) {
  return {
    schemaVersion: 1,
    requestDigest: request.requestDigest,
    invocationId: request.invocationId,
    nonce: request.nonce,
    purpose: request.purpose,
    providerId: request.providerId,
    roleAssignmentDigest: request.roleAssignmentDigest,
    capabilityProfile: request.capabilityProfile,
    repositoryId: request.repositoryId,
    baseCommit: request.baseCommit,
    baseTree: request.baseTree,
    targetDigest: request.targetDigest,
    inputManifestDigest: request.inputManifestDigest,
    authorizationNodeId: request.authorizationNodeId,
    outputSchema: request.outputSchema,
    evaluatorVersion: request.evaluatorVersion,
    policyDigest: request.policyDigest,
    limits: request.limits,
    observedTouchedPaths: [],
    output,
  };
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function createTaskDiffReviewSigningFixture(): {
  signer: MaintainerSignerProvider;
  trustedSigner: {
    identity: string;
    publicKey: string;
    fingerprint: string;
  };
  dispose(): void;
} {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'task-diff-review-signing-')),
  );
  const keyPath = path.join(root, 'review-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
  const publicKey = fs
    .readFileSync(`${keyPath}.pub`, 'utf8')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join(' ');
  const fingerprint = execFileSync(
    'ssh-keygen',
    ['-l', '-E', 'sha256', '-f', `${keyPath}.pub`],
    { encoding: 'utf8' },
  ).match(/SHA256:[A-Za-z0-9+/]+/)?.[0];
  if (!fingerprint)
    throw new Error('TaskDiffReview fixture fingerprint missing.');
  const identity = 'task-diff-review-maintainer';
  const signer: MaintainerSignerProvider = {
    assertHumanPresent() {},
    identity: () => identity,
    sign(payload, namespace) {
      assert.ok(namespace);
      const payloadPath = path.join(root, 'payload');
      fs.writeFileSync(payloadPath, payload, { mode: 0o600 });
      execFileSync('ssh-keygen', [
        '-Y',
        'sign',
        '-f',
        keyPath,
        '-n',
        namespace,
        payloadPath,
      ]);
      const signature = fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      fs.rmSync(payloadPath, { force: true });
      fs.rmSync(`${payloadPath}.sig`, { force: true });
      return signature;
    },
    verify(payload, signature, requestedIdentity, namespace) {
      assert.ok(namespace);
      verifySshSignatureWithPublicKey(
        payload,
        signature,
        requestedIdentity,
        publicKey,
        namespace,
      );
    },
  };
  return {
    signer,
    trustedSigner: { identity, publicKey, fingerprint },
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export function runCli(
  repository: string,
  args: string[],
  environment: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.resolve(import.meta.dirname, '../bootstrap/workflow-engine-host.ts'),
      ...args,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    },
  );
}

export function snapshotRepositoryObservation(repository: string): {
  status: string;
  runtime: Array<readonly [string, string]>;
} {
  const root = runtimeRoot(repository);
  return {
    status: git(repository, ['status', '--porcelain=v2', '-z']),
    runtime: fs
      .readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map(String)
      .sort()
      .filter((relativePath) =>
        fs.lstatSync(path.join(root, relativePath)).isFile(),
      )
      .map(
        (relativePath) =>
          [
            relativePath,
            fs.readFileSync(path.join(root, relativePath), 'hex'),
          ] as const,
      ),
  };
}

export function snapshotFilesUnder(
  directory: string,
): Array<readonly [string, string]> {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { recursive: true, encoding: 'utf8' })
    .map(String)
    .sort()
    .filter((relativePath) =>
      fs.lstatSync(path.join(directory, relativePath)).isFile(),
    )
    .map(
      (relativePath) =>
        [
          relativePath,
          fs.readFileSync(path.join(directory, relativePath), 'hex'),
        ] as const,
    );
}

export function externalReviewGrantInput(
  subject: ReturnType<typeof inspectTaskDiffReviewSubject>,
  callerId: string,
) {
  return {
    changeId: subject.changeId,
    taskId: subject.taskId,
    baselineCommit: subject.baseCommit,
    baselineTree: subject.baseTree,
    targetDigest: subject.subjectDigest,
    lifecyclePhase: 'task-diff-review' as const,
    rolePair: {
      authorRole: 'task-implementer' as const,
      conflictingRole: 'task-diff-reviewer' as const,
    },
    availableActor: {
      kind: 'caller' as const,
      callerId,
      assurance: 'self-declared' as const,
    },
    degradedForm: 'caller-supplied' as const,
    reason: 'No provider reviewer is callable for this exact subject.',
    ttlMinutes: 30,
    maxUses: 1 as const,
  };
}

export function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code;
}
