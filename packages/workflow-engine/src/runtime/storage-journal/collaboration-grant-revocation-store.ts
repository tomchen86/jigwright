import { runGit } from '../repository-transaction/git.ts';
import {
  type CollaborationGrantEnvelope,
  validateCollaborationGrantPayload,
} from '../../modules/authority/collaboration-grant-codec.ts';
import {
  canonicalCollaborationGrantEnvelope,
  parseCollaborationGrantEnvelope,
} from '../grants/grant-services.ts';
import { withRepositoryLifecycleOperation } from '../session-workspace/repository-lifecycle-lock.ts';

import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import path from 'node:path';
import type {
  CollaborationGrantInspection,
  CollaborationTerminalRecord,
} from '../../modules/authority/collaboration-grant-records.ts';
import {
  collaborationGrantStorePaths,
  ensureStoreDirectories,
  statePath,
  assertNonterminalUnambiguous,
  createPrivateFileAtomic,
} from './collaboration-grant-private-files.ts';
import {
  exactDate,
  grantNotFound,
  ambiguousGrant,
  serialize,
} from '../../modules/authority/collaboration-grant-values.ts';
import { loadPolicyAtCommit } from './collaboration-grant-reservation.ts';
import {
  type HumanRevocationAuthorization,
  assertHumanRevocationAuthorization,
} from '../../modules/authority/human-revocation-contract.ts';
import fs from 'node:fs';
import {
  readTerminal,
  readAvailable,
  readReservationOrInterrupted,
  inspectTerminal,
  cleanupNonterminal,
} from './collaboration-grant-records.ts';
import { executeGrantLifecycleTransitionV1 } from '../grants/optional-grants-package.ts';
import { GRANT_LIFECYCLE_CONTRACT_VERSION_V1 } from '@jigwright/core/grant-lifecycle-contracts';
import type {
  WithCollaborationRevocationStore,
  CollaborationRevocationTarget,
} from '../../modules/authority/grant-revocation-contract.ts';
import { canonicalHumanRevocationAuthorization } from '../../modules/authority/human-revocation-contract.ts';
export const withCollaborationRevocationStore: WithCollaborationRevocationStore =
  (gitCommonDirectory, repositoryRoot, operation) => {
    const paths = collaborationGrantStorePaths(gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) =>
      operation({
        assertOwned,
        readTarget: (grantId) =>
          readCollaborationRevocationTarget(paths, grantId, assertOwned),
        assertTarget: (envelope, now) =>
          assertIndependentHumanRevocationTarget(repositoryRoot, envelope, now),
        authorizationPath: (grantId) =>
          path.join(paths.revocationAuthorizations, `${grantId}.json`),
        publish: (target, authorization) =>
          terminallyRevokeCollaborationGrant(
            paths,
            target,
            authorization,
            assertOwned,
          ),
      }),
    );
  };
