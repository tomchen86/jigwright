/**
 * Exposes investigation storage APIs and authorizes durable human-resolution grant revocation.
 *
 * Invariants:
 * - Public entry points retain the same types, errors, and durable record identities.
 * - Revocation binds the exact grant and session before its audited terminal transition.
 *
 * Depends on: investigation records, resolution grant storage, and human revocation authorization.
 * Failure modes: callers lose compatibility or a grant is revoked against unrelated session authority.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type HumanRevocationOptions,
  authorizeHumanRevocation,
  canonicalHumanRevocationAuthorization,
  digestHumanRevocationSubject,
} from '../../application/control-plane/human-revocation.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { deriveAuthorityAuditRepositoryId } from './authority-audit-ledger.ts';
import { withHumanResolutionGrantStoreLock } from './human-resolution-grant-lock.ts';
import {
  type HumanResolutionGrantStoreEntry,
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
  humanResolutionGrantNotFound,
  humanResolutionGrantUnsafe,
  humanResolutionPaths,
} from './investigation-resolution-values.ts';
import { readInvestigationSession } from './investigation-session-records.ts';
import { isRecord } from './investigation-store-values.ts';

export {
  archiveHumanResolutionSingleton,
  quarantineUnsafeCurrentInvestigationRef,
  quarantineUnsafeHumanResolutionRef,
  quarantineUnsafeInvestigationStartReservation,
} from './human-resolution-archive.ts';
export {
  advertisedHumanResolutions,
  assertHumanResolutionConsequences,
  assertHumanResolutionDecision,
  createHumanResolutionNode,
  createInvestigationHumanActionBlocker,
  humanResolutionDecisionSchemaDigest,
  investigationCurrentRefDigest,
  investigationResolutionStateDigest,
} from './human-resolution-contract.ts';
export type {
  HumanResolutionAvailability,
  HumanResolutionConsequences,
  HumanResolutionDecision,
  HumanResolutionExpectedState,
  HumanResolutionNode,
  HumanResolutionTarget,
  InvestigationHumanActionBlocker,
  InvestigationResolutionState,
  InvestigationResolutionStateEnvelope,
} from './human-resolution-contract.ts';
export type {
  HumanResolutionGrantPublicationAuditTag,
  HumanResolutionGrantPublicationStateBinding,
  HumanResolutionGrantPublicationStoreInspection,
  HumanResolutionGrantPublicationStoreState,
  HumanResolutionGrantPublicationTemporary,
  QuarantinedHumanResolutionGrantPublication,
} from './human-resolution-grant-publication-contract.ts';
export {
  inspectInterruptedHumanResolutionGrantPublications,
  quarantineInterruptedHumanResolutionGrantPublication,
} from './human-resolution-grant-publication.ts';
export {
  inspectStoredHumanResolutionGrants,
  readAvailableHumanResolutionGrant,
  readReservedHumanResolutionGrant,
  readTerminalHumanResolutionGrant,
  reserveHumanResolutionGrant,
  rollbackAvailableHumanResolutionGrant,
  storeAvailableHumanResolutionGrant,
  terminalizeHumanResolutionGrant,
  withHumanResolutionGrantExecution,
} from './human-resolution-grant-store.ts';
export type { HumanResolutionGrantStoreEntry } from './human-resolution-grant-store.ts';
export { createHumanResolutionJournal } from './human-resolution-journal-contract.ts';
export type { HumanResolutionJournal } from './human-resolution-journal-contract.ts';
export {
  assertHumanResolutionLifecycleBarrier,
  readActiveHumanResolutionJournal,
  readHumanResolutionArchive,
  readHumanResolutionJournal,
  reclaimHumanResolutionJournalTemporaries,
  writeHumanResolutionArchive,
  writeHumanResolutionJournal,
  writeHumanResolutionReceipt,
} from './human-resolution-journal.ts';
export {
  compareAndSwapHumanResolutionHead,
  readHumanResolutionHead,
  readHumanResolutionNode,
  writeHumanResolutionNode,
} from './human-resolution-nodes.ts';
export {
  inspectInvestigationQuarantineState,
  inspectInvestigationResolutionState,
} from './human-resolution-state.ts';
export {
  assertInvestigationCheckpointEnvelope,
  assertInvestigationScanSaturationAcceptanceEnvelope,
  checkpointContributionDigest,
  checkpointEnvelopeDigest,
  scanSaturationAcceptanceEnvelopeDigest,
} from './investigation-checkpoint-contract.ts';
export {
  assertPrivateInvestigationDirectory,
  createPrivateCanonicalJson,
  ensurePrivateInvestigationDirectory,
  privatePathExists,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
  writePrivateCanonicalJsonAtomic,
} from './investigation-private-files.ts';
export {
  deriveInvestigationSessionState,
  investigationCheckpointId,
} from './investigation-session-contract.ts';
export {
  compareAndSwapCurrentInvestigationRef,
  compareAndSwapInvestigationSession,
  createCurrentInvestigationRef,
  createInvestigationId,
  createInvestigationSessionRecord,
  investigationSessionExists,
  readCurrentInvestigationRef,
  readInvestigationSession,
} from './investigation-session-records.ts';
export type {
  BlindResultReference,
  GroupDispositionsPayload,
  InvestigationCheckpointEnvelope,
  InvestigationCheckpointKind,
  InvestigationScanSaturationAcceptanceEnvelope,
  InvestigationSession,
  InvestigationSessionState,
  MainTermsPayload,
  StoredInvestigationCheckpoint,
  StoredInvestigationScanSaturationAcceptance,
  WhyAnswersPayload,
} from './investigation-session-types.ts';
export {
  listProviderInvocationLifecycleProjections,
  readProviderInvocationLifecycleProjection,
  scanProviderInvocationLifecycles,
} from './provider-invocation-lifecycle.ts';
export {
  assertProviderRuntimeDurableAuthorities,
  assertProviderRuntimeTerminalAuthorityPreflight,
  readAcceptedProviderInvocationRuntimeReceiptAuthority,
} from './provider-runtime-authority.ts';
export type { ProviderInvocationRuntimeGeneration } from './provider-runtime-authority.ts';
export type {
  ProviderInvocationLifecycleProjection,
  ProviderInvocationLifecycleScan,
} from './provider-runtime-evidence-contract.ts';

export function revokeStoredHumanResolutionGrant(
  paths: InvestigationRuntimePaths,
  cwd: string,
  requestedGrantId: string,
  options: HumanRevocationOptions,
): HumanResolutionGrantStoreEntry {
  const grantId = assertHumanResolutionGrantId(requestedGrantId);
  const current = inspectStoredHumanResolutionGrant(paths, grantId);
  if (current === null) throw humanResolutionGrantNotFound(grantId);
  if (current.state === 'consumed') {
    throw workflowError(
      'HUMAN_REVOCATION_STATE_INVALID',
      'Consumed human-resolution authority cannot be revoked.',
      ExitCode.guard,
    );
  }
  if (
    current.state === 'reserved' &&
    readHumanResolutionJournal(paths, grantId) !== null
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_RECOVERY_REQUIRED',
      'A prepared human-resolution transaction must be recovered instead of revoked.',
      ExitCode.conflict,
    );
  }
  const binding = humanResolutionRevocationBinding(
    paths,
    current.envelopeBytes,
    grantId,
  );
  const authorization = authorizeHumanRevocation(
    cwd,
    binding,
    options,
    humanResolutionRevocationAuthorizationPath(paths, grantId),
    current.revocationAuthorization ?? null,
  );
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

function humanResolutionRevocationBinding(
  paths: InvestigationRuntimePaths,
  envelopeBytes: string,
  grantId: string,
) {
  let envelope: unknown;
  try {
    envelope = JSON.parse(envelopeBytes);
  } catch {
    throw humanResolutionGrantUnsafe();
  }
  if (!isRecord(envelope) || !isRecord(envelope.payload)) {
    throw humanResolutionGrantUnsafe();
  }
  const payload = envelope.payload;
  if (
    payload.grantId !== grantId ||
    typeof payload.repositoryId !== 'string' ||
    typeof payload.repositoryOrigin !== 'string' ||
    !isRecord(payload.target) ||
    typeof payload.target.changeId !== 'string' ||
    typeof payload.target.workflowId !== 'string'
  ) {
    throw humanResolutionGrantUnsafe();
  }
  const session = readInvestigationSession(paths, payload.target.workflowId);
  if (
    session.changeId !== payload.target.changeId ||
    (session.mandateBinding !== undefined &&
      session.mandateBinding.changeId !== payload.target.changeId)
  ) {
    throw workflowError(
      'HUMAN_REVOCATION_BINDING_INVALID',
      'Human-resolution revocation session binding is unavailable or different.',
      ExitCode.guard,
    );
  }
  return {
    subjectKind: 'human-resolution-grant' as const,
    grantId,
    grantDigest: digestHumanRevocationSubject(envelopeBytes),
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    changeId: payload.target.changeId,
    taskId: session.mandateBinding?.mandateTaskId ?? null,
    workflowId: payload.target.workflowId,
    audit: session.mandateBinding
      ? {
          externalAuditRoot: session.mandateBinding.externalAuditRoot,
          repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
        }
      : null,
  };
}
