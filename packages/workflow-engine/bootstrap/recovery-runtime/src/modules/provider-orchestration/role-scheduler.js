import crypto from 'node:crypto';
import { bindingFromRoleContextSharingGrantPayloadV1, canonicalRoleContextSharingGrantEnvelopeV1, } from "../authority/optional-grants-package.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { COLLABORATION_GRANT_AUTHORIZED_EFFECT, canonicalCollaborationGrantEnvelope, directHumanReviewAttestationDigest, parseCollaborationGrantEnvelope, validateDirectHumanReviewAttestation, } from "../authority/collaboration-grant.js";
import { consumedCollaborationGrantUseForReplay, validateCollaborationGrantUseProjection, } from "../../runtime/storage-journal/collaboration-grant-store.js";
import { computeRoleContextSharingResultAdmissionDigestV1, consumedRoleContextSharingUseForReplay, } from "../authority/role-context-sharing-consumed-replay.js";
import { isProviderId, requireProviderCapability, } from "./provider-registry.js";
const ADMITTED_ROLE_RESULT_COMMON_KEYS = [
    'schemaVersion',
    'form',
    'role',
    'targetDigest',
    'assignment',
    'author',
    'participant',
    'orchestration',
    'requiredIndependence',
    'achievedIndependence',
    'content',
    'providerInvocation',
    'grantUse',
    'directHumanReviewAttestation',
    'resultDigest',
];
/**
 * Re-admit the exact immutable role-result record before any consumer uses its
 * author, participant, or orchestration facts. Grant-backed v1 results still
 * require their normal external consumed-use replay at the authority boundary;
 * this content-pure reader prevents an embedded record from changing facts
 * while retaining the digest minted by that replay.
 */
