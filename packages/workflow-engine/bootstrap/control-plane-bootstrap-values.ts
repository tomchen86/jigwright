/** Shared bootstrap constants, canonical values, and exact error construction. */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import type {
  InitialSupervisorBootstrapPhase,
  BootstrapControlPlaneSupervisorState,
  Sha256Digest,
} from './control-plane-bootstrap-types.ts';

export const PRIVATE_DIRECTORY_MODE = 0o700;

export const PRIVATE_FILE_MODE = 0o600;

export const PRIVATE_EXECUTABLE_MODE = 0o500;

export const MAX_STATE_BYTES = 4 * 1024 * 1024;

export const MAX_EXECUTABLE_BYTES = 16 * 1024 * 1024;

export const MAX_CLOSURE_FILE_BYTES = 16 * 1024 * 1024;

export const MAX_PROMOTION_FILE_BYTES = 16 * 1024 * 1024;

export const MAX_PROMOTION_TOTAL_BYTES = 64 * 1024 * 1024;

export const MAX_PROMOTION_BUNDLE_BYTES = 192 * 1024 * 1024;

export const CONTROL_PLANE_GRANT_MAX_TTL_MS = 5 * 60 * 1000;

export const CONTROL_PLANE_SIGNATURE_NAMESPACE_V3 =
  'jigwright.control-plane-grant.v3';

export const CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3 =
  'jigwright.control-plane-independent-review.v3';

export const CONTROL_PLANE_HISTORY_RECORD_FILE = /^[0-9a-f]{64}\.json$/;

export const RECOVERY_QUARANTINE_GRANT_ID =
  /^quarantine-(?:enter|release)-[0-9a-f]{64}$/;

export const RECOVERY_QUARANTINE_HISTORY_DIRECTORY = /^[0-9a-f]{64}$/;

export const RECOVERY_QUARANTINE_CLAIM_FILE = /^[0-9a-f]{64}\.json$/;

export const PROCESS_TIMEOUT_MS = 10_000;

export const PROCESS_MAX_BUFFER_BYTES = 1024 * 1024;

export const PROTECTED_CAPABILITY_MANIFEST_PATH =
  'workflow/protected-capabilities.json';

export const BUILT_IN_PROTOCOL_VERSION = 3;

export const BUILT_IN_SESSION_SCHEMA = 'v4';

export const BUILT_IN_POLICY_SCHEMA_VERSION = 2;

export const BUILT_IN_BOOTSTRAP_RUNTIME_PATHS = [
  'packages/workflow-engine/bootstrap/built-in-engine-closure-pin.ts',
  'packages/workflow-engine/bootstrap/candidate-engine-selection.ts',
  'packages/workflow-engine/bootstrap/canonical-json.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-closure.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-executable.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-files.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-history.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-initial.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-local.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-promotion-records.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-promotion.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-protected-records.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-protected.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-provenance.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-quarantine.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-types.ts',
  'packages/workflow-engine/bootstrap/control-plane-bootstrap-values.ts',
  'packages/workflow-engine/bootstrap/control-plane-trust.ts',
  'packages/workflow-engine/bootstrap/harness-bootstrap-production.ts',
  'packages/workflow-engine/bootstrap/maintainer-authority-production.ts',
  'packages/workflow-engine/bootstrap/workflow-bootstrap-host.ts',
  'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
] as const;

export const REQUIRED_BOOTSTRAP_PROTECTED_CAPABILITIES = [
  'adoption.journal',
  'apply.journal',
  'audit.append',
  'authorization.verify',
  'control-plane.update',
  'effect.monitor',
  'human.trust-roots',
  'policy.classify',
  'recovery.rollback',
  'ref-generation.ledger',
  'sandbox.enforce',
  'workflow.abort-or-supersede',
] as const;

const TERMINAL_HISTORIES = {
  FINALIZED: [
    'PREPARED',
    'OLD_CLOSURE_VERIFIED',
    'CANDIDATE_VERIFIED',
    'RECOVERY_VERIFIED',
    'SWITCHED',
    'SELF_TESTED',
    'FINALIZED',
  ],
  ROLLED_BACK: [
    'PREPARED',
    'OLD_CLOSURE_VERIFIED',
    'CANDIDATE_VERIFIED',
    'RECOVERY_VERIFIED',
    'SWITCHED',
    'ROLLBACK_REQUIRED',
    'ROLLED_BACK',
  ],
} as const;

