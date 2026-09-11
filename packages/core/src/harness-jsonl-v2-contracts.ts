/** Deterministic harness-jsonl-v2 frame and receipt contracts. Streaming state belongs to agent-runtime. */
import crypto from 'node:crypto';
import { canonicalJson } from './canonical-json.ts';

export const HARNESS_JSONL_V2_CONTRACT_VERSION =
  'jigwright.agent-runtime.harness-jsonl.v2' as const;

const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,255}$/u;

const NATIVE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;

const DIGEST = /^[0-9a-f]{64}$/u;

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

export const HARNESS_JSONL_V2_LIMITS = Object.freeze({
  maxLineBytes: 4_096,
  maxAggregateBytes: 64 * 1_024,
  maxFrameCount: 128,
  cancelGraceMs: 100,
});

export type ProviderWrapperSessionProtocolDeclaration = Readonly<{
  protocol: 'harness-jsonl-v2';
}>;

export type ProviderWrapperSessionControl =
  | Readonly<{
      action: 'start' | 'resume';
      nativeSessionIdentityMode: 'engine-supplied';
      expectedNativeSessionId: string;
    }>
  | Readonly<{
      action: 'start';
      nativeSessionIdentityMode: 'provider-observed';
      expectedNativeSessionId: null;
    }>;

export type ProviderWrapperSessionProtocolBinding = Readonly<{
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  sessionControl: ProviderWrapperSessionControl;
}>;

export type ProviderWrapperSessionHelloFrame = Readonly<{
  schemaVersion: 2;
  type: 'hello';
  sequence: number;
  protocol: 'harness-jsonl-v2';
}>;

export type ProviderWrapperSessionProgressFrame = Readonly<{
  schemaVersion: 2;
  type: 'progress';
  sequence: number;
  phase: 'starting' | 'tool' | 'model' | 'finalizing';
}>;

export type ProviderWrapperNativeSessionFrame = Readonly<{
  schemaVersion: 2;
  type: 'session';
  sequence: number;
  action: 'start' | 'resume';
  nativeSessionId: string;
}>;

export type ProviderWrapperSessionResultFrame = Readonly<{
  schemaVersion: 2;
  type: 'result';
  sequence: number;
  outputSlot: 'primary';
}>;

export type ProviderWrapperSessionErrorFrame = Readonly<{
  schemaVersion: 2;
  type: 'error';
  sequence: number;
  code: string;
}>;

export type ProviderWrapperSessionCancelAckFrame = Readonly<{
  schemaVersion: 2;
  type: 'cancel-ack';
  sequence: number;
}>;

export type ProviderWrapperSessionProtocolFrame =
  | ProviderWrapperSessionHelloFrame
  | ProviderWrapperSessionProgressFrame
  | ProviderWrapperNativeSessionFrame
  | ProviderWrapperSessionResultFrame
  | ProviderWrapperSessionErrorFrame
  | ProviderWrapperSessionCancelAckFrame;

export type ProviderWrapperSessionIdentityDigestFrame = Readonly<{
  schemaVersion: 2;
  type: 'session';
  sequence: number;
  action: 'start' | 'resume';
  nativeSessionIdDigest: string;
}>;

export type ProviderWrapperSessionPublicFrame =
  | Exclude<
      ProviderWrapperSessionProtocolFrame,
      ProviderWrapperNativeSessionFrame
    >
  | ProviderWrapperSessionIdentityDigestFrame;

export type ProviderWrapperSessionFrameReceipt = Readonly<{
  schemaVersion: 2;
  kind: 'provider-wrapper-session-frame-receipt';
  protocol: 'harness-jsonl-v2';
  receiptSequence: number;
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  sessionAction: 'start' | 'resume';
  nativeSessionIdentityMode: 'engine-supplied' | 'provider-observed';
  expectedNativeSessionIdDigest: string | null;
  frame: ProviderWrapperSessionPublicFrame;
}>;

/**
 * The sole raw-identity handoff from the V2 parser. Supplying the sink is an
 * explicit capability intended only for trusted private runtime persistence.
 */
export type ProviderWrapperNativeSessionIdentityObservation = Readonly<{
  schemaVersion: 2;
  kind: 'provider-wrapper-native-session-identity-observation';
  protocol: 'harness-jsonl-v2';
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  sessionAction: 'start' | 'resume';
  nativeSessionId: string;
  nativeSessionIdDigest: string;
  protocolReceiptDigest: string;
}>;

