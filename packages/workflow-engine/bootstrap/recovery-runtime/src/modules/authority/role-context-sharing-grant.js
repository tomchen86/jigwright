import crypto from 'node:crypto';
import { ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1, bindingFromRoleContextSharingGrantPayloadV1, canonicalRoleContextSharingGrantEnvelopeV1, executeGrantLifecycleTransitionV1, GRANT_LIFECYCLE_CONTRACT_VERSION_V1, isRoleContextSharingGrantError, verifyRoleContextSharingGrantCapabilityV1, } from "./optional-grants-package.js";
import { ExitCode, WorkflowError, workflowError, } from "../../foundation/errors/errors.js";
import { assertAuthoritativeRoleContextSharingGrantVerifier, } from "./role-context-sharing-grant-verifier-port.js";
import { LEGACY_WORKFLOW_IDENTITIES } from "../compatibility/legacy-workflow-identities.js";
export const ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1 = 'workflow.role-context-sharing-eligibility.v1';
export const ROLE_CONTEXT_SHARING_MAX_TTL_MINUTES = 30;
export const ROLE_CONTEXT_SHARING_POLICY = deepFreeze({
    schemaVersion: 1,
    policyId: 'workflow.role-context-sharing-policy.v1',
    authorizedEffect: 'role-context-sharing-degradation',
    exactRolePairs: [
        'author-builder',
        'author-reviewer',
        'builder-reviewer',
    ],
    maxUses: 1,
    maxTtlMinutes: ROLE_CONTEXT_SHARING_MAX_TTL_MINUTES,
    defaultEligibility: 'deny-unless-explicitly-listed',
    retainedBoundaries: [
        'provider-data-authorization',
        'repository-policy',
        'managed-transition-authority',
    ],
});
export const ROLE_CONTEXT_SHARING_POLICY_DIGEST = crypto
    .createHash('sha256')
    .update(JSON.stringify(ROLE_CONTEXT_SHARING_POLICY))
    .digest('hex');
export const LEGACY_ROLE_CONTEXT_SHARING_POLICY_DIGEST = crypto
    .createHash('sha256')
    .update(JSON.stringify({
    ...ROLE_CONTEXT_SHARING_POLICY,
    policyId: LEGACY_WORKFLOW_IDENTITIES.roleContextSharingPolicy,
}))
    .digest('hex');
