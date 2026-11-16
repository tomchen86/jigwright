import type { RoleContextSharingRolePairV1 } from '@jigwright/core/role-context-sharing-grant-codec';
/**
 * Declares role-context-sharing records, use evidence and the lock-held
 * lifecycle port.
 *
 * Invariants:
 * - Consumed-use evidence has the literal kind
 *   role-context-sharing-consumed-use.v1.
 * - Both reserve and consume methods require an assertOwned callback in
 *   their type contract.
 */
import type {
  GrantLifecycleAuditReceiptV1,
  GrantLifecycleState,
} from '@jigwright/core/grant-lifecycle-contracts';
import type {
  RoleContextSharingGrantEnvelopeV1,
  RoleContextSharingGrantExpectedBindingV1,
} from '@jigwright/core/role-context-sharing-grant-codec';

import type { RoleContextSharingEligibilityPortV1 } from './role-context-sharing-grant.ts';
import type { AuthoritativeRoleContextSharingGrantVerifier } from './role-context-sharing-grant-verifier-port.ts';
import type { MaintainerPolicy } from './maintainer-policy.ts';

export type RoleContextSharingLifecycleUseV1 = Readonly<{
  rolePairs: readonly (
    'author-builder' | 'author-reviewer' | 'builder-reviewer'
  )[];
  providerId: string;
  sessionId: string;
  sharedEngineSessionId: string;
  contextGeneration: number;
  sessionGeneration: number;
  providerDefinitionDigest: string;
  invocationId: string;
  requestDigest: string;
  assignmentDigest: string;
  admissionDigest: string;
}>;

export type RoleContextSharingLifecycleRecordV1 = Readonly<{
  grantId: string;
  state: GrantLifecycleState;
  envelope: RoleContextSharingGrantEnvelopeV1;
  expectedBinding: RoleContextSharingGrantExpectedBindingV1 | null;
  receipts: readonly GrantLifecycleAuditReceiptV1[];
  receiptDigests: readonly string[];
  reservation: Readonly<{
    reservedAt: string;
    reservationDigest: string;
  }> | null;
  use: RoleContextSharingLifecycleUseV1 | null;
  recordDigest: string;
}>;

export type ConsumedRoleContextSharingUseEvidenceV1 = Readonly<{
  kind: 'role-context-sharing-consumed-use.v1';
  grantId: string;
  envelope: RoleContextSharingGrantEnvelopeV1;
  expectedBinding: RoleContextSharingGrantExpectedBindingV1;
  reservationReceiptDigest: string;
  terminalReceiptDigest: string;
  terminalRecordDigest: string;
  use: RoleContextSharingLifecycleUseV1;
  useProjectionDigest: string;
}>;

export type RoleContextSharingLifecycleTransitionV1 = Readonly<{
  now?: Date;
  expected: RoleContextSharingGrantExpectedBindingV1;
  policy: MaintainerPolicy;
  verifier: AuthoritativeRoleContextSharingGrantVerifier;
  eligibility: RoleContextSharingEligibilityPortV1;
}>;

export type RoleContextSharingGrantLifecyclePortV1 = Readonly<{
  read(
    gitCommonDirectory: string,
    grantId: string,
  ): RoleContextSharingLifecycleRecordV1;
  reserveOrReadExactUnderLifecycleLock(
    gitCommonDirectory: string,
    grantId: string,
    options: RoleContextSharingLifecycleTransitionV1,
    assertOwned: () => void,
  ): RoleContextSharingLifecycleRecordV1;
  consumeOrReadExactUnderLifecycleLock(
    gitCommonDirectory: string,
    grantId: string,
    options: Readonly<{
      expected: RoleContextSharingGrantExpectedBindingV1;
      use: RoleContextSharingLifecycleUseV1;
    }> &
      Partial<Omit<RoleContextSharingLifecycleTransitionV1, 'expected'>>,
    assertOwned: () => void,
  ): RoleContextSharingLifecycleRecordV1;
}>;

export type VerifiedConsumedRoleContextSharingReplay = Readonly<{
  schemaVersion: 1;
  kind: 'verified-consumed-role-context-sharing-replay.v1';
  grantId: string;
  terminalRecordDigest: string;
  useProjectionDigest: string;
  admissionDigest: string;
}>;

export type RoleContextSharingUseV1 = Readonly<{
  rolePairs: readonly RoleContextSharingRolePairV1[];
  providerId: string;
  sessionId: string;
  sharedEngineSessionId: string;
  contextGeneration: number;
  sessionGeneration: number;
  providerDefinitionDigest: string;
  invocationId: string;
  requestDigest: string;
  assignmentDigest: string;
  admissionDigest: string;
}>;

export type RoleContextSharingJournalRecord = Readonly<{
  schemaVersion: 1;
  kind: 'role-context-sharing-journal.v1';
  grantId: string;
  state: GrantLifecycleState;
  envelope: RoleContextSharingGrantEnvelopeV1;
  expectedBinding: RoleContextSharingGrantExpectedBindingV1 | null;
  transitionDigest: string | null;
  receipts: readonly GrantLifecycleAuditReceiptV1[];
  receiptDigests: readonly string[];
  reservation: Readonly<{
    reservedAt: string;
    reservationDigest: string;
  }> | null;
  use: RoleContextSharingUseV1 | null;
  recordDigest: string;
}>;

export const ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_SIGNATURE_NAMESPACE_V1 =
  'workflow.role-context-sharing-terminal-receipt.v1' as const;

export const ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_TAG_PREFIX_V1 =
  'refs/tags/workflow-grant/role-context-sharing-use-' as const;

export type RoleContextSharingTerminalReceiptPayloadV1 = Readonly<{
  schemaVersion: 1;
  kind: 'role-context-sharing-terminal-receipt.v1';
  signatureNamespace: typeof ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_SIGNATURE_NAMESPACE_V1;
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  policyBlob: string;
  baselineCommit: string;
  grantEnvelopeDigest: string;
  expectedBindingDigest: string;
  transitionDigest: string;
  fromState: 'reserved';
  toState: 'consumed';
  terminalState: 'consumed';
  reservationReceiptDigest: string;
  terminalReceiptDigest: string;
  terminalRecordDigest: string;
  useProjectionDigest: string;
  admissionDigest: string;
  consumedAt: string;
  attestedAt: string;
  signer: string;
  terminalRecord: RoleContextSharingJournalRecord;
}>;

export type RoleContextSharingTerminalReceiptEnvelopeV1 = Readonly<{
  payload: RoleContextSharingTerminalReceiptPayloadV1;
  signature: string;
}>;

export type VerifiedRoleContextSharingTerminalReceiptV1 = Readonly<{
  tagRef: string;
  tagObject: string;
  target: string;
  envelope: RoleContextSharingTerminalReceiptEnvelopeV1;
  policy: MaintainerPolicy;
}>;

export type RoleContextSharingTerminalUseIdentityV1 = Readonly<{
  grantId: string;
  signedEnvelopeDigest: string;
  transitionDigest: string;
  useProjectionDigest: string;
  admissionDigest: string;
}>;