export type ProviderWrapperSessionProtocolReceipt = Readonly<{
  schemaVersion: 2;
  kind: 'provider-wrapper-session-protocol-receipt';
  protocol: 'harness-jsonl-v2';
  invocationId: string;
  requestDigest: string;
  attemptId: string;
  sessionAction: 'start' | 'resume';
  nativeSessionIdentityMode: 'engine-supplied' | 'provider-observed';
  expectedNativeSessionIdDigest: string | null;
  observedNativeSessionIdDigest: string | null;
  sessionFrameCount: 0 | 1;
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

export type ProviderWrapperSessionProtocolOutcome = Readonly<{
  schemaVersion: 2;
  kind: 'provider-wrapper-session-protocol-outcome';
  receipt: ProviderWrapperSessionProtocolReceipt;
}>;

export type ProviderWrapperSessionProtocolExecution =
  ProviderWrapperSessionProtocolDeclaration &
    Readonly<{
      binding: ProviderWrapperSessionProtocolBinding;
      onFrame?: (receipt: ProviderWrapperSessionFrameReceipt) => void;
      privateNativeSessionIdentitySink?: (
        identity: ProviderWrapperNativeSessionIdentityObservation,
      ) => void;
    }>;

export class ProviderWrapperSessionProtocolError extends Error {
  readonly code = 'PROVIDER_WRAPPER_SESSION_PROTOCOL_INVALID';

  constructor() {
    super(
      'Provider wrapper session protocol stream is malformed, unbound, or out of order.',
    );
    this.name = 'ProviderWrapperSessionProtocolError';
  }
}

export function providerNativeSessionIdDigest(nativeSessionId: string): string {
  if (!isNativeSessionId(nativeSessionId)) {
    throw new ProviderWrapperSessionProtocolError();
  }
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'provider-native-session-identity',
      nativeSessionId,
    }),
  );
}

export function renderProviderWrapperSessionFrame(
  frame: ProviderWrapperSessionProtocolFrame,
): string {
  const admitted = assertProviderWrapperSessionFrame(frame);
  const rendered = `${canonicalJson(admitted)}\n`;
  if (
    Buffer.byteLength(rendered, 'utf8') > HARNESS_JSONL_V2_LIMITS.maxLineBytes
  ) {
    throw new ProviderWrapperSessionProtocolError();
  }
  return rendered;
}

export function assertProviderWrapperSessionProtocolReceipt(
  value: unknown,
  expectedBinding?: ProviderWrapperSessionProtocolBinding,
): ProviderWrapperSessionProtocolReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'protocol',
      'invocationId',
      'requestDigest',
      'attemptId',
      'sessionAction',
      'nativeSessionIdentityMode',
      'expectedNativeSessionIdDigest',
      'observedNativeSessionIdDigest',
      'sessionFrameCount',
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
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-wrapper-session-protocol-receipt' ||
    value.protocol !== 'harness-jsonl-v2' ||
    !isBindingIdentifier(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isBindingIdentifier(value.attemptId) ||
    !['start', 'resume'].includes(String(value.sessionAction)) ||
    !['engine-supplied', 'provider-observed'].includes(
      String(value.nativeSessionIdentityMode),
    ) ||
    !isReceiptSessionIdentity(value) ||
    !Number.isSafeInteger(value.sessionFrameCount) ||
    ![0, 1].includes(value.sessionFrameCount as number) ||
    ((value.sessionFrameCount as number) === 0) !==
      (value.observedNativeSessionIdDigest === null) ||
    (value.observedNativeSessionIdDigest !== null &&
      !isDigest(value.observedNativeSessionIdDigest)) ||
    !Number.isSafeInteger(value.frameCount) ||
    (value.frameCount as number) < 1 ||
    (value.frameCount as number) > HARNESS_JSONL_V2_LIMITS.maxFrameCount ||
    !Number.isSafeInteger(value.aggregateBytes) ||
    (value.aggregateBytes as number) < 1 ||
    (value.aggregateBytes as number) >
      HARNESS_JSONL_V2_LIMITS.maxAggregateBytes ||
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
      (value.outputSlot !== 'primary' ||
        value.errorCode !== null ||
        value.sessionFrameCount !== 1)) ||
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
    throw new ProviderWrapperSessionProtocolError();
  }
  if (
    value.nativeSessionIdentityMode === 'engine-supplied' &&
    value.observedNativeSessionIdDigest !== null &&
    value.observedNativeSessionIdDigest !== value.expectedNativeSessionIdDigest
  ) {
    throw new ProviderWrapperSessionProtocolError();
  }
  if (expectedBinding !== undefined) {
    const binding = assertProviderWrapperSessionBinding(expectedBinding);
    const expectedIdentityDigest = expectedNativeSessionIdDigest(binding);
    if (
      value.invocationId !== binding.invocationId ||
      value.requestDigest !== binding.requestDigest ||
      value.attemptId !== binding.attemptId ||
      value.sessionAction !== binding.sessionControl.action ||
      value.nativeSessionIdentityMode !==
        binding.sessionControl.nativeSessionIdentityMode ||
      value.expectedNativeSessionIdDigest !== expectedIdentityDigest
    ) {
      throw new ProviderWrapperSessionProtocolError();
    }
  }
  const payload = { ...value };
  delete payload.receiptDigest;
  if (sha256(canonicalJson(payload)) !== value.receiptDigest) {
    throw new ProviderWrapperSessionProtocolError();
  }
  return deepFreeze(
    structuredClone(value) as ProviderWrapperSessionProtocolReceipt,
  );
}

