/** Canonical Grant records, evidence validation and exact record projections. */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { isRecord } from "../../foundation/canonical-json/contract-values.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertApprovalSubject, assertGrantChallenge, approvalSubjectDigest, createApprovalSubject, } from "./grant-core.js";
import { assertSshPortableApprovalEvidenceV1, sshPortableApprovalEvidenceDigest, sshPortableApprovalEvidenceSubjectDigest, } from "./grant-approval.js";
import { freezeGrantCanonical, GRANT_SHA256_DIGEST, GRANT_STABLE_ID, GRANT_UUID_V4, grantHasExactKeys, grantSha256, grantSameStrings, parseGrantTimestamp, } from "./grant-primitives.js";
const MODULE_VERSION = /^[1-9][0-9]*$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
export const MAX_GRANT_RECORD_BYTES = 1_048_576;
/** Parse one exact canonical Grant record without consulting a local store. */
export function parseGrantRecord(value) {
    try {
        if (typeof value !== 'string') {
            const canonical = canonicalJson(value);
            if (Buffer.byteLength(canonical, 'utf8') + 1 > MAX_GRANT_RECORD_BYTES) {
                throw storeUnsafe();
            }
            return assertGrantRecord(JSON.parse(canonical));
        }
        if (Buffer.byteLength(value, 'utf8') > MAX_GRANT_RECORD_BYTES ||
            !value.endsWith('\n')) {
            throw storeUnsafe();
        }
        const record = assertGrantRecord(JSON.parse(value));
        if (`${canonicalJson(record)}\n` !== value)
            throw storeUnsafe();
        return record;
    }
    catch (error) {
        if (error instanceof Error && 'code' in error)
            throw error;
        throw storeUnsafe();
    }
}
/** Rebuild the exact prepared ancestor embedded by a terminal record. */
export function projectPreparedGrantRecord(candidate) {
    const record = assertGrantRecord(candidate);
    if (record.state === 'pending')
        throw storeUnsafe();
    return assertGrantRecord({
        schemaVersion: record.schemaVersion,
        kind: record.kind,
        state: 'prepared',
        challenge: record.challenge,
        recordedAt: record.recordedAt,
        operationId: record.operationId,
        approvalSubject: record.approvalSubject,
        proofModules: record.proofModules,
        preparedAt: record.preparedAt,
    });
}
export function grantRecordDigest(candidate) {
    const record = assertGrantRecord(candidate);
    return grantSha256(`workflow.grant-record.v1\n${canonicalJson(record)}`);
}
export function assertExactPreparedGrantParentBinding(parent, binding) {
    const choice = parent.challenge.choices.find(({ choiceId }) => choiceId === parent.approvalSubject.choiceId);
    if (choice === undefined ||
        binding.parentChallengeId !== parent.challenge.challengeId ||
        binding.parentChallengeDigest !== parent.challenge.challengeDigest ||
        binding.parentOperationId !== parent.operationId ||
        binding.parentApprovalSubjectDigest !==
            approvalSubjectDigest(parent.approvalSubject) ||
        binding.parentStateBindingDigest !== parent.challenge.stateBinding.digest ||
        binding.parentParametersDigest !==
            grantSha256(canonicalJson(choice.parameters)) ||
        binding.parentPreparedRecordDigest !== grantRecordDigest(parent)) {
        throw storeUnsafe();
    }
}
export function assertGrantRecord(value) {
    return storeSafe(() => {
        if (!isRecord(value) || typeof value.state !== 'string') {
            throw storeUnsafe();
        }
        const state = value.state;
        const preparedKeys = [
            'operationId',
            'approvalSubject',
            'proofModules',
            'preparedAt',
        ];
        const terminalKeys = ['poststateDigest', 'outcome', 'completedAt', 'audit'];
        const extraKeys = state === 'pending'
            ? []
            : state === 'prepared'
                ? preparedKeys
                : state === 'completed' || state === 'failed'
                    ? [...preparedKeys, ...terminalKeys]
                    : null;
        if (extraKeys === null ||
            !grantHasExactKeys(value, [
                'schemaVersion',
                'kind',
                'state',
                'challenge',
                'recordedAt',
                ...extraKeys,
            ]) ||
            value.schemaVersion !== 1 ||
            value.kind !== 'grant-record.v1' ||
            typeof value.recordedAt !== 'string') {
            throw storeUnsafe();
        }
        const challenge = assertGrantChallenge(value.challenge);
        if (value.recordedAt !== challenge.issuedAt)
            throw storeUnsafe();
        const base = {
            schemaVersion: 1,
            kind: 'grant-record.v1',
            state: 'pending',
            challenge,
            recordedAt: challenge.issuedAt,
        };
        if (state === 'pending') {
            return freezeGrantCanonical(base);
        }
        const prepared = assertPreparedFields(value, base);
        if (state === 'prepared')
            return prepared;
        if (typeof value.poststateDigest !== 'string' ||
            !GRANT_SHA256_DIGEST.test(value.poststateDigest) ||
            typeof value.completedAt !== 'string') {
            throw storeUnsafe();
        }
        const completedAt = parseGrantTimestamp(value.completedAt);
        if (completedAt === null ||
            completedAt.getTime() < new Date(prepared.preparedAt).getTime()) {
            throw storeUnsafe();
        }
        const outcome = assertTransitionOutcome(value.outcome);
        if (outcome.outcome !== state)
            throw storeUnsafe();
        return freezeGrantCanonical({
            ...prepared,
            state,
            poststateDigest: value.poststateDigest,
            outcome,
            completedAt: completedAt.toISOString(),
            audit: assertGrantAuditRecord(value.audit, prepared),
        });
    });
}
function assertPreparedFields(value, base) {
    if (typeof value.operationId !== 'string' ||
        !GRANT_UUID_V4.test(value.operationId) ||
        !Array.isArray(value.proofModules) ||
        typeof value.preparedAt !== 'string') {
        throw storeUnsafe();
    }
    const subject = assertSubjectForChallenge(base.challenge, value.approvalSubject);
    const proofModules = assertProofModules(value.proofModules, subject);
    const preparedAt = parseGrantTimestamp(value.preparedAt);
    if (preparedAt === null ||
        preparedAt.getTime() < new Date(base.challenge.issuedAt).getTime() ||
        preparedAt.getTime() > new Date(base.challenge.expiresAt).getTime()) {
        throw storeUnsafe();
    }
    assertProofMethod(subject, proofModules);
    return freezeGrantCanonical({
        ...base,
        state: 'prepared',
        operationId: value.operationId,
        approvalSubject: subject,
        proofModules,
        preparedAt: preparedAt.toISOString(),
    });
}
export function assertSubjectForChallenge(challenge, value) {
    const subject = storeSafe(() => assertApprovalSubject(value));
    const recreated = storeSafe(() => createApprovalSubject(challenge, {
        choiceId: subject.choiceId,
        approvalMethod: subject.approvalMethod,
        reasonCode: subject.reasonCode,
        reason: subject.reason,
        sessionNonce: subject.sessionNonce,
    }, { now: new Date(challenge.issuedAt) }));
    if (canonicalJson(subject) !== canonicalJson(recreated))
        throw storeUnsafe();
    return subject;
}
export function assertProofModules(value, subject) {
    if (!Array.isArray(value) || value.length < 1)
        throw storeUnsafe();
    const identities = new Set();
    return freezeGrantCanonical(value.map((candidate) => {
        if (!isRecord(candidate) ||
            !grantHasExactKeys(candidate, [
                'moduleId',
                'version',
                'claim',
                'proofDigest',
                'identity',
                'portableEvidence',
            ]) ||
            typeof candidate.moduleId !== 'string' ||
            !GRANT_STABLE_ID.test(candidate.moduleId) ||
            typeof candidate.version !== 'string' ||
            !MODULE_VERSION.test(candidate.version) ||
            (candidate.claim !== 'fresh-local-device-owner' &&
                candidate.claim !== 'ssh-signature') ||
            typeof candidate.proofDigest !== 'string' ||
            !GRANT_SHA256_DIGEST.test(candidate.proofDigest) ||
            !(candidate.identity === null ||
                (typeof candidate.identity === 'string' &&
                    IDENTITY.test(candidate.identity)))) {
            throw storeUnsafe();
        }
        const identity = `${candidate.moduleId}@${candidate.version}:${candidate.claim}`;
        if (identities.has(identity))
            throw storeUnsafe();
        identities.add(identity);
        const portableEvidence = candidate.portableEvidence === null
            ? null
            : storeSafe(() => assertSshPortableApprovalEvidenceV1(candidate.portableEvidence));
        const isSshProof = candidate.moduleId === 'grant-proof-ssh' &&
            candidate.version === '1' &&
            candidate.claim === 'ssh-signature';
        if (isSshProof
            ? portableEvidence === null ||
                candidate.identity !== portableEvidence.identity ||
                candidate.proofDigest !==
                    sshPortableApprovalEvidenceDigest(portableEvidence) ||
                approvalSubjectDigest(subject) !==
                    sshPortableApprovalEvidenceSubjectDigest(portableEvidence)
            : portableEvidence !== null) {
            throw storeUnsafe();
        }
        return {
            moduleId: candidate.moduleId,
            version: candidate.version,
            claim: candidate.claim,
            proofDigest: candidate.proofDigest,
            identity: candidate.identity,
            portableEvidence,
        };
    }));
}
export function assertProofMethod(subject, proofs) {
    if (proofs.length !== 1)
        throw storeUnsafe();
    const proof = proofs[0];
    if (subject.approvalMethod === 'human-presence'
        ? proof.claim !== 'fresh-local-device-owner' ||
            proof.identity !== null ||
            proof.portableEvidence !== null
        : proof.moduleId !== 'grant-proof-ssh' ||
            proof.version !== '1' ||
            proof.claim !== 'ssh-signature' ||
            typeof proof.identity !== 'string' ||
            proof.portableEvidence === null) {
        throw storeUnsafe();
    }
}
export function assertTransitionOutcome(value) {
    if (!isRecord(value) ||
        !grantHasExactKeys(value, ['outcome', 'details']) ||
        (value.outcome !== 'completed' && value.outcome !== 'failed')) {
        throw storeUnsafe();
    }
    return freezeGrantCanonical({
        outcome: value.outcome,
        details: value.details,
    });
}
export function assertGrantAuditRecord(value, prepared) {
    if (!isRecord(value) ||
        !grantHasExactKeys(value, [
            'approvalMethod',
            'authorityClass',
            'identity',
            'identityAssurance',
            'presenceAssurance',
            'proofModules',
        ]) ||
        value.approvalMethod !== prepared.approvalSubject.approvalMethod ||
        !Array.isArray(value.proofModules) ||
        !value.proofModules.every((module) => typeof module === 'string' &&
            /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*@[1-9][0-9]*$/.test(module)) ||
        !grantSameStrings(value.proofModules, prepared.proofModules.map(({ moduleId, version }) => `${moduleId}@${version}`)) ||
        !auditAssuranceMatchesMethod(value, prepared)) {
        throw storeUnsafe();
    }
    return freezeGrantCanonical(value);
}
function auditAssuranceMatchesMethod(value, prepared) {
    if (value.approvalMethod === 'human-presence') {
        return (value.authorityClass === 'local-device-owner' &&
            value.identity === null &&
            value.identityAssurance === 'not-asserted' &&
            value.presenceAssurance === 'fresh-os-authentication');
    }
    const sshIdentity = prepared.proofModules[0]?.identity;
    return (value.approvalMethod === 'ssh' &&
        value.authorityClass === 'ssh-credential' &&
        typeof value.identity === 'string' &&
        value.identity === sshIdentity &&
        IDENTITY.test(value.identity) &&
        value.identityAssurance === 'policy-trusted-ssh-key' &&
        value.presenceAssurance === 'not-asserted');
}
export function assertChallengeId(value) {
    if (typeof value !== 'string' || !GRANT_UUID_V4.test(value)) {
        throw storeUnsafe();
    }
}
export function storeSafe(operation) {
    try {
        return operation();
    }
    catch {
        throw storeUnsafe();
    }
}
export function challengeUnavailable(challengeId) {
    return workflowError('GRANT_CHALLENGE_UNAVAILABLE', `Grant challenge ${challengeId} is not available.`, ExitCode.staleState);
}
export function storeUnsafe() {
    return workflowError('GRANT_STORE_UNSAFE', 'Grant challenge storage is unsafe or malformed.', ExitCode.unsafeEnvironment);
}
/** Validate the exact lifecycle recovery allowance before consulting storage. */
export function assertAllowedGrantChallengeIds(allowedChallengeIds) {
    const allowed = new Set();
    for (const challengeId of allowedChallengeIds) {
        assertChallengeId(challengeId);
        if (allowed.has(challengeId))
            throw storeUnsafe();
        allowed.add(challengeId);
    }
    return allowed;
}
export function assertNoBlockingPreparedGrants(records, allowed) {
    for (const record of records) {
        if (!allowed.has(record.challenge.challengeId)) {
            throw workflowError('GRANT_TRANSITION_RECOVERY_REQUIRED', `Prepared grant ${record.challenge.challengeId} must be recovered before another repository lifecycle operation.`, ExitCode.staleState);
        }
    }
}
