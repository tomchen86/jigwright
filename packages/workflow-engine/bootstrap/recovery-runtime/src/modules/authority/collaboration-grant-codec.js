import { COLLABORATION_GRANT_AUTHORIZED_EFFECT, } from "../provider-orchestration/role-independence.js";
export { COLLABORATION_GRANT_AUTHORIZED_EFFECT, } from "../provider-orchestration/role-independence.js";
/**
 * Encodes and verifies collaboration Grants and direct human review
 * attestations.
 *
 * Invariants:
 * - Every collaboration grant is single-use: validation requires both
 *   payload.maxUses and policy.maxUses to equal 1.
 * - Grant lifetime is capped at min(policy.maxTtlMinutes,
 *   COLLABORATION_GRANT_MAX_TTL_MINUTES=30) minutes between issuedAt and
 *   expiresAt.
 */
import crypto from 'node:crypto';
import { assertTaskId as assertCoreTaskId } from '@jigwright/core/workflow-identifiers';
import { isGrantUseUniquenessError, isCollaborationGrantEnvelopeReaderError, isSignedAttestationEnvelopeReaderError, } from "./grant-errors.js";
import { COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1, COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE as PACKAGE_COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE, } from '@jigwright/core/collaboration-grant-envelope-codec';
import { SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1, } from '@jigwright/core/signed-attestation-envelope-codec';
import { ExitCode, WorkflowError, workflowError, } from "../../foundation/errors/errors.js";
import { assertChangeId } from "../../foundation/repository-path/repository-path.js";
import { isProviderId, } from "../provider-orchestration/provider-registry.js";
export const COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE = PACKAGE_COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE;
export const DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE = 'workflow.direct-human-review.v1';
export const COLLABORATION_GRANT_REPLAY_SCOPE = 'repository-common-dir-local';
export const COLLABORATION_GRANT_RESIDUALS = Object.freeze([
    'GLOBAL_CROSS_CLONE_ONE_USE_NOT_PROVEN',
    'GIT_COMMON_DIR_STATE_IS_COOPERATIVE_NOT_REMOTE_ATTESTED',
    'TRACKED_HISTORY_ONE_USE_REQUIRES_AGGREGATE_VALIDATION',
    'LOCAL_WALL_CLOCK_NOT_EXTERNALLY_ATTESTED',
]);
export const COLLABORATION_GRANT_MAX_TTL_MINUTES = 30;
export const COLLABORATION_GRANT_POLICY = deepFreeze({
    schemaVersion: 1,
    policyId: 'workflow.collaboration-policy.v1',
    permittedForms: {
        'blind-survey': ['same-provider-fresh-session', 'caller-supplied'],
        'plan-review': [
            'same-provider-fresh-session',
            'caller-supplied',
            'direct-human-review',
        ],
        'task-implementation': [
            'same-provider-fresh-session',
            'caller-supplied',
        ],
    },
    trustCriticalDirectHumanRequiredPhases: [],
});
export const COLLABORATION_GRANT_POLICY_DIGEST = crypto
    .createHash('sha256')
    .update(JSON.stringify(COLLABORATION_GRANT_POLICY))
    .digest('hex');
export const TASK_DIFF_REVIEW_COLLABORATION_POLICY = deepFreeze({
    schemaVersion: 1,
    policyId: 'workflow.collaboration-policy.task-diff-review.v1',
    permittedForms: {
        'task-diff-review': [
            'same-provider-fresh-session',
            'caller-supplied',
            'direct-human-review',
        ],
    },
    trustCriticalDirectHumanRequiredPhases: [],
});
export const TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST = crypto
    .createHash('sha256')
    .update(JSON.stringify(TASK_DIFF_REVIEW_COLLABORATION_POLICY))
    .digest('hex');