export function assertAdmittedRoleResultRecord(value) {
    if (!value || typeof value !== 'object') {
        throw roleResultInvalid();
    }
    const schemaVersion = Reflect.get(value, 'schemaVersion');
    const expectedKeys = schemaVersion === 2
        ? [...ADMITTED_ROLE_RESULT_COMMON_KEYS, 'roleContextSharingUse']
        : ADMITTED_ROLE_RESULT_COMMON_KEYS;
    if ((schemaVersion !== 1 && schemaVersion !== 2) ||
        !hasExactKeys(value, expectedKeys)) {
        throw roleResultInvalid();
    }
    const record = structuredClone(value);
    const { resultDigest, ...semantic } = record;
    const expectedDigest = crypto
        .createHash('sha256')
        .update(canonicalJson({
        schema: `admitted-role-result.v${schemaVersion}`,
        ...semantic,
    }))
        .digest('hex');
    if (!/^[0-9a-f]{64}$/.test(resultDigest) ||
        resultDigest !== expectedDigest ||
        !/^[0-9a-f]{64}$/.test(record.targetDigest) ||
        (record.requiredIndependence !== 'provider-independent' &&
            record.requiredIndependence !== 'session-independent') ||
        !record.assignment ||
        typeof record.assignment !== 'object' ||
        record.assignment.role !== record.role ||
        record.assignment.targetDigest !== record.targetDigest ||
        canonicalJson(normalizeRecordedParticipant(record.author)) !==
            canonicalJson(record.author) ||
        canonicalJson(normalizeRecordedParticipant(record.participant)) !==
            canonicalJson(record.participant) ||
        canonicalJson(assertRoleContentAdmission(record.content)) !==
            canonicalJson(record.content)) {
        throw roleResultInvalid();
    }
    if (schemaVersion === 2) {
        if (record.form !== 'granted-role-context-sharing') {
            throw roleResultInvalid();
        }
        const replayed = admitRoleContextSharingResult({
            assignment: record.assignment,
            author: record.author,
            participant: record.participant,
            content: record.content,
            providerInvocation: record.providerInvocation,
            consumedUse: record.roleContextSharingUse,
        });
        if (canonicalJson(replayed) !== canonicalJson(record)) {
            throw roleResultInvalid();
        }
        return replayed;
    }
    if (record.form === 'ordinary-provider') {
        const replayed = admitRoleResult({
            assignment: record.assignment,
            author: record.author,
            participant: record.participant,
            content: record.content,
            providerInvocation: record.providerInvocation,
            grantUse: null,
            grantValidation: null,
        });
        if (canonicalJson(replayed) !== canonicalJson(record)) {
            throw roleResultInvalid();
        }
        return replayed;
    }
    if (!record.grantUse ||
        typeof record.grantUse !== 'object' ||
        (record.form === 'granted-same-provider'
            ? record.orchestration !== 'engine-spawned-provider' ||
                record.achievedIndependence !== 'session-independent' ||
                record.providerInvocation === null ||
                record.directHumanReviewAttestation !== null
            : record.form === 'granted-caller-supplied'
                ? record.orchestration !== 'caller-supplied' ||
                    record.achievedIndependence !== 'none' ||
                    record.providerInvocation !== null ||
                    record.directHumanReviewAttestation !== null
                : record.form === 'direct-human-attestation'
                    ? record.orchestration !== 'direct-human-review' ||
                        record.achievedIndependence !== 'none' ||
                        record.providerInvocation !== null ||
                        !record.directHumanReviewAttestation
                    : true)) {
        throw roleResultInvalid();
    }
    return deepFreeze(record);
}
const ORDINARY_ASSIGNMENT_KEYS = [
    'role',
    'providerId',
    'sessionId',
    'targetDigest',
    'requiredIndependence',
    'achievedIndependence',
];
const ROLE_CONTENT_KEYS = [
    'kind',
    'nodeId',
    'resultDigest',
    'outputSchema',
    'evaluator',
    'policyDigest',
    'contentDigest',
    'current',
];
const OUTPUT_SCHEMA_KEYS = ['id', 'version', 'digest'];
const PROVIDER_INVOCATION_KEYS = [
    'invocationId',
    'requestDigest',
    'outputDigest',
    'providerId',
    'sessionId',
    'targetDigest',
    'engineSpawned',
];
const RECORDED_PARTICIPANT_KEYS = [
    'providerId',
    'sessionId',
    'principalId',
    'identityAssurance',
    'engineSpawned',
];
const ROLE_CAPABILITY = {
    'plan-reviewer': 'plan-review',
    'task-diff-reviewer': 'task-diff-review',
    'task-implementer': 'task-implementation',
};
function roleSupportsPurpose(role, purpose) {
    return (ROLE_CAPABILITY[role] === purpose ||
        (role === 'plan-reviewer' && purpose === 'survey'));
}
/**
 * Assess independence of a candidate relative to the author being challenged.
 * Provider independence requires the candidate to have a provider distinct from
 * the author's. Session independence requires both author and candidate to have
 * defined session IDs, the candidate to be engine-spawned, and the IDs to
 * differ; it is never manufactured relative to an author with no session.
 * Principal independence is unknown (`null`) whenever either principal is
 * unidentified. When principal independence is positively established and
 * provider independence is not, the achieved summary is `principal-independent`
 * before session independence is considered.
 */
export function assessRoleIndependence(author, candidate) {
    const providerIndependent = candidate.providerId !== undefined &&
        author.providerId !== undefined &&
        candidate.providerId !== author.providerId;
    const sessionIndependent = candidate.engineSpawned &&
        candidate.sessionId !== undefined &&
        author.sessionId !== undefined &&
        candidate.sessionId !== author.sessionId;
    const principalIndependent = author.principalId === undefined || candidate.principalId === undefined
        ? null
        : candidate.principalId !== author.principalId;
    let achievedIndependence = 'none';
    if (providerIndependent) {
        achievedIndependence = 'provider-independent';
    }
    else if (principalIndependent === true) {
        achievedIndependence = 'principal-independent';
    }
    else if (sessionIndependent) {
        achievedIndependence = 'session-independent';
    }
    return {
        principalIndependent,
        providerIndependent,
        sessionIndependent,
        achievedIndependence,
    };
}
/**
 * Schedule an ordinary role at the session-independent floor, or at an
 * explicitly requested provider-independent risk floor. A weaker or unrelated
 * dimension fails closed.
 * Every runtime candidate ID is checked against the code-owned registry and the
 * required purpose capability, so an unknown candidate fails closed rather
 * than being launched. The first enabled, available candidate meeting the
 * requested floor is assigned; otherwise the transition pauses for an eligible
 * collaboration grant.
 */
