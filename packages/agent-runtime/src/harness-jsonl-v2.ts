/** Stateful harness-jsonl-v2 stream admission and cancellation. */
import { TextDecoder } from 'node:util';
import { canonicalJson } from '@jigwright/core/canonical-json';
import {
  HARNESS_JSONL_V2_LIMITS,
  type ProviderWrapperSessionProtocolBinding,
  type ProviderWrapperSessionResultFrame,
  type ProviderWrapperSessionErrorFrame,
  type ProviderWrapperSessionProtocolFrame,
  type ProviderWrapperSessionPublicFrame,
  type ProviderWrapperSessionFrameReceipt,
  type ProviderWrapperNativeSessionIdentityObservation,
  type ProviderWrapperSessionProtocolOutcome,
  ProviderWrapperSessionProtocolError,
  providerNativeSessionIdDigest,
  assertProviderWrapperSessionProtocolReceipt,
  assertProviderWrapperSessionProtocolOutcome,
  assertProviderWrapperSessionBinding,
  expectedNativeSessionIdDigest,
  assertProviderWrapperSessionFrame,
  sha256,
  deepFreeze,
} from '@jigwright/core/harness-jsonl-v2-contracts';
export {
  HARNESS_JSONL_V2_CONTRACT_VERSION,
  HARNESS_JSONL_V2_LIMITS,
  type ProviderWrapperSessionProtocolDeclaration,
  type ProviderWrapperSessionControl,
  type ProviderWrapperSessionProtocolBinding,
  type ProviderWrapperSessionHelloFrame,
  type ProviderWrapperSessionProgressFrame,
  type ProviderWrapperNativeSessionFrame,
  type ProviderWrapperSessionResultFrame,
  type ProviderWrapperSessionErrorFrame,
  type ProviderWrapperSessionCancelAckFrame,
  type ProviderWrapperSessionProtocolFrame,
  type ProviderWrapperSessionIdentityDigestFrame,
  type ProviderWrapperSessionPublicFrame,
  type ProviderWrapperSessionFrameReceipt,
  type ProviderWrapperNativeSessionIdentityObservation,
  type ProviderWrapperSessionProtocolReceipt,
  type ProviderWrapperSessionProtocolOutcome,
  type ProviderWrapperSessionProtocolExecution,
  ProviderWrapperSessionProtocolError,
  providerNativeSessionIdDigest,
  renderProviderWrapperSessionFrame,
  assertProviderWrapperSessionProtocolReceipt,
  assertProviderWrapperSessionProtocolOutcome,
} from '@jigwright/core/harness-jsonl-v2-contracts';

const REDACTED_ERROR_CODE = 'PROVIDER_ERROR_CODE_REDACTED';

