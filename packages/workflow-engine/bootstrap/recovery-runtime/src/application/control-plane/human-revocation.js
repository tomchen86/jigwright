/** Human authorization, exact replay and audit orchestration; all observations are required. */
import { HUMAN_REVOCATION_SIGNATURE_NAMESPACE, canonicalHumanRevocationAuthorizationPayload, canonicalHumanRevocationAuthorization, assertHumanRevocationAuthorization, humanRevocationSignatureNamespace, assertAuthorizationBinding, assertBinding, assertPayload, boundedText, exactDate, digest, revocationConflict, } from "../../modules/authority/human-revocation-contract.js";
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
export function createHumanRevocationAuthorizer(services) {
    const { discoverRepository, loadCurrentPolicy, readOptionalPreparation, persistExactPreparation, verifyAuthorityAuditEvents, recordAuthorityAuditEvent, } = services;
    const authorizeHumanRevocation = (cwd, rawBinding, rawOptions, preparationPath, existingAuthorization = null) => {
        const binding = assertBinding(rawBinding);
        const reason = boundedText(rawOptions.reason, 1024, 'reason');
        const now = exactDate(rawOptions.now ?? services.now());
        const repository = discoverRepository(cwd);
        const policy = loadCurrentPolicy(repository.repositoryRoot);
        const origin = services.readRepositoryOrigin(repository.repositoryRoot);
        if (origin !== policy.repository.origin ||
            binding.repositoryId !== policy.repository.id ||
            binding.repositoryOrigin !== policy.repository.origin) {
            throw workflowError('HUMAN_REVOCATION_REPOSITORY_MISMATCH', 'Revocation is not bound to the current trusted repository identity.', ExitCode.guard);
        }
        const signer = rawOptions.signer ??
            services.createSigner(repository.repositoryRoot, policy);
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
    };
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
    return authorizeHumanRevocation;
}
