/**
 * Authorizes and records human revocations under the current repository
 * policy.
 *
 * Invariants:
 * - Revocation requires human presence and a signer trusted by the current
 *   policy.
 */
import { HUMAN_REVOCATION_SIGNATURE_NAMESPACE, canonicalHumanRevocationAuthorizationPayload, canonicalHumanRevocationAuthorization, parseHumanRevocationAuthorization, assertHumanRevocationAuthorization, humanRevocationSignatureNamespace, assertAuthorizationBinding, assertBinding, assertPayload, boundedText, exactDate, digest, invalidRevocation, revocationConflict, } from "../../modules/authority/human-revocation-contract.js";
export { HUMAN_REVOCATION_SIGNATURE_NAMESPACE, digestHumanRevocationSubject, canonicalHumanRevocationAuthorizationPayload, canonicalHumanRevocationAuthorization, parseHumanRevocationAuthorization, assertHumanRevocationAuthorization, } from "../../modules/authority/human-revocation-contract.js";
import fs from 'node:fs';
import path from 'node:path';
import { recordAuthorityAuditEvent, verifyAuthorityAuditEvents, } from "../../runtime/storage-journal/authority-audit-service.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { ensurePlainDirectory } from "../../runtime/repository-transaction/filesystem-safety.js";
import { discoverRepository, runGit, } from "../../runtime/repository-transaction/git.js";
import { parseMaintainerPolicy } from "../../modules/authority/maintainer-policy.js";
import { createInteractiveSshSigner, } from "../../adapters/signing/ssh/maintainer-signer.js";
/**
 * Produces (or replays) a current-human signed revocation authorization,
 * durably prepares its exact bytes, and only then appends binding-derived
 * external audit. Callers terminalize their grant after this returns.
 */
