import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildClaudeProviderInvocation,
  CLAUDE_EXECUTABLE_CANDIDATES,
  CLAUDE_REQUIRED_HELP_FLAGS,
} from '../src/adapters/providers/claude/claude-provider-adapter.ts';
import {
  buildCodexProviderInvocation,
  CODEX_EXECUTABLE_CANDIDATES,
} from '../src/adapters/providers/codex/codex-provider-adapter.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING,
  parseAiAdapterPolicyDocument,
} from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import {
  createProviderExecutionEnvironment,
  createTrustedExecutionEnvironment,
} from '../src/runtime/provider-execution/execution-environment.ts';
import {
  buildContextManifest,
  inspectDurableEpochContextStore,
  inspectDurableRetentionCatalog,
  rolloverDurableEpochContextStore,
  storeDurableEvidence,
} from '../src/modules/authority/execution-governance.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  captureGovernedProviderProjection,
  compareGovernedProviderProjections,
  discoverRepository,
} from '../src/runtime/repository-transaction/git.ts';
import {
  createProviderInvocationRequest,
  type ProviderInvocationRequest,
  type ProviderInvocationRequestInput,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  blindSurveyOutputValidator,
  claimProviderInvocation,
  completeProviderInvocationFromRunner,
  createProviderExecutionPolicySnapshot,
  createProviderInvocation,
  prepareProviderInvocationAcceptanceBinding,
  readProviderInvocation,
  recoverProviderInvocationCompletion,
  storeProviderExecutionPolicySnapshot,
  type ProviderInvocationAcceptanceBinding,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { readProviderInvocationLifecycleProjection } from '../src/runtime/storage-journal/investigation-session-store.ts';
import {
  providerExecutionAdmissionAuthorityPath,
  readExecutionJobState,
} from '../src/runtime/storage-journal/execution-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
} from '../src/modules/assurance/plan-review.ts';
import {
  assembleProviderPromptManifest,
  ensureProviderPromptContext,
  extractProviderRepairFailure,
  prepareProviderPromptContextForInvocation,
  providerPromptContextStoreRoot,
} from '../src/runtime/provider-execution/provider-execution-governance.ts';
import {
  createProviderRunnerForTesting,
  preflightBuiltInProvider,
  type ProviderExecutableIdentity,
  type ProviderRunInput,
  type ProviderRunnerHost,
} from '../src/runtime/provider-execution/provider-runner.ts';
import { spawnBoundedProviderProcess } from '../src/runtime/provider-execution/bounded-provider-process.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '../src/runtime/provider-execution/built-in-provider-definition.ts';
import { createBuiltInAgentRuntimeV1Bridge } from '../src/composition-root/agent-runtime-v1-production.ts';
import { runHostWrapperProviderThroughAgentRuntimeV1 } from '../src/composition-root/agent-runtime-host-wrapper-production.ts';
import { productionAgentRuntime } from '../src/composition-root/agent-runtime-production.ts';
import { agentRuntimeNativeSessionIdDigestV1 } from '@jigwright/core/agent-runtime-port';
import {
  parseAgentProviderConfigToml,
  type BuiltInReviewedProviderProfileSnapshot,
  type HostWrapperProviderProfileSnapshot,
  type ProviderWrapperSessionProtocolBinding,
} from '@jigwright/agent-runtime';
import type { ProviderExecutableObservation } from '@jigwright/agent-runtime/provider-executable-identity';
import type {
  AgentRuntimeAssignmentBindingV1,
  AgentRuntimeNativeSessionTurnControllerV1,
  AgentRuntimeSingleShotInput,
} from '../src/modules/provider-orchestration/agent-runtime-port.ts';
import { createAgentRuntimeAssignmentBindingV1 } from '../src/modules/provider-orchestration/agent-runtime-assignment-binding.ts';
import {
  assertAgentRuntimeHostExecutionBindingV1,
  type AgentRuntimeHostExecutionBindingV1,
} from '../src/modules/provider-orchestration/agent-runtime-host-execution-binding.ts';
import {
  type ProviderNativeSessionClaimV1,
  type ProviderNativeSessionCompletionV1,
} from '../src/modules/provider-orchestration/provider-native-session.ts';
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
import { createOrReadExactChangeRoleAssignmentRecordV1 } from '../src/runtime/storage-journal/change-role-assignment-store.ts';
import {
  claimProviderNativeSessionTurnV1,
  completeClaimedProviderNativeSessionTurnV1,
  publishProviderNativeSessionContinuationAuthorityV1,
  readProviderNativeSessionChainV1,
} from '../src/runtime/storage-journal/provider-native-session-store.ts';
import {
  changeRoleAssignmentObjectPathV1,
  changeRoleAssignmentRefPathV1,
  changeRoleAssignmentStorePathsV1,
  providerNativeSessionClaimObjectPathV1,
  providerNativeSessionClaimRefPathV1,
  providerNativeSessionCompletionObjectPathV1,
  providerNativeSessionCompletionRefPathV1,
  providerNativeSessionContinuationAuthorityObjectPathV1,
  providerNativeSessionHandleObjectPathV1,
  providerNativeSessionStorePathsV1,
} from '../src/runtime/session-workspace/provider-runtime-authority-paths.ts';
import {
  assertProviderRuntimeProtocolReceipt,
  type ProviderRuntimeProtocolReceipt,
  type ProviderWrapperProtocolReceipt,
} from '../src/modules/provider-orchestration/agent-runtime-protocol.ts';
import {
  createFixtureRepository,
  git,
  sourceRepositoryRoot,
} from './fixture.ts';

