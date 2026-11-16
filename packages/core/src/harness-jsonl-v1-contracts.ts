/** Deterministic harness-jsonl-v1 frame and receipt contracts. Streaming state belongs to agent-runtime. */
import crypto from 'node:crypto';
import { canonicalJson } from './canonical-json.ts';

export const HARNESS_JSONL_V1_CONTRACT_VERSION =
  'jigwright.agent-runtime.harness-jsonl.v1' as const;

const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;

const DIGEST = /^[0-9a-f]{64}$/u;

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

export const HARNESS_JSONL_V1_LIMITS = Object.freeze({
  maxLineBytes: 4_096,
  maxAggregateBytes: 64 * 1_024,
  maxFrameCount: 128,
  cancelGraceMs: 100,
});

export type ProviderWrapperProtocolDeclaration = Readonly<{
  protocol: 'harness-jsonl-v1';
}>;

export type ProviderWrapperProtocolBinding = Readonly<{
  invocationId: string;
  requestDigest: string;
  attemptId: string;
}>;

export type ProviderWrapperHelloFrame = Readonly<{
  schemaVersion: 1;
  type: 'hello';
  sequence: number;
  protocol: 'harness-jsonl-v1';
}>;

export type ProviderWrapperProgressFrame = Readonly<{
  schemaVersion: 1;
  type: 'progress';
  sequence: number;
  phase: 'starting' | 'tool' | 'model' | 'finalizing';
}>;

export type ProviderWrapperResultFrame = Readonly<{
  schemaVersion: 1;
  type: 'result';
  sequence: number;
  outputSlot: 'primary';
}>;

export type ProviderWrapperErrorFrame = Readonly<{
  schemaVersion: 1;
  type: 'error';
  sequence: number;
  code: string;
}>;

export type ProviderWrapperCancelAckFrame = Readonly<{
  schemaVersion: 1;
  type: 'cancel-ack';
  sequence: number;
}>;

export type ProviderWrapperFrame =
  | ProviderWrapperHelloFrame
  | ProviderWrapperProgressFrame
  | ProviderWrapperResultFrame
  | ProviderWrapperErrorFrame
  | ProviderWrapperCancelAckFrame;

export type ProviderWrapperFrameReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'provider-wrapper-frame-receipt';
  protocol: 'harness-jsonl-v1';
  receiptSequence: number;
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  frame: ProviderWrapperFrame;
}>;

export type ProviderWrapperProtocolReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'provider-wrapper-protocol-receipt';
  protocol: 'harness-jsonl-v1';
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  frameCount: number;
  aggregateBytes: number;
  lastSequence: number;
  progressFrameCount: number;
  terminal: 'result' | 'error' | 'cancelled';
  outputSlot: 'primary' | null;
  errorCode: string | null;
  cancellation: Readonly<{
    requested: boolean;
    acknowledged: boolean;
    forced: boolean;
  }>;
  receiptDigest: string;
}>;

export type ProviderWrapperProtocolExecution =
  ProviderWrapperProtocolDeclaration &
    Readonly<{
      binding: ProviderWrapperProtocolBinding;
      onFrame?: (receipt: ProviderWrapperFrameReceipt) => void;
    }>;

export class ProviderWrapperProtocolError extends Error {
  readonly code = 'PROVIDER_WRAPPER_PROTOCOL_INVALID';

  constructor() {
    super('Provider wrapper protocol stream is malformed or out of order.');
    this.name = 'ProviderWrapperProtocolError';
  }
}

export function renderProviderWrapperFrame(
  frame: ProviderWrapperFrame,
): string {
  const admitted = assertProviderWrapperFrame(frame);
  const rendered = `${canonicalJson(admitted)}\n`;
  if (
    Buffer.byteLength(rendered, 'utf8') > HARNESS_JSONL_V1_LIMITS.maxLineBytes
  ) {
    throw new ProviderWrapperProtocolError();
  }
  return rendered;
}

