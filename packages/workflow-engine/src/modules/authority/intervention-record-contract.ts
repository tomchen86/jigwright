/** Validate retained intervention checkpoints and their signed maintenance grants. */
import {
  type Sha256Digest,
  assertNonEmpty,
  assertDigest,
  assertIsoTimestamp,
  freezeDeep,
  canonicalDigest,
  assertSortedUnique,
  assertSafePath,
  type HumanSignatureVerifier,
  verifyHumanSignatureSafely,
  HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
} from './intervention-control-values.ts';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

export interface WipCheckpointInput {
  parentChangeId: string;
  baseOid: string;
  worktreeFingerprint: Sha256Digest;
  trackedTreeDigest: Sha256Digest;
  untrackedBundleDigest: Sha256Digest;
  sessionStateDigest: Sha256Digest;
  pendingIntentDigest: Sha256Digest;
  engineDigest: Sha256Digest;
  policyDigest: Sha256Digest;
  createdAt: string;
}

export interface WipCheckpoint extends WipCheckpointInput {
  kind: 'harness-wip-checkpoint.v1';
  checkpointId: Sha256Digest;
}

function checkpointPayload(input: WipCheckpointInput) {
  return {
    kind: 'harness-wip-checkpoint.v1' as const,
    parentChangeId: input.parentChangeId,
    baseOid: input.baseOid,
    worktreeFingerprint: input.worktreeFingerprint,
    trackedTreeDigest: input.trackedTreeDigest,
    untrackedBundleDigest: input.untrackedBundleDigest,
    sessionStateDigest: input.sessionStateDigest,
    pendingIntentDigest: input.pendingIntentDigest,
    engineDigest: input.engineDigest,
    policyDigest: input.policyDigest,
    createdAt: input.createdAt,
  };
}

function validateCheckpointInput(input: WipCheckpointInput): void {
  assertNonEmpty(
    input.parentChangeId,
    'INTERVENTION_CHECKPOINT_INVALID',
    'Parent change id',
  );
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.baseOid)) {
    throw workflowError(
      'INTERVENTION_CHECKPOINT_INVALID',
      'Checkpoint baseOid must be a full Git object id.',
      ExitCode.usage,
    );
  }
  for (const digest of [
    input.worktreeFingerprint,
    input.trackedTreeDigest,
    input.untrackedBundleDigest,
    input.sessionStateDigest,
    input.pendingIntentDigest,
    input.engineDigest,
    input.policyDigest,
  ]) {
    assertDigest(digest, 'INTERVENTION_CHECKPOINT_INVALID');
  }
  assertIsoTimestamp(input.createdAt, 'INTERVENTION_CHECKPOINT_INVALID');
}

export function verifyWipCheckpoint(checkpoint: WipCheckpoint): WipCheckpoint {
  validateCheckpointInput(checkpoint);
  if (checkpoint.kind !== 'harness-wip-checkpoint.v1') {
    throw workflowError(
      'INTERVENTION_CHECKPOINT_INVALID',
      'Unknown WIP checkpoint schema.',
      ExitCode.usage,
    );
  }
  assertDigest(checkpoint.checkpointId, 'INTERVENTION_CHECKPOINT_INVALID');
  const expected = canonicalDigest(checkpointPayload(checkpoint));
  if (checkpoint.checkpointId !== expected) {
    throw workflowError(
      'INTERVENTION_CHECKPOINT_DIGEST_MISMATCH',
      'WIP checkpoint content no longer matches its immutable digest.',
      ExitCode.verification,
      { details: { expected, actual: checkpoint.checkpointId } },
    );
  }
  return freezeDeep({ ...checkpoint });
}

export type ParentChangeStatus =
  'draft' | 'active' | 'completed' | 'cancelled' | 'superseded';

export interface HarnessInterventionBlocker {
  kind: 'harness-intervention';
  checkpointId: Sha256Digest;
  blockedBy: string;
}

export interface ParentChangeState {
  changeId: string;
  status: ParentChangeStatus;
  engineBinding: Sha256Digest;
  sessionSchema: string;
  blocker: HarnessInterventionBlocker | null;
}