const PROVIDER_SCHEMA = {
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

const providerWrapperFixture = path.join(
  import.meta.dirname,
  'fixtures/provider-wrapper-fixture.mjs',
);

function builtInProfile(
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

test('built-in adapters publish fixed candidates and capability-specific argv', () => {
  assert.deepEqual(CODEX_EXECUTABLE_CANDIDATES.darwin, [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
  ]);
  assert.deepEqual(CLAUDE_EXECUTABLE_CANDIDATES.darwin, [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]);
  assert.equal(
    CLAUDE_EXECUTABLE_CANDIDATES.darwin.includes(
      '/Applications/Claude.app/Contents/MacOS/claude',
    ),
    false,
  );
  assert.equal(Object.isFrozen(CODEX_EXECUTABLE_CANDIDATES), true);
  assert.equal(Object.isFrozen(CODEX_EXECUTABLE_CANDIDATES.darwin), true);
  assert.equal(Object.isFrozen(CLAUDE_EXECUTABLE_CANDIDATES), true);
  assert.equal(Object.isFrozen(CLAUDE_EXECUTABLE_CANDIDATES.darwin), true);
  assert.deepEqual(
    resolveBuiltInProviderDefinitionSnapshot('claude', 'darwin')
      ?.executableCandidates,
    CLAUDE_EXECUTABLE_CANDIDATES.darwin,
  );
  assert.deepEqual(
    resolveBuiltInProviderDefinitionSnapshot('codex', 'darwin')
      ?.executableCandidates,
    CODEX_EXECUTABLE_CANDIDATES.darwin,
  );

  const codex = buildCodexProviderInvocation({
    executable: '/real/codex',
    repositoryRoot: '/repo',
    promptPath: '/runtime/prompt.json',
    schemaPath: '/runtime/schema.json',
    semanticOutputPath: '/runtime/semantic-output.json',
  });
  assert.equal(codex.executable, '/real/codex');
  assert.equal(codex.shell, false);
  assert.equal(codex.cwd, '/repo');
  assert.equal(Object.isFrozen(codex), true);
  assert.equal(Object.isFrozen(codex.args), true);
  assert.deepEqual(codex.args, [
    '-a',
    'never',
    '-s',
    'read-only',
    '-C',
    '/repo',
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--json',
    '--color',
    'never',
    '--output-schema',
    '/runtime/schema.json',
    '--output-last-message',
    '/runtime/semantic-output.json',
    '-',
  ]);
  assert.equal(codex.stdinSource, '/runtime/prompt.json');

  const claude = buildClaudeProviderInvocation({
    executable: '/real/claude',
    repositoryRoot: '/repo',
    promptPath: '/runtime/prompt.json',
    schemaPath: '/runtime/schema.json',
    semanticOutputPath: '/runtime/semantic-output.json',
    semanticOutputSchema: PROVIDER_SCHEMA,
  });
  assert.equal(claude.executable, '/real/claude');
  assert.equal(claude.shell, false);
  assert.equal(claude.cwd, '/repo');
  assert.equal(Object.isFrozen(claude), true);
  assert.equal(Object.isFrozen(claude.args), true);
  assert.deepEqual(claude.args, [
    '--print',
    '--output-format',
    'json',
    '--no-session-persistence',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-chrome',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--permission-mode',
    'plan',
    '--tools',
    'Read,Glob,Grep',
    '--allowedTools',
    'Read,Glob,Grep',
    '--effort',
    'max',
    '--json-schema',
    canonicalJson(PROVIDER_SCHEMA),
  ]);
  assert.equal(claude.stdinSource, '/runtime/prompt.json');
  assert.equal(
    claude.args.some((argument) => argument === 'high'),
    false,
  );
  assert.ok(CLAUDE_REQUIRED_HELP_FLAGS.includes('--allowedTools'));
  assert.ok(CLAUDE_REQUIRED_HELP_FLAGS.includes('--effort'));
});

test('code-owned provider schemas omit unsupported external meta-schema identifiers', () => {
  for (const [schema, identity] of [
    [BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA, BLIND_SURVEY_OUTPUT_SCHEMA],
    [PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA, PLAN_REVIEW_OUTPUT_SCHEMA],
  ] as const) {
    assert.equal(Object.hasOwn(schema, '$schema'), false);

    const claude = buildClaudeProviderInvocation({
      executable: '/real/claude',
      repositoryRoot: '/repo',
      promptPath: '/runtime/prompt.json',
      schemaPath: '/runtime/schema.json',
      semanticOutputPath: '/runtime/semantic-output.json',
      semanticOutputSchema: schema,
    });
    const schemaFlagIndex = claude.args.indexOf('--json-schema');
    assert.notEqual(schemaFlagIndex, -1);
    const transmitted = claude.args[schemaFlagIndex + 1]!;
    assert.deepEqual(JSON.parse(transmitted), schema);
    assert.equal(sha256(transmitted), identity.digest);
  }
  assert.equal(
    Object.hasOwn(PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA, '$comment'),
    true,
  );
  assert.equal(
    Object.hasOwn(PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA, '$defs'),
    true,
  );
});

test('provider requests accept Git SHA-256 object identities', () => {
  const repository = createFixtureRepository();
  try {
    const policyDigest = crypto
      .createHash('sha256')
      .update('provider-policy')
      .digest('hex');
    const input = providerRequestInput(policyDigest, repository);
    input.baseCommit = 'a'.repeat(64);
    input.baseTree = 'b'.repeat(64);

    const request = createProviderInvocationRequest(input);

    assert.equal(request.baseCommit, input.baseCommit);
    assert.equal(request.baseTree, input.baseTree);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider environments preserve only reviewed provider-specific auth context', () => {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-env-'),
  );
  try {
    const source = {
      HOME: temporaryDirectory,
      USER: 'reviewer',
      LOGNAME: 'reviewer',
      CODEX_HOME: path.join(temporaryDirectory, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(temporaryDirectory, '.claude'),
      OPENAI_API_KEY: 'must-not-leak',
      ANTHROPIC_API_KEY: 'must-not-leak',
      NODE_OPTIONS: '--require=/tmp/evil.cjs',
      DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      GIT_CONFIG_GLOBAL: '/tmp/evil.gitconfig',
      PATH: '/tmp/fake-provider-bin',
      UNRELATED_SECRET: 'must-not-leak',
    };
    fs.mkdirSync(source.CODEX_HOME);
    fs.mkdirSync(source.CLAUDE_CONFIG_DIR);

    const codex = createProviderExecutionEnvironment(
      'codex',
      process.execPath,
      temporaryDirectory,
      source,
    );
    const claude = createProviderExecutionEnvironment(
      'claude',
      process.execPath,
      temporaryDirectory,
      source,
    );
    const neutralWrapper = createProviderExecutionEnvironment(
      null,
      process.execPath,
      temporaryDirectory,
      source,
    );

    assert.equal(codex.CODEX_HOME, source.CODEX_HOME);
    assert.equal(codex.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(claude.CLAUDE_CONFIG_DIR, source.CLAUDE_CONFIG_DIR);
    assert.equal(claude.CODEX_HOME, undefined);
    assert.equal(neutralWrapper.CODEX_HOME, undefined);
    assert.equal(neutralWrapper.CLAUDE_CONFIG_DIR, undefined);
    for (const environment of [codex, claude, neutralWrapper]) {
      assert.equal(environment.HOME, source.HOME);
      assert.equal(environment.USER, 'reviewer');
      assert.equal(environment.LOGNAME, 'reviewer');
      assert.equal(environment.OPENAI_API_KEY, undefined);
      assert.equal(environment.ANTHROPIC_API_KEY, undefined);
      assert.equal(environment.NODE_OPTIONS, undefined);
      assert.equal(environment.DYLD_INSERT_LIBRARIES, undefined);
      assert.equal(environment.UNRELATED_SECRET, undefined);
      assert.notEqual(environment.GIT_CONFIG_GLOBAL, source.GIT_CONFIG_GLOBAL);
      assert.equal(environment.TMPDIR, fs.realpathSync(temporaryDirectory));
      assert.equal(environment.TERM, 'dumb');
      assert.equal(environment.CI, '1');
      assert.equal(environment.GIT_PAGER, 'cat');
      assert.equal(environment.GIT_ATTR_NOSYSTEM, '1');
      assert.equal(environment.PATH?.includes('/tmp/fake-provider-bin'), false);
    }

    assert.equal(createTrustedExecutionEnvironment().GIT_ATTR_NOSYSTEM, '1');

    const rejectedRelativeHome = createProviderExecutionEnvironment(
      'claude',
      process.execPath,
      temporaryDirectory,
      { HOME: 'relative/home', USER: 'reviewer' },
    );
    assert.equal(rejectedRelativeHome.HOME, undefined);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('provider preflight inspects only fixed candidates and records canonical identity', () => {
  const inspected: string[] = [];
  const probed: string[][] = [];
  const identity = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/2.1.206/claude',
  );
  const host = fakeHost({
    inspectCandidate(candidate) {
      inspected.push(candidate);
      return candidate === '/opt/homebrew/bin/claude' ? identity : null;
    },
    runProbe(input) {
      probed.push(input.args);
      if (input.args[0] === '--version') {
        return successfulProbe('2.1.206 (Claude Code)\n');
      }
      if (input.args[0] === 'auth') {
        return successfulProbe('{"loggedIn":true,"authMethod":"claude.ai"}\n');
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
  });

  const preflight = createProviderRunnerForTesting(host).preflight;
  const resolution = preflight('claude', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: {
      PATH: '/tmp/fake-provider-bin',
      HOME: os.homedir(),
    },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'available');
  assert.equal(resolution.version, '2.1.206 (Claude Code)');
  assert.deepEqual(resolution.executable, identity);
  assert.deepEqual(inspected, [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ]);
  assert.equal(
    inspected.some((candidate) => candidate.includes('/tmp/fake-provider-bin')),
    false,
  );
  assert.deepEqual(probed, [['--version'], ['--help'], ['auth', 'status']]);

  const disabled = createProviderRunnerForTesting(
    fakeHost({
      inspectCandidate() {
        assert.fail('disabled providers must not be inspected');
      },
    }),
  ).preflight('claude', {
    platform: 'darwin',
    enabled: false,
    sourceEnvironment: process.env,
    temporaryDirectory: os.tmpdir(),
  });
  assert.equal(disabled.status, 'disabled');
  assert.equal(typeof preflightBuiltInProvider, 'function');
});

test('provider preflight preserves shared executable observation states', () => {
  const candidate = '/opt/homebrew/bin/claude';
  const identity = executableIdentity(candidate, candidate);
  const resolve = (observation: ProviderExecutableObservation) =>
    createProviderRunnerForTesting(
      fakeHost({
        inspectCandidate(observedCandidate) {
          return observedCandidate === candidate ? observation : null;
        },
        runProbe(input) {
          if (input.args[0] === '--version') {
            return successfulProbe('2.1.206 (Claude Code)\n');
          }
          if (input.args[0] === 'auth') {
            return successfulProbe('{"loggedIn":true}\n');
          }
          return successfulProbe(CLAUDE_REQUIRED_HELP_FLAGS.join('\n'));
        },
      }),
    ).preflight('claude', {
      platform: 'darwin',
      enabled: true,
      sourceEnvironment: { HOME: os.homedir() },
      temporaryDirectory: os.tmpdir(),
    });

  assert.equal(
    resolve({
      schemaVersion: 1,
      kind: 'provider-executable-observation',
      candidatePath: candidate,
      state: 'absent',
      unsafeReason: null,
      identity: null,
    }).status,
    'absent',
  );
  assert.equal(
    resolve({
      schemaVersion: 1,
      kind: 'provider-executable-observation',
      candidatePath: candidate,
      state: 'unsafe',
      unsafeReason: 'GROUP_OR_WORLD_WRITABLE',
      identity: null,
    }).status,
    'unsafe-candidate',
  );
  const observed = resolve({
    schemaVersion: 1,
    kind: 'provider-executable-observation',
    candidatePath: candidate,
    state: 'observed',
    unsafeReason: null,
    identity,
  });
  assert.equal(observed.status, 'available');
  assert.deepEqual(observed.executable, identity);
});

test('Codex preflight probes root and exec capability surfaces with its own auth command', () => {
  const probed: string[][] = [];
  const identity = executableIdentity(
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
  );
  const resolution = createProviderRunnerForTesting(
    fakeHost({
      inspectCandidate(candidate) {
        return candidate === identity.candidatePath ? identity : null;
      },
      runProbe(input) {
        probed.push(input.args);
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
    }),
  ).preflight('codex', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: { HOME: os.homedir() },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'available');
  assert.deepEqual(probed, [
    ['--version'],
    ['--help'],
    ['exec', '--help'],
    ['login', 'status'],
  ]);
});

test('provider preflight rejects ambiguous successful authentication output', () => {
  for (const [providerId, authCommand, authOutput] of [
    ['claude', 'auth', '{}\n'],
    ['codex', 'login', 'Authentication required\n'],
  ] as const) {
    const candidate =
      providerId === 'claude'
        ? '/opt/homebrew/bin/claude'
        : '/Applications/ChatGPT.app/Contents/Resources/codex';
    const identity = executableIdentity(
      candidate,
      providerId === 'claude'
        ? '/opt/homebrew/Caskroom/claude-code/2.1.206/claude'
        : candidate,
    );
    const resolution = createProviderRunnerForTesting(
      fakeHost({
        inspectCandidate(observed) {
          return observed === candidate ? identity : null;
        },
        runProbe(input) {
          if (input.args[0] === '--version') {
            return successfulProbe(`${providerId} 1.0.0\n`);
          }
          if (input.args[0] === authCommand) {
            return successfulProbe(authOutput);
          }
          return successfulProbe(
            providerId === 'claude'
              ? CLAUDE_REQUIRED_HELP_FLAGS.join('\n')
              : input.args[0] === 'exec'
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
      }),
    ).preflight(providerId, {
      platform: 'darwin',
      enabled: true,
      sourceEnvironment: { HOME: os.homedir() },
      temporaryDirectory: os.tmpdir(),
    });

    assert.equal(resolution.status, 'unauthenticated');
  }
});

test('preflight continues to a later reviewed candidate when the first is incompatible', () => {
  const first = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/1.0.0/claude',
  );
  const second = executableIdentity(
    '/usr/local/bin/claude',
    '/usr/local/Caskroom/claude-code/2.1.206/claude',
  );
  const probed: string[] = [];
  const resolution = createProviderRunnerForTesting(
    fakeHost({
      inspectCandidate(candidate) {
        return candidate === first.candidatePath
          ? first
          : candidate === second.candidatePath
            ? second
            : null;
      },
      runProbe(input) {
        probed.push(`${input.executable}:${input.args.join(' ')}`);
        if (input.args[0] === '--version') {
          return successfulProbe(
            input.executable === first.realPath ? '1.0.0\n' : '2.1.206\n',
          );
        }
        if (input.args[0] === '--help') {
          return successfulProbe(
            input.executable === first.realPath
              ? '--print\n'
              : CLAUDE_REQUIRED_HELP_FLAGS.join('\n'),
          );
        }
        return successfulProbe('{"loggedIn":true}\n');
      },
    }),
  ).preflight('claude', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: { HOME: os.homedir() },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'available');
  assert.equal(resolution.executable?.realPath, second.realPath);
  assert.ok(probed.some((entry) => entry.startsWith(first.realPath)));
  assert.ok(probed.some((entry) => entry.startsWith(second.realPath)));
});

test('assigned built-in preflight probes only the exact selected profile executable', () => {
  const unselected = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/3.0.0/claude',
  );
  const selected = executableIdentity(
    '/usr/local/bin/claude',
    '/usr/local/Caskroom/claude-code/2.1.206/claude',
  );
  const inspected: string[] = [];
  const probed: string[] = [];
  const runner = createProviderRunnerForTesting(
    fakeHost({
      inspectCandidate(candidate) {
        inspected.push(candidate);
        return candidate === unselected.candidatePath
          ? unselected
          : candidate === selected.candidatePath
            ? selected
            : null;
      },
      runProbe(input) {
        probed.push(input.executable);
        if (input.args[0] === '--version') {
          return successfulProbe('2.1.206\n');
        }
        if (input.args[0] === '--help') {
          return successfulProbe(CLAUDE_REQUIRED_HELP_FLAGS.join('\n'));
        }
        return successfulProbe('{"loggedIn":true}\n');
      },
    }),
  );

  const resolution = runner.preflightProfile(
    builtInProfile('/usr/local/bin/claude'),
    {
      platform: 'darwin',
      enabled: true,
      sourceEnvironment: { HOME: os.homedir() },
      temporaryDirectory: os.tmpdir(),
    },
  );

  assert.equal(resolution.status, 'available');
  assert.equal(resolution.executable?.candidatePath, selected.candidatePath);
  assert.deepEqual(inspected, [selected.candidatePath]);
  assert.equal(
    probed.every((candidate) => candidate === selected.realPath),
    true,
  );
});

test('provider preflight rejects a reviewed symlink that resolves outside reviewed roots', () => {
  let probeCount = 0;
  const resolution = createProviderRunnerForTesting(
    fakeHost({
      inspectCandidate(candidate) {
        return candidate === '/opt/homebrew/bin/claude'
          ? executableIdentity(candidate, '/tmp/caller-controlled-claude')
          : null;
      },
      runProbe() {
        probeCount += 1;
        return successfulProbe('');
      },
    }),
  ).preflight('claude', {
    platform: 'darwin',
    enabled: true,
    sourceEnvironment: { HOME: os.homedir() },
    temporaryDirectory: os.tmpdir(),
  });

  assert.equal(resolution.status, 'unsafe-candidate');
  assert.equal(probeCount, 0);
});

test('provider preflight rejects real paths outside exact reviewed install roots', () => {
  for (const realPath of [
    '/opt/homebrew/tmp/claude',
    '/opt/homebrew/Caskroom/unrelated-tool/1.0.0/claude',
  ]) {
    let probeCount = 0;
    const resolution = createProviderRunnerForTesting(
      fakeHost({
        inspectCandidate(candidate) {
          return candidate === '/opt/homebrew/bin/claude'
            ? executableIdentity(candidate, realPath)
            : null;
        },
        runProbe() {
          probeCount += 1;
          return successfulProbe('');
        },
      }),
    ).preflight('claude', {
      platform: 'darwin',
      enabled: true,
      sourceEnvironment: { HOME: os.homedir() },
      temporaryDirectory: os.tmpdir(),
    });

    assert.equal(resolution.status, 'unsafe-candidate', realPath);
    assert.equal(probeCount, 0, realPath);
  }
});

test('governed projection names repository, planning, ref, index, ignored, and runtime drift', () => {
  const cases: Array<{
    expected: string;
    mutate(repository: string, runtimeInput: string): void;
  }> = [
    {
      expected: 'tracked-worktree',
      mutate(repository) {
        fs.writeFileSync(path.join(repository, 'src/.gitkeep'), 'changed\n');
      },
    },
    {
      expected: 'untracked-worktree',
      mutate(repository) {
        fs.writeFileSync(path.join(repository, 'src/untracked.ts'), 'new\n');
      },
    },
    {
      expected: 'ignored-worktree-manifest',
      mutate(repository) {
        fs.mkdirSync(path.join(repository, 'node_modules/new-package'), {
          recursive: true,
        });
        fs.writeFileSync(
          path.join(repository, 'node_modules/new-package/index.js'),
          'ignored\n',
        );
      },
    },
    {
      expected: 'index',
      mutate(repository) {
        fs.writeFileSync(path.join(repository, 'src/staged.ts'), 'staged\n');
        git(repository, ['add', 'src/staged.ts']);
      },
    },
    {
      expected: 'refs',
      mutate(repository) {
        const head = git(repository, ['rev-parse', 'HEAD']).trim();
        git(repository, ['update-ref', 'refs/heads/provider-drift', head]);
        git(repository, ['symbolic-ref', 'HEAD', 'refs/heads/provider-drift']);
      },
    },
    {
      expected: 'git-control',
      mutate(repository) {
        git(repository, ['config', 'provider.test-control', 'changed']);
      },
    },
    {
      expected: 'git-control',
      mutate(repository) {
        const infoDirectory = path.join(repository, '.git', 'objects', 'info');
        fs.mkdirSync(infoDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(infoDirectory, 'alternates'),
          '/tmp/untrusted-object-store\n',
        );
      },
    },
    {
      expected: 'git-control',
      mutate(repository) {
        const head = `${git(repository, ['rev-parse', 'HEAD']).trim()}\n`;
        for (const pseudoref of ['FETCH_HEAD', 'MERGE_HEAD', 'REBASE_HEAD']) {
          fs.writeFileSync(path.join(repository, '.git', pseudoref), head);
        }
      },
    },
    {
      expected: 'planning-artifacts',
      mutate(repository) {
        fs.appendFileSync(
          path.join(repository, 'openspec/changes/demo-change/design.md'),
          '\nchanged\n',
        );
      },
    },
    {
      expected: 'governed-runtime-inputs',
      mutate(_repository, runtimeInput) {
        fs.writeFileSync(runtimeInput, 'changed runtime input\n');
      },
    },
  ];

  for (const { expected, mutate } of cases) {
    const repository = createFixtureRepository();
    const runtimeDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'provider-runtime-input-'),
    );
    const runtimeInput = path.join(runtimeDirectory, 'request.json');
    try {
      fs.writeFileSync(runtimeInput, '{"request":"original"}\n');
      const before = captureGovernedProviderProjection(repository, [
        { id: 'request', path: runtimeInput },
      ]);
      mutate(repository, runtimeInput);
      const after = captureGovernedProviderProjection(repository, [
        { id: 'request', path: runtimeInput },
      ]);
      const comparison = compareGovernedProviderProjections(before, after);

      assert.equal(comparison.unchanged, false, expected);
      assert.ok(
        comparison.changedCategories.includes(expected),
        `${expected}: ${comparison.changedCategories.join(', ')}`,
      );
      assert.notEqual(comparison.beforeDigest, comparison.afterDigest);
    } finally {
      fs.rmSync(runtimeDirectory, { recursive: true, force: true });
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('governed refs projection binds symbolic-ref targets at the same object', () => {
  const repository = createFixtureRepository();
  try {
    const head = git(repository, ['rev-parse', 'HEAD']).trim();
    git(repository, ['update-ref', 'refs/heads/provider-alternate', head]);
    const before = captureGovernedProviderProjection(repository);
    git(repository, ['symbolic-ref', 'HEAD', 'refs/heads/provider-alternate']);
    const after = captureGovernedProviderProjection(repository);

    const comparison = compareGovernedProviderProjections(before, after);
    assert.equal(comparison.unchanged, false);
    assert.ok(comparison.changedCategories.includes('refs'));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed refs projection ignores unrelated shared refs during linked-worktree activity', () => {
  const repository = createFixtureRepository();
  const linkedParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-concurrent-worktree-'),
  );
  const linked = path.join(linkedParent, 'linked');
  try {
    git(repository, ['worktree', 'add', '-b', 'concurrent-task', linked]);
    const before = captureGovernedProviderProjection(repository);

    fs.writeFileSync(path.join(linked, 'concurrent-change.txt'), 'changed\n');
    git(linked, ['add', 'concurrent-change.txt']);
    git(linked, ['commit', '-m', 'Advance unrelated concurrent task']);
    // Shared refs that are not selected by this worktree are outside the
    // accidental-drift tripwire, including remote-tracking activity.
    git(repository, [
      'update-ref',
      'refs/remotes/origin/concurrent-task',
      git(linked, ['rev-parse', 'HEAD']).trim(),
    ]);

    const after = captureGovernedProviderProjection(repository);
    const comparison = compareGovernedProviderProjections(before, after);
    assert.equal(comparison.unchanged, true);
    assert.deepEqual(comparison.changedCategories, []);
  } finally {
    if (fs.existsSync(linked)) {
      git(repository, ['worktree', 'remove', '--force', linked]);
    }
    fs.rmSync(linkedParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed Git control rejects symlinked control roots', () => {
  const repository = createFixtureRepository();
  const hookTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-hooks-'));
  try {
    const hooks = path.join(repository, '.git', 'hooks');
    fs.rmSync(hooks, { recursive: true, force: true });
    fs.symlinkSync(hookTarget, hooks);

    assert.throws(
      () => captureGovernedProviderProjection(repository),
      (error) => isWorkflowError(error, 'GOVERNED_PROJECTION_FAILED'),
    );
  } finally {
    fs.rmSync(hookTarget, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed runtime directory policy rejects the bare parent segment', () => {
  const repository = createFixtureRepository();
  const runtimeDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-runtime-policy-'),
  );
  try {
    for (const mutableContentPaths of [[], ['..']]) {
      assert.throws(
        () =>
          captureGovernedProviderProjection(repository, [
            {
              id: 'semantic-output',
              path: runtimeDirectory,
              kind: 'directory-closure',
              expectedFiles: ['..'],
              mutableContentPaths,
            },
          ]),
        (error) => isWorkflowError(error, 'GOVERNED_PROJECTION_FAILED'),
      );
    }
  } finally {
    fs.rmSync(runtimeDirectory, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('governed Git control binds common-dir rerere state from a linked worktree', () => {
  const repository = createFixtureRepository();
  const linkedParent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'provider-linked-worktree-'),
  );
  const linked = path.join(linkedParent, 'linked');
  try {
    git(repository, ['worktree', 'add', '-b', 'provider-linked', linked]);
    const before = captureGovernedProviderProjection(linked);
    const rerere = path.join(
      repository,
      '.git',
      'rr-cache',
      '0123456789abcdef',
    );
    fs.mkdirSync(rerere, { recursive: true });
    fs.writeFileSync(path.join(rerere, 'preimage'), 'conflict\n');
    const after = captureGovernedProviderProjection(linked);

    const comparison = compareGovernedProviderProjections(before, after);
    assert.equal(comparison.unchanged, false);
    assert.ok(comparison.changedCategories.includes('git-control'));
  } finally {
    if (fs.existsSync(linked)) {
      git(repository, ['worktree', 'remove', '--force', linked]);
    }
    fs.rmSync(linkedParent, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('runner wraps provider-native output only after unchanged governed projection', () => {
  const fixture = createRunnerFixture();
  try {
    const host = claudeRunnerHost((input) => {
      assert.ok(Buffer.isBuffer(input.stdinContent));
      const prompt = JSON.parse(input.stdinContent.toString('utf8'));
      assert.equal(prompt.kind, 'managed-provider-prompt');
      assert.equal(prompt.request.requestDigest, fixture.request.requestDigest);
      assert.equal(
        sha256(canonicalJson(prompt.manifest)),
        fixture.request.inputManifestDigest,
      );
      return {
        ...successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(fixture.request),
          }),
        ),
        elapsedMs: 12,
      };
    });
    const report = createProviderRunnerForTesting(host).run(fixture.input, {
      platform: 'darwin',
    });

    assert.deepEqual(report.semanticOutput, semanticOutput(fixture.request));
    assert.equal(report.requestDigest, fixture.request.requestDigest);
    assert.equal('result' in report, false);
    assert.equal(report.assurance, 'unchanged-governed-projection');
    assert.equal(report.projection.unchanged, true);
    assert.deepEqual(report.projection.changedCategories, []);
    assert.equal(report.sameUserProcessConfined, false);
    assert.equal(Object.isFrozen(report), true);
    assert.equal(Object.isFrozen(report.projection), true);
    assert.ok(report.residuals.includes('SAME_USER_PROCESS_NOT_CONFINED'));
    assert.ok(
      report.residuals.includes('TRANSIENT_WRITE_RESTORE_NOT_DETECTABLE'),
    );
    assert.ok(
      report.residuals.includes('UNREACHABLE_OBJECT_WRITES_NOT_OBSERVABLE'),
    );
    assert.ok(
      report.residuals.includes('GLOBAL_FILESYSTEM_IMMUTABILITY_NOT_PROVEN'),
    );
    assert.ok(report.residuals.includes('SUBPROCESS_TREE_NOT_CONFINED'));
    assert.ok(
      report.residuals.includes(
        'TRANSIENT_EXECUTABLE_SUBSTITUTION_NOT_DETECTABLE',
      ),
    );
    assert.ok(
      report.residuals.includes(
        'STALE_CONCURRENCY_SLOT_PID_REUSE_NOT_DETECTABLE',
      ),
    );
    assert.deepEqual(
      report.providerDefinitionSnapshot,
      resolveBuiltInProviderDefinitionSnapshot('claude', 'darwin'),
    );
    assert.ok(
      report.providerDefinitionSnapshot?.executableCandidates.includes(
        report.executable.candidatePath,
      ),
    );
    for (const name of ['prompt.json', 'schema.json', 'semantic-output.json']) {
      const stats = fs.lstatSync(
        path.join(fixture.input.invocationDirectory, 'runtime', name),
      );
      assert.equal(stats.isFile(), true);
      assert.equal(stats.isSymbolicLink(), false);
      assert.equal(stats.mode & 0o777, 0o600);
    }
  } finally {
    fixture.cleanup();
  }
});

test('assigned runner launch cannot fall back to an unselected higher-priority candidate', () => {
  const fixture = createRunnerFixture();
  const profile = builtInProfile('/usr/local/bin/claude');
  const selected = executableIdentity(
    profile.executable,
    '/usr/local/Caskroom/claude-code/2.1.206/claude',
  );
  const unselected = executableIdentity(
    '/opt/homebrew/bin/claude',
    '/opt/homebrew/Caskroom/claude-code/3.0.0/claude',
  );
  const inspected: string[] = [];
  try {
    const report = createProviderRunnerForTesting(
      fakeHost({
        inspectCandidate(candidate) {
          inspected.push(candidate);
          return candidate === selected.candidatePath
            ? selected
            : candidate === unselected.candidatePath
              ? unselected
              : null;
        },
        runProbe(input) {
          if (input.args[0] === '--version') {
            return successfulProbe('2.1.206\n');
          }
          if (input.args[0] === '--help') {
            return successfulProbe(CLAUDE_REQUIRED_HELP_FLAGS.join('\n'));
          }
          return successfulProbe('{"loggedIn":true}\n');
        },
        execute(input) {
          assert.equal(input.executable, selected.realPath);
          return successfulProbe(
            JSON.stringify({
              type: 'result',
              subtype: 'success',
              structured_output: semanticOutput(fixture.request),
            }),
          );
        },
      }),
    ).run(
      {
        ...fixture.input,
        assignmentBinding: createAgentRuntimeAssignmentBindingV1({
          schemaVersion: 1,
          kind: 'agent-runtime-assignment-binding.v1',
          changeId: 'selected-provider-profile',
          planningGeneration: '1'.repeat(64),
          recordDigest: '2'.repeat(64),
          assignmentDigest: '3'.repeat(64),
          role: 'author',
          logicalProviderId: profile.logicalProviderId,
          providerProfileId: profile.id,
          providerProfileSnapshot: profile,
          definitionDigest: resolveBuiltInProviderDefinitionSnapshot(
            'claude',
            'darwin',
          )!.definitionDigest,
          dataAuthorizationPolicyDigest: fixture.request.policyDigest,
          assignmentManifestDigest: '4'.repeat(64),
          inputManifestDigest: fixture.request.inputManifestDigest,
          targetDigest: fixture.request.targetDigest,
        }),
      },
      { platform: 'darwin' },
    );

    assert.equal(report.executable.candidatePath, selected.candidatePath);
    assert.equal(inspected.includes(unselected.candidatePath), false);
    assert.equal(
      inspected.every((candidate) => candidate === selected.candidatePath),
      true,
    );
  } finally {
    fixture.cleanup();
  }
});

test('fixed Codex launch binds the code-owned provider definition snapshot', () => {
  const fixture = createRunnerFixture('codex');
  try {
    const report = createProviderRunnerForTesting(
      codexRunnerHost((input) => {
        const outputIndex = input.args.indexOf('--output-last-message');
        assert.ok(outputIndex >= 0);
        fs.writeFileSync(
          input.args[outputIndex + 1]!,
          canonicalJson(semanticOutput(fixture.request)),
        );
        return successfulProbe('{"type":"turn.completed"}\n');
      }),
    ).run(fixture.input, { platform: 'darwin' });

    assert.deepEqual(
      report.providerDefinitionSnapshot,
      resolveBuiltInProviderDefinitionSnapshot('codex', 'darwin'),
    );
    assert.ok(
      report.providerDefinitionSnapshot?.executableCandidates.includes(
        report.executable.candidatePath,
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test('async runner uses the async execution host while preserving single-shot validation', async () => {
  const fixture = createRunnerFixture();
  const activity: string[] = [];
  try {
    const host = claudeRunnerHost(() => {
      assert.fail(
        'the async runner must not fall back to synchronous execution',
      );
    });
    host.executeAsync = async (input, control) => {
      assert.ok(Buffer.isBuffer(input.stdinContent));
      assert.equal(control.wrapperProtocol, undefined);
      control.onActivity?.({ type: 'spawned', elapsedMs: 0 });
      await Promise.resolve();
      control.onActivity?.({ type: 'stdout', elapsedMs: 1, bytes: 10 });
      return {
        ...successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(fixture.request),
          }),
        ),
        elapsedMs: 12,
      };
    };

    const report = await createProviderRunnerForTesting(host).runAsync(
      fixture.input,
      {
        platform: 'darwin',
        onActivity(event) {
          activity.push(event.type);
        },
      },
    );

    assert.deepEqual(report.semanticOutput, semanticOutput(fixture.request));
    assert.equal(report.assurance, 'unchanged-governed-projection');
    assert.deepEqual(activity, ['spawned', 'stdout']);
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          fixture.repository,
          '.git',
          'workflow-engine',
          'investigations',
          'provider-slots',
        ),
      ),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});

test('public AgentRuntimePortV1 bridges one fresh single-shot into the existing runner', async () => {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'runtime-v1-bridge-'),
  );
  const invocationDirectory = path.join(repository, 'invocation');
  fs.mkdirSync(invocationDirectory);
  const activity: string[] = [];
  try {
    const request = createProviderInvocationRequest({
      invocationId: 'invocation-runtime-v1-bridge',
      nonce: 'runtime-v1-bridge-nonce-000000000',
      purpose: 'survey',
      providerId: 'claude',
      roleAssignment: {
        role: 'blind-surveyor',
        providerId: 'claude',
        sessionId: 'runtime-v1-bridge-session',
        targetDigest: '1'.repeat(64),
        requiredIndependence: 'provider-independent',
        achievedIndependence: 'provider-independent',
      },
      capabilityProfile: 'repository-read-only',
      repositoryId: 'runtime-v1-fixture',
      baseCommit: '2'.repeat(40),
      baseTree: '3'.repeat(40),
      targetDigest: '1'.repeat(64),
      inputManifestDigest: '4'.repeat(64),
      authorizationNodeId: '5'.repeat(64),
      writeAllowedPaths: [],
      outputSchema: {
        id: 'runtime-v1-output',
        version: 1,
        digest: sha256(canonicalJson(PROVIDER_SCHEMA)),
      },
      evaluatorVersion: 'runtime-v1-fixture',
      policyDigest: '6'.repeat(64),
      limits: { timeoutMs: 30_000, aggregateOutputBytes: 1_048_576 },
    });
    const definition = resolveBuiltInProviderDefinitionSnapshot(
      'claude',
      'darwin',
    )!;
    const executable = executableIdentity(
      '/opt/homebrew/bin/claude',
      '/opt/homebrew/Caskroom/claude-code/2.1.206/claude',
    );
    const selectedProfile = builtInProfile(executable.candidatePath);
    const bridge = createBuiltInAgentRuntimeV1Bridge({
      preflight(providerId, options, profile) {
        assert.equal(providerId, 'claude');
        assert.equal(options.platform, 'darwin');
        assert.deepEqual(profile, selectedProfile);
        return {
          status: 'available',
          executable,
          version: '2.1.206 (Claude Code)',
        };
      },
      async runAsync(input, options) {
        options.onActivity?.({ type: 'spawned', elapsedMs: 0 });
        options.onActivity?.({ type: 'stdout', elapsedMs: 1, bytes: 7 });
        options.onActivity?.({ type: 'exited', elapsedMs: 2 });
        const output = semanticOutput(request);
        return {
          invocationId: request.invocationId,
          providerId: request.providerId,
          purpose: request.purpose,
          requestDigest: request.requestDigest,
          semanticOutput: output,
          semanticOutputDigest: sha256(canonicalJson(output)),
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: '7'.repeat(64),
            afterDigest: '7'.repeat(64),
          },
          sameUserProcessConfined: false,
          residuals: ['SAME_USER_PROCESS_NOT_CONFINED'],
          executable,
          elapsedMs: 2,
          providerDefinitionSnapshot: definition,
        };
      },
    });
    const acceptancePayload = {
      schemaVersion: 1 as const,
      kind: 'provider-invocation-acceptance-binding' as const,
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      ownerWorkflowId: 'workflow-runtime-v1',
      invocationRevision: 1,
      leaseGeneration: 1,
      context: {
        ownerWorkflowId: 'workflow-runtime-v1',
        purpose: request.purpose,
        workflowId: 'workflow-runtime-v1',
        generation: 1,
        epoch: 1,
        contextDigest: '8'.repeat(64),
        manifest:
          {} as ProviderInvocationAcceptanceBinding['context']['manifest'],
      },
      executionJobId: 'job-runtime-v1',
      executionAttemptId: 'attempt-runtime-v1',
      executionRevision: 1,
      executionStateDigest: '9'.repeat(64),
      receiptRequirement: 'schema-v4' as const,
      repair: {
        invocationId: request.invocationId,
        lineagePath: path.join(invocationDirectory, 'repair-lineage.json'),
        lineageDigest: null,
        currentEvidencePath: path.join(
          invocationDirectory,
          'repair-evidence.json',
        ),
        evidencePath: null,
        evidenceDigest: null,
      },
    };
    const acceptanceBinding = {
      ...acceptancePayload,
      bindingDigest: sha256(canonicalJson(acceptancePayload)),
    };
    const report = await bridge(
      {
        providerId: 'claude',
        repositoryRoot: repository,
        invocationDirectory,
        request,
        semanticOutputSchema: PROVIDER_SCHEMA,
        outputValidator: outputValidatorFor(request),
        governedRuntimeInputs: [],
        acceptanceBinding,
        reviewSnapshotRoot: null,
        sourceEnvironment: {},
        assignmentBinding: createAgentRuntimeAssignmentBindingV1({
          schemaVersion: 1,
          kind: 'agent-runtime-assignment-binding.v1',
          changeId: 'runtime-v1-bridge',
          planningGeneration: 'b'.repeat(64),
          recordDigest: 'c'.repeat(64),
          assignmentDigest: 'd'.repeat(64),
          role: 'author',
          logicalProviderId: 'claude',
          providerProfileId: selectedProfile.id,
          providerProfileSnapshot: selectedProfile,
          definitionDigest: definition.definitionDigest,
          dataAuthorizationPolicyDigest: request.policyDigest,
          assignmentManifestDigest: 'e'.repeat(64),
          inputManifestDigest: request.inputManifestDigest,
          targetDigest: request.targetDigest,
        }),
      },
      {
        platform: 'darwin',
        onActivity(event) {
          activity.push(event.type);
        },
      },
    );

    assert.deepEqual(report.semanticOutput, semanticOutput(request));
    assert.equal(report.requestDigest, request.requestDigest);
    assert.equal(report.assurance, 'unchanged-governed-projection');
    assert.deepEqual(activity, ['spawned', 'stdout', 'exited']);
    assert.deepEqual(
      report.providerDefinitionSnapshot,
      resolveBuiltInProviderDefinitionSnapshot('claude', 'darwin'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('async runner consumes harness-jsonl-v1 only after explicit adapter opt-in', async () => {
  const fixture = createRunnerFixture();
  const input = {
    ...bindRunnerInputToInvestigationOwner(
      fixture.input,
      'investigation-provider-wrapper-fixture',
    ),
    wrapperProtocol: { protocol: 'harness-jsonl-v1' as const },
  };
  try {
    const host = claudeRunnerHost(() => {
      assert.fail('wrapper protocol execution must remain asynchronous');
    });
    host.executeAsync = async (executeInput, control) => {
      assert.equal(control.wrapperProtocol?.protocol, 'harness-jsonl-v1');
      fs.writeFileSync(
        path.join(
          fixture.input.invocationDirectory,
          'runtime',
          'semantic-output.json',
        ),
        canonicalJson(semanticOutput(fixture.request)),
      );
      return await spawnBoundedProviderProcess({
        executable: process.execPath,
        args: [providerWrapperFixture, 'success'],
        cwd: executeInput.cwd,
        environment: executeInput.environment,
        timeoutMs: executeInput.timeoutMs,
        maxOutputBytes: executeInput.maxOutputBytes,
        wrapperProtocol: control.wrapperProtocol!,
      });
    };

    const report = await createProviderRunnerForTesting(host).runAsync(input, {
      platform: 'darwin',
    });

    assert.deepEqual(report.semanticOutput, semanticOutput(fixture.request));
    assert.equal(report.wrapperProtocolReceipt?.terminal, 'result');
    assert.equal(
      report.wrapperProtocolReceipt?.attemptId,
      input.acceptanceBinding!.executionAttemptId,
    );
  } finally {
    fixture.cleanup();
  }
});

test('production host-wrapper bridge starts and resumes one private native session through the public v1 port', async () => {
  const first = createRunnerFixture();
  const second = createRunnerFixture();
  const wrapper = path.join(
    sourceRepositoryRoot,
    'packages/agent-runtime/test/fixtures/provider-wrapper-fixture.mjs',
  );
  const profile = hostWrapperProfile(wrapper, true);
  const nativeSessionId = 'native-host-wrapper-1';
  const completionDigests = ['1'.repeat(64), '2'.repeat(64)];
  const terminals: unknown[] = [];
  const successActivities: string[] = [];
  let claimCount = 0;
  const controller = (
    action: 'start' | 'resume',
  ): Omit<
    AgentRuntimeNativeSessionTurnControllerV1,
    'assignmentBinding' | 'invocationBinding'
  > => ({
    profile,
    nextAction() {
      return action;
    },
    claim({ attemptId, expectedAction }) {
      assert.equal(expectedAction, action);
      claimCount += 1;
      const runtimeInput = action === 'start' ? first.input : second.input;
      const binding = {
        invocationId: runtimeInput.request.invocationId,
        requestDigest: runtimeInput.request.requestDigest,
        attemptId,
        sessionControl:
          action === 'start'
            ? {
                action: 'start' as const,
                nativeSessionIdentityMode: 'provider-observed' as const,
                expectedNativeSessionId: null,
              }
            : {
                action: 'resume' as const,
                nativeSessionIdentityMode: 'engine-supplied' as const,
                expectedNativeSessionId: nativeSessionId,
              },
      };
      const claim = fakeNativeSessionClaim(
        hostWrapperAssignmentBinding(runtimeInput, profile),
        profile,
        binding,
        action === 'start' ? null : completionDigests[0]!,
      );
      return {
        claim,
        claimDigest: claim.claimDigest,
        predecessorCompletionDigest:
          action === 'start' ? null : completionDigests[0]!,
        binding,
      };
    },
    complete(input) {
      terminals.push(input.terminal);
      return { completionDigest: completionDigests[terminals.length - 1]! };
    },
  });
  try {
    const firstInput = hostWrapperInput(
      bindRunnerInputToInvestigationOwner(
        first.input,
        'investigation-host-wrapper-start',
      ),
      profile,
      controller('start'),
    );
    const firstReport = await productionAgentRuntime.runSingleShotAsync!(
      firstInput,
      {
        platform: process.platform,
        onActivity(event) {
          successActivities.push(event.type);
          throw new Error('activity observer must remain non-authoritative');
        },
      },
    );
    assert.deepEqual(firstReport.semanticOutput, semanticOutput(first.request));
    assert.ok(successActivities.includes('spawned'));
    assert.ok(successActivities.includes('exited'));
    assert.equal(
      (
        firstReport.providerDefinitionSnapshot as HostWrapperProviderProfileSnapshot
      ).profileDigest,
      profile.profileDigest,
    );
    const firstHostBinding = firstReport.hostExecutionBinding;
    assert.ok(firstHostBinding?.probe);
    assert.deepEqual(firstHostBinding.probe.executable, firstReport.executable);
    const forgedHostBinding = structuredClone(
      firstHostBinding,
    ) as unknown as Record<string, unknown>;
    const forgedProbe = forgedHostBinding.probe as Record<string, unknown>;
    const forgedExecutable = forgedProbe.executable as Record<string, unknown>;
    forgedExecutable.candidatePath = `${wrapper}.forged`;
    forgedProbe.providerDefinitionBindingDigest = sha256(
      canonicalJson({
        providerDefinitionDigest: forgedProbe.providerProfileDigest,
        executable: forgedExecutable,
      }),
    );
    const forgedBody = { ...forgedHostBinding };
    delete forgedBody.bindingDigest;
    forgedHostBinding.bindingDigest = sha256(
      `workflow.agent-runtime-host-execution-binding.v1\n${canonicalJson(forgedBody)}`,
    );
    assert.throws(() =>
      assertAgentRuntimeHostExecutionBindingV1(forgedHostBinding),
    );
    const forgedExecutableBinding = structuredClone(
      firstHostBinding,
    ) as unknown as Record<string, unknown>;
    const forgedExecutableProbe = forgedExecutableBinding.probe as Record<
      string,
      unknown
    >;
    const forgedExecutableIdentity = forgedExecutableProbe.executable as Record<
      string,
      unknown
    >;
    forgedExecutableIdentity.realPath = `${forgedExecutableIdentity.realPath as string}.forged`;
    const forgedExecutableBody = { ...forgedExecutableBinding };
    delete forgedExecutableBody.bindingDigest;
    forgedExecutableBinding.bindingDigest = sha256(
      `workflow.agent-runtime-host-execution-binding.v1\n${canonicalJson(forgedExecutableBody)}`,
    );
    assert.throws(() =>
      assertAgentRuntimeHostExecutionBindingV1(forgedExecutableBinding),
    );

    const secondInput = hostWrapperInput(
      bindRunnerInputToInvestigationOwner(
        second.input,
        'investigation-host-wrapper-resume',
      ),
      profile,
      controller('resume'),
    );
    const secondReport = await productionAgentRuntime.runSingleShotAsync!(
      secondInput,
      { platform: process.platform },
    );
    assert.deepEqual(
      secondReport.semanticOutput,
      semanticOutput(second.request),
    );
    assert.equal(claimCount, 2);
    assert.equal(terminals.length, 2);
    assert.equal(JSON.stringify(terminals).includes(nativeSessionId), true);
    assert.equal(JSON.stringify(firstReport).includes(nativeSessionId), false);
    assert.equal(JSON.stringify(secondReport).includes(nativeSessionId), false);

    const firstReceipt = firstReport.wrapperProtocolReceipt;
    if (firstReceipt?.kind !== 'provider-wrapper-session-protocol-receipt') {
      assert.fail('host-wrapper start omitted its session protocol receipt');
    }
    const forgedResumeReceipt = structuredClone(
      firstReceipt,
    ) as unknown as Record<string, unknown>;
    forgedResumeReceipt.sessionAction = 'resume';
    forgedResumeReceipt.nativeSessionIdentityMode = 'engine-supplied';
    forgedResumeReceipt.expectedNativeSessionIdDigest =
      forgedResumeReceipt.observedNativeSessionIdDigest;
    const forgedPayload = { ...forgedResumeReceipt };
    delete forgedPayload.receiptDigest;
    forgedResumeReceipt.receiptDigest = sha256(canonicalJson(forgedPayload));
    assert.throws(() =>
      assertProviderRuntimeProtocolReceipt(forgedResumeReceipt, {
        invocationId: first.request.invocationId,
        requestDigest: first.request.requestDigest,
        attemptId: firstInput.acceptanceBinding.executionAttemptId,
        sessionControl: {
          action: 'start',
          nativeSessionIdentityMode: 'provider-observed',
          expectedNativeSessionId: null,
        },
      }),
    );
  } finally {
    first.cleanup();
    second.cleanup();
  }
});

test('production host-wrapper preserves terminal error evidence for the worker failure channel', async () => {
  const fixture = createRunnerFixture();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'host-wrapper-error-')),
  );
  const wrapper = path.join(hostDirectory, 'provider-wrapper.mjs');
  fs.writeFileSync(wrapper, canonicalHostWrapperFixture('error', 2), {
    mode: 0o700,
  });
  const profile = hostWrapperProfile(wrapper, false);
  const terminals: unknown[] = [];
  const observed: ProviderRuntimeProtocolReceipt[] = [];
  const activities: string[] = [];
  const failedHostBindings: AgentRuntimeHostExecutionBindingV1[] = [];
  const boundInput = bindRunnerInputToInvestigationOwner(
    fixture.input,
    'investigation-host-wrapper-error',
  );
  try {
    await assert.rejects(
      runHostWrapperProviderThroughAgentRuntimeV1(
        hostWrapperInput(
          boundInput,
          profile,
          hostWrapperStartController(boundInput, profile, terminals),
        ),
        {
          platform: process.platform,
          onActivity(event) {
            activities.push(event.type);
            throw new Error('activity observer must remain non-authoritative');
          },
          onProtocolReceipt(receipt) {
            observed.push(receipt);
            throw new Error('receipt observer must remain non-authoritative');
          },
          onHostExecutionBinding(binding) {
            failedHostBindings.push(binding);
          },
        },
      ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_V1_HOST_WRAPPER_FAILED',
    );
    assert.equal(observed.length, 1);
    assert.equal(
      observed[0]!.kind,
      'provider-wrapper-session-protocol-receipt',
    );
    assert.equal(observed[0]!.terminal, 'error');
    assert.equal(observed[0]!.errorCode, 'FIXTURE_REJECTED');
    assert.ok(activities.includes('spawned'));
    assert.ok(activities.includes('stdout'));
    assert.ok(activities.includes('exited'));
    assert.equal(failedHostBindings.length, 1);
    const failedHostBinding = assertAgentRuntimeHostExecutionBindingV1(
      failedHostBindings[0],
    );
    assert.ok(failedHostBinding.probe);
    assert.equal(
      failedHostBinding.probe.executable.candidatePath,
      profile.executable,
    );
    assert.equal(terminals.length, 1);
    assert.deepEqual(terminals[0], {
      kind: 'protocol-outcome',
      outcome: {
        schemaVersion: 2,
        kind: 'provider-wrapper-session-protocol-outcome',
        receipt: observed[0],
      },
      privateIdentityObservation: null,
    });
  } finally {
    fixture.cleanup();
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

test('production host-wrapper preserves cancelled process activity for the durable worker receipt', async () => {
  const fixture = createRunnerFixture();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'host-wrapper-cancelled-')),
  );
  const wrapper = path.join(hostDirectory, 'provider-wrapper.mjs');
  fs.writeFileSync(wrapper, canonicalHostWrapperFixture('cancelled'), {
    mode: 0o700,
  });
  const profile = hostWrapperProfile(wrapper, false);
  const terminals: unknown[] = [];
  const observed: ProviderRuntimeProtocolReceipt[] = [];
  const activities: string[] = [];
  const cancellation = new AbortController();
  const boundInput = bindRunnerInputToInvestigationOwner(
    fixture.input,
    'investigation-host-wrapper-cancelled',
  );
  let timer: NodeJS.Timeout | null = null;
  try {
    await assert.rejects(
      runHostWrapperProviderThroughAgentRuntimeV1(
        hostWrapperInput(
          boundInput,
          profile,
          hostWrapperStartController(boundInput, profile, terminals),
        ),
        {
          platform: process.platform,
          signal: cancellation.signal,
          onHostProbeEvidence() {
            timer = setTimeout(() => cancellation.abort(), 250);
          },
          onActivity(event) {
            activities.push(event.type);
          },
          onProtocolReceipt(receipt) {
            observed.push(receipt);
          },
        },
      ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_V1_HOST_WRAPPER_FAILED',
    );
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.terminal, 'cancelled');
    assert.ok(activities.includes('spawned'));
    assert.ok(activities.includes('cancelled'));
    assert.deepEqual(terminals, [
      {
        kind: 'protocol-outcome',
        outcome: {
          schemaVersion: 2,
          kind: 'provider-wrapper-session-protocol-outcome',
          receipt: observed[0],
        },
        privateIdentityObservation: null,
      },
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    fixture.cleanup();
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

test('production host-wrapper never turns a nonzero process with a result frame into a usable native session', async () => {
  const fixture = createRunnerFixture();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'host-wrapper-nonzero-result-')),
  );
  const wrapper = path.join(hostDirectory, 'provider-wrapper.mjs');
  fs.writeFileSync(wrapper, canonicalHostWrapperFixture('result', 1), {
    mode: 0o700,
  });
  const profile = hostWrapperProfile(wrapper, false);
  const terminals: unknown[] = [];
  const observed: ProviderRuntimeProtocolReceipt[] = [];
  const boundInput = bindRunnerInputToInvestigationOwner(
    fixture.input,
    'investigation-host-wrapper-nonzero-result',
  );
  try {
    await assert.rejects(
      runHostWrapperProviderThroughAgentRuntimeV1(
        hostWrapperInput(
          boundInput,
          profile,
          hostWrapperStartController(boundInput, profile, terminals),
        ),
        {
          platform: process.platform,
          onProtocolReceipt(receipt) {
            observed.push(receipt);
          },
        },
      ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_V1_HOST_WRAPPER_FAILED',
    );
    assert.equal(observed.length, 1);
    assert.equal(observed[0]!.terminal, 'result');
    assert.deepEqual(terminals, [
      {
        kind: 'protocol-outcome',
        outcome: {
          schemaVersion: 2,
          kind: 'provider-wrapper-session-protocol-outcome',
          receipt: observed[0],
        },
        privateIdentityObservation: null,
      },
    ]);
  } finally {
    fixture.cleanup();
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

test('production host-wrapper seals a semantically rejected result turn without a resumable handle', async () => {
  const fixture = createRunnerFixture();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'host-wrapper-invalid-result-')),
  );
  const wrapper = path.join(hostDirectory, 'provider-wrapper.mjs');
  fs.writeFileSync(wrapper, canonicalHostWrapperFixture('result'), {
    mode: 0o700,
  });
  const changeId = 'host-wrapper-invalid-result';
  const locator = discoverRepository(fixture.repository);
  const runtime = investigationRuntimePaths(
    locator.gitCommonDirectory,
    'workflow-engine',
  );
  const assignment = durableHostWrapperAssignment(
    changeId,
    fixture.request,
    wrapper,
    true,
  );
  createOrReadExactChangeRoleAssignmentRecordV1(
    runtime,
    assignment.record,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
  );
  const boundInput = bindRunnerInputToInvestigationOwner(
    fixture.input,
    'investigation-host-wrapper-invalid-result',
  );
  const nativeClaims: ProviderNativeSessionClaimV1[] = [];
  const nativeCompletions: ProviderNativeSessionCompletionV1[] = [];
  const hostBindings: AgentRuntimeHostExecutionBindingV1[] = [];
  const protocolReceipts: ProviderRuntimeProtocolReceipt[] = [];
  const input = hostWrapperInput(
    {
      ...boundInput,
      outputValidator: {
        ...boundInput.outputValidator,
        validate: () => false,
      },
    },
    assignment.profile,
    {
      profile: assignment.profile,
      nextAction: () => 'start',
      claim({ attemptId }) {
        const claimed = claimProviderNativeSessionTurnV1(
          runtime,
          {
            changeId: assignment.record.changeId,
            planningGeneration: assignment.record.planningGeneration,
            assignmentRecordDigest: assignment.record.recordDigest,
            sessionSlotId: assignment.slot.sessionSlotId,
            predecessorCompletionDigest: null,
            invocationId: fixture.request.invocationId,
            requestDigest: fixture.request.requestDigest,
            attemptId,
          },
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
        );
        assert.equal(claimed.outcome, 'claimed');
        assert.ok(claimed.binding);
        nativeClaims.push(claimed.claim);
        return {
          claim: claimed.claim,
          claimDigest: claimed.claim.claimDigest,
          predecessorCompletionDigest: null,
          binding: claimed.binding,
        };
      },
      complete(value) {
        const nativeClaim = nativeClaims.at(-1);
        assert.ok(nativeClaim);
        const completion = completeClaimedProviderNativeSessionTurnV1(runtime, {
          changeId: assignment.record.changeId,
          planningGeneration: assignment.record.planningGeneration,
          assignmentRecordDigest: assignment.record.recordDigest,
          sessionSlotId: assignment.slot.sessionSlotId,
          claimDigest: nativeClaim.claimDigest,
          terminal: value.terminal,
        });
        nativeCompletions.push(completion);
        return { completionDigest: completion.completionDigest };
      },
    },
    assignment.binding,
  );
  try {
    await assert.rejects(
      runHostWrapperProviderThroughAgentRuntimeV1(input, {
        platform: process.platform,
        onProtocolReceipt(receipt) {
          protocolReceipts.push(receipt);
        },
        onHostExecutionBinding(binding) {
          hostBindings.push(binding);
        },
      }),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_V1_OUTPUT_INVALID',
    );
    assert.equal(nativeClaims.length, 1);
    assert.equal(nativeCompletions.length, 1);
    const completion = nativeCompletions[0]!;
    assert.equal(completion.disposition, 'rejected');
    assert.equal(completion.usable, false);
    assert.equal(completion.protocolReceipt?.terminal, 'result');
    assert.notEqual(completion.nativeSessionIdDigest, null);
    assert.equal(completion.handleDigest, null);
    assert.deepEqual(protocolReceipts, [completion.protocolReceipt]);
    assert.equal(hostBindings.length, 1);
    const hostBinding = assertAgentRuntimeHostExecutionBindingV1(
      hostBindings[0],
    );
    assert.equal(
      hostBinding.nativeSessionCompletionDigest,
      completion.completionDigest,
    );
    const chain = readProviderNativeSessionChainV1(
      runtime,
      assignment.record.changeId,
      assignment.record.planningGeneration,
      assignment.record.recordDigest,
      assignment.slot.sessionSlotId,
      (candidate) => candidate,
      (candidate) => candidate,
      (candidate) => candidate,
      (candidate) => candidate,
      (candidate) => candidate,
      (candidate) => candidate,
      (candidate) => candidate,
    );
    assert.equal(chain.state, 'terminal-unusable');
    assert.equal(
      chain.turns[0]?.completion?.completionDigest,
      completion.completionDigest,
    );
    const locations = providerNativeSessionStorePathsV1(runtime);
    assert.equal(
      fs.existsSync(
        providerNativeSessionCompletionObjectPathV1(
          locations,
          completion.completionDigest,
        ),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(
        providerNativeSessionCompletionRefPathV1(
          locations,
          nativeClaims[0]!.scope.scopeKey,
          nativeClaims[0]!.turn,
        ),
      ),
      true,
    );
    assert.deepEqual(
      fs.existsSync(locations.handles) ? fs.readdirSync(locations.handles) : [],
      [],
    );
  } finally {
    fixture.cleanup();
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

test('production host-wrapper artifacts remain an exact provider lifecycle closure', async () => {
  const repository = createFixtureRepository();
  const hostDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'host-wrapper-lifecycle-')),
  );
  const wrapper = path.join(hostDirectory, 'provider-wrapper.mjs');
  fs.writeFileSync(wrapper, canonicalHostWrapperFixture(), { mode: 0o700 });
  const policyContent = writeAdapterPolicy(repository);
  const invocationId = 'invocation-host-wrapper-lifecycle';
  const investigationId = 'investigation-host-wrapper-lifecycle';
  const changeId = 'host-wrapper-lifecycle';
  const locator = discoverRepository(repository);
  const runtime = investigationRuntimePaths(
    locator.gitCommonDirectory,
    'workflow-engine',
  );
  const invocationDirectory = path.join(runtime.invocations, invocationId);
  const manifest = {
    schemaVersion: 1 as const,
    kind: 'blind-survey-manifest' as const,
    changeId,
    repositoryId: 'fixture',
    baseCommit: locator.head,
    baseTree: locator.tree,
    normalizedIntent: {
      schemaVersion: 1 as const,
      summary: 'Exercise the exact host-wrapper lifecycle closure.',
      explicitPaths: [],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion: 'Which exact provider artifacts bind this run?',
    capabilityProfile: 'repository-read-only' as const,
  };
  const manifestDigest = sha256(canonicalJson(manifest));
  const targetDigest = blindSurveyIntentDigest(manifest);
  const request = createProviderInvocationRequest({
    invocationId,
    nonce: 'host-wrapper-lifecycle-nonce-000001',
    purpose: 'survey',
    providerId: 'claude',
    roleAssignment: {
      role: 'blind-surveyor',
      providerId: 'claude',
      sessionId: 'provider-session-host-wrapper-lifecycle',
      targetDigest,
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: 'fixture',
    baseCommit: locator.head,
    baseTree: locator.tree,
    targetDigest,
    inputManifestDigest: manifestDigest,
    authorizationNodeId: 'e'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey-evaluator.v1',
    policyDigest: sha256(policyContent),
    limits: { timeoutMs: 30_000, aggregateOutputBytes: 1_048_576 },
  });
  storeProviderExecutionPolicySnapshot(
    runtime,
    request,
    parseAiAdapterPolicyDocument(policyContent),
  );
  createProviderInvocation(runtime, {
    investigationId,
    changeId,
    attempt: 1,
    manifest,
    request,
    createdAt: '2026-08-31T00:00:00.000Z',
  });
  const claim = claimProviderInvocation(runtime, invocationId, {
    workerId: 'provider-worker-host-wrapper-lifecycle',
    leaseDurationMs: request.limits.timeoutMs,
    now: '2026-08-31T00:00:01.000Z',
  });
  const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
    runtime,
    invocationId,
    'schema-v4',
  );
  const assignment = durableHostWrapperAssignment(
    changeId,
    request,
    wrapper,
    true,
  );
  createOrReadExactChangeRoleAssignmentRecordV1(
    runtime,
    assignment.record,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
    (candidate) => candidate,
  );
  const profile = assignment.profile;
  let completed = false;
  let nativeClaim: ProviderNativeSessionClaimV1 | null = null;
  let nativeCompletion: ProviderNativeSessionCompletionV1 | null = null;
  const input = hostWrapperInput(
    {
      providerId: 'claude',
      repositoryRoot: repository,
      invocationDirectory,
      request,
      semanticOutputSchema: BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
      outputValidator: blindSurveyOutputValidator(request),
      governedRuntimeInputs: [],
      acceptanceBinding,
      sourceEnvironment: {},
    },
    profile,
    {
      profile,
      nextAction: () => 'start',
      claim({ attemptId }) {
        const claimed = claimProviderNativeSessionTurnV1(
          runtime,
          {
            changeId: assignment.record.changeId,
            planningGeneration: assignment.record.planningGeneration,
            assignmentRecordDigest: assignment.record.recordDigest,
            sessionSlotId: assignment.slot.sessionSlotId,
            predecessorCompletionDigest: null,
            invocationId,
            requestDigest: request.requestDigest,
            attemptId,
          },
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
        );
        assert.equal(claimed.outcome, 'claimed');
        assert.ok(claimed.binding);
        nativeClaim = claimed.claim;
        return {
          claim: claimed.claim,
          claimDigest: claimed.claim.claimDigest,
          predecessorCompletionDigest: null,
          binding: claimed.binding,
        };
      },
      complete(value) {
        if (nativeClaim === null) assert.fail('native claim was not published');
        nativeCompletion = completeClaimedProviderNativeSessionTurnV1(runtime, {
          changeId: assignment.record.changeId,
          planningGeneration: assignment.record.planningGeneration,
          assignmentRecordDigest: assignment.record.recordDigest,
          sessionSlotId: assignment.slot.sessionSlotId,
          claimDigest: nativeClaim.claimDigest,
          terminal: value.terminal,
        });
        completed = true;
        return { completionDigest: nativeCompletion.completionDigest };
      },
    },
    assignment.binding,
  );
  try {
    const report = await productionAgentRuntime.runSingleShotAsync!(input, {
      platform: process.platform,
    });
    assert.deepEqual(report.semanticOutput, semanticOutput(request));
    assert.equal(
      report.wrapperProtocolReceipt?.kind,
      'provider-wrapper-session-protocol-receipt',
    );
    assert.equal(
      report.wrapperProtocolReceipt?.kind ===
        'provider-wrapper-session-protocol-receipt'
        ? report.wrapperProtocolReceipt.sessionAction
        : null,
      'start',
    );
    assert.equal(completed, true);

    assert.equal(
      readProviderInvocationLifecycleProjection(runtime, invocationId).state,
      'leased',
    );

    const probeDirectory = path.join(
      invocationDirectory,
      'host-wrapper-probe-runtime',
    );
    const turnDirectory = path.join(
      invocationDirectory,
      'host-wrapper-runtime',
    );
    const artifacts = [
      path.join(probeDirectory, 'request.json'),
      path.join(probeDirectory, 'probe-result.json'),
      path.join(turnDirectory, 'request.json'),
      path.join(turnDirectory, 'semantic-output.json'),
    ];
    const originals = new Map(
      artifacts.map((filePath) => [filePath, fs.readFileSync(filePath)]),
    );
    const assertUnsafe = () =>
      assert.throws(
        () => readProviderInvocationLifecycleProjection(runtime, invocationId),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE',
      );
    const restore = (filePath: string) => {
      fs.rmSync(filePath, { force: true });
      fs.writeFileSync(filePath, originals.get(filePath)!, { mode: 0o600 });
      fs.chmodSync(filePath, 0o600);
    };
    const replaceCanonical = (
      filePath: string,
      mutate: (value: Record<string, unknown>) => void,
    ) => {
      const value = JSON.parse(
        originals.get(filePath)!.toString('utf8'),
      ) as Record<string, unknown>;
      mutate(value);
      rewritePrivateJson(filePath, value);
      assertUnsafe();
      restore(filePath);
    };

    for (const directory of [probeDirectory, turnDirectory]) {
      fs.chmodSync(directory, 0o755);
      assertUnsafe();
      fs.chmodSync(directory, 0o700);

      const moved = path.join(
        hostDirectory,
        `${path.basename(directory)}.missing`,
      );
      fs.renameSync(directory, moved);
      if (directory === probeDirectory) {
        assertUnsafe();
      } else {
        assert.equal(
          readProviderInvocationLifecycleProjection(runtime, invocationId)
            .state,
          'leased',
        );
      }
      fs.renameSync(moved, directory);

      const extra = path.join(directory, 'unexpected.json');
      rewritePrivateJson(extra, { unexpected: true });
      assertUnsafe();
      fs.rmSync(extra);
    }
    const extraRoot = path.join(invocationDirectory, 'unexpected.json');
    rewritePrivateJson(extraRoot, { unexpected: true });
    assertUnsafe();
    fs.rmSync(extraRoot);

    for (const [index, filePath] of artifacts.entries()) {
      fs.chmodSync(filePath, 0o644);
      assertUnsafe();
      fs.chmodSync(filePath, 0o600);

      const moved = path.join(hostDirectory, `missing-${index}.json`);
      fs.renameSync(filePath, moved);
      if (filePath.endsWith('/semantic-output.json')) {
        assert.equal(
          readProviderInvocationLifecycleProjection(runtime, invocationId)
            .state,
          'leased',
        );
      } else {
        assertUnsafe();
      }
      fs.renameSync(moved, filePath);

      const target = path.join(hostDirectory, `symlink-target-${index}.json`);
      fs.writeFileSync(target, originals.get(filePath)!);
      fs.rmSync(filePath);
      fs.symlinkSync(target, filePath);
      assertUnsafe();
      restore(filePath);

      const parsed = JSON.parse(
        originals.get(filePath)!.toString('utf8'),
      ) as Record<string, unknown>;
      fs.writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
      if (!filePath.endsWith('/request.json')) {
        assert.equal(
          readProviderInvocationLifecycleProjection(runtime, invocationId)
            .state,
          'leased',
          'wrapper-produced JSON is bounded evidence and need not use the engine canonical encoding',
        );
      } else {
        assertUnsafe();
      }
      restore(filePath);
    }

    replaceCanonical(artifacts[0]!, (value) => {
      value.outputFile = path.join(hostDirectory, 'probe-result.json');
    });
    replaceCanonical(artifacts[0]!, (value) => {
      value.providerFamily = 'codex';
    });
    {
      const value = JSON.parse(
        originals.get(artifacts[0]!)!.toString('utf8'),
      ) as Record<string, unknown>;
      value.profileDigest = '0'.repeat(64);
      rewritePrivateJson(artifacts[0]!, value);
      assert.equal(
        readProviderInvocationLifecycleProjection(runtime, invocationId).state,
        'leased',
        'a syntactically valid probe profile remains bounded evidence until terminal runtime evidence binds it',
      );
      restore(artifacts[0]!);
    }
    replaceCanonical(artifacts[1]!, (value) => {
      value.authentication = 'unauthenticated';
    });
    replaceCanonical(artifacts[2]!, (value) => {
      value.invocationId = 'invocation-host-wrapper-other';
    });
    replaceCanonical(artifacts[2]!, (value) => {
      value.requestDigest = '0'.repeat(64);
    });
    replaceCanonical(artifacts[2]!, (value) => {
      value.outputFile = path.join(hostDirectory, 'semantic-output.json');
    });
    replaceCanonical(artifacts[2]!, (value) => {
      const prompt = JSON.parse(String(value.prompt)) as {
        request: { requestDigest: string };
      };
      prompt.request.requestDigest = '0'.repeat(64);
      value.prompt = canonicalJson(prompt);
    });
    for (const mutate of [
      (value: Record<string, unknown>) => {
        value.reference = 'invocation-host-wrapper-other';
      },
      (value: Record<string, unknown>) => {
        value.terms = [
          { kind: 'symbol', value: 'protectedBranches' },
          { kind: 'symbol', value: 'protectedBranches' },
        ];
      },
    ]) {
      const value = JSON.parse(
        originals.get(artifacts[3]!)!.toString('utf8'),
      ) as Record<string, unknown>;
      mutate(value);
      rewritePrivateJson(artifacts[3]!, value);
      assert.equal(
        readProviderInvocationLifecycleProjection(runtime, invocationId).state,
        'leased',
        'leased provider output remains bounded raw failure evidence until terminal acceptance',
      );
      restore(artifacts[3]!);
    }

    const movedTurn = path.join(hostDirectory, 'turn-failure-window');
    fs.renameSync(turnDirectory, movedTurn);
    fs.writeFileSync(
      path.join(probeDirectory, 'probe-result.json'),
      'provider probe failed\n',
    );
    assert.equal(
      readProviderInvocationLifecycleProjection(runtime, invocationId).state,
      'leased',
      'probe failure bytes remain observable before durable failure terminalization',
    );
    restore(path.join(probeDirectory, 'probe-result.json'));
    fs.renameSync(movedTurn, turnDirectory);

    replaceCanonical(artifacts[1]!, (value) => {
      value.providerVersion = '界'.repeat(100);
    });
    replaceCanonical(artifacts[3]!, (value) => {
      value.reference = 'x'.repeat(1_048_576);
    });

    assert.equal(
      readProviderInvocationLifecycleProjection(runtime, invocationId).state,
      'leased',
    );

    const protocolReceipt = report.wrapperProtocolReceipt;
    if (protocolReceipt?.kind !== 'provider-wrapper-session-protocol-receipt') {
      assert.fail('host-wrapper report omitted its session protocol receipt');
    }
    assert.throws(
      () =>
        completeProviderInvocationFromRunner(runtime, invocationId, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          report,
          acceptanceBinding,
          runtimeProgress: {
            schemaVersion: 1,
            kind: 'agent-runtime-process-progress',
            processState: 'exited',
            eventCount: 1,
            stdoutBytes: protocolReceipt.aggregateBytes,
            stderrBytes: 0,
            lastProcessActivityElapsedMs: report.elapsedMs,
            lastProviderActivityElapsedMs: report.elapsedMs,
          },
          now: '2026-08-31T00:00:02.000Z',
          simulateCrashAfterProviderStateWriteBeforeContinuationAuthority: true,
        }),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'PROVIDER_CONTINUATION_AUTHORITY_SIMULATED_CRASH',
    );
    const statePath = path.join(invocationDirectory, 'state.json');
    const publishedNativeClaim =
      nativeClaim as unknown as ProviderNativeSessionClaimV1;
    const publishedNativeCompletion =
      nativeCompletion as unknown as ProviderNativeSessionCompletionV1;
    assert.ok(publishedNativeClaim);
    assert.ok(publishedNativeCompletion);
    const nativePaths = providerNativeSessionStorePathsV1(runtime);
    const continuationAuthorityPath =
      providerNativeSessionContinuationAuthorityObjectPathV1(
        nativePaths,
        publishedNativeCompletion.completionDigest,
      );
    assert.equal(fs.existsSync(continuationAuthorityPath), false);
    assert.equal(
      readProviderNativeSessionChainV1(
        runtime,
        assignment.record.changeId,
        assignment.record.planningGeneration,
        assignment.record.recordDigest,
        assignment.slot.sessionSlotId,
        (candidate) => candidate,
        (candidate) => candidate,
        (candidate) => candidate,
        (candidate) => candidate,
        (candidate) => candidate,
        (candidate) => candidate,
        (candidate) => candidate,
      ).state,
      'continuation-pending',
    );
    const refusedResume = {
      changeId: assignment.record.changeId,
      planningGeneration: assignment.record.planningGeneration,
      assignmentRecordDigest: assignment.record.recordDigest,
      sessionSlotId: assignment.slot.sessionSlotId,
      predecessorCompletionDigest: publishedNativeCompletion.completionDigest,
      invocationId: 'invocation-host-wrapper-lifecycle-refused-resume',
      requestDigest: 'c'.repeat(64),
      attemptId: 'attempt-host-wrapper-lifecycle-refused-resume',
    };
    const stateBeforeRefusedResume = fs.readFileSync(statePath);
    assert.throws(
      () =>
        claimProviderNativeSessionTurnV1(
          runtime,
          refusedResume,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
          (candidate) => candidate,
        ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'PROVIDER_NATIVE_SESSION_CONTINUATION_NOT_AUTHORIZED',
    );
    assert.deepEqual(fs.readFileSync(statePath), stateBeforeRefusedResume);
    assert.throws(
      () => readProviderInvocation(runtime, invocationId),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'PROVIDER_INVOCATION_STORE_UNSAFE',
    );
    assert.throws(
      () => readProviderInvocationLifecycleProjection(runtime, invocationId),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'HUMAN_RESOLUTION_PROVIDER_STATE_UNSAFE',
    );
    const recovered = recoverProviderInvocationCompletion(
      runtime,
      invocationId,
      { expectedRevision: claim.record.revision },
    );
    assert.equal(recovered.repaired, true);
    assert.equal(recovered.record.state, 'succeeded');
    const firstContinuationBytes = fs.readFileSync(
      continuationAuthorityPath,
      'utf8',
    );
    const publishInput = {
      changeId: assignment.record.changeId,
      planningGeneration: assignment.record.planningGeneration,
      assignmentRecordDigest: assignment.record.recordDigest,
      sessionSlotId: assignment.slot.sessionSlotId,
      completionDigest: publishedNativeCompletion.completionDigest,
    };
    const firstReplay = publishProviderNativeSessionContinuationAuthorityV1(
      runtime,
      publishInput,
    );
    const secondReplay = publishProviderNativeSessionContinuationAuthorityV1(
      runtime,
      publishInput,
    );
    assert.deepEqual(secondReplay, firstReplay);
    assert.equal(
      fs.readFileSync(continuationAuthorityPath, 'utf8'),
      firstContinuationBytes,
    );
    const terminalState = JSON.parse(
      fs.readFileSync(statePath, 'utf8'),
    ) as Record<string, unknown>;
    const currentExecution = readExecutionJobState(
      runtime,
      acceptanceBinding.executionJobId,
    );
    assert.ok(currentExecution);
    assert.notEqual(
      sha256(canonicalJson(currentExecution)),
      acceptanceBinding.executionStateDigest,
      'terminal acceptance mutates the live Job after immutable admission',
    );
    const admissionAuthorityPath = providerExecutionAdmissionAuthorityPath(
      runtime,
      acceptanceBinding,
    );
    const admissionAuthorityBytes = fs.readFileSync(
      admissionAuthorityPath,
      'utf8',
    );
    assert.equal(
      readProviderInvocationLifecycleProjection(runtime, invocationId).state,
      'succeeded',
      'terminal host-wrapper output is bound to its exact profile, executable, session action, and receipt',
    );
    const terminalStateBytes = fs.readFileSync(statePath, 'utf8');
    const assertPrimaryUnsafe = () =>
      assert.throws(
        () => readProviderInvocation(runtime, invocationId),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code === 'PROVIDER_INVOCATION_STORE_UNSAFE',
      );
    const assertPrimaryRejected = () =>
      assert.throws(
        () => readProviderInvocation(runtime, invocationId),
        (error: unknown) => error instanceof WorkflowError,
      );
    const assertAuthorityUnsafe = () => {
      assertUnsafe();
      assertPrimaryUnsafe();
      assert.equal(fs.readFileSync(statePath, 'utf8'), terminalStateBytes);
    };
    const missingAdmissionAuthorityPath = `${admissionAuthorityPath}.missing`;
    fs.renameSync(admissionAuthorityPath, missingAdmissionAuthorityPath);
    assertAuthorityUnsafe();
    fs.renameSync(missingAdmissionAuthorityPath, admissionAuthorityPath);

    fs.writeFileSync(
      admissionAuthorityPath,
      admissionAuthorityBytes.trimEnd(),
      { mode: 0o600 },
    );
    assertAuthorityUnsafe();
    fs.writeFileSync(admissionAuthorityPath, admissionAuthorityBytes, {
      mode: 0o600,
    });

    assert.equal(publishedNativeCompletion.usable, true);
    assert.ok(publishedNativeCompletion.handleDigest);
    const assignmentPaths = changeRoleAssignmentStorePathsV1(runtime);
    const durableAuthorityFiles = [
      changeRoleAssignmentRefPathV1(
        assignmentPaths,
        assignment.record.changeId,
        assignment.record.planningGeneration,
      ),
      changeRoleAssignmentObjectPathV1(
        assignmentPaths,
        assignment.record.recordDigest,
      ),
      providerNativeSessionClaimRefPathV1(
        nativePaths,
        publishedNativeClaim.scope.scopeKey,
        publishedNativeClaim.turn,
      ),
      providerNativeSessionClaimObjectPathV1(
        nativePaths,
        publishedNativeClaim.claimDigest,
      ),
      providerNativeSessionCompletionRefPathV1(
        nativePaths,
        publishedNativeClaim.scope.scopeKey,
        publishedNativeClaim.turn,
      ),
      providerNativeSessionCompletionObjectPathV1(
        nativePaths,
        publishedNativeCompletion.completionDigest,
      ),
      providerNativeSessionHandleObjectPathV1(
        nativePaths,
        publishedNativeCompletion.handleDigest!,
      ),
    ];
    for (const [index, authorityPath] of durableAuthorityFiles.entries()) {
      const moved = path.join(
        hostDirectory,
        `durable-authority-${index}.missing`,
      );
      fs.renameSync(authorityPath, moved);
      assertAuthorityUnsafe();
      fs.renameSync(moved, authorityPath);
    }

    const assignmentObjectPath = durableAuthorityFiles[1]!;
    const assignmentObjectBytes = fs.readFileSync(assignmentObjectPath, 'utf8');
    const tamperedAssignmentObject = JSON.parse(
      assignmentObjectBytes,
    ) as Record<string, unknown>;
    (tamperedAssignmentObject.host as Record<string, unknown>).sourceDigest =
      '0'.repeat(64);
    rewritePrivateJson(assignmentObjectPath, tamperedAssignmentObject);
    assertAuthorityUnsafe();
    fs.writeFileSync(assignmentObjectPath, assignmentObjectBytes, {
      mode: 0o600,
    });

    const handlePath = durableAuthorityFiles[6]!;
    const handleBytes = fs.readFileSync(handlePath, 'utf8');
    const tamperedHandle = JSON.parse(handleBytes) as Record<string, unknown>;
    tamperedHandle.nativeSessionId = 'native-host-wrapper-forged';
    rewritePrivateJson(handlePath, tamperedHandle);
    assertAuthorityUnsafe();
    fs.writeFileSync(handlePath, handleBytes, { mode: 0o600 });

    const assignmentRefPath = durableAuthorityFiles[0]!;
    const assignmentRefBytes = fs.readFileSync(assignmentRefPath, 'utf8');
    const forgedAssignmentRef = JSON.parse(assignmentRefBytes) as Record<
      string,
      unknown
    >;
    forgedAssignmentRef.recordDigest = 'f'.repeat(64);
    rewritePrivateJson(assignmentRefPath, forgedAssignmentRef);
    assertAuthorityUnsafe();
    fs.writeFileSync(assignmentRefPath, assignmentRefBytes, { mode: 0o600 });

    const completionRefPath = durableAuthorityFiles[4]!;
    const completionRefBytes = fs.readFileSync(completionRefPath, 'utf8');
    const forgedCompletionRef = JSON.parse(completionRefBytes) as Record<
      string,
      unknown
    >;
    forgedCompletionRef.completionDigest = 'e'.repeat(64);
    rewritePrivateJson(completionRefPath, forgedCompletionRef);
    assertAuthorityUnsafe();
    fs.writeFileSync(completionRefPath, completionRefBytes, { mode: 0o600 });

    {
      const movedProbeResult = path.join(
        hostDirectory,
        'terminal-probe-result.missing',
      );
      fs.renameSync(artifacts[1]!, movedProbeResult);
      assertUnsafe();
      fs.renameSync(movedProbeResult, artifacts[1]!);
    }

    replaceCanonical(artifacts[0]!, (value) => {
      value.profileDigest = '0'.repeat(64);
    });

    for (const directory of [probeDirectory, turnDirectory]) {
      const moved = path.join(
        hostDirectory,
        `${path.basename(directory)}.terminal-missing`,
      );
      fs.renameSync(directory, moved);
      assertUnsafe();
      fs.renameSync(moved, directory);
    }

    const replaceTerminalState = (
      mutate: (value: Record<string, unknown>) => void,
      requirePrimaryRejection = false,
    ) => {
      const value = structuredClone(terminalState) as unknown as Record<
        string,
        unknown
      >;
      mutate(value);
      rewritePrivateJson(statePath, value);
      const mutatedStateBytes = fs.readFileSync(statePath, 'utf8');
      assertUnsafe();
      if (requirePrimaryRejection) assertPrimaryRejected();
      assert.equal(
        fs.readFileSync(statePath, 'utf8'),
        mutatedStateBytes,
        'reader rejection must not rewrite poisoned provider state',
      );
      rewritePrivateJson(statePath, terminalState);
    };
    replaceTerminalState((value) => {
      delete value.runtimeReceipt;
    }, true);
    replaceTerminalState((value) => {
      const runtimeReceipt = value.runtimeReceipt as Record<string, unknown>;
      const legacyProtocolBody = {
        schemaVersion: 1,
        kind: 'provider-wrapper-protocol-receipt',
        protocol: 'harness-jsonl-v1',
        invocationId,
        requestDigest: request.requestDigest,
        attemptId: acceptanceBinding.executionAttemptId,
        frameCount: 1,
        aggregateBytes: 1,
        lastSequence: 1,
        progressFrameCount: 0,
        terminal: 'result',
        outputSlot: 'primary',
        errorCode: null,
        cancellation: {
          requested: false,
          acknowledged: false,
          forced: false,
        },
      };
      runtimeReceipt.schemaVersion = 3;
      delete runtimeReceipt.acceptanceBinding;
      delete runtimeReceipt.failureCode;
      delete runtimeReceipt.hostExecutionBinding;
      delete runtimeReceipt.terminalDisposition;
      runtimeReceipt.protocolReceipt = {
        ...legacyProtocolBody,
        receiptDigest: sha256(canonicalJson(legacyProtocolBody)),
      };
      const receiptBody = { ...runtimeReceipt };
      delete receiptBody.receiptDigest;
      runtimeReceipt.receiptDigest = sha256(canonicalJson(receiptBody));
    }, true);
    {
      const forgedState = structuredClone(terminalState) as unknown as Record<
        string,
        unknown
      >;
      forgedState.state = 'failed';
      forgedState.result = null;
      forgedState.failure = {
        kind: 'retryable',
        code: 'FORGED_PRE_NATIVE_PROTOCOL',
        message: 'Forged pre-native protocol receipt.',
      };
      const forgedProtocolBody = {
        schemaVersion: 1,
        kind: 'provider-wrapper-protocol-receipt',
        protocol: 'harness-jsonl-v1',
        invocationId,
        requestDigest: request.requestDigest,
        attemptId: acceptanceBinding.executionAttemptId,
        frameCount: 1,
        aggregateBytes: 1,
        lastSequence: 1,
        progressFrameCount: 0,
        terminal: 'error',
        outputSlot: null,
        errorCode: 'FORGED_PROTOCOL',
        cancellation: {
          requested: false,
          acknowledged: false,
          forced: false,
        },
      };
      const assignmentAdmittedBody = {
        schemaVersion: 1,
        kind: 'agent-runtime-host-execution-binding.v1',
        phase: 'assignment-admitted',
        assignmentBinding: assignment.binding,
        assignmentBindingDigest: assignment.binding.bindingDigest,
        probe: null,
        nativeSessionClaim: null,
        nativeSessionCompletionDigest: null,
      };
      const runtimeReceipt = forgedState.runtimeReceipt as Record<
        string,
        unknown
      >;
      runtimeReceipt.terminalState = 'failed';
      runtimeReceipt.terminalDisposition = 'failed-before-result';
      runtimeReceipt.failureCode = 'FORGED_PRE_NATIVE_PROTOCOL';
      runtimeReceipt.protocolReceipt = {
        ...forgedProtocolBody,
        receiptDigest: sha256(canonicalJson(forgedProtocolBody)),
      };
      runtimeReceipt.hostExecutionBinding = {
        ...assignmentAdmittedBody,
        bindingDigest: sha256(
          `workflow.agent-runtime-host-execution-binding.v1\n${canonicalJson(
            assignmentAdmittedBody,
          )}`,
        ),
      };
      const receiptDigestBody = { ...runtimeReceipt };
      delete receiptDigestBody.receiptDigest;
      runtimeReceipt.receiptDigest = sha256(canonicalJson(receiptDigestBody));
      rewritePrivateJson(statePath, forgedState);
      const forgedStateBytes = fs.readFileSync(statePath, 'utf8');
      assertUnsafe();
      assertPrimaryUnsafe();
      assert.equal(fs.readFileSync(statePath, 'utf8'), forgedStateBytes);
      rewritePrivateJson(statePath, terminalState);
    }
    replaceTerminalState((value) => {
      value.state = 'failed';
      value.result = null;
      value.failure = {
        kind: 'retryable',
        code: 'FORGED_REJECTED_AFTER_RESULT',
        message: 'Forged post-result rejection with a continuation marker.',
      };
      const runtimeReceipt = value.runtimeReceipt as Record<string, unknown>;
      runtimeReceipt.terminalState = 'failed';
      runtimeReceipt.terminalDisposition = 'rejected-after-result';
      runtimeReceipt.failureCode = 'FORGED_REJECTED_AFTER_RESULT';
      const receiptBody = { ...runtimeReceipt };
      delete receiptBody.receiptDigest;
      runtimeReceipt.receiptDigest = sha256(canonicalJson(receiptBody));
    }, true);
    replaceTerminalState((value) => {
      const observation = (
        value.result as {
          runtimeObservation: { residuals: string[] };
        }
      ).runtimeObservation;
      observation.residuals = [];
    });
    replaceTerminalState((value) => {
      const observation = (
        value.result as {
          runtimeObservation: {
            executable: { sha256: string };
          };
        }
      ).runtimeObservation;
      observation.executable.sha256 = '0'.repeat(64);
    });
    replaceTerminalState((value) => {
      const observation = (
        value.result as {
          runtimeObservation: {
            providerDefinitionSnapshot: { profileDigest: string };
            providerDefinitionBindingDigest: string;
            executable: unknown;
          };
        }
      ).runtimeObservation;
      observation.providerDefinitionSnapshot.profileDigest = '0'.repeat(64);
      observation.providerDefinitionBindingDigest = sha256(
        canonicalJson({
          providerDefinitionDigest: '0'.repeat(64),
          executable: observation.executable,
        }),
      );
    }, true);
    replaceTerminalState((value) => {
      const observation = (
        value.result as {
          runtimeObservation: {
            providerDefinitionSnapshot: { profileDigest: string };
            providerDefinitionBindingDigest: string;
            executable: { sha256: string };
          };
        }
      ).runtimeObservation;
      observation.executable.sha256 = '0'.repeat(64);
      observation.providerDefinitionBindingDigest = sha256(
        canonicalJson({
          providerDefinitionDigest:
            observation.providerDefinitionSnapshot.profileDigest,
          executable: observation.executable,
        }),
      );
    }, true);

    const turnRequest = JSON.parse(
      originals.get(artifacts[2]!)!.toString('utf8'),
    ) as Record<string, unknown>;
    turnRequest.action = 'resume';
    rewritePrivateJson(artifacts[2]!, turnRequest);
    assertUnsafe();
    restore(artifacts[2]!);

    const resumedInvocationId = 'invocation-host-wrapper-lifecycle-resume';
    const resumedInvestigationId =
      'investigation-host-wrapper-lifecycle-resume';
    const resumedRequest = createProviderInvocationRequest({
      invocationId: resumedInvocationId,
      nonce: 'host-wrapper-lifecycle-resume-nonce-000001',
      purpose: request.purpose,
      providerId: request.providerId,
      roleAssignment: {
        ...request.roleAssignment,
        sessionId: 'provider-session-host-wrapper-lifecycle-resume',
      },
      capabilityProfile: request.capabilityProfile,
      repositoryId: request.repositoryId,
      baseCommit: request.baseCommit,
      baseTree: request.baseTree,
      targetDigest: request.targetDigest,
      inputManifestDigest: request.inputManifestDigest,
      authorizationNodeId: request.authorizationNodeId,
      writeAllowedPaths: [],
      outputSchema: request.outputSchema,
      evaluatorVersion: request.evaluatorVersion,
      policyDigest: request.policyDigest,
      limits: request.limits,
    });
    storeProviderExecutionPolicySnapshot(
      runtime,
      resumedRequest,
      parseAiAdapterPolicyDocument(policyContent),
    );
    createProviderInvocation(runtime, {
      investigationId: resumedInvestigationId,
      changeId,
      attempt: 1,
      manifest,
      request: resumedRequest,
      createdAt: '2026-08-31T00:01:00.000Z',
    });
    const resumedLease = claimProviderInvocation(runtime, resumedInvocationId, {
      workerId: 'provider-worker-host-wrapper-lifecycle-resume',
      leaseDurationMs: resumedRequest.limits.timeoutMs,
      now: '2026-08-31T00:01:01.000Z',
    });
    const resumedAcceptance = prepareProviderInvocationAcceptanceBinding(
      runtime,
      resumedInvocationId,
      'schema-v4',
    );
    let resumedNativeCompletion: ProviderNativeSessionCompletionV1 | null =
      null;
    const resumedInput = hostWrapperInput(
      {
        providerId: resumedRequest.providerId,
        repositoryRoot: repository,
        invocationDirectory: path.join(
          runtime.invocations,
          resumedInvocationId,
        ),
        request: resumedRequest,
        semanticOutputSchema: BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
        outputValidator: blindSurveyOutputValidator(resumedRequest),
        governedRuntimeInputs: [],
        acceptanceBinding: resumedAcceptance,
        sourceEnvironment: {},
      },
      profile,
      {
        profile,
        nextAction: () => 'resume',
        claim({ attemptId, expectedAction }) {
          assert.equal(expectedAction, 'resume');
          const resumed = claimProviderNativeSessionTurnV1(
            runtime,
            {
              changeId: assignment.record.changeId,
              planningGeneration: assignment.record.planningGeneration,
              assignmentRecordDigest: assignment.record.recordDigest,
              sessionSlotId: assignment.slot.sessionSlotId,
              predecessorCompletionDigest:
                publishedNativeCompletion.completionDigest,
              invocationId: resumedInvocationId,
              requestDigest: resumedRequest.requestDigest,
              attemptId,
            },
            (candidate) => candidate,
            (candidate) => candidate,
            (candidate) => candidate,
            (candidate) => candidate,
            (candidate) => candidate,
            (candidate) => candidate,
            (candidate) => candidate,
          );
          assert.equal(resumed.outcome, 'claimed');
          assert.equal(resumed.claim.action, 'resume');
          assert.ok(resumed.binding);
          return {
            claim: resumed.claim,
            claimDigest: resumed.claim.claimDigest,
            predecessorCompletionDigest:
              publishedNativeCompletion.completionDigest,
            binding: resumed.binding,
          };
        },
        complete(value) {
          const current = readProviderNativeSessionChainV1(
            runtime,
            assignment.record.changeId,
            assignment.record.planningGeneration,
            assignment.record.recordDigest,
            assignment.slot.sessionSlotId,
            (candidate) => candidate,
            (candidate) => candidate,
            (candidate) => candidate,
            (candidate) => candidate,
            (candidate) => candidate,
            (candidate) => candidate,
            (candidate) => candidate,
          ).turns.at(-1)?.claim;
          assert.ok(current);
          resumedNativeCompletion = completeClaimedProviderNativeSessionTurnV1(
            runtime,
            {
              changeId: assignment.record.changeId,
              planningGeneration: assignment.record.planningGeneration,
              assignmentRecordDigest: assignment.record.recordDigest,
              sessionSlotId: assignment.slot.sessionSlotId,
              claimDigest: current.claimDigest,
              terminal: value.terminal,
            },
          );
          return {
            completionDigest: resumedNativeCompletion.completionDigest,
          };
        },
      },
      assignment.binding,
    );
    const resumedReport = await productionAgentRuntime.runSingleShotAsync!(
      resumedInput,
      { platform: process.platform },
    );
    assert.deepEqual(
      resumedReport.semanticOutput,
      semanticOutput(resumedRequest),
    );
    assert.equal(
      resumedReport.wrapperProtocolReceipt?.kind ===
        'provider-wrapper-session-protocol-receipt'
        ? resumedReport.wrapperProtocolReceipt.sessionAction
        : null,
      'resume',
    );
    const publishedResumeCompletion =
      resumedNativeCompletion as unknown as ProviderNativeSessionCompletionV1;
    assert.ok(publishedResumeCompletion);
    assert.equal(publishedResumeCompletion.usable, true);
    assert.equal(
      readProviderNativeSessionChainV1(
        runtime,
        assignment.record.changeId,
        assignment.record.planningGeneration,
        assignment.record.recordDigest,
        assignment.slot.sessionSlotId,
        (candidate) => candidate,
        (candidate) => candidate,
        (candidate) => candidate,
        (candidate) => candidate,
        (candidate) => candidate,
        (candidate) => candidate,
        (candidate) => candidate,
      ).state,
      'continuation-pending',
    );
    assert.equal(resumedLease.record.state, 'leased');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  }
});

test('host-wrapper resume unsupported by its definition fails before claim or launch', async () => {
  const fixture = createRunnerFixture();
  const wrapper = path.join(
    sourceRepositoryRoot,
    'packages/agent-runtime/test/fixtures/provider-wrapper-fixture.mjs',
  );
  const profile = hostWrapperProfile(wrapper, false);
  let claims = 0;
  const controller: Omit<
    AgentRuntimeNativeSessionTurnControllerV1,
    'assignmentBinding' | 'invocationBinding'
  > = {
    profile,
    nextAction: () => 'resume',
    claim() {
      claims += 1;
      throw new Error('claim must remain unreachable');
    },
    complete() {
      throw new Error('completion must remain unreachable');
    },
  };
  try {
    await assert.rejects(
      runHostWrapperProviderThroughAgentRuntimeV1(
        hostWrapperInput(
          bindRunnerInputToInvestigationOwner(
            fixture.input,
            'investigation-host-wrapper-unsupported-resume',
          ),
          profile,
          controller,
        ),
        { platform: process.platform },
      ),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === 'AGENT_RUNTIME_V1_RESUME_UNSUPPORTED',
    );
    assert.equal(claims, 0);
    assert.equal(
      fs.existsSync(
        path.join(fixture.input.invocationDirectory, 'host-wrapper-runtime'),
      ),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

for (const fixtureMode of ['error', 'cancel-ack', 'cancel-ignore'] as const) {
  test(`async runner exposes the validated ${fixtureMode} wrapper receipt on its failure channel`, async () => {
    const fixture = createRunnerFixture();
    const input = {
      ...bindRunnerInputToInvestigationOwner(
        fixture.input,
        `investigation-provider-wrapper-${fixtureMode}`,
      ),
      wrapperProtocol: { protocol: 'harness-jsonl-v1' as const },
    };
    const controller = new AbortController();
    const observed: ProviderWrapperProtocolReceipt[] = [];
    try {
      const host = claudeRunnerHost(() => {
        assert.fail('wrapper protocol execution must remain asynchronous');
      });
      host.executeAsync = async (executeInput, control) =>
        await spawnBoundedProviderProcess({
          executable: process.execPath,
          args: [providerWrapperFixture, fixtureMode],
          cwd: executeInput.cwd,
          environment: executeInput.environment,
          timeoutMs: executeInput.timeoutMs,
          maxOutputBytes: executeInput.maxOutputBytes,
          ...(fixtureMode === 'error' ? {} : { signal: controller.signal }),
          wrapperProtocol: {
            ...control.wrapperProtocol!,
            ...(fixtureMode === 'error'
              ? {}
              : {
                  onFrame(receipt) {
                    if (receipt.frame.type === 'hello') controller.abort();
                  },
                }),
          },
        });

      await assert.rejects(
        createProviderRunnerForTesting(host).runAsync(input, {
          platform: 'darwin',
          ...(fixtureMode === 'error' ? {} : { signal: controller.signal }),
          onProtocolReceipt(receipt) {
            if (receipt.kind !== 'provider-wrapper-protocol-receipt') {
              assert.fail(
                'harness-jsonl-v1 emitted a session protocol receipt',
              );
            }
            observed.push(receipt);
            if (fixtureMode === 'error') {
              throw new Error('receipt observer must be non-authoritative');
            }
          },
        }),
        (error: unknown) =>
          error instanceof WorkflowError &&
          error.code ===
            (fixtureMode === 'error'
              ? 'PROVIDER_WRAPPER_REPORTED_ERROR'
              : 'PROVIDER_PROCESS_CANCELLED'),
      );

      assert.equal(observed.length, 1);
      assert.equal(
        observed[0]!.terminal,
        fixtureMode === 'error' ? 'error' : 'cancelled',
      );
      assert.deepEqual(observed[0]!.cancellation, {
        requested: fixtureMode !== 'error',
        acknowledged: fixtureMode === 'cancel-ack',
        forced: fixtureMode === 'cancel-ignore',
      });
      assert.equal(
        observed[0]!.attemptId,
        input.acceptanceBinding!.executionAttemptId,
      );
    } finally {
      fixture.cleanup();
    }
  });
}

test('async runner releases its concurrency slot after execution rejects', async () => {
  const fixture = createRunnerFixture();
  const expected = new Error('async execution failed');
  try {
    const host = claudeRunnerHost(() => {
      assert.fail('the async runner must not use synchronous execution');
    });
    host.executeAsync = async () => {
      throw expected;
    };

    await assert.rejects(
      createProviderRunnerForTesting(host).runAsync(fixture.input, {
        platform: 'darwin',
      }),
      expected,
    );
    assert.deepEqual(
      fs.readdirSync(
        path.join(
          fixture.repository,
          '.git',
          'workflow-engine',
          'investigations',
          'provider-slots',
        ),
      ),
      [],
    );
  } finally {
    fixture.cleanup();
  }
});

test('production prompt assembly reads only the exact current manifest and excludes unrelated durable evidence', () => {
  const fixture = createRunnerFixture();
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const binding = ensureProviderPromptContext(
      providerPromptContextStoreRoot(fixture.input.invocationDirectory),
      fixture.request,
      manifest,
      'investigation-provider-runner-test',
    );
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const catalog = inspectDurableRetentionCatalog(
      storeRoot,
      binding.workflowId,
    );
    const oldEvidence = 'OLD_EPOCH_EVIDENCE_MUST_NOT_ENTER_PROMPT';
    storeDurableEvidence(storeRoot, {
      workflowId: binding.workflowId,
      expectedCatalogGeneration: catalog.generation,
      record: {
        schemaVersion: 1,
        kind: 'evidence-retention',
        evidenceId: 'unreferenced-old-provider-evidence',
        itemIdentity: null,
        workflowId: binding.workflowId,
        epoch: binding.epoch,
        evidenceClass: 'raw',
        digest: `sha256:${sha256(oldEvidence)}`,
        retention: 'active',
        createdAt: '2026-08-03T14:00:00.000Z',
        expiresAt: null,
        pin: null,
      },
      content: oldEvidence,
    });

    let managedPrompt = '';
    const host = claudeRunnerHost((input) => {
      managedPrompt = input.stdinContent.toString('utf8');
      return successfulProbe(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          structured_output: semanticOutput(fixture.request),
        }),
      );
    });
    createProviderRunnerForTesting(host).run(fixture.input, {
      platform: 'darwin',
    });
    assert.equal(managedPrompt.includes(oldEvidence), false);
    const parsed = JSON.parse(managedPrompt) as { manifest: unknown };
    assert.deepEqual(parsed.manifest, manifest);
  } finally {
    fixture.cleanup();
  }
});

test('provider prompt context identity is isolated by the durable investigation owner', () => {
  const fixture = createRunnerFixture();
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const first = ensureProviderPromptContext(
      storeRoot,
      fixture.request,
      manifest,
      'investigation-context-owner-a',
    );
    const second = ensureProviderPromptContext(
      storeRoot,
      fixture.request,
      manifest,
      'investigation-context-owner-b',
    );

    assert.notEqual(first.workflowId, second.workflowId);
    assert.equal(first.ownerWorkflowId, 'investigation-context-owner-a');
    assert.equal(second.ownerWorkflowId, 'investigation-context-owner-b');
  } finally {
    fixture.cleanup();
  }
});

test('production prompt assembly rejects a stale request after durable context rollover', () => {
  const fixture = createRunnerFixture();
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const binding = ensureProviderPromptContext(
      storeRoot,
      fixture.request,
      manifest,
      'investigation-provider-runner-test',
    );
    const nextContent = canonicalJson({
      kind: 'new-current-provider-context',
      sentinel: 'CURRENT_ONLY',
    });
    const next = buildContextManifest({
      workflowId: binding.workflowId,
      epoch: 2,
      contractVersion: binding.manifest.contractVersion,
      baselineDigest: binding.manifest.baselineDigest,
      intentDigest: binding.manifest.intentDigest,
      termSetDigest: binding.manifest.termSetDigest,
      planningSnapshotDigest: binding.manifest.planningSnapshotDigest,
      items: [{ identity: 'provider-input-manifest', content: nextContent }],
    });
    const current = inspectDurableEpochContextStore(
      storeRoot,
      binding.workflowId,
    );
    rolloverDurableEpochContextStore(storeRoot, {
      workflowId: binding.workflowId,
      expectedGeneration: 1,
      expectedEpoch: 1,
      expectedContextDigest: binding.contextDigest,
      nextManifest: next,
      items: [{ identity: 'provider-input-manifest', content: nextContent }],
      reason: 'Test a semantically changed provider context.',
      restartFrom: 'survey',
      carriedForward: [],
      carryForwardManifest: {
        sourceWorkflow: binding.workflowId,
        sourceEpoch: 1,
        carriedForward: [],
        excluded: [
          {
            identity: 'provider-input-manifest',
            reason: 'The provider context changed for this stale-request test.',
          },
        ],
      },
      invalidated: ['provider-input-manifest'],
      verification: null,
      createdAt: new Date(Date.parse(current.updatedAt) + 1),
    });
    assert.throws(
      () =>
        assembleProviderPromptManifest(
          storeRoot,
          fixture.request,
          manifest,
          'investigation-provider-runner-test',
        ),
      (error) => isWorkflowError(error, 'PROVIDER_CONTEXT_STALE_OR_WRONG'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('lifecycle invocation selection rolls semantic provider context once and stale workers cannot roll it back', () => {
  const fixture = createRunnerFixture();
  const firstManifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const owner = 'investigation-provider-runner-test';
    const first = prepareProviderPromptContextForInvocation(
      storeRoot,
      fixture.request,
      firstManifest,
      owner,
      new Date('2026-08-03T15:00:00.000Z'),
    );
    const secondManifest = {
      kind: 'test-manifest',
      invocationId: 'invocation-adapter-test-next-semantic-input',
    };
    const secondRequest = providerRequest(
      fixture.request.policyDigest,
      fixture.repository,
      fixture.request.providerId,
      fixture.request.limits.aggregateOutputBytes,
      secondManifest.invocationId,
      sha256(canonicalJson(secondManifest)),
      fixture.request.purpose,
      fixture.request.limits.timeoutMs,
    );
    const second = prepareProviderPromptContextForInvocation(
      storeRoot,
      secondRequest,
      secondManifest,
      owner,
      new Date('2026-08-03T15:05:00.000Z'),
    );

    assert.equal(second.workflowId, first.workflowId);
    assert.equal(second.epoch, first.epoch + 1);
    assert.equal(second.generation, first.generation + 1);
    assert.equal(
      ensureProviderPromptContext(
        storeRoot,
        secondRequest,
        secondManifest,
        owner,
      ).contextDigest,
      second.contextDigest,
    );
    assert.throws(
      () =>
        ensureProviderPromptContext(
          storeRoot,
          fixture.request,
          firstManifest,
          owner,
        ),
      (error) => isWorkflowError(error, 'PROVIDER_CONTEXT_STALE_OR_WRONG'),
    );
    assert.equal(
      ensureProviderPromptContext(
        storeRoot,
        secondRequest,
        secondManifest,
        owner,
      ).contextDigest,
      second.contextDigest,
    );
  } finally {
    fixture.cleanup();
  }
});

test('managed prompt exposes the scope and v3 structured coverage contracts only to plan review', () => {
  const scopeAssessmentInstruction =
    'The output "scopeAssessment" is scope-only: set kind "challenges" if and only if at least one "findings" entry has category "missing-scope" or "missing-consumers"; otherwise set kind "no-challenge" with at least one evidence item, even when "findings" contains challenges in other categories.';
  const structuredCoverageInstruction =
    'In the immutable investigation.json v3 Manifest, find the unique applicability.semanticDelta.investigationRequirements[] entry whose kind is "plan-review-coverage-requirement". Read structured PlanReview coverage only from that entry\'s coverage.requiredTargetIds and coverage.targetBindings. Treat every requiredTargetIds entry as mandatory. For each required target, cite the matching targetBindings row\'s exact evidenceKind and path at least once in scopeAssessment, a finding, or a suggestion. Extra evidence is allowed; omitting a required row is rejected at plan commit.';
  for (const purpose of ['survey', 'plan-review'] as const) {
    const fixture = createRunnerFixture('claude', 1_048_576, 2, purpose);
    let executeCount = 0;
    try {
      const host = claudeRunnerHost((input) => {
        executeCount += 1;
        assert.ok(Buffer.isBuffer(input.stdinContent));
        const prompt = JSON.parse(input.stdinContent.toString('utf8')) as {
          instructions: string[];
        };
        assert.equal(
          prompt.instructions.includes(scopeAssessmentInstruction),
          purpose === 'plan-review',
        );
        assert.equal(
          prompt.instructions.includes(structuredCoverageInstruction),
          purpose === 'plan-review',
        );
        if (purpose === 'plan-review') {
          const renderedInstructions = prompt.instructions.join('\n');
          assert.doesNotMatch(renderedInstructions, /evidence node/i);
          assert.doesNotMatch(renderedInstructions, /\boutput\./);
        }
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(fixture.request),
          }),
        );
      });
      createProviderRunnerForTesting(host).run(fixture.input, {
        platform: 'darwin',
      });
      assert.equal(executeCount, 1);
    } finally {
      fixture.cleanup();
    }
  }
});

test('runner rejects persistent files outside the exact runtime closure', () => {
  const fixture = createRunnerFixture();
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost((input) => {
            fs.writeFileSync(
              path.join(path.dirname(input.stdinSource), 'undeclared.tmp'),
              'unexpected\n',
            );
            fs.chmodSync(
              path.join(path.dirname(input.stdinSource), 'undeclared.tmp'),
              0o000,
            );
            return successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: semanticOutput(fixture.request),
              }),
            );
          }),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_GOVERNED_PROJECTION_DRIFT'));
        assert.ok(
          (
            (error as WorkflowError).details?.changedCategories as string[]
          ).includes('governed-runtime-inputs'),
        );
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner bounds provider-created projection content before hashing it', () => {
  const fixture = createRunnerFixture();
  const oversizedPath = path.join(
    fixture.repository,
    'src/provider-oversized.bin',
  );
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => {
            fs.closeSync(fs.openSync(oversizedPath, 'w'));
            fs.truncateSync(oversizedPath, 128 * 1024 * 1024 + 1);
            return successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: semanticOutput(fixture.request),
              }),
            );
          }),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'GOVERNED_PROJECTION_FAILED'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner requires private Git-common runtime and no-follow engine files', () => {
  const insideWorktree = createRunnerFixture();
  try {
    const worktreeRuntime = path.join(
      insideWorktree.repository,
      'provider-runtime',
    );
    fs.mkdirSync(worktreeRuntime);
    insideWorktree.input.invocationDirectory = worktreeRuntime;
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() =>
            successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: semanticOutput(insideWorktree.request),
              }),
            ),
          ),
        ).run(insideWorktree.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_DIRECTORY_UNSAFE'),
    );
  } finally {
    insideWorktree.cleanup();
  }

  const arbitraryGitRuntime = createRunnerFixture();
  try {
    const arbitraryDirectory = path.join(
      arbitraryGitRuntime.repository,
      '.git',
      'workflow-engine',
      'arbitrary-runtime',
      arbitraryGitRuntime.request.invocationId,
    );
    fs.mkdirSync(arbitraryDirectory, { recursive: true });
    arbitraryGitRuntime.input.invocationDirectory = arbitraryDirectory;
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe('')),
        ).run(arbitraryGitRuntime.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_DIRECTORY_UNSAFE'),
    );
  } finally {
    arbitraryGitRuntime.cleanup();
  }

  const symlinkedPrompt = createRunnerFixture();
  const external = path.join(
    os.tmpdir(),
    `provider-external-${crypto.randomUUID()}`,
  );
  try {
    fs.writeFileSync(external, 'do not overwrite\n');
    const runtimeDirectory = path.join(
      symlinkedPrompt.input.invocationDirectory,
      'runtime',
    );
    fs.mkdirSync(runtimeDirectory);
    fs.symlinkSync(external, path.join(runtimeDirectory, 'prompt.json'));
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe('')),
        ).run(symlinkedPrompt.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_PATH_UNSAFE'),
    );
    assert.equal(fs.readFileSync(external, 'utf8'), 'do not overwrite\n');
  } finally {
    fs.rmSync(external, { force: true });
    symlinkedPrompt.cleanup();
  }
});

test('runner never truncates a preplanted hardlink in its runtime', () => {
  const fixture = createRunnerFixture();
  const trackedPath = path.join(fixture.repository, 'src/.gitkeep');
  try {
    const runtimeDirectory = path.join(
      fixture.input.invocationDirectory,
      'runtime',
    );
    fs.mkdirSync(runtimeDirectory, { mode: 0o700 });
    fs.linkSync(trackedPath, path.join(runtimeDirectory, 'prompt.json'));

    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe('')),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_PATH_UNSAFE'),
    );
    assert.equal(fs.readFileSync(trackedPath, 'utf8'), '');
  } finally {
    fixture.cleanup();
  }
});

test('runner requires a freshly engine-created runtime directory', () => {
  const fixture = createRunnerFixture();
  try {
    fs.mkdirSync(path.join(fixture.input.invocationDirectory, 'runtime'), {
      mode: 0o700,
    });
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe('')),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_PATH_UNSAFE'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner binds enabled policy, provider, baseline, and semantic schema before launch', () => {
  for (const [name, mutate, code] of [
    [
      'disabled provider',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const policyContent = writeAdapterPolicy(fixture.repository, false);
        git(fixture.repository, ['add', 'workflow/ai-adapter-policy.json']);
        git(fixture.repository, ['commit', '-m', 'Disable Claude adapter']);
        const request = providerRequest(
          sha256(policyContent),
          fixture.repository,
          'claude',
          1_048_576,
          fixture.input.request.invocationId,
          fixture.input.request.inputManifestDigest,
        );
        fixture.input.request = request;
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'request.json'),
          request,
        );
        writeProviderExecutionPolicySnapshot(
          fixture.input.invocationDirectory,
          request,
          policyContent,
        );
      },
      'PROVIDER_DISABLED',
    ],
    [
      'stale policy digest',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const request = providerRequest(
          '9'.repeat(64),
          fixture.repository,
          'claude',
          1_048_576,
          fixture.input.request.invocationId,
          fixture.input.request.inputManifestDigest,
        );
        fixture.input.request = request;
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'request.json'),
          request,
        );
      },
      'PROVIDER_EXECUTION_POLICY_SNAPSHOT_MISMATCH',
    ],
    [
      'provider mismatch',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        fixture.input.providerId = 'codex';
      },
      'PROVIDER_REQUEST_UNBOUND',
    ],
    [
      'repository identity mismatch',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const request = createProviderInvocationRequest({
          ...providerRequestInput(
            fixture.input.request.policyDigest,
            fixture.repository,
            'claude',
            1_048_576,
            fixture.input.request.invocationId,
            fixture.input.request.inputManifestDigest,
          ),
          repositoryId: 'different-repository',
        });
        fixture.input.request = request;
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'request.json'),
          request,
        );
      },
      'PROVIDER_REPOSITORY_MISMATCH',
    ],
    [
      'baseline mismatch',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const request = createProviderInvocationRequest({
          ...providerRequestInput(
            fixture.input.request.policyDigest,
            fixture.repository,
            'claude',
            1_048_576,
            fixture.input.request.invocationId,
            fixture.input.request.inputManifestDigest,
          ),
          baseCommit: '9'.repeat(40),
        });
        fixture.input.request = request;
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'request.json'),
          request,
        );
      },
      'PROVIDER_BASELINE_MISMATCH',
    ],
    [
      'semantic schema mismatch',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        fixture.input.semanticOutputSchema = { type: 'string' };
      },
      'PROVIDER_OUTPUT_SCHEMA_UNBOUND',
    ],
  ] as const) {
    const fixture = createRunnerFixture();
    let launches = 0;
    try {
      mutate(fixture);
      assert.throws(
        () =>
          createProviderRunnerForTesting(
            claudeRunnerHost(() => {
              launches += 1;
              return successfulProbe('');
            }),
          ).run(fixture.input, { platform: 'darwin' }),
        (error) => isWorkflowError(error, code),
        name,
      );
      assert.equal(launches, 0, name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('production runner executes Attempt 2 with a durable 600s policy snapshot and the immutable semantic base', () => {
  const fixture = createRunnerFixture();
  const baselinePolicyPath = path.join(
    fixture.repository,
    'workflow/ai-adapter-policy.json',
  );
  const baselinePolicy = fs.readFileSync(baselinePolicyPath, 'utf8');
  try {
    const retryPolicy = writeAdapterPolicy(
      fixture.repository,
      true,
      2,
      600_000,
    );
    const invocationId = 'invocation-adapter-retry-attempt-2';
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
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(fixture.input.invocationDirectory, 'manifest.json'),
        'utf8',
      ),
    ) as unknown;
    const manifestPath = path.join(invocationDirectory, 'manifest.json');
    rewritePrivateJson(manifestPath, manifest);
    const request = providerRequest(
      sha256(retryPolicy),
      fixture.repository,
      'claude',
      fixture.request.limits.aggregateOutputBytes,
      invocationId,
      fixture.request.inputManifestDigest,
      fixture.request.purpose,
      600_000,
    );
    assert.equal(request.baseCommit, fixture.request.baseCommit);
    assert.equal(request.baseTree, fixture.request.baseTree);
    assert.equal(request.limits.timeoutMs, 600_000);
    rewritePrivateJson(path.join(invocationDirectory, 'request.json'), request);
    rewritePrivateJson(path.join(invocationDirectory, 'state.json'), {
      invocationId,
      state: 'leased',
    });
    writeProviderExecutionPolicySnapshot(
      invocationDirectory,
      request,
      retryPolicy,
    );

    // The live tracked policy returns to the immutable semantic baseline. The
    // replacement Attempt executes only from its exact durable policy snapshot.
    fs.writeFileSync(baselinePolicyPath, baselinePolicy, 'utf8');
    let observedTimeoutMs = 0;
    const report = createProviderRunnerForTesting(
      claudeRunnerHost((input) => {
        observedTimeoutMs = input.timeoutMs;
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(request),
          }),
        );
      }),
    ).run(
      {
        ...fixture.input,
        invocationDirectory,
        request,
        outputValidator: outputValidatorFor(request),
        governedRuntimeInputs: [{ id: 'manifest', path: manifestPath }],
      },
      { platform: 'darwin' },
    );
    assert.equal(observedTimeoutMs, 600_000);
    assert.equal(report.requestDigest, request.requestDigest);
  } finally {
    fixture.cleanup();
  }
});

