/** Pure mandate audit scope, refusal binding and canonical event inputs. */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { type ProviderId } from '../provider-orchestration/provider-registry.ts';
import {
  deriveAuthorityAuditRepositoryId,
  type AuthorityAuditEventInput,
  type AuthorityAuditLedgerScope,
  type AuthorityRefusalAuditBinding,
  type Sha256Digest,
} from './authority-audit-contract.ts';
import {
  unsafeStore,
  type StoredTaskMandateProviderUsage,
  type TaskMandatePayload,
  type TaskMandateProviderInvocationAuditInput,
  type TaskMandateRecord,
} from './task-mandate-values.ts';
import { taskMandateBinding } from './task-mandate.ts';

export function taskMandateAuditScope(
  repositoryRoot: string,
  payload: TaskMandatePayload,
): AuthorityAuditLedgerScope {
  return {
    externalAuditRoot: payload.externalAuditRoot,
    repositoryRoot,
    repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
  };
}

export function taskMandateRefusalBinding(
  repositoryRoot: string,
  record: TaskMandateRecord,
  operation: string,
  refusalIdentity: Readonly<Record<string, unknown>>,
): AuthorityRefusalAuditBinding {
  const binding = taskMandateBinding(record);
  const grantDigest = prefixedDigest(binding.mandateDigest);
  return {
    scope: taskMandateAuditScope(repositoryRoot, record.envelope.payload),
    family: 'task-mandate',
    operation,
    subjectId: record.mandateId,
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: record.taskId,
    changeId: record.changeId,
    workflowId: record.mandateId,
    grantDigest,
    bindingDigest: grantDigest,
    refusalIdentity: {
      mandateId: record.mandateId,
      ...refusalIdentity,
    },
  };
}

export function taskMandateAuthorizationAuditInput(
  repositoryRoot: string,
  record: TaskMandateRecord,
): readonly [AuthorityAuditLedgerScope, AuthorityAuditEventInput] {
  const binding = taskMandateBinding(record);
  const grantDigest = prefixedDigest(binding.mandateDigest);
  return [
    taskMandateAuditScope(repositoryRoot, record.envelope.payload),
    {
      eventType: 'task-mandate',
      occurredAt: record.envelope.payload.issuedAt,
      idempotencyKey: auditValueDigest({
        kind: 'task-mandate-authorization-audit.v1',
        mandateId: record.mandateId,
        grantDigest,
      }),
      actor: { kind: 'human', identity: record.envelope.payload.signer },
      taskId: record.taskId,
      changeId: record.changeId,
      workflowId: record.mandateId,
      grantDigest,
      candidateBundleDigest: null,
      prestateDigest: null,
      poststateDigest: auditValueDigest({
        kind: 'task-mandate-authorized-poststate.v1',
        mandateId: record.mandateId,
        issuedAt: record.envelope.payload.issuedAt,
        state: 'active',
      }),
      command: {
        name: 'task.authorize',
        argvDigest: auditValueDigest({
          changeId: record.changeId,
          taskId: record.taskId,
          grantDigest,
        }),
      },
      providerInvocation: null,
      externalEffect: null,
      result: 'recorded',
      outcomeDigest: auditValueDigest({
        kind: 'task-mandate-authorization-outcome.v1',
        binding,
      }),
      errorCode: null,
    },
  ];
}

export function taskMandateRevocationAuditInput(
  repositoryRoot: string,
  record: TaskMandateRecord,
): readonly [AuthorityAuditLedgerScope, AuthorityAuditEventInput] {
  if (
    record.state !== 'revoked' ||
    record.revokedAt === null ||
    record.revocationReason === null
  ) {
    throw unsafeStore();
  }
  const binding = taskMandateBinding(record);
  const grantDigest = prefixedDigest(binding.mandateDigest);
  return [
    taskMandateAuditScope(repositoryRoot, record.envelope.payload),
    {
      eventType: 'revoke',
      occurredAt: record.revokedAt,
      idempotencyKey: auditValueDigest({
        kind: 'task-mandate-revocation-audit.v1',
        mandateId: record.mandateId,
        revokedAt: record.revokedAt,
      }),
      actor: { kind: 'human', identity: record.envelope.payload.signer },
      taskId: record.taskId,
      changeId: record.changeId,
      workflowId: record.mandateId,
      grantDigest,
      candidateBundleDigest: null,
      prestateDigest: auditValueDigest({
        kind: 'task-mandate-revocation-prestate.v1',
        mandateId: record.mandateId,
        state: 'active',
      }),
      poststateDigest: auditValueDigest({
        kind: 'task-mandate-revocation-poststate.v1',
        mandateId: record.mandateId,
        revokedAt: record.revokedAt,
        reasonDigest: auditValueDigest(record.revocationReason),
        state: 'revoked',
      }),
      command: {
        name: 'task.revoke',
        argvDigest: auditValueDigest({
          taskId: record.taskId,
          reasonDigest: auditValueDigest(record.revocationReason),
        }),
      },
      providerInvocation: null,
      externalEffect: null,
      result: 'revoked',
      outcomeDigest: auditValueDigest({
        kind: 'task-mandate-revocation-outcome.v1',
        mandateId: record.mandateId,
        revokedAt: record.revokedAt,
      }),
      errorCode: null,
    },
  ];
}

