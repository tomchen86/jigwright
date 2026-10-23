/** Parent intervention fencing and exact local adoption/journal binding. */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import {
  assertExactWorktreeRoot,
  assertPrivateDirectory,
  bootstrapPaths,
  readCanonicalPrivateRecord,
} from './control-plane-bootstrap-files.ts';
import type {
  BootstrapParentInterventionFence,
  BootstrapPaths,
  BootstrapWorktreeIdentity,
  Sha256Digest,
} from './control-plane-bootstrap-types.ts';
import {
  canonicalDigest,
  deepFreeze,
  hasExactKeys,
  identityFileName,
  interventionFenceCorrupt,
  isCanonicalIso,
  isDigest,
  isNonEmptyTrimmed,
  isRecord,
  parentChangeIdFromBranch,
  trustError,
  verifyRecordDigest,
} from './control-plane-bootstrap-values.ts';

/**
 * Resolve the bootstrap-owned pause fence created with the parent's WIP
 * checkpoint. The mutable engine is deliberately not involved: a broken E1
 * must not be able to omit or weaken the fence that pauses its parent.
 */
export function resolveParentInterventionFence(
  storageRoot: string,
  identity: BootstrapWorktreeIdentity,
): BootstrapParentInterventionFence | null {
  const parentChangeId = parentChangeIdFromBranch(identity.branchRef);
  if (parentChangeId === null) return null;
  assertExactWorktreeRoot(identity.worktreeRoot);
  const paths = bootstrapPaths(storageRoot);
  const interventionDirectory = fs.lstatSync(paths.interventions, {
    throwIfNoEntry: false,
  });
  if (interventionDirectory === undefined) return null;
  assertPrivateDirectory(
    paths.root,
    'WORKFLOW_PARENT_INTERVENTION_STATE_UNSAFE',
  );
  assertPrivateDirectory(
    paths.interventions,
    'WORKFLOW_PARENT_INTERVENTION_STATE_UNSAFE',
  );
  const recordPath = path.join(
    paths.interventions,
    `${identityFileName('intervention', parentChangeId)}.json`,
  );
  if (fs.lstatSync(recordPath, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  const value = readCanonicalPrivateRecord(
    recordPath,
    interventionFenceCorrupt,
  );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'checkpoint',
      'childWorkspace',
      'createdAt',
      'kind',
      'parent',
      'recordDigest',
      'relationship',
    ]) ||
    value.kind !== 'persisted-harness-intervention.v1' ||
    !verifyRecordDigest(value) ||
    !isCanonicalIso(value.createdAt) ||
    !isRecord(value.parent) ||
    !isRecord(value.relationship) ||
    !isRecord(value.checkpoint) ||
    !isRecord(value.childWorkspace)
  ) {
    throw interventionFenceCorrupt();
  }
  const parent = value.parent;
  const relationship = value.relationship;
  const checkpoint = value.checkpoint;
  const childWorkspace = value.childWorkspace;
  if (
    !hasExactKeys(parent, [
      'blocker',
      'changeId',
      'engineBinding',
      'sessionSchema',
      'status',
    ]) ||
    parent.changeId !== parentChangeId ||
    parent.status !== 'active' ||
    !isDigest(parent.engineBinding) ||
    !isNonEmptyTrimmed(parent.sessionSchema) ||
    !isRecord(parent.blocker) ||
    !hasExactKeys(parent.blocker, ['blockedBy', 'checkpointId', 'kind']) ||
    parent.blocker.kind !== 'harness-intervention' ||
    !isDigest(parent.blocker.checkpointId) ||
    !isNonEmptyTrimmed(parent.blocker.blockedBy) ||
    !hasExactKeys(relationship, [
      'checkpointId',
      'interventionChangeId',
      'kind',
      'parentChangeId',
      'state',
      'unblocks',
    ]) ||
    relationship.kind !== 'harness-intervention.v1' ||
    relationship.parentChangeId !== parentChangeId ||
    relationship.unblocks !== parentChangeId ||
    relationship.state !== 'active' ||
    relationship.interventionChangeId !== parent.blocker.blockedBy ||
    relationship.checkpointId !== parent.blocker.checkpointId ||
    !validInterventionCheckpoint(checkpoint, parentChangeId) ||
    checkpoint.checkpointId !== parent.blocker.checkpointId ||
    checkpoint.engineDigest !== parent.engineBinding ||
    !validInterventionChildWorkspace(
      childWorkspace,
      identity.worktreeRoot,
      parentChangeId,
      String(relationship.interventionChangeId),
      String(checkpoint.checkpointId),
      String(checkpoint.baseOid),
    )
  ) {
    throw interventionFenceCorrupt();
  }
  assertStoredInterventionCheckpoint(paths, checkpoint);
  return deepFreeze({
    kind: 'harness-intervention',
    parentChangeId,
    checkpointId: checkpoint.checkpointId as Sha256Digest,
    blockedBy: relationship.interventionChangeId as string,
    parentWorkspacePath: identity.worktreeRoot,
  });
}

