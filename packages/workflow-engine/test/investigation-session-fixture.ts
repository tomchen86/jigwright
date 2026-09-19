/** Shared investigation-session fixtures; this module registers no tests. */
import { readProviderRetryAccountingEvidence } from '../src/runtime/storage-journal/provider-retry-accounting-reader.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
  loadAiAdapterPolicy,
} from '../src/runtime/provider-policy/ai-adapter-policy.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import type { InvestigationManifestV3 } from '../src/modules/investigation/manifest/investigation-manifest-types.ts';
import type { InvestigationPlanReviewCoverageRequirementV3 } from '../src/modules/investigation/manifest/investigation-requirement-types.ts';
import {
  createEvidenceNode,
  type EvidenceNode,
} from '../src/foundation/evidence-node/evidence-node.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import {
  createInvestigationCheckpointEnvelope,
  startInvestigationSession as startInvestigationSessionWithMandate,
  type GrantCoreHumanResolutionAuthorization,
  type GrantCoreHumanResolutionExecutionOptions,
} from '../src/adapters/planning/investigation/investigation-session.ts';
import { executeGrantCoreHumanResolution } from '../src/composition-root/investigation-retry-production.ts';
import {
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderExecutableIdentity,
  type ProviderRunnerHost,
  type ProviderRunnerReport,
} from '../src/runtime/provider-execution/provider-runner.ts';
import {
  inspectInvestigationQuarantineState,
  inspectInvestigationResolutionState,
} from '../src/runtime/storage-journal/human-resolution-state.ts';
import {
  type HumanResolutionConsequences,
  type HumanResolutionDecision,
} from '../src/modules/investigation/domain/human-resolution-contract.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';
import { investigationManifestPublicationNamespace } from '../src/modules/investigation/manifest/investigation-publication-contracts.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import { authorizeAutomaticProviderRetry } from '../src/modules/provider-orchestration/provider-retry-decision.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  claimProviderInvocation,
  completeProviderInvocation,
  createProviderInvocation,
  failProviderInvocation,
  readProviderInvocationRequest,
  storeProviderExecutionPolicySnapshot,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import type { BlindSurveyManifest } from '../src/modules/investigation/manifest/blind-survey-manifest.ts';
import { humanResolutionBlockerBinding } from '../src/modules/investigation/domain/human-resolution-grant-contract.ts';
import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
} from './fixture.ts';
import {
  runtimePaths as workflowRuntimePaths,
  withRepositoryLifecycleOperation,
} from '../src/runtime/session-workspace/session-store.ts';

export const FIRST_INSTANT = '2026-07-24T00:00:00.000Z';

export const DURING_COMPLETION_GRACE = '2026-07-24T00:00:01.100Z';

export const BEFORE_EXPIRY = '2026-07-24T00:00:30.999Z';

export const AT_EXPIRY = '2026-07-24T00:00:31.000Z';

export const WORKFLOW_SOURCE_MODULE_PATHS = {
  'session-store.ts': 'runtime/session-workspace/session-store.ts',
  'planning-lock.ts': 'runtime/session-workspace/planning-lock.ts',
  'human-resolution-grant-store.ts':
    'runtime/storage-journal/human-resolution-grant-store.ts',
  'investigation-session.ts':
    'composition-root/investigation-retry-production.ts',
  'propose-orchestrator.ts': 'composition-root/propose-production.ts',
  'evidence-object-store.ts':
    'runtime/storage-journal/evidence-object-store.ts',
  'filesystem-safety.ts': 'runtime/repository-transaction/filesystem-safety.ts',
  'paths.ts': 'runtime/paths/runtime-paths.ts',
  'session.ts': 'application/execute-task/session.ts',
} as const;

export const SESSION_STORE_MODULE_URL =
  workflowSourceModuleUrl('session-store.ts');

export const PLANNING_LOCK_MODULE_URL =
  workflowSourceModuleUrl('planning-lock.ts');