function assertIndependentHumanRevocationTarget(
  repositoryRoot: string,
  envelope: CollaborationGrantEnvelope,
  now: Date,
): void {
  const payload = envelope.payload;
  const baselineCommit = runGit(repositoryRoot, [
    'rev-parse',
    `${payload.baselineCommit}^{commit}`,
  ]).trim();
  const baselineTree = runGit(repositoryRoot, [
    'rev-parse',
    `${baselineCommit}^{tree}`,
  ]).trim();
  const policyBlob = runGit(repositoryRoot, [
    'rev-parse',
    `${baselineCommit}:workflow/maintainer-policy.json`,
  ]).trim();
  const origin = runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
  const policy = loadPolicyAtCommit(repositoryRoot, baselineCommit);
  if (
    baselineCommit !== payload.baselineCommit ||
    baselineTree !== payload.baselineTree ||
    policyBlob !== payload.policyBlob ||
    payload.repositoryId !== policy.repository.id ||
    payload.repositoryOrigin !== policy.repository.origin ||
    origin !== policy.repository.origin
  ) {
    throw workflowError(
      'HUMAN_REVOCATION_BINDING_INVALID',
      'Collaboration revocation target no longer matches its historical repository policy.',
      ExitCode.guard,
    );
  }
  validateCollaborationGrantPayload(payload, policy, {
    now,
    expectedPolicyBlob: policyBlob,
    allowExpired: true,
  });
  parseCollaborationGrantEnvelope(
    canonicalCollaborationGrantEnvelope(envelope),
  );
}
function readCollaborationRevocationTarget(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  grantId: string,
  assertOwned: () => void,
): CollaborationRevocationTarget {
  ensureStoreDirectories(paths);
  assertOwned();
  const terminalPath = statePath(paths.terminal, grantId);
  if (fs.existsSync(terminalPath)) {
    const terminal = readTerminal(terminalPath, grantId);
    return {
      state: terminal.state,
      envelope: terminal.envelope,
      transitionDigest: terminal.transitionDigest,
      reason: terminal.reason,
      authorization: terminal.revocationAuthorization ?? null,
    };
  }
  assertNonterminalUnambiguous(paths, grantId);
  const availablePath = statePath(paths.available, grantId);
  const reservedPath = statePath(paths.reserved, grantId);
  const available = fs.existsSync(availablePath)
    ? readAvailable(availablePath, grantId)
    : undefined;
  const reservation = fs.existsSync(reservedPath)
    ? readReservationOrInterrupted(reservedPath, grantId)
    : undefined;
  if (!available && !reservation) throw grantNotFound(grantId);
  const envelope = available ?? reservation?.envelope;
  if (
    !envelope ||
    (available &&
      reservation &&
      canonicalCollaborationGrantEnvelope(available) !==
        canonicalCollaborationGrantEnvelope(reservation.envelope))
  ) {
    throw ambiguousGrant(grantId);
  }
  return {
    state: reservation ? 'reserved' : 'available',
    envelope,
    transitionDigest: reservation?.transitionDigest ?? null,
    reason: null,
    authorization: null,
  };
}
function terminallyRevokeCollaborationGrant(
  paths: ReturnType<typeof collaborationGrantStorePaths>,
  target: ReturnType<typeof readCollaborationRevocationTarget>,
  rawAuthorization: HumanRevocationAuthorization,
  assertOwned: () => void,
): CollaborationGrantInspection {
  const authorization = assertHumanRevocationAuthorization(rawAuthorization);
  const grantId = target.envelope.payload.grantId;
  if (
    authorization.payload.subjectKind !== 'collaboration-grant' ||
    authorization.payload.grantId !== grantId
  ) {
    throw workflowError(
      'HUMAN_REVOCATION_CONFLICT',
      'Collaboration revocation authorization is bound elsewhere.',
      ExitCode.conflict,
    );
  }
  if (target.state === 'revoked') {
    if (
      target.reason !== authorization.payload.reason ||
      target.authorization === null ||
      canonicalHumanRevocationAuthorization(target.authorization) !==
        canonicalHumanRevocationAuthorization(authorization)
    ) {
      throw workflowError(
        'HUMAN_REVOCATION_CONFLICT',
        'Collaboration grant already has a different revocation tombstone.',
        ExitCode.conflict,
      );
    }
    return inspectTerminal(
      readTerminal(statePath(paths.terminal, grantId), grantId),
    );
  }
  if (target.state !== 'available' && target.state !== 'reserved') {
    throw workflowError(
      'HUMAN_REVOCATION_STATE_INVALID',
      'Only active collaboration authority can be revoked.',
      ExitCode.guard,
    );
  }
  const transition = executeGrantLifecycleTransitionV1(
    {
      contractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
      grantId,
      transitionDigest: target.transitionDigest,
      maxUses: target.envelope.payload.maxUses,
      event: { kind: 'revoke', reason: authorization.payload.reason },
    },
    {
      clock: {
        now: () => exactDate(new Date(authorization.payload.revokedAt)),
      },
      storage: {
        readState: () => target.state,
        applyTransition(input) {
          if (input.receipt.toState !== 'revoked') {
            throw workflowError(
              'HUMAN_REVOCATION_STATE_INVALID',
              'Only active collaboration authority can be revoked.',
              ExitCode.guard,
            );
          }
          const terminal: CollaborationTerminalRecord = {
            schemaVersion: 1,
            state: 'revoked',
            grantId,
            transitionDigest: target.transitionDigest,
            reason: input.receipt.reason,
            recordedAt: input.receipt.occurredAt,
            envelope: target.envelope,
            use: null,
            revocationAuthorization: authorization,
          };
          assertOwned();
          createPrivateFileAtomic(
            statePath(paths.terminal, grantId),
            serialize(terminal),
          );
          cleanupNonterminal(
            paths,
            grantId,
            target.envelope,
            target.transitionDigest,
          );
          assertOwned();
          return terminal;
        },
      },
    },
  );
  return inspectTerminal(transition.value);
}
