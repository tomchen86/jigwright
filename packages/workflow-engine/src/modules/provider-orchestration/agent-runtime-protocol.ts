/**
 * Validates public provider protocol receipts against engine invocation and
 * native-session bindings.
 *
 * Invariants:
 * - When an expected binding is supplied, invocation, request and attempt
 *   identities must all match.
 */
import {
  assertProviderWrapperProtocolReceipt,
  type ProviderWrapperProtocolBinding,
  type ProviderWrapperProtocolReceipt,
} from '@jigwright/core/harness-jsonl-v1-contracts';
import {
  assertProviderWrapperSessionProtocolReceipt,
  type ProviderWrapperSessionProtocolBinding,
  type ProviderWrapperSessionProtocolReceipt,
} from '@jigwright/core/harness-jsonl-v2-contracts';
import {
  assertProviderNativeSessionClaimV1,
  type ProviderNativeSessionClaimV1,
} from './provider-native-session.ts';

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
export {
  assertProviderWrapperSessionProtocolReceipt,
  type ProviderWrapperSessionProtocolReceipt,
} from '@jigwright/core/harness-jsonl-v2-contracts';

export type ProviderRuntimeProtocolReceipt =
  ProviderWrapperProtocolReceipt | ProviderWrapperSessionProtocolReceipt;

export type ProviderRuntimeProtocolBinding =
  ProviderWrapperProtocolBinding | ProviderWrapperSessionProtocolBinding;

export function assertProviderRuntimeProtocolReceipt(
  value: unknown,
  expectedBinding?: ProviderRuntimeProtocolBinding,
): ProviderRuntimeProtocolReceipt {
  const receipt =
    isRecord(value) &&
    value.kind === 'provider-wrapper-session-protocol-receipt'
      ? assertProviderWrapperSessionProtocolReceipt(
          value,
          expectedBinding !== undefined && 'sessionControl' in expectedBinding
            ? expectedBinding
            : undefined,
        )
      : assertProviderWrapperProtocolReceipt(
          value,
          expectedBinding === undefined
            ? undefined
            : {
                invocationId: expectedBinding.invocationId,
                requestDigest: expectedBinding.requestDigest,
                attemptId: expectedBinding.attemptId,
              },
        );
  if (
    expectedBinding !== undefined &&
    (receipt.invocationId !== expectedBinding.invocationId ||
      receipt.requestDigest !== expectedBinding.requestDigest ||
      receipt.attemptId !== expectedBinding.attemptId)
  ) {
    throw new TypeError('Provider runtime protocol receipt is unbound.');
  }
  return receipt;
}

/** Validate one session receipt against the public, digest-only durable claim. */
export function assertProviderRuntimeProtocolReceiptForNativeSessionClaim(
  value: unknown,
  expectedClaim: ProviderNativeSessionClaimV1,
): ProviderWrapperSessionProtocolReceipt {
  const claim = assertProviderNativeSessionClaimV1(expectedClaim);
  const receipt = assertProviderRuntimeProtocolReceipt(value, {
    invocationId: claim.invocationId,
    requestDigest: claim.requestDigest,
    attemptId: claim.attemptId,
  });
  if (
    receipt.kind !== 'provider-wrapper-session-protocol-receipt' ||
    receipt.sessionAction !== claim.action ||
    receipt.expectedNativeSessionIdDigest !==
      claim.expectedNativeSessionIdDigest ||
    (claim.action === 'start'
      ? receipt.nativeSessionIdentityMode !== 'provider-observed'
      : receipt.nativeSessionIdentityMode !== 'engine-supplied')
  ) {
    throw new TypeError(
      'Provider runtime session receipt is unbound from its durable claim.',
    );
  }
  return receipt;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
