/**
 * Exports recovery authority descriptor validation and storage operations
 * through the bootstrap facade.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
 */
export {
  MAX_RECOVERY_AUTHORITY_DESCRIPTOR_BYTES,
  RECOVERY_AUTHORITY_KNOWN_DOMAINS,
  recoveryAuthorityRepositoryIdentityDigest,
  recoveryAuthorityDescriptorDigest,
  parseRecoveryAuthorityDescriptor,
  verifyRecoveryAuthorityDescriptor,
  assertRecoveryAuthorityDomain,
} from './modules/authority/recovery-authority-contract.ts';
export type {
  RecoveryAuthorityDomain,
  RecoveryAuthoritySha256Digest,
  RecoveryAuthorityRepositoryIdentityV1,
  RecoveryAuthoritySealedRuntimeBindingV1,
  RecoveryAuthorityAuditBindingV1,
  RecoveryAuthoritySignerV1,
  RecoveryAuthorityDescriptorPayloadV1,
  RecoveryAuthorityDescriptorV1,
  RecoveryAuthorityExpectations,
  RecoveryAuthorityImportBoundary,
  RecoveryAuthorityImportPhase,
  RecoveryAuthorityImportHooks,
} from './modules/authority/recovery-authority-contract.ts';
export {
  importRecoveryAuthorityDescriptor,
  readRecoveryAuthorityDescriptor,
} from './modules/authority/recovery-authority-store.ts';