export const HUMAN_RESOLUTION_GRANT_STORE_MODULE_URL = workflowSourceModuleUrl(
  'human-resolution-grant-store.ts',
);

export const INVESTIGATION_SESSION_MODULE_URL = workflowSourceModuleUrl(
  'investigation-session.ts',
);

export const PROPOSE_ORCHESTRATOR_MODULE_URL = workflowSourceModuleUrl(
  'propose-orchestrator.ts',
);

export const EVIDENCE_STORE_MODULE_URL = workflowSourceModuleUrl(
  'evidence-object-store.ts',
);

export const FILESYSTEM_SAFETY_MODULE_URL = workflowSourceModuleUrl(
  'filesystem-safety.ts',
);

export const PATHS_MODULE_URL = workflowSourceModuleUrl('paths.ts');

export const SESSION_MODULE_URL = workflowSourceModuleUrl('session.ts');

export function planReviewCoverageEvidence(
  investigation: InvestigationManifestV3,
) {
  const output =
    investigation.applicability.kind === 'ordinary'
      ? investigation.applicability.semanticDelta.investigationRequirements.find(
          (
            requirement,
          ): requirement is InvestigationPlanReviewCoverageRequirementV3 =>
            requirement.kind === 'plan-review-coverage-requirement',
        )?.coverage
      : undefined;
  assert.ok(output);
  const required = new Set(output.requiredTargetIds);
  return [
    ...new Set(
      output.targetBindings
        .filter(({ targetId }) => required.has(targetId))
        .map(({ path: targetPath }) => targetPath),
    ),
  ]
    .sort()
    .map((targetPath) => ({
      kind: 'repository-location' as const,
      path: targetPath,
      line: 1,
      observation: 'The engine-required review target was examined.',
    }));
}

export function setFixtureProviderTimeout(
  repository: string,
  timeoutMs: number,
): void {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')) as {
    limits: { timeoutMs: number };
  };
  policy.limits.timeoutMs = timeoutMs;
  fs.writeFileSync(policyPath, `${canonicalJson(policy)}\n`, 'utf8');
}

export type InvestigationFixture = {
  repository: string;
  paths: ReturnType<typeof investigationRuntimePaths>;
  blindManifest: BlindSurveyManifest;
  blindManifestDigest: string;
  intentDigest: string;
  request: ProviderInvocationRequest;
};

export function createFailedProviderInvocationFixture(
  fixture: InvestigationFixture,
  investigationId: string,
  invocationId: string,
): ReturnType<typeof failProviderInvocation> {
  const request = createProviderInvocationRequest(
    providerRequestInput(fixture, invocationId),
  );
  storeProviderExecutionPolicySnapshot(
    fixture.paths,
    request,
    loadAiAdapterPolicy(fixture.repository),
  );
  const prepared = createProviderInvocation(fixture.paths, {
    investigationId,
    changeId: fixture.blindManifest.changeId,
    attempt: 1,
    manifest: fixture.blindManifest,
    request,
  });
  const claim = claimProviderInvocation(fixture.paths, invocationId, {
    expectedRevision: prepared.revision,
    workerId: `${invocationId}-worker`,
    leaseDurationMs: 1_000,
  });
  return failProviderInvocation(fixture.paths, invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    failure: {
      kind: 'retryable',
      code: 'PROVIDER_PROCESS_FAILED',
      message: 'Independent fixture failure for a governed retry decision.',
    },
  });
}

export function authorizeProviderRetryFixture(
  fixture: InvestigationFixture,
  failed: ReturnType<typeof failProviderInvocation>,
  replacementRequest: ProviderInvocationRequest,
) {
  const executionPolicy = loadAiAdapterPolicy(fixture.repository);
  const failedRequest = readProviderInvocationRequest(
    fixture.paths,
    failed.invocationId,
  );
  const authorization = authorizeAutomaticProviderRetry(
    readProviderRetryAccountingEvidence(fixture.paths, failed, failedRequest),
    {
      failed,
      failedRequest,
      replacementRequest,
      replacementExecutionPolicy: executionPolicy,
      dataAuthorizationPolicyPort: AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT,
      now: new Date().toISOString(),
    },
  );
  assert.equal(authorization.decision.retryable, true);
  assert.equal(authorization.decision.automatic, true);
  return {
    executionPolicy,
    retryDecision: {
      schemaVersion: 1 as const,
      kind: 'provider-retry-decision-binding' as const,
      executionJobId: authorization.job.jobId,
      executionRevision: authorization.executionRevision,
      failedAttemptId: authorization.attempt.attemptId,
      evidenceDigest: authorization.evidenceDigest,
      evaluatedAt: authorization.evaluatedAt,
    },
  };
}