export function scheduleOrdinaryRole(input) {
    const requiredIndependence = input.requestedIndependence ?? 'session-independent';
    if (requiredIndependence !== 'session-independent' &&
        requiredIndependence !== 'provider-independent') {
        throw workflowError('ROLE_INDEPENDENCE_DOWNGRADE', `Ordinary role "${input.role}" requires at least session-independent; ` +
            `it cannot use ${requiredIndependence}.`, ExitCode.guard);
    }
    // Every candidate ID must be a reviewed provider that supports the required
    // capability; an unknown candidate fails closed before any selection.
    const capability = input.purpose ?? ROLE_CAPABILITY[input.role];
    if (!roleSupportsPurpose(input.role, capability)) {
        throw workflowError('ROLE_CAPABILITY_INVALID', `Role "${input.role}" cannot perform ${capability}.`, ExitCode.guard);
    }
    for (const candidate of input.candidates) {
        requireProviderCapability(candidate.providerId, capability, 'repository-read-only');
    }
    const selected = input.candidates.find((candidate) => {
        if (!candidate.enabled || !candidate.available) {
            return false;
        }
        const independence = assessRoleIndependence(input.author, {
            providerId: candidate.providerId,
            sessionId: candidate.sessionId,
            principalId: undefined,
            identityAssurance: 'adapter-assigned',
            engineSpawned: true,
        });
        return requiredIndependence === 'provider-independent'
            ? independence.providerIndependent
            : independence.sessionIndependent;
    });
    if (!selected) {
        return {
            outcome: 'collaboration-grant-required',
            role: input.role,
            requiredIndependence,
            reason: 'NO_REQUIRED_INDEPENDENCE_CANDIDATE',
        };
    }
    const assignment = Object.freeze({
        role: input.role,
        providerId: selected.providerId,
        sessionId: selected.sessionId,
        targetDigest: input.targetDigest,
        requiredIndependence,
        achievedIndependence: assessRoleIndependence(input.author, {
            providerId: selected.providerId,
            sessionId: selected.sessionId,
            principalId: undefined,
            identityAssurance: 'adapter-assigned',
            engineSpawned: true,
        }).achievedIndependence,
    });
    return { outcome: 'assigned', assignment };
}
/**
 * Apply an already validated and atomically reserved collaboration grant to
 * one exact ordinary-role conflict. This is intentionally additive to
 * `scheduleOrdinaryRole`: an ordinary `RoleAssignment` satisfies the requested
 * session- or provider-independent floor, while degraded assignments have a
 * distinct type that cannot be mistaken for an ordinary result.
 *
 * The function derives achieved independence and orchestration from the actual
 * participant and callable-provider set. Callers cannot supply either claim.
 * A same-provider grant requires the only callable provider, a real
 * engine-spawned fresh session, and is labeled session-independent. A
 * caller-supplied or direct-human contribution is permitted only when no
 * provider is callable and always records no provider/session independence.
 */
