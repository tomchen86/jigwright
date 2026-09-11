import { describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { parseAiAdapterPolicyDocument } from '../src/runtime/provider-execution/ai-adapter-policy.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  blindSurveyIntentDigest,
  blindSurveyOutputValidator,
  claimProviderInvocation,
  completeProviderInvocationFromRunner,
  createProviderInvocation,
  prepareProviderInvocationAcceptanceBinding,
  readProviderInvocation,
  recoverProviderInvocationCompletion,
  storeProviderExecutionPolicySnapshot,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { readProviderInvocationLifecycleProjection } from '../src/runtime/storage-journal/provider-invocation-lifecycle.ts';
import {
  providerExecutionAdmissionAuthorityPath,
  readExecutionJobState,
} from '../src/runtime/storage-journal/execution-store.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import { productionAgentRuntime } from '../src/composition-root/agent-runtime-production.ts';
import {
  type ProviderNativeSessionClaimV1,
  type ProviderNativeSessionCompletionV1,
} from '../src/modules/provider-orchestration/provider-native-session.ts';
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
import { createFixtureRepository } from './fixture.ts';
import {
  durableHostWrapperAssignment,
  canonicalHostWrapperFixture,
  hostWrapperInput,
  semanticOutput,
  writeAdapterPolicy,
  rewritePrivateJson,
  sha256,
} from './provider-adapter-fixture.ts';

async function createLeasedNativeFixture(verify?: {
  claim(claimed: ReturnType<typeof claimProviderNativeSessionTurnV1>): void;
  complete(nativeClaim: ProviderNativeSessionClaimV1 | null): void;
}) {
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
      sourceRefs: [],
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
      role: 'plan-reviewer',
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
        verify?.claim(claimed);
        if (!claimed.binding)
          throw new Error('Native fixture claim omitted its exact binding.');
        nativeClaim = claimed.claim;
        return {
          claim: claimed.claim,
          claimDigest: claimed.claim.claimDigest,
          predecessorCompletionDigest: null,
          binding: claimed.binding,
        };
      },
      complete(value) {
        verify?.complete(nativeClaim);
        if (nativeClaim === null)
          throw new Error('Native fixture claim was not published.');
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
  const cleanup = () => {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(hostDirectory, { recursive: true, force: true });
  };
  try {
    const report = await productionAgentRuntime.runSingleShotAsync(input, {
      platform: process.platform,
    });
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
    return {
      repository,
      hostDirectory,
      wrapper,
      policyContent,
      invocationId,
      investigationId,
      changeId,
      locator,
      runtime,
      invocationDirectory,
      manifest,
      manifestDigest,
      targetDigest,
      request,
      claim,
      acceptanceBinding,
      assignment,
      profile,
      completed,
      nativeClaim,
      nativeCompletion,
      input,
      report,
      probeDirectory,
      turnDirectory,
      artifacts,
      originals,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function nativeArtifactAssertions(
  fixture: Awaited<ReturnType<typeof createLeasedNativeFixture>>,
) {
  const { invocationId, runtime, originals } = fixture;
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
  return { assertUnsafe, restore, replaceCanonical };
}

async function createRecoveredNativeFixture() {
  const fixture = await createLeasedNativeFixture();
  const {
    invocationId,
    runtime,
    invocationDirectory,
    claim,
    acceptanceBinding,
    nativeClaim,
    nativeCompletion,
    report,
  } = fixture;
  try {
    const protocolReceipt = report.wrapperProtocolReceipt;
    if (protocolReceipt?.kind !== 'provider-wrapper-session-protocol-receipt')
      throw new Error('Native fixture report omitted its protocol receipt.');
    let interrupted = false;
    try {
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
      });
    } catch (error) {
      if (
        !(error instanceof WorkflowError) ||
        error.code !== 'PROVIDER_CONTINUATION_AUTHORITY_SIMULATED_CRASH'
      )
        throw error;
      interrupted = true;
    }
    if (!interrupted) {
      throw new Error('Expected the native continuation publication crash.');
    }
    recoverProviderInvocationCompletion(runtime, invocationId, {
      expectedRevision: claim.record.revision,
    });
    const statePath = path.join(invocationDirectory, 'state.json');
    const publishedNativeClaim =
      nativeClaim as unknown as ProviderNativeSessionClaimV1;
    const publishedNativeCompletion =
      nativeCompletion as unknown as ProviderNativeSessionCompletionV1;
    const nativePaths = providerNativeSessionStorePathsV1(runtime);
    const continuationAuthorityPath =
      providerNativeSessionContinuationAuthorityObjectPathV1(
        nativePaths,
        publishedNativeCompletion.completionDigest,
      );
    const terminalState = JSON.parse(
      fs.readFileSync(statePath, 'utf8'),
    ) as Record<string, unknown>;
    const admissionAuthorityPath = providerExecutionAdmissionAuthorityPath(
      runtime,
      acceptanceBinding,
    );
    const admissionAuthorityBytes = fs.readFileSync(
      admissionAuthorityPath,
      'utf8',
    );
    const terminalStateBytes = fs.readFileSync(statePath, 'utf8');
    return {
      ...fixture,
      protocolReceipt,
      statePath,
      publishedNativeClaim,
      publishedNativeCompletion,
      nativePaths,
      continuationAuthorityPath,
      terminalState,
      admissionAuthorityPath,
      admissionAuthorityBytes,
      terminalStateBytes,
    };
  } catch (error) {
    fixture.cleanup();
    throw error;
  }
}

describe('production host-wrapper artifacts remain an exact provider lifecycle closure', () => {
  test('keeps leased wrapper artifacts bounded without trusting terminal claims', async () => {
    const fixture = await createLeasedNativeFixture({
      claim(claimed: ReturnType<typeof claimProviderNativeSessionTurnV1>) {
        assert.equal(claimed.outcome, 'claimed');
        assert.ok(claimed.binding);
      },
      complete(nativeClaim: ProviderNativeSessionClaimV1 | null) {
        if (nativeClaim === null) assert.fail('native claim was not published');
      },
    });
    const {
      hostDirectory,
      invocationId,
      runtime,
      invocationDirectory,
      request,
      completed,
      report,
      probeDirectory,
      turnDirectory,
      artifacts,
      originals,
      cleanup,
      assertUnsafe,
      restore,
      replaceCanonical,
    } = { ...fixture, ...nativeArtifactAssertions(fixture) };
    try {
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
      // A file the engine does not own at the invocation root is reported,
      // not fatal: the engine's own atomic write leaves a .tmp here when it is
      // killed, and an invocation nobody can read any more has no exit. The
      // closure stays exact where it is evidence - digesting still refuses.
      const extraRoot = path.join(invocationDirectory, 'unexpected.json');
      rewritePrivateJson(extraRoot, { unexpected: true });
      assert.deepEqual(
        readProviderInvocationLifecycleProjection(runtime, invocationId)
          .strayFiles,
        ['unexpected.json'],
      );
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
          readProviderInvocationLifecycleProjection(runtime, invocationId)
            .state,
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
          readProviderInvocationLifecycleProjection(runtime, invocationId)
            .state,
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
    } finally {
      cleanup();
    }
  });

  test('repairs the exact completion crash window before continuation replay', async () => {
    const fixture = await createLeasedNativeFixture();
    const {
      invocationId,
      changeId,
      runtime,
      invocationDirectory,
      claim,
      acceptanceBinding,
      assignment,
      nativeClaim,
      nativeCompletion,
      report,
      cleanup,
    } = { ...fixture, ...nativeArtifactAssertions(fixture) };
    try {
      const protocolReceipt = report.wrapperProtocolReceipt;
      if (
        protocolReceipt?.kind !== 'provider-wrapper-session-protocol-receipt'
      ) {
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
    } finally {
      cleanup();
    }
  });

  test('rejects poisoned terminal authority and receipt artifacts without rewriting them', async () => {
    const fixture = await createRecoveredNativeFixture();
    const {
      hostDirectory,
      invocationId,
      changeId,
      runtime,
      request,
      acceptanceBinding,
      assignment,
      probeDirectory,
      turnDirectory,
      artifacts,
      originals,
      cleanup,
      protocolReceipt,
      statePath,
      publishedNativeClaim,
      publishedNativeCompletion,
      nativePaths,
      terminalState,
      admissionAuthorityPath,
      admissionAuthorityBytes,
      terminalStateBytes,
      assertUnsafe,
      restore,
      replaceCanonical,
    } = { ...fixture, ...nativeArtifactAssertions(fixture) };
    try {
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
      const assignmentObjectBytes = fs.readFileSync(
        assignmentObjectPath,
        'utf8',
      );
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
    } finally {
      cleanup();
    }
  });

  test('resumes only from the completed native session authority', async () => {
    const fixture = await createRecoveredNativeFixture();
    const {
      repository,
      policyContent,
      invocationId,
      investigationId,
      changeId,
      runtime,
      invocationDirectory,
      manifest,
      targetDigest,
      request,
      claim,
      acceptanceBinding,
      assignment,
      profile,
      cleanup,
      publishedNativeCompletion,
    } = { ...fixture, ...nativeArtifactAssertions(fixture) };
    try {
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
      const resumedLease = claimProviderInvocation(
        runtime,
        resumedInvocationId,
        {
          workerId: 'provider-worker-host-wrapper-lifecycle-resume',
          leaseDurationMs: resumedRequest.limits.timeoutMs,
          now: '2026-08-31T00:01:01.000Z',
        },
      );
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
            resumedNativeCompletion =
              completeClaimedProviderNativeSessionTurnV1(runtime, {
                changeId: assignment.record.changeId,
                planningGeneration: assignment.record.planningGeneration,
                assignmentRecordDigest: assignment.record.recordDigest,
                sessionSlotId: assignment.slot.sessionSlotId,
                claimDigest: current.claimDigest,
                terminal: value.terminal,
              });
            return {
              completionDigest: resumedNativeCompletion.completionDigest,
            };
          },
        },
        assignment.binding,
      );
      const resumedReport = await productionAgentRuntime.runSingleShotAsync(
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
      cleanup();
    }
  });
});