export function writeFixtureProviderRuntime(
  paths: ReturnType<typeof investigationRuntimePaths>,
  invocationId: string,
  semanticOutput: unknown,
): void {
  const runtime = path.join(paths.invocations, invocationId, 'runtime');
  fs.mkdirSync(runtime, { mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', '{}\n'],
    ['schema.json', '{}\n'],
    ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
  ] as const) {
    fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
  }
}

export function grantCoreHumanResolutionAuthorizationFixture(
  repository: string,
  investigationId: string,
  decision: HumanResolutionDecision,
  consequences: HumanResolutionConsequences,
  challengeId: string,
  quarantine = false,
): GrantCoreHumanResolutionAuthorization {
  const repositoryState = discoverRepository(repository);
  const runtime = investigationRuntimePaths(
    repositoryState.gitCommonDirectory,
    'workflow-engine',
  );
  const state = quarantine
    ? inspectInvestigationQuarantineState(
        runtime,
        investigationId,
        'github:R_fixture',
      )
    : inspectInvestigationResolutionState(
        runtime,
        investigationId,
        'github:R_fixture',
      );
  return {
    schemaVersion: 1,
    kind: 'grant-core-human-resolution.v1',
    challengeId,
    approvalSubjectDigest: `sha256:${sha256(`approval-${challengeId}`)}`,
    repositoryId: state.envelope.repositoryId,
    repositoryHead: repositoryState.head,
    repositoryTree: repositoryState.tree,
    target: {
      workflowKind: 'investigation',
      changeId: state.envelope.changeId,
      workflowId: state.envelope.investigationId,
    },
    expected: {
      ...humanResolutionBlockerBinding(state),
      stateDigest: state.currentStateDigest,
      currentRefDigest: state.currentRefDigest,
    },
    decision,
    consequences,
  };
}

export function executeGrantCoreHumanResolutionFixture(
  repository: string,
  authorization: GrantCoreHumanResolutionAuthorization,
  options: GrantCoreHumanResolutionExecutionOptions = {},
) {
  const repositoryState = discoverRepository(repository);
  const runtime = workflowRuntimePaths(
    repositoryState.gitCommonDirectory,
    'workflow-engine',
  );
  return withRepositoryLifecycleOperation(
    runtime,
    (assertOwned) =>
      executeGrantCoreHumanResolution(
        repository,
        authorization,
        assertOwned,
        options,
      ),
    {
      allowHumanResolutionGrantId: authorization.challengeId,
      allowHumanResolutionChangeId: authorization.target.changeId,
    },
  );
}