export function createProviderWrapperSessionProtocolParser(input: {
  binding: ProviderWrapperSessionProtocolBinding;
  onFrame?: (receipt: ProviderWrapperSessionFrameReceipt) => void;
  privateNativeSessionIdentitySink?: (
    identity: ProviderWrapperNativeSessionIdentityObservation,
  ) => void;
}) {
  const binding = assertProviderWrapperSessionBinding(input.binding);
  const expectedIdentityDigest = expectedNativeSessionIdDigest(binding);
  let pending = Buffer.alloc(0);
  let aggregateBytes = 0;
  let frameCount = 0;
  let progressFrameCount = 0;
  let nextSequence = 1;
  let helloSeen = false;
  let observedNativeSessionId: string | null = null;
  let terminalFrame:
    | ProviderWrapperSessionResultFrame
    | ProviderWrapperSessionErrorFrame
    | null = null;
  let cancellationRequested = false;
  let cancellationAcknowledged = false;
  let finished = false;

  const fail = (): never => {
    throw new ProviderWrapperSessionProtocolError();
  };

  const admit = (candidate: unknown): void => {
    if (finished || terminalFrame !== null) fail();
    const frame = assertProviderWrapperSessionFrame(candidate);
    if (frame.sequence !== nextSequence) fail();
    if (!helloSeen) {
      if (
        frame.type !== 'hello' ||
        frame.sequence !== 1 ||
        frame.protocol !== 'harness-jsonl-v2'
      ) {
        fail();
      }
      helloSeen = true;
    } else if (frame.type === 'hello') {
      fail();
    } else if (frame.type === 'session') {
      if (
        observedNativeSessionId !== null ||
        frame.action !== binding.sessionControl.action ||
        (binding.sessionControl.nativeSessionIdentityMode ===
          'engine-supplied' &&
          frame.nativeSessionId !==
            binding.sessionControl.expectedNativeSessionId)
      ) {
        fail();
      }
      observedNativeSessionId = frame.nativeSessionId;
    } else if (frame.type === 'progress') {
      progressFrameCount += 1;
    } else if (frame.type === 'cancel-ack') {
      if (!cancellationRequested || cancellationAcknowledged) fail();
      cancellationAcknowledged = true;
    } else {
      if (cancellationAcknowledged) fail();
      if (frame.type === 'result' && observedNativeSessionId === null) fail();
      terminalFrame = frame;
    }
    frameCount += 1;
    nextSequence += 1;
    if (frameCount > HARNESS_JSONL_V2_LIMITS.maxFrameCount) fail();
    const receipt = deepFreeze({
      schemaVersion: 2 as const,
      kind: 'provider-wrapper-session-frame-receipt' as const,
      protocol: 'harness-jsonl-v2' as const,
      receiptSequence: frameCount,
      invocationId: binding.invocationId,
      requestDigest: binding.requestDigest,
      attemptId: binding.attemptId,
      sessionAction: binding.sessionControl.action,
      nativeSessionIdentityMode:
        binding.sessionControl.nativeSessionIdentityMode,
      expectedNativeSessionIdDigest: expectedIdentityDigest,
      frame: publicFrame(frame, observedNativeSessionId),
    });
    try {
      input.onFrame?.(receipt);
    } catch {
      // Observation callbacks never gain parser or process-control authority.
    }
  };

  const parseLine = (line: Buffer): void => {
    if (
      line.length === 0 ||
      line.length + 1 > HARNESS_JSONL_V2_LIMITS.maxLineBytes ||
      line.at(-1) === 0x0d
    ) {
      fail();
    }
    let document = '';
    try {
      document = new TextDecoder('utf-8', { fatal: true }).decode(line);
    } catch {
      fail();
    }
    let candidate: unknown;
    try {
      candidate = JSON.parse(document) as unknown;
    } catch {
      fail();
    }
    admit(candidate);
  };

  return Object.freeze({
    push(chunk: Buffer): void {
      if (finished || !Buffer.isBuffer(chunk) || chunk.length === 0) fail();
      aggregateBytes += chunk.length;
      if (
        aggregateBytes > HARNESS_JSONL_V2_LIMITS.maxAggregateBytes ||
        !Number.isSafeInteger(aggregateBytes)
      ) {
        fail();
      }
      pending = Buffer.concat([pending, chunk]);
      let newline = pending.indexOf(0x0a);
      while (newline >= 0) {
        parseLine(pending.subarray(0, newline));
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(0x0a);
      }
      if (pending.length >= HARNESS_JSONL_V2_LIMITS.maxLineBytes) fail();
    },
    requestCancellation(): boolean {
      if (finished || terminalFrame !== null || cancellationRequested) {
        return false;
      }
      cancellationRequested = true;
      return true;
    },
    hasNaturalTerminal(): boolean {
      return terminalFrame !== null;
    },
    finish(completion: {
      cancellationForced: boolean;
    }): ProviderWrapperSessionProtocolOutcome {
      if (
        finished ||
        pending.length !== 0 ||
        !helloSeen ||
        typeof completion.cancellationForced !== 'boolean' ||
        (completion.cancellationForced && !cancellationRequested) ||
        (!cancellationRequested && terminalFrame === null) ||
        (terminalFrame !== null &&
          (cancellationAcknowledged || completion.cancellationForced))
      ) {
        fail();
      }
      finished = true;
      const terminal =
        terminalFrame === null ? ('cancelled' as const) : terminalFrame.type;
      const receiptPayload = {
        schemaVersion: 2 as const,
        kind: 'provider-wrapper-session-protocol-receipt' as const,
        protocol: 'harness-jsonl-v2' as const,
        invocationId: binding.invocationId,
        requestDigest: binding.requestDigest,
        attemptId: binding.attemptId,
        sessionAction: binding.sessionControl.action,
        nativeSessionIdentityMode:
          binding.sessionControl.nativeSessionIdentityMode,
        expectedNativeSessionIdDigest: expectedIdentityDigest,
        observedNativeSessionIdDigest:
          observedNativeSessionId === null
            ? null
            : providerNativeSessionIdDigest(observedNativeSessionId),
        sessionFrameCount:
          observedNativeSessionId === null ? (0 as const) : (1 as const),
        frameCount,
        aggregateBytes,
        lastSequence: nextSequence - 1,
        progressFrameCount,
        terminal,
        outputSlot:
          terminal === 'result' && terminalFrame?.type === 'result'
            ? terminalFrame.outputSlot
            : null,
        errorCode:
          terminal === 'error' && terminalFrame?.type === 'error'
            ? publicErrorCode(terminalFrame.code, observedNativeSessionId)
            : null,
        cancellation: {
          requested: cancellationRequested,
          acknowledged: cancellationAcknowledged,
          forced: completion.cancellationForced,
        },
      };
      const receipt = assertProviderWrapperSessionProtocolReceipt(
        {
          ...receiptPayload,
          receiptDigest: sha256(canonicalJson(receiptPayload)),
        },
        binding,
      );
      const outcome = assertProviderWrapperSessionProtocolOutcome(
        {
          schemaVersion: 2,
          kind: 'provider-wrapper-session-protocol-outcome',
          receipt,
        },
        binding,
      );
      if (observedNativeSessionId !== null && receipt.terminal === 'result') {
        const identity = deepFreeze({
          schemaVersion: 2 as const,
          kind: 'provider-wrapper-native-session-identity-observation' as const,
          protocol: 'harness-jsonl-v2' as const,
          invocationId: binding.invocationId,
          requestDigest: binding.requestDigest,
          attemptId: binding.attemptId,
          sessionAction: binding.sessionControl.action,
          nativeSessionId: observedNativeSessionId,
          nativeSessionIdDigest: providerNativeSessionIdDigest(
            observedNativeSessionId,
          ),
          protocolReceiptDigest: receipt.receiptDigest,
        });
        try {
          input.privateNativeSessionIdentitySink?.(identity);
        } catch {
          fail();
        }
      }
      return outcome;
    },
  });
}

function publicFrame(
  frame: ProviderWrapperSessionProtocolFrame,
  observedNativeSessionId: string | null,
): ProviderWrapperSessionPublicFrame {
  if (frame.type === 'session') {
    return deepFreeze({
      schemaVersion: 2 as const,
      type: 'session' as const,
      sequence: frame.sequence,
      action: frame.action,
      nativeSessionIdDigest: providerNativeSessionIdDigest(
        frame.nativeSessionId,
      ),
    });
  }
  if (frame.type === 'error') {
    const code = publicErrorCode(frame.code, observedNativeSessionId);
    return code === frame.code ? frame : deepFreeze({ ...frame, code });
  }
  return frame;
}

function publicErrorCode(
  code: string,
  observedNativeSessionId: string | null,
): string {
  return observedNativeSessionId !== null &&
    code.includes(observedNativeSessionId)
    ? REDACTED_ERROR_CODE
    : code;
}
