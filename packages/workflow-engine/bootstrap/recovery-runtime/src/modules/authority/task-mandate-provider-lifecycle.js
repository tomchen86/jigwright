/**
 * Reserves and records Task Mandate provider calls while the lifecycle lock
 * is held.
 *
 * Invariants:
 * - recordTaskMandateProviderInvocationLocked throws
 *   TASK_MANDATE_PROVIDER_INVOCATION_UNRESERVED unless a stored reservation
 *   matches the invocation's id, providerId, and requestDigest.
 * - A reservation replay with an existing id must match its providerId,
 *   requestDigest, and operationDigest, else it throws
 *   TASK_MANDATE_PROVIDER_RESERVATION_CONFLICT.
 */
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
export function createTaskMandateProviderLifecycle({ assertTaskMandateBinding, assertProviderReservationId, discoverRepository, taskMandateStorePaths, withRepositoryLifecycleOperation, readTaskRecord, validateTaskMandateEnvelopeForRepository, exactDate, assertRecordActive, assertExactTaskMandateBinding, appendTaskMandateAuthorizationAudit, assertProviderInvocationAuditInput, findTaskMandateProviderReservation, appendTaskMandateProviderInvocationAudit, assertProviderReservationOperation, taskMandateProviderOperationDigest, appendTaskMandateProviderReservationAudit, authorizeProviderCall, replacePrivateFileAtomic, taskRecordPath, canonicalTaskMandateRecord, unsafeStore, }) {
    function authorizeTaskMandateProviderReservation(cwd, binding, requestedReservationId, operation, options = {}) {
        const exactBinding = assertTaskMandateBinding(binding);
        const reservationId = assertProviderReservationId(requestedReservationId);
        const repository = discoverRepository(cwd);
        const paths = taskMandateStorePaths(repository.gitCommonDirectory);
        return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => authorizeTaskMandateProviderReservationLocked(repository.repositoryRoot, paths, exactBinding, reservationId, operation, options, assertOwned));
    }
    function authorizeTaskMandateProviderReservationUnderLifecycleLock(cwd, binding, requestedReservationId, operation, assertOwned, options = {}) {
        const exactBinding = assertTaskMandateBinding(binding);
        const reservationId = assertProviderReservationId(requestedReservationId);
        const repository = discoverRepository(cwd);
        const paths = taskMandateStorePaths(repository.gitCommonDirectory);
        assertOwned();
        return authorizeTaskMandateProviderReservationLocked(repository.repositoryRoot, paths, exactBinding, reservationId, operation, options, assertOwned);
    }
    function assertActiveTaskMandateBindingUnderLifecycleLock(cwd, binding, assertOwned, options = {}) {
        const exactBinding = assertTaskMandateBinding(binding);
        const repository = discoverRepository(cwd);
        const paths = taskMandateStorePaths(repository.gitCommonDirectory);
        assertOwned();
        const record = readTaskRecord(paths, exactBinding.mandateTaskId);
        validateTaskMandateEnvelopeForRepository(repository.repositoryRoot, record.envelope, options.signer);
        const bindingNow = exactDate(options.now ?? new Date());
        assertRecordActive(record, bindingNow);
        assertExactTaskMandateBinding(record, exactBinding);
        appendTaskMandateAuthorizationAudit(repository.repositoryRoot, record, bindingNow);
        assertOwned();
        return exactBinding;
    }
    function recordTaskMandateProviderInvocation(cwd, binding, input, options = {}) {
        const exactBinding = assertTaskMandateBinding(binding);
        const repository = discoverRepository(cwd);
        const paths = taskMandateStorePaths(repository.gitCommonDirectory);
        return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => recordTaskMandateProviderInvocationLocked(repository.repositoryRoot, paths, exactBinding, input, options, assertOwned));
    }
    function recordTaskMandateProviderInvocationUnderLifecycleLock(cwd, binding, input, assertOwned, options = {}) {
        const exactBinding = assertTaskMandateBinding(binding);
        const repository = discoverRepository(cwd);
        const paths = taskMandateStorePaths(repository.gitCommonDirectory);
        assertOwned();
        return recordTaskMandateProviderInvocationLocked(repository.repositoryRoot, paths, exactBinding, input, options, assertOwned);
    }
    function recordTaskMandateProviderInvocationLocked(repositoryRoot, paths, exactBinding, rawInput, options, assertOwned) {
        const input = assertProviderInvocationAuditInput(rawInput);
        const record = readTaskRecord(paths, exactBinding.mandateTaskId);
        validateTaskMandateEnvelopeForRepository(repositoryRoot, record.envelope, options.signer);
        const invocationNow = exactDate(options.now ?? new Date());
        assertRecordActive(record, invocationNow);
        assertExactTaskMandateBinding(record, exactBinding);
        appendTaskMandateAuthorizationAudit(repositoryRoot, record, invocationNow);
        const reservation = findTaskMandateProviderReservation(record, input.invocationId);
        if (reservation === null ||
            reservation.providerId !== input.providerId ||
            reservation.reservation.requestDigest !== input.requestDigest) {
            throw workflowError('TASK_MANDATE_PROVIDER_INVOCATION_UNRESERVED', 'Provider invocation has no exact durable Task Mandate reservation.', ExitCode.guard);
        }
        assertOwned();
        const audit = appendTaskMandateProviderInvocationAudit(repositoryRoot, record, input);
        assertOwned();
        return audit;
    }
    function authorizeTaskMandateProviderReservationLocked(repositoryRoot, paths, exactBinding, reservationId, operation, options, assertOwned) {
        const record = readTaskRecord(paths, exactBinding.mandateTaskId);
        validateTaskMandateEnvelopeForRepository(repositoryRoot, record.envelope, options.signer);
        const now = exactDate(options.now ?? new Date());
        assertRecordActive(record, now);
        assertExactTaskMandateBinding(record, exactBinding);
        appendTaskMandateAuthorizationAudit(repositoryRoot, record, now);
        const checkedOperation = assertProviderReservationOperation(operation);
        const operationDigest = taskMandateProviderOperationDigest(checkedOperation);
        const existing = findTaskMandateProviderReservation(record, reservationId);
        if (existing !== null) {
            if (existing.providerId !== checkedOperation.providerId ||
                existing.reservation.requestDigest !== checkedOperation.requestDigest ||
                existing.reservation.operationDigest !== operationDigest) {
                throw workflowError('TASK_MANDATE_PROVIDER_RESERVATION_CONFLICT', 'Provider reservation replay does not match its exact authorized call.', ExitCode.conflict);
            }
            const audit = appendTaskMandateProviderReservationAudit(repositoryRoot, record, existing.providerId, existing.reservation);
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
        const providerUsage = authorizeProviderCall(record, checkedOperation, reservationId, now.toISOString(), operationDigest);
        record.lastActivityAt = now.toISOString();
        replacePrivateFileAtomic(taskRecordPath(paths.active, exactBinding.mandateTaskId), canonicalTaskMandateRecord(record));
        assertOwned();
        const stored = findTaskMandateProviderReservation(record, reservationId);
        if (stored === null)
            throw unsafeStore();
        const audit = appendTaskMandateProviderReservationAudit(repositoryRoot, record, stored.providerId, stored.reservation);
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
