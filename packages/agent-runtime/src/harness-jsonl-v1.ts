/** Stateful harness-jsonl-v1 stream admission and cancellation. */
import { TextDecoder } from 'node:util';
import { canonicalJson } from '@jigwright/core/canonical-json';
import {
  HARNESS_JSONL_V1_LIMITS,
  type ProviderWrapperProtocolBinding,
  type ProviderWrapperResultFrame,
  type ProviderWrapperErrorFrame,
  type ProviderWrapperFrameReceipt,
  type ProviderWrapperProtocolReceipt,
  ProviderWrapperProtocolError,
  assertProviderWrapperProtocolReceipt,
  assertProviderWrapperBinding,
  assertProviderWrapperFrame,
  sha256,
  deepFreeze,
} from '@jigwright/core/harness-jsonl-v1-contracts';
export {
  HARNESS_JSONL_V1_CONTRACT_VERSION,
  HARNESS_JSONL_V1_LIMITS,
  type ProviderWrapperProtocolDeclaration,
  type ProviderWrapperProtocolBinding,
  type ProviderWrapperHelloFrame,
  type ProviderWrapperProgressFrame,
  type ProviderWrapperResultFrame,
  type ProviderWrapperErrorFrame,
  type ProviderWrapperCancelAckFrame,
  type ProviderWrapperFrame,
  type ProviderWrapperFrameReceipt,
  type ProviderWrapperProtocolReceipt,
  type ProviderWrapperProtocolExecution,
  ProviderWrapperProtocolError,
  renderProviderWrapperFrame,
  assertProviderWrapperProtocolReceipt,
} from '@jigwright/core/harness-jsonl-v1-contracts';

export function createProviderWrapperProtocolParser(input: {
  binding: ProviderWrapperProtocolBinding;
  onFrame?: (receipt: ProviderWrapperFrameReceipt) => void;
}) {
  const binding = assertProviderWrapperBinding(input.binding);
  let pending = Buffer.alloc(0);
  let aggregateBytes = 0;
  let frameCount = 0;
  let progressFrameCount = 0;
  let nextSequence = 1;
  let helloSeen = false;
  let terminalFrame:
    ProviderWrapperResultFrame | ProviderWrapperErrorFrame | null = null;
  let cancellationRequested = false;
  let cancellationAcknowledged = false;
  let finished = false;

  const fail = (): never => {
    throw new ProviderWrapperProtocolError();
  };

  const admit = (candidate: unknown): void => {
    if (finished || terminalFrame !== null) fail();
    const frame = assertProviderWrapperFrame(candidate);
    if (frame.sequence !== nextSequence) fail();
    if (!helloSeen) {
      if (
        frame.type !== 'hello' ||
        frame.sequence !== 1 ||
        frame.protocol !== 'harness-jsonl-v1'
      ) {
        fail();
      }
      helloSeen = true;
    } else if (frame.type === 'hello') {
      fail();
    } else if (frame.type === 'progress') {
      progressFrameCount += 1;
    } else if (frame.type === 'cancel-ack') {
      if (!cancellationRequested || cancellationAcknowledged) fail();
      cancellationAcknowledged = true;
    } else {
      if (cancellationAcknowledged) fail();
      terminalFrame = frame;
    }
    frameCount += 1;
    nextSequence += 1;
    if (frameCount > HARNESS_JSONL_V1_LIMITS.maxFrameCount) fail();
    const receipt = deepFreeze({
      schemaVersion: 1 as const,
      kind: 'provider-wrapper-frame-receipt' as const,
      protocol: 'harness-jsonl-v1' as const,
      receiptSequence: frameCount,
      ...binding,
      frame,
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
      line.length + 1 > HARNESS_JSONL_V1_LIMITS.maxLineBytes ||
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
        aggregateBytes > HARNESS_JSONL_V1_LIMITS.maxAggregateBytes ||
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
      if (pending.length >= HARNESS_JSONL_V1_LIMITS.maxLineBytes) fail();
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
    finish(input: {
      cancellationForced: boolean;
    }): ProviderWrapperProtocolReceipt {
      if (
        finished ||
        pending.length !== 0 ||
        !helloSeen ||
        typeof input.cancellationForced !== 'boolean' ||
        (input.cancellationForced && !cancellationRequested) ||
        (!cancellationRequested && terminalFrame === null) ||
        (terminalFrame !== null &&
          (cancellationAcknowledged || input.cancellationForced))
      ) {
        fail();
      }
      finished = true;
      const terminal =
        terminalFrame === null ? ('cancelled' as const) : terminalFrame.type;
      const payload = {
        schemaVersion: 1 as const,
        kind: 'provider-wrapper-protocol-receipt' as const,
        protocol: 'harness-jsonl-v1' as const,
        ...binding,
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
            ? terminalFrame.code
            : null,
        cancellation: {
          requested: cancellationRequested,
          acknowledged: cancellationAcknowledged,
          forced: input.cancellationForced,
        },
      };
      return assertProviderWrapperProtocolReceipt({
        ...payload,
        receiptDigest: sha256(canonicalJson(payload)),
      });
    },
  });
}