export function installFixtureMaintainerPolicy(repository: string): void {
  const origin = 'https://github.com/example/fixture.git';
  git(repository, ['remote', 'add', 'origin', origin]);
  fs.writeFileSync(
    path.join(repository, 'workflow/maintainer-policy.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        repository: { id: 'github:R_fixture', origin },
        phase: 'bootstrap',
        auditTagPrefix: 'refs/tags/workflow-grant/',
        signatureNamespace: 'workflow.maintainer-grant.v1',
        maxTtlMinutes: 30,
        maxUses: 1,
        bootstrapEligiblePaths: ['packages/workflow-engine/src/**'],
        sealedImmutablePaths: [],
        requiredChecks: ['fixture'],
        trustedSigners: [
          {
            identity: 'fixture-maintainer',
            publicKey:
              'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJL6dVljsgm9EAbjCiOhA/tKsgApOhKmcB/NRewL1uns',
            fingerprint: 'SHA256:7UB1aHADtIMUJBFt3sjo9RwoBDgCKc1B1GlEucUDL4U',
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
}

export function investigationFixture(
  invocationId: string,
): InvestigationFixture {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', 'work/demo-change']);
  const repositoryState = discoverRepository(repository);
  const paths = investigationRuntimePaths(
    repositoryState.gitCommonDirectory,
    'workflow-engine',
  );
  const normalizedIntent = {
    schemaVersion: 1 as const,
    summary: 'Understand and extend the durable planning workflow.',
    sourceRefs: [],
    explicitPaths: [] as string[],
    explicitSymbols: ['InvestigationSession'],
    explicitConfigKeys: [] as string[],
    renamePairs: [] as Array<{ from: string; to: string }>,
  };
  const blindManifest: BlindSurveyManifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: 'demo-change',
    repositoryId: 'fixture',
    baseCommit: repositoryState.head,
    baseTree: repositoryState.tree,
    normalizedIntent,
    architectureQuestion:
      'Which components preserve the lifecycle invariants, and why?',
    capabilityProfile: 'repository-read-only',
  };
  const blindManifestDigest = sha256(canonicalJson(blindManifest));
  const intentDigest = sha256(canonicalJson(normalizedIntent));
  const fixture = {
    repository,
    paths,
    blindManifest,
    blindManifestDigest,
    intentDigest,
  };
  return {
    ...fixture,
    request: createProviderInvocationRequest(
      providerRequestInput(fixture, invocationId),
    ),
  };
}

export function fakeRunnerReport(
  request: ProviderInvocationRequest,
  semanticOutput: unknown,
  invocationDirectory?: string,
): ProviderRunnerReport {
  if (invocationDirectory !== undefined) {
    const runtime = path.join(invocationDirectory, 'runtime');
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    for (const [name, content] of [
      ['prompt.json', '{}\n'],
      ['schema.json', '{}\n'],
      ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
    ] as const) {
      fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
    }
  }
  return {
    invocationId: request.invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
    assurance: 'unchanged-governed-projection',
    projection: {
      unchanged: true,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false,
    residuals: [...PROVIDER_RUNNER_RESIDUALS],
    executable: builtInProviderExecutableIdentityForTest(request.providerId),
    elapsedMs: 5,
    providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
      request.providerId,
    ),
  };
}

export function malformedClaudeRunnerHost(
  malformedOutput: string,
): ProviderRunnerHost {
  const identity: ProviderExecutableIdentity = {
    candidatePath: '/opt/homebrew/bin/claude',
    realPath: '/opt/homebrew/Caskroom/claude-code/2.1.206/claude',
    device: '1',
    inode: '2',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 1024,
    mtimeNs: '123456789',
    sha256: 'b'.repeat(64),
  };
  const success = (stdout: string): ProviderProcessOutcome => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 1,
    stdout,
    stderr: '',
  });
  return {
    inspectCandidate(candidatePath) {
      return candidatePath === identity.candidatePath ? identity : null;
    },
    runProbe(input) {
      if (input.args[0] === '--version') {
        return success('2.1.206 (Claude Code)\n');
      }
      if (input.args[0] === 'auth') {
        return success('{"loggedIn":true}\n');
      }
      return success(
        [
          '--print',
          '--output-format',
          '--no-session-persistence',
          '--safe-mode',
          '--disable-slash-commands',
          '--no-chrome',
          '--strict-mcp-config',
          '--mcp-config',
          '--permission-mode',
          '--tools',
          '--allowedTools',
          '--effort',
          '--json-schema',
        ].join('\n'),
      );
    },
    execute() {
      return success(malformedOutput);
    },
  };
}

export function providerRequestInput(
  fixture: Omit<InvestigationFixture, 'request'>,
  invocationId: string,
  override: { nonce?: string; policyDigest?: string } = {},
) {
  return {
    invocationId,
    nonce: override.nonce ?? `nonce-for-${invocationId}-0000`,
    purpose: 'survey' as const,
    providerId: 'claude' as const,
    roleAssignment: {
      role: 'plan-reviewer' as const,
      providerId: 'claude' as const,
      sessionId: `provider-session-${invocationId}`,
      targetDigest: fixture.intentDigest,
      requiredIndependence: 'session-independent' as const,
      achievedIndependence: 'provider-independent' as const,
    },
    capabilityProfile: 'repository-read-only' as const,
    repositoryId: fixture.blindManifest.repositoryId,
    baseCommit: fixture.blindManifest.baseCommit,
    baseTree: fixture.blindManifest.baseTree,
    targetDigest: fixture.intentDigest,
    inputManifestDigest: fixture.blindManifestDigest,
    authorizationNodeId: '1'.repeat(64),
    writeAllowedPaths: [] as string[],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey-evaluator.v1',
    policyDigest:
      override.policyDigest ??
      sha256(
        fs.readFileSync(
          path.join(fixture.repository, 'workflow/ai-adapter-policy.json'),
          'utf8',
        ),
      ),
    limits: {
      timeoutMs: 300_000,
      aggregateOutputBytes: 1_048_576,
    },
  };
}

export function startFixture(fixture: InvestigationFixture) {
  return startInvestigationSession(fixture.repository, {
    changeId: 'demo-change',
    blindManifest: fixture.blindManifest,
    blindRequest: fixture.request,
  });
}

export function mainTermsEnvelope(
  status: ReturnType<typeof startInvestigationSession>,
) {
  return createInvestigationCheckpointEnvelope(status, {
    reference: 'main-agent-survey',
    terms: [mainTerm('MainOnlyTerm')],
  });
}

export function mainTerm(value: string) {
  return {
    kind: 'symbol' as const,
    value,
    rationale: `The main investigation identified ${value}.`,
    expectedRelationship: 'An existing consumer may depend on this symbol.',
  };
}

export function completeBlindInvocation(
  fixture: InvestigationFixture,
  invocationId: string,
) {
  const request = readProviderInvocationRequest(fixture.paths, invocationId);
  const claim = claimProviderInvocation(fixture.paths, invocationId, {
    workerId: `worker-${invocationId}`,
    leaseDurationMs: 60_000,
  });
  return completeProviderInvocation(fixture.paths, invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome: providerOutcome(request),
  });
}

