/** Append-only supervisor history and promoted terminal-state replay. */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import {
  supervisorNotTerminal,
  identityFileName,
  isRecord,
  hasExactKeys,
  verifyRecordDigest,
  isCanonicalIso,
  isNonEmptyTrimmed,
  isDigest,
  verifyJournalDigest,
  validTerminalHistory,
  MAX_PROMOTION_BUNDLE_BYTES,
  canonicalDigest,
  CONTROL_PLANE_HISTORY_RECORD_FILE,
  positiveSafeInteger,
  isGitObjectId,
  INITIAL_BOOTSTRAP_PHASE_FILES,
} from './control-plane-bootstrap-values.ts';
import type {
  BootstrapPaths,
  BootstrapControlPlaneSupervisorState,
  InitialSupervisorProvenance,
  BootstrapSupervisorHistoryAnchor,
  BootstrapSupervisorHistoryTerminal,
  BootstrapSupervisorHistoryTransition,
  Sha256Digest,
  BootstrapSupervisorHistory,
  BootstrapSupervisorHistoryRecord,
  BootstrapSupervisorHistoryAnchorAuthority,
  BootstrapSupervisorHistoryArtifact,
} from './control-plane-bootstrap-types.ts';
import {
  readCanonicalPrivateRecord,
  assertPrivateDirectory,
} from './control-plane-bootstrap-files.ts';
import {
  assertPromotionHasValidInitialBootstrapAnchor,
  readInitialBootstrapJournalRecord,
} from './control-plane-bootstrap-initial.ts';
import { assertMaterializedPromotionArtifact } from './control-plane-bootstrap-closure.ts';
import {
  validProtectedCapabilityManifestV2,
  affectedCapabilitiesForV2,
} from './control-plane-bootstrap-protected-records.ts';
import { assertV3PromotionHumanSignatures } from './control-plane-bootstrap-promotion.ts';
import {
  validTerminalObservationsV2,
  validExactChangesV2,
  validBoundedSignature,
  assertedGrantPayloadV3,
  validPromotionBundleV3,
} from './control-plane-bootstrap-promotion-records.ts';

export function assertTerminalSelectionV3(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
  currentRecord: Record<string, unknown>,
): void {
  const history = readBootstrapSupervisorHistory(paths);
  const leaf = history.leaf;
  const transition = supervisor.transition;
  if (
    transition === null ||
    history.anchor.repositoryId !== supervisor.repositoryId ||
    leaf.repositoryId !== supervisor.repositoryId ||
    leaf.generation !== supervisor.generation ||
    leaf.supervisorRecordDigest !== supervisor.recordDigest ||
    canonicalJson(leaf.activeArtifact) !==
      canonicalJson({
        artifactId: supervisor.activeArtifact.artifactId,
        executableDigest: supervisor.activeArtifact.executableDigest,
        closureDigest: supervisor.activeArtifact.closureDigest,
      }) ||
    leaf.grantId !== transition.grantId ||
    leaf.txId !== transition.txId ||
    transition.phase !==
      (leaf.terminalState === 'FINALIZED'
        ? 'candidate-selected'
        : 'rollback-restored') ||
    leaf.updateRecordDigest !== currentRecord.recordDigest
  ) {
    throw supervisorNotTerminal();
  }
  const initialProvenance = assertBootstrapHistoryAnchor(paths, history.anchor);
  const expectedGrantIds = new Set<string>();
  let index = 1;
  while (index < history.records.length) {
    const predecessor = history.records[index - 1]!;
    if (
      predecessor.kind !== 'control-plane-supervisor-history-anchor.v1' &&
      predecessor.kind !== 'control-plane-supervisor-history-terminal.v1'
    ) {
      throw supervisorNotTerminal();
    }
    const candidateTransition = history.records[index];
    if (
      candidateTransition?.kind !==
        'control-plane-supervisor-history-transition.v1' ||
      candidateTransition.phase !== 'candidate-selected'
    ) {
      throw supervisorNotTerminal();
    }
    const possibleRollback = history.records[index + 1];
    const rollbackTransition =
      possibleRollback?.kind ===
        'control-plane-supervisor-history-transition.v1' &&
      possibleRollback.phase === 'rollback-restored'
        ? possibleRollback
        : null;
    const terminal = history.records[index + (rollbackTransition ? 2 : 1)];
    if (terminal?.kind !== 'control-plane-supervisor-history-terminal.v1') {
      throw supervisorNotTerminal();
    }
    const record =
      terminal.recordDigest === leaf.recordDigest
        ? currentRecord
        : readCanonicalPrivateRecord(
            path.join(
              paths.controlUpdates,
              `${identityFileName('control-update', terminal.grantId)}.json`,
            ),
          );
    if (!isRecord(record)) throw supervisorNotTerminal();
    assertV3HistoryUpdate(
      paths,
      initialProvenance,
      history.anchor,
      predecessor,
      candidateTransition,
      rollbackTransition,
      terminal,
      record,
    );
    expectedGrantIds.add(terminal.grantId);
    index += rollbackTransition ? 3 : 2;
  }
  assertExactControlPlaneAuthorityInventory(paths, expectedGrantIds);
}

