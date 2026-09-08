/** Parent intervention fencing and exact local adoption/journal binding. */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import {
  parentChangeIdFromBranch,
  identityFileName,
  interventionFenceCorrupt,
  isRecord,
  hasExactKeys,
  verifyRecordDigest,
  isCanonicalIso,
  isDigest,
  isNonEmptyTrimmed,
  deepFreeze,
  trustError,
  localBindingMismatch,
  canonicalDigest,
  localBindingCorrupt,
  localJournalCorrupt,
  verifyJournalDigest,
  ADOPTION_HISTORIES,
  PRIVATE_EXECUTABLE_MODE,
  MAX_EXECUTABLE_BYTES,
  rawDigest,
} from './control-plane-bootstrap-values.ts';
import type {
  BootstrapWorktreeIdentity,
  BootstrapParentInterventionFence,
  Sha256Digest,
  BootstrapLocalEngineSelection,
  BootstrapPaths,
  BootstrapLocalEngineBinding,
  BootstrapLocalAdoptionRecord,
  BootstrapAdoptionJournal,
  BootstrapAdoptionState,
} from './control-plane-bootstrap-types.ts';
import {
  assertExactWorktreeRoot,
  bootstrapPaths,
  assertPrivateDirectory,
  readCanonicalPrivateRecord,
} from './control-plane-bootstrap-files.ts';

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

/** A committed, exact local overlay is the only automatic fence release. */
export function assertParentInterventionFenceCleared(
  fence: BootstrapParentInterventionFence | null,
  selection: BootstrapLocalEngineSelection | null,
): void {
  if (fence === null) return;
  if (
    selection !== null &&
    selection.resumeBinding.parentChangeId === fence.parentChangeId &&
    selection.resumeBinding.checkpointId === fence.checkpointId
  ) {
    return;
  }
  throw trustError(
    'WORKFLOW_PARENT_INTERVENTION_BLOCKED',
    `Parent change ${fence.parentChangeId} is paused by harness intervention ${fence.blockedBy}; use the sealed harness-bootstrap recovery lane.`,
    14,
  );
}

/**
 * Resolve a committed parent-session overlay. Detached, unrelated, or
 * non-canonical worktree branches deliberately do not observe local state.
 */