export const COLLABORATION_GRANT_RETAINED_OBLIGATIONS = Object.freeze([
    'engine-search-floor',
    'typed-term-contributions',
    'effective-union-scan',
    'hit-dispositions',
    'why-ledger',
    'structured-role-content',
    'challenge-dispositions',
    'registered-checks',
    'allowed-paths',
    'freshness',
    'managed-transition-authority',
]);
export function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
        Object.freeze(value);
    }
    return value;
}
export function collaborationSignatureInvalid(cause) {
    return workflowError('COLLABORATION_SIGNATURE_INVALID', 'Collaboration grant SSH signature is invalid.', ExitCode.verification, {
        details: {
            cause: cause instanceof Error ? cause.message : String(cause),
        },
    });
}
function assertTaskId(value) {
    return assertCoreTaskId(value, () => workflowError('INVALID_TASK_ID', `Invalid task ID: ${value}`, ExitCode.usage, { recovery: 'Use a dotted numeric task ID, for example 1.1.' }));
}
export const FULL_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export const DIGEST = /^[0-9a-f]{64}$/;
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@:+/-]{0,127}$/;
const COLLABORATION_GRANT_PAYLOAD_KEYS = [
    'version',
    'signatureNamespace',
    'grantId',
    'repositoryId',
    'repositoryOrigin',
    'policyBlob',
    'collaborationPolicyDigest',
    'changeId',
    'taskId',
    'baselineCommit',
    'baselineTree',
    'targetDigest',
    'lifecyclePhase',
    'rolePair',
    'availableActor',
    'degradedForm',
    'authorizedEffect',
    'reason',
    'issuedAt',
    'expiresAt',
    'maxUses',
    'signer',
];
const DIRECT_HUMAN_PAYLOAD_KEYS = [
    'version',
    'grantId',
    'signedEnvelopeDigest',
    'transitionDigest',
    'targetDigest',
    'reviewNodeId',
    'reviewResultDigest',
    'signedAt',
    'signer',
];
const COLLABORATION_GRANT_PAYLOAD_CODEC = {
    v2PayloadKeys: COLLABORATION_GRANT_PAYLOAD_KEYS,
    parsePayload(value) {
        assertCollaborationPayloadShape(value);
        return value;
    },
    projectPayloadFields: collaborationGrantPayloadFields,
    validateSignature: assertArmoredSignature,
};
const DIRECT_HUMAN_REVIEW_ATTESTATION_CODEC = {
    payloadKeys: DIRECT_HUMAN_PAYLOAD_KEYS,
    parsePayload(value) {
        assertDirectHumanReviewPayload(value);
        return value;
    },
    projectPayloadFields(payload) {
        return {
            grantId: payload.grantId,
            signedEnvelopeDigest: payload.signedEnvelopeDigest,
            transitionDigest: payload.transitionDigest,
            targetDigest: payload.targetDigest,
            reviewNodeId: payload.reviewNodeId,
            reviewResultDigest: payload.reviewResultDigest,
            signedAt: payload.signedAt,
            signer: payload.signer,
        };
    },
    validateSignature: assertArmoredSignature,
};
export function assertCollaborationGrantId(value) {
    if (typeof value !== 'string' || !GRANT_ID.test(value)) {
        throw collaborationInvalid('Collaboration grant ID is invalid.');
    }
    return value;
}
function directHumanReviewSignatureNamespace(attestation) {
    if (attestation.signatureNamespace === DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE) {
        return attestation.signatureNamespace;
    }
    throw directHumanReviewInvalid();
}
export function validateCollaborationGrantPayload(payload, policy, options) {
    assertCollaborationPayloadShape(payload);
    if (payload.repositoryId !== policy.repository.id ||
        payload.repositoryOrigin !== policy.repository.origin ||
        payload.policyBlob !== options.expectedPolicyBlob ||
        !isKnownCollaborationPolicyDigestForPhase(payload.collaborationPolicyDigest, payload.lifecyclePhase) ||
        !policy.trustedSigners.some(({ identity }) => identity === payload.signer) ||
        payload.maxUses !== 1 ||
        policy.maxUses !== 1) {
        throw collaborationBindingMismatch('Collaboration grant does not match trusted repository policy.');
    }
    const issuedAt = exactTimestamp(payload.issuedAt);
    const expiresAt = exactTimestamp(payload.expiresAt);
    const now = exactDate(options.now).getTime();
    if (issuedAt === undefined ||
        expiresAt === undefined ||
        issuedAt > expiresAt ||
        expiresAt - issuedAt >
            Math.min(policy.maxTtlMinutes, COLLABORATION_GRANT_MAX_TTL_MINUTES) *
                60_000 ||
        issuedAt > now + 30_000) {
        throw collaborationInvalid('Collaboration grant has invalid time bounds.');
    }
    if (!options.allowExpired && expiresAt < now) {
        throw workflowError('COLLABORATION_GRANT_EXPIRED', 'Collaboration grant has expired.', ExitCode.staleState);
    }
}
export function bindingFromPayload(payload) {
    return {
        repositoryId: payload.repositoryId,
        repositoryOrigin: payload.repositoryOrigin,
        policyBlob: payload.policyBlob,
        collaborationPolicyDigest: payload.collaborationPolicyDigest,
        changeId: payload.changeId,
        taskId: payload.taskId,
        baselineCommit: payload.baselineCommit,
        baselineTree: payload.baselineTree,
        targetDigest: payload.targetDigest,
        lifecyclePhase: payload.lifecyclePhase,
        rolePair: canonicalRolePair(payload.rolePair),
        availableActor: canonicalAvailableActor(payload.availableActor),
        degradedForm: payload.degradedForm,
        reason: payload.reason,
    };
}
function assertCollaborationPayloadShape(candidate) {
    if (!isPlainRecord(candidate)) {
        throw collaborationInvalid('Collaboration grant payload shape is invalid.');
    }
    const payload = candidate;
    if (!hasExactCollaborationPayloadKeys(payload) ||
        payload.version !== 2 ||
        payload.signatureNamespace !== COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE ||
        typeof payload.grantId !== 'string' ||
        !GRANT_ID.test(payload.grantId) ||
        typeof payload.repositoryId !== 'string' ||
        payload.repositoryId.length === 0 ||
        typeof payload.repositoryOrigin !== 'string' ||
        payload.repositoryOrigin.length === 0 ||
        typeof payload.policyBlob !== 'string' ||
        !FULL_OID.test(payload.policyBlob) ||
        typeof payload.collaborationPolicyDigest !== 'string' ||
        !DIGEST.test(payload.collaborationPolicyDigest) ||
        typeof payload.changeId !== 'string' ||
        (payload.taskId !== null && typeof payload.taskId !== 'string') ||
        typeof payload.baselineCommit !== 'string' ||
        !FULL_OID.test(payload.baselineCommit) ||
        typeof payload.baselineTree !== 'string' ||
        !FULL_OID.test(payload.baselineTree) ||
        payload.baselineCommit.length !== payload.baselineTree.length ||
        typeof payload.targetDigest !== 'string' ||
        !DIGEST.test(payload.targetDigest) ||
        !isCollaborationLifecyclePhase(payload.lifecyclePhase) ||
        !isCollaborationDegradedForm(payload.degradedForm) ||
        payload.authorizedEffect !== COLLABORATION_GRANT_AUTHORIZED_EFFECT ||
        typeof payload.reason !== 'string' ||
        typeof payload.issuedAt !== 'string' ||
        typeof payload.expiresAt !== 'string' ||
        payload.maxUses !== 1 ||
        !validReason(payload.reason) ||
        typeof payload.signer !== 'string' ||
        !IDENTITY.test(payload.signer)) {
        throw collaborationInvalid('Collaboration grant payload shape is invalid.');
    }
    try {
        assertChangeId(payload.changeId);
        if (payload.taskId !== null) {
            assertTaskId(payload.taskId);
        }
    }
    catch {
        throw collaborationInvalid('Collaboration grant change or task binding is invalid.');
    }
    assertRolePhase(payload.lifecyclePhase, payload.rolePair);
    if (!collaborationPermittedForms(payload.lifecyclePhase).includes(payload.degradedForm)) {
        throw collaborationInvalid('Collaboration policy does not permit this degraded form.');
    }
    assertAvailableActor(payload.availableActor, payload.degradedForm, {
        lifecyclePhase: payload.lifecyclePhase,
        signer: payload.signer,
    });
}
export function collaborationPolicyDigestForPhase(phase) {
    return phase === 'task-diff-review'
        ? TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST
        : COLLABORATION_GRANT_POLICY_DIGEST;
}
export function isKnownCollaborationPolicyDigestForPhase(digest, phase) {
    return digest === collaborationPolicyDigestForPhase(phase);
}
function collaborationPermittedForms(phase) {
    return phase === 'task-diff-review'
        ? TASK_DIFF_REVIEW_COLLABORATION_POLICY.permittedForms['task-diff-review']
        : COLLABORATION_GRANT_POLICY.permittedForms[phase];
}
function assertRolePhase(phase, rolePair) {
    if (!isPlainRecord(rolePair) ||
        !hasExactDataKeys(rolePair, ['authorRole', 'conflictingRole'])) {
        throw collaborationInvalid('Collaboration grant role pair is invalid.');
    }
    const valid = (phase === 'blind-survey' &&
        rolePair.authorRole === 'investigation-author' &&
        rolePair.conflictingRole === 'plan-reviewer') ||
        (phase === 'plan-review' &&
            rolePair.authorRole === 'plan-author' &&
            rolePair.conflictingRole === 'plan-reviewer') ||
        (phase === 'task-diff-review' &&
            rolePair.authorRole === 'task-implementer' &&
            rolePair.conflictingRole === 'task-diff-reviewer') ||
        (phase === 'task-implementation' &&
            rolePair.authorRole === 'red-author' &&
            rolePair.conflictingRole === 'task-implementer');
    if (!valid) {
        throw collaborationInvalid('Collaboration grant lifecycle phase and roles do not match.');
    }
}
function assertAvailableActor(actor, form, payload) {
    if (!isPlainRecord(actor)) {
        throw collaborationInvalid('Collaboration grant available actor is invalid.');
    }
    if (form === 'same-provider-fresh-session' &&
        hasExactDataKeys(actor, ['kind', 'providerId', 'assurance']) &&
        actor.kind === 'provider' &&
        isProviderId(actor.providerId) &&
        isActorAssurance(actor.assurance)) {
        return;
    }
    if (form === 'caller-supplied' &&
        hasExactDataKeys(actor, ['kind', 'callerId', 'assurance']) &&
        actor.kind === 'caller' &&
        typeof actor.callerId === 'string' &&
        IDENTITY.test(actor.callerId) &&
        isActorAssurance(actor.assurance)) {
        return;
    }
    if (form === 'direct-human-review' &&
        (payload.lifecyclePhase === 'plan-review' ||
            payload.lifecyclePhase === 'task-diff-review') &&
        hasExactDataKeys(actor, ['kind', 'identity', 'assurance']) &&
        actor.kind === 'direct-human' &&
        actor.identity === payload.signer &&
        actor.assurance === 'maintainer-signed') {
        return;
    }
    throw collaborationInvalid('Collaboration grant degraded form and available actor do not match.');
}
function canonicalRolePair(pair) {
    return {
        authorRole: pair.authorRole,
        conflictingRole: pair.conflictingRole,
    };
}
function canonicalAvailableActor(actor) {
    if (actor.kind === 'provider') {
        return {
            kind: 'provider',
            providerId: actor.providerId,
            assurance: actor.assurance,
        };
    }
    if (actor.kind === 'caller') {
        return {
            kind: 'caller',
            callerId: actor.callerId,
            assurance: actor.assurance,
        };
    }
    return {
        kind: 'direct-human',
        identity: actor.identity,
        assurance: 'maintainer-signed',
    };
}
function collaborationGrantPayloadFields(payload) {
    return {
        grantId: payload.grantId,
        repositoryId: payload.repositoryId,
        repositoryOrigin: payload.repositoryOrigin,
        policyBlob: payload.policyBlob,
        collaborationPolicyDigest: payload.collaborationPolicyDigest,
        changeId: payload.changeId,
        taskId: payload.taskId,
        baselineCommit: payload.baselineCommit,
        baselineTree: payload.baselineTree,
        targetDigest: payload.targetDigest,
        lifecyclePhase: payload.lifecyclePhase,
        rolePair: canonicalRolePair(payload.rolePair),
        availableActor: canonicalAvailableActor(payload.availableActor),
        degradedForm: payload.degradedForm,
        authorizedEffect: payload.authorizedEffect,
        reason: payload.reason,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        maxUses: payload.maxUses,
        signer: payload.signer,
    };
}
export function assertArmoredSignature(signature) {
    if (typeof signature !== 'string' ||
        signature.length > 16_384 ||
        signature.includes('\r') ||
        !/^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END SSH SIGNATURE-----\n$/.test(signature)) {
        throw workflowError('COLLABORATION_SIGNATURE_INVALID', 'Collaboration grant SSH signature is invalid.', ExitCode.verification);
    }
}
function assertDirectHumanReviewPayload(payload) {
    if (!isPlainRecord(payload) ||
        !hasExactDataKeys(payload, DIRECT_HUMAN_PAYLOAD_KEYS) ||
        payload.version !== 1 ||
        !GRANT_ID.test(payload.grantId) ||
        !DIGEST.test(payload.signedEnvelopeDigest) ||
        !DIGEST.test(payload.transitionDigest) ||
        !DIGEST.test(payload.targetDigest) ||
        !DIGEST.test(payload.reviewNodeId) ||
        !DIGEST.test(payload.reviewResultDigest) ||
        exactTimestamp(payload.signedAt) === undefined ||
        !IDENTITY.test(payload.signer)) {
        throw directHumanReviewInvalid();
    }
}
function isActorAssurance(value) {
    return (value === 'self-declared' ||
        value === 'runtime-hint' ||
        value === 'adapter-assigned');
}
function isCollaborationLifecyclePhase(value) {
    return (value === 'blind-survey' ||
        value === 'plan-review' ||
        value === 'task-diff-review' ||
        value === 'task-implementation');
}
function isCollaborationDegradedForm(value) {
    return (value === 'same-provider-fresh-session' ||
        value === 'caller-supplied' ||
        value === 'direct-human-review');
}
function validReason(value) {
    return (typeof value === 'string' &&
        value.length >= 12 &&
        value.length <= 500 &&
        value.trim() === value &&
        ![...value].some((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code <= 31 || (code >= 127 && code <= 159);
        }));
}
function exactTimestamp(value) {
    if (typeof value !== 'string') {
        return undefined;
    }
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString() === value
        ? time
        : undefined;
}
export function exactDate(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        throw collaborationInvalid('Collaboration grant time is invalid.');
    }
    return date;
}
function isPlainRecord(value) {
    if (typeof value !== 'object' ||
        value === null ||
        Array.isArray(value) ||
        Object.getPrototypeOf(value) !== Object.prototype) {
        return false;
    }
    return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) => 'value' in descriptor && descriptor.enumerable === true);
}
function hasExactDataKeys(value, expected) {
    const actual = Object.keys(value).sort();
    const keys = [...expected].sort();
    return (actual.length === keys.length &&
        actual.every((entry, index) => entry === keys[index]));
}
function hasExactCollaborationPayloadKeys(value) {
    return hasExactDataKeys(value, COLLABORATION_GRANT_PAYLOAD_KEYS);
}
export function collaborationInvalid(message) {
    return workflowError('COLLABORATION_GRANT_INVALID', message, ExitCode.guard);
}
export function collaborationBindingMismatch(message) {
    return workflowError('COLLABORATION_GRANT_BINDING_MISMATCH', message, ExitCode.guard);
}
function collaborationReaderInvalid(error, message) {
    return (collaborationReaderSignatureCause(error) ?? collaborationInvalid(message));
}
function collaborationReaderSignatureCause(error) {
    if (error instanceof WorkflowError &&
        (error.code === 'COLLABORATION_SIGNATURE_INVALID' ||
            error.code === 'COLLABORATION_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE')) {
        return error;
    }
    return error instanceof Error && error.cause !== undefined
        ? collaborationReaderSignatureCause(error.cause)
        : null;
}
function directHumanReviewInvalid() {
    return workflowError('DIRECT_HUMAN_REVIEW_INVALID', 'Direct-human review attestation is invalid.', ExitCode.guard);
}
function canonicalExpectedBinding(binding) {
    return JSON.stringify({
        repositoryId: binding.repositoryId,
        repositoryOrigin: binding.repositoryOrigin,
        policyBlob: binding.policyBlob,
        collaborationPolicyDigest: binding.collaborationPolicyDigest,
        changeId: binding.changeId,
        taskId: binding.taskId,
        baselineCommit: binding.baselineCommit,
        baselineTree: binding.baselineTree,
        targetDigest: binding.targetDigest,
        lifecyclePhase: binding.lifecyclePhase,
        rolePair: canonicalRolePair(binding.rolePair),
        availableActor: canonicalAvailableActor(binding.availableActor),
        degradedForm: binding.degradedForm,
        reason: binding.reason,
    });
}
export function createCollaborationGrantCodec(operations) {
    const { canonicalCollaborationGrantEnvelopeBytesV1, canonicalCollaborationGrantPayloadBytesV1, parseCollaborationGrantEnvelopeV1, selectCollaborationGrantSignatureNamespaceV1, readAndVerifyCollaborationGrantEnvelopeV1, canonicalSignedAttestationEnvelopeBytesV1, canonicalSignedAttestationPayloadBytesV1, parseSignedAttestationEnvelopeV1, readAndVerifySignedAttestationEnvelopeV1, assertUniqueGrantUseClaimsV1, } = operations;
    function canonicalCollaborationGrantPayload(payload) {
        try {
            return canonicalCollaborationGrantPayloadBytesV1(payload, COLLABORATION_GRANT_PAYLOAD_CODEC);
        }
        catch (error) {
            throw collaborationReaderInvalid(error, 'Collaboration grant payload version or signature namespace is invalid.');
        }
    }
    function collaborationGrantSignatureNamespace(payload) {
        try {
            return selectCollaborationGrantSignatureNamespaceV1(payload);
        }
        catch (error) {
            throw collaborationReaderInvalid(error, 'Collaboration grant payload version or signature namespace is invalid.');
        }
    }
    function canonicalCollaborationGrantEnvelope(envelope) {
        try {
            return canonicalCollaborationGrantEnvelopeBytesV1(envelope, COLLABORATION_GRANT_PAYLOAD_CODEC);
        }
        catch (error) {
            throw collaborationReaderInvalid(error, 'Collaboration grant envelope is invalid.');
        }
    }
    function collaborationGrantEnvelopeDigest(envelope) {
        return crypto
            .createHash('sha256')
            .update(canonicalCollaborationGrantEnvelope(envelope))
            .digest('hex');
    }
    function canonicalDirectHumanReviewPayload(payload) {
        try {
            return canonicalSignedAttestationPayloadBytesV1(payload, DIRECT_HUMAN_REVIEW_ATTESTATION_CODEC);
        }
        catch (error) {
            const signatureError = collaborationReaderSignatureCause(error);
            if (signatureError)
                throw signatureError;
            throw directHumanReviewInvalid();
        }
    }
    function canonicalDirectHumanReviewAttestation(attestation) {
        try {
            const envelope = canonicalSignedAttestationEnvelopeBytesV1({ payload: attestation.payload, signature: attestation.signature }, DIRECT_HUMAN_REVIEW_ATTESTATION_CODEC);
            const signatureNamespace = directHumanReviewSignatureNamespace(attestation);
            const parsed = JSON.parse(envelope);
            return `${JSON.stringify({
                payload: parsed.payload,
                signatureNamespace,
                signature: parsed.signature,
            })}\n`;
        }
        catch (error) {
            const signatureError = collaborationReaderSignatureCause(error);
            if (signatureError)
                throw signatureError;
            throw directHumanReviewInvalid();
        }
    }
    function directHumanReviewAttestationDigest(attestation) {
        return crypto
            .createHash('sha256')
            .update(canonicalDirectHumanReviewAttestation(attestation))
            .digest('hex');
    }
    function parseDirectHumanReviewAttestation(raw) {
        try {
            const value = JSON.parse(raw);
            if (!isPlainRecord(value) ||
                !hasExactDataKeys(value, [
                    'payload',
                    'signatureNamespace',
                    'signature',
                ]) ||
                value.signatureNamespace !== DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE) {
                throw directHumanReviewInvalid();
            }
            const envelope = parseSignedAttestationEnvelopeV1(`${JSON.stringify({
                payload: value.payload,
                signature: value.signature,
            })}\n`, DIRECT_HUMAN_REVIEW_ATTESTATION_CODEC);
            const current = {
                ...envelope,
                signatureNamespace: DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
            };
            if (canonicalDirectHumanReviewAttestation(current) !== raw) {
                throw directHumanReviewInvalid();
            }
            return current;
        }
        catch (error) {
            const signatureError = collaborationReaderSignatureCause(error);
            if (signatureError)
                throw signatureError;
            throw directHumanReviewInvalid();
        }
    }
    function parseCollaborationGrantEnvelope(raw) {
        try {
            const envelope = parseCollaborationGrantEnvelopeV1(raw, COLLABORATION_GRANT_PAYLOAD_CODEC);
            assertCollaborationGrantId(envelope.payload.grantId);
            return envelope;
        }
        catch (error) {
            const signatureError = collaborationReaderSignatureCause(error);
            if (signatureError) {
                throw signatureError;
            }
            throw collaborationInvalid('Collaboration grant envelope is invalid.');
        }
    }
    /**
     * Reject a grant or signed envelope claimed more than once across a complete
     * subject. Every collaboration grant is issued with `maxUses: 1`, so a repeated
     * identity is a duplicate claim even when each use validated in isolation.
     * Live transitions and CI replay share this rule; neither consults the mutable
     * common-directory reservation store to apply it.
     */
    function assertUniqueCollaborationGrantUses(uses) {
        try {
            assertUniqueGrantUseClaimsV1(uses);
        }
        catch (error) {
            if (!isGrantUseUniquenessError(error))
                throw error;
            if (error.code === 'GRANT_USE_IDENTITY_INVALID') {
                throw workflowError('COLLABORATION_GRANT_USE_INVALID', 'A collaboration grant terminal-use identity is malformed.', ExitCode.verification);
            }
            if (error.code === 'GRANT_USE_IDENTITY_DUPLICATE') {
                throw workflowError('COLLABORATION_GRANT_USE_DUPLICATE', 'A collaboration grant use is claimed more than once in this subject.', ExitCode.staleState);
            }
            throw error;
        }
    }
    function validateDirectHumanReviewAttestation(attestation, options) {
        if (!isPlainRecord(attestation) ||
            !hasExactDataKeys(attestation, [
                'payload',
                'signatureNamespace',
                'signature',
            ]) ||
            !isPlainRecord(attestation.payload) ||
            !hasExactDataKeys(attestation.payload, DIRECT_HUMAN_PAYLOAD_KEYS) ||
            typeof attestation.signature !== 'string') {
            throw directHumanReviewInvalid();
        }
        const signatureNamespace = directHumanReviewSignatureNamespace(attestation);
        try {
            const verified = readAndVerifySignedAttestationEnvelopeV1({
                readerContractVersion: SIGNED_ATTESTATION_ENVELOPE_READER_CONTRACT_VERSION_V1,
                raw: canonicalSignedAttestationEnvelopeBytesV1({
                    payload: attestation.payload,
                    signature: attestation.signature,
                }, DIRECT_HUMAN_REVIEW_ATTESTATION_CODEC),
                codec: DIRECT_HUMAN_REVIEW_ATTESTATION_CODEC,
                signatureNamespace,
                allowedSignatureNamespaces: [DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE],
                validatePayload(parsedPayload) {
                    const grant = validateCollaborationGrantEnvelope(options.grantEnvelope, options.policy, {
                        now: options.now,
                        expected: bindingFromPayload(options.grantEnvelope.payload),
                        verifier: options.verifier,
                        allowExpired: true,
                    });
                    const grantPayload = grant.payload;
                    const signedAt = exactTimestamp(parsedPayload.signedAt);
                    if (grantPayload.degradedForm !== 'direct-human-review' ||
                        grantPayload.availableActor.kind !== 'direct-human' ||
                        parsedPayload.grantId !== grantPayload.grantId ||
                        parsedPayload.signedEnvelopeDigest !==
                            collaborationGrantEnvelopeDigest(grant) ||
                        parsedPayload.transitionDigest !== options.transitionDigest ||
                        parsedPayload.targetDigest !== grantPayload.targetDigest ||
                        parsedPayload.reviewNodeId !== options.reviewNodeId ||
                        parsedPayload.reviewResultDigest !== options.reviewResultDigest ||
                        parsedPayload.signer !== grantPayload.signer ||
                        parsedPayload.signer !== grantPayload.availableActor.identity ||
                        signedAt === undefined ||
                        signedAt < Date.parse(grantPayload.issuedAt) ||
                        signedAt > Date.parse(grantPayload.expiresAt) ||
                        signedAt > exactDate(options.now).getTime() + 30_000) {
                        throw directHumanReviewInvalid();
                    }
                },
                signer: (parsedPayload) => parsedPayload.signer,
                verifier: options.verifier,
            });
            void verified;
            return parseDirectHumanReviewAttestation(canonicalDirectHumanReviewAttestation(attestation));
        }
        catch (error) {
            if (isSignedAttestationEnvelopeReaderError(error)) {
                const signatureError = collaborationReaderSignatureCause(error);
                if (signatureError)
                    throw signatureError;
                if (error.code === 'SIGNED_ATTESTATION_SIGNATURE_INVALID') {
                    throw collaborationSignatureInvalid(error);
                }
                throw directHumanReviewInvalid();
            }
            throw error;
        }
    }
    function validateCollaborationGrantEnvelope(envelope, policy, options) {
        return verifyCollaborationGrantCapability(envelope, policy, options)
            .envelope;
    }
    function verifyCollaborationGrantCapability(envelope, policy, options) {
        if (!isPlainRecord(envelope) ||
            !hasExactDataKeys(envelope, ['payload', 'signature']) ||
            !isPlainRecord(envelope.payload) ||
            !hasExactCollaborationPayloadKeys(envelope.payload) ||
            typeof envelope.signature !== 'string') {
            throw collaborationInvalid('Collaboration grant envelope shape is invalid.');
        }
        if (envelope.payload.version !== 2 ||
            envelope.payload.signatureNamespace !==
                COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE) {
            throw collaborationInvalid('Collaboration grant envelope is invalid.');
        }
        try {
            const verified = readAndVerifyCollaborationGrantEnvelopeV1({
                readerContractVersion: COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
                raw: canonicalCollaborationGrantEnvelope(envelope),
                codec: COLLABORATION_GRANT_PAYLOAD_CODEC,
                validatePayload(payload) {
                    validateCollaborationGrantPayload(payload, policy, {
                        now: options.now,
                        expectedPolicyBlob: options.expected.policyBlob,
                        allowExpired: options.allowExpired,
                    });
                    if (canonicalExpectedBinding(bindingFromPayload(payload)) !==
                        canonicalExpectedBinding(options.expected)) {
                        throw collaborationBindingMismatch('Collaboration grant does not match the exact requested transition.');
                    }
                },
                authorizedEffect: (payload) => payload.authorizedEffect,
                signer: (payload) => payload.signer,
                allowedAuthorizedEffects: [COLLABORATION_GRANT_AUTHORIZED_EFFECT],
                verifier: options.verifier,
            });
            return deepFreeze(verified);
        }
        catch (error) {
            if (error instanceof WorkflowError) {
                throw error;
            }
            const signatureError = collaborationReaderSignatureCause(error);
            if (signatureError) {
                throw signatureError;
            }
            if (isCollaborationGrantEnvelopeReaderError(error)) {
                throw collaborationInvalid('Collaboration grant envelope is invalid.');
            }
            throw collaborationSignatureInvalid(error);
        }
    }
    return {
        canonicalCollaborationGrantPayload,
        collaborationGrantSignatureNamespace,
        canonicalCollaborationGrantEnvelope,
        collaborationGrantEnvelopeDigest,
        canonicalDirectHumanReviewPayload,
        canonicalDirectHumanReviewAttestation,
        directHumanReviewAttestationDigest,
        parseDirectHumanReviewAttestation,
        parseCollaborationGrantEnvelope,
        assertUniqueCollaborationGrantUses,
        validateDirectHumanReviewAttestation,
        validateCollaborationGrantEnvelope,
        verifyCollaborationGrantCapability,
    };
}