export function assertProviderWrapperSessionProtocolOutcome(
  value: unknown,
  expectedBinding?: ProviderWrapperSessionProtocolBinding,
): ProviderWrapperSessionProtocolOutcome {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'kind', 'receipt']) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'provider-wrapper-session-protocol-outcome'
  ) {
    throw new ProviderWrapperSessionProtocolError();
  }
  const receipt = assertProviderWrapperSessionProtocolReceipt(
    value.receipt,
    expectedBinding,
  );
  return deepFreeze({
    schemaVersion: 2 as const,
    kind: 'provider-wrapper-session-protocol-outcome' as const,
    receipt,
  });
}

export function assertProviderWrapperSessionBinding(
  value: ProviderWrapperSessionProtocolBinding,
): ProviderWrapperSessionProtocolBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'invocationId',
      'requestDigest',
      'attemptId',
      'sessionControl',
    ]) ||
    !isBindingIdentifier(value.invocationId) ||
    !isDigest(value.requestDigest) ||
    !isBindingIdentifier(value.attemptId) ||
    !isRecord(value.sessionControl) ||
    !hasExactKeys(value.sessionControl, [
      'action',
      'nativeSessionIdentityMode',
      'expectedNativeSessionId',
    ]) ||
    !['start', 'resume'].includes(String(value.sessionControl.action)) ||
    !['engine-supplied', 'provider-observed'].includes(
      String(value.sessionControl.nativeSessionIdentityMode),
    ) ||
    (value.sessionControl.nativeSessionIdentityMode === 'engine-supplied' &&
      !isNativeSessionId(value.sessionControl.expectedNativeSessionId)) ||
    (value.sessionControl.nativeSessionIdentityMode === 'provider-observed' &&
      (value.sessionControl.action !== 'start' ||
        value.sessionControl.expectedNativeSessionId !== null))
  ) {
    throw new ProviderWrapperSessionProtocolError();
  }
  return deepFreeze(structuredClone(value));
}

export function expectedNativeSessionIdDigest(
  binding: ProviderWrapperSessionProtocolBinding,
): string | null {
  return binding.sessionControl.nativeSessionIdentityMode === 'engine-supplied'
    ? providerNativeSessionIdDigest(
        binding.sessionControl.expectedNativeSessionId,
      )
    : null;
}

export function assertProviderWrapperSessionFrame(
  value: unknown,
): ProviderWrapperSessionProtocolFrame {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 2 ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1
  ) {
    throw new ProviderWrapperSessionProtocolError();
  }
  if (
    value.type === 'hello' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'protocol']) &&
    value.protocol === 'harness-jsonl-v2'
  ) {
    return deepFreeze(
      structuredClone(value) as ProviderWrapperSessionHelloFrame,
    );
  }
  if (
    value.type === 'progress' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'phase']) &&
    ['starting', 'tool', 'model', 'finalizing'].includes(String(value.phase))
  ) {
    return deepFreeze(
      structuredClone(value) as ProviderWrapperSessionProgressFrame,
    );
  }
  if (
    value.type === 'session' &&
    hasExactKeys(value, [
      'schemaVersion',
      'type',
      'sequence',
      'action',
      'nativeSessionId',
    ]) &&
    ['start', 'resume'].includes(String(value.action)) &&
    isNativeSessionId(value.nativeSessionId)
  ) {
    return deepFreeze(
      structuredClone(value) as ProviderWrapperNativeSessionFrame,
    );
  }
  if (
    value.type === 'result' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'outputSlot']) &&
    value.outputSlot === 'primary'
  ) {
    return deepFreeze(
      structuredClone(value) as ProviderWrapperSessionResultFrame,
    );
  }
  if (
    value.type === 'error' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence', 'code']) &&
    typeof value.code === 'string' &&
    ERROR_CODE.test(value.code)
  ) {
    return deepFreeze(
      structuredClone(value) as ProviderWrapperSessionErrorFrame,
    );
  }
  if (
    value.type === 'cancel-ack' &&
    hasExactKeys(value, ['schemaVersion', 'type', 'sequence'])
  ) {
    return deepFreeze(
      structuredClone(value) as ProviderWrapperSessionCancelAckFrame,
    );
  }
  throw new ProviderWrapperSessionProtocolError();
}

function isReceiptSessionIdentity(value: Record<string, unknown>): boolean {
  if (value.nativeSessionIdentityMode === 'provider-observed') {
    return (
      value.sessionAction === 'start' &&
      value.expectedNativeSessionIdDigest === null
    );
  }
  return (
    value.nativeSessionIdentityMode === 'engine-supplied' &&
    isDigest(value.expectedNativeSessionIdDigest)
  );
}

function isBindingIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function isNativeSessionId(value: unknown): value is string {
  return typeof value === 'string' && NATIVE_SESSION_ID.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
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
