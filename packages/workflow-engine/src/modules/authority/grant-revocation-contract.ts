/** Canonical collaboration revocation targets and required transaction capabilities. */
import type { HumanRevocationAuthorization } from './human-revocation-contract.ts';
import type { CollaborationGrantEnvelope } from './collaboration-grant-codec.ts';
import type { CollaborationGrantInspection } from './collaboration-grant-records.ts';

export type CollaborationRevocationTarget = {
  state: CollaborationGrantInspection['state'];
  envelope: CollaborationGrantEnvelope;
  transitionDigest: string | null;
  reason: string | null;
  authorization: HumanRevocationAuthorization | null;
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
