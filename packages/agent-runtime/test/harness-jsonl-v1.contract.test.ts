import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HARNESS_JSONL_V1_CONTRACT_VERSION,
  HARNESS_JSONL_V1_LIMITS,
  ProviderWrapperProtocolError,
  assertProviderWrapperProtocolReceipt,
  createProviderWrapperProtocolParser,
  renderProviderWrapperFrame,
  type ProviderWrapperFrame,
  type ProviderWrapperProtocolBinding,
} from '../src/index.ts';

const binding: ProviderWrapperProtocolBinding = Object.freeze({
  invocationId: 'invocation-agent-runtime-package',
  requestDigest: 'a'.repeat(64),
  attemptId: 'attempt-agent-runtime-package',
});

function pushFrames(
  parser: ReturnType<typeof createProviderWrapperProtocolParser>,
  frames: readonly ProviderWrapperFrame[],
): void {
  parser.push(Buffer.from(frames.map(renderProviderWrapperFrame).join('')));
}

test('public harness-jsonl-v1 contract is versioned and engine-bound', () => {
  assert.equal(
    HARNESS_JSONL_V1_CONTRACT_VERSION,
    'jigwright.agent-runtime.harness-jsonl.v1',
  );
  assert.deepEqual(HARNESS_JSONL_V1_LIMITS, {
    maxLineBytes: 4_096,
    maxAggregateBytes: 65_536,
    maxFrameCount: 128,
    cancelGraceMs: 100,
  });

  const parser = createProviderWrapperProtocolParser({ binding });
  parser.push(
    Buffer.from(
      [
        renderProviderWrapperFrame({
          schemaVersion: 1,
          type: 'hello',
          sequence: 1,
          protocol: 'harness-jsonl-v1',
        }),
        renderProviderWrapperFrame({
          schemaVersion: 1,
          type: 'progress',
          sequence: 2,
          phase: 'model',
        }),
        renderProviderWrapperFrame({
          schemaVersion: 1,
          type: 'result',
          sequence: 3,
          outputSlot: 'primary',
        }),
      ].join(''),
    ),
  );
  const receipt = parser.finish({ cancellationForced: false });

  assert.equal(receipt.invocationId, binding.invocationId);
  assert.equal(receipt.requestDigest, binding.requestDigest);
  assert.equal(receipt.attemptId, binding.attemptId);
  assert.equal(receipt.terminal, 'result');
  assert.deepEqual(
    assertProviderWrapperProtocolReceipt(receipt, binding),
    receipt,
  );
});

test('public protocol parser fails closed on unknown and post-terminal frames', () => {
  const hello = renderProviderWrapperFrame({
    schemaVersion: 1,
    type: 'hello',
    sequence: 1,
    protocol: 'harness-jsonl-v1',
  });
  const result = renderProviderWrapperFrame({
    schemaVersion: 1,
    type: 'result',
    sequence: 2,
    outputSlot: 'primary',
  });

  for (const stream of [
    `${JSON.stringify({ schemaVersion: 1, type: 'unknown', sequence: 1 })}\n`,
    `${hello}${result}${JSON.stringify({ schemaVersion: 1, type: 'progress', sequence: 3, phase: 'tool' })}\n`,
  ]) {
    const parser = createProviderWrapperProtocolParser({ binding });
    assert.throws(
      () => parser.push(Buffer.from(stream)),
      ProviderWrapperProtocolError,
    );
  }
});

test('public protocol parser preserves a natural terminal across cancellation races', () => {
  const hello: ProviderWrapperFrame = {
    schemaVersion: 1,
    type: 'hello',
    sequence: 1,
    protocol: 'harness-jsonl-v1',
  };

  {
    const parser = createProviderWrapperProtocolParser({ binding });
    pushFrames(parser, [
      hello,
      {
        schemaVersion: 1,
        type: 'result',
        sequence: 2,
        outputSlot: 'primary',
      },
    ]);
    assert.equal(parser.requestCancellation(), false);
    const receipt = parser.finish({ cancellationForced: false });
    assert.equal(receipt.terminal, 'result');
    assert.deepEqual(receipt.cancellation, {
      requested: false,
      acknowledged: false,
      forced: false,
    });
    assert.equal(parser.requestCancellation(), false);
  }

  {
    const parser = createProviderWrapperProtocolParser({ binding });
    pushFrames(parser, [hello]);
    assert.equal(parser.requestCancellation(), true);
    pushFrames(parser, [
      {
        schemaVersion: 1,
        type: 'result',
        sequence: 2,
        outputSlot: 'primary',
      },
    ]);
    const receipt = parser.finish({ cancellationForced: false });
    assert.equal(receipt.terminal, 'result');
    assert.deepEqual(receipt.cancellation, {
      requested: true,
      acknowledged: false,
      forced: false,
    });
  }

  {
    const parser = createProviderWrapperProtocolParser({ binding });
    pushFrames(parser, [hello]);
    assert.equal(parser.requestCancellation(), true);
    pushFrames(parser, [
      {
        schemaVersion: 1,
        type: 'error',
        sequence: 2,
        code: 'PROVIDER_FAILED',
      },
    ]);
    const receipt = parser.finish({ cancellationForced: false });
    assert.equal(receipt.terminal, 'error');
    assert.equal(receipt.errorCode, 'PROVIDER_FAILED');
    assert.deepEqual(receipt.cancellation, {
      requested: true,
      acknowledged: false,
      forced: false,
    });
  }
});

test('public protocol parser rejects a natural terminal after acknowledged or forced cancellation', () => {
  const hello: ProviderWrapperFrame = {
    schemaVersion: 1,
    type: 'hello',
    sequence: 1,
    protocol: 'harness-jsonl-v1',
  };

  {
    const parser = createProviderWrapperProtocolParser({ binding });
    pushFrames(parser, [hello]);
    assert.equal(parser.requestCancellation(), true);
    pushFrames(parser, [{ schemaVersion: 1, type: 'cancel-ack', sequence: 2 }]);
    assert.throws(
      () =>
        pushFrames(parser, [
          {
            schemaVersion: 1,
            type: 'result',
            sequence: 3,
            outputSlot: 'primary',
          },
        ]),
      ProviderWrapperProtocolError,
    );
  }

  {
    const parser = createProviderWrapperProtocolParser({ binding });
    pushFrames(parser, [hello]);
    assert.equal(parser.requestCancellation(), true);
    pushFrames(parser, [
      {
        schemaVersion: 1,
        type: 'result',
        sequence: 2,
        outputSlot: 'primary',
      },
    ]);
    assert.throws(
      () => parser.finish({ cancellationForced: true }),
      ProviderWrapperProtocolError,
    );
  }
});