export function resolveLocalEngineSelection(
  storageRoot: string,
  identity: BootstrapWorktreeIdentity,
): BootstrapLocalEngineSelection | null {
  const parentChangeId = parentChangeIdFromBranch(identity.branchRef);
  if (parentChangeId === null) return null;
  assertExactWorktreeRoot(identity.worktreeRoot);
  const paths = bootstrapPaths(storageRoot);
  const bindingPath = path.join(
    paths.localSessions,
    `${identityFileName('parent-session', parentChangeId)}.json`,
  );
  if (fs.lstatSync(bindingPath, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  assertPrivateDirectory(paths.root, 'WORKFLOW_LOCAL_ADOPTION_STATE_UNSAFE');
  assertPrivateDirectory(
    paths.localSessions,
    'WORKFLOW_LOCAL_ADOPTION_STATE_UNSAFE',
  );
  const binding = readLocalBinding(bindingPath);
  if (
    binding.parentChangeId !== parentChangeId ||
    binding.parentBranch !== identity.branchRef ||
    binding.parentWorkspacePath !== identity.worktreeRoot
  ) {
    throw localBindingMismatch();
  }
  const adoptionPath = path.join(
    paths.adoptions,
    `${identityFileName('adoption', binding.txId)}.json`,
  );
  assertPrivateDirectory(
    paths.adoptions,
    'WORKFLOW_LOCAL_ADOPTION_STATE_UNSAFE',
  );
  const adoption = readLocalAdoptionJournal(adoptionPath, binding.txId);
  const journal = adoption.journal;
  assertLocalBindingJournalIdentity(paths, binding, journal);
  assertLocalAdoptionWorkflowBinding(
    paths,
    journal,
    adoption.artifactRecordDigest,
  );

  if (journal.state === 'ENGINE_BINDING_ROLLED_BACK') {
    assertTerminalRolledBackBinding(binding, journal);
    return null;
  }
  if (journal.state !== 'COMMITTED') {
    assertPermittedIncompleteBinding(binding, journal);
    throw trustError(
      'WORKFLOW_LOCAL_ADOPTION_INCOMPLETE',
      'Local engine adoption is not terminal; use harness-bootstrap to inspect or recover it.',
      14,
    );
  }
  assertTerminalCommittedBinding(binding, journal);
  verifyLocalEngineArtifact(paths, binding.activeArtifact);
  return deepFreeze({
    executablePath: binding.activeArtifact.executablePath,
    executableDigest: binding.activeArtifact.executableDigest,
    resumeBinding: {
      kind: 'local-engine-resume-binding.v1',
      parentChangeId: binding.parentChangeId,
      checkpointId: binding.checkpointId,
      engineDigest: binding.engineDigest,
    },
  });
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

function readLocalBinding(filePath: string): BootstrapLocalEngineBinding {
  const value = readCanonicalPrivateRecord(filePath, localBindingCorrupt);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'activeArtifact',
      'blocker',
      'checkpointId',
      'engineDigest',
      'generation',
      'interventionChangeId',
      'interventionState',
      'kind',
      'parentBranch',
      'parentChangeId',
      'parentWorkspacePath',
      'recordDigest',
      'sessionSchema',
      'txId',
      'updatedAt',
    ]) ||
    value.kind !== 'local-parent-session-metadata.v2' ||
    !verifyRecordDigest(value)
  ) {
    throw localBindingCorrupt();
  }
  const binding = value as unknown as BootstrapLocalEngineBinding;
  if (
    !isNonEmptyTrimmed(binding.parentChangeId) ||
    !isNonEmptyTrimmed(binding.parentWorkspacePath) ||
    !path.isAbsolute(binding.parentWorkspacePath) ||
    path.resolve(binding.parentWorkspacePath) !== binding.parentWorkspacePath ||
    binding.parentBranch !== `refs/heads/work/${binding.parentChangeId}` ||
    !isNonEmptyTrimmed(binding.interventionChangeId) ||
    !isNonEmptyTrimmed(binding.txId) ||
    !isDigest(binding.checkpointId) ||
    !isDigest(binding.engineDigest) ||
    !isRecord(binding.activeArtifact) ||
    !hasExactKeys(binding.activeArtifact, [
      'artifactId',
      'executableDigest',
      'executablePath',
    ]) ||
    !isDigest(binding.activeArtifact.artifactId) ||
    !isDigest(binding.activeArtifact.executableDigest) ||
    typeof binding.activeArtifact.executablePath !== 'string' ||
    !path.isAbsolute(binding.activeArtifact.executablePath) ||
    path.resolve(binding.activeArtifact.executablePath) !==
      binding.activeArtifact.executablePath ||
    !isNonEmptyTrimmed(binding.sessionSchema) ||
    !['active', 'adopted'].includes(binding.interventionState) ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation < 1 ||
    !isCanonicalIso(binding.updatedAt) ||
    !validLocalBlocker(binding)
  ) {
    throw localBindingCorrupt();
  }
  return binding;
}

