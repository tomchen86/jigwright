/**
 * Restores operational trust roots through durable reservations and audited
 * pointer updates.
 *
 * Invariants:
 * - A persisted restore reservation must retain the exact authorized
 *   envelope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './foundation/canonical-json/canonical-json.ts';
import { ExitCode } from './foundation/errors/errors.ts';
import type { PersistenceHumanSignatureVerifier } from './runtime/storage-journal/intervention-control-persistence.ts';
import {
  verifyRecoveryAuthorityDescriptor,
  assertRecoveryAuthorityDomain,
} from './recovery-authority.ts';
import type {
  RecoveryAuthorityImportBoundary,
  RecoveryAuthorityDescriptorV1,
  RecoveryAuthorityExpectations,
} from './recovery-authority.ts';
import {
  createReservation,
  assertGrantWindow,
  assertPointerCas,
  createPointer,
  pointerFileName,
  createReceipt,
  createTerminal,
  normalizePointer,
  normalizeReservation,
  canonicalRecoveryOperationalTrustRootRestoreStatement,
  normalizeReceipt,
  normalizeTerminal,
  normalizeAudit,
  normalizeAuditAcknowledgement,
  assertRecordChain,
  normalizeEnvelope,
  createAuditRecord,
  createAuditAcknowledgement,
} from './modules/authority/recovery-trust-root-contract.ts';
import type {
  RecoveryOperationalTrustRootRestoreDependencies,
  RecoveryOperationalTrustRootRestoreResult,
  RecoveryOperationalTrustRootReadDependencies,
  RecoveryOperationalTrustRootPointer,
  StatePaths,
  RecoveryOperationalTrustRootRestoreRecord,
  RecoveryOperationalTrustRootRestoreEnvelope,
  OperationPaths,
  RecoveryOperationalTrustRootRestoreGrantPayload,
} from './modules/authority/recovery-trust-root-contract.ts';
import {
  assertBoundaries,
  assertExternalAuditBoundary,
  readExternalEnvelope,
  operationPaths,
  hasExactPublicationEvidence,
  ensureImmutable,
  assertPrivateStoreBoundary,
  assertPrivateDirectory,
  statePaths,
  assertStateClosure,
  readPublished,
  readPreparation,
  assertOperationClosure,
  readOptionalPublished,
} from './modules/authority/recovery-trust-root-store.ts';
import { normalizeRoot } from './modules/authority/recovery-operational-trust-root.ts';
import type { RecoveryOperationalTrustRoot } from './modules/authority/recovery-operational-trust-root.ts';
import {
  canonicalDigest,
  stateCorrupt,
  alreadyConsumed,
  deepFreeze,
  isRecord,
  hasExactKeys,
  isExactAbsolutePath,
  restoreError,
  auditRootUnsafe,
  POINTER_FILE,
  PREPARATION,
  transitionIncomplete,
  digestHex,
  RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
  GRANT_ID,
  grantInvalid,
} from './modules/authority/recovery-trust-root-values.ts';
export {
  recoveryOperationalTrustRootRestoreGrantId,
  canonicalRecoveryOperationalTrustRootRestoreStatement,
} from './modules/authority/recovery-trust-root-contract.ts';
export type {
  RecoveryOperationalTrustRootRestoreGrantUnsignedPayload,
  RecoveryOperationalTrustRootRestoreGrantPayload,
  RecoveryOperationalTrustRootRestoreEnvelope,
  RecoveryOperationalTrustRootPointer,
  RecoveryOperationalTrustRootRestoreReservation,
  RecoveryOperationalTrustRootRestoreReceipt,
  RecoveryOperationalTrustRootRestoreTerminal,
  RecoveryOperationalTrustRootRestoreAuditRecord,
  RecoveryOperationalTrustRootRestoreAuditAcknowledgement,
  RecoveryOperationalTrustRootRestoreRecord,
  RecoveryOperationalTrustRootRestoreFaultPhase,
  RecoveryOperationalTrustRootRestoreDependencies,
  RecoveryOperationalTrustRootReadDependencies,
  RecoveryOperationalTrustRootRestoreResult,
} from './modules/authority/recovery-trust-root-contract.ts';
export { recoveryOperationalTrustRootDigest } from './modules/authority/recovery-operational-trust-root.ts';
export type {
  RecoveryOperationalTrustSigner,
  RecoveryOperationalTrustRootPayload,
  RecoveryOperationalTrustRoot,
} from './modules/authority/recovery-operational-trust-root.ts';
export {
  RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
  RECOVERY_TRUST_ROOT_RESTORE_TTL_MS,
  MAX_RECOVERY_TRUST_ROOT_BUNDLE_BYTES,
} from './modules/authority/recovery-trust-root-values.ts';

export function executeRecoveryOperationalTrustRootRestore(
  externalEnvelopePath: string,
  privateStoreRoot: string,
  boundary: RecoveryAuthorityImportBoundary,
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
): RecoveryOperationalTrustRootRestoreResult {
  assertDependencies(dependencies);
  assertBoundaries(externalEnvelopePath, privateStoreRoot, boundary);
  assertExternalAuditBoundary(dependencies.externalAuditRoot, boundary);
  const envelope = verifyEnvelope(
    readExternalEnvelope(externalEnvelopePath),
    dependencies,
  );
  const payload = envelope.payload;
  const envelopeDigest = canonicalDigest(envelope);
  const expectedReservation = createReservation(envelope, envelopeDigest);

  const observedPaths = operationPaths(
    privateStoreRoot,
    payload.grantId,
    false,
  );
  const hasAdmissionEvidence =
    observedPaths !== null &&
    hasExactPublicationEvidence(
      observedPaths.operationDirectory,
      'reservation.json',
      expectedReservation,
    );
  if (!hasAdmissionEvidence) {
    assertGrantWindow(payload, dependencies.now);
    assertPointerCas(
      readActiveTrustRootChain(
        privateStoreRoot,
        dependencies.authorityDescriptor,
        dependencies.authorityExpectations,
        dependencies.verifyHumanSignature,
        dependencies.externalAuditRoot,
        payload.grantId,
      ),
      payload,
    );
  }

  const paths = operationPaths(privateStoreRoot, payload.grantId, true);
  if (paths === null) throw stateCorrupt();
  ensureImmutable(
    paths.reservation,
    expectedReservation,
    dependencies,
    'reservation-published',
  );
  let record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    payload.grantId,
  );
  if (canonicalJson(record.reservation.envelope) !== canonicalJson(envelope)) {
    throw stateCorrupt();
  }
  if (record.auditAcknowledgement !== null) throw alreadyConsumed();

  const rootPath = path.join(
    paths.roots,
    `${payload.replacementRootDigest.slice('sha256:'.length)}.json`,
  );
  ensureImmutable(
    rootPath,
    envelope.replacement,
    dependencies,
    'root-published',
  );

  const pointer = createPointer(payload, envelopeDigest, record.reservation);
  const activeBefore = readActiveTrustRootChain(
    privateStoreRoot,
    dependencies.authorityDescriptor,
    dependencies.authorityExpectations,
    dependencies.verifyHumanSignature,
    dependencies.externalAuditRoot,
    payload.grantId,
  );
  if (activeBefore?.pointer.pointerDigest !== pointer.pointerDigest) {
    assertPointerCas(activeBefore, payload);
    const pointerPath = path.join(
      paths.pointers,
      pointerFileName(pointer.generation),
    );
    ensureImmutable(pointerPath, pointer, dependencies, 'pointer-published');
  }
  const active = readActiveTrustRootChain(
    privateStoreRoot,
    dependencies.authorityDescriptor,
    dependencies.authorityExpectations,
    dependencies.verifyHumanSignature,
    dependencies.externalAuditRoot,
    payload.grantId,
  );
  if (
    active === null ||
    active.pointer.pointerDigest !== pointer.pointerDigest ||
    active.root.rootDigest !== envelope.replacement.rootDigest
  ) {
    throw stateCorrupt();
  }

  record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    payload.grantId,
  );
  if (record.receipt === null) {
    ensureImmutable(
      paths.receipt,
      createReceipt(payload, pointer, record.reservation.reservedAt),
      dependencies,
      'receipt-published',
    );
  }
  record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    payload.grantId,
  );
  if (record.receipt === null) throw stateCorrupt();
  if (record.terminal === null) {
    ensureImmutable(
      paths.terminal,
      createTerminal(
        payload,
        envelopeDigest,
        record.receipt,
        record.reservation.reservedAt,
      ),
      dependencies,
      'terminal-published',
    );
  }

  record = finishAudit(privateStoreRoot, paths, payload, dependencies);
  if (record.receipt === null) throw stateCorrupt();
  return deepFreeze({
    pointer,
    root: envelope.replacement,
    receipt: record.receipt,
    record,
  });
}

export function readRecoveryOperationalTrustRootActive(
  privateStoreRoot: string,
  descriptorValue: RecoveryAuthorityDescriptorV1,
  expectations: RecoveryAuthorityExpectations,
  dependencies: RecoveryOperationalTrustRootReadDependencies,
): {
  pointer: RecoveryOperationalTrustRootPointer;
  root: RecoveryOperationalTrustRoot;
} | null {
  if (
    !isRecord(dependencies) ||
    !hasExactKeys(dependencies, [
      'boundary',
      'externalAuditRoot',
      'verifyHumanSignature',
    ]) ||
    !isExactAbsolutePath(dependencies.externalAuditRoot) ||
    typeof dependencies.verifyHumanSignature !== 'function'
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_VERIFIER_REQUIRED',
      'Active operational trust-root reads require the pinned Recovery Authority signature verifier.',
      ExitCode.unsafeEnvironment,
    );
  }
  assertPrivateStoreBoundary(privateStoreRoot, dependencies.boundary);
  assertPrivateDirectory(dependencies.externalAuditRoot, auditRootUnsafe);
  assertExternalAuditBoundary(
    dependencies.externalAuditRoot,
    dependencies.boundary,
  );
  return readActiveTrustRootChain(
    privateStoreRoot,
    descriptorValue,
    expectations,
    dependencies.verifyHumanSignature,
    dependencies.externalAuditRoot,
    null,
  );
}

function readActiveTrustRootChain(
  privateStoreRoot: string,
  descriptorValue: RecoveryAuthorityDescriptorV1,
  expectations: RecoveryAuthorityExpectations,
  verifyHumanSignature: PersistenceHumanSignatureVerifier,
  externalAuditRoot: string,
  allowedPendingGrantId: string | null,
): {
  pointer: RecoveryOperationalTrustRootPointer;
  root: RecoveryOperationalTrustRoot;
} | null {
  const descriptor = verifyRecoveryAuthorityDescriptor(
    descriptorValue,
    expectations,
  );
  const paths = statePaths(privateStoreRoot, false);
  if (paths === null) return null;
  assertStateClosure(paths);
  assertNoForeignPendingRestore(paths, privateStoreRoot, allowedPendingGrantId);
  assertNoForeignUnpublishedPreparation(
    paths,
    privateStoreRoot,
    allowedPendingGrantId,
  );
  const names = fs
    .readdirSync(paths.pointers)
    .filter((name) => POINTER_FILE.test(name))
    .sort();
  if (names.length === 0) return null;
  let previous: RecoveryOperationalTrustRootPointer | null = null;
  let activeRoot: RecoveryOperationalTrustRoot | null = null;
  for (const [index, name] of names.entries()) {
    const generation = index + 1;
    if (name !== pointerFileName(generation)) throw stateCorrupt();
    const pointer = normalizePointer(
      readPublished(path.join(paths.pointers, name)),
    );
    if (
      pointer.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
      pointer.authorityDescriptorDigest !== descriptor.descriptorDigest ||
      pointer.authorityGeneration !== descriptor.generation ||
      pointer.generation !== generation ||
      pointer.previousPointerDigest !==
        (previous === null ? null : previous.pointerDigest)
    ) {
      throw stateCorrupt();
    }
    const rootPath = path.join(
      paths.roots,
      `${pointer.rootDigest.slice('sha256:'.length)}.json`,
    );
    const root = normalizeRoot(readPublished(rootPath));
    if (
      root.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
      root.generation !== pointer.generation ||
      root.rootDigest !== pointer.rootDigest
    ) {
      throw stateCorrupt();
    }
    assertPersistedPointerAuthority(
      privateStoreRoot,
      descriptor,
      expectations,
      verifyHumanSignature,
      externalAuditRoot,
      pointer,
      root,
      allowedPendingGrantId,
    );
    previous = pointer;
    activeRoot = root;
  }
  if (previous === null || activeRoot === null) throw stateCorrupt();
  return deepFreeze({ pointer: previous, root: activeRoot });
}

function assertNoForeignUnpublishedPreparation(
  paths: StatePaths,
  privateStoreRoot: string,
  allowedPendingGrantId: string | null,
): void {
  const allowedTargets = new Set<string>();
  if (allowedPendingGrantId !== null) {
    const operation = operationPaths(
      privateStoreRoot,
      allowedPendingGrantId,
      false,
    );
    if (
      operation !== null &&
      fs.lstatSync(operation.reservation, { throwIfNoEntry: false }) !==
        undefined
    ) {
      const reservation = normalizeReservation(
        readPublished(operation.reservation),
      );
      const payload = reservation.envelope.payload;
      allowedTargets.add(
        `${payload.replacementRootDigest.slice('sha256:'.length)}.json`,
      );
      allowedTargets.add(pointerFileName(payload.replacementGeneration));
    }
  }
  for (const directory of [paths.roots, paths.pointers]) {
    for (const name of fs.readdirSync(directory).sort()) {
      const match = PREPARATION.exec(name);
      if (match === null) continue;
      const targetName = match[1]!;
      const target = path.join(directory, targetName);
      if (fs.lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
        continue;
      }
      const preparation = readPreparation(path.join(directory, name));
      if (preparation.stats.nlink !== 1 || !allowedTargets.has(targetName)) {
        throw transitionIncomplete();
      }
    }
  }
}

function assertNoForeignPendingRestore(
  paths: StatePaths,
  privateStoreRoot: string,
  allowedPendingGrantId: string | null,
): void {
  const allowedDirectory =
    allowedPendingGrantId === null ? null : digestHex(allowedPendingGrantId);
  for (const name of fs.readdirSync(paths.operations).sort()) {
    const directory = path.join(paths.operations, name);
    assertPrivateDirectory(directory, stateCorrupt);
    const reservationPath = path.join(directory, 'reservation.json');
    if (
      fs.lstatSync(reservationPath, { throwIfNoEntry: false }) === undefined
    ) {
      if (name !== allowedDirectory) throw transitionIncomplete();
      continue;
    }
    const reservation = normalizeReservation(readPublished(reservationPath));
    if (digestHex(reservation.grantId) !== name) throw stateCorrupt();
    const record = readRecoveryOperationalTrustRootRestoreRecord(
      privateStoreRoot,
      reservation.grantId,
    );
    if (
      record.auditAcknowledgement === null &&
      reservation.grantId !== allowedPendingGrantId
    ) {
      throw transitionIncomplete();
    }
  }
}

function assertPersistedPointerAuthority(
  privateStoreRoot: string,
  descriptor: RecoveryAuthorityDescriptorV1,
  expectations: RecoveryAuthorityExpectations,
  verifyHumanSignature: PersistenceHumanSignatureVerifier,
  externalAuditRoot: string,
  pointer: RecoveryOperationalTrustRootPointer,
  root: RecoveryOperationalTrustRoot,
  allowedPendingGrantId: string | null,
): void {
  const record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    pointer.grantId,
  );
  const envelope = record.reservation.envelope;
  const payload = envelope.payload;
  if (
    payload.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
    payload.authorityDescriptorDigest !== descriptor.descriptorDigest ||
    payload.authorityGeneration !== descriptor.generation ||
    payload.recoveryRuntimeDigest !== descriptor.sealedRuntime.closureDigest ||
    payload.externalAuditRoot !== externalAuditRoot ||
    payload.humanSigner !== descriptor.signer.identity ||
    payload.signerFingerprint !== descriptor.signer.fingerprint ||
    payload.replacementGeneration !== pointer.generation ||
    payload.replacementRootDigest !== pointer.rootDigest ||
    payload.expectedActivePointerDigest !== pointer.previousPointerDigest ||
    record.reservation.envelopeDigest !== pointer.envelopeDigest ||
    canonicalJson(envelope.replacement) !== canonicalJson(root) ||
    (record.receipt !== null &&
      record.receipt.newPointerDigest !== pointer.pointerDigest)
  ) {
    throw stateCorrupt();
  }
  assertRecoveryAuthorityDomain(
    descriptor,
    expectations,
    RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    payload.signerFingerprint,
  );
  let verified = false;
  try {
    verified = verifyHumanSignature(
      canonicalRecoveryOperationalTrustRootRestoreStatement(payload, root),
      envelope.signature,
      payload.humanSigner,
      RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_PERSISTED_SIGNATURE_INVALID',
      'Active operational trust-root lineage does not retain a valid Recovery Authority signature.',
      ExitCode.verification,
    );
  }
  if (
    record.auditAcknowledgement === null &&
    pointer.grantId !== allowedPendingGrantId
  ) {
    throw transitionIncomplete();
  }
}

export function readRecoveryOperationalTrustRootRestoreRecord(
  privateStoreRoot: string,
  grantIdValue: string,
): RecoveryOperationalTrustRootRestoreRecord {
  if (!GRANT_ID.test(grantIdValue)) throw grantInvalid();
  const paths = operationPaths(privateStoreRoot, grantIdValue, false);
  if (paths === null) throw stateCorrupt();
  assertOperationClosure(paths);
  const reservation = normalizeReservation(readPublished(paths.reservation));
  if (reservation.grantId !== grantIdValue) throw stateCorrupt();
  const receipt = readOptionalPublished(paths.receipt, normalizeReceipt);
  const terminal = readOptionalPublished(paths.terminal, normalizeTerminal);
  const audit = readOptionalPublished(paths.audit, normalizeAudit);
  const auditAcknowledgement = readOptionalPublished(
    paths.auditAcknowledgement,
    normalizeAuditAcknowledgement,
  );
  assertRecordChain(
    reservation,
    receipt,
    terminal,
    audit,
    auditAcknowledgement,
  );
  return deepFreeze({
    state:
      auditAcknowledgement !== null
        ? 'audited'
        : terminal !== null
          ? 'consumed'
          : receipt !== null
            ? 'receipt-durable'
            : 'reserved',
    reservation,
    receipt,
    terminal,
    audit,
    auditAcknowledgement,
  });
}

function verifyEnvelope(
  value: unknown,
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
): RecoveryOperationalTrustRootRestoreEnvelope {
  const envelope = normalizeEnvelope(value);
  const payload = envelope.payload;
  const replacement = envelope.replacement;
  const descriptor = dependencies.authorityDescriptor;
  if (
    payload.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
    payload.authorityDescriptorDigest !== descriptor.descriptorDigest ||
    payload.authorityGeneration !== descriptor.generation ||
    payload.recoveryRuntimeDigest !== descriptor.sealedRuntime.closureDigest ||
    payload.externalAuditRoot !== dependencies.externalAuditRoot ||
    payload.humanSigner !== descriptor.signer.identity ||
    payload.signerFingerprint !== descriptor.signer.fingerprint
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_AUTHORITY_BINDING_MISMATCH',
      'Trust-root restore does not bind the exact loaded Recovery Authority, runtime, and audit root.',
      ExitCode.verification,
    );
  }
  assertRecoveryAuthorityDomain(
    descriptor,
    dependencies.authorityExpectations,
    RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    payload.signerFingerprint,
  );
  let verified = false;
  try {
    verified = dependencies.verifyHumanSignature(
      canonicalRecoveryOperationalTrustRootRestoreStatement(
        payload,
        replacement,
      ),
      envelope.signature,
      payload.humanSigner,
      RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    );
  } catch {
    verified = false;
  }
  if (!verified) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_SIGNATURE_INVALID',
      'Trust-root restore signature is invalid for its independent Recovery Authority domain.',
      ExitCode.verification,
    );
  }
  return envelope;
}

function finishAudit(
  privateStoreRoot: string,
  paths: OperationPaths,
  payload: RecoveryOperationalTrustRootRestoreGrantPayload,
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
): RecoveryOperationalTrustRootRestoreRecord {
  let record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    payload.grantId,
  );
  if (record.receipt === null || record.terminal === null) throw stateCorrupt();
  if (record.auditAcknowledgement !== null) return record;
  const audit =
    record.audit ??
    createAuditRecord(
      payload,
      record.reservation.envelopeDigest,
      record.receipt,
      record.terminal,
      record.reservation.reservedAt,
    );
  if (record.audit === null) {
    ensureImmutable(paths.audit, audit, dependencies, 'audit-published');
  }
  dependencies.appendAudit(audit);
  dependencies.hooks?.afterPhase('audit-appended', null);
  ensureImmutable(
    paths.auditAcknowledgement,
    createAuditAcknowledgement(audit, record.reservation.reservedAt),
    dependencies,
    'audit-ack-published',
  );
  record = readRecoveryOperationalTrustRootRestoreRecord(
    privateStoreRoot,
    payload.grantId,
  );
  if (record.auditAcknowledgement === null) throw stateCorrupt();
  return record;
}

function assertDependencies(
  dependencies: RecoveryOperationalTrustRootRestoreDependencies,
): void {
  if (
    !isRecord(dependencies) ||
    !isExactAbsolutePath(dependencies.externalAuditRoot) ||
    !(dependencies.now instanceof Date) ||
    !Number.isFinite(dependencies.now.getTime()) ||
    typeof dependencies.verifyHumanSignature !== 'function' ||
    typeof dependencies.appendAudit !== 'function' ||
    (dependencies.hooks !== undefined &&
      (!isRecord(dependencies.hooks) ||
        !hasExactKeys(dependencies.hooks, ['afterPhase']) ||
        typeof dependencies.hooks.afterPhase !== 'function'))
  ) {
    throw restoreError(
      'RECOVERY_TRUST_ROOT_DEPENDENCIES_INVALID',
      'Trust-root restore requires exact out-of-band authority, time, signature, and audit dependencies.',
      ExitCode.unsafeEnvironment,
    );
  }
  assertPrivateDirectory(dependencies.externalAuditRoot, auditRootUnsafe);
}