export function isKnownRoleContextSharingPolicyDigest(digest) {
    return digest === ROLE_CONTEXT_SHARING_POLICY_DIGEST;
}
/** Inert historical classification; never grants production authority. */
export function isHistoricalRoleContextSharingPolicyDigest(digest) {
    return digest === LEGACY_ROLE_CONTEXT_SHARING_POLICY_DIGEST;
}
export function verifyRoleContextSharingGrantCapability(envelope, policy, options) {
    assertAuthoritativeRoleContextSharingGrantVerifier(options.verifier);
    const verifier = options.verifier;
    verifier.assertCurrent();
    const eligibility = assertEligibilityPort(options.eligibility);
    try {
        return verifyRoleContextSharingGrantCapabilityV1({
            readerContractVersion: ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
            raw: canonicalRoleContextSharingGrantEnvelopeV1(envelope),
            expected: options.expected,
            verifier,
            validatePayload(payload) {
                validateDomainPayload(payload, policy, options, eligibility);
            },
        });
    }
    catch (error) {
        if (error instanceof WorkflowError)
            throw error;
        if (isRoleContextSharingGrantError(error)) {
            if (error.code === 'ROLE_CONTEXT_SHARING_GRANT_BINDING_MISMATCH') {
                throw bindingMismatch();
            }
            if (error.code === 'ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_INVALID') {
                throw workflowError('ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_INVALID', 'Role-context-sharing grant signature is invalid.', ExitCode.guard, { details: errorDetails(error) });
            }
            throw invalidGrant(error);
        }
        throw error;
    }
}
export function executeRoleContextSharingGrantTransitionV1(request, ports) {
    const validation = () => verifyRoleContextSharingGrantCapability(request.envelope, request.policy, request.options);
    return executeGrantLifecycleTransitionV1({
        contractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
        grantId: request.envelope.payload.grantId,
        transitionDigest: request.envelope.payload.targetDigest,
        maxUses: request.envelope.payload.maxUses,
        event: request.event === 'reserve'
            ? {
                kind: 'reserve',
                expiresAt: request.envelope.payload.expiresAt,
                reason: 'Exact role-context-sharing grant reserved',
                expirationReason: 'Role-context-sharing grant expired before reservation',
            }
            : {
                kind: 'consume',
                reason: 'Exact role-context-sharing grant consumed',
            },
        validate: validation,
        ...(request.event === 'consume'
            ? {
                validationFailureReason: 'Role-context-sharing grant failed exact consume validation',
            }
            : {}),
    }, ports);
}
function validateDomainPayload(payload, policy, options, eligibility) {
    if (payload.repositoryId !== policy.repository.id ||
        payload.repositoryOrigin !== policy.repository.origin ||
        payload.policyBlob !== options.expected.policyBlob ||
        !isKnownRoleContextSharingPolicyDigest(payload.roleContextSharingPolicyDigest) ||
        payload.eligibilityPolicyDigest !== eligibility.policyDigest ||
        policy.maxUses !== 1 ||
        payload.maxUses !== 1 ||
        !policy.trustedSigners.some(({ identity }) => identity === payload.signer)) {
        throw bindingMismatch();
    }
    const now = exactDate(options.now);
    const issuedAt = exactTimestamp(payload.issuedAt);
    const expiresAt = exactTimestamp(payload.expiresAt);
    if (issuedAt === undefined ||
        expiresAt === undefined ||
        issuedAt > expiresAt ||
        issuedAt > now.getTime() + 30_000 ||
        expiresAt < now.getTime() ||
        expiresAt - issuedAt >
            Math.min(policy.maxTtlMinutes, ROLE_CONTEXT_SHARING_MAX_TTL_MINUTES) *
                60_000) {
        throw workflowError('ROLE_CONTEXT_SHARING_GRANT_EXPIRED', 'Role-context-sharing grant is expired or has invalid time bounds.', ExitCode.staleState);
    }
    try {
        eligibility.assertEligible(bindingFromRoleContextSharingGrantPayloadV1(payload));
    }
    catch (cause) {
        if (cause instanceof WorkflowError &&
            cause.code === 'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE') {
            throw cause;
        }
        throw ineligible(cause);
    }
}
function assertEligibilityPort(value) {
    if (value?.contractVersion !==
        ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1 ||
        !/^[0-9a-f]{64}$/.test(value.policyDigest) ||
        typeof value.assertEligible !== 'function') {
        throw ineligible();
    }
    return value;
}
function exactDate(value) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
        throw invalidGrant();
    }
    return new Date(value.getTime());
}
function exactTimestamp(value) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) &&
        new Date(timestamp).toISOString() === value
        ? timestamp
        : undefined;
}
function bindingMismatch() {
    return workflowError('ROLE_CONTEXT_SHARING_GRANT_BINDING_MISMATCH', 'Role-context-sharing grant does not match the exact requested authority binding.', ExitCode.guard);
}
function ineligible(cause) {
    return workflowError('ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE', 'Role-context-sharing grant subject is not explicitly eligible.', ExitCode.guard, cause === undefined ? {} : { details: errorDetails(cause) });
}
function invalidGrant(cause) {
    return workflowError('ROLE_CONTEXT_SHARING_GRANT_INVALID', 'Role-context-sharing grant is invalid.', ExitCode.guard, cause === undefined ? {} : { details: errorDetails(cause) });
}
function errorDetails(cause) {
    return {
        cause: cause instanceof Error ? cause.message : String(cause),
    };
}
function deepFreeze(value) {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const nested of Object.values(value))
            deepFreeze(nested);
    }
    return value;
}