export interface HarnessInterventionRelationship {
  kind: 'harness-intervention.v1';
  parentChangeId: string;
  interventionChangeId: string;
  checkpointId: Sha256Digest;
  unblocks: string;
  state: 'active' | 'adopted' | 'closed';
}

export type HarnessMaintenanceOperation =
  | 'adopt-engine-into-parent'
  | 'build-engine-artifact'
  | 'create-isolated-workspace'
  | 'modify-engine'
  | 'run-engine-tests';

export type HarnessMaintenanceWaiver =
  | 'active-change-exclusivity'
  | 'clean-worktree-required'
  | 'engine-path-protection'
  | 'parent-terminalization-required'
  | 'selected-workflow-check';

const MAINTENANCE_OPERATIONS: readonly HarnessMaintenanceOperation[] = [
  'adopt-engine-into-parent',
  'build-engine-artifact',
  'create-isolated-workspace',
  'modify-engine',
  'run-engine-tests',
];

const MAINTENANCE_WAIVERS: readonly HarnessMaintenanceWaiver[] = [
  'active-change-exclusivity',
  'clean-worktree-required',
  'engine-path-protection',
  'parent-terminalization-required',
  'selected-workflow-check',
];

export interface HarnessMaintenanceGrantPayload {
  kind: 'harness-maintenance-grant.v1';
  grantId: string;
  parentChangeId: string;
  interventionChangeId: string;
  scope: {
    paths: string[];
    operations: HarnessMaintenanceOperation[];
  };
  waivers: HarnessMaintenanceWaiver[];
  engineFromDigest: Sha256Digest;
  sessionSchema: string;
  maxLocalAdoptions: number;
  issuedAt: string;
  expiresAt: string;
  humanSigner: string;
  reason: string;
}

export interface HarnessMaintenanceGrantEnvelope {
  payload: HarnessMaintenanceGrantPayload;
  signature: string;
}

export function canonicalHarnessMaintenanceGrantPayload(
  payload: HarnessMaintenanceGrantPayload,
): string {
  return `${canonicalJson(payload)}\n`;
}

function validateMaintenancePayload(
  payload: HarnessMaintenanceGrantPayload,
): void {
  if (payload.kind !== 'harness-maintenance-grant.v1') {
    throw workflowError(
      'MAINTENANCE_GRANT_INVALID',
      'Unknown maintenance grant schema.',
      ExitCode.usage,
    );
  }
  for (const [value, label] of [
    [payload.grantId, 'Grant id'],
    [payload.parentChangeId, 'Parent change id'],
    [payload.interventionChangeId, 'Intervention change id'],
    [payload.sessionSchema, 'Session schema'],
    [payload.humanSigner, 'Human signer'],
    [payload.reason, 'Reason'],
  ] as const) {
    assertNonEmpty(value, 'MAINTENANCE_GRANT_INVALID', label);
  }
  assertDigest(payload.engineFromDigest, 'MAINTENANCE_GRANT_INVALID');
  if (payload.parentChangeId === payload.interventionChangeId) {
    throw workflowError(
      'MAINTENANCE_GRANT_INVALID',
      'Parent and intervention must differ.',
      ExitCode.usage,
    );
  }
  if (!Array.isArray(payload.scope.paths) || payload.scope.paths.length === 0) {
    throw workflowError(
      'MAINTENANCE_GRANT_INVALID',
      'Maintenance scope needs exact path globs.',
      ExitCode.usage,
    );
  }
  for (const path of payload.scope.paths) {
    assertSafePath(path, true, 'MAINTENANCE_GRANT_INVALID');
  }
  assertSortedUnique(payload.scope.paths, 'MAINTENANCE_GRANT_INVALID');
  if (
    !Array.isArray(payload.scope.operations) ||
    payload.scope.operations.length === 0
  ) {
    throw workflowError(
      'MAINTENANCE_GRANT_INVALID',
      'Maintenance scope needs operations.',
      ExitCode.usage,
    );
  }
  assertSortedUnique(payload.scope.operations, 'MAINTENANCE_GRANT_INVALID');
  if (
    payload.scope.operations.some(
      (operation) => !MAINTENANCE_OPERATIONS.includes(operation),
    )
  ) {
    throw workflowError(
      'MAINTENANCE_GRANT_OPERATION_UNKNOWN',
      'Unknown maintenance operation.',
      ExitCode.guard,
    );
  }
  if (!payload.scope.operations.includes('adopt-engine-into-parent')) {
    throw workflowError(
      'MAINTENANCE_GRANT_ADOPTION_NOT_AUTHORIZED',
      'Maintenance grant does not authorize local engine adoption.',
      ExitCode.guard,
    );
  }
  assertSortedUnique(payload.waivers, 'MAINTENANCE_GRANT_INVALID');
  if (payload.waivers.some((waiver) => !MAINTENANCE_WAIVERS.includes(waiver))) {
    throw workflowError(
      'MAINTENANCE_GRANT_NONWAIVABLE_INVARIANT',
      'Maintenance grant attempts to waive a recovery invariant.',
      ExitCode.guard,
    );
  }
  if (payload.maxLocalAdoptions !== 1) {
    throw workflowError(
      'MAINTENANCE_GRANT_V1_ADOPTION_LIMIT_INVALID',
      'V1 maintenance grants authorize exactly one local adoption.',
      ExitCode.guard,
    );
  }
  assertIsoTimestamp(payload.issuedAt, 'MAINTENANCE_GRANT_INVALID');
  assertIsoTimestamp(payload.expiresAt, 'MAINTENANCE_GRANT_INVALID');
  if (Date.parse(payload.expiresAt) <= Date.parse(payload.issuedAt)) {
    throw workflowError(
      'MAINTENANCE_GRANT_INVALID',
      'Maintenance grant expiry must follow issue time.',
      ExitCode.usage,
    );
  }
}