export function providerWireResult(
  request: ProviderInvocationRequest,
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

export function providerOutcome(
  request: ProviderInvocationRequest,
  override: Partial<ProviderProcessOutcome> = {},
): ProviderProcessOutcome {
  const output = {
    reference: request.invocationId,
    terms: [{ kind: 'symbol', value: 'BlindOnlyTerm' }],
  };
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 10,
    stdout: JSON.stringify(providerWireResult(request, output)),
    stderr: '',
    ...override,
  };
}

export function workflowSourceModuleUrl(
  fileName: keyof typeof WORKFLOW_SOURCE_MODULE_PATHS,
): string {
  return pathToFileURL(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src',
      WORKFLOW_SOURCE_MODULE_PATHS[fileName],
    ),
  ).href;
}

export function runLockCrashChild(
  cwd: string,
  operation: string,
  phase: 'write' | 'unlink',
  targetFragment: string,
): ReturnType<typeof spawnSync> {
  const script = `
    const fs = (await import('node:fs')).default;
    const descriptorPaths = new Map();
    const originalOpen = fs.openSync.bind(fs);
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      descriptorPaths.set(descriptor, String(target));
      return descriptor;
    };
    if (${JSON.stringify(phase)} === 'write') {
      const originalWrite = fs.writeFileSync.bind(fs);
      fs.writeFileSync = (target, ...args) => {
        const observed =
          typeof target === 'number' ? descriptorPaths.get(target) : String(target);
        if (
          typeof observed === 'string' &&
          observed.includes(${JSON.stringify(targetFragment)}) &&
          observed.endsWith('.tmp')
        ) {
          process.kill(process.pid, 'SIGKILL');
        }
        return originalWrite(target, ...args);
      };
    } else {
      const originalUnlink = fs.unlinkSync.bind(fs);
      fs.unlinkSync = (target, ...args) => {
        if (
          typeof target === 'string' &&
          target.includes(${JSON.stringify(targetFragment)}) &&
          target.endsWith('.tmp')
        ) {
          process.kill(process.pid, 'SIGKILL');
        }
        return originalUnlink(target, ...args);
      };
    }
    ${operation}
  `;
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    { cwd, encoding: 'utf8' },
  );
}

