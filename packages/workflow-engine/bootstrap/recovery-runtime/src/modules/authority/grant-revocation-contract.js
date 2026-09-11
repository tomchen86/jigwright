import { isRecord } from "../investigation/domain/investigation-store-values.js";
import { humanResolutionGrantUnsafe } from "../investigation/domain/human-resolution-values.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { deriveAuthorityAuditRepositoryId } from "./authority-audit-contract.js";
import { digestHumanRevocationSubject, } from "./human-revocation-contract.js";
export function humanResolutionRevocationBinding(envelopeBytes, grantId, readSession) {
    let envelope;
    try {
        envelope = JSON.parse(envelopeBytes);
    }
    catch {
        throw humanResolutionGrantUnsafe();
    }
    if (!isRecord(envelope) || !isRecord(envelope.payload)) {
        throw humanResolutionGrantUnsafe();
    }
    const payload = envelope.payload;
    if (payload.grantId !== grantId ||
        typeof payload.repositoryId !== 'string' ||
        typeof payload.repositoryOrigin !== 'string' ||
        !isRecord(payload.target) ||
        typeof payload.target.changeId !== 'string' ||
        typeof payload.target.workflowId !== 'string') {
        throw humanResolutionGrantUnsafe();
    }
    const session = readSession(payload.target.workflowId);
    if (session.changeId !== payload.target.changeId ||
        (session.mandateBinding !== undefined &&
            session.mandateBinding.changeId !== payload.target.changeId)) {
        throw workflowError('HUMAN_REVOCATION_BINDING_INVALID', 'Human-resolution revocation session binding is unavailable or different.', ExitCode.guard);
    }
    return {
        subjectKind: 'human-resolution-grant',
        grantId,
        grantDigest: digestHumanRevocationSubject(envelopeBytes),
        repositoryId: payload.repositoryId,
        repositoryOrigin: payload.repositoryOrigin,
        changeId: payload.target.changeId,
        taskId: session.mandateBinding?.mandateTaskId ?? null,
        workflowId: payload.target.workflowId,
        audit: session.mandateBinding
            ? {
                externalAuditRoot: session.mandateBinding.externalAuditRoot,
                repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
            }
            : null,
    };
}