export function authorizeGrantedOrdinaryRole(input) {
    if (!input ||
        typeof input !== 'object' ||
        !Array.isArray(input.callableProviderIds) ||
        !/^[0-9a-f]{64}$/.test(input.targetDigest)) {
        throw grantedRoleInvalid();
    }
    const callableProviderIds = [...input.callableProviderIds];
    const degradedAuthorityOverride = input.degradedAuthorityOverride === undefined
        ? undefined
        : assertTaskDiffChallengeClosureAuthorityOverride(input.degradedAuthorityOverride, input.role, input.targetDigest);
    if (callableProviderIds.some((providerId) => !isProviderId(providerId)) ||
        callableProviderIds.length !== new Set(callableProviderIds).size) {
        throw grantedRoleInvalid();
    }
    const reservation = input.reservation;
    if (!reservation ||
        reservation.state !== 'reserved' ||
        !/^[0-9a-f]{64}$/.test(reservation.transitionDigest)) {
        throw grantedRoleInvalid();
    }
    const envelope = parseCollaborationGrantEnvelope(canonicalCollaborationGrantEnvelope(reservation.envelope));
    const payload = envelope.payload;
    if (payload.targetDigest !== input.targetDigest ||
        payload.rolePair.conflictingRole !== input.role ||
        (input.role === 'plan-reviewer' &&
            payload.lifecyclePhase !== 'blind-survey' &&
            payload.lifecyclePhase !== 'plan-review') ||
        (input.role === 'task-diff-reviewer' &&
            payload.lifecyclePhase !== 'task-diff-review') ||
        (input.role === 'task-implementer' &&
            payload.lifecyclePhase !== 'task-implementation')) {
        throw grantedRoleInvalid();
    }
    const base = {
        role: input.role,
        targetDigest: payload.targetDigest,
        requiredIndependence: 'provider-independent',
        providerIndependent: false,
        grantId: payload.grantId,
        degradedForm: payload.degradedForm,
        authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
        author: recordParticipant(input.author),
        callableProviderIds: Object.freeze([...callableProviderIds].sort()),
        ...(degradedAuthorityOverride === undefined
            ? {}
            : { degradedAuthorityOverride }),
    };
    const participant = input.actualParticipant;
    if (payload.degradedForm === 'same-provider-fresh-session' &&
        payload.availableActor.kind === 'provider') {
        const providerId = payload.availableActor.providerId;
        if (input.author.providerId !== providerId ||
            callableProviderIds.length !== 1 ||
            callableProviderIds[0] !== providerId ||
            participant.providerId !== providerId ||
            participant.identityAssurance !== payload.availableActor.assurance ||
            degradedAuthorityOverride !== undefined ||
            !participant.engineSpawned ||
            typeof input.author.sessionId !== 'string' ||
            typeof participant.sessionId !== 'string' ||
            participant.sessionId.length === 0 ||
            participant.sessionId === input.author.sessionId) {
            throw grantedRoleInvalid();
        }
        return Object.freeze({
            ...base,
            providerId,
            sessionId: participant.sessionId,
            achievedIndependence: 'session-independent',
            sessionIndependent: true,
            engineSpawned: true,
            orchestration: 'engine-spawned-provider',
            participant: recordParticipant(participant),
            directHumanReviewAttestationDigest: null,
        });
    }
    if (callableProviderIds.length !== 0 ||
        participant.providerId !== undefined ||
        participant.sessionId !== undefined ||
        participant.engineSpawned) {
        throw grantedRoleInvalid();
    }
    if (payload.degradedForm === 'caller-supplied' &&
        payload.availableActor.kind === 'caller' &&
        participant.principalId === payload.availableActor.callerId &&
        participant.identityAssurance === payload.availableActor.assurance &&
        (input.role === 'task-implementer' ||
            (typeof input.author.principalId === 'string' &&
                participant.principalId !== input.author.principalId))) {
        return Object.freeze({
            ...base,
            providerId: null,
            sessionId: null,
            achievedIndependence: 'none',
            sessionIndependent: false,
            engineSpawned: false,
            orchestration: 'caller-supplied',
            participant: recordParticipant(participant),
            directHumanReviewAttestationDigest: null,
        });
    }
    if (payload.degradedForm === 'direct-human-review' &&
        payload.availableActor.kind === 'direct-human' &&
        (input.role === 'plan-reviewer' || input.role === 'task-diff-reviewer') &&
        participant.principalId === payload.availableActor.identity &&
        input.directHumanReview) {
        const attestation = validateDirectHumanReviewAttestation(input.directHumanReview.attestation, {
            now: input.directHumanReview.now,
            grantEnvelope: envelope,
            policy: input.directHumanReview.policy,
            verifier: input.directHumanReview.verifier,
            transitionDigest: reservation.transitionDigest,
            reviewNodeId: input.directHumanReview.reviewNodeId,
            reviewResultDigest: input.directHumanReview.reviewResultDigest,
        });
        return Object.freeze({
            ...base,
            providerId: null,
            sessionId: null,
            achievedIndependence: 'none',
            sessionIndependent: false,
            engineSpawned: false,
            orchestration: 'direct-human-review',
            participant: {
                ...recordParticipant(participant),
                identityAssurance: 'maintainer-signed',
            },
            directHumanReviewAttestationDigest: directHumanReviewAttestationDigest(attestation),
        });
    }
    throw grantedRoleInvalid();
}
/**
 * Admit one exact role result without conflating provider execution with
 * caller-supplied or direct-human content. The result form is derived from the
 * assignment and observed orchestration; callers cannot select a stronger
 * label. Grant-backed forms replay the same signed-use validator used by live
 * grant consumption and CI.
 */