test('runner fails closed for a missing, mismatched, or malformed execution policy snapshot', () => {
  for (const [name, mutate, code] of [
    [
      'missing snapshot',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        fs.unlinkSync(
          path.join(fixture.input.invocationDirectory, 'execution-policy.json'),
        );
      },
      'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE',
    ],
    [
      'mismatched request binding',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const snapshotPath = path.join(
          fixture.input.invocationDirectory,
          'execution-policy.json',
        );
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
          requestDigest: string;
        };
        rewritePrivateJson(snapshotPath, {
          ...snapshot,
          requestDigest: '9'.repeat(64),
        });
      },
      'PROVIDER_EXECUTION_POLICY_SNAPSHOT_MISMATCH',
    ],
    [
      'malformed policy document',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const snapshotPath = path.join(
          fixture.input.invocationDirectory,
          'execution-policy.json',
        );
        const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8')) as {
          policyDocument: string;
        };
        rewritePrivateJson(snapshotPath, {
          ...snapshot,
          policyDocument: '{}',
        });
      },
      'PROVIDER_EXECUTION_POLICY_SNAPSHOT_UNSAFE',
    ],
  ] as const) {
    const fixture = createRunnerFixture();
    let launches = 0;
    try {
      mutate(fixture);
      assert.throws(
        () =>
          createProviderRunnerForTesting(
            claudeRunnerHost(() => {
              launches += 1;
              return successfulProbe('');
            }),
          ).run(fixture.input, { platform: 'darwin' }),
        (error) => isWorkflowError(error, code),
        name,
      );
      assert.equal(launches, 0, name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('runner binds policy, request, and manifest to pinned durable inputs', () => {
  for (const [name, mutate, code] of [
    [
      'live policy differs from pinned HEAD',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const policyContent = writeAdapterPolicy(fixture.repository, true, 1);
        const request = providerRequest(
          sha256(policyContent),
          fixture.repository,
          'claude',
          1_048_576,
          fixture.input.request.invocationId,
          fixture.input.request.inputManifestDigest,
        );
        fixture.input.request = request;
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'request.json'),
          request,
        );
      },
      'PROVIDER_POLICY_BASELINE_MISMATCH',
    ],
    [
      'durable request differs from launch request',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        fixture.input.request = createProviderInvocationRequest({
          ...providerRequestInput(
            fixture.input.request.policyDigest,
            fixture.repository,
            'claude',
            1_048_576,
            fixture.input.request.invocationId,
            fixture.input.request.inputManifestDigest,
          ),
          nonce: 'different-adapter-nonce-00000000',
        });
      },
      'PROVIDER_DURABLE_REQUEST_MISMATCH',
    ],
    [
      'request fields are tampered without recomputing the digest',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        fixture.input.request = {
          ...fixture.input.request,
          nonce: 'tampered-adapter-nonce-0000000',
        };
      },
      'PROVIDER_DURABLE_REQUEST_MISMATCH',
    ],
    [
      'live workflow config differs from pinned HEAD',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        const configPath = path.join(
          fixture.repository,
          'workflow',
          'config.json',
        );
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        config.branchTemplate = 'work/revised-{changeId}';
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
      },
      'PROVIDER_CONFIG_BASELINE_MISMATCH',
    ],
    [
      'manifest bytes do not match the request binding',
      (fixture: ReturnType<typeof createRunnerFixture>) => {
        rewritePrivateJson(
          path.join(fixture.input.invocationDirectory, 'manifest.json'),
          { kind: 'different-manifest' },
        );
      },
      'PROVIDER_INPUT_MANIFEST_MISMATCH',
    ],
  ] as const) {
    const fixture = createRunnerFixture();
    let launches = 0;
    try {
      mutate(fixture);
      assert.throws(
        () =>
          createProviderRunnerForTesting(
            claudeRunnerHost(() => {
              launches += 1;
              return successfulProbe('');
            }),
          ).run(fixture.input, { platform: 'darwin' }),
        (error) => isWorkflowError(error, code),
        name,
      );
      assert.equal(launches, 0, name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('runner fingerprints around provider preflight and model execution', () => {
  const fixture = createRunnerFixture();
  let mutated = false;
  try {
    const host = claudeRunnerHost(() =>
      successfulProbe(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          structured_output: semanticOutput(fixture.request),
        }),
      ),
    );
    const originalProbe = host.runProbe;
    host.runProbe = (input) => {
      if (!mutated) {
        mutated = true;
        fs.writeFileSync(
          path.join(fixture.repository, 'src/preflight-mutated.ts'),
          'mutation\n',
        );
      }
      return originalProbe(input);
    };

    assert.throws(
      () =>
        createProviderRunnerForTesting(host).run(fixture.input, {
          platform: 'darwin',
        }),
      (error) => isWorkflowError(error, 'PROVIDER_GOVERNED_PROJECTION_DRIFT'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner automatically governs its prompt and schema inputs', () => {
  const fixture = createRunnerFixture();
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost((input) => {
            fs.writeFileSync(input.stdinSource, '{"mutated":true}\n');
            return successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: semanticOutput(fixture.request),
              }),
            );
          }),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_GOVERNED_PROJECTION_DRIFT'));
        assert.ok(
          (
            (error as WorkflowError).details?.changedCategories as string[]
          ).includes('governed-runtime-inputs'),
        );
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner revalidates engine files after preflight before model launch', () => {
  const fixture = createRunnerFixture();
  try {
    const host = claudeRunnerHost(() => {
      assert.fail('model execution must not start after preflight file drift');
    });
    const originalProbe = host.runProbe;
    let mutated = false;
    host.runProbe = (input) => {
      const outcome = originalProbe(input);
      if (!mutated) {
        mutated = true;
        fs.writeFileSync(
          path.join(input.cwd, 'prompt.json'),
          '{"preflight":"mutated"}\n',
        );
      }
      return outcome;
    };

    assert.throws(
      () =>
        createProviderRunnerForTesting(host).run(fixture.input, {
          platform: 'darwin',
        }),
      (error) => isWorkflowError(error, 'PROVIDER_RUNTIME_PATH_UNSAFE'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner automatically governs durable request and state inputs', () => {
  for (const fileName of ['request.json', 'state.json']) {
    const fixture = createRunnerFixture();
    try {
      assert.throws(
        () =>
          createProviderRunnerForTesting(
            claudeRunnerHost(() => {
              rewritePrivateJson(
                path.join(fixture.input.invocationDirectory, fileName),
                { mutated: true },
              );
              return successfulProbe(
                JSON.stringify({
                  type: 'result',
                  subtype: 'success',
                  structured_output: semanticOutput(fixture.request),
                }),
              );
            }),
          ).run(fixture.input, { platform: 'darwin' }),
        (error) => {
          assert.ok(
            isWorkflowError(error, 'PROVIDER_GOVERNED_PROJECTION_DRIFT'),
            fileName,
          );
          assert.ok(
            (
              (error as WorkflowError).details?.changedCategories as string[]
            ).includes('governed-runtime-inputs'),
            fileName,
          );
          return true;
        },
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('runner derives drift itself and creates no successful provider result', () => {
  const fixture = createRunnerFixture();
  try {
    const host = claudeRunnerHost(() => {
      fs.writeFileSync(
        path.join(fixture.repository, 'src/provider-mutated.ts'),
        'mutation\n',
      );
      return successfulProbe(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          structured_output: semanticOutput(fixture.request),
        }),
      );
    });

    assert.throws(
      () =>
        createProviderRunnerForTesting(host).run(fixture.input, {
          platform: 'darwin',
        }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_GOVERNED_PROJECTION_DRIFT'));
        assert.deepEqual((error as WorkflowError).details?.changedCategories, [
          'untracked-worktree',
        ]);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('runner enforces native output, aggregate limit, and executable identity', () => {
  for (const [name, execute, code] of [
    [
      'malformed wrapper',
      () => successfulProbe('not-json'),
      'PROVIDER_NATIVE_OUTPUT_INVALID',
    ],
    [
      'non-zero process',
      () => ({ ...successfulProbe(''), exitCode: 7 }),
      'PROVIDER_PROCESS_NONZERO',
    ],
    [
      'aggregate output',
      () => successfulProbe('x'.repeat(1_048_577)),
      'PROVIDER_OUTPUT_LIMIT_EXCEEDED',
    ],
  ] as const) {
    const fixture = createRunnerFixture();
    try {
      assert.throws(
        () =>
          createProviderRunnerForTesting(claudeRunnerHost(execute)).run(
            fixture.input,
            {
              platform: 'darwin',
            },
          ),
        (error) => isWorkflowError(error, code),
        name,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('malformed native output yields bounded redacted repair feedback', () => {
  const fixture = createRunnerFixture();
  const malformed = 'not-json secret-that-must-not-enter-repair-evidence';
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe(malformed)),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_NATIVE_OUTPUT_INVALID'));
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.equal(repair.repairKind, 'schema');
        assert.deepEqual(repair.previousOutput, {
          kind: 'provider-native-output-unavailable',
          reasonCode: 'NATIVE_JSON_PARSE_FAILED',
        });
        assert.deepEqual(repair.validationErrors, [
          {
            path: '/',
            code: 'NATIVE_JSON_PARSE_FAILED',
            message:
              'Provider native output was not valid JSON; return one complete object matching the target schema.',
          },
        ]);
        const encoded = canonicalJson(repair);
        assert.ok(Buffer.byteLength(encoded, 'utf8') < 300_000);
        assert.equal(encoded.includes(malformed), false);
        assert.equal(encoded.includes('secret-that-must-not-enter'), false);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('missing Codex semantic payload yields the same bounded repair contract', () => {
  const fixture = createRunnerFixture('codex');
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          codexRunnerHost(() => successfulProbe('{"type":"turn.completed"}\n')),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_NATIVE_OUTPUT_INVALID'));
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.deepEqual(repair.previousOutput, {
          kind: 'provider-native-output-unavailable',
          reasonCode: 'NATIVE_JSON_PARSE_FAILED',
        });
        assert.deepEqual(
          repair.validationErrors.map(({ path, code }) => ({ path, code })),
          [{ path: '/', code: 'NATIVE_JSON_PARSE_FAILED' }],
        );
        assert.ok(Buffer.byteLength(canonicalJson(repair), 'utf8') < 300_000);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('real runner returns bounded structured schema feedback for a repair Attempt', () => {
  const fixture = createRunnerFixture();
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() =>
            successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: {
                  reference: 7,
                  terms: [],
                },
              }),
            ),
          ),
        ).run(
          {
            ...fixture.input,
            outputValidator: {
              ...fixture.input.outputValidator,
              validate: () => false,
            },
          },
          { platform: 'darwin' },
        ),
      (error) => {
        assert.ok(isWorkflowError(error, 'PROVIDER_NATIVE_OUTPUT_INVALID'));
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.equal(repair.repairKind, 'schema');
        assert.deepEqual(repair.previousOutput, {
          reference: 7,
          terms: [],
        });
        assert.deepEqual(
          repair.validationErrors.map(({ path, code }) => ({ path, code })),
          [{ path: '/reference', code: 'TYPE_STRING_REQUIRED' }],
        );
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('real runner distinguishes semantic feedback after structural validation passes', () => {
  const fixture = createRunnerFixture();
  try {
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() =>
            successfulProbe(
              JSON.stringify({
                type: 'result',
                subtype: 'success',
                structured_output: semanticOutput(fixture.request),
              }),
            ),
          ),
        ).run(
          {
            ...fixture.input,
            outputValidator: {
              ...fixture.input.outputValidator,
              validate: () => false,
            },
          },
          { platform: 'darwin' },
        ),
      (error) => {
        const repair = extractProviderRepairFailure(error, PROVIDER_SCHEMA);
        assert.ok(repair);
        assert.equal(repair.repairKind, 'semantic');
        assert.deepEqual(repair.validationErrors, [
          {
            path: '/',
            code: 'SEMANTIC_VALIDATION_FAILED',
            message:
              'Output matched the structural schema but failed the bound semantic validator.',
          },
        ]);
        return true;
      },
    );
  } finally {
    fixture.cleanup();
  }
});

test('Codex semantic output file and normalized output count toward the aggregate cap', () => {
  const fixture = createRunnerFixture('codex', 1024);
  try {
    const oversized = {
      reference: fixture.request.invocationId,
      terms: [{ kind: 'symbol', value: 'x'.repeat(1500) }],
    };
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          codexRunnerHost((input) => {
            const outputIndex = input.args.indexOf('--output-last-message');
            assert.ok(outputIndex >= 0);
            fs.writeFileSync(
              input.args[outputIndex + 1]!,
              JSON.stringify(oversized),
            );
            return successfulProbe('{"type":"turn.completed"}\n');
          }),
        ).run(fixture.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_LIMIT_EXCEEDED'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('provider concurrency is bounded repository-wide and slots release in finally', () => {
  const fixture = createRunnerFixture();
  const outerInput = bindRunnerInputToInvestigationOwner(
    fixture.input,
    'investigation-provider-concurrency-outer',
  );
  const second = bindRunnerInputToInvestigationOwner(
    siblingRunnerInput(fixture, 'invocation-adapter-second'),
    'investigation-provider-concurrency-second',
  );
  const third = bindRunnerInputToInvestigationOwner(
    siblingRunnerInput(fixture, 'invocation-adapter-third'),
    'investigation-provider-concurrency-third',
  );
  let thirdLaunches = 0;
  try {
    const thirdRunner = createProviderRunnerForTesting(
      claudeRunnerHost(() => {
        thirdLaunches += 1;
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(third.request),
          }),
        );
      }),
    );
    const secondRunner = createProviderRunnerForTesting(
      claudeRunnerHost(() => {
        assert.throws(
          () => thirdRunner.run(third, { platform: 'darwin' }),
          (error) => isWorkflowError(error, 'PROVIDER_CONCURRENCY_LIMIT'),
        );
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(second.request),
          }),
        );
      }),
    );
    const outerRunner = createProviderRunnerForTesting(
      claudeRunnerHost(() => {
        const nested = secondRunner.run(second, { platform: 'darwin' });
        assert.equal(nested.assurance, 'unchanged-governed-projection');
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(fixture.request),
          }),
        );
      }),
    );

    const outer = outerRunner.run(outerInput, { platform: 'darwin' });
    assert.equal(outer.assurance, 'unchanged-governed-projection');
    assert.equal(thirdLaunches, 0);

    const afterRelease = thirdRunner.run(third, { platform: 'darwin' });
    assert.equal(afterRelease.assurance, 'unchanged-governed-projection');
    assert.equal(thirdLaunches, 1);
  } finally {
    fixture.cleanup();
  }
});

test('provider concurrency reclaims dead owners and honors a lowered limit', () => {
  const reclaimable = createRunnerFixture();
  try {
    writeProviderSlot(reclaimable.repository, 0, 999_999_991);
    writeProviderSlot(reclaimable.repository, 1, 999_999_992);
    const report = createProviderRunnerForTesting(
      claudeRunnerHost(() =>
        successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(reclaimable.request),
          }),
        ),
      ),
    ).run(reclaimable.input, { platform: 'darwin' });
    assert.equal(report.assurance, 'unchanged-governed-projection');
  } finally {
    reclaimable.cleanup();
  }

  const lowered = createRunnerFixture('claude', 1_048_576, 1);
  try {
    writeProviderSlot(lowered.repository, 1, process.pid);
    assert.throws(
      () =>
        createProviderRunnerForTesting(
          claudeRunnerHost(() => successfulProbe('')),
        ).run(lowered.input, { platform: 'darwin' }),
      (error) => isWorkflowError(error, 'PROVIDER_CONCURRENCY_LIMIT'),
    );
  } finally {
    lowered.cleanup();
  }
});

test('tracked policy is managed-lifecycle-only and diagnostic remains non-launching', () => {
  const policy = JSON.parse(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/ai-adapter-policy.json'),
      'utf8',
    ),
  );
  assert.equal(policy.schemaVersion, 4);
  assert.equal(policy.mode, 'managed-read-only');
  assert.equal(policy.launchPolicy, 'lifecycle-only');

  const schema = JSON.parse(
    fs.readFileSync(
      path.join(
        sourceRepositoryRoot,
        'workflow/schemas/ai-adapter-policy.schema.json',
      ),
      'utf8',
    ),
  );
  assert.equal(schema.properties.schemaVersion.const, 4);
  assert.equal(schema.properties.mode.const, 'managed-read-only');
  assert.equal(schema.properties.launchPolicy.const, 'lifecycle-only');
});

function createRunnerFixture(
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

function hostWrapperProfile(wrapperPath: string, resumable: boolean) {
  const profile = hostWrapperConfiguration(wrapperPath, resumable)
    .providers[0]!;
  assert.equal(profile.trustTier, 'host-wrapper');
  return profile as HostWrapperProviderProfileSnapshot;
}

function hostWrapperConfiguration(wrapperPath: string, resumable: boolean) {
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

function durableHostWrapperAssignment(
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

function gitBlobObjectId(source: string): string {
  return crypto
    .createHash('sha1')
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest('hex');
}

function canonicalHostWrapperFixture(
  terminal: 'result' | 'error' | 'cancelled' = 'result',
  exitCode = terminal === 'result' || terminal === 'cancelled' ? 0 : 2,
): string {
  const terminalFrame =
    terminal === 'result'
      ? "emit({ schemaVersion: 2, type: 'result', sequence, outputSlot: 'primary' });"
      : terminal === 'error'
        ? "emit({ schemaVersion: 2, type: 'error', sequence, code: 'FIXTURE_REJECTED' });"
        : "process.once('SIGTERM', () => { emit({ schemaVersion: 2, type: 'cancel-ack', sequence }); setTimeout(() => process.exit(0), 10); }); setInterval(() => {}, 1000);";
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

function hostWrapperStartController(
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

function hostWrapperInput(
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

function hostWrapperAssignmentBinding(
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

function fakeNativeSessionClaim(
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

function providerRequest(
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

function providerRequestInput(
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
      role: purpose === 'plan-review' ? 'plan-reviewer' : 'blind-surveyor',
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

function semanticOutput(request: ProviderInvocationRequest) {
  return {
    reference: request.invocationId,
    terms: [{ kind: 'symbol', value: 'protectedBranches' }],
  };
}

function outputValidatorFor(request: ProviderInvocationRequest) {
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

function siblingRunnerInput(
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

function bindRunnerInputToInvestigationOwner(
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

function executableIdentity(
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

function successfulProbe(stdout: string) {
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

function fakeHost(
  override: Partial<ProviderRunnerHost> = {},
): ProviderRunnerHost {
  return {
    inspectCandidate: () => null,
    runProbe: () => successfulProbe(''),
    execute: () => successfulProbe(''),
    ...override,
  };
}

function claudeRunnerHost(
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

function codexRunnerHost(
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

function writeAdapterPolicy(
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

function writeProviderExecutionPolicySnapshot(
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

function createPrivateDirectory(directory: string): void {
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

function rewritePrivateJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function writeProviderSlot(
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

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
