import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLAUDE_REQUIRED_HELP_FLAGS } from '../src/adapters/providers/claude/claude-provider-adapter.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { createProviderRunnerForTesting } from '../src/runtime/provider-execution/provider-runner.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '../src/runtime/provider-execution/built-in-provider-definition.ts';
import { createAgentRuntimeAssignmentBindingV1 } from '../src/modules/provider-orchestration/agent-runtime-assignment-binding.ts';
import { git } from './fixture.ts';
import {
  builtInProfile,
  createRunnerFixture,
  providerRequest,
  providerRequestInput,
  semanticOutput,
  outputValidatorFor,
  executableIdentity,
  successfulProbe,
  fakeHost,
  claudeRunnerHost,
  codexRunnerHost,
  writeAdapterPolicy,
  writeProviderExecutionPolicySnapshot,
  createPrivateDirectory,
  rewritePrivateJson,
  isWorkflowError,
  sha256,
} from './provider-adapter-fixture.ts';

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
