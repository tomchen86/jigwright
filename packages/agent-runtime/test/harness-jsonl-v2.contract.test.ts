import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HARNESS_JSONL_V2_CONTRACT_VERSION,
  ProviderWrapperSessionProtocolError,
  assertProviderWrapperSessionProtocolOutcome,
  assertProviderWrapperSessionProtocolReceipt,
  createProviderWrapperSessionProtocolParser,
  providerNativeSessionIdDigest,
  renderProviderWrapperSessionFrame,
  type ProviderWrapperSessionProtocolBinding,
  type ProviderWrapperSessionProtocolFrame,
} from '../src/index.ts';

const requestDigest = 'a'.repeat(64);

function engineSuppliedBinding(
  action: 'start' | 'resume',
  nativeSessionId: string,
): ProviderWrapperSessionProtocolBinding {
  return {
    invocationId: `invocation-${action}`,
    requestDigest,
    attemptId: `attempt-${action}`,
    sessionControl: {
      action,
      nativeSessionIdentityMode: 'engine-supplied',
      expectedNativeSessionId: nativeSessionId,
    },
  };
}

function observedStartBinding(): ProviderWrapperSessionProtocolBinding {
  return {
    invocationId: 'invocation-observed-start',
    requestDigest,
    attemptId: 'attempt-observed-start',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
}

function pushFrames(
  parser: ReturnType<typeof createProviderWrapperSessionProtocolParser>,
  frames: readonly ProviderWrapperSessionProtocolFrame[],
): void {
  parser.push(
    Buffer.from(frames.map(renderProviderWrapperSessionFrame).join('')),
  );
}

test('harness-jsonl-v2 binds an engine-supplied start identity into an immutable receipt', () => {
  assert.equal(
    HARNESS_JSONL_V2_CONTRACT_VERSION,
    'jigwright.agent-runtime.harness-jsonl.v2',
  );
  const binding = engineSuppliedBinding('start', 'native-session-start-1');
  const publicFrames: unknown[] = [];
  const privateIdentities: unknown[] = [];
  const parser = createProviderWrapperSessionProtocolParser({
    binding,
    onFrame(receipt) {
      publicFrames.push(receipt);
    },
    privateNativeSessionIdentitySink(identity) {
      privateIdentities.push(identity);
    },
  });
  pushFrames(parser, [
    {
      schemaVersion: 2,
      type: 'hello',
      sequence: 1,
      protocol: 'harness-jsonl-v2',
    },
    {
      schemaVersion: 2,
      type: 'session',
      sequence: 2,
      action: 'start',
      nativeSessionId: 'native-session-start-1',
    },
    {
      schemaVersion: 2,
      type: 'progress',
      sequence: 3,
      phase: 'model',
    },
    {
      schemaVersion: 2,
      type: 'result',
      sequence: 4,
      outputSlot: 'primary',
    },
  ]);

  const outcome = parser.finish({ cancellationForced: false });
  assert.equal('observedNativeSessionId' in outcome, false);
  assert.equal(
    JSON.stringify(outcome).includes('native-session-start-1'),
    false,
  );
  assert.equal(
    JSON.stringify(publicFrames).includes('native-session-start-1'),
    false,
  );
  assert.deepEqual(privateIdentities, [
    {
      schemaVersion: 2,
      kind: 'provider-wrapper-native-session-identity-observation',
      protocol: 'harness-jsonl-v2',
      invocationId: binding.invocationId,
      requestDigest: binding.requestDigest,
      attemptId: binding.attemptId,
      sessionAction: 'start',
      nativeSessionId: 'native-session-start-1',
      nativeSessionIdDigest: providerNativeSessionIdDigest(
        'native-session-start-1',
      ),
      protocolReceiptDigest: outcome.receipt.receiptDigest,
    },
  ]);
  assert.equal(outcome.receipt.sessionAction, 'start');
  assert.equal(outcome.receipt.nativeSessionIdentityMode, 'engine-supplied');
  assert.equal(outcome.receipt.sessionFrameCount, 1);
  assert.equal(
    outcome.receipt.expectedNativeSessionIdDigest,
    providerNativeSessionIdDigest('native-session-start-1'),
  );
  assert.equal(
    outcome.receipt.observedNativeSessionIdDigest,
    outcome.receipt.expectedNativeSessionIdDigest,
  );
  assert.equal(Object.isFrozen(outcome), true);
  assert.equal(Object.isFrozen(outcome.receipt), true);
  assert.deepEqual(
    assertProviderWrapperSessionProtocolOutcome(
      structuredClone(outcome),
      binding,
    ),
    outcome,
  );
});

test('harness-jsonl-v2 admits provider-observed starts and exact engine-supplied resumes', () => {
  const observedBinding = observedStartBinding();
  const privateObservedIdentities: Array<{ nativeSessionId: string }> = [];
  const observedParser = createProviderWrapperSessionProtocolParser({
    binding: observedBinding,
    privateNativeSessionIdentitySink(identity) {
      privateObservedIdentities.push(identity);
    },
  });
  pushFrames(observedParser, [
    {
      schemaVersion: 2,
      type: 'hello',
      sequence: 1,
      protocol: 'harness-jsonl-v2',
    },
    {
      schemaVersion: 2,
      type: 'session',
      sequence: 2,
      action: 'start',
      nativeSessionId: 'provider-observed-session-1',
    },
    {
      schemaVersion: 2,
      type: 'result',
      sequence: 3,
      outputSlot: 'primary',
    },
  ]);
  const observed = observedParser.finish({ cancellationForced: false });
  assert.equal(observed.receipt.expectedNativeSessionIdDigest, null);
  assert.equal(
    observed.receipt.observedNativeSessionIdDigest,
    providerNativeSessionIdDigest('provider-observed-session-1'),
  );

  const resumeBinding = engineSuppliedBinding(
    'resume',
    'provider-observed-session-1',
  );
  const resumeParser = createProviderWrapperSessionProtocolParser({
    binding: resumeBinding,
  });
  pushFrames(resumeParser, [
    {
      schemaVersion: 2,
      type: 'hello',
      sequence: 1,
      protocol: 'harness-jsonl-v2',
    },
    {
      schemaVersion: 2,
      type: 'session',
      sequence: 2,
      action: 'resume',
      nativeSessionId: privateObservedIdentities[0]!.nativeSessionId,
    },
    {
      schemaVersion: 2,
      type: 'result',
      sequence: 3,
      outputSlot: 'primary',
    },
  ]);
  const resumed = resumeParser.finish({ cancellationForced: false });
  assert.equal(resumed.receipt.sessionAction, 'resume');
  assert.equal(
    resumed.receipt.observedNativeSessionIdDigest,
    observed.receipt.observedNativeSessionIdDigest,
  );
});

test('harness-jsonl-v2 fails closed on duplicate, mismatched, missing, or post-terminal session evidence', () => {
  const hello: ProviderWrapperSessionProtocolFrame = {
    schemaVersion: 2,
    type: 'hello',
    sequence: 1,
    protocol: 'harness-jsonl-v2',
  };

  {
    const parser = createProviderWrapperSessionProtocolParser({
      binding: engineSuppliedBinding('start', 'native-duplicate'),
    });
    pushFrames(parser, [
      hello,
      {
        schemaVersion: 2,
        type: 'session',
        sequence: 2,
        action: 'start',
        nativeSessionId: 'native-duplicate',
      },
    ]);
    assert.throws(
      () =>
        pushFrames(parser, [
          {
            schemaVersion: 2,
            type: 'session',
            sequence: 3,
            action: 'start',
            nativeSessionId: 'native-duplicate',
          },
        ]),
      ProviderWrapperSessionProtocolError,
    );
  }

  for (const sessionFrame of [
    {
      schemaVersion: 2,
      type: 'session',
      sequence: 2,
      action: 'start',
      nativeSessionId: 'wrong-native-session',
    },
    {
      schemaVersion: 2,
      type: 'session',
      sequence: 2,
      action: 'resume',
      nativeSessionId: 'native-expected',
    },
  ] as const) {
    const parser = createProviderWrapperSessionProtocolParser({
      binding: engineSuppliedBinding('start', 'native-expected'),
    });
    pushFrames(parser, [hello]);
    assert.throws(
      () => pushFrames(parser, [sessionFrame]),
      ProviderWrapperSessionProtocolError,
    );
  }

  {
    const parser = createProviderWrapperSessionProtocolParser({
      binding: observedStartBinding(),
    });
    pushFrames(parser, [hello]);
    assert.throws(
      () =>
        pushFrames(parser, [
          {
            schemaVersion: 2,
            type: 'result',
            sequence: 2,
            outputSlot: 'primary',
          },
        ]),
      ProviderWrapperSessionProtocolError,
    );
  }

  {
    const parser = createProviderWrapperSessionProtocolParser({
      binding: engineSuppliedBinding('resume', 'native-terminal'),
    });
    pushFrames(parser, [
      hello,
      {
        schemaVersion: 2,
        type: 'session',
        sequence: 2,
        action: 'resume',
        nativeSessionId: 'native-terminal',
      },
      {
        schemaVersion: 2,
        type: 'result',
        sequence: 3,
        outputSlot: 'primary',
      },
    ]);
    assert.throws(
      () =>
        pushFrames(parser, [
          {
            schemaVersion: 2,
            type: 'progress',
            sequence: 4,
            phase: 'finalizing',
          },
        ]),
      ProviderWrapperSessionProtocolError,
    );
  }
});

test('harness-jsonl-v2 rejects forged receipt or raw identity outcomes', () => {
  const binding = observedStartBinding();
  const parser = createProviderWrapperSessionProtocolParser({ binding });
  pushFrames(parser, [
    {
      schemaVersion: 2,
      type: 'hello',
      sequence: 1,
      protocol: 'harness-jsonl-v2',
    },
    {
      schemaVersion: 2,
      type: 'session',
      sequence: 2,
      action: 'start',
      nativeSessionId: 'observed-for-tamper-test',
    },
    {
      schemaVersion: 2,
      type: 'result',
      sequence: 3,
      outputSlot: 'primary',
    },
  ]);
  const outcome = parser.finish({ cancellationForced: false });

  assert.throws(
    () =>
      assertProviderWrapperSessionProtocolReceipt(
        {
          ...outcome.receipt,
          observedNativeSessionIdDigest: 'b'.repeat(64),
        },
        binding,
      ),
    ProviderWrapperSessionProtocolError,
  );
  assert.throws(
    () =>
      assertProviderWrapperSessionProtocolOutcome(
        {
          ...outcome,
          observedNativeSessionId: 'observed-for-tamper-test',
        },
        binding,
      ),
    ProviderWrapperSessionProtocolError,
  );
});

test('harness-jsonl-v2 redacts an observed identity reused in an error and publishes no private handle input', () => {
  const binding = observedStartBinding();
  const nativeSessionId = 'NATIVE_SESSION_SECRET';
  const publicFrames: unknown[] = [];
  const privateIdentities: unknown[] = [];
  const parser = createProviderWrapperSessionProtocolParser({
    binding,
    onFrame(receipt) {
      publicFrames.push(receipt);
    },
    privateNativeSessionIdentitySink(identity) {
      privateIdentities.push(identity);
    },
  });
  pushFrames(parser, [
    {
      schemaVersion: 2,
      type: 'hello',
      sequence: 1,
      protocol: 'harness-jsonl-v2',
    },
    {
      schemaVersion: 2,
      type: 'session',
      sequence: 2,
      action: 'start',
      nativeSessionId,
    },
    {
      schemaVersion: 2,
      type: 'error',
      sequence: 3,
      code: `PROVIDER_${nativeSessionId}_FAILURE`,
    },
  ]);

  const outcome = parser.finish({ cancellationForced: false });
  assert.equal(outcome.receipt.terminal, 'error');
  assert.equal(outcome.receipt.errorCode, 'PROVIDER_ERROR_CODE_REDACTED');
  assert.equal(JSON.stringify(outcome).includes(nativeSessionId), false);
  assert.equal(JSON.stringify(publicFrames).includes(nativeSessionId), false);
  assert.deepEqual(privateIdentities, []);
});