export function runReviewerReconciliationCrashChild(
  repository: string,
  changeId: string,
  envelope: ReturnType<typeof createInvestigationCheckpointEnvelope>,
  targetPath: string,
  phase:
    | 'after-open'
    | 'during-write'
    | 'before-rename'
    | 'after-rename' = 'after-rename',
): ReturnType<typeof spawnSync> {
  const script = `
    const fs = (await import('node:fs')).default;
    const path = (await import('node:path')).default;
    const targetPath = ${JSON.stringify(targetPath)};
    const phase = ${JSON.stringify(phase)};
    const absolutePath = (target) => {
      const observed = String(target);
      return path.isAbsolute(observed)
        ? observed
        : path.resolve(process.cwd(), observed);
    };
    const descriptorPaths = new Map();
    const originalOpen = fs.openSync.bind(fs);
    fs.openSync = (target, ...args) => {
      const descriptor = originalOpen(target, ...args);
      const observed = absolutePath(target);
      descriptorPaths.set(descriptor, observed);
      if (
        phase === 'after-open' &&
        observed.startsWith(targetPath + '.') &&
        observed.endsWith('.tmp')
      ) {
        process.kill(process.pid, 'SIGKILL');
      }
      return descriptor;
    };
    const originalWrite = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (target, data, ...args) => {
      const observed =
        typeof target === 'number' ? descriptorPaths.get(target) : String(target);
      if (
        phase === 'during-write' &&
        typeof target === 'number' &&
        typeof observed === 'string' &&
        observed.startsWith(targetPath + '.') &&
        observed.endsWith('.tmp')
      ) {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Buffer.from(String(data), 'utf8');
        fs.writeSync(
          target,
          bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
        );
        process.kill(process.pid, 'SIGKILL');
      }
      return originalWrite(target, data, ...args);
    };
    const originalRename = fs.renameSync.bind(fs);
    fs.renameSync = (source, target) => {
      const observedTarget = absolutePath(target);
      if (
        observedTarget === targetPath &&
        phase === 'before-rename'
      ) {
        process.kill(process.pid, 'SIGKILL');
      }
      const result = originalRename(source, target);
      if (
        observedTarget === targetPath &&
        phase === 'after-rename'
      ) {
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    const { resumePropose } =
      await import(${JSON.stringify(PROPOSE_ORCHESTRATOR_MODULE_URL)});
    resumePropose(
      ${JSON.stringify(repository)},
      ${JSON.stringify(changeId)},
      ${JSON.stringify(envelope)},
    );
  `;
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    { cwd: repository, encoding: 'utf8' },
  );
}

export function createCrashPublicationEvidenceNode(
  label: string,
): EvidenceNode {
  return createEvidenceNode({
    type: 'crash-publication-test',
    nodeSchema: 'workflow.crash-publication-test.v1',
    evaluator: 'workflow-test.v1',
    policyDigest: '1'.repeat(64),
    exactInputDigests: {
      input: sha256(label),
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'workflow.crash-publication-test-output.v1',
    output: { label },
    runtimeMetadata: {},
  });
}

export function snapshotFileTree(root: string): readonly unknown[] {
  const snapshot: unknown[] = [];
  const visit = (absolute: string, relative: string): void => {
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (stats === undefined) return;
    snapshot.push({
      path: relative,
      mode: stats.mode,
      kind: stats.isDirectory()
        ? 'directory'
        : stats.isFile()
          ? 'file'
          : stats.isSymbolicLink()
            ? 'symlink'
            : 'other',
      content: stats.isFile()
        ? fs.readFileSync(absolute).toString('base64')
        : stats.isSymbolicLink()
          ? fs.readlinkSync(absolute)
          : null,
    });
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) {
        visit(path.join(absolute, entry), path.join(relative, entry));
      }
    }
  };
  visit(root, '.');
  return snapshot;
}

