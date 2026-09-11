import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertChangeId, assertInvestigationId, } from "../../foundation/repository-path/repository-path.js";
import { assertHumanResolutionConsequences, assertHumanResolutionDecision, humanResolutionDecisionSchemaDigest, } from "../investigation/domain/human-resolution-contract.js";
export const HUMAN_RESOLUTION_SIGNATURE_NAMESPACE = 'workflow.human-resolution-grant.v1';
const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const DIGEST = /^[0-9a-f]{64}$/;
const HUMAN_RESOLUTION_PAYLOAD_KEYS = [
    'version',
    'grantId',
    'repositoryId',
    'repositoryOrigin',
    'trustBaseCommit',
    'policyBlob',
    'target',
    'expected',
    'decision',
    'consequences',
    'rationale',
    'issuedAt',
    'expiresAt',
    'maxUses',
    'signer',
];
export function canonicalHumanResolutionGrantPayload(payload) {
    return `${canonicalJson({
        version: payload.version,
        grantId: payload.grantId,
        repositoryId: payload.repositoryId,
        repositoryOrigin: payload.repositoryOrigin,
        trustBaseCommit: payload.trustBaseCommit,
        policyBlob: payload.policyBlob,
        target: payload.target,
        expected: payload.expected,
        decision: payload.decision,
        consequences: payload.consequences,
        rationale: payload.rationale,
        issuedAt: payload.issuedAt,
        expiresAt: payload.expiresAt,
        maxUses: payload.maxUses,
        signer: payload.signer,
    })}\n`;
}
export function canonicalHumanResolutionGrantEnvelope(envelope) {
    const canonicalPayload = JSON.parse(canonicalHumanResolutionGrantPayload(envelope.payload));
    return `${canonicalJson({
        payload: canonicalPayload,
        signature: envelope.signature,
    })}\n`;
}
export function parseHumanResolutionGrantEnvelope(raw) {
    try {
        if (typeof raw !== 'string' || raw.length > 65_536) {
            throw new Error('invalid envelope size');
        }
        const value = JSON.parse(raw);
        if (typeof value !== 'object' ||
            value === null ||
            Array.isArray(value) ||
            !hasExactKeys(value, ['payload', 'signature'])) {
            throw new Error('invalid envelope');
        }
        const candidate = value;
        if (typeof candidate.payload !== 'object' ||
            candidate.payload === null ||
            Array.isArray(candidate.payload) ||
            !hasExactKeys(candidate.payload, HUMAN_RESOLUTION_PAYLOAD_KEYS) ||
            typeof candidate.signature !== 'string') {
            throw new Error('invalid envelope fields');
        }
        const envelope = {
            payload: candidate.payload,
            signature: candidate.signature,
        };
        assertArmoredSshSignature(envelope.signature);
        assertMaintainerGrantId(envelope.payload.grantId);
        if (canonicalHumanResolutionGrantEnvelope(envelope) !== raw) {
            throw new Error('non-canonical envelope');
        }
        return envelope;
    }
    catch (error) {
        if (error &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'MAINTAINER_SIGNATURE_INVALID') {
            throw error;
        }
        throw humanResolutionGrantInvalid('Human resolution grant envelope is invalid.');
    }
}
export function validateHumanResolutionGrantPayload(payload, policy, options) {
    if (typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload) ||
        !hasExactKeys(payload, HUMAN_RESOLUTION_PAYLOAD_KEYS) ||
        payload.version !== 1 ||
        !GRANT_ID.test(payload.grantId) ||
        payload.repositoryId !== policy.repository.id ||
        payload.repositoryOrigin !== policy.repository.origin ||
        !COMMIT_OID.test(payload.trustBaseCommit) ||
        payload.trustBaseCommit !== options.expectedTrustBase ||
        !COMMIT_OID.test(payload.policyBlob) ||
        payload.policyBlob !== options.expectedPolicyBlob ||
        payload.maxUses !== 1 ||
        !validReason(payload.rationale) ||
        !policy.trustedSigners.some(({ identity }) => identity === payload.signer)) {
        throw humanResolutionGrantInvalid('Human resolution grant does not match its trusted binding.');
    }
    let decision;
    let consequences;
    try {
        decision = assertHumanResolutionDecision(payload.decision);
        consequences = assertHumanResolutionConsequences(payload.consequences);
    }
    catch {
        throw humanResolutionGrantInvalid('Human resolution grant carries an invalid decision.');
    }
    if (payload.target.workflowKind !== 'investigation' ||
        payload.target.changeId !== options.state.envelope.changeId ||
        payload.target.workflowId !== options.state.envelope.investigationId ||
        payload.expected.stateDigest !== options.state.currentStateDigest ||
        payload.expected.currentRefDigest !== options.state.currentRefDigest) {
        throw workflowError('HUMAN_RESOLUTION_GRANT_STALE', 'Human resolution grant is not bound to the exact current state.', ExitCode.staleState);
    }
    const blockerBinding = humanResolutionBlockerBinding(options.state);
    if (payload.expected.reasonCode !== blockerBinding.reasonCode ||
        payload.expected.blockedTransition !== blockerBinding.blockedTransition) {
        throw workflowError('HUMAN_RESOLUTION_GRANT_BLOCKER_MISMATCH', 'Human resolution grant names another blocker or transition.', ExitCode.staleState);
    }
    assertResolutionDecisionAvailable(options.state, decision);
    assertResolutionConsequences(decision, consequences);
    const issuedAt = exactTimestamp(payload.issuedAt);
    const expiresAt = exactTimestamp(payload.expiresAt);
    const now = options.now.getTime();
    if (issuedAt === undefined ||
        expiresAt === undefined ||
        issuedAt > expiresAt ||
        expiresAt - issuedAt > policy.maxTtlMinutes * 60_000 ||
        issuedAt > now + 30_000) {
        throw humanResolutionGrantInvalid('Human resolution grant has invalid time bounds.');
    }
    if (!options.allowExpired && expiresAt < now) {
        throw workflowError('HUMAN_RESOLUTION_GRANT_EXPIRED', 'Human resolution grant has expired.', ExitCode.staleState);
    }
}
export function assertHumanResolutionAuditPayload(payload, policy, trustBasePolicy, expectedPolicyBlob) {
    const target = payload.target;
    const expected = payload.expected;
    const pinnedSigner = policy.trustedSigners.find(({ identity }) => identity === payload.signer);
    const trustBaseSigner = trustBasePolicy.trustedSigners.find(({ identity }) => identity === payload.signer);
    if (typeof payload !== 'object' ||
        payload === null ||
        Array.isArray(payload) ||
        !hasExactKeys(payload, HUMAN_RESOLUTION_PAYLOAD_KEYS) ||
        payload.version !== 1 ||
        !GRANT_ID.test(payload.grantId) ||
        payload.repositoryId !== policy.repository.id ||
        payload.repositoryOrigin !== policy.repository.origin ||
        trustBasePolicy.repository.id !== policy.repository.id ||
        trustBasePolicy.repository.origin !== policy.repository.origin ||
        trustBasePolicy.auditTagPrefix !== policy.auditTagPrefix ||
        !COMMIT_OID.test(payload.trustBaseCommit) ||
        !COMMIT_OID.test(payload.policyBlob) ||
        payload.policyBlob !== expectedPolicyBlob ||
        payload.maxUses !== 1 ||
        !validReason(payload.rationale) ||
        !pinnedSigner ||
        !trustBaseSigner ||
        pinnedSigner.publicKey !== trustBaseSigner.publicKey ||
        pinnedSigner.fingerprint !== trustBaseSigner.fingerprint ||
        typeof target !== 'object' ||
        target === null ||
        Array.isArray(target) ||
        !hasExactKeys(target, ['workflowKind', 'changeId', 'workflowId']) ||
        target.workflowKind !== 'investigation' ||
        typeof target.changeId !== 'string' ||
        typeof target.workflowId !== 'string' ||
        typeof expected !== 'object' ||
        expected === null ||
        Array.isArray(expected) ||
        !hasExactKeys(expected, [
            'reasonCode',
            'blockedTransition',
            'stateDigest',
            'currentRefDigest',
        ]) ||
        !validBoundedText(expected.reasonCode, 256) ||
        !validBoundedText(expected.blockedTransition, 256) ||
        typeof expected.stateDigest !== 'string' ||
        !DIGEST.test(expected.stateDigest) ||
        (expected.currentRefDigest !== null &&
            (typeof expected.currentRefDigest !== 'string' ||
                !DIGEST.test(expected.currentRefDigest)))) {
        throw humanResolutionGrantInvalid('Human resolution audit grant does not match its trusted binding.');
    }
    try {
        assertChangeId(target.changeId);
        assertInvestigationId(target.workflowId);
        const consequences = assertHumanResolutionConsequences(payload.consequences);
        const decision = assertHumanResolutionDecision(payload.decision);
        assertResolutionConsequences(decision, consequences);
    }
    catch {
        throw humanResolutionGrantInvalid('Human resolution audit grant carries an invalid decision.');
    }
    const issuedAt = exactTimestamp(payload.issuedAt);
    const expiresAt = exactTimestamp(payload.expiresAt);
    const maximumTtl = Math.min(policy.maxTtlMinutes, trustBasePolicy.maxTtlMinutes) * 60_000;
    if (issuedAt === undefined ||
        expiresAt === undefined ||
        issuedAt > expiresAt ||
        expiresAt - issuedAt > maximumTtl) {
        throw humanResolutionGrantInvalid('Human resolution audit grant has invalid time bounds.');
    }
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
function assertArmoredSshSignature(signature) {
    if (typeof signature !== 'string' ||
        signature.length > 16_384 ||
        signature.includes('\r') ||
        !/^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END SSH SIGNATURE-----\n$/.test(signature)) {
        throw workflowError('MAINTAINER_SIGNATURE_INVALID', 'The maintainer grant SSH signature is invalid.', ExitCode.verification);
    }
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
function validBoundedText(value, maxBytes) {
    return (typeof value === 'string' &&
        value.length > 0 &&
        value.trim() === value &&
        Buffer.byteLength(value, 'utf8') <= maxBytes &&
        ![...value].some((character) => {
            const code = character.codePointAt(0) ?? 0;
            return code <= 31 || (code >= 127 && code <= 159);
        }));
}
export function humanResolutionBlockerBinding(state) {
    const blocker = state.blocker;
    if (blocker === null) {
        return {
            reasonCode: 'HUMAN_ROOT_DECISION_REQUESTED',
            blockedTransition: 'workflow-state',
        };
    }
    if (!('code' in blocker)) {
        return {
            reasonCode: blocker.reasonCode,
            blockedTransition: blocker.blockedTransition,
        };
    }
    return {
        reasonCode: blocker.code,
        blockedTransition: 'workflow-state',
    };
}
export function assertResolutionDecisionAvailable(state, decision) {
    const advertised = state.availableResolutions.find(({ kind }) => kind === decision.kind);
    if (!advertised ||
        advertised.parameterSchemaDigest !==
            humanResolutionDecisionSchemaDigest(decision.kind)) {
        throw humanResolutionGrantInvalid('The selected decision is not executable from the bound state.');
    }
}
export function assertResolutionConsequences(decision, consequences) {
    switch (decision.kind) {
        case 'resume-with-capability':
            if (consequences.continuity !== 'preserved' ||
                consequences.assurance !== 'unchanged' ||
                consequences.claimsWaived.length !== 0) {
                throw humanResolutionGrantInvalid('An additional bounded capability must preserve continuity without changing assurance.');
            }
            return;
        case 'close-input':
            if (consequences.continuity !== 'preserved' ||
                consequences.assurance === 'unchanged' ||
                !consequences.claimsWaived.includes('reviewer-term-incorporation')) {
                throw humanResolutionGrantInvalid('Closing reviewer input must preserve continuity and explicitly downgrade reviewer-term incorporation assurance.');
            }
            return;
        case 'abort':
            if (consequences.continuity === 'preserved' ||
                consequences.assurance !== 'degraded') {
                throw humanResolutionGrantInvalid('Abort must declare non-preserved continuity and degraded assurance.');
            }
            return;
        case 'supersede':
        case 'repair':
            if (consequences.continuity !== 'broken' ||
                consequences.assurance !== 'degraded') {
                throw humanResolutionGrantInvalid('Supersede and repair must declare broken continuity and degraded assurance.');
            }
            return;
        case 'quarantine':
            if (consequences.continuity !== 'not-applicable' ||
                consequences.assurance !== 'degraded') {
                throw humanResolutionGrantInvalid('Quarantine must avoid a continuity claim and declare degraded assurance.');
            }
            return;
        case 'waive-assurance':
            if (consequences.continuity !== 'preserved' ||
                consequences.assurance !== 'human-waived' ||
                !consequences.claimsWaived.includes(decision.claim)) {
                throw humanResolutionGrantInvalid('An assurance waiver must preserve continuity while naming and downgrading the waived claim.');
            }
            return;
    }
}
function hasExactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return (actual.length === expected.length &&
        actual.every((v, i) => v === expected[i]));
}
export function humanResolutionGrantInvalid(message) {
    return workflowError('HUMAN_RESOLUTION_GRANT_INVALID', message, ExitCode.guard);
}
const GRANT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function assertMaintainerGrantId(requestedGrantId) {
    if (typeof requestedGrantId !== 'string' ||
        !GRANT_ID.test(requestedGrantId)) {
        throw invalidGrant('Maintainer grant ID is invalid.');
    }
    return requestedGrantId;
}
function invalidGrant(message) {
    return workflowError('MAINTAINER_GRANT_INVALID', message, ExitCode.guard);
}
