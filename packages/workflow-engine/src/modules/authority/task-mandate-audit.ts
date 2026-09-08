import { type AuthorityRefusalAuditBinding } from './authority-refusal-audit.ts';

import { type ProviderId } from '../provider-orchestration/provider-registry.ts';

import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import type {
  TaskMandateAuditBindings,
  TaskMandateAuditTypes,
} from './task-mandate.ts';

type TaskMandatePayload = TaskMandateAuditTypes['TaskMandatePayload'];

type AuthorityAuditLedgerScope =
  TaskMandateAuditTypes['AuthorityAuditLedgerScope'];

type TaskMandateRecord = TaskMandateAuditTypes['TaskMandateRecord'];

type AuthorityAuditRecordedEvent =
  TaskMandateAuditTypes['AuthorityAuditRecordedEvent'];

type StoredTaskMandateProviderUsage =
  TaskMandateAuditTypes['StoredTaskMandateProviderUsage'];

type TaskMandateProviderInvocationAuditInput =
  TaskMandateAuditTypes['TaskMandateProviderInvocationAuditInput'];

type Sha256Digest = TaskMandateAuditTypes['Sha256Digest'];

export function createTaskMandateAudit({
  deriveAuthorityAuditRepositoryId,
  taskMandateBinding,
  recordAuthorityAuditEvent,
  unsafeStore,
}: TaskMandateAuditBindings) {
  function taskMandateAuditScope(
    repositoryRoot: string,
    payload: TaskMandatePayload,
  ): AuthorityAuditLedgerScope {
    return {
      externalAuditRoot: payload.externalAuditRoot,
      repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
    };
  }

  function taskMandateRefusalBinding(
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

  function appendTaskMandateAuthorizationAudit(
    repositoryRoot: string,
    record: TaskMandateRecord,
    now?: Date,
  ): AuthorityAuditRecordedEvent {
    const binding = taskMandateBinding(record);
    const grantDigest = prefixedDigest(binding.mandateDigest);
    return recordAuthorityAuditEvent(
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
      now === undefined ? {} : { now: () => now },
    );
  }

  /**
   * The ledger rejects an event stamped far ahead of its own clock. The event
   * time here comes from the caller's clock, so the append has to read the same
   * one — otherwise any operation running on an injected clock records a time
   * the ledger then refuses.
   */
  function appendTaskMandateRevocationAudit(
    repositoryRoot: string,
    record: TaskMandateRecord,
    now?: Date,
  ): AuthorityAuditRecordedEvent {
    if (
      record.state !== 'revoked' ||
      record.revokedAt === null ||
      record.revocationReason === null
    ) {
      throw unsafeStore();
    }
    const binding = taskMandateBinding(record);
    const grantDigest = prefixedDigest(binding.mandateDigest);
    return recordAuthorityAuditEvent(
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
      now === undefined ? {} : { now: () => now },
    );
  }

  function appendTaskMandateProviderReservationAudit(
    repositoryRoot: string,
    record: TaskMandateRecord,
    providerId: ProviderId,
    reservation: StoredTaskMandateProviderUsage['reservations'][number],
  ): AuthorityAuditRecordedEvent {
    const grantDigest = prefixedDigest(
      taskMandateBinding(record).mandateDigest,
    );
    const requestDigest = prefixedDigest(reservation.requestDigest);
    return recordAuthorityAuditEvent(
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
    );
  }

  function appendTaskMandateProviderInvocationAudit(
    repositoryRoot: string,
    record: TaskMandateRecord,
    input: TaskMandateProviderInvocationAuditInput,
  ): AuthorityAuditRecordedEvent {
    const grantDigest = prefixedDigest(
      taskMandateBinding(record).mandateDigest,
    );
    const requestDigest = prefixedDigest(input.requestDigest);
    return recordAuthorityAuditEvent(
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
    );
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

  return {
    taskMandateAuditScope,
    taskMandateRefusalBinding,
    appendTaskMandateAuthorizationAudit,
    appendTaskMandateRevocationAudit,
    appendTaskMandateProviderReservationAudit,
    appendTaskMandateProviderInvocationAudit,
  };
}