function readLocalAdoptionJournal(
  filePath: string,
  txId: string,
): BootstrapLocalAdoptionRecord {
  const value = readCanonicalPrivateRecord(filePath, localJournalCorrupt);
  const recordKeys = [
    'artifactRecordDigest',
    'createdAt',
    'effectsPerformed',
    'grantEnvelopeDigest',
    'journal',
    'kind',
    'maintenanceGrantEnvelope',
    'observations',
    'recordDigest',
    'updatedAt',
  ];
  if (
    !isRecord(value) ||
    !hasExactKeys(value, recordKeys) ||
    value.kind !== 'persisted-engine-adoption.v2' ||
    value.effectsPerformed !== false ||
    !verifyRecordDigest(value) ||
    !isDigest(value.grantEnvelopeDigest) ||
    canonicalDigest(value.maintenanceGrantEnvelope) !==
      value.grantEnvelopeDigest ||
    !Array.isArray(value.observations) ||
    !isCanonicalIso(value.createdAt) ||
    !isCanonicalIso(value.updatedAt) ||
    Date.parse(value.updatedAt) < Date.parse(value.createdAt) ||
    !isRecord(value.journal) ||
    !isDigest(value.artifactRecordDigest)
  ) {
    throw localJournalCorrupt();
  }
  const journal = value.journal as unknown as BootstrapAdoptionJournal;
  const journalKeys = [
    'artifactId',
    'checkpointId',
    'fromEngineDigest',
    'grantId',
    'history',
    'interventionChangeId',
    'journalDigest',
    'kind',
    'parentChangeId',
    'sessionSchema',
    'state',
    'toEngineDigest',
    'txId',
    'workflowBindingDigest',
    'workflowStatus',
  ];
  if (
    !hasExactKeys(value.journal, journalKeys) ||
    journal.kind !== 'engine-adoption-journal.v1' ||
    journal.txId !== txId ||
    !isNonEmptyTrimmed(journal.txId) ||
    !isNonEmptyTrimmed(journal.grantId) ||
    !isNonEmptyTrimmed(journal.parentChangeId) ||
    !isNonEmptyTrimmed(journal.interventionChangeId) ||
    !isNonEmptyTrimmed(journal.sessionSchema) ||
    !isDigest(journal.checkpointId) ||
    !isDigest(journal.fromEngineDigest) ||
    !isDigest(journal.toEngineDigest) ||
    !isDigest(journal.artifactId) ||
    !isDigest(journal.workflowBindingDigest) ||
    journal.workflowStatus !== 'repair-active' ||
    !verifyJournalDigest(value.journal) ||
    !validAdoptionHistory(journal.state, journal.history)
  ) {
    throw localJournalCorrupt();
  }
  return {
    journal,
    artifactRecordDigest: value.artifactRecordDigest as Sha256Digest,
  };
}

