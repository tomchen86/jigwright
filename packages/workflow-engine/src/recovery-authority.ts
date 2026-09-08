/** Public recovery-authority APIs and authoritative operation ordering. */
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
