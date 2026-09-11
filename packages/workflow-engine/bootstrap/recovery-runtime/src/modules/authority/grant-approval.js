/**
 * Evaluates registered approval proofs against the exact claims required by
 * a Grant profile.
 *
 * Invariants:
 * - Approval succeeds only when the union of proven claims exactly equals
 *   the profile's requiredClaims.
 * - Each proof module identity (moduleId@version) must be unique within one
 *   evaluation.
 */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { isRecord } from "../../foundation/canonical-json/contract-values.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { freezeGrantCanonical as freezeCanonical, GRANT_SHA256_DIGEST as SHA256_DIGEST, GRANT_STABLE_ID as STABLE_ID, grantHasExactKeys as hasExactKeys, grantSameStrings as sameStrings, grantSha256, parseGrantTimestamp, } from "./grant-primitives.js";
import { approvalSubjectDigest, assertApprovalSubject } from "./grant-core.js";
const MODULE_VERSION = /^[1-9][0-9]*$/;
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/;
const SIGNATURE_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_PORTABLE_PAYLOAD_BYTES = 65_536;
const MAX_SIGNATURE_BYTES = 16_384;
export function evaluateApprovalProfile(policy, profileId, expectedSubjectDigest, suppliedProofs) {
    if (!STABLE_ID.test(profileId) ||
        !SHA256_DIGEST.test(expectedSubjectDigest) ||
        !Array.isArray(suppliedProofs) ||
        suppliedProofs.length < 1) {
        throw approvalInvalid();
    }
    const profile = policy.profiles[profileId];
    if (profile === undefined) {
        throw workflowError('GRANT_APPROVAL_PROFILE_UNKNOWN', `Grant approval profile ${profileId} is unavailable.`, ExitCode.guard);
    }
    const moduleIdentities = new Set();
    const claimed = new Set();
    const proofModules = [];
    for (const supplied of suppliedProofs) {
        const proof = assertVerifiedApprovalProof(supplied);
        const identity = `${proof.moduleId}@${proof.version}`;
        if (moduleIdentities.has(identity) ||
            proof.approvalSubjectDigest !== expectedSubjectDigest) {
            throw approvalInvalid();
        }
        moduleIdentities.add(identity);
        const registration = policy.approvalModules.find(({ moduleId, version }) => moduleId === proof.moduleId && version === proof.version);
        if (registration === undefined ||
            !sameStrings(proof.claims, registration.allowedClaims)) {
            throw approvalInvalid();
        }
        if (proof.portableEvidence !== null &&
            (policy.optionalSsh === undefined ||
                proof.portableEvidence.signatureNamespace !==
                    policy.optionalSsh.signatureNamespace ||
                !policy.optionalSsh.trustedSigners.some(({ identity }) => identity === proof.portableEvidence?.identity))) {
            throw approvalInvalid();
        }
        for (const claim of proof.claims) {
            if (claimed.has(claim))
                throw approvalInvalid();
            claimed.add(claim);
            proofModules.push({
                moduleId: proof.moduleId,
                version: proof.version,
                claim,
                proofDigest: proof.proofDigest,
                identity: proof.identity,
                portableEvidence: proof.portableEvidence,
            });
        }
    }
    if (!sameStrings([...claimed], profile.requiredClaims)) {
        throw workflowError('GRANT_APPROVAL_PROFILE_UNSATISFIED', 'Verified approval proofs do not satisfy the selected grant profile.', ExitCode.guard);
    }
    const claims = [...claimed].sort();
    return freezeCanonical({
        profileId,
        approvalSubjectDigest: expectedSubjectDigest,
        claims,
        proofModules,
    });
}
function assertVerifiedApprovalProof(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'moduleId',
            'version',
            'claims',
            'approvalSubjectDigest',
            'proofDigest',
            'verifiedAt',
            'identity',
            'portableEvidence',
        ]) ||
        typeof value.moduleId !== 'string' ||
        !STABLE_ID.test(value.moduleId) ||
        typeof value.version !== 'string' ||
        !MODULE_VERSION.test(value.version) ||
        !Array.isArray(value.claims) ||
        value.claims.length < 1 ||
        !value.claims.every((claim) => claim === 'fresh-local-device-owner' || claim === 'ssh-signature') ||
        new Set(value.claims).size !== value.claims.length ||
        typeof value.approvalSubjectDigest !== 'string' ||
        !SHA256_DIGEST.test(value.approvalSubjectDigest) ||
        typeof value.proofDigest !== 'string' ||
        !SHA256_DIGEST.test(value.proofDigest) ||
        typeof value.verifiedAt !== 'string' ||
        !(value.identity === null ||
            (typeof value.identity === 'string' && IDENTITY.test(value.identity)))) {
        throw approvalInvalid();
    }
    const verifiedAt = new Date(value.verifiedAt);
    if (!Number.isFinite(verifiedAt.getTime()) ||
        verifiedAt.toISOString() !== value.verifiedAt) {
        throw approvalInvalid();
    }
    const portableEvidence = value.portableEvidence === null
        ? null
        : assertSshPortableApprovalEvidenceV1(value.portableEvidence);
    const isSshProof = value.moduleId === 'grant-proof-ssh' &&
        value.version === '1' &&
        sameStrings(value.claims, ['ssh-signature']);
    if (isSshProof
        ? portableEvidence === null ||
            value.identity !== portableEvidence.identity ||
            value.verifiedAt !== portableEvidence.verifiedAt ||
            value.approvalSubjectDigest !==
                sshPortableApprovalEvidenceSubjectDigest(portableEvidence) ||
            value.proofDigest !==
                sshPortableApprovalEvidenceDigest(portableEvidence)
        : portableEvidence !== null) {
        throw approvalInvalid();
    }
    return freezeCanonical({
        moduleId: value.moduleId,
        version: value.version,
        claims: [...value.claims],
        approvalSubjectDigest: value.approvalSubjectDigest,
        proofDigest: value.proofDigest,
        verifiedAt: verifiedAt.toISOString(),
        identity: value.identity,
        portableEvidence,
    });
}
export function assertSshPortableApprovalEvidenceV1(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'payload',
            'signature',
            'signatureNamespace',
            'identity',
            'verifiedAt',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'grant-proof-ssh-portable-evidence.v1' ||
        typeof value.payload !== 'string' ||
        Buffer.byteLength(value.payload) > MAX_PORTABLE_PAYLOAD_BYTES ||
        typeof value.signature !== 'string' ||
        Buffer.byteLength(value.signature) < 1 ||
        Buffer.byteLength(value.signature) > MAX_SIGNATURE_BYTES ||
        /[\0\r]/.test(value.signature) ||
        typeof value.signatureNamespace !== 'string' ||
        !SIGNATURE_NAMESPACE.test(value.signatureNamespace) ||
        typeof value.identity !== 'string' ||
        !IDENTITY.test(value.identity) ||
        typeof value.verifiedAt !== 'string' ||
        parseGrantTimestamp(value.verifiedAt) === null) {
        throw approvalInvalid();
    }
    let payload;
    try {
        payload = JSON.parse(value.payload);
    }
    catch {
        throw approvalInvalid();
    }
    if (!isRecord(payload) ||
        !hasExactKeys(payload, [
            'schemaVersion',
            'kind',
            'approvalSubject',
            'approvalSubjectDigest',
            'signerIdentity',
        ]) ||
        payload.schemaVersion !== 1 ||
        payload.kind !== 'grant-proof-ssh-subject.v1' ||
        typeof payload.approvalSubjectDigest !== 'string' ||
        !SHA256_DIGEST.test(payload.approvalSubjectDigest) ||
        typeof payload.signerIdentity !== 'string' ||
        payload.signerIdentity !== value.identity) {
        throw approvalInvalid();
    }
    const subject = assertApprovalSubject(payload.approvalSubject);
    if (subject.approvalMethod !== 'ssh' ||
        approvalSubjectDigest(subject) !== payload.approvalSubjectDigest ||
        canonicalJson({
            schemaVersion: 1,
            kind: 'grant-proof-ssh-subject.v1',
            approvalSubject: subject,
            approvalSubjectDigest: payload.approvalSubjectDigest,
            signerIdentity: payload.signerIdentity,
        }) !== value.payload) {
        throw approvalInvalid();
    }
    return freezeCanonical({
        schemaVersion: 1,
        kind: 'grant-proof-ssh-portable-evidence.v1',
        payload: value.payload,
        signature: value.signature,
        signatureNamespace: value.signatureNamespace,
        identity: value.identity,
        verifiedAt: value.verifiedAt,
    });
}
export function sshPortableApprovalEvidenceDigest(value) {
    return grantSha256(canonicalJson(assertSshPortableApprovalEvidenceV1(value)));
}
export function sshPortableApprovalEvidenceSubjectDigest(value) {
    const payload = JSON.parse(value.payload);
    return payload.approvalSubjectDigest;
}
function approvalInvalid() {
    return workflowError('GRANT_APPROVAL_PROOF_INVALID', 'A grant approval proof is malformed, untrusted, or subject-mismatched.', ExitCode.guard);
}
