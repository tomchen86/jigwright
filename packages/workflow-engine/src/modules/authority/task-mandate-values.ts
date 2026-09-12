/** Canonical Task Mandate data and deterministic scalar validation. */
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type ProviderId } from '../provider-orchestration/provider-registry.ts';

export const TASK_MANDATE_SIGNATURE_NAMESPACE_V2 =
  'HARNESS_TASK_MANDATE_V2' as const;

export const TASK_MANDATE_INACTIVITY_DAYS = 14;

export const TASK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const MANDATE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const PROVIDER_RESERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const SIGNATURE =
  /^-----BEGIN SSH SIGNATURE-----\n[A-Za-z0-9+/=\r\n]+-----END SSH SIGNATURE-----\n$/;

export const DATA_TYPES = [
  'diff',
  'repository-metadata',
  'source-code',
  'task-intent',
  'test-output',
] as const;

export const PAYLOAD_KEYS = [
  'kind',
  'mandateId',
  'changeId',
  'taskId',
  'repositoryId',
  'repositoryOrigin',
  'externalAuditRoot',
  'policyBlob',
  'baseCommit',
  'intent',
  'preparation',
  'authoritativeEffects',
  'controlPlaneMutation',
  'secretScopes',
  'validUntil',
  'auditRequired',
  'issuedAt',
  'signer',
] as const;

export type TaskMandateDataType = (typeof DATA_TYPES)[number];

export type TaskMandateProviderDeclaration = {
  maxInvocations: number;
  maxBudget: number | null;
  dataTypes: TaskMandateDataType[];
  sourceCode: boolean;
  secrets: false;
  retryOnFailure: boolean;
  retryRequiresHuman: boolean;
};

export type TaskMandateRequest = {
  changeId: string;
  taskId: string;
  intent: string;
  providerCalls: Partial<Record<ProviderId, TaskMandateProviderDeclaration>>;
};

export type TaskMandatePayload = {
  kind: 'task-mandate.v2';
  mandateId: string;
  changeId: string;
  taskId: string;
  repositoryId: string;
  repositoryOrigin: string;
  externalAuditRoot: string;
  policyBlob: string;
  baseCommit: string;
  intent: string;
  preparation: {
    repositoryRead: true;
    isolatedRepositoryWrites: true;
    addDeleteRenameFiles: true;
    localCommands: true;
    draftCommits: true;
    candidateAndDesignArtifacts: true;
    providerCalls: Partial<Record<ProviderId, TaskMandateProviderDeclaration>>;
    readOnlyConnectors: true;
  };
  authoritativeEffects: false;
  controlPlaneMutation: false;
  secretScopes: [];
  validUntil: {
    taskClosed: true;
    humanRevokes: true;
    repositoryIdentityChanges: true;
    intentReplaced: true;
    inactivityDays: 14;
  };
  auditRequired: true;
  issuedAt: string;
  signer: string;
};

export type TaskMandateEnvelope = {
  payload: TaskMandatePayload;
  signature: string;
};

export type TaskMandateProviderUsage = {
  invocations: number;
  budget: number;
};

export type StoredTaskMandateProviderUsage = TaskMandateProviderUsage & {
  reservations: Array<{
    reservationId: string;
    authorizedAt: string;
    requestDigest: string;
    operationDigest: string;
    executionGrantId?: string;
  }>;
};

export type TaskMandateRecord = {
  schemaVersion: 2;
  state: 'active' | 'revoked';
  mandateId: string;
  changeId: string;
  externalAuditRoot: string;
  taskId: string;
  lastActivityAt: string;
  providerUsage: Partial<Record<ProviderId, StoredTaskMandateProviderUsage>>;
  revokedAt: string | null;
  revocationReason: string | null;
  envelope: TaskMandateEnvelope;
};