export function admitRoleResult(input) {
    return admitRoleResultCore(input, null);
}
/**
 * Finish the exact role admission whose Collaboration Grant already reached a
 * cryptographically authenticated terminal `consumed` state. This is not a
 * second validation mode for ordinary governing callers: only the opaque
 * consumed crash-replay proof can enter this path.
 */
export function admitConsumedRoleResultReplay(input) {
    const grantUse = consumedCollaborationGrantUseForReplay(input.replay);
    return admitRoleResultCore({
        assignment: input.assignment,
        author: input.author,
        participant: input.participant,
        content: input.content,
        providerInvocation: input.providerInvocation,
        grantUse,
        grantValidation: null,
    }, grantUse);
}
export function admitRoleContextSharingResult(input) {
    const binding = normalizeRoleContextSharingResultAdmissionBinding(input);
    const { assignment, author, participant, content, providerInvocation } = binding;
    const evidence = input.consumedUse;
    const use = evidence?.use;
    const envelope = evidence?.envelope;
    if (evidence?.kind !== 'role-context-sharing-consumed-use.v1' ||
        evidence.grantId !== assignment.roleContextSharingGrantId ||
        evidence.reservationReceiptDigest !== assignment.reservationReceiptDigest ||
        !/^[0-9a-f]{64}$/.test(evidence.terminalReceiptDigest) ||
        !/^[0-9a-f]{64}$/.test(evidence.terminalRecordDigest) ||
        !/^[0-9a-f]{64}$/.test(evidence.useProjectionDigest) ||
        evidence.useProjectionDigest !==
            crypto.createHash('sha256').update(canonicalJson(use)).digest('hex') ||
        canonicalJson(evidence.expectedBinding) !==
            canonicalJson(bindingFromRoleContextSharingGrantPayloadV1(envelope.payload)) ||
        envelope.payload.grantId !== assignment.roleContextSharingGrantId ||
        canonicalJson(envelope.payload.rolePairs) !==
            canonicalJson(assignment.exactRolePairs) ||
        use.providerId !== assignment.providerId ||
        use.sessionId !== assignment.sessionId ||
        use.sharedEngineSessionId !== assignment.sharedEngineSessionId ||
        use.contextGeneration !== assignment.contextGeneration ||
        use.sessionGeneration !== assignment.sessionGeneration ||
        use.providerDefinitionDigest !== assignment.providerDefinitionDigest ||
        use.assignmentDigest !==
            crypto
                .createHash('sha256')
                .update(canonicalJson(assignment))
                .digest('hex') ||
        use.admissionDigest !==
            computeRoleContextSharingResultAdmissionDigestV1(binding)) {
        throw roleResultInvalid();
    }
    canonicalRoleContextSharingGrantEnvelopeV1(envelope);
    const semantic = {
        schemaVersion: 2,
        form: 'granted-role-context-sharing',
        role: assignment.role,
        targetDigest: assignment.targetDigest,
        assignment: structuredClone(assignment),
        author,
        participant,
        orchestration: 'engine-spawned-provider',
        requiredIndependence: 'provider-independent',
        achievedIndependence: assignment.achievedIndependence,
        content,
        providerInvocation,
        grantUse: null,
        roleContextSharingUse: structuredClone(evidence),
        directHumanReviewAttestation: null,
    };
    return deepFreeze({
        ...semantic,
        resultDigest: crypto
            .createHash('sha256')
            .update(canonicalJson({ schema: 'admitted-role-result.v2', ...semantic }))
            .digest('hex'),
    });
}
/**
 * Validate and freeze the complete result binding before a live one-use
 * transition is allowed to become terminal. Replay admission calls this same
 * normalizer after recovering the exact durable binding.
 */
