/** Canonical authority audit evidence and refusal contracts. */
export const AUTHORITY_AUDIT_EVENT_TYPES = Object.freeze([
    'abort',
    'apply-grant',
    'branch-update',
    'candidate-bundle',
    'cas',
    'command',
    'control-plane-grant',
    'error',
    'escalation-request',
    'external-effect',
    'file-change',
    'grant-consume',
    'poststate',
    'provider-invocation',
    'recovery',
    'revoke',
    'rollback',
    'supersede',
    'task-mandate',
]);
export const AUTHORITY_AUDIT_RESULTS = Object.freeze([
    'aborted',
    'failed',
    'recorded',
    'revoked',
    'rolled-back',
    'succeeded',
    'superseded',
]);
import crypto from 'node:crypto';
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
export function deriveAuthorityAuditRepositoryId(repositoryIdentity) {
    if (typeof repositoryIdentity !== 'string' ||
        repositoryIdentity.length === 0 ||
        repositoryIdentity.trim() !== repositoryIdentity ||
        Buffer.byteLength(repositoryIdentity) > MAX_REPOSITORY_ID_BYTES ||
        [...repositoryIdentity].some((character) => {
            const point = character.codePointAt(0) ?? 0;
            return point <= 31 || (point >= 127 && point <= 159);
        })) {
        throw invalidScope();
    }
    return sha256Digest(canonicalJson({
        schemaVersion: 1,
        kind: 'authority-audit-repository.v1',
        repositoryIdentity,
    }));
}
export function sha256Digest(content) {
    return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}
export function invalidScope() {
    return workflowError('AUTHORITY_AUDIT_SCOPE_INVALID', 'Authority audit ledger scope must use explicit canonical absolute paths and a digest repository identity.', ExitCode.usage);
}
export const MAX_REPOSITORY_ID_BYTES = 512;
export const PROTECTED_AUDIT_ASSURANCE = 'bootstrap-only-local-filesystem-worm-not-remote-sealed';
