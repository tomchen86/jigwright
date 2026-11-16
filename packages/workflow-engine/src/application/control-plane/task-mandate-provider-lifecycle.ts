/** Provider reservations and invocation audit with exact lifecycle ownership and replay. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type AuthorityAuditRecordedEvent } from '../../modules/authority/authority-audit-contract.ts';
import {
  type TaskMandateOptions,
  type TaskMandateProviderReservationAuthorization,
} from '../../modules/authority/task-mandate-access-contract.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import {
  assertProviderInvocationAuditInput,
  assertProviderReservationId,
  assertProviderReservationOperation,
  assertTaskMandateBinding,
  authorizeProviderCall,
  findTaskMandateProviderReservation,
  taskMandateProviderOperationDigest,
} from '../../modules/authority/task-mandate-policy.ts';
import { canonicalTaskMandateRecord } from '../../modules/authority/task-mandate-records.ts';
import { type TaskMandateServices } from '../../modules/authority/task-mandate-services.ts';
import {
  exactDate,
  unsafeStore,
  type TaskMandateProviderInvocationAuditInput,
  type TaskMandateProviderReservationOperation,
} from '../../modules/authority/task-mandate-values.ts';
import {
  assertExactTaskMandateBinding,
  assertRecordActive,
} from '../../modules/authority/task-mandate.ts';
import {
  appendTaskMandateAuthorizationAudit,
  appendTaskMandateProviderInvocationAudit,
  appendTaskMandateProviderReservationAudit,
} from './task-mandate-audit.ts';
import { validateTaskMandateEnvelopeForRepository } from './task-mandate-trust.ts';

export function createTaskMandateProviderLifecycle(
  services: TaskMandateServices,
) {
  const { now: clockNow, withRepositoryLifecycleOperation } = services;
  const { discoverRepository } = services.repository;
  const {
    taskMandateStorePaths,
    readTaskRecord,
    replacePrivateFileAtomic,
    taskRecordPath,
  } = services.store;
  function authorizeTaskMandateProviderReservation(
    cwd: string,
    binding: TaskMandateBinding,
    requestedReservationId: string,
    operation: TaskMandateProviderReservationOperation,
    options: TaskMandateOptions = {},
  ): TaskMandateProviderReservationAuthorization {
    const exactBinding = assertTaskMandateBinding(binding);
    const reservationId = assertProviderReservationId(requestedReservationId);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
      authorizeTaskMandateProviderReservationLocked(
        repository.repositoryRoot,
        paths,
        exactBinding,
        reservationId,
        operation,
        options,
        assertOwned,
      ),
    );
  }

  function authorizeTaskMandateProviderReservationUnderLifecycleLock(
    cwd: string,
    binding: TaskMandateBinding,
    requestedReservationId: string,
    operation: TaskMandateProviderReservationOperation,
    assertOwned: () => void,
    options: TaskMandateOptions = {},
  ): TaskMandateProviderReservationAuthorization {
    const exactBinding = assertTaskMandateBinding(binding);
    const reservationId = assertProviderReservationId(requestedReservationId);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    assertOwned();
    return authorizeTaskMandateProviderReservationLocked(
      repository.repositoryRoot,
      paths,
      exactBinding,
      reservationId,
      operation,
      options,
      assertOwned,
    );
  }

  function assertActiveTaskMandateBindingUnderLifecycleLock(
    cwd: string,
    binding: TaskMandateBinding,
    assertOwned: () => void,
    options: TaskMandateOptions = {},
  ): TaskMandateBinding {
    const exactBinding = assertTaskMandateBinding(binding);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    assertOwned();
    const record = readTaskRecord(paths, exactBinding.mandateTaskId);
    validateTaskMandateEnvelopeForRepository(
      services,
      repository.repositoryRoot,
      record.envelope,
      options.signer,
    );
    const bindingNow = exactDate(options.now ?? clockNow());
    assertRecordActive(record, bindingNow);
    assertExactTaskMandateBinding(record, exactBinding);
    appendTaskMandateAuthorizationAudit(
      services.audit,
      repository.repositoryRoot,
      record,
      bindingNow,
    );
    assertOwned();
    return exactBinding;
  }

  function recordTaskMandateProviderInvocation(
    cwd: string,
    binding: TaskMandateBinding,
    input: TaskMandateProviderInvocationAuditInput,
    options: TaskMandateOptions = {},
  ): AuthorityAuditRecordedEvent {
    const exactBinding = assertTaskMandateBinding(binding);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
      recordTaskMandateProviderInvocationLocked(
        repository.repositoryRoot,
        paths,
        exactBinding,
        input,
        options,
        assertOwned,
      ),
    );
  }

  function recordTaskMandateProviderInvocationUnderLifecycleLock(
    cwd: string,
    binding: TaskMandateBinding,
    input: TaskMandateProviderInvocationAuditInput,
    assertOwned: () => void,
    options: TaskMandateOptions = {},
  ): AuthorityAuditRecordedEvent {
    const exactBinding = assertTaskMandateBinding(binding);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    assertOwned();
    return recordTaskMandateProviderInvocationLocked(
      repository.repositoryRoot,
      paths,
      exactBinding,
      input,
      options,
      assertOwned,
    );
  }

  function recordTaskMandateProviderInvocationLocked(
    repositoryRoot: string,
    paths: ReturnType<typeof taskMandateStorePaths>,
    exactBinding: TaskMandateBinding,
    rawInput: TaskMandateProviderInvocationAuditInput,
    options: TaskMandateOptions,
    assertOwned: () => void,
  ): AuthorityAuditRecordedEvent {
    const input = assertProviderInvocationAuditInput(rawInput);
    const record = readTaskRecord(paths, exactBinding.mandateTaskId);
    validateTaskMandateEnvelopeForRepository(
      services,
      repositoryRoot,
      record.envelope,
      options.signer,
    );
    const invocationNow = exactDate(options.now ?? clockNow());
    assertRecordActive(record, invocationNow);
    assertExactTaskMandateBinding(record, exactBinding);
    appendTaskMandateAuthorizationAudit(
      services.audit,
      repositoryRoot,
      record,
      invocationNow,
    );
    const reservation = findTaskMandateProviderReservation(
      record,
      input.invocationId,
    );
    if (
      reservation === null ||
      reservation.providerId !== input.providerId ||
      reservation.reservation.requestDigest !== input.requestDigest
    ) {
      throw workflowError(
        'TASK_MANDATE_PROVIDER_INVOCATION_UNRESERVED',
        'Provider invocation has no exact durable Task Mandate reservation.',
        ExitCode.guard,
      );
    }
    assertOwned();
    const audit = appendTaskMandateProviderInvocationAudit(
      services.audit,
      repositoryRoot,
      record,
      input,
    );
    assertOwned();
    return audit;
  }

  function authorizeTaskMandateProviderReservationLocked(
    repositoryRoot: string,
    paths: ReturnType<typeof taskMandateStorePaths>,
    exactBinding: TaskMandateBinding,
    reservationId: string,
    operation: TaskMandateProviderReservationOperation,
    options: TaskMandateOptions,
    assertOwned: () => void,
  ): TaskMandateProviderReservationAuthorization {
    const record = readTaskRecord(paths, exactBinding.mandateTaskId);
    validateTaskMandateEnvelopeForRepository(
      services,
      repositoryRoot,
      record.envelope,
      options.signer,
    );
    const now = exactDate(options.now ?? clockNow());
    assertRecordActive(record, now);
    assertExactTaskMandateBinding(record, exactBinding);
    appendTaskMandateAuthorizationAudit(
      services.audit,
      repositoryRoot,
      record,
      now,
    );
    const checkedOperation = assertProviderReservationOperation(operation);
    const operationDigest =
      taskMandateProviderOperationDigest(checkedOperation);
    const existing = findTaskMandateProviderReservation(record, reservationId);
    if (existing !== null) {
      if (
        existing.providerId !== checkedOperation.providerId ||
        existing.reservation.requestDigest !== checkedOperation.requestDigest ||
        existing.reservation.operationDigest !== operationDigest
      ) {
        throw workflowError(
          'TASK_MANDATE_PROVIDER_RESERVATION_CONFLICT',
          'Provider reservation replay does not match its exact authorized call.',
          ExitCode.conflict,
        );
      }
      const audit = appendTaskMandateProviderReservationAudit(
        services.audit,
        repositoryRoot,
        record,
        existing.providerId,
        existing.reservation,
      );
      return {
        authorized: true,
        binding: exactBinding,
        reservationId,
        providerUsage: {
          invocations: existing.usage.invocations,
          budget: existing.usage.budget,
        },
        replay: true,
        audit,
      };
    }
    assertOwned();
    const providerUsage = authorizeProviderCall(
      record,
      checkedOperation,
      reservationId,
      now.toISOString(),
      operationDigest,
    );
    record.lastActivityAt = now.toISOString();
    replacePrivateFileAtomic(
      taskRecordPath(paths.active, exactBinding.mandateTaskId),
      canonicalTaskMandateRecord(record),
    );
    assertOwned();
    const stored = findTaskMandateProviderReservation(record, reservationId);
    if (stored === null) throw unsafeStore();
    const audit = appendTaskMandateProviderReservationAudit(
      services.audit,
      repositoryRoot,
      record,
      stored.providerId,
      stored.reservation,
    );
    assertOwned();
    return {
      authorized: true,
      binding: exactBinding,
      reservationId,
      providerUsage,
      replay: false,
      audit,
    };
  }

  return {
    authorizeTaskMandateProviderReservation,
    authorizeTaskMandateProviderReservationUnderLifecycleLock,
    assertActiveTaskMandateBindingUnderLifecycleLock,
    recordTaskMandateProviderInvocation,
    recordTaskMandateProviderInvocationUnderLifecycleLock,
  };
}
