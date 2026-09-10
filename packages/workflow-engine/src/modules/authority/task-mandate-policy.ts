/**
 * Checks Task Mandate provider scope, retries and budgets, and binds
 * provider reservation identities.
 *
 * Invariants:
 * - An execution Grant bypasses the invocation ceiling for its reservation;
 *   the declared monetary ceiling still applies.
 * - taskMandateProviderOperationDigest hashes the operation with
 *   executionGrant stripped, so a reservation's identity is independent of
 *   the grant object.
 */
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import {
  type ProviderId,
  isProviderId,
} from '../provider-orchestration/provider-registry.ts';

import { isRecord } from '../../foundation/canonical-json/contract-values.ts';

import crypto from 'node:crypto';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import type {
  TaskMandatePolicyBindings,
  TaskMandatePolicyTypes,
} from './task-mandate.ts';

type TaskMandateRecord = TaskMandatePolicyTypes['TaskMandateRecord'];

type TaskMandateProviderReservationOperation =
  TaskMandatePolicyTypes['TaskMandateProviderReservationOperation'];

type TaskMandateProviderUsage =
  TaskMandatePolicyTypes['TaskMandateProviderUsage'];

type TaskMandateOperation = TaskMandatePolicyTypes['TaskMandateOperation'];

type TaskMandateProviderDeclaration =
  TaskMandatePolicyTypes['TaskMandateProviderDeclaration'];

type TaskMandateDataType = TaskMandatePolicyTypes['TaskMandateDataType'];

type TaskMandateBinding = TaskMandatePolicyTypes['TaskMandateBinding'];

type StoredTaskMandateProviderUsage =
  TaskMandatePolicyTypes['StoredTaskMandateProviderUsage'];

type TaskMandateProviderInvocationAuditInput =
  TaskMandatePolicyTypes['TaskMandateProviderInvocationAuditInput'];

