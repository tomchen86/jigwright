import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  BOUNDED_PROVIDER_PROCESS_V2_CONTRACT_VERSION,
  providerNativeSessionIdDigest,
  spawnBoundedProviderSessionProcess,
  type ProviderWrapperSessionFrameReceipt,
  type ProviderWrapperSessionProtocolBinding,
} from '../src/index.ts';

const fixtureProcess = path.join(
  import.meta.dirname,
  'fixtures/provider-wrapper-fixture.mjs',
);
const requestDigest = 'c'.repeat(64);

function observedStartBinding(): ProviderWrapperSessionProtocolBinding {
  return {
    invocationId: 'invocation-bounded-v2-start',
    requestDigest,
    attemptId: 'attempt-bounded-v2-start',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
}

function engineSuppliedBinding(
  action: 'start' | 'resume',
  nativeSessionId: string,
): ProviderWrapperSessionProtocolBinding {
  return {
    invocationId: `invocation-bounded-v2-${action}`,
    requestDigest,
    attemptId: `attempt-bounded-v2-${action}`,
    sessionControl: {
      action,
      nativeSessionIdentityMode: 'engine-supplied',
      expectedNativeSessionId: nativeSessionId,
    },
  };
}

function runV2(
  mode: string,
  binding: ProviderWrapperSessionProtocolBinding,
  options: Readonly<{
    timeoutMs?: number;
    signal?: AbortSignal;
    onFrame?: (receipt: ProviderWrapperSessionFrameReceipt) => void;
    privateNativeSessionIdentitySink?: (identity: {
      nativeSessionId: string;
    }) => void;
  }> = {},
) {
  return spawnBoundedProviderSessionProcess({
    executable: process.execPath,
    args: [
      fixtureProcess,
      mode,
      binding.sessionControl.expectedNativeSessionId ?? '',
    ],
    cwd: os.tmpdir(),
    environment: {},
    timeoutMs: options.timeoutMs ?? 2_000,
    maxOutputBytes: 16_384,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    wrapperSessionProtocol: {
      protocol: 'harness-jsonl-v2',
      binding,
      ...(options.onFrame === undefined ? {} : { onFrame: options.onFrame }),
      ...(options.privateNativeSessionIdentitySink === undefined
        ? {}
        : {
            privateNativeSessionIdentitySink:
              options.privateNativeSessionIdentitySink,
          }),
    },
  });
}

test('bounded process v2 returns validated observed-start and exact-resume session outcomes', async () => {
  assert.equal(
    BOUNDED_PROVIDER_PROCESS_V2_CONTRACT_VERSION,
    'jigwright.agent-runtime.bounded-provider-process.v2',
  );
  const privateStartedIdentities: Array<{ nativeSessionId: string }> = [];
  const started = await runV2('v2-start-observed', observedStartBinding(), {
    privateNativeSessionIdentitySink(identity) {
      privateStartedIdentities.push(identity);
    },
  });

  assert.equal(started.terminationReason, 'exited');
  assert.equal(
    JSON.stringify(started).includes('native-bounded-observed-1'),
    false,
  );
  assert.equal(started.stdout.includes('native-bounded-observed-1'), false);
  assert.equal(started.stderr, '');
  assert.equal(
    JSON.stringify(started.wrapperSessionProtocolOutcome).includes(
      'native-bounded-observed-1',
    ),
    false,
  );
  assert.equal(
    'observedNativeSessionId' in started.wrapperSessionProtocolOutcome!,
    false,
  );
  assert.equal(
    privateStartedIdentities[0]?.nativeSessionId,
    'native-bounded-observed-1',
  );
  assert.equal(
    started.wrapperSessionProtocolOutcome?.receipt.terminal,
    'result',
  );
  assert.equal(
    started.wrapperSessionProtocolOutcome?.receipt
      .observedNativeSessionIdDigest,
    providerNativeSessionIdDigest('native-bounded-observed-1'),
  );
  assert.equal(
    JSON.stringify(started.wrapperSessionProtocolOutcome?.receipt).includes(
      'native-bounded-observed-1',
    ),
    false,
  );
  assert.equal('wrapperProtocolReceipt' in started, false);

  const resumed = await runV2(
    'v2-resume',
    engineSuppliedBinding(
      'resume',
      privateStartedIdentities[0]!.nativeSessionId,
    ),
  );
  assert.equal(resumed.terminationReason, 'exited');
  assert.equal(resumed.stdout.includes('native-bounded-observed-1'), false);
  assert.equal(
    JSON.stringify(resumed.wrapperSessionProtocolOutcome).includes(
      'native-bounded-observed-1',
    ),
    false,
  );
  assert.equal(
    resumed.wrapperSessionProtocolOutcome?.receipt.sessionAction,
    'resume',
  );
  assert.equal(
    resumed.wrapperSessionProtocolOutcome?.receipt
      .expectedNativeSessionIdDigest,
    started.wrapperSessionProtocolOutcome?.receipt
      .observedNativeSessionIdDigest,
  );
});

test('bounded process v2 fails closed on mismatched, missing, duplicate, and post-terminal session evidence', async () => {
  for (const { mode, binding } of [
    {
      mode: 'v2-mismatch',
      binding: engineSuppliedBinding('resume', 'native-bounded-expected'),
    },
    { mode: 'v2-missing', binding: observedStartBinding() },
    { mode: 'v2-duplicate', binding: observedStartBinding() },
    { mode: 'v2-post-terminal', binding: observedStartBinding() },
  ]) {
    const outcome = await runV2(mode, binding);
    assert.equal(outcome.terminationReason, 'protocol-error', mode);
    assert.equal(
      outcome.spawnErrorCode,
      'PROVIDER_WRAPPER_SESSION_PROTOCOL_INVALID',
      mode,
    );
    assert.equal(outcome.wrapperSessionProtocolOutcome, undefined, mode);
  }
});

test('bounded process v2 suppresses timeout diagnostics and never promotes partial session evidence', async () => {
  const outcome = await runV2(
    'v2-timeout',
    engineSuppliedBinding('start', 'native-bounded-timeout'),
    { timeoutMs: 300 },
  );

  assert.equal(outcome.terminationReason, 'timed-out');
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.stderr, '');
  assert.equal(outcome.wrapperSessionProtocolOutcome, undefined);
});