export function runEvidenceObjectCrashChild(
  repository: string,
  gitCommonDirectory: string,
  node: EvidenceNode,
  objectPath: string,
  phase: 'during-temp-write' | 'before-link' | 'after-link',
): ReturnType<typeof spawnSync> {
  const script = `
    const fs = (await import('node:fs')).default;
    const objectPath = ${JSON.stringify(objectPath)};
    const phase = ${JSON.stringify(phase)};
    const originalWriteFile = fs.writeFileSync.bind(fs);
    fs.writeFileSync = (target, data, ...args) => {
      if (
        phase === 'during-temp-write' &&
        typeof target === 'number'
      ) {
        const bytes = Buffer.isBuffer(data)
          ? data
          : Buffer.from(String(data), 'utf8');
        fs.writeSync(
          target,
          bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))),
        );
        process.kill(process.pid, 'SIGKILL');
      }
      return originalWriteFile(target, data, ...args);
    };
    const originalLink = fs.linkSync.bind(fs);
    fs.linkSync = (source, target) => {
      if (String(target) === objectPath && phase === 'before-link') {
        process.kill(process.pid, 'SIGKILL');
      }
      const result = originalLink(source, target);
      if (String(target) === objectPath && phase === 'after-link') {
        process.kill(process.pid, 'SIGKILL');
      }
      return result;
    };
    const { writeEvidenceNode } =
      await import(${JSON.stringify(EVIDENCE_STORE_MODULE_URL)});
    const { investigationRuntimePaths } =
      await import(${JSON.stringify(PATHS_MODULE_URL)});
    writeEvidenceNode(
      investigationRuntimePaths(
        ${JSON.stringify(gitCommonDirectory)},
        'workflow-engine',
      ),
      ${JSON.stringify(node)},
    );
  `;
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '--eval', script],
    { cwd: repository, encoding: 'utf8' },
  );
}

export function listEvidenceObjectCrashAliases(objectPath: string): string[] {
  const directory = path.dirname(objectPath);
  const basename = path.basename(objectPath);
  return fs.existsSync(directory)
    ? fs
        .readdirSync(directory)
        .filter(
          (name) =>
            name.startsWith(`${basename}.`) && name.endsWith('.publish.tmp'),
        )
        .sort()
        .map((name) => path.join(directory, name))
    : [];
}

export function listReviewerReconciliationTemporaries(
  changeDirectory: string,
  basename: 'investigation.json' | 'design.md',
): string[] {
  const pattern = new RegExp(
    `^${basename.replace('.', '\\.')}\\.[1-9][0-9]*\\.` +
      '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-' +
      '[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$',
  );
  return fs
    .readdirSync(changeDirectory)
    .filter((name) => pattern.test(name))
    .sort()
    .map((name) => path.join(changeDirectory, name));
}

export function listInvestigationPublicationCandidates(
  changeDirectory: string,
): string[] {
  return fs
    .readdirSync(changeDirectory)
    .filter((name) =>
      /^investigation\.json\.[0-9a-f]{64}\.candidate$/u.test(name),
    )
    .sort()
    .map((name) => path.join(changeDirectory, name));
}

