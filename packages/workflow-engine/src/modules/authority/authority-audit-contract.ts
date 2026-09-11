/** Canonical authority audit evidence and refusal contracts. */

export const AUTHORITY_AUDIT_EVENT_TYPES = Object.freeze([
  'abort',
  'apply-grant',
  'branch-update',
  'candidate-bundle',
  'cas',
  'command',
  'control-plane-grant',
  'error',
  'escalation-request',
  'external-effect',
  'file-change',
  'grant-consume',
  'poststate',
  'provider-invocation',
  'recovery',
  'revoke',
  'rollback',
  'supersede',
  'task-mandate',
] as const);

export const AUTHORITY_AUDIT_RESULTS = Object.freeze([
  'aborted',
  'failed',
  'recorded',
  'revoked',
  'rolled-back',
  'succeeded',
  'superseded',
] as const);

export type Sha256Digest = `sha256:${string}`;

export type AuthorityAuditProfile = 'development' | 'protected';

export type AuthorityAuditEventType =
  (typeof AUTHORITY_AUDIT_EVENT_TYPES)[number];

export type AuthorityAuditResult = (typeof AUTHORITY_AUDIT_RESULTS)[number];

export type AuthorityAuditLedgerScope = Readonly<{
  /**
   * A dedicated absolute directory outside repositoryRoot. There is no
   * repository-local or environment-variable fallback.
   */
  externalAuditRoot: string;
  repositoryRoot: string;
  repositoryId: Sha256Digest;
  /** Defaults to development, then becomes immutable for this repository ID. */
  profile?: AuthorityAuditProfile;
}>;

export type AuthorityAuditRecord = Readonly<{
  schemaVersion: 1;
  kind: 'authority-audit-record.v1';
  repositoryId: Sha256Digest;
  sequence: number;
  occurredAt: string;
  eventType: AuthorityAuditEventType;
  idempotencyKey: Sha256Digest;
  previousRecordDigest: Sha256Digest | null;
  grantDigest: Sha256Digest | null;
  candidateBundleDigest: Sha256Digest | null;
  prestateDigest: Sha256Digest | null;
  poststateDigest: Sha256Digest | null;
  result: AuthorityAuditResult;
  resultDigest: Sha256Digest;
}>;

export type AuthorityAuditLedgerEntry = Readonly<{
  recordDigest: Sha256Digest;
  record: AuthorityAuditRecord;
}>;

export type AuthorityAuditActor = Readonly<{
  kind: 'agent' | 'engine' | 'human';
  identity: string;
}>;

export type AuthorityAuditCommand = Readonly<{
  name: string;
  argvDigest: Sha256Digest;
}>;

export type AuthorityAuditProviderInvocation = Readonly<{
  providerId: string;
  invocationId: string;
  requestDigest: Sha256Digest;
}>;

export type AuthorityAuditExternalEffect = Readonly<{
  kind: string;
  targetDigest: Sha256Digest;
  idempotencyKey: Sha256Digest;
}>;

export type AuthorityAuditEventInput = Readonly<{
  eventType: AuthorityAuditEventType;
  occurredAt: string;
  idempotencyKey: Sha256Digest;
  actor: AuthorityAuditActor;
  taskId: string | null;
  changeId: string | null;
  workflowId: string | null;
  grantDigest: Sha256Digest | null;
  candidateBundleDigest: Sha256Digest | null;
  prestateDigest: Sha256Digest | null;
  poststateDigest: Sha256Digest | null;
  command: AuthorityAuditCommand | null;
  providerInvocation: AuthorityAuditProviderInvocation | null;
  externalEffect: AuthorityAuditExternalEffect | null;
  result: AuthorityAuditResult;
  outcomeDigest: Sha256Digest;
  errorCode: string | null;
}>;

export type AuthorityAuditEvent = Readonly<{
  schemaVersion: 1;
  kind: 'authority-audit-event.v1';
  eventId: Sha256Digest;
  repositoryId: Sha256Digest;
  eventType: AuthorityAuditEventType;
  occurredAt: string;
  idempotencyKey: Sha256Digest;
  actor: AuthorityAuditActor;
  taskId: string | null;
  changeId: string | null;
  workflowId: string | null;
  grantDigest: Sha256Digest | null;
  candidateBundleDigest: Sha256Digest | null;
  prestateDigest: Sha256Digest | null;
  poststateDigest: Sha256Digest | null;
  command: AuthorityAuditCommand | null;
  providerInvocation: AuthorityAuditProviderInvocation | null;
  externalEffect: AuthorityAuditExternalEffect | null;
  result: AuthorityAuditResult;
  outcomeDigest: Sha256Digest;
  errorCode: string | null;
}>;

