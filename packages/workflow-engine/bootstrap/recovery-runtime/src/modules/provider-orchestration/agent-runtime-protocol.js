/** Compatibility facade for the public agent-runtime protocol package. */
import { assertProviderWrapperProtocolReceipt, } from '@jigwright/agent-runtime/harness-jsonl-v1';
import { assertProviderWrapperSessionProtocolReceipt, } from '@jigwright/agent-runtime/harness-jsonl-v2';
import { assertProviderNativeSessionClaimV1, } from "./provider-native-session.js";
export * from '@jigwright/agent-runtime/harness-jsonl-v1';
export { assertProviderWrapperSessionProtocolReceipt, } from '@jigwright/agent-runtime/harness-jsonl-v2';
export function assertProviderRuntimeProtocolReceipt(value, expectedBinding) {
    const receipt = isRecord(value) &&
        value.kind === 'provider-wrapper-session-protocol-receipt'
        ? assertProviderWrapperSessionProtocolReceipt(value, expectedBinding !== undefined && 'sessionControl' in expectedBinding
            ? expectedBinding
            : undefined)
        : assertProviderWrapperProtocolReceipt(value, expectedBinding === undefined
            ? undefined
            : {
                invocationId: expectedBinding.invocationId,
                requestDigest: expectedBinding.requestDigest,
                attemptId: expectedBinding.attemptId,
            });
    if (expectedBinding !== undefined &&
        (receipt.invocationId !== expectedBinding.invocationId ||
            receipt.requestDigest !== expectedBinding.requestDigest ||
            receipt.attemptId !== expectedBinding.attemptId)) {
        throw new TypeError('Provider runtime protocol receipt is unbound.');
    }
    return receipt;
}
/** Validate one session receipt against the public, digest-only durable claim. */
export function assertProviderRuntimeProtocolReceiptForNativeSessionClaim(value, expectedClaim) {
    const claim = assertProviderNativeSessionClaimV1(expectedClaim);
    const receipt = assertProviderRuntimeProtocolReceipt(value, {
        invocationId: claim.invocationId,
        requestDigest: claim.requestDigest,
        attemptId: claim.attemptId,
    });
    if (receipt.kind !== 'provider-wrapper-session-protocol-receipt' ||
        receipt.sessionAction !== claim.action ||
        receipt.expectedNativeSessionIdDigest !==
            claim.expectedNativeSessionIdDigest ||
        (claim.action === 'start'
            ? receipt.nativeSessionIdentityMode !== 'provider-observed'
            : receipt.nativeSessionIdentityMode !== 'engine-supplied')) {
        throw new TypeError('Provider runtime session receipt is unbound from its durable claim.');
    }
    return receipt;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
