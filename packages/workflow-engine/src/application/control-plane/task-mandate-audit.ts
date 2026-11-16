/** Append canonical mandate events through the required audit sink. */
import { type AuthorityAuditRecordedEvent } from '../../modules/authority/authority-audit-contract.ts';
import {
  taskMandateAuthorizationAuditInput,
  taskMandateProviderInvocationAuditInput,
  taskMandateProviderReservationAuditInput,
  taskMandateRevocationAuditInput,
} from '../../modules/authority/task-mandate-audit.ts';
import { type TaskMandateAuditServices } from '../../modules/authority/task-mandate-services.ts';
import {
  type StoredTaskMandateProviderUsage,
  type TaskMandateProviderInvocationAuditInput,
  type TaskMandateRecord,
} from '../../modules/authority/task-mandate-values.ts';
import { type ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';

export function appendTaskMandateAuthorizationAudit(
  audit: Pick<TaskMandateAuditServices, 'recordAuthorityAuditEvent'>,
  repositoryRoot: string,
  record: TaskMandateRecord,
  now?: Date,
): AuthorityAuditRecordedEvent {
  const { recordAuthorityAuditEvent } = audit;
  const [scope, event] = taskMandateAuthorizationAuditInput(
    repositoryRoot,
    record,
  );
  return recordAuthorityAuditEvent(
    scope,
    event,
    now === undefined ? {} : { now: () => now },
  );
}
export function appendTaskMandateRevocationAudit(
  audit: Pick<TaskMandateAuditServices, 'recordAuthorityAuditEvent'>,
  repositoryRoot: string,
  record: TaskMandateRecord,
  now?: Date,
): AuthorityAuditRecordedEvent {
  const { recordAuthorityAuditEvent } = audit;
  const [scope, event] = taskMandateRevocationAuditInput(
    repositoryRoot,
    record,
  );
  return recordAuthorityAuditEvent(
    scope,
    event,
    now === undefined ? {} : { now: () => now },
  );
}
export function appendTaskMandateProviderReservationAudit(
  audit: Pick<TaskMandateAuditServices, 'recordAuthorityAuditEvent'>,
  repositoryRoot: string,
  record: TaskMandateRecord,
  providerId: ProviderId,
  reservation: StoredTaskMandateProviderUsage['reservations'][number],
): AuthorityAuditRecordedEvent {
  const { recordAuthorityAuditEvent } = audit;
  const [scope, event] = taskMandateProviderReservationAuditInput(
    repositoryRoot,
    record,
    providerId,
    reservation,
  );
  return recordAuthorityAuditEvent(scope, event);
}
export function appendTaskMandateProviderInvocationAudit(
  audit: Pick<TaskMandateAuditServices, 'recordAuthorityAuditEvent'>,
  repositoryRoot: string,
  record: TaskMandateRecord,
  input: TaskMandateProviderInvocationAuditInput,
): AuthorityAuditRecordedEvent {
  const { recordAuthorityAuditEvent } = audit;
  const [scope, event] = taskMandateProviderInvocationAuditInput(
    repositoryRoot,
    record,
    input,
  );
  return recordAuthorityAuditEvent(scope, event);
}
