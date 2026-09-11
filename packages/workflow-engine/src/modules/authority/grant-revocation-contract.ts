/** Canonical revocation targets and required transaction capabilities. */
import type { InvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import type { InvestigationSession } from '../investigation/domain/investigation-session-types.ts';
import { isRecord } from '../investigation/domain/investigation-store-values.ts';
import { humanResolutionGrantUnsafe } from '../investigation/domain/human-resolution-values.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import { deriveAuthorityAuditRepositoryId } from './authority-audit-contract.ts';
import {
  digestHumanRevocationSubject,
  type HumanRevocationAuthorization,
  type HumanRevocationOptions,
  type HumanRevocationBinding,
} from './human-revocation-contract.ts';
import type { CollaborationGrantEnvelope } from './collaboration-grant-codec.ts';
import type { CollaborationGrantInspection } from './collaboration-grant-records.ts';
export type CollaborationRevocationTarget = {
  state: CollaborationGrantInspection['state'];
  envelope: CollaborationGrantEnvelope;
  transitionDigest: string | null;
  reason: string | null;
  authorization: HumanRevocationAuthorization | null;
};
export type HumanResolutionGrantStoreEntry = {
  grantId: string;
  state: 'available' | 'reserved' | 'revoked' | 'consumed';
  envelopeBytes: string;
  terminalReason: string | null;
  recordedAt: string | null;
  revocationAuthorization?: HumanRevocationAuthorization;
};
export type CollaborationRevocationStore = Readonly<{
  assertOwned: () => void;
  readTarget: (grantId: string) => CollaborationRevocationTarget;
  assertTarget: (envelope: CollaborationGrantEnvelope, now: Date) => void;
  authorizationPath: (grantId: string) => string;
  publish: (
    target: CollaborationRevocationTarget,
    authorization: HumanRevocationAuthorization,
  ) => CollaborationGrantInspection;
}>;
export type WithCollaborationRevocationStore = <T>(
  gitCommonDirectory: string,
  repositoryRoot: string,
  operation: (store: CollaborationRevocationStore) => T,
) => T;
export type HumanResolutionRevocationStore = Readonly<{
  inspect: (grantId: string) => HumanResolutionGrantStoreEntry | null;
  hasPreparedJournal: (grantId: string) => boolean;
  binding: (envelopeBytes: string, grantId: string) => HumanRevocationBinding;
  authorizationPath: (grantId: string) => string;
  publish: (
    grantId: string,
    authorization: HumanRevocationAuthorization,
  ) => HumanResolutionGrantStoreEntry;
}>;
export type OpenHumanResolutionRevocationStore = (
  paths: InvestigationRuntimePaths,
) => HumanResolutionRevocationStore;
export type HumanResolutionGrantRevoker = (
  paths: InvestigationRuntimePaths,
  cwd: string,
  requestedGrantId: string,
  options: HumanRevocationOptions,
) => HumanResolutionGrantStoreEntry;
export function humanResolutionRevocationBinding(
  envelopeBytes: string,
  grantId: string,
  readSession: (
    investigationId: string,
  ) => Pick<InvestigationSession, 'changeId' | 'mandateBinding'>,
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
  const session = readSession(payload.target.workflowId);
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