function assertLocalAdoptionWorkflowBinding(
  paths: BootstrapPaths,
  journal: BootstrapAdoptionJournal,
  artifactRecordDigest: Sha256Digest,
): void {
  if (
    !isDigest(journal.workflowBindingDigest) ||
    journal.workflowStatus !== 'repair-active'
  ) {
    throw localJournalCorrupt();
  }
  assertPrivateDirectory(
    paths.sidecarSessions,
    'WORKFLOW_LOCAL_ADOPTION_STATE_UNSAFE',
  );
  const sidecarPath = path.join(
    paths.sidecarSessions,
    `${identityFileName('sidecar-session', journal.parentChangeId)}.json`,
  );
  const value = readCanonicalPrivateRecord(sidecarPath, localJournalCorrupt);
  if (
    !isRecord(value) ||
    value.kind !== 'bootstrap-sidecar-session.v2' ||
    !hasExactKeys(value, [
      'adoption',
      'artifacts',
      'createdAt',
      'history',
      'identity',
      'kind',
      'parentUnblock',
      'promotion',
      'recordDigest',
      'sidecarSessionId',
      'state',
      'updatedAt',
      'workflowBinding',
      'workspace',
    ]) ||
    !verifyRecordDigest(value) ||
    !isRecord(value.identity) ||
    !hasExactKeys(value.identity, [
      'checkpointId',
      'interventionChangeId',
      'parentChangeId',
      'workspaceId',
    ]) ||
    !isRecord(value.workflowBinding) ||
    !hasExactKeys(value.workflowBinding, [
      'baselineOid',
      'changeId',
      'changeRef',
      'checkpointId',
      'kind',
      'parentChangeId',
      'repositoryRoot',
      'status',
      'workflowBindingDigest',
      'workflowId',
      'workflowType',
      'workspaceId',
    ]) ||
    !isRecord(value.workspace) ||
    !hasExactKeys(value.workspace, [
      'changeRef',
      'childWorkspacePath',
      'materializedAt',
      'receiptDigest',
      'state',
    ]) ||
    !Array.isArray(value.artifacts)
  ) {
    throw localJournalCorrupt();
  }
  const identity = value.identity;
  const workflow = value.workflowBinding;
  const workspace = value.workspace;
  if (
    workflow.kind !== 'bootstrap-maintenance-workflow.v1' ||
    workflow.workflowType !== 'bootstrap-maintenance' ||
    !isDigest(workflow.workflowId) ||
    !isDigest(workflow.workflowBindingDigest) ||
    !isDigest(workflow.checkpointId) ||
    !isDigest(workflow.workspaceId) ||
    !isNonEmptyTrimmed(workflow.changeId) ||
    !isNonEmptyTrimmed(workflow.parentChangeId) ||
    typeof workflow.repositoryRoot !== 'string' ||
    !path.isAbsolute(workflow.repositoryRoot) ||
    path.resolve(workflow.repositoryRoot) !== workflow.repositoryRoot ||
    !isNonEmptyTrimmed(workflow.changeRef) ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(String(workflow.baselineOid)) ||
    !['repair-active', 'adopted', 'abandoned'].includes(
      String(workflow.status),
    ) ||
    workflow.status !== value.state ||
    identity.parentChangeId !== journal.parentChangeId ||
    identity.interventionChangeId !== journal.interventionChangeId ||
    identity.checkpointId !== journal.checkpointId ||
    workflow.parentChangeId !== identity.parentChangeId ||
    workflow.changeId !== identity.interventionChangeId ||
    workflow.checkpointId !== identity.checkpointId ||
    workflow.workspaceId !== identity.workspaceId ||
    workflow.repositoryRoot !== workspace.childWorkspacePath ||
    workflow.changeRef !== workspace.changeRef
  ) {
    throw localJournalCorrupt();
  }
  const { workflowBindingDigest, ...workflowPayload } = workflow;
  const expectedWorkflowId = canonicalDigest({
    kind: 'bootstrap-maintenance-workflow-identity.v1',
    changeId: workflow.changeId,
    parentChangeId: workflow.parentChangeId,
    checkpointId: workflow.checkpointId,
    workspaceId: workflow.workspaceId,
  });
  const expectedBindingDigest = canonicalDigest(workflowPayload);
  const activeBindingDigest = canonicalDigest({
    ...workflowPayload,
    status: 'repair-active',
  });
  if (
    workflow.workflowId !== expectedWorkflowId ||
    workflowBindingDigest !== expectedBindingDigest ||
    journal.workflowBindingDigest !== activeBindingDigest ||
    value.sidecarSessionId !==
      canonicalDigest({
        kind: 'bootstrap-sidecar-session-identity.v2',
        ...identity,
        workflowId: workflow.workflowId,
      }) ||
    (journal.state === 'COMMITTED'
      ? !['repair-active', 'adopted'].includes(String(workflow.status))
      : workflow.status !== 'repair-active')
  ) {
    throw localJournalCorrupt();
  }
  const matchingArtifacts = value.artifacts.filter((artifact) => {
    if (
      !isRecord(artifact) ||
      !hasExactKeys(artifact, [
        'artifactId',
        'evidenceDigest',
        'executableDigest',
        'readyAt',
        'sourceDigest',
        'workflowBindingDigest',
        'workflowStatus',
      ])
    ) {
      throw localJournalCorrupt();
    }
    if (
      !isDigest(artifact.artifactId) ||
      !isDigest(artifact.evidenceDigest) ||
      !isDigest(artifact.executableDigest) ||
      !isDigest(artifact.sourceDigest) ||
      !isCanonicalIso(artifact.readyAt) ||
      artifact.workflowBindingDigest !== activeBindingDigest ||
      artifact.workflowStatus !== 'repair-active'
    ) {
      throw localJournalCorrupt();
    }
    return (
      artifact.artifactId === journal.artifactId &&
      artifact.evidenceDigest === artifactRecordDigest
    );
  });
  if (matchingArtifacts.length !== 1) {
    throw localJournalCorrupt();
  }
  assertSidecarAdoptionBinding(value, journal, activeBindingDigest);
}