/** A paused parent must use its sealed recovery lane before ordinary work. */
export function assertParentInterventionFenceCleared(
  fence: BootstrapParentInterventionFence | null,
): void {
  if (fence === null) return;
  throw trustError(
    'WORKFLOW_PARENT_INTERVENTION_BLOCKED',
    `Parent change ${fence.parentChangeId} is paused by harness intervention ${fence.blockedBy}; use the sealed harness-bootstrap recovery lane.`,
    14,
  );
}

function validInterventionCheckpoint(
  checkpoint: Record<string, unknown>,
  parentChangeId: string,
): boolean {
  if (
    !hasExactKeys(checkpoint, [
      'baseOid',
      'checkpointId',
      'createdAt',
      'engineDigest',
      'kind',
      'parentChangeId',
      'pendingIntentDigest',
      'policyDigest',
      'sessionStateDigest',
      'trackedTreeDigest',
      'untrackedBundleDigest',
      'worktreeFingerprint',
    ]) ||
    checkpoint.kind !== 'harness-wip-checkpoint.v1' ||
    checkpoint.parentChangeId !== parentChangeId ||
    typeof checkpoint.baseOid !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(checkpoint.baseOid) ||
    !isCanonicalIso(checkpoint.createdAt)
  ) {
    return false;
  }
  for (const key of [
    'checkpointId',
    'engineDigest',
    'pendingIntentDigest',
    'policyDigest',
    'sessionStateDigest',
    'trackedTreeDigest',
    'untrackedBundleDigest',
    'worktreeFingerprint',
  ]) {
    if (!isDigest(checkpoint[key])) return false;
  }
  const { checkpointId, ...payload } = checkpoint;
  return checkpointId === canonicalDigest(payload);
}

function validInterventionChildWorkspace(
  metadata: Record<string, unknown>,
  parentWorkspacePath: string,
  parentChangeId: string,
  interventionChangeId: string,
  checkpointId: string,
  baseOid: string,
): boolean {
  if (
    !hasExactKeys(metadata, [
      'baseOid',
      'changeRef',
      'checkpointId',
      'childWorkspacePath',
      'createdAt',
      'effectsPerformed',
      'interventionChangeId',
      'kind',
      'metadataDigest',
      'parentChangeId',
      'parentWorkspacePath',
      'state',
      'workspaceId',
    ]) ||
    metadata.kind !== 'intervention-child-worktree.v1' ||
    metadata.state !== 'planned' ||
    metadata.effectsPerformed !== false ||
    metadata.parentChangeId !== parentChangeId ||
    metadata.interventionChangeId !== interventionChangeId ||
    metadata.checkpointId !== checkpointId ||
    metadata.baseOid !== baseOid ||
    metadata.parentWorkspacePath !== parentWorkspacePath ||
    metadata.changeRef !== `refs/heads/work/${interventionChangeId}` ||
    typeof metadata.childWorkspacePath !== 'string' ||
    !path.isAbsolute(metadata.childWorkspacePath) ||
    path.resolve(metadata.childWorkspacePath) !== metadata.childWorkspacePath ||
    !isDigest(metadata.workspaceId) ||
    !isDigest(metadata.metadataDigest) ||
    !isCanonicalIso(metadata.createdAt)
  ) {
    return false;
  }
  const { metadataDigest, ...payload } = metadata;
  if (metadataDigest !== canonicalDigest(payload)) return false;
  return (
    metadata.workspaceId ===
    canonicalDigest({
      kind: 'intervention-child-worktree-identity.v1',
      parentChangeId,
      interventionChangeId,
      checkpointId,
      parentWorkspacePath,
      childWorkspacePath: metadata.childWorkspacePath,
      changeRef: metadata.changeRef,
    })
  );
}

function assertStoredInterventionCheckpoint(
  paths: BootstrapPaths,
  checkpoint: Record<string, unknown>,
): void {
  assertPrivateDirectory(
    paths.checkpoints,
    'WORKFLOW_PARENT_INTERVENTION_STATE_UNSAFE',
  );
  const checkpointId = checkpoint.checkpointId as Sha256Digest;
  const stored = readCanonicalPrivateRecord(
    path.join(
      paths.checkpoints,
      `${checkpointId.slice('sha256:'.length)}.json`,
    ),
    interventionFenceCorrupt,
  );
  if (canonicalJson(stored) !== canonicalJson(checkpoint)) {
    throw interventionFenceCorrupt();
  }
}