export type AuthorityAuditRecordedEvent = Readonly<{
  eventDigest: Sha256Digest;
  eventPath: string;
  event: AuthorityAuditEvent;
  ledger: AuthorityAuditLedgerEntry;
}>;

export type AuthorityAuditServiceHooks = Readonly<{
  testAfterLedgerAppend?: () => void;
  testAfterEventPreparation?: () => void;
  /** Injectable engine clock; production callers omit it. */
  now?: () => Date;
}>;

export type AuthorityRefusalAuditBinding = Readonly<{
  scope: AuthorityAuditLedgerScope;
  family: string;
  operation: string;
  subjectId: string;
  actor: AuthorityAuditActor;
  taskId: string | null;
  changeId: string | null;
  workflowId: string | null;
  grantDigest: Sha256Digest | null;
  candidateBundleDigest?: Sha256Digest | null;
  bindingDigest: Sha256Digest;
  refusalIdentity: Readonly<Record<string, unknown>>;
}>;

export type AuthorityRefusalAuditOptions = Readonly<{
  now?: Date;
  serviceHooks?: AuthorityAuditServiceHooks;
  onRecord?: (entry: AuthorityAuditRecordedEvent) => void;
}>;

import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
export function deriveAuthorityAuditRepositoryId(
  repositoryIdentity: string,
): Sha256Digest {
  if (
    typeof repositoryIdentity !== 'string' ||
    repositoryIdentity.length === 0 ||
    repositoryIdentity.trim() !== repositoryIdentity ||
    Buffer.byteLength(repositoryIdentity) > MAX_REPOSITORY_ID_BYTES ||
    [...repositoryIdentity].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point <= 31 || (point >= 127 && point <= 159);
    })
  ) {
    throw invalidScope();
  }
  return sha256Digest(
    canonicalJson({
      schemaVersion: 1,
      kind: 'authority-audit-repository.v1',
      repositoryIdentity,
    }),
  );
}
export function sha256Digest(content: string): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}
export function invalidScope() {
  return workflowError(
    'AUTHORITY_AUDIT_SCOPE_INVALID',
    'Authority audit ledger scope must use explicit canonical absolute paths and a digest repository identity.',
    ExitCode.usage,
  );
}
export const MAX_REPOSITORY_ID_BYTES = 512;

export type AuthorityAuditLedgerScan = Readonly<{
  repositoryId: Sha256Digest;
  profile: AuthorityAuditProfile;
  recordCount: number;
  prunedRecordCount: number;
  headSequence: number;
  headRecordDigest: Sha256Digest | null;
  records: readonly AuthorityAuditLedgerEntry[];
}>;

export type AuthorityAuditMaintenanceHooks = Readonly<{
  testAfterJournalPreparation?: () => void;
  testAfterTombstonePreparation?: () => void;
  testAfterTombstonePublication?: () => void;
  testAfterCheckpointPreparation?: () => void;
  testAfterCheckpointPublication?: () => void;
  testAfterEntryRemoval?: () => void;
}>;

export type AuthorityAuditCompactionResult = Readonly<{
  schemaVersion: 1;
  kind: 'authority-audit-compaction.v1';
  profile: AuthorityAuditProfile;
  pruned: number;
  retained: number;
  prunedThroughSequence: number;
  prunedThroughRecordDigest: Sha256Digest | null;
  checkpointDigest: Sha256Digest | null;
}>;

export type AuthorityAuditAnchorBackend = Readonly<{
  backendId: string;
  /** Publish to the real remote tag/WORM backend selected by the caller. */
  publish: (canonicalPayload: string) => string;
  /** Independently validates the backend's opaque receipt. */
  verify: (canonicalPayload: string, backendReceipt: string) => boolean;
}>;

export type AuthorityAuditAnchorReceipt = Readonly<{
  schemaVersion: 1;
  kind: 'authority-audit-anchor-receipt.v1';
  repositoryId: Sha256Digest;
  profile: 'protected';
  policyDigest: Sha256Digest;
  headSequence: number;
  headRecordDigest: Sha256Digest;
  anchoredAt: string;
  backendId: string;
  backendReceipt: string;
}>;

export type AuthorityAuditAnchorPublication = Readonly<{
  receiptDigest: Sha256Digest;
  receiptPath: string;
  receipt: AuthorityAuditAnchorReceipt;
}>;

export type AuthorityAuditAnchorVerification = Readonly<{
  schemaVersion: 1;
  kind: 'authority-audit-anchor-verification.v1';
  repositoryId: Sha256Digest;
  ok: true;
  currentHeadAnchored: boolean;
  receipts: readonly AuthorityAuditAnchorPublication[];
}>;