function assertV3HistoryUpdate(
  paths: BootstrapPaths,
  initialProvenance: InitialSupervisorProvenance,
  anchor: BootstrapSupervisorHistoryAnchor,
  predecessor:
    BootstrapSupervisorHistoryAnchor | BootstrapSupervisorHistoryTerminal,
  candidateTransition: BootstrapSupervisorHistoryTransition,
  rollbackTransition: BootstrapSupervisorHistoryTransition | null,
  terminal: BootstrapSupervisorHistoryTerminal,
  record: Record<string, unknown>,
): void {
  if (
    !hasExactKeys(record, [
      'afterManifest',
      'beforeManifest',
      'changes',
      'createdAt',
      'effectsPerformed',
      'envelope',
      'grantState',
      'kind',
      'observations',
      'recordDigest',
      'transaction',
      'updatedAt',
    ]) ||
    record.kind !== 'persisted-control-plane-update.v3' ||
    record.grantState !== 'consumed' ||
    record.effectsPerformed !== false ||
    !verifyRecordDigest(record) ||
    !isCanonicalIso(record.createdAt) ||
    !isCanonicalIso(record.updatedAt) ||
    Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
    !isRecord(record.transaction) ||
    !isRecord(record.envelope) ||
    !isRecord(record.beforeManifest) ||
    !isRecord(record.afterManifest) ||
    !Array.isArray(record.changes) ||
    !Array.isArray(record.observations)
  ) {
    throw supervisorNotTerminal();
  }
  const transaction = record.transaction;
  if (
    !hasExactKeys(transaction, [
      'afterClosureDigest',
      'beforeClosureDigest',
      'candidateDigest',
      'grantId',
      'history',
      'journalDigest',
      'kind',
      'recoveryBundleDigest',
      'state',
      'txId',
      'updaterVersion',
    ]) ||
    transaction.kind !== 'minimal-control-plane-updater.v1' ||
    transaction.updaterVersion !== 3 ||
    transaction.grantId !== terminal.grantId ||
    transaction.txId !== terminal.txId ||
    !isNonEmptyTrimmed(transaction.grantId) ||
    !isNonEmptyTrimmed(transaction.txId) ||
    !isDigest(transaction.candidateDigest) ||
    !isDigest(transaction.beforeClosureDigest) ||
    !isDigest(transaction.afterClosureDigest) ||
    !isDigest(transaction.recoveryBundleDigest) ||
    !verifyJournalDigest(transaction) ||
    !validTerminalHistory(transaction.state, transaction.history) ||
    !validTerminalObservationsV2(
      transaction.history,
      record.observations,
      record.createdAt,
      record.updatedAt,
    ) ||
    transaction.state !== terminal.terminalState ||
    transaction.beforeClosureDigest !== predecessor.activeArtifact.closureDigest
  ) {
    throw supervisorNotTerminal();
  }
  const beforeManifest = record.beforeManifest;
  const afterManifest = record.afterManifest;
  const changes = record.changes;
  if (
    !validProtectedCapabilityManifestV2(beforeManifest) ||
    !validProtectedCapabilityManifestV2(afterManifest) ||
    !validExactChangesV2(changes) ||
    beforeManifest.manifestDigest !== transaction.beforeClosureDigest ||
    afterManifest.manifestDigest !== transaction.afterClosureDigest ||
    (beforeManifest.manifestDigest !== afterManifest.manifestDigest &&
      !changes.some((change) => change.path === beforeManifest.manifestPath))
  ) {
    throw supervisorNotTerminal();
  }
  const envelope = record.envelope;
  if (
    !hasExactKeys(envelope, ['payload', 'signature']) ||
    !isRecord(envelope.payload) ||
    !validBoundedSignature(envelope.signature)
  ) {
    throw supervisorNotTerminal();
  }
  const payload = assertedGrantPayloadV3(envelope.payload);
  if (
    payload.grantId !== terminal.grantId ||
    payload.repositoryId !== terminal.repositoryId ||
    payload.candidateDigest !== transaction.candidateDigest ||
    payload.beforeClosureDigest !== transaction.beforeClosureDigest ||
    payload.afterClosureDigest !== transaction.afterClosureDigest ||
    payload.recoveryBundle.bundleDigest !== transaction.recoveryBundleDigest ||
    canonicalJson(payload.exactChanges) !== canonicalJson(changes) ||
    Date.parse(payload.issuedAt) > Date.parse(record.createdAt)
  ) {
    throw supervisorNotTerminal();
  }
  const bundle = readCanonicalPrivateRecord(
    path.join(
      paths.bundles,
      `${identityFileName('control-plane-promotion', terminal.grantId)}.json`,
    ),
    supervisorNotTerminal,
    MAX_PROMOTION_BUNDLE_BYTES,
  );
  if (
    !isRecord(bundle) ||
    !validPromotionBundleV3(bundle, payload, beforeManifest, afterManifest)
  ) {
    throw supervisorNotTerminal();
  }
  const material = bundle.material;
  const lineage = bundle.lineage;
  const candidate = assertV3PromotionHumanSignatures(
    paths,
    initialProvenance,
    material,
    lineage,
    bundle.independentReviewAttestation,
    payload,
    envelope.signature,
    beforeManifest,
  );
  const impact = affectedCapabilitiesForV2(
    beforeManifest,
    afterManifest,
    changes,
  );
  if (
    impact === null ||
    canonicalJson(impact) !== canonicalJson(payload.affectedCapabilities) ||
    canonicalJson(payload.affectedCapabilities) !==
      canonicalJson(material.affectedCapabilities)
  ) {
    throw supervisorNotTerminal();
  }
  const candidateArtifact = material.candidateArtifact;
  const restartArtifact = material.recoveryBundle.restartArtifact;
  assertMaterializedPromotionArtifact(
    paths,
    candidateArtifact,
    material.candidateExecutableBase64,
  );
  assertMaterializedPromotionArtifact(
    paths,
    restartArtifact,
    material.recoveryBundle.restartExecutableBase64,
  );
  if (
    lineage.historyAnchorDigest !== anchor.recordDigest ||
    lineage.previousTerminalRecordDigest !== predecessor.recordDigest ||
    lineage.previousSupervisorRecordDigest !==
      predecessor.supervisorRecordDigest ||
    lineage.previousGeneration !== predecessor.generation ||
    lineage.candidateGeneration !== predecessor.generation + 1 ||
    lineage.rollbackGeneration !== predecessor.generation + 2 ||
    lineage.previousActiveTrustCommit !== predecessor.activeTrustCommit ||
    lineage.candidateTrustCommit !== candidate.candidateCommit ||
    candidateTransition.grantId !== payload.grantId ||
    candidateTransition.txId !== transaction.txId ||
    candidateTransition.grantEnvelopeDigest !== canonicalDigest(envelope) ||
    candidateTransition.promotionBundleDigest !== bundle.bundleDigest ||
    candidateTransition.promotionLineageDigest !== lineage.lineageDigest ||
    candidateTransition.sourceJournalDigest !==
      minimalUpdaterJournalDigestAt(transaction, 'RECOVERY_VERIFIED') ||
    candidateTransition.toGeneration !== lineage.candidateGeneration ||
    candidateTransition.activeTrustCommit !== lineage.candidateTrustCommit ||
    canonicalJson(candidateTransition.activeArtifact) !==
      canonicalJson({
        artifactId: candidateArtifact.artifactId,
        executableDigest: candidateArtifact.executableDigest,
        closureDigest: transaction.afterClosureDigest,
      }) ||
    terminal.updateRecordDigest !== record.recordDigest ||
    terminal.transactionJournalDigest !== transaction.journalDigest ||
    terminal.grantEnvelopeDigest !== canonicalDigest(envelope) ||
    terminal.promotionBundleDigest !== bundle.bundleDigest
  ) {
    throw supervisorNotTerminal();
  }
  if (transaction.state === 'FINALIZED') {
    if (
      rollbackTransition !== null ||
      terminal.previousRecordDigest !== candidateTransition.recordDigest ||
      terminal.generation !== lineage.candidateGeneration
    ) {
      throw supervisorNotTerminal();
    }
  } else if (
    rollbackTransition === null ||
    rollbackTransition.grantId !== payload.grantId ||
    rollbackTransition.txId !== transaction.txId ||
    rollbackTransition.sourceJournalDigest !==
      minimalUpdaterJournalDigestAt(transaction, 'ROLLBACK_REQUIRED') ||
    rollbackTransition.toGeneration !== lineage.rollbackGeneration ||
    rollbackTransition.activeTrustCommit !==
      lineage.previousActiveTrustCommit ||
    canonicalJson(rollbackTransition.activeArtifact) !==
      canonicalJson({
        artifactId: restartArtifact.artifactId,
        executableDigest: restartArtifact.executableDigest,
        closureDigest: transaction.beforeClosureDigest,
      }) ||
    terminal.previousRecordDigest !== rollbackTransition.recordDigest ||
    terminal.generation !== lineage.rollbackGeneration
  ) {
    throw supervisorNotTerminal();
  }
}

