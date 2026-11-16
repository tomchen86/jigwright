import { authorityRefusalDigest } from "../../modules/authority/authority-refusal-audit.js";
export function createHarnessBootstrapAudit(bindings) {
    const { deriveAuthorityAuditRepositoryId, recordAuthorityAuditEvent, recordAuthorityRefusal, } = bindings;
    function auditHarnessRecoveryRefusal(authority, args, refusal, overrides) {
        if (refusal.code.startsWith('AUTHORITY_AUDIT_'))
            return;
        const { marker, repositoryRoot } = authority;
        try {
            recordAuthorityRefusal({
                scope: {
                    externalAuditRoot: marker.externalAuditRoot,
                    repositoryRoot,
                    repositoryId: deriveAuthorityAuditRepositoryId(marker.repositoryId),
                },
                family: 'recovery-authority',
                operation: 'harness-bootstrap.rejection',
                subjectId: marker.enterGrantId,
                actor: { kind: 'engine', identity: 'sealed-recovery-harness' },
                taskId: null,
                changeId: null,
                workflowId: marker.enterGrantId,
                grantDigest: marker.enterEnvelopeDigest,
                candidateBundleDigest: null,
                bindingDigest: marker.markerDigest,
                refusalIdentity: {
                    argvDigest: authorityRefusalDigest({ argv: [...args] }),
                },
            }, refusal, { now: overrides.now?.() ?? new Date() });
        }
        catch (auditError) {
            attachHarnessRefusalAuditFailure(refusal, auditError);
        }
    }
    function attachHarnessRefusalAuditFailure(refusal, auditError) {
        try {
            const currentCause = refusal.cause;
            Object.defineProperty(refusal, 'cause', {
                configurable: true,
                enumerable: false,
                value: currentCause === undefined
                    ? auditError
                    : new AggregateError([currentCause, auditError], 'Recovery refusal audit also failed.'),
                writable: false,
            });
        }
        catch {
            // The stable refusal stays authoritative if diagnostic attachment fails.
        }
    }
    function productionRecoveryTrustRootAuditSink(repositoryRoot) {
        return {
            append(record) {
                recordAuthorityAuditEvent({
                    externalAuditRoot: record.externalAuditRoot,
                    repositoryRoot,
                    repositoryId: deriveAuthorityAuditRepositoryId(record.repositoryId),
                }, {
                    eventType: 'recovery',
                    occurredAt: record.recordedAt,
                    idempotencyKey: record.recordId,
                    grantDigest: record.envelopeDigest,
                    candidateBundleDigest: record.rootDigest,
                    prestateDigest: record.previousPointerDigest,
                    poststateDigest: record.newPointerDigest,
                    actor: { kind: 'human', identity: record.humanSigner },
                    taskId: null,
                    changeId: null,
                    workflowId: record.grantId,
                    command: {
                        name: 'recovery-authority.restore-trust-root',
                        argvDigest: record.recordDigest,
                    },
                    providerInvocation: null,
                    externalEffect: null,
                    result: 'succeeded',
                    outcomeDigest: record.terminalDigest,
                    errorCode: null,
                });
            },
        };
    }
    function productionRecoveryQuarantineAuditSink(repositoryRoot) {
        return {
            append(record) {
                recordAuthorityAuditEvent({
                    externalAuditRoot: record.externalAuditRoot,
                    repositoryRoot,
                    repositoryId: deriveAuthorityAuditRepositoryId(record.repositoryId),
                }, {
                    eventType: record.event === 'quarantine-entered'
                        ? 'recovery'
                        : 'grant-consume',
                    occurredAt: record.recordedAt,
                    idempotencyKey: record.recordId,
                    grantDigest: record.envelopeDigest,
                    candidateBundleDigest: null,
                    prestateDigest: record.event === 'quarantine-released'
                        ? record.markerDigest
                        : null,
                    poststateDigest: record.event === 'quarantine-entered'
                        ? record.markerDigest
                        : null,
                    actor: { kind: 'human', identity: record.humanSigner },
                    taskId: null,
                    changeId: null,
                    workflowId: record.grantId,
                    command: {
                        name: record.event === 'quarantine-entered'
                            ? 'recovery-quarantine.enter'
                            : 'recovery-quarantine.release',
                        argvDigest: record.recordDigest,
                    },
                    providerInvocation: null,
                    externalEffect: null,
                    result: 'succeeded',
                    outcomeDigest: record.receiptDigest,
                    errorCode: null,
                });
            },
        };
    }
    return {
        auditHarnessRecoveryRefusal,
        productionRecoveryTrustRootAuditSink,
        productionRecoveryQuarantineAuditSink,
    };
}
