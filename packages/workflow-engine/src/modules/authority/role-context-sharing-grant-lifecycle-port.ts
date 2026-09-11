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
  RoleContextSharingGrantEnvelopeV1,
  RoleContextSharingGrantExpectedBindingV1,
} from './optional-grants-package.ts';

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
