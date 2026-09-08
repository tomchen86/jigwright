/** Shared provider-adapters fixtures; this module registers no tests. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING,
  parseAiAdapterPolicyDocument,
} from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderInvocationRequestInput,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  createProviderExecutionPolicySnapshot,
  type ProviderInvocationAcceptanceBinding,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  ensureProviderPromptContext,
  providerPromptContextStoreRoot,
} from '../src/runtime/provider-execution/provider-execution-governance.ts';
import {
  type ProviderExecutableIdentity,
  type ProviderRunInput,
  type ProviderRunnerHost,
} from '../src/runtime/provider-execution/provider-runner.ts';
import { agentRuntimeNativeSessionIdDigestV1 } from '@jigwright/core/agent-runtime-port';
import {
  parseAgentProviderConfigToml,
  type BuiltInReviewedProviderProfileSnapshot,
  type HostWrapperProviderProfileSnapshot,
  type ProviderWrapperSessionProtocolBinding,
} from '@jigwright/agent-runtime';
import type {
  AgentRuntimeAssignmentBindingV1,
  AgentRuntimeNativeSessionTurnControllerV1,
  AgentRuntimeSingleShotInput,
} from '../src/modules/provider-orchestration/agent-runtime-port.ts';
import { createAgentRuntimeAssignmentBindingV1 } from '../src/modules/provider-orchestration/agent-runtime-assignment-binding.ts';
import { type ProviderNativeSessionClaimV1 } from '../src/modules/provider-orchestration/provider-native-session.ts';
import {
  agentRolePlanV2Digest,
  createAgentRolePlanV2Snapshot,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  createCentralRoleProviderDefault,
  createCentralRoleProviderDefaultSnapshotV1,
  renderCentralRoleProviderDefault,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import { createChangeRoleAssignmentRecordV1 } from '../src/modules/provider-orchestration/change-role-assignment-record.ts';
import {
  createChangeRoleAssignmentProtectedContextV1,
  resolveChangeRoleAssignmentV1,
} from '../src/modules/provider-orchestration/change-role-assignment.ts';
import { projectAgentRuntimeAssignmentBindingV1 } from '../src/modules/provider-orchestration/agent-runtime-durable-authority.ts';
import { createFixtureRepository, git } from './fixture.ts';

export const PROVIDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reference', 'terms'],
  properties: {
    reference: { type: 'string' },
    terms: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'value'],
        properties: {
          kind: {
            enum: ['literal-content', 'literal-path', 'symbol', 'config-key'],
          },
          value: { type: 'string', minLength: 1 },
        },
      },
    },
  },
} as const;

export const providerWrapperFixture = path.join(
  import.meta.dirname,
  'fixtures/provider-wrapper-fixture.mjs',
);

export function builtInProfile(
  executable: string,
): BuiltInReviewedProviderProfileSnapshot {
  return parseAgentProviderConfigToml(
    `schema_version = 2
global_ranking = ["claude-selected"]

[[providers]]
id = "claude-selected"
family = "claude"
trust_tier = "built-in-reviewed"
enabled = true
protocol = "claude-stream-json-v1"
executable = "${executable}"

[provider_preferences]
author = ["claude-selected"]
builder = ["claude-selected"]
reviewer = ["claude-selected"]
`,
    { platform: 'darwin' },
  ).providers[0] as BuiltInReviewedProviderProfileSnapshot;
}

export function createRunnerFixture(
  providerId: 'claude' | 'codex' = 'claude',
  aggregateOutputBytes = 1_048_576,
  maxConcurrent = 2,
  purpose: ProviderInvocationRequest['purpose'] = 'survey',
) {
  const repository = createFixtureRepository();
  const policyContent = writeAdapterPolicy(repository, true, maxConcurrent);
  if (git(repository, ['status', '--porcelain']).trim() !== '') {
    git(repository, ['add', 'workflow/ai-adapter-policy.json']);
    git(repository, ['commit', '-m', 'Add adapter policy']);
  }
  const invocationId = 'invocation-adapter-test';
  const manifest = {
    kind: purpose === 'plan-review' ? 'plan-review-manifest' : 'test-manifest',
    invocationId,
  };
  const manifestDigest = sha256(canonicalJson(manifest));
  const request = providerRequest(
    sha256(policyContent),
    repository,
    providerId,
    aggregateOutputBytes,
    invocationId,
    manifestDigest,
    purpose,
  );
  const invocationDirectoryPath = path.join(
    repository,
    '.git',
    'workflow-engine',
    'investigations',
    'invocations',
    invocationId,
  );
  createPrivateDirectory(invocationDirectoryPath);
  const invocationDirectory = fs.realpathSync(invocationDirectoryPath);
  const manifestPath = path.join(invocationDirectory, 'manifest.json');
  rewritePrivateJson(manifestPath, manifest);
  rewritePrivateJson(path.join(invocationDirectory, 'request.json'), request);
  rewritePrivateJson(path.join(invocationDirectory, 'state.json'), {
    invocationId,
    state: 'leased',
  });
  writeProviderExecutionPolicySnapshot(
    invocationDirectory,
    request,
    policyContent,
  );
  const input: ProviderRunInput = {
    providerId,
    repositoryRoot: repository,
    invocationDirectory,
    request,
    semanticOutputSchema: PROVIDER_SCHEMA,
    outputValidator: outputValidatorFor(request),
    governedRuntimeInputs: [{ id: 'manifest', path: manifestPath }],
    sourceEnvironment: {
      HOME: os.homedir(),
      USER: 'reviewer',
      LOGNAME: 'reviewer',
    },
  };
  return {
    repository,
    request,
    input,
    cleanup() {
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

export function hostWrapperProfile(wrapperPath: string, resumable: boolean) {
  const profile = hostWrapperConfiguration(wrapperPath, resumable)
    .providers[0]!;
  assert.equal(profile.trustTier, 'host-wrapper');
  return profile as HostWrapperProviderProfileSnapshot;
}

export function hostWrapperConfiguration(
  wrapperPath: string,
  resumable: boolean,
) {
  const capabilities = resumable
    ? '"fresh-session", "resumable-session", "plan-review", "survey", "task-diff-review", "task-implementation"'
    : '"fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"';
  const resumeArgs = resumable
    ? `["${wrapperPath}", "host-resume", "{native_session_id}", "{request_file}"]`
    : '[]';
  return parseAgentProviderConfigToml(
    `schema_version = 2
global_ranking = ["host-claude"]

[[providers]]
id = "host-claude"
logical_provider_id = "claude"
family = "claude"
capabilities = [${capabilities}]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = "${process.execPath}"
start_args = ["${wrapperPath}", "host-start", "{request_file}"]
resume_args = ${resumeArgs}
prompt_input = "stdin"
cancel = "process-group"

[provider_preferences]
author = ["host-claude"]
builder = ["host-claude"]
reviewer = ["host-claude"]
`,
    { platform: process.platform },
  );
}

export function durableHostWrapperAssignment(
  changeId: string,
  request: ProviderInvocationRequest,
  wrapperPath: string,
  resumable: boolean,
) {
  const configuration = hostWrapperConfiguration(wrapperPath, resumable);
  const profile = configuration
    .providers[0] as HostWrapperProviderProfileSnapshot;
  const central = createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: [
      {
        roles: ['author', 'builder', 'reviewer'],
        sessionGroups: [['author', 'builder', 'reviewer']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: 'claude',
        },
      },
    ],
    globalProviderRanking: ['claude'],
  });
  const caller = {
    logicalProviderId: 'claude',
    profileId: profile.id,
    engineSessionId: 'assignment-caller-host-wrapper-lifecycle',
    adoptableRoles: [] as const,
  };
  const dataAuthorization = {
    policyDigest: request.policyDigest,
    inputManifestDigest: request.inputManifestDigest,
    relevantTargetDigest: request.targetDigest,
    profiles: [
      {
        profileId: profile.id,
        allowed: true,
        reason: 'AUTHORIZED',
      },
    ],
  };
  const sessionCapabilities = [
    {
      profileId: profile.id,
      canStartFresh: true,
      canResume:
        resumable && profile.capabilities.includes('resumable-session'),
    },
  ];
  const providerRegistry = {
    schemaVersion: 1 as const,
    policyDigest: sha256('host-wrapper-provider-registry-policy'),
    providers: [
      {
        logicalProviderId: 'claude',
        providerFamily: 'claude',
        enabled: true,
        definitionDigest: profile.profileDigest,
      },
    ],
  };
  const changeOverrideBody: AgentRolePlanBodyV2 = {
    schemaVersion: 2,
    changeId,
    baseCentralConfigurationDigest: central.configurationDigest,
    roleLanes: [],
    pairwiseRequirements: [],
    customWrapperPolicy: 'allowed',
    grantReferences: [],
  };
  const changeOverridePlan = {
    ...changeOverrideBody,
    planDigest: agentRolePlanV2Digest(changeOverrideBody),
  };
  const protectedContext = createChangeRoleAssignmentProtectedContextV1({
    classification: 'ordinary',
    pathRoleSourceDigest: sha256('host-wrapper-path-role-source'),
    policySourceDigest: sha256('host-wrapper-protected-policy-source'),
    inputManifestDigest: request.inputManifestDigest,
    relevantTargetDigest: request.targetDigest,
  });
  const providerRegistryDigest = sha256(canonicalJson(providerRegistry));
  const resolved = resolveChangeRoleAssignmentV1({
    changeId,
    planningGeneration: request.inputManifestDigest,
    providerRegistryDigest,
    centralDefault: central,
    changeOverride: changeOverridePlan,
    providerConfiguration: configuration,
    caller,
    dataAuthorization,
    sessionCapabilities,
    protectedContext,
  });
  if (resolved.outcome === 'unsatisfied') {
    assert.fail(`${resolved.code}: ${canonicalJson(resolved.diagnostics)}`);
  }
  const centralSource = renderCentralRoleProviderDefault(central);
  const overrideSource = renderAgentRolePlanV2(changeOverridePlan);
  const record = createChangeRoleAssignmentRecordV1({
    central: createCentralRoleProviderDefaultSnapshotV1({
      pinnedCommit: request.baseCommit,
      blobObjectId: gitBlobObjectId(centralSource),
      configuration: central,
    }),
    host: {
      sourceDigest: sha256('host-wrapper-provider-configuration-source'),
      configuration,
    },
    changeOverride: createAgentRolePlanV2Snapshot({
      pinnedCommit: request.baseCommit,
      blobObjectId: gitBlobObjectId(overrideSource),
      plan: changeOverridePlan,
    }),
    caller,
    dataAuthorization,
    sessionCapabilities,
    providerRegistry,
    resolution: resolved.resolution,
  });
  const binding = projectAgentRuntimeAssignmentBindingV1(record, {
    purpose: request.purpose,
    providerId: request.providerId,
    inputManifestDigest: request.inputManifestDigest,
    targetDigest: request.targetDigest,
  });
  const slot = record.sessionSlots.find((candidate) =>
    candidate.roles.includes('author'),
  );
  assert.ok(slot);
  return { binding, profile, record, slot };
}

export function gitBlobObjectId(source: string): string {
  return crypto
    .createHash('sha1')
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest('hex');
}

export function canonicalHostWrapperFixture(
  terminal: 'result' | 'error' | 'cancelled' = 'result',
  exitCode = terminal === 'result' || terminal === 'cancelled' ? 0 : 2,
): string {
  const terminalFrame =
    terminal === 'result'
      ? "emit({ schemaVersion: 2, type: 'result', sequence, outputSlot: 'primary' });"
      : terminal === 'error'
        ? "emit({ schemaVersion: 2, type: 'error', sequence, code: 'FIXTURE_REJECTED' });"
        : "process.once('SIGTERM', () => { emit({ schemaVersion: 2, type: 'cancel-ack', sequence }); setTimeout(() => process.exit(0), 10); }); fs.writeFileSync(new URL('./provider-ready', import.meta.url), 'ready'); setInterval(() => {}, 1000);";
  return `import fs from 'node:fs';

const action = process.argv[2] === 'host-resume' ? 'resume' : 'start';
const requestPath = action === 'resume' ? process.argv[4] : process.argv[3];
const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
const canonicalJson = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
};
const write = (filePath, value) => fs.writeFileSync(filePath, canonicalJson(value) + '\\n');
if (request.kind === 'agent-runtime-host-wrapper-probe-request.v1') {
  write(request.outputFile, {
    authentication: 'authenticated',
    kind: 'agent-runtime-host-wrapper-probe-result.v1',
    providerVersion: 'canonical-host-wrapper-v1',
    schemaVersion: 1,
  });
  process.exit(0);
}
${terminal === 'cancelled' ? 'await new Promise((resolve) => setTimeout(resolve, 500));' : ''}
write(request.outputFile, {
  reference: request.invocationId,
  terms: [{ kind: 'symbol', value: 'protectedBranches' }],
});
let sequence = 1;
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
emit({ schemaVersion: 2, type: 'hello', sequence: sequence++, protocol: 'harness-jsonl-v2' });
emit({ schemaVersion: 2, type: 'session', sequence: sequence++, action, nativeSessionId: 'native-host-wrapper-lifecycle' });
${terminalFrame}
process.exitCode = ${exitCode};
`;
}

export function hostWrapperStartController(
  input: ProviderRunInput,
  profile: ReturnType<typeof hostWrapperProfile>,
  terminals: unknown[],
): Omit<
  AgentRuntimeNativeSessionTurnControllerV1,
  'assignmentBinding' | 'invocationBinding'
> {
  return {
    profile,
    nextAction: () => 'start',
    claim({ attemptId, expectedAction }) {
      assert.equal(expectedAction, 'start');
      const binding = {
        invocationId: input.request.invocationId,
        requestDigest: input.request.requestDigest,
        attemptId,
        sessionControl: {
          action: 'start' as const,
          nativeSessionIdentityMode: 'provider-observed' as const,
          expectedNativeSessionId: null,
        },
      };
      const claim = fakeNativeSessionClaim(
        hostWrapperAssignmentBinding(input, profile),
        profile,
        binding,
        null,
      );
      return {
        claim,
        claimDigest: claim.claimDigest,
        predecessorCompletionDigest: null,
        binding,
      };
    },
    complete(value) {
      terminals.push(value.terminal);
      return { completionDigest: '2'.repeat(64) };
    },
  };
}

export function hostWrapperInput(
  input: ProviderRunInput,
  profile: ReturnType<typeof hostWrapperProfile>,
  nativeSessionTurn: Omit<
    AgentRuntimeNativeSessionTurnControllerV1,
    'assignmentBinding' | 'invocationBinding'
  >,
  exactAssignmentBinding?: AgentRuntimeAssignmentBindingV1,
): AgentRuntimeSingleShotInput {
  const assignmentBinding =
    exactAssignmentBinding ?? hostWrapperAssignmentBinding(input, profile);
  return {
    ...input,
    semanticOutputSchema:
      input.semanticOutputSchema as AgentRuntimeSingleShotInput['semanticOutputSchema'],
    reviewSnapshotRoot: input.reviewSnapshotRoot ?? null,
    assignmentBinding,
    nativeSessionTurn: {
      ...nativeSessionTurn,
      assignmentBinding,
      invocationBinding: {
        requestDigest: input.request.requestDigest,
        inputManifestDigest: input.request.inputManifestDigest,
        targetDigest: input.request.targetDigest,
        policyDigest: input.request.policyDigest,
      },
    },
    acceptanceBinding: input.acceptanceBinding!,
  };
}

export function hostWrapperAssignmentBinding(
  input: ProviderRunInput,
  profile: ReturnType<typeof hostWrapperProfile>,
): AgentRuntimeAssignmentBindingV1 {
  return createAgentRuntimeAssignmentBindingV1({
    schemaVersion: 1 as const,
    kind: 'agent-runtime-assignment-binding.v1' as const,
    changeId: 'host-wrapper-fixture',
    planningGeneration: '1'.repeat(64),
    recordDigest: '2'.repeat(64),
    assignmentDigest: '3'.repeat(64),
    role: 'author' as const,
    logicalProviderId: profile.logicalProviderId,
    providerProfileId: profile.id,
    providerProfileSnapshot: profile,
    definitionDigest: profile.profileDigest,
    dataAuthorizationPolicyDigest: input.request.policyDigest,
    assignmentManifestDigest: input.request.inputManifestDigest,
    inputManifestDigest: input.request.inputManifestDigest,
    targetDigest: input.request.targetDigest,
  });
}

export function fakeNativeSessionClaim(
  assignment: AgentRuntimeAssignmentBindingV1,
  profile: HostWrapperProviderProfileSnapshot,
  binding: ProviderWrapperSessionProtocolBinding,
  predecessorCompletionDigest: string | null,
): ProviderNativeSessionClaimV1 {
  const scopeBody = {
    schemaVersion: 1 as const,
    kind: 'provider-native-session-scope.v1' as const,
    changeId: assignment.changeId,
    planningGeneration: assignment.planningGeneration,
    assignmentRecordDigest: assignment.recordDigest,
    resolutionDigest: '4'.repeat(64),
    sessionSlotId: `role-assignment-session-${'5'.repeat(64)}`,
    logicalProviderId: assignment.logicalProviderId,
    providerDefinitionDigest: assignment.definitionDigest,
    profileId: assignment.providerProfileId,
    profileDigest: profile.profileDigest,
    protocol: 'harness-jsonl-v2' as const,
    providerConfigurationDigest: '6'.repeat(64),
    providerRegistryDigest: '7'.repeat(64),
    dataAuthorizationDecisionDigest: '8'.repeat(64),
    sessionCapabilitySnapshotDigest: '9'.repeat(64),
    canResume:
      profile.capabilities.includes('resumable-session') &&
      profile.resumeArgs.length > 0,
  };
  const scope = {
    ...scopeBody,
    scopeKey: crypto
      .createHash('sha256')
      .update(
        `workflow.provider-native-session-scope.v1\n${canonicalJson(scopeBody)}`,
      )
      .digest('hex'),
  };
  const action = binding.sessionControl.action;
  const claimBody = {
    schemaVersion: 1 as const,
    kind: 'provider-native-session-claim.v1' as const,
    scope,
    turn: action === 'start' ? 1 : 2,
    action,
    predecessorCompletionDigest:
      action === 'start' ? null : predecessorCompletionDigest,
    expectedNativeSessionIdDigest:
      binding.sessionControl.nativeSessionIdentityMode === 'engine-supplied'
        ? agentRuntimeNativeSessionIdDigestV1(
            binding.sessionControl.expectedNativeSessionId,
          )
        : null,
    invocationId: binding.invocationId,
    requestDigest: binding.requestDigest,
    attemptId: binding.attemptId,
  };
  return {
    ...claimBody,
    claimDigest: crypto
      .createHash('sha256')
      .update(
        `workflow.provider-native-session-claim.v1\n${canonicalJson(claimBody)}`,
      )
      .digest('hex'),
  };
}

export function providerRequest(
  policyDigest: string,
  repository: string,
  providerId: 'claude' | 'codex' = 'claude',
  aggregateOutputBytes = 1_048_576,
  invocationId = 'invocation-adapter-test',
  inputManifestDigest = 'd'.repeat(64),
  purpose: ProviderInvocationRequest['purpose'] = 'survey',
  timeoutMs = 300_000,
): ProviderInvocationRequest {
  return createProviderInvocationRequest(
    providerRequestInput(
      policyDigest,
      repository,
      providerId,
      aggregateOutputBytes,
      invocationId,
      inputManifestDigest,
      purpose,
      timeoutMs,
    ),
  );
}

export function providerRequestInput(
  policyDigest: string,
  repository: string,
  providerId: 'claude' | 'codex' = 'claude',
  aggregateOutputBytes = 1_048_576,
  invocationId = 'invocation-adapter-test',
  inputManifestDigest = 'd'.repeat(64),
  purpose: ProviderInvocationRequest['purpose'] = 'survey',
  timeoutMs = 300_000,
): ProviderInvocationRequestInput {
  const outputSchemaDigest = crypto
    .createHash('sha256')
    .update(canonicalJson(PROVIDER_SCHEMA))
    .digest('hex');
  return {
    invocationId,
    nonce: 'adapter-test-nonce-000000000000',
    purpose,
    providerId,
    roleAssignment: {
      role: purpose === 'plan-review' ? 'plan-reviewer' : 'plan-reviewer',
      providerId,
      sessionId: 'provider-session-test',
      targetDigest: 'b'.repeat(64),
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: 'fixture',
    baseCommit: git(repository, ['rev-parse', 'HEAD']).trim(),
    baseTree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    targetDigest: 'b'.repeat(64),
    inputManifestDigest,
    authorizationNodeId: 'e'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: {
      id: BLIND_SURVEY_OUTPUT_SCHEMA.id,
      version: 1,
      digest: outputSchemaDigest,
    },
    evaluatorVersion:
      purpose === 'plan-review'
        ? 'plan-review.v2'
        : 'blind-survey-evaluator.v1',
    policyDigest,
    limits: {
      timeoutMs,
      aggregateOutputBytes,
    },
  };
}

export function semanticOutput(request: ProviderInvocationRequest) {
  return {
    reference: request.invocationId,
    terms: [{ kind: 'symbol', value: 'protectedBranches' }],
  };
}

export function outputValidatorFor(request: ProviderInvocationRequest) {
  return {
    id: request.outputSchema.id,
    version: request.outputSchema.version,
    digest: request.outputSchema.digest,
    validate(value: unknown) {
      return (
        typeof value === 'object' &&
        value !== null &&
        (value as { reference?: unknown }).reference === request.invocationId &&
        Array.isArray((value as { terms?: unknown }).terms)
      );
    },
  };
}

export function siblingRunnerInput(
  fixture: ReturnType<typeof createRunnerFixture>,
  invocationId: string,
): ProviderRunInput {
  const invocationDirectoryPath = path.join(
    fixture.repository,
    '.git',
    'workflow-engine',
    'investigations',
    'invocations',
    invocationId,
  );
  createPrivateDirectory(invocationDirectoryPath);
  const invocationDirectory = fs.realpathSync(invocationDirectoryPath);
  const manifest = { kind: 'test-manifest', invocationId };
  const manifestPath = path.join(invocationDirectory, 'manifest.json');
  rewritePrivateJson(manifestPath, manifest);
  const request = providerRequest(
    fixture.input.request.policyDigest,
    fixture.repository,
    'claude',
    fixture.input.request.limits.aggregateOutputBytes,
    invocationId,
    sha256(canonicalJson(manifest)),
  );
  rewritePrivateJson(path.join(invocationDirectory, 'request.json'), request);
  rewritePrivateJson(path.join(invocationDirectory, 'state.json'), {
    invocationId,
    state: 'leased',
  });
  writeProviderExecutionPolicySnapshot(
    invocationDirectory,
    request,
    fs.readFileSync(
      path.join(fixture.repository, 'workflow/ai-adapter-policy.json'),
      'utf8',
    ),
  );
  return {
    ...fixture.input,
    invocationDirectory,
    request,
    outputValidator: outputValidatorFor(request),
    governedRuntimeInputs: [{ id: 'manifest', path: manifestPath }],
  };
}

export function bindRunnerInputToInvestigationOwner(
  input: ProviderRunInput,
  ownerWorkflowId: string,
): ProviderRunInput {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  const context = ensureProviderPromptContext(
    providerPromptContextStoreRoot(input.invocationDirectory),
    input.request,
    manifest,
    ownerWorkflowId,
  );
  const acceptancePayload = {
    schemaVersion: 1 as const,
    kind: 'provider-invocation-acceptance-binding' as const,
    invocationId: input.request.invocationId,
    requestDigest: input.request.requestDigest,
    ownerWorkflowId,
    invocationRevision: 1,
    leaseGeneration: 1,
    context,
    executionJobId: `job-provider-concurrency-${input.request.invocationId}`,
    executionAttemptId: `attempt-provider-concurrency-${input.request.invocationId}`,
    executionRevision: 1,
    executionStateDigest: '0'.repeat(64),
    receiptRequirement: 'schema-v4' as const,
    repair: {
      invocationId: input.request.invocationId,
      lineagePath: path.join(input.invocationDirectory, 'repair-lineage.json'),
      lineageDigest: null,
      currentEvidencePath: path.join(
        input.invocationDirectory,
        'repair-evidence.json',
      ),
      evidencePath: null,
      evidenceDigest: null,
    },
  };
  const acceptanceBinding: ProviderInvocationAcceptanceBinding = {
    ...acceptancePayload,
    bindingDigest: sha256(canonicalJson(acceptancePayload)),
  };
  return { ...input, acceptanceBinding };
}

export function executableIdentity(
  candidatePath: string,
  realPath: string,
): ProviderExecutableIdentity {
  return {
    candidatePath,
    realPath,
    device: '1',
    inode: '2',
    mode: 0o100755,
    uid: 501,
    gid: 20,
    size: 100,
    mtimeNs: '1000',
    sha256: 'f'.repeat(64),
  };
}

export function successfulProbe(stdout: string) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 1,
    stdout,
    stderr: '',
  };
}

export function fakeHost(
  override: Partial<ProviderRunnerHost> = {},
): ProviderRunnerHost {
  return {
    inspectCandidate: () => null,
    runProbe: () => successfulProbe(''),
    execute: () => successfulProbe(''),
    ...override,
  };
}

export function claudeRunnerHost(
  execute: ProviderRunnerHost['execute'],
): ProviderRunnerHost {
  const identity = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/2.1.206/claude',
  );
  return fakeHost({
    inspectCandidate(candidate) {
      return candidate === '/opt/homebrew/bin/claude' ? identity : null;
    },
    runProbe(input) {
      if (input.args[0] === '--version') {
        return successfulProbe('2.1.206 (Claude Code)\n');
      }
      if (input.args[0] === 'auth') {
        return successfulProbe('{"loggedIn":true}\n');
      }
      return successfulProbe(
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
    execute,
  });
}

export function codexRunnerHost(
  execute: ProviderRunnerHost['execute'],
): ProviderRunnerHost {
  const identity = executableIdentity(
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  );
  return fakeHost({
    inspectCandidate(candidate) {
      return candidate === identity.candidatePath ? identity : null;
    },
    runProbe(input) {
      if (input.args[0] === '--version') {
        return successfulProbe('codex-cli 0.145.0-alpha.30\n');
      }
      if (input.args[0] === 'login') {
        return successfulProbe('Logged in using ChatGPT\n');
      }
      return successfulProbe(
        input.args[0] === 'exec'
          ? [
              '--sandbox',
              '--cd',
              '--ephemeral',
              '--ignore-user-config',
              '--ignore-rules',
              '--output-schema',
              '--output-last-message',
              '--json',
              '--color',
            ].join('\n')
          : ['exec', '--ask-for-approval'].join('\n'),
      );
    },
    execute,
  });
}

export function writeAdapterPolicy(
  repository: string,
  claudeEnabled = true,
  maxConcurrent = 2,
  timeoutMs = 300_000,
): string {
  const policyPath = path.join(repository, 'workflow/ai-adapter-policy.json');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  const content = `${JSON.stringify(
    {
      schemaVersion: 4,
      mode: 'managed-read-only',
      launchPolicy: 'lifecycle-only',
      requiredControls: [
        'separate-security-principal',
        'kernel-enforced-write-boundary',
        'git-common-directory-isolation',
        'network-egress-control',
        'secret-isolation',
        'subprocess-tree-confinement',
        'resource-limits',
        'immutable-runtime',
      ],
      providers: {
        codex: { enabled: true },
        claude: { enabled: claudeEnabled },
      },
      limits: {
        timeoutMs,
        aggregateOutputBytes: 1_048_576,
        maxConcurrent,
      },
      retryAccounting: structuredClone(DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING),
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(policyPath, content);
  return content;
}

export function writeProviderExecutionPolicySnapshot(
  invocationDirectory: string,
  request: ProviderInvocationRequest,
  policyDocument: string,
): void {
  rewritePrivateJson(
    path.join(invocationDirectory, 'execution-policy.json'),
    createProviderExecutionPolicySnapshot(
      request,
      parseAiAdapterPolicyDocument(policyDocument),
    ),
  );
}

export function createPrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  let current = directory;
  while (path.basename(current) !== '.git') {
    fs.chmodSync(current, 0o700);
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Expected a .git ancestor for ${directory}`);
    }
    current = parent;
  }
}

export function rewritePrivateJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

export function writeProviderSlot(
  repository: string,
  index: number,
  pid: number,
): void {
  const directory = path.join(
    repository,
    '.git',
    'workflow-engine',
    'investigations',
    'provider-slots',
  );
  createPrivateDirectory(directory);
  rewritePrivateJson(path.join(directory, `slot-${index}.lock`), {
    schemaVersion: 1,
    ownerToken: `test-owner-${index}`,
    invocationId: `invocation-test-slot-${index}`,
    pid,
    createdAt: '2026-07-23T00:00:00.000Z',
  });
}

export function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