export const ADOPTION_HISTORIES = {
  PREPARED: ['PREPARED'],
  PARENT_CHECKPOINTED: ['PREPARED', 'PARENT_CHECKPOINTED'],
  ENGINE_BINDING_UPDATED: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
  ],
  NEW_ENGINE_STARTED: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
    'NEW_ENGINE_STARTED',
  ],
  HEALTHY: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
    'NEW_ENGINE_STARTED',
    'HEALTHY',
  ],
  COMMITTED: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
    'NEW_ENGINE_STARTED',
    'HEALTHY',
    'COMMITTED',
  ],
  ROLLBACK_REQUIRED: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
    'NEW_ENGINE_STARTED',
    'ROLLBACK_REQUIRED',
  ],
  ENGINE_BINDING_ROLLED_BACK: [
    'PREPARED',
    'PARENT_CHECKPOINTED',
    'ENGINE_BINDING_UPDATED',
    'NEW_ENGINE_STARTED',
    'ROLLBACK_REQUIRED',
    'ENGINE_BINDING_ROLLED_BACK',
  ],
} as const;

export const INITIAL_BOOTSTRAP_PHASE_FILES: Record<
  InitialSupervisorBootstrapPhase,
  string
> = {
  PREPARED: '00-prepared.json',
  ARTIFACT_MATERIALIZED: '01-artifact-materialized.json',
  SUPERVISOR_PUBLISHED: '02-supervisor-published.json',
};

export const INITIAL_BOOTSTRAP_PHASES = [
  'PREPARED',
  'ARTIFACT_MATERIALIZED',
  'SUPERVISOR_PUBLISHED',
] as const satisfies readonly InitialSupervisorBootstrapPhase[];

export function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

export function isGitObjectId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)
  );
}

export function sortedUniqueSafePaths(
  value: unknown,
  allowEmpty: boolean,
): value is string[] {
  return (
    sortedUniqueStrings(value, allowEmpty) &&
    value.every((filePath) => safeClosurePath(filePath))
  );
}

export function sortedUniqueStrings(
  value: unknown,
  allowEmpty: boolean,
): value is string[] {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && value.length === 0) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    return false;
  }
  const sorted = [...new Set(value)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return canonicalJson(value) === canonicalJson(sorted);
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function verifyJournalDigest(
  transaction: Record<string, unknown>,
): boolean {
  if (!isDigest(transaction.journalDigest)) return false;
  const { journalDigest, ...payload } = transaction;
  return canonicalDigest(payload) === journalDigest;
}

export function verifyRecordDigest(record: Record<string, unknown>): boolean {
  if (!isDigest(record.recordDigest)) return false;
  const { recordDigest, ...payload } = record;
  return canonicalDigest(payload) === recordDigest;
}

export function validTerminalHistory(
  state: unknown,
  history: unknown,
): boolean {
  if (state !== 'FINALIZED' && state !== 'ROLLED_BACK') return false;
  if (!Array.isArray(history)) return false;
  const expected = TERMINAL_HISTORIES[state];
  if (history.length !== expected.length) return false;
  let previousTime = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < history.length; index += 1) {
    const entry = history[index];
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['at', 'state']) ||
      entry.state !== expected[index] ||
      !isCanonicalIso(entry.at)
    ) {
      return false;
    }
    const currentTime = Date.parse(entry.at);
    if (currentTime < previousTime) return false;
    previousTime = currentTime;
  }
  return true;
}

export function validTransition(
  value: BootstrapControlPlaneSupervisorState['transition'],
): boolean {
  return (
    value === null ||
    (isRecord(value) &&
      hasExactKeys(value, ['grantId', 'phase', 'txId']) &&
      isNonEmptyTrimmed(value.grantId) &&
      isNonEmptyTrimmed(value.txId) &&
      (value.phase === 'candidate-selected' ||
        value.phase === 'rollback-restored'))
  );
}

export function identityFileName(kind: string, identity: string): string {
  return crypto
    .createHash('sha256')
    .update(`${kind}\0${identity}`)
    .digest('hex');
}

export function parentChangeIdFromBranch(
  branchRef: string | null,
): string | null {
  const prefix = 'refs/heads/work/';
  if (branchRef === null || !branchRef.startsWith(prefix)) return null;
  const parentChangeId = branchRef.slice(prefix.length);
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(parentChangeId)
    ? parentChangeId
    : null;
}