export function authorizeHumanRevocation(cwd, rawBinding, rawOptions, preparationPath, existingAuthorization = null) {
    const binding = assertBinding(rawBinding);
    const reason = boundedText(rawOptions.reason, 1024, 'reason');
    const now = exactDate(rawOptions.now ?? new Date());
    const repository = discoverRepository(cwd);
    const policy = loadCurrentPolicy(repository.repositoryRoot);
    const origin = runGit(repository.repositoryRoot, [
        'remote',
        'get-url',
        'origin',
    ]).trim();
    if (origin !== policy.repository.origin ||
        binding.repositoryId !== policy.repository.id ||
        binding.repositoryOrigin !== policy.repository.origin) {
        throw workflowError('HUMAN_REVOCATION_REPOSITORY_MISMATCH', 'Revocation is not bound to the current trusted repository identity.', ExitCode.guard);
    }
    const signer = rawOptions.signer ??
        createInteractiveSshSigner(repository.repositoryRoot, policy);
    signer.assertHumanPresent();
    const actorIdentity = boundedText(signer.identity(), 192, 'signer identity');
    if (!policy.trustedSigners.some(({ identity }) => identity === actorIdentity)) {
        throw workflowError('HUMAN_REVOCATION_SIGNER_UNTRUSTED', 'Revocation requires a signer trusted by the current HEAD policy.', ExitCode.guard);
    }
    const prepared = readOptionalPreparation(preparationPath);
    if (existingAuthorization !== null &&
        prepared !== null &&
        canonicalHumanRevocationAuthorization(existingAuthorization) !==
            canonicalHumanRevocationAuthorization(prepared)) {
        throw revocationConflict();
    }
    let authorization = existingAuthorization ?? prepared;
    if (authorization !== null) {
        authorization = assertAuthorizationBinding(authorization, binding, reason);
        assertCurrentAuthorizationSignature(authorization, policy, signer);
    }
    else {
        const payload = assertPayload({
            schemaVersion: 1,
            kind: 'human-revocation-authorization.v1',
            ...structuredClone(binding),
            reason,
            revokedAt: now.toISOString(),
            signer: actorIdentity,
        });
        const signature = signer.sign(canonicalHumanRevocationAuthorizationPayload(payload), HUMAN_REVOCATION_SIGNATURE_NAMESPACE);
        authorization = assertHumanRevocationAuthorization({
            payload,
            signatureNamespace: HUMAN_REVOCATION_SIGNATURE_NAMESPACE,
            signature,
        });
        assertCurrentAuthorizationSignature(authorization, policy, signer);
    }
    persistExactPreparation(preparationPath, authorization);
    appendRevocationAudit(repository.repositoryRoot, authorization);
    rawOptions.testAfterAudit?.();
    return authorization;
}
function appendRevocationAudit(repositoryRoot, authorization) {
    const payload = authorization.payload;
    if (payload.audit === null)
        return;
    const scope = Object.freeze({
        externalAuditRoot: payload.audit.externalAuditRoot,
        repositoryRoot,
        repositoryId: payload.audit.repositoryId,
    });
    verifyAuthorityAuditEvents(scope);
    const outcomeDigest = digest(canonicalHumanRevocationAuthorization(authorization));
    recordAuthorityAuditEvent(scope, {
        eventType: 'revoke',
        occurredAt: payload.revokedAt,
        idempotencyKey: digest(canonicalJson({
            schemaVersion: 1,
            kind: 'human-revocation-audit-identity.v1',
            subjectKind: payload.subjectKind,
            grantId: payload.grantId,
            grantDigest: payload.grantDigest,
            reason: payload.reason,
        })),
        actor: { kind: 'human', identity: payload.signer },
        taskId: payload.taskId,
        changeId: payload.changeId,
        workflowId: payload.workflowId,
        grantDigest: payload.grantDigest,
        candidateBundleDigest: null,
        prestateDigest: payload.grantDigest,
        poststateDigest: outcomeDigest,
        command: {
            name: `${payload.subjectKind}.revoke`,
            argvDigest: digest(canonicalJson({
                grantId: payload.grantId,
                reason: payload.reason,
            })),
        },
        providerInvocation: null,
        externalEffect: null,
        result: 'revoked',
        outcomeDigest,
        errorCode: null,
    });
}
function assertCurrentAuthorizationSignature(authorization, policy, verifier) {
    if (!policy.trustedSigners.some(({ identity }) => identity === authorization.payload.signer)) {
        throw workflowError('HUMAN_REVOCATION_SIGNER_UNTRUSTED', 'The durable revocation tombstone signer is no longer trusted.', ExitCode.guard);
    }
    verifier.verify(canonicalHumanRevocationAuthorizationPayload(authorization.payload), authorization.signature, authorization.payload.signer, humanRevocationSignatureNamespace(authorization));
}
function persistExactPreparation(preparationPath, authorization) {
    if (!path.isAbsolute(preparationPath))
        throw invalidRevocation();
    const parent = path.dirname(preparationPath);
    ensurePlainDirectory(parent);
    fs.chmodSync(parent, 0o700);
    const bytes = canonicalHumanRevocationAuthorization(authorization);
    const existing = readOptionalPreparation(preparationPath);
    if (existing !== null) {
        if (canonicalHumanRevocationAuthorization(existing) !== bytes) {
            throw revocationConflict();
        }
        return;
    }
    let descriptor;
    try {
        descriptor = fs.openSync(preparationPath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(descriptor, bytes, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fsyncDirectory(parent);
    }
    catch (error) {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
        if (isNodeError(error) && error.code === 'EEXIST') {
            const raced = readOptionalPreparation(preparationPath);
            if (raced !== null &&
                canonicalHumanRevocationAuthorization(raced) === bytes) {
                return;
            }
            throw revocationConflict();
        }
        throw error;
    }
}
function readOptionalPreparation(preparationPath) {
    const stats = fs.lstatSync(preparationPath, { throwIfNoEntry: false });
    if (!stats)
        return null;
    if (!stats.isFile() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o600) {
        throw invalidRevocation();
    }
    return parseHumanRevocationAuthorization(fs.readFileSync(preparationPath, 'utf8'));
}
function loadCurrentPolicy(repositoryRoot) {
    try {
        return parseMaintainerPolicy(JSON.parse(runGit(repositoryRoot, [
            'show',
            'HEAD:workflow/maintainer-policy.json',
        ])));
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error)
            throw error;
        throw workflowError('MAINTAINER_POLICY_INVALID', 'The current HEAD does not contain a valid maintainer policy.', ExitCode.guard);
    }
}
function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, 'r');
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