function assertSidecarAdoptionBinding(
  sidecar: Record<string, unknown>,
  journal: BootstrapAdoptionJournal,
  activeBindingDigest: Sha256Digest,
): void {
  const adoption = sidecar.adoption;
  if (sidecar.state === 'repair-active') {
    if (adoption !== null) throw localJournalCorrupt();
    return;
  }
  if (
    sidecar.state !== 'adopted' ||
    journal.state !== 'COMMITTED' ||
    !isRecord(adoption) ||
    !hasExactKeys(adoption, [
      'adoptedAt',
      'artifactId',
      'journalDigest',
      'txId',
      'workflowBindingDigest',
      'workflowStatus',
    ]) ||
    adoption.txId !== journal.txId ||
    adoption.artifactId !== journal.artifactId ||
    adoption.journalDigest !== journal.journalDigest ||
    !isCanonicalIso(adoption.adoptedAt) ||
    adoption.workflowBindingDigest !== activeBindingDigest ||
    adoption.workflowStatus !== 'repair-active'
  ) {
    throw localJournalCorrupt();
  }
}

function assertLocalBindingJournalIdentity(
  paths: BootstrapPaths,
  binding: BootstrapLocalEngineBinding,
  journal: BootstrapAdoptionJournal,
): void {
  const expectedExecutablePath = path.join(
    paths.localArtifacts,
    journal.artifactId.slice('sha256:'.length),
    'engine',
  );
  if (
    binding.txId !== journal.txId ||
    binding.parentChangeId !== journal.parentChangeId ||
    binding.interventionChangeId !== journal.interventionChangeId ||
    binding.checkpointId !== journal.checkpointId ||
    binding.sessionSchema !== journal.sessionSchema ||
    binding.activeArtifact.artifactId !== journal.artifactId ||
    binding.activeArtifact.executableDigest !== journal.toEngineDigest ||
    binding.activeArtifact.executablePath !== expectedExecutablePath
  ) {
    throw localBindingMismatch();
  }
}

function assertTerminalCommittedBinding(
  binding: BootstrapLocalEngineBinding,
  journal: BootstrapAdoptionJournal,
): void {
  if (
    binding.engineDigest !== journal.toEngineDigest ||
    binding.generation !== 3 ||
    binding.interventionState !== 'adopted' ||
    binding.blocker !== null
  ) {
    throw localBindingMismatch();
  }
}

function assertTerminalRolledBackBinding(
  binding: BootstrapLocalEngineBinding,
  journal: BootstrapAdoptionJournal,
): void {
  if (
    binding.engineDigest !== journal.fromEngineDigest ||
    binding.generation !== 3 ||
    binding.interventionState !== 'active' ||
    !activeLocalBlockerMatches(binding, journal)
  ) {
    throw localBindingMismatch();
  }
}

