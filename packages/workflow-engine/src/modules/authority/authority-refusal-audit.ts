/** Pure refusal identity/event construction and original-error preservation. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import {
  sha256Digest,
  type AuthorityAuditEventInput,
  type AuthorityRefusalAuditBinding,
  type AuthorityRefusalAuditOptions,
  type RecordAuthorityRefusal,
  type Sha256Digest,
} from './authority-audit-contract.ts';

/** Retain this identity across the durable occurrence lookup; it omits time. */
export function createAuthorityRefusalIdentity(
  binding: AuthorityRefusalAuditBinding,
  error: WorkflowError,
) {
  const identity = {
    schemaVersion: 1,
    kind: 'authority-refusal-audit-identity.v1',
    family: binding.family,
    operation: binding.operation,
    subjectId: binding.subjectId,
    actor: binding.actor,
    taskId: binding.taskId,
    changeId: binding.changeId,
    workflowId: binding.workflowId,
    grantDigest: binding.grantDigest,
    bindingDigest: binding.bindingDigest,
    refusalIdentity: binding.refusalIdentity,
    errorCode: error.code,
  };
  const idempotencyKey = sha256Digest(canonicalJson(identity));
  return { identity, idempotencyKey };
}

/** Build event bytes only after the persistence owner selects occurredAt. */
export function createAuthorityRefusalEventInput(
  binding: AuthorityRefusalAuditBinding,
  error: WorkflowError,
  {
    identity,
    idempotencyKey,
  }: ReturnType<typeof createAuthorityRefusalIdentity>,
  occurredAt: string,
): AuthorityAuditEventInput {
  const outcomeDigest = sha256Digest(
    canonicalJson({
      schemaVersion: 1,
      kind: 'authority-refusal-audit-outcome.v1',
      identity,
      result: 'failed',
    }),
  );
  return {
    eventType: 'error',
    occurredAt,
    idempotencyKey,
    actor: binding.actor,
    taskId: binding.taskId,
    changeId: binding.changeId,
    workflowId: binding.workflowId,
    grantDigest: binding.grantDigest,
    candidateBundleDigest: binding.candidateBundleDigest ?? null,
    prestateDigest: binding.bindingDigest,
    poststateDigest: null,
    command: {
      name: binding.operation,
      argvDigest: sha256Digest(
        canonicalJson({
          family: binding.family,
          operation: binding.operation,
          subjectId: binding.subjectId,
          refusalIdentity: binding.refusalIdentity,
        }),
      ),
    },
    providerInvocation: null,
    externalEffect: null,
    result: 'failed',
    outcomeDigest,
    errorCode: error.code,
  };
}

export function withAuthorityRefusalAudit<T>(
  recordAuthorityRefusal: RecordAuthorityRefusal,
  binding: AuthorityRefusalAuditBinding,
  options: AuthorityRefusalAuditOptions,
  operation: () => T,
): T {
  try {
    return operation();
  } catch (error) {
    if (
      !(error instanceof WorkflowError) ||
      error.code.startsWith('AUTHORITY_AUDIT_')
    ) {
      throw error;
    }
    try {
      recordAuthorityRefusal(binding, error, options);
    } catch (auditError) {
      attachAuthorityAuditFailure(error, auditError);
    }
    throw error;
  }
}

function attachAuthorityAuditFailure(
  refusal: WorkflowError,
  auditError: unknown,
): void {
  try {
    const currentCause = (refusal as Error & { cause?: unknown }).cause;
    const cause =
      currentCause === undefined
        ? auditError
        : new AggregateError(
            [currentCause, auditError],
            'Authority refusal audit also failed.',
          );
    Object.defineProperty(refusal, 'cause', {
      configurable: true,
      enumerable: false,
      value: cause,
      writable: false,
    });
  } catch {
    // The stable, verified refusal remains authoritative even when a frozen
    // error object cannot carry the secondary audit infrastructure failure.
  }
}

export function authorityRefusalDigest(value: unknown): Sha256Digest {
  return sha256Digest(canonicalJson(value));
}

export type {
  AuthorityRefusalAuditBinding,
  AuthorityRefusalAuditOptions,
} from './authority-audit-contract.ts';
