import { recordAuthorityRefusal, authorityRefusalDigest, } from "../../modules/authority/authority-refusal-audit.js";
export function createHarnessBootstrapAudit(bindings) {
    const { deriveAuthorityAuditRepositoryId, recordAuthorityAuditEvent } = bindings;
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
    function productionControlPlaneAuditSink(repositoryRoot) {
        return {
            append(record) {
                recordAuthorityAuditEvent({
                    externalAuditRoot: record.externalAuditRoot,
                    repositoryRoot,
                    repositoryId: deriveAuthorityAuditRepositoryId(record.repositoryId),
                }, {
                    eventType: controlPlaneAuditEventType(record),
                    occurredAt: record.recordedAt,
                    idempotencyKey: record.recordId,
                    grantDigest: record.grantEnvelopeDigest,
                    candidateBundleDigest: record.promotionBundleDigest,
                    prestateDigest: null,
                    poststateDigest: record.evidenceDigest,
                    actor: { kind: 'engine', identity: 'sealed-control-plane-updater' },
                    taskId: record.parentTaskId,
                    changeId: record.changeId,
                    workflowId: record.txId,
                    command: {
                        name: 'control-plane.recovery.rollback-source-transaction',
                        argvDigest: record.recordDigest,
                    },
                    providerInvocation: null,
                    externalEffect: null,
                    result: controlPlaneAuditResult(record),
                    outcomeDigest: record.recordDigest,
                    errorCode: null,
                });
            },
        };
    }
    function productionRecoveryAuditSink(repositoryRoot) {
        return {
            append(record) {
                recordAuthorityAuditEvent({
                    externalAuditRoot: record.externalAuditRoot,
                    repositoryRoot,
                    repositoryId: deriveAuthorityAuditRepositoryId(record.repositoryId),
                }, {
                    eventType: record.event === 'authorized' ||
                        record.event === 'expired' ||
                        record.event === 'failed'
                        ? 'recovery'
                        : record.event === 'rolled-back'
                            ? 'rollback'
                            : 'grant-consume',
                    occurredAt: record.recordedAt,
                    idempotencyKey: record.recordId,
                    grantDigest: record.grantEnvelopeDigest,
                    candidateBundleDigest: record.promotionBundleDigest,
                    prestateDigest: record.prestateDigest,
                    poststateDigest: record.poststateDigest,
                    actor: {
                        kind: record.event === 'authorized' ? 'human' : 'engine',
                        identity: record.event === 'authorized'
                            ? record.humanSigner
                            : 'sealed-control-plane-recovery',
                    },
                    taskId: null,
                    changeId: null,
                    workflowId: record.sourceControlPlaneGrantId,
                    command: {
                        name: 'control-plane.recovery.rollback-control-plane',
                        argvDigest: record.recordDigest,
                    },
                    providerInvocation: null,
                    externalEffect: null,
                    result: record.event === 'rolled-back'
                        ? 'rolled-back'
                        : record.event === 'consumed'
                            ? 'succeeded'
                            : record.event === 'expired' || record.event === 'failed'
                                ? 'failed'
                                : 'recorded',
                    outcomeDigest: record.receiptDigest ?? record.recordDigest,
                    errorCode: null,
                });
            },
        };
    }
    function controlPlaneAuditEventType(record) {
        switch (record.event) {
            case 'prepared':
                return 'control-plane-grant';
            case 'switched':
                return 'cas';
            case 'rollback-required':
            case 'rolled-back':
                return 'rollback';
            case 'finalized':
                return 'grant-consume';
            default:
                return 'poststate';
        }
    }
    function controlPlaneAuditResult(record) {
        return record.event === 'finalized'
            ? 'succeeded'
            : record.event === 'rolled-back'
                ? 'rolled-back'
                : 'recorded';
    }
    return {
        auditHarnessRecoveryRefusal,
        productionRecoveryTrustRootAuditSink,
        productionRecoveryQuarantineAuditSink,
        productionControlPlaneAuditSink,
        productionRecoveryAuditSink,
    };
}