function assertPermittedIncompleteBinding(
  binding: BootstrapLocalEngineBinding,
  journal: BootstrapAdoptionJournal,
): void {
  const beforeSwitch =
    binding.generation === 1 &&
    binding.engineDigest === journal.fromEngineDigest &&
    binding.interventionState === 'active' &&
    activeLocalBlockerMatches(binding, journal);
  const afterSwitch =
    binding.generation === 2 &&
    binding.engineDigest === journal.toEngineDigest &&
    binding.interventionState === 'active' &&
    activeLocalBlockerMatches(binding, journal);
  const finalizedAheadOfJournal =
    journal.state === 'HEALTHY' &&
    binding.generation === 3 &&
    binding.engineDigest === journal.toEngineDigest &&
    binding.interventionState === 'adopted' &&
    binding.blocker === null;
  const rollbackAheadOfJournal =
    journal.state === 'ROLLBACK_REQUIRED' &&
    binding.generation === 3 &&
    binding.engineDigest === journal.fromEngineDigest &&
    binding.interventionState === 'active' &&
    activeLocalBlockerMatches(binding, journal);
  const allowed =
    journal.state === 'PREPARED'
      ? beforeSwitch
      : journal.state === 'PARENT_CHECKPOINTED'
        ? beforeSwitch || afterSwitch
        : journal.state === 'ENGINE_BINDING_UPDATED' ||
            journal.state === 'NEW_ENGINE_STARTED'
          ? afterSwitch
          : journal.state === 'HEALTHY'
            ? afterSwitch || finalizedAheadOfJournal
            : journal.state === 'ROLLBACK_REQUIRED'
              ? afterSwitch || rollbackAheadOfJournal
              : false;
  if (!allowed) throw localBindingMismatch();
}

function activeLocalBlockerMatches(
  binding: BootstrapLocalEngineBinding,
  journal: BootstrapAdoptionJournal,
): boolean {
  return (
    isRecord(binding.blocker) &&
    hasExactKeys(binding.blocker, ['blockedBy', 'checkpointId', 'kind']) &&
    binding.blocker.kind === 'harness-intervention' &&
    binding.blocker.checkpointId === journal.checkpointId &&
    binding.blocker.blockedBy === journal.interventionChangeId
  );
}

function validLocalBlocker(binding: BootstrapLocalEngineBinding): boolean {
  return (
    binding.blocker === null ||
    (isRecord(binding.blocker) &&
      hasExactKeys(binding.blocker, ['blockedBy', 'checkpointId', 'kind']) &&
      binding.blocker.kind === 'harness-intervention' &&
      binding.blocker.checkpointId === binding.checkpointId &&
      binding.blocker.blockedBy === binding.interventionChangeId)
  );
}

function validAdoptionHistory(state: unknown, history: unknown): boolean {
  if (
    typeof state !== 'string' ||
    !(state in ADOPTION_HISTORIES) ||
    !Array.isArray(history)
  ) {
    return false;
  }
  const expected = ADOPTION_HISTORIES[state as BootstrapAdoptionState];
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

function verifyLocalEngineArtifact(
  paths: BootstrapPaths,
  artifact: BootstrapLocalEngineBinding['activeArtifact'],
): void {
  const expectedPath = path.join(
    paths.localArtifacts,
    artifact.artifactId.slice('sha256:'.length),
    'engine',
  );
  if (artifact.executablePath !== expectedPath) throw localBindingMismatch();
  assertPrivateDirectory(
    paths.localArtifacts,
    'WORKFLOW_LOCAL_ADOPTION_ARTIFACT_UNSAFE',
  );
  assertPrivateDirectory(
    path.dirname(expectedPath),
    'WORKFLOW_LOCAL_ADOPTION_ARTIFACT_UNSAFE',
  );
  const stats = fs.lstatSync(expectedPath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== PRIVATE_EXECUTABLE_MODE ||
    stats.size < 1 ||
    stats.size > MAX_EXECUTABLE_BYTES ||
    fs.realpathSync(expectedPath) !== expectedPath
  ) {
    throw trustError(
      'WORKFLOW_LOCAL_ADOPTION_ARTIFACT_UNSAFE',
      'Materialized local engine artifact is missing, indirect, or unsafe.',
      12,
    );
  }
  const descriptor = fs.openSync(
    expectedPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    if (
      opened.dev !== stats.dev ||
      opened.ino !== stats.ino ||
      opened.size !== stats.size ||
      rawDigest(bytes) !== artifact.executableDigest
    ) {
      throw trustError(
        'WORKFLOW_LOCAL_ADOPTION_ARTIFACT_DIGEST_MISMATCH',
        'Materialized local engine artifact digest changed.',
        13,
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}
