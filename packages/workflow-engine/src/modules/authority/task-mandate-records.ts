/** Canonical mandate requests, envelopes, records and issuance data. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { assertChangeId } from '../../foundation/repository-path/repository-path.ts';
import {
  isBuiltInProviderFamily as isProviderId,
  type BuiltInProviderFamily as ProviderId,
} from '@jigwright/core/built-in-provider-catalog';
import { type MaintainerPolicy } from './maintainer-policy.ts';
import {
  assertTaskMandateTaskId,
  cloneProviderDeclarations,
  isSortedUniqueProviderReservations,
  parseProviderDeclarations,
} from './task-mandate-policy.ts';
import {
  assertExternalAuditRootPath,
  assertIntent,
  assertSignature,
  COMMIT_OID,
  exactTimestamp,
  hasExactKeys,
  isWorkflowFailure,
  MANDATE_ID,
  mandateInvalid,
  PAYLOAD_KEYS,
  TASK_ID,
  TASK_MANDATE_INACTIVITY_DAYS,
  unsafeStore,
  type StoredTaskMandateProviderUsage,
  type TaskMandateEnvelope,
  type TaskMandatePayload,
  type TaskMandateRecord,
  type TaskMandateRequest,
} from './task-mandate-values.ts';

export function parseTaskMandateRequest(value: unknown): TaskMandateRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['changeId', 'taskId', 'intent', 'providerCalls']) ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.intent !== 'string' ||
    !isRecord(value.providerCalls)
  ) {
    throw mandateInvalid('Task mandate request is malformed.');
  }
  const request: TaskMandateRequest = {
    changeId: assertChangeId(value.changeId),
    taskId: assertTaskMandateTaskId(value.taskId),
    intent: assertIntent(value.intent),
    providerCalls: parseProviderDeclarations(value.providerCalls),
  };
  return request;
}

export function canonicalTaskMandatePayload(
  payload: TaskMandatePayload,
): string {
  validateTaskMandatePayload(payload);
  return `${canonicalJson(payload)}\n`;
}

export function canonicalTaskMandateEnvelope(
  envelope: TaskMandateEnvelope,
): string {
  validateTaskMandatePayload(envelope.payload);
  assertSignature(envelope.signature);
  return `${canonicalJson(envelope)}\n`;
}

export function parseTaskMandateEnvelope(raw: string): TaskMandateEnvelope {
  try {
    if (typeof raw !== 'string' || raw.length > 1_048_576) {
      throw new Error('invalid envelope size');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['payload', 'signature']) ||
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, PAYLOAD_KEYS) ||
      typeof value.signature !== 'string'
    ) {
      throw new Error('invalid envelope shape');
    }
    const envelope = {
      payload: parseTaskMandatePayload(value.payload),
      signature: value.signature,
    };
    assertSignature(envelope.signature);
    if (canonicalTaskMandateEnvelope(envelope) !== raw) {
      throw new Error('noncanonical envelope');
    }
    return envelope;
  } catch (error) {
    if (isWorkflowFailure(error)) throw error;
    throw mandateInvalid('Task mandate envelope is malformed or noncanonical.');
  }
}

function parseTaskMandatePayload(
  value: Record<string, unknown>,
): TaskMandatePayload {
  if (
    value.kind !== 'task-mandate.v2' ||
    typeof value.mandateId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.repositoryId !== 'string' ||
    typeof value.repositoryOrigin !== 'string' ||
    typeof value.externalAuditRoot !== 'string' ||
    typeof value.policyBlob !== 'string' ||
    typeof value.baseCommit !== 'string' ||
    typeof value.intent !== 'string' ||
    !isRecord(value.preparation) ||
    value.authoritativeEffects !== false ||
    value.controlPlaneMutation !== false ||
    !Array.isArray(value.secretScopes) ||
    !isRecord(value.validUntil) ||
    value.auditRequired !== true ||
    typeof value.issuedAt !== 'string' ||
    typeof value.signer !== 'string'
  ) {
    throw new Error('invalid task mandate payload');
  }
  const preparation = value.preparation;
  const validUntil = value.validUntil;
  if (
    !hasExactKeys(preparation, [
      'repositoryRead',
      'isolatedRepositoryWrites',
      'addDeleteRenameFiles',
      'localCommands',
      'draftCommits',
      'candidateAndDesignArtifacts',
      'providerCalls',
      'readOnlyConnectors',
    ]) ||
    preparation.repositoryRead !== true ||
    preparation.isolatedRepositoryWrites !== true ||
    preparation.addDeleteRenameFiles !== true ||
    preparation.localCommands !== true ||
    preparation.draftCommits !== true ||
    preparation.candidateAndDesignArtifacts !== true ||
    !isRecord(preparation.providerCalls) ||
    preparation.readOnlyConnectors !== true ||
    !hasExactKeys(validUntil, [
      'taskClosed',
      'humanRevokes',
      'repositoryIdentityChanges',
      'intentReplaced',
      'inactivityDays',
    ]) ||
    validUntil.taskClosed !== true ||
    validUntil.humanRevokes !== true ||
    validUntil.repositoryIdentityChanges !== true ||
    validUntil.intentReplaced !== true ||
    validUntil.inactivityDays !== TASK_MANDATE_INACTIVITY_DAYS
  ) {
    throw new Error('unsafe task mandate bounds');
  }
  const payload: TaskMandatePayload = {
    kind: 'task-mandate.v2',
    mandateId: value.mandateId,
    changeId: value.changeId,
    taskId: value.taskId,
    repositoryId: value.repositoryId,
    repositoryOrigin: value.repositoryOrigin,
    externalAuditRoot: value.externalAuditRoot,
    policyBlob: value.policyBlob,
    baseCommit: value.baseCommit,
    intent: value.intent,
    preparation: {
      repositoryRead: true,
      isolatedRepositoryWrites: true,
      addDeleteRenameFiles: true,
      localCommands: true,
      draftCommits: true,
      candidateAndDesignArtifacts: true,
      providerCalls: parseProviderDeclarations(preparation.providerCalls),
      readOnlyConnectors: true,
    },
    authoritativeEffects: false,
    controlPlaneMutation: false,
    secretScopes: [],
    validUntil: {
      taskClosed: true,
      humanRevokes: true,
      repositoryIdentityChanges: true,
      intentReplaced: true,
      inactivityDays: TASK_MANDATE_INACTIVITY_DAYS,
    },
    auditRequired: true,
    issuedAt: value.issuedAt,
    signer: value.signer,
  };
  validateTaskMandatePayload(payload);
  return payload;
}

export function validateTaskMandatePayload(payload: TaskMandatePayload): void {
  if (
    payload.kind !== 'task-mandate.v2' ||
    !MANDATE_ID.test(payload.mandateId) ||
    assertChangeId(payload.changeId) !== payload.changeId ||
    !TASK_ID.test(payload.taskId) ||
    payload.taskId.length > 128 ||
    !/^github:[A-Za-z0-9_-]+$/.test(payload.repositoryId) ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      payload.repositoryOrigin,
    ) ||
    assertExternalAuditRootPath(payload.externalAuditRoot) !==
      payload.externalAuditRoot ||
    !COMMIT_OID.test(payload.policyBlob) ||
    !COMMIT_OID.test(payload.baseCommit) ||
    assertIntent(payload.intent) !== payload.intent ||
    payload.authoritativeEffects !== false ||
    payload.controlPlaneMutation !== false ||
    payload.secretScopes.length !== 0 ||
    payload.auditRequired !== true ||
    exactTimestamp(payload.issuedAt) === undefined ||
    payload.signer.length === 0 ||
    payload.signer.length > 128
  ) {
    throw mandateInvalid(
      'Task mandate does not preserve the preparation-only boundary.',
    );
  }
  parseProviderDeclarations(payload.preparation.providerCalls);
}

export function canonicalTaskMandateRecord(record: TaskMandateRecord): string {
  return `${canonicalJson(record)}\n`;
}

export function parseCurrentTaskMandateRecord(raw: string): TaskMandateRecord {
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'state',
        'mandateId',
        'changeId',
        'externalAuditRoot',
        'taskId',
        'lastActivityAt',
        'providerUsage',
        'revokedAt',
        'revocationReason',
        'envelope',
      ]) ||
      value.schemaVersion !== 2 ||
      (value.state !== 'active' && value.state !== 'revoked') ||
      typeof value.mandateId !== 'string' ||
      typeof value.changeId !== 'string' ||
      typeof value.externalAuditRoot !== 'string' ||
      typeof value.taskId !== 'string' ||
      typeof value.lastActivityAt !== 'string' ||
      !isRecord(value.providerUsage) ||
      (value.revokedAt !== null && typeof value.revokedAt !== 'string') ||
      (value.revocationReason !== null &&
        typeof value.revocationReason !== 'string') ||
      !isRecord(value.envelope)
    ) {
      throw new Error('invalid record shape');
    }
    const productionEnvelope = parseTaskMandateEnvelope(
      `${canonicalJson(value.envelope)}\n`,
    );
    const providerUsage: Partial<
      Record<ProviderId, StoredTaskMandateProviderUsage>
    > = {};
    for (const [providerId, usage] of Object.entries(value.providerUsage)) {
      if (
        !isProviderId(providerId) ||
        !isRecord(usage) ||
        !hasExactKeys(usage, ['invocations', 'budget', 'reservations']) ||
        typeof usage.invocations !== 'number' ||
        !Number.isInteger(usage.invocations) ||
        usage.invocations < 0 ||
        typeof usage.budget !== 'number' ||
        !Number.isFinite(usage.budget) ||
        usage.budget < 0 ||
        !isSortedUniqueProviderReservations(usage.reservations)
      ) {
        throw new Error('invalid provider usage');
      }
      providerUsage[providerId] = {
        invocations: usage.invocations,
        budget: usage.budget,
        reservations: structuredClone(usage.reservations),
      };
    }
    const record: TaskMandateRecord = {
      schemaVersion: 2,
      state: value.state,
      mandateId: value.mandateId,
      changeId: value.changeId,
      externalAuditRoot: value.externalAuditRoot,
      taskId: value.taskId,
      lastActivityAt: value.lastActivityAt,
      providerUsage,
      revokedAt: value.revokedAt,
      revocationReason: value.revocationReason,
      envelope: productionEnvelope,
    };
    const issuedAt = exactTimestamp(productionEnvelope.payload.issuedAt);
    const lastActivityAt = exactTimestamp(record.lastActivityAt);
    const declaredProviders = Object.keys(
      productionEnvelope.payload.preparation.providerCalls,
    ).sort();
    const usageProviders = Object.keys(record.providerUsage).sort();
    const reservations = Object.values(record.providerUsage).flatMap(
      (usage) => usage?.reservations ?? [],
    );
    if (
      record.mandateId !== productionEnvelope.payload.mandateId ||
      record.changeId !== productionEnvelope.payload.changeId ||
      record.externalAuditRoot !==
        productionEnvelope.payload.externalAuditRoot ||
      record.taskId !== productionEnvelope.payload.taskId ||
      issuedAt === undefined ||
      lastActivityAt === undefined ||
      lastActivityAt < issuedAt ||
      JSON.stringify(declaredProviders) !== JSON.stringify(usageProviders) ||
      new Set(reservations.map(({ reservationId }) => reservationId)).size !==
        reservations.length ||
      reservations.some(
        ({ authorizedAt }) => exactTimestamp(authorizedAt)! > lastActivityAt,
      ) ||
      declaredProviders.some((providerId) => {
        const declaration =
          productionEnvelope.payload.preparation.providerCalls[
            providerId as ProviderId
          ];
        const usage = record.providerUsage[providerId as ProviderId];
        // Reservations attributed to a signed execution grant legitimately
        // exceed the declared invocation ceiling by exactly their count.
        const grantedReservations =
          usage?.reservations.filter(
            ({ executionGrantId }) => executionGrantId !== undefined,
          ).length ?? 0;
        return (
          !declaration ||
          !usage ||
          usage.invocations !== usage.reservations.length ||
          usage.invocations >
            declaration.maxInvocations + grantedReservations ||
          (declaration.maxBudget !== null &&
            usage.budget > declaration.maxBudget)
        );
      }) ||
      (record.state === 'active' &&
        (record.revokedAt !== null || record.revocationReason !== null)) ||
      (record.state === 'revoked' &&
        (exactTimestamp(record.revokedAt ?? '') === undefined ||
          exactTimestamp(record.revokedAt ?? '')! < lastActivityAt ||
          !record.revocationReason)) ||
      canonicalTaskMandateRecord(record) !== raw
    ) {
      throw new Error('invalid record binding');
    }
    return record;
  } catch (error) {
    if (isWorkflowFailure(error)) throw error;
    throw unsafeStore();
  }
}
export function createTaskMandatePayload(
  request: TaskMandateRequest,
  context: {
    policy: MaintainerPolicy;
    policyBlob: string;
    repository: { head: string };
  },
  mandateId: string,
  externalAuditRoot: string,
  now: Date,
  identity: string,
): TaskMandatePayload {
  return {
    kind: 'task-mandate.v2',
    mandateId,
    changeId: request.changeId,
    taskId: request.taskId,
    repositoryId: context.policy.repository.id,
    repositoryOrigin: context.policy.repository.origin,
    externalAuditRoot,
    policyBlob: context.policyBlob,
    baseCommit: context.repository.head,
    intent: request.intent,
    preparation: {
      repositoryRead: true,
      isolatedRepositoryWrites: true,
      addDeleteRenameFiles: true,
      localCommands: true,
      draftCommits: true,
      candidateAndDesignArtifacts: true,
      providerCalls: cloneProviderDeclarations(request.providerCalls),
      readOnlyConnectors: true,
    },
    authoritativeEffects: false,
    controlPlaneMutation: false,
    secretScopes: [],
    validUntil: {
      taskClosed: true,
      humanRevokes: true,
      repositoryIdentityChanges: true,
      intentReplaced: true,
      inactivityDays: TASK_MANDATE_INACTIVITY_DAYS,
    },
    auditRequired: true,
    issuedAt: now.toISOString(),
    signer: identity,
  };
}
export function createInitialTaskMandateRecord(
  request: TaskMandateRequest,
  envelope: TaskMandateEnvelope,
  mandateId: string,
  externalAuditRoot: string,
  now: Date,
): TaskMandateRecord {
  return {
    schemaVersion: 2,
    state: 'active',
    mandateId,
    changeId: request.changeId,
    externalAuditRoot,
    taskId: request.taskId,
    lastActivityAt: now.toISOString(),
    providerUsage: Object.fromEntries(
      Object.keys(request.providerCalls).map((providerId) => [
        providerId,
        { invocations: 0, budget: 0, reservations: [] },
      ]),
    ),
    revokedAt: null,
    revocationReason: null,
    envelope,
  };
}