export function createTaskMandatePolicy({
  mandateInvalid,
  hasExactKeys,
  DATA_TYPES,
  TASK_ID,
  canonicalTaskMandateEnvelope,
  assertMandateId,
  assertChangeId,
  assertExternalAuditRootPath,
  PROVIDER_RESERVATION_ID,
  unsafeStore,
  exactTimestamp,
}: TaskMandatePolicyBindings) {
  function authorizeProviderCall(
    record: TaskMandateRecord,
    operation: TaskMandateProviderReservationOperation,
    reservationId: string,
    authorizedAt: string,
    operationDigest: string,
  ): TaskMandateProviderUsage {
    const declaration =
      record.envelope.payload.preparation.providerCalls[operation.providerId];
    const requestedDataTypes = normalizeDataTypes(operation.dataTypes);
    if (!declaration) {
      throw workflowError(
        'TASK_MANDATE_PROVIDER_NOT_DECLARED',
        `Provider ${operation.providerId} is not declared by the task mandate.`,
        ExitCode.guard,
      );
    }
    if (
      requestedDataTypes.some(
        (dataType) => !declaration.dataTypes.includes(dataType),
      ) ||
      requestedDataTypes.includes('source-code') !== operation.sourceCode ||
      (operation.sourceCode && !declaration.sourceCode) ||
      operation.secrets ||
      (operation.retry && !declaration.retryOnFailure)
    ) {
      throw workflowError(
        'TASK_MANDATE_PROVIDER_SCOPE_EXCEEDED',
        'Provider call exceeds the data, source, secret, or retry scope in the task mandate.',
        ExitCode.guard,
      );
    }
    if (operation.retry && declaration.retryRequiresHuman) {
      throw workflowError(
        'TASK_MANDATE_HUMAN_CONFIRMATION_REQUIRED',
        'This provider retry requires a new human confirmation.',
        ExitCode.guard,
      );
    }
    const usage = record.providerUsage[operation.providerId] ?? {
      invocations: 0,
      budget: 0,
      reservations: [],
    };
    const budget = operation.budget === null ? 0 : operation.budget;
    if (!Number.isFinite(budget) || budget < 0) {
      throw mandateInvalid('Provider call budget is invalid.');
    }
    if (declaration.maxBudget !== null && operation.budget === null) {
      throw workflowError(
        'TASK_MANDATE_PROVIDER_SCOPE_EXCEEDED',
        'A metered provider declaration requires an exact call budget.',
        ExitCode.guard,
      );
    }
    // The declared budget bounds unsupervised spend. A caller holding a
    // validated, consumed execution-budget grant carries a fresh human
    // signature for exactly one bounded replacement, and that consent lifts the
    // invocation ceiling by the one reservation it names. The monetary ceiling
    // stays strict either way: granted entries record no per-call amount, so a
    // metered excess could never be attributed.
    if (
      (usage.invocations >= declaration.maxInvocations &&
        operation.executionGrant === undefined) ||
      (declaration.maxBudget !== null &&
        usage.budget + budget > declaration.maxBudget)
    ) {
      throw workflowError(
        'TASK_MANDATE_PROVIDER_BUDGET_EXHAUSTED',
        'Task mandate provider invocation or monetary budget is exhausted.',
        ExitCode.guard,
      );
    }
    const next = {
      invocations: usage.invocations + 1,
      budget: usage.budget + budget,
      reservations: [
        ...usage.reservations,
        {
          reservationId,
          authorizedAt,
          requestDigest: operation.requestDigest,
          operationDigest,
          ...(operation.executionGrant === undefined
            ? {}
            : { executionGrantId: operation.executionGrant.grantId }),
        },
      ].sort((left, right) =>
        left.reservationId.localeCompare(right.reservationId),
      ),
    };
    record.providerUsage[operation.providerId] = next;
    return { invocations: next.invocations, budget: next.budget };
  }

  function isPreparationOperation(kind: TaskMandateOperation['kind']): boolean {
    return [
      'repository-read',
      'isolated-repository-write',
      'add-delete-rename',
      'local-command',
      'draft-commit',
      'candidate-or-design-artifact',
      'read-only-connector',
    ].includes(kind);
  }

  function parseProviderDeclarations(
    value: Record<string, unknown>,
  ): Partial<Record<ProviderId, TaskMandateProviderDeclaration>> {
    const result: Partial<Record<ProviderId, TaskMandateProviderDeclaration>> =
      {};
    for (const providerId of Object.keys(value).sort()) {
      const declaration = value[providerId];
      if (!isProviderId(providerId) || !isRecord(declaration)) {
        throw mandateInvalid('Task mandate names an unknown provider.');
      }
      if (
        !hasExactKeys(declaration, [
          'maxInvocations',
          'maxBudget',
          'dataTypes',
          'sourceCode',
          'secrets',
          'retryOnFailure',
          'retryRequiresHuman',
        ]) ||
        typeof declaration.maxInvocations !== 'number' ||
        !Number.isInteger(declaration.maxInvocations) ||
        declaration.maxInvocations < 1 ||
        declaration.maxInvocations > 1000 ||
        (declaration.maxBudget !== null &&
          (typeof declaration.maxBudget !== 'number' ||
            !Number.isFinite(declaration.maxBudget) ||
            declaration.maxBudget < 0 ||
            declaration.maxBudget > 1_000_000)) ||
        !Array.isArray(declaration.dataTypes) ||
        typeof declaration.sourceCode !== 'boolean' ||
        declaration.secrets !== false ||
        typeof declaration.retryOnFailure !== 'boolean' ||
        typeof declaration.retryRequiresHuman !== 'boolean'
      ) {
        throw mandateInvalid('Task mandate provider declaration is invalid.');
      }
      const dataTypes = normalizeDataTypes(declaration.dataTypes);
      if (
        dataTypes.length === 0 ||
        dataTypes.includes('source-code') !== declaration.sourceCode ||
        (declaration.retryRequiresHuman && !declaration.retryOnFailure)
      ) {
        throw mandateInvalid(
          'Task mandate provider declaration has inconsistent data or retry bounds.',
        );
      }
      result[providerId] = {
        maxInvocations: declaration.maxInvocations,
        maxBudget: declaration.maxBudget,
        dataTypes,
        sourceCode: declaration.sourceCode,
        secrets: false,
        retryOnFailure: declaration.retryOnFailure,
        retryRequiresHuman: declaration.retryRequiresHuman,
      };
    }
    return result;
  }

  function normalizeDataTypes(value: unknown[]): TaskMandateDataType[] {
    if (
      !value.every(
        (entry): entry is TaskMandateDataType =>
          typeof entry === 'string' &&
          (DATA_TYPES as readonly string[]).includes(entry),
      )
    ) {
      throw mandateInvalid('Task mandate provider data type is unknown.');
    }
    const normalized = [...new Set(value)].sort();
    if (
      normalized.length !== value.length ||
      normalized.some((entry, index) => entry !== value[index])
    ) {
      throw mandateInvalid(
        'Task mandate provider data types must be sorted and unique.',
      );
    }
    return normalized;
  }

  function cloneProviderDeclarations(
    declarations: Partial<Record<ProviderId, TaskMandateProviderDeclaration>>,
  ): Partial<Record<ProviderId, TaskMandateProviderDeclaration>> {
    return Object.fromEntries(
      Object.entries(declarations).map(([providerId, declaration]) => [
        providerId,
        {
          ...declaration,
          dataTypes: [...declaration.dataTypes],
        },
      ]),
    );
  }

  function assertTaskMandateTaskId(value: string): string {
    if (!TASK_ID.test(value) || value.length > 128) {
      throw mandateInvalid(
        'Task mandate task ID must be lower-case kebab-case.',
      );
    }
    return value;
  }

  function taskMandateBinding(record: TaskMandateRecord): TaskMandateBinding {
    return {
      schemaVersion: 1,
      mandateTaskId: record.taskId,
      mandateId: record.mandateId,
      mandateDigest: crypto
        .createHash('sha256')
        .update(canonicalTaskMandateEnvelope(record.envelope))
        .digest('hex'),
      changeId: record.changeId,
      externalAuditRoot: record.externalAuditRoot,
    };
  }

  function assertTaskMandateBinding(value: unknown): TaskMandateBinding {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'mandateTaskId',
        'mandateId',
        'mandateDigest',
        'changeId',
        'externalAuditRoot',
      ]) ||
      value.schemaVersion !== 1 ||
      typeof value.mandateTaskId !== 'string' ||
      typeof value.mandateId !== 'string' ||
      typeof value.mandateDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.mandateDigest) ||
      typeof value.changeId !== 'string' ||
      typeof value.externalAuditRoot !== 'string'
    ) {
      throw mandateInvalid('Task mandate binding is malformed.');
    }
    return {
      schemaVersion: 1,
      mandateTaskId: assertTaskMandateTaskId(value.mandateTaskId),
      mandateId: assertMandateId(value.mandateId),
      mandateDigest: value.mandateDigest,
      changeId: assertChangeId(value.changeId),
      externalAuditRoot: assertExternalAuditRootPath(value.externalAuditRoot),
    };
  }

  function assertTaskMandateChange(
    record: TaskMandateRecord,
    changeId: string,
  ): void {
    if (record.changeId !== changeId) {
      throw workflowError(
        'TASK_MANDATE_CHANGE_MISMATCH',
        `Task mandate ${record.taskId} is bound to another change.`,
        ExitCode.guard,
      );
    }
  }

  function assertExactTaskMandateBinding(
    record: TaskMandateRecord,
    binding: TaskMandateBinding,
  ): void {
    const current = taskMandateBinding(record);
    if (canonicalJson(current) !== canonicalJson(binding)) {
      throw workflowError(
        'TASK_MANDATE_BINDING_STALE',
        'The durable task mandate binding no longer matches the active mandate.',
        ExitCode.staleState,
      );
    }
  }

  function assertProviderReservationId(value: string): string {
    if (!PROVIDER_RESERVATION_ID.test(value)) {
      throw mandateInvalid('Provider reservation ID is invalid.');
    }
    return value;
  }

  function assertProviderReservationOperation(
    value: unknown,
  ): TaskMandateProviderReservationOperation {
    if (
      !isRecord(value) ||
      !(
        hasExactKeys(value, [
          'providerId',
          'dataTypes',
          'sourceCode',
          'secrets',
          'retry',
          'budget',
          'requestDigest',
        ]) ||
        hasExactKeys(value, [
          'providerId',
          'dataTypes',
          'sourceCode',
          'secrets',
          'retry',
          'budget',
          'requestDigest',
          'executionGrant',
        ])
      ) ||
      !isProviderId(value.providerId) ||
      !Array.isArray(value.dataTypes) ||
      typeof value.sourceCode !== 'boolean' ||
      typeof value.secrets !== 'boolean' ||
      typeof value.retry !== 'boolean' ||
      (value.budget !== null && typeof value.budget !== 'number') ||
      typeof value.requestDigest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.requestDigest) ||
      (value.executionGrant !== undefined &&
        !(
          isRecord(value.executionGrant) &&
          hasExactKeys(value.executionGrant, ['grantId']) &&
          typeof value.executionGrant.grantId === 'string' &&
          /^[0-9a-f-]{36}$/.test(value.executionGrant.grantId)
        ))
    ) {
      throw mandateInvalid('Provider reservation operation is malformed.');
    }
    return {
      providerId: value.providerId,
      dataTypes: normalizeDataTypes(value.dataTypes),
      sourceCode: value.sourceCode,
      secrets: value.secrets,
      retry: value.retry,
      budget: value.budget,
      requestDigest: value.requestDigest,
      ...(value.executionGrant === undefined
        ? {}
        : {
            executionGrant: {
              grantId: (value.executionGrant as { grantId: string }).grantId,
            },
          }),
    };
  }

  function taskMandateProviderOperationDigest(
    operation: TaskMandateProviderReservationOperation,
  ): string {
    // The grant is the authorization vehicle, not part of the operation's
    // semantic identity: the same reservation replays identically whether or
    // not its caller still holds the grant object.
    const { executionGrant: _executionGrant, ...semantic } = operation;
    return crypto
      .createHash('sha256')
      .update(
        canonicalJson({
          kind: 'task-mandate-provider-reservation-operation.v1',
          operation: semantic,
        }),
      )
      .digest('hex');
  }

  function findTaskMandateProviderReservation(
    record: TaskMandateRecord,
    reservationId: string,
  ): {
    providerId: ProviderId;
    usage: StoredTaskMandateProviderUsage;
    reservation: StoredTaskMandateProviderUsage['reservations'][number];
  } | null {
    let found: ReturnType<typeof findTaskMandateProviderReservation> = null;
    for (const [rawProviderId, usage] of Object.entries(record.providerUsage)) {
      if (!isProviderId(rawProviderId) || usage === undefined)
        throw unsafeStore();
      const reservation = usage.reservations.find(
        (candidate) => candidate.reservationId === reservationId,
      );
      if (reservation === undefined) continue;
      if (found !== null) throw unsafeStore();
      found = { providerId: rawProviderId, usage, reservation };
    }
    return found;
  }

  function assertProviderInvocationAuditInput(
    value: unknown,
  ): TaskMandateProviderInvocationAuditInput {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'providerId',
        'invocationId',
        'requestDigest',
        'occurredAt',
      ]) ||
      !isProviderId(value.providerId) ||
      typeof value.invocationId !== 'string' ||
      typeof value.requestDigest !== 'string' ||
      typeof value.occurredAt !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.requestDigest) ||
      exactTimestamp(value.occurredAt) === undefined
    ) {
      throw mandateInvalid('Provider invocation audit input is malformed.');
    }
    return {
      providerId: value.providerId,
      invocationId: assertProviderReservationId(value.invocationId),
      requestDigest: value.requestDigest,
      occurredAt: value.occurredAt,
    };
  }

  function isSortedUniqueProviderReservations(
    value: unknown,
  ): value is StoredTaskMandateProviderUsage['reservations'] {
    return (
      Array.isArray(value) &&
      value.every(
        (reservation) =>
          isRecord(reservation) &&
          (hasExactKeys(reservation, [
            'reservationId',
            'authorizedAt',
            'requestDigest',
            'operationDigest',
          ]) ||
            hasExactKeys(reservation, [
              'reservationId',
              'authorizedAt',
              'requestDigest',
              'operationDigest',
              'executionGrantId',
            ])) &&
          typeof reservation.reservationId === 'string' &&
          PROVIDER_RESERVATION_ID.test(reservation.reservationId) &&
          typeof reservation.authorizedAt === 'string' &&
          exactTimestamp(reservation.authorizedAt) !== undefined &&
          typeof reservation.requestDigest === 'string' &&
          /^[0-9a-f]{64}$/.test(reservation.requestDigest) &&
          typeof reservation.operationDigest === 'string' &&
          /^[0-9a-f]{64}$/.test(reservation.operationDigest) &&
          (reservation.executionGrantId === undefined ||
            (typeof reservation.executionGrantId === 'string' &&
              /^[0-9a-f-]{36}$/.test(reservation.executionGrantId))),
      ) &&
      new Set(value.map(({ reservationId }) => reservationId)).size ===
        value.length &&
      [...value]
        .sort((left, right) =>
          left.reservationId.localeCompare(right.reservationId),
        )
        .every(
          (reservation, index) =>
            canonicalJson(reservation) === canonicalJson(value[index]),
        )
    );
  }

  return {
    authorizeProviderCall,
    isPreparationOperation,
    parseProviderDeclarations,
    cloneProviderDeclarations,
    assertTaskMandateTaskId,
    taskMandateBinding,
    assertTaskMandateBinding,
    assertTaskMandateChange,
    assertExactTaskMandateBinding,
    assertProviderReservationId,
    assertProviderReservationOperation,
    taskMandateProviderOperationDigest,
    findTaskMandateProviderReservation,
    assertProviderInvocationAuditInput,
    isSortedUniqueProviderReservations,
  };
}
