import type { HumanResolutionGrantStoreEntry } from '../../modules/investigation/domain/human-resolution-grant-contract.ts';
/**
 * Publishes, reserves, reads, and terminalizes human-resolution grants.
 *
 * Invariants:
 * - Available, reserved, and terminal records remain mutually consistent under the grant-store lock.
 * - Canonical envelopes and terminal residual reconciliation retain exact replay checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type HumanRevocationAuthorization,
  assertHumanRevocationAuthorization,
} from '../../modules/authority/human-revocation-contract.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  assertNoPreparedHumanResolutionGrantPublicationRecovery,
  listHumanResolutionGrantIds,
  readHumanResolutionGrantPublicationRecovery,
  withHumanResolutionGrantStoreLock,
} from './human-resolution-grant-lock.ts';
import {
  createPrivateCanonicalJson,
  createPrivateRawFile,
  ensurePrivateInvestigationDirectory,
  fsyncDirectory,
  privatePathExists,
  readPrivateCanonicalJson,
  readPrivateFile,
  withPrivateRuntimeLock,
} from './investigation-private-files.ts';
import {
  assertCanonicalResolutionEnvelopeBytes,
  humanResolutionGrantUnavailable,
  humanResolutionPaths,
} from './investigation-resolution-values.ts';
import { humanResolutionGrantNotFound } from '../../modules/investigation/domain/human-resolution-values.ts';
import {
  assertHumanResolutionGrantId,
  humanResolutionGrantUnsafe,
  isBoundedResolutionText,
} from '../../modules/investigation/domain/human-resolution-values.ts';
import {
  deepFreeze,
  hasExactKeys,
  isDigest,
  isRecord,
  isTimestamp,
} from '../../modules/investigation/domain/investigation-store-values.ts';

export function storeAvailableHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  canonicalEnvelope: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  assertCanonicalResolutionEnvelopeBytes(canonicalEnvelope);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      if (
        readHumanResolutionGrantPublicationRecovery(paths, stores, grantId) !==
        null
      ) {
        throw workflowError(
          'HUMAN_RESOLUTION_GRANT_EXISTS',
          `Human resolution grant ${grantId} already has publication recovery history.`,
          ExitCode.conflict,
        );
      }
      for (const directory of [
        stores.available,
        stores.reserved,
        stores.terminal,
      ]) {
        const candidate = path.join(directory, `${grantId}.json`);
        if (privatePathExists(paths, candidate, humanResolutionGrantUnsafe)) {
          throw workflowError(
            'HUMAN_RESOLUTION_GRANT_EXISTS',
            `Human resolution grant ${grantId} already has durable state.`,
            ExitCode.conflict,
          );
        }
      }
      const target = path.join(stores.available, `${grantId}.json`);
      createPrivateRawFile(
        paths,
        target,
        canonicalEnvelope,
        humanResolutionGrantUnsafe,
      );
      return target;
    },
    {
      allowPreparedPublicationRecovery: true,
      targetGrantId: grantId,
    },
  );
}

export function rollbackAvailableHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  canonicalEnvelope: string,
): 'absent' | 'different' | 'removed' {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  assertCanonicalResolutionEnvelopeBytes(canonicalEnvelope);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const target = path.join(stores.available, `${grantId}.json`);
      if (!privatePathExists(paths, target, humanResolutionGrantUnsafe)) {
        return 'absent';
      }
      if (
        readPrivateFile(target, humanResolutionGrantUnsafe) !==
        canonicalEnvelope
      ) {
        return 'different';
      }
      fs.unlinkSync(target);
      fsyncDirectory(stores.available);
      return 'removed';
    },
    { targetGrantId: grantId },
  );
}

export function withHumanResolutionGrantExecution<T>(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  operation: () => T,
  options: { allowPublicationRecovery?: boolean } = {},
): T {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  return withPrivateRuntimeLock(
    paths,
    path.join(humanResolutionPaths(paths).locks, `${grantId}.execution.lock`),
    () => {
      if (!options.allowPublicationRecovery) {
        assertNoPreparedHumanResolutionGrantPublicationRecovery(paths, grantId);
      }
      return operation();
    },
    'HUMAN_RESOLUTION_OPERATION_CONFLICT',
    humanResolutionGrantUnsafe,
  );
}

export function inspectStoredHumanResolutionGrants(
  paths: InvestigationRuntimePaths,
  requestedGrantId?: string,
): HumanResolutionGrantStoreEntry[] {
  const grantId =
    requestedGrantId === undefined
      ? undefined
      : assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  const ids = grantId
    ? [grantId]
    : [
        ...new Set(
          [stores.available, stores.reserved, stores.terminal].flatMap(
            (directory) => listHumanResolutionGrantIds(paths, directory),
          ),
        ),
      ].sort();
  const entries = ids
    .map((id) => inspectStoredHumanResolutionGrant(paths, id))
    .filter((entry): entry is HumanResolutionGrantStoreEntry => entry !== null);
  if (grantId !== undefined && entries.length === 0) {
    throw humanResolutionGrantNotFound(grantId);
  }
  return entries;
}

export function reserveHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const available = path.join(stores.available, `${grantId}.json`);
      const reserved = path.join(stores.reserved, `${grantId}.json`);
      const terminal = path.join(stores.terminal, `${grantId}.json`);
      if (
        privatePathExists(paths, reserved, humanResolutionGrantUnsafe) ||
        privatePathExists(paths, terminal, humanResolutionGrantUnsafe)
      ) {
        throw humanResolutionGrantUnavailable(grantId);
      }
      if (!privatePathExists(paths, available, humanResolutionGrantUnsafe)) {
        throw humanResolutionGrantUnavailable(grantId);
      }
      const envelope = readPrivateFile(available, humanResolutionGrantUnsafe);
      assertCanonicalResolutionEnvelopeBytes(envelope);
      ensurePrivateInvestigationDirectory(
        paths,
        path.dirname(reserved),
        humanResolutionGrantUnsafe,
      );
      fs.renameSync(available, reserved);
      fsyncDirectory(path.dirname(available));
      fsyncDirectory(path.dirname(reserved));
      return envelope;
    },
    { targetGrantId: grantId },
  );
}

export function readAvailableHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const available = path.join(stores.available, `${grantId}.json`);
      const reserved = path.join(stores.reserved, `${grantId}.json`);
      const terminal = path.join(stores.terminal, `${grantId}.json`);
      if (
        privatePathExists(paths, reserved, humanResolutionGrantUnsafe) ||
        privatePathExists(paths, terminal, humanResolutionGrantUnsafe) ||
        !privatePathExists(paths, available, humanResolutionGrantUnsafe)
      ) {
        throw humanResolutionGrantUnavailable(grantId);
      }
      const envelope = readPrivateFile(available, humanResolutionGrantUnsafe);
      assertCanonicalResolutionEnvelopeBytes(envelope);
      return envelope;
    },
    { targetGrantId: grantId },
  );
}

export function readReservedHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const filePath = path.join(stores.reserved, `${grantId}.json`);
      const envelope = readPrivateFile(filePath, humanResolutionGrantUnsafe);
      assertCanonicalResolutionEnvelopeBytes(envelope);
      return envelope;
    },
    { targetGrantId: grantId },
  );
}

export function terminalizeHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
  record: Record<string, unknown>,
): void {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const reserved = path.join(stores.reserved, `${grantId}.json`);
      const terminal = path.join(stores.terminal, `${grantId}.json`);
      if (privatePathExists(paths, terminal, humanResolutionGrantUnsafe)) {
        const existing = readPrivateCanonicalJson(
          paths,
          terminal,
          humanResolutionGrantUnsafe,
        );
        if (canonicalJson(existing) !== canonicalJson(record)) {
          throw humanResolutionGrantUnavailable(grantId);
        }
        reconcileTerminalHumanResolutionGrantResidual(
          paths,
          stores,
          grantId,
          existing,
        );
        return;
      }
      if (!privatePathExists(paths, reserved, humanResolutionGrantUnsafe)) {
        throw humanResolutionGrantUnavailable(grantId);
      }
      createPrivateCanonicalJson(
        paths,
        terminal,
        record,
        humanResolutionGrantUnsafe,
        'HUMAN_RESOLUTION_GRANT_TERMINAL_CONFLICT',
      );
      fs.unlinkSync(reserved);
      fsyncDirectory(path.dirname(reserved));
    },
    { targetGrantId: grantId },
  );
}

export function reconcileTerminalHumanResolutionGrantResidual(
  paths: InvestigationRuntimePaths,
  stores: ReturnType<typeof humanResolutionPaths>,
  grantId: string,
  terminal: unknown,
): void {
  assertTerminalHumanResolutionGrant(terminal, grantId);
  const residuals = [stores.available, stores.reserved]
    .map((directory) => ({
      directory,
      state:
        directory === stores.available
          ? ('available' as const)
          : ('reserved' as const),
      filePath: path.join(directory, `${grantId}.json`),
    }))
    .filter(({ filePath }) =>
      privatePathExists(paths, filePath, humanResolutionGrantUnsafe),
    );
  if (residuals.length > 1) {
    throw humanResolutionGrantUnsafe();
  }
  const residual = residuals[0];
  if (!residual) {
    return;
  }
  assertTerminalHumanResolutionGrantResidual(
    paths,
    grantId,
    terminal,
    residual.state,
    residual.filePath,
  );
  fs.unlinkSync(residual.filePath);
  fsyncDirectory(residual.directory);
}

export function readTerminalHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): Record<string, unknown> | null {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const terminal = path.join(stores.terminal, `${grantId}.json`);
      if (!privatePathExists(paths, terminal, humanResolutionGrantUnsafe)) {
        return null;
      }
      const value = readPrivateCanonicalJson(
        paths,
        terminal,
        humanResolutionGrantUnsafe,
      );
      if (!isRecord(value)) {
        throw humanResolutionGrantUnsafe();
      }
      assertTerminalHumanResolutionGrant(value, grantId);
      return deepFreeze(value);
    },
    { targetGrantId: grantId },
  );
}

export function inspectStoredHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  grantId: string,
): HumanResolutionGrantStoreEntry | null {
  const stores = humanResolutionPaths(paths);
  const candidates = [
    { state: 'available' as const, directory: stores.available },
    { state: 'reserved' as const, directory: stores.reserved },
    { state: 'terminal' as const, directory: stores.terminal },
  ].filter(({ directory }) =>
    privatePathExists(
      paths,
      path.join(directory, `${grantId}.json`),
      humanResolutionGrantUnsafe,
    ),
  );
  if (candidates.length === 0) {
    return null;
  }
  const terminalCandidate = candidates.find(
    ({ state }) => state === 'terminal',
  );
  if (terminalCandidate) {
    const terminal = readPrivateCanonicalJson(
      paths,
      path.join(terminalCandidate.directory, `${grantId}.json`),
      humanResolutionGrantUnsafe,
    );
    const terminalEntry = assertTerminalHumanResolutionGrant(terminal, grantId);
    const residuals = candidates.filter(({ state }) => state !== 'terminal');
    if (residuals.length > 1) {
      throw humanResolutionGrantUnsafe();
    }
    const residual = residuals[0];
    if (residual) {
      if (residual.state === 'terminal') {
        throw humanResolutionGrantUnsafe();
      }
      assertTerminalHumanResolutionGrantResidual(
        paths,
        grantId,
        terminal,
        residual.state,
        path.join(residual.directory, `${grantId}.json`),
      );
    }
    return terminalEntry;
  }
  if (candidates.length !== 1) {
    throw humanResolutionGrantUnsafe();
  }
  const candidate = candidates[0];
  if (!candidate || candidate.state === 'terminal') {
    throw humanResolutionGrantUnsafe();
  }
  const filePath = path.join(candidate.directory, `${grantId}.json`);
  {
    const envelopeBytes = readPrivateFile(filePath, humanResolutionGrantUnsafe);
    assertCanonicalResolutionEnvelopeBytes(envelopeBytes);
    return deepFreeze({
      grantId,
      state: candidate.state,
      envelopeBytes,
      terminalReason: null,
      recordedAt: null,
    });
  }
}

function assertTerminalHumanResolutionGrant(
  terminal: unknown,
  grantId: string,
): HumanResolutionGrantStoreEntry {
  const hasRevocationAuthorization =
    isRecord(terminal) &&
    Object.prototype.hasOwnProperty.call(terminal, 'revocationAuthorization');
  const terminalState =
    isRecord(terminal) &&
    (terminal.state === 'revoked' || terminal.state === 'consumed')
      ? terminal.state
      : null;
  const expectedKeys =
    terminalState === 'revoked'
      ? [
          'schemaVersion',
          'state',
          'grantId',
          'reason',
          'recordedAt',
          'envelope',
          ...(hasRevocationAuthorization ? ['revocationAuthorization'] : []),
        ]
      : [
          'schemaVersion',
          'state',
          'grantId',
          'resolutionNodeId',
          'receiptDigest',
          'recordedAt',
          'envelope',
        ];
  if (
    !isRecord(terminal) ||
    !hasExactKeys(terminal, expectedKeys) ||
    terminal.schemaVersion !== 1 ||
    terminalState === null ||
    terminal.grantId !== grantId ||
    !isTimestamp(terminal.recordedAt) ||
    !isRecord(terminal.envelope) ||
    (terminalState === 'revoked' &&
      !isBoundedResolutionText(terminal.reason, 1024)) ||
    (terminalState === 'consumed' &&
      (!isDigest(terminal.resolutionNodeId) ||
        !isDigest(terminal.receiptDigest)))
  ) {
    throw humanResolutionGrantUnsafe();
  }
  const envelopeBytes = `${canonicalJson(terminal.envelope)}\n`;
  assertCanonicalResolutionEnvelopeBytes(envelopeBytes);
  let revocationAuthorization: HumanRevocationAuthorization | null = null;
  if (terminalState === 'revoked' && hasRevocationAuthorization) {
    revocationAuthorization = assertHumanRevocationAuthorization(
      terminal.revocationAuthorization,
    );
    if (
      revocationAuthorization.payload.subjectKind !==
        'human-resolution-grant' ||
      revocationAuthorization.payload.grantId !== grantId ||
      revocationAuthorization.payload.reason !== terminal.reason ||
      revocationAuthorization.payload.revokedAt !== terminal.recordedAt
    ) {
      throw humanResolutionGrantUnsafe();
    }
  }
  return deepFreeze({
    grantId,
    state: terminalState,
    envelopeBytes,
    terminalReason:
      terminalState === 'revoked' ? String(terminal.reason) : null,
    recordedAt: terminal.recordedAt as string,
    ...(revocationAuthorization ? { revocationAuthorization } : {}),
  });
}

function assertTerminalHumanResolutionGrantResidual(
  paths: InvestigationRuntimePaths,
  grantId: string,
  terminal: unknown,
  residualState: 'available' | 'reserved',
  residualPath: string,
): void {
  const terminalEntry = assertTerminalHumanResolutionGrant(terminal, grantId);
  if (terminalEntry.state === 'consumed' && residualState !== 'reserved') {
    throw humanResolutionGrantUnsafe();
  }
  if (
    readPrivateFile(residualPath, humanResolutionGrantUnsafe) !==
    terminalEntry.envelopeBytes
  ) {
    throw humanResolutionGrantUnsafe();
  }
}