export type TaskMandateInspection = {
  mandateId: string;
  changeId: string;
  externalAuditRoot: string;
  taskId: string;
  state: 'active' | 'expired' | 'revoked';
  intent: string;
  baseCommit: string;
  signer: string;
  issuedAt: string;
  lastActivityAt: string;
  providerUsage: Partial<Record<ProviderId, TaskMandateProviderUsage>>;
  inactivityDays: 14;
  revokedAt?: string;
  revocationReason?: string;
};

export type TaskMandateOperation =
  | {
      kind:
        | 'repository-read'
        | 'isolated-repository-write'
        | 'add-delete-rename'
        | 'local-command'
        | 'draft-commit'
        | 'candidate-or-design-artifact'
        | 'read-only-connector';
    }
  | {
      kind:
        | 'authoritative-ref-update'
        | 'push'
        | 'deploy'
        | 'secret-scope-expansion'
        | 'irreversible-external-effect'
        | 'live-workflow-state-mutation'
        | 'control-plane-mutation';
    }
  | {
      kind: 'provider-call';
      providerId: ProviderId;
      dataTypes: TaskMandateDataType[];
      sourceCode: boolean;
      secrets: boolean;
      retry: boolean;
      budget: number | null;
    };

export type TaskMandateProviderReservationOperation = Omit<
  Extract<TaskMandateOperation, { kind: 'provider-call' }>,
  'kind'
> & {
  requestDigest: string;
  /**
   * A signed execution-budget grant the caller has already validated and
   * consumed for this exact replacement Attempt. The human signature it
   * carries is the consent that lets this one reservation proceed past an
   * exhausted declared budget; the ledger records the grant so the excess is
   * attributed, never silent.
   */
  executionGrant?: { grantId: string };
};

export type TaskMandateProviderInvocationAuditInput = {
  providerId: ProviderId;
  invocationId: string;
  requestDigest: string;
  occurredAt: string;
};

export function assertExternalAuditRoot(value: string | undefined): string {
  if (value === undefined) {
    throw workflowError(
      'TASK_MANDATE_AUDIT_ROOT_REQUIRED',
      'Task Mandate authorization requires an explicit repository-external audit root.',
      ExitCode.unsafeEnvironment,
    );
  }
  return assertExternalAuditRootPath(value);
}

export function assertExternalAuditRootPath(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > 4096 ||
    value.includes('\0') ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value
  ) {
    throw mandateInvalid(
      'Task mandate external audit root must be an exact absolute path.',
    );
  }
  return value;
}

export function assertMandateId(value: string): string {
  if (!MANDATE_ID.test(value)) {
    throw mandateInvalid('Task mandate ID must be a UUID v4.');
  }
  return value;
}

export function assertIntent(value: string): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 4096 ||
    containsControlCharacter(value)
  ) {
    throw mandateInvalid('Task mandate intent is invalid.');
  }
  return value;
}

export function assertRevocationReason(value: string): string {
  if (
    value.trim() !== value ||
    value.length === 0 ||
    value.length > 1024 ||
    containsControlCharacter(value)
  ) {
    throw mandateInvalid('Task mandate revocation reason is invalid.');
  }
  return value;
}

export function assertSignature(value: string): void {
  if (!SIGNATURE.test(value)) {
    throw workflowError(
      'TASK_MANDATE_SIGNATURE_INVALID',
      'Task mandate signature is not canonical armored SSH signature data.',
      ExitCode.verification,
    );
  }
}

export function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw mandateInvalid('Task mandate timestamp is invalid.');
  }
  return date;
}

export function exactTimestamp(value: string): number | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value
    ? date.getTime()
    : undefined;
}

export function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127;
  });
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...keys].sort())
  );
}

export function isWorkflowFailure(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  );
}

export function mandateInvalid(message: string) {
  return workflowError('TASK_MANDATE_INVALID', message, ExitCode.guard);
}

export function unsafeStore() {
  return workflowError(
    'TASK_MANDATE_STORE_UNSAFE',
    'Task mandate storage is malformed or unsafe.',
    ExitCode.unsafeEnvironment,
  );
}