export type AuditDestructionGrantPayload = Readonly<{
  schemaVersion: 1;
  kind: 'audit-destruction-grant.v1';
  domain: 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1';
  grantId: string;
  repositoryId: Sha256Digest;
  profile: 'protected';
  expectedHeadSequence: number;
  expectedHeadRecordDigest: Sha256Digest;
  throughSequence: number;
  throughRecordDigest: Sha256Digest;
  issuedAt: string;
  expiresAt: string;
  uses: 1;
  signerIdentity: string;
  reasonDigest: Sha256Digest;
  remoteAnchorDisposition: 'retain' | 'deletion-authorized';
}>;

export type AuditDestructionGrantEnvelope = Readonly<{
  schemaVersion: 1;
  kind: 'audit-destruction-grant-envelope.v1';
  payload: AuditDestructionGrantPayload;
  signature: string;
}>;

export type AuditDestructionSignatureVerifier = (
  input: Readonly<{
    domain: 'HARNESS_AUDIT_DESTRUCTION_GRANT_V1';
    payload: string;
    signerIdentity: string;
    signature: string;
  }>,
) => boolean;

export type AuthorityAuditProtectedConfiguration = Readonly<{
  schemaVersion: 1;
  kind: 'authority-audit-protected-configuration.v1';
  repositoryId: Sha256Digest;
  backendId: 'filesystem-worm.v1';
  backendRoot: string;
  destructionPublicKeyPem: string;
  destructionPublicKeyDigest: Sha256Digest;
  configurationDigest: Sha256Digest;
}>;

export type AuthorityAuditVerification = Readonly<{
  repositoryId: Sha256Digest;
  profile: AuthorityAuditProfile;
  ok: boolean;
  recordCount: number;
  projectedEventCount: number;
  legacyUnprojectedCount: number;
  headSequence: number;
  headRecordDigest: Sha256Digest | null;
  events: readonly AuthorityAuditRecordedEvent[];
}>;

export type ScanAuthorityAuditLedger = (
  scope: AuthorityAuditLedgerScope,
) => AuthorityAuditLedgerScan;
export type ShowAuthorityAuditTask = (
  scope: AuthorityAuditLedgerScope,
  requestedTaskId: string,
) => AuthorityAuditVerification;
export type VerifyAuthorityAuditEvents = (
  scope: AuthorityAuditLedgerScope,
) => AuthorityAuditVerification;
export type ConfigureProtectedAuthorityAuditLedger = (
  scope: AuthorityAuditLedgerScope,
  input: Readonly<{
    backendRoot: string;
    destructionPublicKeyPem: string;
  }>,
) => AuthorityAuditProtectedConfiguration;
export type CreatePinnedAuthorityAuditAnchorBackend = (
  scope: AuthorityAuditLedgerScope,
) => AuthorityAuditAnchorBackend;
export type CreatePinnedAuditDestructionSignatureVerifier = (
  scope: AuthorityAuditLedgerScope,
) => AuditDestructionSignatureVerifier;
export type AnchorProtectedAuthorityAuditLedger = (
  scope: AuthorityAuditLedgerScope,
  input: Readonly<{
    anchoredAt: string;
    backend: AuthorityAuditAnchorBackend;
  }>,
) => AuthorityAuditAnchorPublication;
export type VerifyProtectedAuthorityAuditAnchors = (
  scope: AuthorityAuditLedgerScope,
  rawBackends: readonly AuthorityAuditAnchorBackend[],
) => AuthorityAuditAnchorVerification;
export type DestroyProtectedAuthorityAuditLedger = (
  scope: AuthorityAuditLedgerScope,
  rawEnvelope: AuditDestructionGrantEnvelope,
  input: Readonly<{
    now: string;
    verifyHumanSignature: AuditDestructionSignatureVerifier;
  }>,
  hooks?: AuthorityAuditMaintenanceHooks,
) => AuthorityAuditCompactionResult;
export type AuthorityAuditLedgerOperations = {
  scanAuthorityAuditLedger: ScanAuthorityAuditLedger;
  showAuthorityAuditTask: ShowAuthorityAuditTask;
  verifyAuthorityAuditEvents: VerifyAuthorityAuditEvents;
  configureProtectedAuthorityAuditLedger: ConfigureProtectedAuthorityAuditLedger;
  createPinnedAuthorityAuditAnchorBackend: CreatePinnedAuthorityAuditAnchorBackend;
  createPinnedAuditDestructionSignatureVerifier: CreatePinnedAuditDestructionSignatureVerifier;
  anchorProtectedAuthorityAuditLedger: AnchorProtectedAuthorityAuditLedger;
  verifyProtectedAuthorityAuditAnchors: VerifyProtectedAuthorityAuditAnchors;
  destroyProtectedAuthorityAuditLedger: DestroyProtectedAuthorityAuditLedger;
};