function minimalUpdaterJournalDigestAt(
  transaction: Record<string, unknown>,
  state: 'RECOVERY_VERIFIED' | 'ROLLBACK_REQUIRED',
): Sha256Digest {
  if (!Array.isArray(transaction.history)) throw supervisorNotTerminal();
  const index = transaction.history.findIndex(
    (entry) => isRecord(entry) && entry.state === state,
  );
  if (index < 0) throw supervisorNotTerminal();
  const { journalDigest: _journalDigest, ...payload } = transaction;
  return canonicalDigest({
    ...payload,
    state,
    history: transaction.history.slice(0, index + 1),
  });
}

function assertExactControlPlaneAuthorityInventory(
  paths: BootstrapPaths,
  expectedGrantIds: ReadonlySet<string>,
): void {
  const expectedUpdates = [...expectedGrantIds]
    .map((grantId) => `${identityFileName('control-update', grantId)}.json`)
    .sort();
  const expectedBundles = [...expectedGrantIds]
    .map(
      (grantId) =>
        `${identityFileName('control-plane-promotion', grantId)}.json`,
    )
    .sort();
  for (const [directory, expected] of [
    [paths.controlUpdates, expectedUpdates],
    [paths.bundles, expectedBundles],
  ] as const) {
    assertPrivateDirectory(directory, 'CONTROL_PLANE_STATE_UNSAFE');
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    if (
      canonicalJson(entries.map(({ name }) => name)) !==
        canonicalJson(expected) ||
      entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
    ) {
      throw supervisorNotTerminal();
    }
  }
}

