import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import type {
  TaskMandateProviderLifecycleBindings,
  TaskMandateProviderLifecycleTypes,
} from './task-mandate.ts';

type TaskMandateBinding =
  TaskMandateProviderLifecycleTypes['TaskMandateBinding'];

type TaskMandateProviderReservationOperation =
  TaskMandateProviderLifecycleTypes['TaskMandateProviderReservationOperation'];

type TaskMandateOptions =
  TaskMandateProviderLifecycleTypes['TaskMandateOptions'];

type TaskMandateProviderReservationAuthorization =
  TaskMandateProviderLifecycleTypes['TaskMandateProviderReservationAuthorization'];

type TaskMandateProviderInvocationAuditInput =
  TaskMandateProviderLifecycleTypes['TaskMandateProviderInvocationAuditInput'];

type AuthorityAuditRecordedEvent =
  TaskMandateProviderLifecycleTypes['AuthorityAuditRecordedEvent'];

export function createTaskMandateProviderLifecycle({
  assertTaskMandateBinding,
  assertProviderReservationId,
  discoverRepository,
  taskMandateStorePaths,
  withRepositoryLifecycleOperation,
  readTaskRecord,
  validateTaskMandateEnvelopeForRepository,
  exactDate,
  assertRecordActive,
  assertExactTaskMandateBinding,
  appendTaskMandateAuthorizationAudit,
  assertProviderInvocationAuditInput,
  findTaskMandateProviderReservation,
  appendTaskMandateProviderInvocationAudit,
  assertProviderReservationOperation,
  taskMandateProviderOperationDigest,
  appendTaskMandateProviderReservationAudit,
  authorizeProviderCall,
  replacePrivateFileAtomic,
  taskRecordPath,
  canonicalTaskMandateRecord,
  unsafeStore,
}: TaskMandateProviderLifecycleBindings) {
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
      repository.repositoryRoot,
      record.envelope,
      options.signer,
    );
    const bindingNow = exactDate(options.now ?? new Date());
    assertRecordActive(record, bindingNow);
    assertExactTaskMandateBinding(record, exactBinding);
    appendTaskMandateAuthorizationAudit(
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
      repositoryRoot,
      record.envelope,
      options.signer,
    );
    const invocationNow = exactDate(options.now ?? new Date());
    assertRecordActive(record, invocationNow);
    assertExactTaskMandateBinding(record, exactBinding);
    appendTaskMandateAuthorizationAudit(repositoryRoot, record, invocationNow);
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
      repositoryRoot,
      record.envelope,
      options.signer,
    );
    const now = exactDate(options.now ?? new Date());
    assertRecordActive(record, now);
    assertExactTaskMandateBinding(record, exactBinding);
    appendTaskMandateAuthorizationAudit(repositoryRoot, record, now);
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
