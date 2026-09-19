import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';

import { withHumanResolutionGrantStoreLock } from './human-resolution-grant-lock.ts';
import {
  type HumanResolutionGrantStoreEntry,
  humanResolutionRevocationBinding,
  type OpenHumanResolutionRevocationStore,
} from '../../modules/investigation/domain/human-resolution-grant-contract.ts';
import {
  inspectStoredHumanResolutionGrant,
  reconcileTerminalHumanResolutionGrantResidual,
} from './human-resolution-grant-store.ts';
import { readHumanResolutionJournal } from './human-resolution-journal.ts';
import {
  createPrivateCanonicalJson,
  fsyncDirectory,
  privatePathExists,
  readPrivateCanonicalJson,
} from './investigation-private-files.ts';
import {
  assertHumanResolutionGrantId,
  humanResolutionGrantUnsafe,
} from '../../modules/investigation/domain/human-resolution-values.ts';
import { humanResolutionGrantNotFound } from '../../modules/investigation/domain/human-resolution-values.ts';
import { humanResolutionPaths } from './investigation-resolution-values.ts';
import { readInvestigationSession } from './investigation-session-records.ts';

import {
  canonicalHumanRevocationAuthorization,
  type HumanRevocationAuthorization,
} from '../../modules/authority/human-revocation-contract.ts';

export const openHumanResolutionRevocationStore: OpenHumanResolutionRevocationStore =
  (paths) => ({
    inspect: (grantId) => inspectStoredHumanResolutionGrant(paths, grantId),
    hasPreparedJournal: (grantId) =>
      readHumanResolutionJournal(paths, grantId) !== null,
    binding: (envelopeBytes, grantId) =>
      humanResolutionRevocationBinding(
        envelopeBytes,
        grantId,
        (investigationId) => readInvestigationSession(paths, investigationId),
      ),
    authorizationPath: (grantId) =>
      humanResolutionRevocationAuthorizationPath(paths, grantId),
    publish: (grantId, authorization) =>
      terminallyRevokeHumanResolutionGrant(paths, grantId, authorization),
  });
function terminallyRevokeHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  grantId: string,
  authorization: HumanRevocationAuthorization,
): HumanResolutionGrantStoreEntry {
  const stores = humanResolutionPaths(paths);
  return withHumanResolutionGrantStoreLock(
    paths,
    stores,
    () => {
      const terminalPath = path.join(stores.terminal, `${grantId}.json`);
      if (privatePathExists(paths, terminalPath, humanResolutionGrantUnsafe)) {
        const terminal = readPrivateCanonicalJson(
          paths,
          terminalPath,
          humanResolutionGrantUnsafe,
        );
        reconcileTerminalHumanResolutionGrantResidual(
          paths,
          stores,
          grantId,
          terminal,
        );
        const existing = inspectStoredHumanResolutionGrant(
          paths,
          grantId,
        ) as HumanResolutionGrantStoreEntry;
        if (
          existing.state !== 'revoked' ||
          existing.terminalReason !== authorization.payload.reason ||
          existing.revocationAuthorization === undefined ||
          canonicalHumanRevocationAuthorization(
            existing.revocationAuthorization,
          ) !== canonicalHumanRevocationAuthorization(authorization)
        ) {
          throw workflowError(
            'HUMAN_REVOCATION_CONFLICT',
            'Human-resolution grant already has a different terminal record.',
            ExitCode.conflict,
          );
        }
        return existing;
      }
      const terminalEntry = inspectStoredHumanResolutionGrant(paths, grantId);
      if (terminalEntry === null) {
        throw humanResolutionGrantNotFound(grantId);
      }
      if (
        terminalEntry.state !== 'available' &&
        terminalEntry.state !== 'reserved'
      ) {
        throw workflowError(
          'HUMAN_REVOCATION_STATE_INVALID',
          'Only active human-resolution authority can be revoked.',
          ExitCode.guard,
        );
      }
      if (
        terminalEntry.state === 'reserved' &&
        readHumanResolutionJournal(paths, grantId) !== null
      ) {
        throw workflowError(
          'HUMAN_RESOLUTION_RECOVERY_REQUIRED',
          'A prepared human-resolution transaction must be recovered instead of revoked.',
          ExitCode.conflict,
        );
      }
      const sourceDirectory =
        terminalEntry.state === 'available'
          ? stores.available
          : stores.reserved;
      const sourcePath = path.join(sourceDirectory, `${grantId}.json`);
      const envelope = JSON.parse(terminalEntry.envelopeBytes) as unknown;
      const record = {
        schemaVersion: 1,
        state: 'revoked',
        grantId,
        reason: authorization.payload.reason,
        recordedAt: authorization.payload.revokedAt,
        envelope,
        revocationAuthorization: authorization,
      };
      createPrivateCanonicalJson(
        paths,
        terminalPath,
        record,
        humanResolutionGrantUnsafe,
        'HUMAN_RESOLUTION_GRANT_TERMINAL_CONFLICT',
      );
      fs.unlinkSync(sourcePath);
      fsyncDirectory(sourceDirectory);
      return inspectStoredHumanResolutionGrant(
        paths,
        grantId,
      ) as HumanResolutionGrantStoreEntry;
    },
    { targetGrantId: grantId },
  );
}
function humanResolutionRevocationAuthorizationPath(
  paths: InvestigationRuntimePaths,
  requestedGrantId: string,
): string {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  return path.join(
    humanResolutionPaths(paths).root,
    'grants',
    'revocation-authorizations',
    `${grantId}.json`,
  );
}