export const PROTECTED_AUDIT_ASSURANCE =
  'bootstrap-only-local-filesystem-worm-not-remote-sealed' as const;
export type AuthorityAuditRuntime = Readonly<{
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  now?: Date;
}>;
export type AuthorityAuditAssurance = typeof PROTECTED_AUDIT_ASSURANCE | null;
export type AuthorityAuditProfileResult = Readonly<{
  action: 'profile';
  requestedSubject: 'development' | 'protected';
  verified: true;
  assurance: AuthorityAuditAssurance;
  result: ReturnType<
    AuthorityAuditLedgerOperations['scanAuthorityAuditLedger']
  >;
}>;
export type AuthorityAuditShowResult = Readonly<{
  action: 'show';
  requestedSubject: string;
  verified: boolean;
  assurance: AuthorityAuditAssurance;
  result: ReturnType<AuthorityAuditLedgerOperations['showAuthorityAuditTask']>;
}>;
export type AuthorityAuditVerifyResult = Readonly<{
  action: 'verify';
  requestedSubject: string;
  verified: boolean;
  assurance: AuthorityAuditAssurance;
  result: ReturnType<
    AuthorityAuditLedgerOperations['verifyAuthorityAuditEvents']
  >;
}>;
export type AuthorityAuditAnchorResult = Readonly<{
  action: 'anchor';
  requestedSubject: string;
  verified: true;
  assurance: typeof PROTECTED_AUDIT_ASSURANCE;
  result: ReturnType<
    AuthorityAuditLedgerOperations['anchorProtectedAuthorityAuditLedger']
  >;
}>;
export type AuthorityAuditVerifyAnchorsResult = Readonly<{
  action: 'verify-anchors';
  requestedSubject: string;
  verified: true;
  assurance: typeof PROTECTED_AUDIT_ASSURANCE;
  result: ReturnType<
    AuthorityAuditLedgerOperations['verifyProtectedAuthorityAuditAnchors']
  >;
}>;
export type AuthorityAuditDestroyResult = Readonly<{
  action: 'destroy';
  requestedSubject: string;
  verified: true;
  assurance: typeof PROTECTED_AUDIT_ASSURANCE;
  result: ReturnType<
    AuthorityAuditLedgerOperations['destroyProtectedAuthorityAuditLedger']
  >;
}>;
export type AuthorityAuditOperationResult =
  | AuthorityAuditProfileResult
  | AuthorityAuditShowResult
  | AuthorityAuditVerifyResult
  | AuthorityAuditAnchorResult
  | AuthorityAuditVerifyAnchorsResult
  | AuthorityAuditDestroyResult;
export type AuthorityAuditRequest =
  | Readonly<{
      action: 'profile';
      subject: 'development';
      auditRoot: string;
    }>
  | Readonly<{
      action: 'profile';
      subject: 'protected';
      auditRoot: string;
      backendRoot: string;
      destructionPublicKey: string;
    }>
  | Readonly<{
      action: 'show' | 'verify';
      subject: string;
      auditRoot: string;
    }>
  | Readonly<{
      action: 'anchor' | 'verify-anchors';
      auditRoot: string;
    }>
  | Readonly<{
      action: 'destroy';
      auditRoot: string;
      grantFile: string;
    }>;

import type { WorkflowError } from '../../foundation/errors/errors.ts';
import type { GitState } from '../repository-consumer/repository-git-state.ts';
export type AuthorityAuditInputErrors = {
  auditUsageError: () => WorkflowError;
  protectedConfigurationInputInvalid: () => WorkflowError;
  inputFileUnsafe: (label: string) => WorkflowError;
  destructionGrantFileInvalid: () => WorkflowError;
};
export type AuthorityAuditInputOperations = {
  assertExternalAuditRoot: (value: string) => string;
  assertProtectedBackendRootInput: (
    backendRoot: string,
    scope: AuthorityAuditLedgerScope,
  ) => void;
  readPrivateInputFile: (filePathValue: string, label: string) => string;
  readCanonicalAuditDestructionGrant: (
    grantFile: string,
  ) => AuditDestructionGrantEnvelope;
  assertControllingTerminal: (runtime: AuthorityAuditRuntime) => void;
  exactRuntimeNow: (runtime: AuthorityAuditRuntime) => Date;
};
export type AuthorityAuditRepositoryObservations = {
  discoverRepository(cwd: string): GitState;
  readPolicyAtHead(repositoryRoot: string, head: string): string;
};