function readBootstrapSupervisorHistory(
  paths: BootstrapPaths,
): BootstrapSupervisorHistory {
  assertPrivateDirectory(paths.supervisorHistory, 'CONTROL_PLANE_STATE_UNSAFE');
  const records = fs
    .readdirSync(paths.supervisorHistory, { withFileTypes: true })
    .map((entry) => {
      if (
        !CONTROL_PLANE_HISTORY_RECORD_FILE.test(entry.name) ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      ) {
        throw supervisorNotTerminal();
      }
      const record = parseBootstrapSupervisorHistoryRecord(
        readCanonicalPrivateRecord(
          path.join(paths.supervisorHistory, entry.name),
          supervisorNotTerminal,
        ),
      );
      if (
        entry.name !== `${record.recordDigest.slice('sha256:'.length)}.json`
      ) {
        throw supervisorNotTerminal();
      }
      return record;
    });
  if (records.length === 0) throw supervisorNotTerminal();
  const digests = new Set<string>();
  const childCounts = new Map<string, number>();
  for (const record of records) {
    if (digests.has(record.recordDigest)) throw supervisorNotTerminal();
    digests.add(record.recordDigest);
    if (record.previousRecordDigest !== null) {
      childCounts.set(
        record.previousRecordDigest,
        (childCounts.get(record.previousRecordDigest) ?? 0) + 1,
      );
    }
  }
  if ([...childCounts.values()].some((count) => count !== 1)) {
    throw supervisorNotTerminal();
  }
  const ordered = records.sort((left, right) => left.sequence - right.sequence);
  const anchor = ordered[0];
  if (
    anchor?.kind !== 'control-plane-supervisor-history-anchor.v1' ||
    anchor.sequence !== 0
  ) {
    throw supervisorNotTerminal();
  }
  for (let index = 0; index < ordered.length; index += 1) {
    const current = ordered[index]!;
    if (
      current.sequence !== index ||
      current.repositoryId !== anchor.repositoryId
    ) {
      throw supervisorNotTerminal();
    }
    if (index === 0) continue;
    const previous = ordered[index - 1]!;
    if (
      current.previousRecordDigest !== previous.recordDigest ||
      Date.parse(current.recordedAt) < Date.parse(previous.recordedAt)
    ) {
      throw supervisorNotTerminal();
    }
    if (current.kind === 'control-plane-supervisor-history-transition.v1') {
      assertBootstrapHistoryTransition(previous, current);
      if (current.phase === 'rollback-restored') {
        const restored = ordered[index - 2];
        if (
          restored === undefined ||
          canonicalJson(current.activeArtifact) !==
            canonicalJson(bootstrapHistoryArtifact(restored)) ||
          current.activeTrustCommit !== bootstrapHistoryTrustCommit(restored)
        ) {
          throw supervisorNotTerminal();
        }
      }
    } else if (
      current.kind === 'control-plane-supervisor-history-terminal.v1'
    ) {
      assertBootstrapHistoryTerminal(previous, current);
    } else {
      throw supervisorNotTerminal();
    }
  }
  const leaf = ordered.at(-1);
  if (leaf?.kind !== 'control-plane-supervisor-history-terminal.v1') {
    throw supervisorNotTerminal();
  }
  return { records: ordered, anchor, leaf };
}