test('bounded process v2 never returns unobserved native identity text from stderr', async () => {
  const nativeSessionId = 'unobserved-native-session-secret';
  const outcome = await runV2('v2-unobserved-stderr', observedStartBinding());

  assert.equal(outcome.terminationReason, 'protocol-error');
  assert.equal(outcome.stderr, '');
  assert.equal(JSON.stringify(outcome).includes(nativeSessionId), false);
});

test('bounded process v2 cancellation retains only a digest receipt and publishes no private identity', async () => {
  const controller = new AbortController();
  const publicFrames: ProviderWrapperSessionFrameReceipt[] = [];
  const privateIdentities: Array<{ nativeSessionId: string }> = [];
  const outcome = await runV2('v2-cancel-ack', observedStartBinding(), {
    signal: controller.signal,
    onFrame(receipt) {
      publicFrames.push(receipt);
      if (receipt.frame.type === 'session') controller.abort();
    },
    privateNativeSessionIdentitySink(identity) {
      privateIdentities.push(identity);
    },
  });

  assert.equal(outcome.terminationReason, 'cancelled');
  assert.equal(outcome.stderr, '');
  assert.equal(
    JSON.stringify(publicFrames).includes('native-bounded-cancel'),
    false,
  );
  assert.equal(outcome.stdout.includes('native-bounded-cancel'), false);
  assert.equal(
    JSON.stringify(outcome.wrapperSessionProtocolOutcome).includes(
      'native-bounded-cancel',
    ),
    false,
  );
  assert.deepEqual(privateIdentities, []);
  assert.deepEqual(
    outcome.wrapperSessionProtocolOutcome?.receipt.cancellation,
    {
      requested: true,
      acknowledged: true,
      forced: false,
    },
  );
});

for (const fixture of [
  {
    mode: 'v2-result-before-abort',
    abortOn: 'result',
    terminal: 'result',
    requested: false,
    exitCode: 0,
  },
  {
    mode: 'v2-cancel-result',
    abortOn: 'session',
    terminal: 'result',
    requested: true,
    exitCode: 0,
  },
  {
    mode: 'v2-cancel-error',
    abortOn: 'session',
    terminal: 'error',
    requested: true,
    exitCode: 2,
  },
] as const) {
  test(`bounded process v2 preserves ${fixture.mode} as its natural terminal`, async () => {
    const controller = new AbortController();
    const privateIdentities: Array<{ nativeSessionId: string }> = [];
    const outcome = await runV2(fixture.mode, observedStartBinding(), {
      signal: controller.signal,
      onFrame(receipt) {
        if (receipt.frame.type === fixture.abortOn) controller.abort();
      },
      privateNativeSessionIdentitySink(identity) {
        privateIdentities.push(identity);
      },
    });

    assert.equal(outcome.terminationReason, 'exited');
    assert.equal(outcome.exitCode, fixture.exitCode);
    assert.equal(outcome.spawnErrorCode, null);
    assert.equal(
      outcome.wrapperSessionProtocolOutcome?.receipt.terminal,
      fixture.terminal,
    );
    assert.deepEqual(
      outcome.wrapperSessionProtocolOutcome?.receipt.cancellation,
      {
        requested: fixture.requested,
        acknowledged: false,
        forced: false,
      },
    );
    assert.equal(
      outcome.wrapperSessionProtocolOutcome?.receipt.errorCode,
      fixture.terminal === 'error' ? 'PROVIDER_FAILED' : null,
    );
    assert.equal(
      privateIdentities.length,
      fixture.terminal === 'result' ? 1 : 0,
    );
  });
}

test('bounded process v2 retains provider errors without upgrading missing identity to success', async () => {
  const privateIdentities: Array<{ nativeSessionId: string }> = [];
  const failed = await runV2('v2-error', observedStartBinding(), {
    privateNativeSessionIdentitySink(identity) {
      privateIdentities.push(identity);
    },
  });
  assert.equal(failed.terminationReason, 'exited');
  assert.equal(failed.exitCode, 2);
  assert.equal(failed.stderr, '');
  assert.equal(failed.wrapperSessionProtocolOutcome?.receipt.terminal, 'error');
  assert.equal(
    failed.wrapperSessionProtocolOutcome?.receipt.errorCode,
    'PROVIDER_FAILED',
  );
  assert.equal(
    JSON.stringify(failed.wrapperSessionProtocolOutcome).includes(
      'native-bounded-error',
    ),
    false,
  );
  assert.equal(failed.stdout.includes('native-bounded-error'), false);
  assert.deepEqual(privateIdentities, []);

  const noSession = await runV2('v2-error-no-session', observedStartBinding());
  assert.equal(noSession.terminationReason, 'exited');
  assert.equal(
    noSession.wrapperSessionProtocolOutcome?.receipt.terminal,
    'error',
  );
  assert.equal(
    noSession.wrapperSessionProtocolOutcome?.receipt.sessionFrameCount,
    0,
  );
  assert.equal(
    'observedNativeSessionId' in noSession.wrapperSessionProtocolOutcome!,
    false,
  );
  assert.notEqual(
    noSession.wrapperSessionProtocolOutcome?.receipt.terminal,
    'result',
  );
});