export function assertProviderWrapperProtocolReceipt(
  value: unknown,
  expectedBinding?: ProviderWrapperProtocolBinding,
): ProviderWrapperProtocolReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'protocol',
      'invocationId',
      'requestDigest',
      'attemptId',
      'frameCount',
      'aggregateBytes',
      'lastSequence',
      'progressFrameCount',
      'terminal',
      'outputSlot',
      'errorCode',
      'cancellation',
      'receiptDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-wrapper-protocol-receipt' ||
    value.protocol !== 'harness-jsonl-v1' ||
    !Number.isSafeInteger(value.frameCount) ||
    (value.frameCount as number) < 1 ||
    (value.frameCount as number) > HARNESS_JSONL_V1_LIMITS.maxFrameCount ||
    !Number.isSafeInteger(value.aggregateBytes) ||
    (value.aggregateBytes as number) < 1 ||
    (value.aggregateBytes as number) >
      HARNESS_JSONL_V1_LIMITS.maxAggregateBytes ||
    value.lastSequence !== value.frameCount ||
    !Number.isSafeInteger(value.progressFrameCount) ||
    (value.progressFrameCount as number) < 0 ||
    (value.progressFrameCount as number) > (value.frameCount as number) ||
    !['result', 'error', 'cancelled'].includes(String(value.terminal)) ||
    !isRecord(value.cancellation) ||
    !hasExactKeys(value.cancellation, [
      'requested',
      'acknowledged',
      'forced',
    ]) ||
    typeof value.cancellation.requested !== 'boolean' ||
    typeof value.cancellation.acknowledged !== 'boolean' ||
    typeof value.cancellation.forced !== 'boolean' ||
    (value.cancellation.acknowledged && !value.cancellation.requested) ||
    (value.cancellation.forced && !value.cancellation.requested) ||
    (value.terminal === 'result' &&
      (value.outputSlot !== 'primary' || value.errorCode !== null)) ||
    (value.terminal === 'error' &&
      (value.outputSlot !== null ||
        typeof value.errorCode !== 'string' ||
        !ERROR_CODE.test(value.errorCode))) ||
    (value.terminal === 'cancelled' &&
      (value.outputSlot !== null ||
        value.errorCode !== null ||
        !value.cancellation.requested)) ||
    (value.terminal !== 'cancelled' &&
      (value.cancellation.acknowledged || value.cancellation.forced)) ||
    typeof value.receiptDigest !== 'string' ||
    !DIGEST.test(value.receiptDigest)
  ) {
    throw new ProviderWrapperProtocolError();
  }
  const binding = assertProviderWrapperBinding({
    invocationId: value.invocationId as string,
    requestDigest: value.requestDigest as string,
    attemptId: value.attemptId as string,
  });
  if (
    expectedBinding !== undefined &&
    canonicalJson(binding) !==
      canonicalJson(assertProviderWrapperBinding(expectedBinding))
  ) {
    throw new ProviderWrapperProtocolError();
  }
  const payload = { ...value };
  delete payload.receiptDigest;
  if (sha256(canonicalJson(payload)) !== value.receiptDigest) {
    throw new ProviderWrapperProtocolError();
  }
  return deepFreeze(structuredClone(value) as ProviderWrapperProtocolReceipt);
}

export function assertProviderWrapperBinding(
  value: ProviderWrapperProtocolBinding,
): ProviderWrapperProtocolBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['invocationId', 'requestDigest', 'attemptId']) ||
    typeof value.invocationId !== 'string' ||
    !IDENTIFIER.test(value.invocationId) ||
    typeof value.requestDigest !== 'string' ||
    !DIGEST.test(value.requestDigest) ||
    typeof value.attemptId !== 'string' ||
    !IDENTIFIER.test(value.attemptId)
  ) {
    throw new ProviderWrapperProtocolError();
  }
  return deepFreeze(structuredClone(value));
}

export function assertProviderWrapperFrame(
  value: unknown,
): ProviderWrapperFrame {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1
  ) {
    throw new ProviderWrapperProtocolError();
  }
  if (
    value.type === 'hello' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'protocol']) &&
    value.protocol === 'harness-jsonl-v1'
  ) {
    return deepFreeze(structuredClone(value) as ProviderWrapperHelloFrame);
  }
  if (
    value.type === 'progress' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'phase']) &&
    ['starting', 'tool', 'model', 'finalizing'].includes(String(value.phase))
  ) {
    return deepFreeze(structuredClone(value) as ProviderWrapperProgressFrame);
  }
  if (
    value.type === 'result' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'outputSlot']) &&
    value.outputSlot === 'primary'
  ) {
    return deepFreeze(structuredClone(value) as ProviderWrapperResultFrame);
  }
  if (
    value.type === 'error' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'code']) &&
    typeof value.code === 'string' &&
    ERROR_CODE.test(value.code)
  ) {
    return deepFreeze(structuredClone(value) as ProviderWrapperErrorFrame);
  }
  if (
    value.type === 'cancel-ack' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence'])
  ) {
    return deepFreeze(structuredClone(value) as ProviderWrapperCancelAckFrame);
  }
  throw new ProviderWrapperProtocolError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