function parseBootstrapSupervisorHistoryRecord(
  value: unknown,
): BootstrapSupervisorHistoryRecord {
  if (!isRecord(value) || !verifyRecordDigest(value)) {
    throw supervisorNotTerminal();
  }
  if (value.kind === 'control-plane-supervisor-history-anchor.v1') {
    if (
      !hasExactKeys(value, [
        'activeArtifact',
        'activeTrustCommit',
        'authority',
        'generation',
        'kind',
        'previousRecordDigest',
        'recordDigest',
        'recordedAt',
        'repositoryId',
        'sequence',
        'supervisorRecordDigest',
      ]) ||
      value.sequence !== 0 ||
      value.previousRecordDigest !== null ||
      !positiveSafeInteger(value.generation) ||
      !isNonEmptyTrimmed(value.repositoryId) ||
      !isDigest(value.supervisorRecordDigest) ||
      !isGitObjectId(value.activeTrustCommit) ||
      !isCanonicalIso(value.recordedAt) ||
      !validBootstrapHistoryArtifact(value.activeArtifact)
    ) {
      throw supervisorNotTerminal();
    }
    const authority = parseBootstrapHistoryAnchorAuthority(value.authority);
    return {
      ...(value as unknown as BootstrapSupervisorHistoryAnchor),
      authority,
    };
  }
  if (value.kind === 'control-plane-supervisor-history-transition.v1') {
    if (
      !hasExactKeys(value, [
        'activeArtifact',
        'activeTrustCommit',
        'fromGeneration',
        'fromSupervisorRecordDigest',
        'grantEnvelopeDigest',
        'grantId',
        'kind',
        'phase',
        'previousRecordDigest',
        'promotionBundleDigest',
        'promotionLineageDigest',
        'recordDigest',
        'recordedAt',
        'repositoryId',
        'sequence',
        'sourceJournalDigest',
        'sourceTransactionState',
        'toGeneration',
        'toSupervisorRecordDigest',
        'txId',
      ]) ||
      !positiveSafeInteger(value.sequence) ||
      !positiveSafeInteger(value.fromGeneration) ||
      !positiveSafeInteger(value.toGeneration) ||
      value.toGeneration !== Number(value.fromGeneration) + 1 ||
      (value.phase !== 'candidate-selected' &&
        value.phase !== 'rollback-restored') ||
      (value.sourceTransactionState !== 'RECOVERY_VERIFIED' &&
        value.sourceTransactionState !== 'ROLLBACK_REQUIRED') ||
      !isNonEmptyTrimmed(value.repositoryId) ||
      !isNonEmptyTrimmed(value.grantId) ||
      !isNonEmptyTrimmed(value.txId) ||
      !isDigest(value.previousRecordDigest) ||
      !isDigest(value.fromSupervisorRecordDigest) ||
      !isDigest(value.toSupervisorRecordDigest) ||
      !isDigest(value.grantEnvelopeDigest) ||
      !isDigest(value.promotionBundleDigest) ||
      !isDigest(value.promotionLineageDigest) ||
      !isDigest(value.sourceJournalDigest) ||
      !isGitObjectId(value.activeTrustCommit) ||
      !isCanonicalIso(value.recordedAt) ||
      !validBootstrapHistoryArtifact(value.activeArtifact)
    ) {
      throw supervisorNotTerminal();
    }
    return value as unknown as BootstrapSupervisorHistoryTransition;
  }
  if (value.kind === 'control-plane-supervisor-history-terminal.v1') {
    if (
      !hasExactKeys(value, [
        'activeArtifact',
        'activeTrustCommit',
        'generation',
        'grantEnvelopeDigest',
        'grantId',
        'kind',
        'previousRecordDigest',
        'promotionBundleDigest',
        'recordDigest',
        'recordedAt',
        'repositoryId',
        'sequence',
        'supervisorRecordDigest',
        'terminalState',
        'transactionJournalDigest',
        'txId',
        'updateRecordDigest',
      ]) ||
      !positiveSafeInteger(value.sequence) ||
      !positiveSafeInteger(value.generation) ||
      (value.terminalState !== 'FINALIZED' &&
        value.terminalState !== 'ROLLED_BACK') ||
      !isNonEmptyTrimmed(value.repositoryId) ||
      !isNonEmptyTrimmed(value.grantId) ||
      !isNonEmptyTrimmed(value.txId) ||
      !isDigest(value.previousRecordDigest) ||
      !isDigest(value.supervisorRecordDigest) ||
      !isDigest(value.updateRecordDigest) ||
      !isDigest(value.transactionJournalDigest) ||
      !isDigest(value.grantEnvelopeDigest) ||
      !isDigest(value.promotionBundleDigest) ||
      !isGitObjectId(value.activeTrustCommit) ||
      !isCanonicalIso(value.recordedAt) ||
      !validBootstrapHistoryArtifact(value.activeArtifact)
    ) {
      throw supervisorNotTerminal();
    }
    return value as unknown as BootstrapSupervisorHistoryTerminal;
  }
  throw supervisorNotTerminal();
}