export function taskMandateProviderReservationAuditInput(
  repositoryRoot: string,
  record: TaskMandateRecord,
  providerId: ProviderId,
  reservation: StoredTaskMandateProviderUsage['reservations'][number],
): readonly [AuthorityAuditLedgerScope, AuthorityAuditEventInput] {
  const grantDigest = prefixedDigest(taskMandateBinding(record).mandateDigest);
  const requestDigest = prefixedDigest(reservation.requestDigest);
  return [
    taskMandateAuditScope(repositoryRoot, record.envelope.payload),
    {
      eventType: 'grant-consume',
      occurredAt: reservation.authorizedAt,
      idempotencyKey: auditValueDigest({
        kind: 'task-mandate-provider-reservation-audit.v1',
        mandateId: record.mandateId,
        reservationId: reservation.reservationId,
        operationDigest: reservation.operationDigest,
      }),
      actor: { kind: 'engine', identity: 'workflow-engine' },
      taskId: record.taskId,
      changeId: record.changeId,
      workflowId: reservation.reservationId,
      grantDigest,
      candidateBundleDigest: null,
      prestateDigest: auditValueDigest({
        kind: 'task-mandate-provider-reservation-prestate.v1',
        mandateId: record.mandateId,
        providerId,
      }),
      poststateDigest: auditValueDigest({
        kind: 'task-mandate-provider-reservation-poststate.v1',
        mandateId: record.mandateId,
        providerId,
        reservationId: reservation.reservationId,
        operationDigest: reservation.operationDigest,
      }),
      command: {
        name: 'provider.reserve',
        argvDigest: auditValueDigest({
          providerId,
          reservationId: reservation.reservationId,
          requestDigest,
        }),
      },
      providerInvocation: {
        providerId,
        invocationId: reservation.reservationId,
        requestDigest,
      },
      externalEffect: null,
      result: 'recorded',
      outcomeDigest: auditValueDigest({
        kind: 'task-mandate-provider-reservation-outcome.v1',
        providerId,
        reservation,
      }),
      errorCode: null,
    },
  ];
}

export function taskMandateProviderInvocationAuditInput(
  repositoryRoot: string,
  record: TaskMandateRecord,
  input: TaskMandateProviderInvocationAuditInput,
): readonly [AuthorityAuditLedgerScope, AuthorityAuditEventInput] {
  const grantDigest = prefixedDigest(taskMandateBinding(record).mandateDigest);
  const requestDigest = prefixedDigest(input.requestDigest);
  return [
    taskMandateAuditScope(repositoryRoot, record.envelope.payload),
    {
      eventType: 'provider-invocation',
      occurredAt: input.occurredAt,
      idempotencyKey: auditValueDigest({
        kind: 'task-mandate-provider-invocation-audit.v1',
        mandateId: record.mandateId,
        invocationId: input.invocationId,
        requestDigest,
      }),
      actor: { kind: 'engine', identity: 'provider-worker' },
      taskId: record.taskId,
      changeId: record.changeId,
      workflowId: input.invocationId,
      grantDigest,
      candidateBundleDigest: null,
      prestateDigest: auditValueDigest({
        kind: 'task-mandate-provider-invocation-prestate.v1',
        invocationId: input.invocationId,
        state: 'prepared',
      }),
      poststateDigest: auditValueDigest({
        kind: 'task-mandate-provider-invocation-poststate.v1',
        invocationId: input.invocationId,
        state: 'dispatch-authorized',
      }),
      command: null,
      providerInvocation: {
        providerId: input.providerId,
        invocationId: input.invocationId,
        requestDigest,
      },
      externalEffect: null,
      result: 'recorded',
      outcomeDigest: auditValueDigest({
        kind: 'task-mandate-provider-invocation-outcome.v1',
        providerId: input.providerId,
        invocationId: input.invocationId,
        requestDigest,
      }),
      errorCode: null,
    },
  ];
}

function auditValueDigest(value: unknown): Sha256Digest {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function prefixedDigest(value: string): Sha256Digest {
  if (!/^[0-9a-f]{64}$/.test(value)) throw unsafeStore();
  return `sha256:${value}`;
}