export function safeClosurePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.normalize('NFC') &&
    !path.isAbsolute(value) &&
    !value.includes('\\') &&
    !/[*?[\]{}]/.test(value) &&
    value
      .split('/')
      .every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

export function isNonEmptyTrimmed(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

export function isCanonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function rawDigest(value: string | Buffer): Sha256Digest {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

export function canonicalDigest(value: unknown): Sha256Digest {
  return rawDigest(canonicalJson(value));
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function bootstrapRepositoryIdentityInvalid(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_REPOSITORY_IDENTITY_INVALID',
    'Initial supervisor repository identity could not be verified from clean Git inputs.',
    11,
  );
}

export function bootstrapPackageRootInvalid(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_PACKAGE_ROOT_INVALID',
    'Initial supervisor package root is not the exact tracked workflow-engine package in this worktree.',
    13,
  );
}

export function bootstrapBaseMismatch(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_BASE_MISMATCH',
    'Initial supervisor bootstrap requires HEAD on an exact configured protected base branch.',
    14,
  );
}

export function bootstrapRemoteBaseMismatch(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_REMOTE_BASE_MISMATCH',
    'Initial supervisor HEAD is not the exact locally tracked origin base commit.',
    14,
  );
}

export function bootstrapProvenanceChanged(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_PROVENANCE_CHANGED',
    'Initial supervisor repository HEAD, tree, branch, or identity changed during sealed bootstrap.',
    14,
  );
}

export function initialBootstrapJournalCorrupt(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_JOURNAL_CORRUPT',
    'Initial supervisor bootstrap journal is partial, malformed, indirect, or inconsistent.',
    13,
  );
}

export function protectedCapabilityManifestInvalid(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_PROTECTED_MANIFEST_INVALID',
    'Tracked protected-capability manifest failed sealed bootstrap validation.',
    13,
  );
}

export function bootstrapStateNotEmpty(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_STATE_NOT_EMPTY',
    'Initial global control-plane namespace contains unknown or non-replayable state.',
    14,
  );
}

export function supervisorAlreadyInitialized(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_SUPERVISOR_ALREADY_INITIALIZED',
    'Control-plane supervisor is already initialized with different exact state.',
    14,
  );
}

export function bootstrapArtifactMismatch(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
    'Initial built-in control-plane artifact is partial, changed, or not exact.',
    13,
  );
}

export function supervisorCorrupt(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_SUPERVISOR_CORRUPT',
    'Control-plane supervisor state failed integrity verification.',
    13,
  );
}

export function localBindingCorrupt(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_LOCAL_ADOPTION_BINDING_CORRUPT',
    'Local engine binding failed canonical integrity verification.',
    13,
  );
}

export function localBindingMismatch(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_LOCAL_ADOPTION_BINDING_MISMATCH',
    'Local engine binding disagrees with its exact worktree or adoption journal.',
    13,
  );
}

export function localJournalCorrupt(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_LOCAL_ADOPTION_JOURNAL_CORRUPT',
    'Persisted local adoption journal failed canonical integrity verification.',
    13,
  );
}

export function interventionFenceCorrupt(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_PARENT_INTERVENTION_FENCE_CORRUPT',
    'Parent intervention fence failed canonical integrity verification.',
    13,
  );
}

export function supervisorNotTerminal(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'CONTROL_PLANE_SUPERVISOR_NOT_TERMINAL',
    'Control-plane supervisor does not select a terminal promotion result.',
    14,
  );
}

export function processVerificationFailed(
  message: string,
): Error & { code: string; exitCode: number } {
  return trustError('CONTROL_PLANE_PROCESS_VERIFICATION_FAILED', message, 13);
}

export function builtInClosureMismatch(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_BUILT_IN_ENGINE_CLOSURE_MISMATCH',
    'Built-in E1 closure is missing, indirect, stale, or has changed bytes.',
    13,
  );
}

export function recoveryQuarantineStateCorrupt(): Error & {
  code: string;
  exitCode: number;
} {
  return trustError(
    'WORKFLOW_RECOVERY_QUARANTINE_STATE_CORRUPT',
    'Recovery Quarantine state is unknown, incomplete, indirect, or failed canonical integrity verification.',
    13,
  );
}

export function trustError(
  code: string,
  message: string,
  exitCode: number,
): Error & { code: string; exitCode: number } {
  return Object.assign(new Error(message), { code, exitCode });
}