function parseBootstrapHistoryAnchorAuthority(
  value: unknown,
): BootstrapSupervisorHistoryAnchorAuthority {
  if (!isRecord(value)) throw supervisorNotTerminal();
  if (value.kind === 'initial-bootstrap-anchor.v1') {
    if (
      !hasExactKeys(value, ['initialBootstrapPublishedDigest', 'kind']) ||
      !isDigest(value.initialBootstrapPublishedDigest)
    ) {
      throw supervisorNotTerminal();
    }
    return value as unknown as BootstrapSupervisorHistoryAnchorAuthority;
  }
  throw supervisorNotTerminal();
}

function validBootstrapHistoryArtifact(
  value: unknown,
): value is BootstrapSupervisorHistoryArtifact {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['artifactId', 'closureDigest', 'executableDigest']) &&
    isDigest(value.artifactId) &&
    isDigest(value.executableDigest) &&
    isDigest(value.closureDigest)
  );
}

function assertBootstrapHistoryTransition(
  previous: BootstrapSupervisorHistoryRecord,
  current: BootstrapSupervisorHistoryTransition,
): void {
  if (
    current.fromGeneration !== bootstrapHistoryGeneration(previous) ||
    current.fromSupervisorRecordDigest !==
      bootstrapHistorySupervisorDigest(previous)
  ) {
    throw supervisorNotTerminal();
  }
  if (current.phase === 'candidate-selected') {
    if (
      (previous.kind !== 'control-plane-supervisor-history-anchor.v1' &&
        previous.kind !== 'control-plane-supervisor-history-terminal.v1') ||
      current.sourceTransactionState !== 'RECOVERY_VERIFIED'
    ) {
      throw supervisorNotTerminal();
    }
    return;
  }
  if (
    previous.kind !== 'control-plane-supervisor-history-transition.v1' ||
    previous.phase !== 'candidate-selected' ||
    current.sourceTransactionState !== 'ROLLBACK_REQUIRED' ||
    current.grantId !== previous.grantId ||
    current.txId !== previous.txId ||
    current.grantEnvelopeDigest !== previous.grantEnvelopeDigest ||
    current.promotionBundleDigest !== previous.promotionBundleDigest ||
    current.promotionLineageDigest !== previous.promotionLineageDigest
  ) {
    throw supervisorNotTerminal();
  }
}

