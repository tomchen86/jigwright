/**
 * Defines one-use Grant states, events, receipts and the storage and clock ports
 * consumed by the optional lifecycle implementation.
 */

export const GRANT_LIFECYCLE_CONTRACT_VERSION_V1 =
  'jigwright.grant-lifecycle.v1' as const;

export const GRANT_LIFECYCLE_AUDIT_RECEIPT_KIND_V1 =
  'jigwright.grant-lifecycle-audit-receipt.v1' as const;

export type GrantLifecycleState =
  'available' | 'reserved' | 'consumed' | 'failed' | 'expired' | 'revoked';

export type GrantLifecycleEventV1 =
  | Readonly<{
      kind: 'reserve';
      expiresAt: string;
      reason: string;
      expirationReason?: string;
    }>
  | Readonly<{ kind: 'consume' | 'fail' | 'revoke'; reason: string }>;

export type GrantLifecycleAuditReceiptV1 = Readonly<{
  schemaVersion: 1;
  kind: typeof GRANT_LIFECYCLE_AUDIT_RECEIPT_KIND_V1;
  lifecycleContractVersion: typeof GRANT_LIFECYCLE_CONTRACT_VERSION_V1;
  grantId: string;
  transitionDigest: string | null;
  fromState: 'available' | 'reserved';
  toState: 'reserved' | 'consumed' | 'failed' | 'expired' | 'revoked';
  occurredAt: string;
  reason: string;
}>;

export type GrantLifecycleClockPortV1 = Readonly<{
  now(): Date;
}>;

export type GrantLifecycleStoragePortV1<Validation, Persisted> = Readonly<{
  readState(): GrantLifecycleState | null;
  applyTransition(
    input: Readonly<{
      receipt: GrantLifecycleAuditReceiptV1;
      receiptDigest: string;
      validation: Validation | undefined;
    }>,
  ): Persisted;
}>;

export type GrantLifecycleTransitionRequestV1<Validation> = Readonly<{
  contractVersion: string;
  grantId: string;
  transitionDigest: string | null;
  maxUses: number;
  event: GrantLifecycleEventV1;
  validate?(): Validation;
  validationFailureReason?: string;
}>;

export type GrantLifecycleTransitionResultV1<Persisted> = Readonly<{
  value: Persisted;
  receipt: GrantLifecycleAuditReceiptV1;
  receiptDigest: string;
}>;

export type GrantUseClaimIdentityV1 = Readonly<{
  grantId: string;
  signedEnvelopeDigest: string;
  transitionDigest: string;
  useProjectionDigest?: string;
  admissionDigest?: string;
}>;

export type GrantLifecycleTransitionErrorCode =
  | 'GRANT_LIFECYCLE_INPUT_INVALID'
  | 'GRANT_LIFECYCLE_CONTRACT_UNSUPPORTED'
  | 'GRANT_LIFECYCLE_MAX_USES_UNSUPPORTED'
  | 'GRANT_LIFECYCLE_STATE_INVALID'
  | 'GRANT_LIFECYCLE_EXPIRED';

export type GrantUseUniquenessErrorCode =
  'GRANT_USE_IDENTITY_INVALID' | 'GRANT_USE_IDENTITY_DUPLICATE';
