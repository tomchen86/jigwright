/** Authority capabilities required by actual mandate consumers. */
import { type AuthorityAuditRecordedEvent } from './authority-audit-contract.ts';
import { type MaintainerSignerProvider } from './maintainer-signer-port.ts';
import type { TaskMandateBinding } from './task-mandate-contract.ts';
import {
  type TaskMandateOperation,
  type TaskMandateProviderInvocationAuditInput,
  type TaskMandateProviderReservationOperation,
  type TaskMandateProviderUsage,
} from './task-mandate-values.ts';

export type TaskMandateOptions = {
  now?: Date;
  signer?: MaintainerSignerProvider;
};

export type TaskMandateOperationOptions = TaskMandateOptions & {
  changeId: string;
};

export type TaskMandateProviderReservationAuthorization = {
  authorized: true;
  binding: TaskMandateBinding;
  reservationId: string;
  providerUsage: TaskMandateProviderUsage;
  replay: boolean;
  audit: AuthorityAuditRecordedEvent;
};
export interface TaskMandateActiveBinding {
  inspectActiveTaskMandateBinding(
    cwd: string,
    requestedTaskId: string,
    options?: TaskMandateOptions,
  ): TaskMandateBinding;
  withActiveTaskMandateBinding<T>(
    cwd: string,
    requestedTaskId: string,
    options: TaskMandateOptions,
    operation: (binding: TaskMandateBinding, assertOwned: () => void) => T,
  ): T;
  assertActiveTaskMandateBindingUnderLifecycleLock(
    cwd: string,
    binding: TaskMandateBinding,
    assertOwned: () => void,
    options?: TaskMandateOptions,
  ): TaskMandateBinding;
}
export interface TaskMandateProviderAdmission {
  authorizeTaskMandateProviderReservationUnderLifecycleLock(
    cwd: string,
    binding: TaskMandateBinding,
    requestedReservationId: string,
    operation: TaskMandateProviderReservationOperation,
    assertOwned: () => void,
    options?: TaskMandateOptions,
  ): TaskMandateProviderReservationAuthorization;
  recordTaskMandateProviderInvocationUnderLifecycleLock(
    cwd: string,
    binding: TaskMandateBinding,
    input: TaskMandateProviderInvocationAuditInput,
    assertOwned: () => void,
    options?: TaskMandateOptions,
  ): AuthorityAuditRecordedEvent;
}
export interface TaskMandatePreparationAuthorization {
  authorizeTaskMandateOperation(
    cwd: string,
    requestedTaskId: string,
    operation: Exclude<TaskMandateOperation, { kind: 'provider-call' }>,
    options: TaskMandateOperationOptions,
  ): {
    authorized: true;
    mandateId: string;
    taskId: string;
    binding: TaskMandateBinding;
  };
}