export function normalizeRoleContextSharingResultAdmissionBinding(input) {
    const assignment = input.assignment;
    const content = assertRoleContentAdmission(input.content);
    const author = normalizeRecordedParticipant(input.author);
    const participant = normalizeRecordedParticipant(input.participant);
    if (assignment.authorityKind !== 'role-context-sharing-grant.v1' ||
        assignment.authorizedEffect !== 'role-context-sharing-degradation' ||
        content.kind !== 'plan-review' ||
        participant.providerId !== assignment.providerId ||
        participant.sessionId !== assignment.sessionId ||
        participant.engineSpawned !== true) {
        throw roleResultInvalid();
    }
    const providerInvocation = assertProviderInvocation(input.providerInvocation, assignment);
    return deepFreeze({
        assignment: structuredClone(assignment),
        author,
        participant,
        content,
        providerInvocation,
    });
}
/**
 * Replay one terminal R-007 admission only from the opaque proof minted after
 * historical signature and exact journal validation.
 */
export function admitConsumedRoleContextSharingResultReplay(input) {
    return admitRoleContextSharingResult({
        assignment: input.assignment,
        author: input.author,
        participant: input.participant,
        content: input.content,
        providerInvocation: input.providerInvocation,
        consumedUse: consumedRoleContextSharingUseForReplay(input.replay, {
            assignment: input.assignment,
            author: input.author,
            participant: input.participant,
            content: input.content,
            providerInvocation: input.providerInvocation,
        }),
    });
}
function admitRoleResultCore(input, consumedReplayUse) {
    if (!input || typeof input !== 'object') {
        throw roleResultInvalid();
    }
    const assignment = input.assignment;
    const content = assertRoleContentAdmission(input.content);
    const author = normalizeRecordedParticipant(input.author);
    const participant = normalizeRecordedParticipant(input.participant);
    if ((assignment.role !== 'plan-reviewer' &&
        assignment.role !== 'task-diff-reviewer' &&
        assignment.role !== 'task-implementer') ||
        !/^[0-9a-f]{64}$/.test(assignment.targetDigest)) {
        throw roleResultInvalid();
    }
    const contentMatchesRole = assignment.role === 'plan-reviewer'
        ? content.kind === 'blind-survey' || content.kind === 'plan-review'
        : assignment.role === 'task-diff-reviewer'
            ? content.kind === 'task-diff-review'
            : content.kind === 'task-implementation';
    if (!contentMatchesRole) {
        throw roleResultInvalid();
    }
    let form;
    let providerInvocation = null;
    let grantUse = null;
    let directHumanReviewAttestation = null;
    let orchestration;
    let achievedIndependence;
    if (isOrdinaryRoleAssignment(assignment)) {
        if (input.grantUse !== null ||
            input.grantValidation !== null ||
            consumedReplayUse !== null) {
            throw roleResultInvalid();
        }
        if (participant.providerId !== assignment.providerId ||
            participant.sessionId !== assignment.sessionId ||
            participant.engineSpawned !== true) {
            throw roleResultInvalid();
        }
        providerInvocation = assertProviderInvocation(input.providerInvocation, assignment);
        form = 'ordinary-provider';
        orchestration = 'engine-spawned-provider';
        achievedIndependence = assignment.achievedIndependence;
    }
    else {
        if (canonicalJson(author) !== canonicalJson(assignment.author) ||
            canonicalJson(participant) !== canonicalJson(assignment.participant) ||
            input.grantUse === null ||
            (consumedReplayUse === null) === (input.grantValidation === null)) {
            throw roleResultInvalid();
        }
        if (consumedReplayUse === null) {
            grantUse = validateCollaborationGrantUseProjection(input.grantUse, {
                ...input.grantValidation,
                expectedAssignment: assignment,
                contentAdmission: {
                    kind: content.kind,
                    nodeId: content.nodeId,
                    resultDigest: content.resultDigest,
                    current: true,
                },
            });
        }
        else {
            if (canonicalJson(input.grantUse) !== canonicalJson(consumedReplayUse) ||
                canonicalJson(consumedReplayUse.assignment) !==
                    canonicalJson(assignment) ||
                canonicalJson(consumedReplayUse.structuredContent) !==
                    canonicalJson({
                        kind: content.kind,
                        nodeId: content.nodeId,
                        resultDigest: content.resultDigest,
                    })) {
                throw roleResultInvalid();
            }
            grantUse = consumedReplayUse;
        }
        orchestration = assignment.orchestration;
        achievedIndependence = assignment.achievedIndependence;
        if (isGrantedSameProviderRoleAssignment(assignment)) {
            providerInvocation = assertProviderInvocation(input.providerInvocation, assignment);
            form = 'granted-same-provider';
        }
        else {
            if (input.providerInvocation !== null) {
                throw roleResultInvalid();
            }
            if (assignment.degradedForm === 'caller-supplied') {
                form = 'granted-caller-supplied';
            }
            else if (assignment.degradedForm === 'direct-human-review') {
                if (assignment.orchestration !== 'direct-human-review' ||
                    !grantUse.directHumanReviewAttestation ||
                    assignment.directHumanReviewAttestationDigest !==
                        directHumanReviewAttestationDigest(grantUse.directHumanReviewAttestation)) {
                    throw roleResultInvalid();
                }
                form = 'direct-human-attestation';
                directHumanReviewAttestation = grantUse.directHumanReviewAttestation;
            }
            else {
                throw roleResultInvalid();
            }
        }
    }
    const semantic = {
        schemaVersion: 1,
        form,
        role: assignment.role,
        targetDigest: assignment.targetDigest,
        assignment: structuredClone(assignment),
        author,
        participant,
        orchestration,
        requiredIndependence: assignment.requiredIndependence,
        achievedIndependence,
        content,
        providerInvocation,
        grantUse,
        directHumanReviewAttestation,
    };
    return deepFreeze({
        ...semantic,
        resultDigest: crypto
            .createHash('sha256')
            .update(canonicalJson({ schema: 'admitted-role-result.v1', ...semantic }))
            .digest('hex'),
    });
}
export function isGrantedSameProviderRoleAssignment(value) {
    return (value.degradedForm === 'same-provider-fresh-session' &&
        value.orchestration === 'engine-spawned-provider' &&
        value.providerId !== null &&
        value.sessionId !== null &&
        value.achievedIndependence === 'session-independent' &&
        value.sessionIndependent === true &&
        value.engineSpawned === true &&
        value.directHumanReviewAttestationDigest === null &&
        value.degradedAuthorityOverride === undefined);
}
function assertTaskDiffChallengeClosureAuthorityOverride(value, role, targetDigest) {
    if (role !== 'task-diff-reviewer' ||
        !value ||
        typeof value !== 'object' ||
        !hasExactKeys(value, [
            'kind',
            'targetDigest',
            'subjectDigest',
            'reviewRecordDigest',
            'responseDigest',
        ]) ||
        value.kind !== 'task-diff-challenge-closure' ||
        !/^[0-9a-f]{64}$/.test(value.subjectDigest) ||
        !/^[0-9a-f]{64}$/.test(value.reviewRecordDigest) ||
        !/^[0-9a-f]{64}$/.test(value.responseDigest) ||
        value.targetDigest !== targetDigest ||
        value.targetDigest !==
            crypto
                .createHash('sha256')
                .update(canonicalJson({
                schema: 'workflow.task-diff-external-continuation-target.v1',
                subjectDigest: value.subjectDigest,
                reviewRecordDigest: value.reviewRecordDigest,
                responseDigest: value.responseDigest,
            }))
                .digest('hex')) {
        throw grantedRoleInvalid();
    }
    return deepFreeze(structuredClone(value));
}
function isOrdinaryRoleAssignment(value) {
    return (!('grantId' in value) &&
        hasExactKeys(value, ORDINARY_ASSIGNMENT_KEYS) &&
        (value.role === 'plan-reviewer' ||
            value.role === 'task-diff-reviewer' ||
            value.role === 'task-implementer') &&
        isProviderId(value.providerId) &&
        typeof value.sessionId === 'string' &&
        value.sessionId.length > 0 &&
        /^[0-9a-f]{64}$/.test(value.targetDigest) &&
        (value.requiredIndependence === 'provider-independent'
            ? value.achievedIndependence === 'provider-independent'
            : value.requiredIndependence === 'session-independent' &&
                (value.achievedIndependence === 'session-independent' ||
                    value.achievedIndependence === 'provider-independent')));
}
function assertRoleContentAdmission(value) {
    if (!value ||
        typeof value !== 'object' ||
        !hasExactKeys(value, ROLE_CONTENT_KEYS) ||
        ![
            'blind-survey',
            'plan-review',
            'task-diff-review',
            'task-implementation',
        ].includes(value.kind) ||
        !/^[0-9a-f]{64}$/.test(value.nodeId) ||
        !/^[0-9a-f]{64}$/.test(value.resultDigest) ||
        !value.outputSchema ||
        typeof value.outputSchema !== 'object' ||
        !hasExactKeys(value.outputSchema, OUTPUT_SCHEMA_KEYS) ||
        typeof value.outputSchema.id !== 'string' ||
        value.outputSchema.id.length === 0 ||
        !Number.isInteger(value.outputSchema.version) ||
        value.outputSchema.version < 1 ||
        !/^[0-9a-f]{64}$/.test(value.outputSchema.digest) ||
        typeof value.evaluator !== 'string' ||
        value.evaluator.length === 0 ||
        !/^[0-9a-f]{64}$/.test(value.policyDigest) ||
        value.contentDigest !== value.resultDigest ||
        value.current !== true) {
        throw roleResultInvalid();
    }
    return deepFreeze(structuredClone(value));
}
function assertProviderInvocation(value, assignment) {
    if (!value ||
        typeof value !== 'object' ||
        !hasExactKeys(value, PROVIDER_INVOCATION_KEYS) ||
        typeof value.invocationId !== 'string' ||
        value.invocationId.length === 0 ||
        !/^[0-9a-f]{64}$/.test(value.requestDigest) ||
        !/^[0-9a-f]{64}$/.test(value.outputDigest) ||
        value.providerId !== assignment.providerId ||
        value.sessionId !== assignment.sessionId ||
        value.targetDigest !== assignment.targetDigest ||
        value.engineSpawned !== true) {
        throw roleResultInvalid();
    }
    return deepFreeze(structuredClone(value));
}
function normalizeRecordedParticipant(value) {
    if (!value || typeof value !== 'object') {
        throw roleResultInvalid();
    }
    if (!hasExactKeys(value, RECORDED_PARTICIPANT_KEYS)) {
        throw roleResultInvalid();
    }
    const providerId = value.providerId ?? null;
    const sessionId = value.sessionId ?? null;
    const principalId = value.principalId ?? null;
    if ((providerId !== null && !isProviderId(providerId)) ||
        (sessionId !== null &&
            (typeof sessionId !== 'string' || sessionId.length === 0)) ||
        (principalId !== null &&
            (typeof principalId !== 'string' || principalId.length === 0)) ||
        ![
            'self-declared',
            'runtime-hint',
            'adapter-assigned',
            'maintainer-signed',
        ].includes(value.identityAssurance) ||
        typeof value.engineSpawned !== 'boolean') {
        throw roleResultInvalid();
    }
    return deepFreeze({
        providerId,
        sessionId,
        principalId,
        identityAssurance: value.identityAssurance,
        engineSpawned: value.engineSpawned,
    });
}
function recordParticipant(participant) {
    if (!participant ||
        typeof participant !== 'object' ||
        (participant.providerId !== undefined &&
            !isProviderId(participant.providerId)) ||
        (participant.sessionId !== undefined &&
            (typeof participant.sessionId !== 'string' ||
                participant.sessionId.length === 0)) ||
        (participant.principalId !== undefined &&
            (typeof participant.principalId !== 'string' ||
                participant.principalId.length === 0)) ||
        !['self-declared', 'runtime-hint', 'adapter-assigned'].includes(participant.identityAssurance) ||
        typeof participant.engineSpawned !== 'boolean') {
        throw grantedRoleInvalid();
    }
    return Object.freeze({
        providerId: participant.providerId ?? null,
        sessionId: participant.sessionId ?? null,
        principalId: participant.principalId ?? null,
        identityAssurance: participant.identityAssurance,
        engineSpawned: participant.engineSpawned,
    });
}
function grantedRoleInvalid() {
    return workflowError('COLLABORATION_GRANT_ROLE_INVALID', 'Collaboration grant does not authorize this exact degraded role assignment.', ExitCode.guard);
}
function roleResultInvalid() {
    return workflowError('ROLE_RESULT_INVALID', 'Role result does not match its exact assignment, orchestration, content, and grant facts.', ExitCode.guard);
}
function hasExactKeys(value, expected) {
    const keys = Reflect.ownKeys(value);
    return (keys.length === expected.length &&
        keys.every((key) => typeof key === 'string') &&
        expected.every((key) => Object.prototype.propertyIsEnumerable.call(value, key)));
}
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}