export function verifyHarnessMaintenanceGrant(
  envelope: HarnessMaintenanceGrantEnvelope,
  context: {
    now: Date;
    parent: ParentChangeState;
    relationship: HarnessInterventionRelationship;
    checkpoint: WipCheckpoint;
    verifyHumanSignature: HumanSignatureVerifier;
  },
): void {
  validateMaintenancePayload(envelope.payload);
  assertNonEmpty(
    envelope.signature,
    'MAINTENANCE_GRANT_SIGNATURE_INVALID',
    'Signature',
  );
  const checkpoint = verifyWipCheckpoint(context.checkpoint);
  const blocker = context.parent.blocker;
  if (
    context.parent.status !== 'active' ||
    blocker?.kind !== 'harness-intervention' ||
    blocker.checkpointId !== checkpoint.checkpointId ||
    blocker.blockedBy !== context.relationship.interventionChangeId ||
    context.relationship.state !== 'active' ||
    context.relationship.parentChangeId !== context.parent.changeId ||
    context.relationship.checkpointId !== checkpoint.checkpointId
  ) {
    throw workflowError(
      'MAINTENANCE_GRANT_INTERVENTION_MISMATCH',
      'Maintenance grant requires the exact active intervention relationship.',
      ExitCode.verification,
    );
  }
  const payload = envelope.payload;
  if (
    payload.parentChangeId !== context.parent.changeId ||
    payload.interventionChangeId !==
      context.relationship.interventionChangeId ||
    payload.engineFromDigest !== context.parent.engineBinding ||
    payload.engineFromDigest !== checkpoint.engineDigest ||
    payload.sessionSchema !== context.parent.sessionSchema
  ) {
    throw workflowError(
      'MAINTENANCE_GRANT_BINDING_MISMATCH',
      'Maintenance grant does not match the parent checkpoint and engine binding.',
      ExitCode.verification,
    );
  }
  if (context.now.getTime() >= Date.parse(payload.expiresAt)) {
    throw workflowError(
      'MAINTENANCE_GRANT_EXPIRED',
      'Maintenance grant has expired.',
      ExitCode.staleState,
    );
  }
  const signatureValid = verifyHumanSignatureSafely(
    context.verifyHumanSignature,
    canonicalHarnessMaintenanceGrantPayload(payload),
    envelope.signature,
    payload.humanSigner,
    HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
  );
  if (!signatureValid) {
    throw workflowError(
      'MAINTENANCE_GRANT_SIGNATURE_INVALID',
      'Human maintenance grant signature could not be verified.',
      ExitCode.verification,
    );
  }
}