function assertBootstrapHistoryTerminal(
  previous: BootstrapSupervisorHistoryRecord,
  current: BootstrapSupervisorHistoryTerminal,
): void {
  if (
    previous.kind !== 'control-plane-supervisor-history-transition.v1' ||
    current.generation !== previous.toGeneration ||
    current.supervisorRecordDigest !== previous.toSupervisorRecordDigest ||
    canonicalJson(current.activeArtifact) !==
      canonicalJson(previous.activeArtifact) ||
    current.activeTrustCommit !== previous.activeTrustCommit ||
    current.grantId !== previous.grantId ||
    current.txId !== previous.txId ||
    current.grantEnvelopeDigest !== previous.grantEnvelopeDigest ||
    current.promotionBundleDigest !== previous.promotionBundleDigest ||
    (current.terminalState === 'FINALIZED' &&
      previous.phase !== 'candidate-selected') ||
    (current.terminalState === 'ROLLED_BACK' &&
      previous.phase !== 'rollback-restored')
  ) {
    throw supervisorNotTerminal();
  }
}

function bootstrapHistoryGeneration(
  record: BootstrapSupervisorHistoryRecord,
): number {
  return record.kind === 'control-plane-supervisor-history-transition.v1'
    ? record.toGeneration
    : record.generation;
}

function bootstrapHistorySupervisorDigest(
  record: BootstrapSupervisorHistoryRecord,
): Sha256Digest {
  return record.kind === 'control-plane-supervisor-history-transition.v1'
    ? record.toSupervisorRecordDigest
    : record.supervisorRecordDigest;
}

function bootstrapHistoryArtifact(
  record: BootstrapSupervisorHistoryRecord,
): BootstrapSupervisorHistoryArtifact {
  return record.activeArtifact;
}

function bootstrapHistoryTrustCommit(
  record: BootstrapSupervisorHistoryRecord,
): string {
  return record.activeTrustCommit;
}

function assertBootstrapHistoryAnchor(
  paths: BootstrapPaths,
  anchor: BootstrapSupervisorHistoryAnchor,
): InitialSupervisorProvenance {
  const initial = assertPromotionHasValidInitialBootstrapAnchor(
    paths,
    anchor.repositoryId,
  );
  const published = readInitialBootstrapJournalRecord(
    path.join(
      paths.initialBootstrapJournal,
      INITIAL_BOOTSTRAP_PHASE_FILES.SUPERVISOR_PUBLISHED,
    ),
  );
  if (
    published.provenance.repositoryId !== anchor.repositoryId ||
    published.provenance.headOid !== initial.provenance.headOid
  ) {
    throw supervisorNotTerminal();
  }
  if (
    anchor.generation !== 1 ||
    anchor.supervisorRecordDigest !== published.supervisorRecordDigest ||
    canonicalJson(anchor.activeArtifact) !==
      canonicalJson({
        artifactId: published.activeArtifact.artifactId,
        executableDigest: published.activeArtifact.executableDigest,
        closureDigest: published.activeArtifact.closureDigest,
      }) ||
    anchor.activeTrustCommit !== published.provenance.headOid ||
    anchor.recordedAt !== published.initializedAt ||
    anchor.authority.initialBootstrapPublishedDigest !== published.recordDigest
  ) {
    throw supervisorNotTerminal();
  }
  return published.provenance;
}