export function assertLinkedLockPair(finalLock: string): string {
  const finalStats = fs.lstatSync(finalLock);
  const temporaries = fs
    .readdirSync(path.dirname(finalLock))
    .filter(
      (entry) =>
        entry.startsWith(`${path.basename(finalLock)}.`) &&
        entry.endsWith('.tmp'),
    )
    .map((entry) => path.join(path.dirname(finalLock), entry))
    .filter((temporary) => {
      const stats = fs.lstatSync(temporary);
      return stats.dev === finalStats.dev && stats.ino === finalStats.ino;
    });
  assert.equal(temporaries.length, 1);
  const temporary = temporaries[0]!;
  const temporaryStats = fs.lstatSync(temporary);
  assert.equal(finalStats.isFile(), true);
  assert.equal(temporaryStats.isFile(), true);
  assert.equal(finalStats.mode & 0o777, 0o600);
  assert.equal(temporaryStats.mode & 0o777, 0o600);
  assert.equal(finalStats.dev, temporaryStats.dev);
  assert.equal(finalStats.ino, temporaryStats.ino);
  assert.equal(finalStats.nlink, 2);
  assert.equal(temporaryStats.nlink, 2);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(finalLock, 'utf8')));
  return temporary;
}

export function runWorkflowCli(
  repository: string,
  args: string[],
  environment: Record<string, string | undefined>,
) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(
        sourceRepositoryRoot,
        'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
      ),
      ...args,
      '--json',
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT: undefined,
        CLAUDECODE: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
        CODEX_SANDBOX: undefined,
        ...environment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

export function whyAnswer(manifestEntryId: string, semanticAuthor = 'codex') {
  return {
    manifestEntryId,
    why: 'This complete module coordinates the load-bearing behavior.',
    protectedInvariant:
      'Every accepted transition preserves the pinned evidence relationship.',
    reviewerQuestion:
      'What prevents a stale implementation blob from satisfying this row?',
    answer:
      'The manifest and evidence node bind the exact complete source blob.',
    semanticAuthor,
    readComplete: true as const,
  };
}

export function sessionPath(
  fixture: InvestigationFixture,
  investigationId: string,
): string {
  return path.join(fixture.paths.sessions, `${investigationId}.json`);
}

export function invocationPath(
  fixture: InvestigationFixture,
  invocationId: string,
): string {
  return path.join(fixture.paths.invocations, invocationId, 'state.json');
}

export function invocationManifestPath(
  fixture: InvestigationFixture,
  invocationId: string,
): string {
  return path.join(fixture.paths.invocations, invocationId, 'manifest.json');
}

export function invocationRequestPath(
  fixture: InvestigationFixture,
  invocationId: string,
): string {
  return path.join(fixture.paths.invocations, invocationId, 'request.json');
}

export function assertTrackedInvestigationManifestPublication(
  repository: string,
  changeId: string,
  manifest: {
    repositoryId: string;
    changeId: string;
    investigationId: string;
    manifestDigest: string;
    investigationApproval: { investigationTargetDigest: string };
  },
): void {
  assert.equal(manifest.changeId, changeId);
  const namespace = investigationManifestPublicationNamespace(manifest);
  const publicationRoot = path.join(
    discoverRepository(repository).gitCommonDirectory,
    'workflow-engine',
    namespace,
  );
  const current = JSON.parse(
    fs.readFileSync(path.join(publicationRoot, 'current.json'), 'utf8'),
  ) as Record<string, unknown>;
  const journal = JSON.parse(
    fs.readFileSync(path.join(publicationRoot, 'journal.json'), 'utf8'),
  ) as Record<string, unknown>;
  assert.equal(current.kind, 'investigation-manifest-current');
  assert.equal(current.manifestDigest, manifest.manifestDigest);
  assert.equal(
    current.investigationTargetDigest,
    manifest.investigationApproval.investigationTargetDigest,
  );
  assert.equal(
    current.manifestPath,
    `openspec/changes/${changeId}/investigation.json`,
  );
  assert.equal(journal.kind, 'investigation-manifest-publication');
  assert.equal(journal.state, 'committed');
  assert.equal(journal.manifestDigest, manifest.manifestDigest);
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

import { taskMandateOperations } from '../src/composition-root/task-mandate-production.ts';

const startInvestigationSession = startInvestigationSessionWithMandate.bind(
  undefined,
  taskMandateOperations,
);
