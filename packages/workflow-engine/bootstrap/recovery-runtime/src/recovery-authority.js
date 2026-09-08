/** Public recovery-authority APIs and authoritative operation ordering. */
export { MAX_RECOVERY_AUTHORITY_DESCRIPTOR_BYTES, RECOVERY_AUTHORITY_KNOWN_DOMAINS, recoveryAuthorityRepositoryIdentityDigest, recoveryAuthorityDescriptorDigest, parseRecoveryAuthorityDescriptor, verifyRecoveryAuthorityDescriptor, assertRecoveryAuthorityDomain, } from "./modules/authority/recovery-authority-contract.js";
export { importRecoveryAuthorityDescriptor, readRecoveryAuthorityDescriptor, } from "./modules/authority/recovery-authority-store.js";
