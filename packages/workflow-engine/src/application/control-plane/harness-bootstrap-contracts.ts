/**
 * Declares consumer-owned recovery inputs, command dependencies, status,
 * refusal authority and injectable runtime hooks.
 *
 * Invariants:
 * - Recovery status carries an authority descriptor and an explicit
 *   nullable quarantine marker.
 */
import type { BootstrapHumanSignatureVerifier } from '../../modules/authority/intervention-bootstrap-contract.ts';
import type { MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';
import type {
  RecoveryAuthorityDescriptorImporter,
  RecoveryAuthorityDescriptorReader,
  RecoveryAuthorityDescriptorV1,
  RecoveryAuthorityExpectations,
  RecoveryAuthorityImportBoundary,
  verifyRecoveryAuthorityDescriptor,
} from '../../modules/authority/recovery-authority-contract.ts';
import type {
  RecoveryQuarantineAuditRecord,
  RecoveryQuarantineDependencies,
  RecoveryQuarantineEnterResult,
  RecoveryQuarantineEnvelope,
  RecoveryQuarantineReleaseResult,
  RecoveryQuarantineMarker,
} from '../../modules/authority/recovery-quarantine-contract.ts';
import type {
  RecoveryOperationalTrustRootRestoreAuditRecord,
  RecoveryOperationalTrustRootRestoreDependencies,
  RecoveryOperationalTrustRootRestoreResult,
} from '../../modules/authority/recovery-trust-root-contract.ts';
import type { GitState } from '../../modules/repository-consumer/repository-git-state.ts';

export interface RecoveryAuthorityStatus {
  kind: 'recovery-authority-status.v1';
  descriptor: RecoveryAuthorityDescriptorV1;
  quarantine: RecoveryQuarantineMarker | null;
}

export interface HarnessRecoveryRefusalAuthority {
  repositoryRoot: string;
  marker: RecoveryQuarantineMarker;
}

export interface HarnessBootstrapRuntimeOverrides {
  now?: () => Date;
  maintenanceSigner?: MaintainerSignerProvider;
  verifyHumanSignature?: BootstrapHumanSignatureVerifier;
  recoveryQuarantineAuditSink?: {
    append(record: RecoveryQuarantineAuditRecord): void;
  };
  recoveryTrustRootAuditSink?: {
    append(record: RecoveryOperationalTrustRootRestoreAuditRecord): void;
  };
  /** Test-only interleaving seam before the final quarantine fence read. */
  beforeRecoveryTrustRootExecute?: () => void;
}

export interface HarnessBootstrapRecoveryInput {
  readExternalRecoveryExpectations(
    filePath: string,
    boundary: RecoveryAuthorityImportBoundary,
  ): RecoveryAuthorityExpectations;
  readExternalRecoveryInput(
    filePath: string,
    boundary: RecoveryAuthorityImportBoundary,
  ): unknown;
  readExternalRecoveryEnvelope(
    filePath: string,
    boundary: RecoveryAuthorityImportBoundary,
  ): RecoveryQuarantineEnvelope;
  readExternalRecoveryTrustRootAuditRoot(
    filePath: string,
    boundary: RecoveryAuthorityImportBoundary,
  ): string;
  ensureRecoveryAuthorityStateRoot(gitCommonDirectory: string): string;
  requireRecoveryAuthorityStateRoot(gitCommonDirectory: string): string;
  readOptionalRecoveryQuarantineMarker(
    gitCommonDirectory: string,
    readMarker: HarnessBootstrapRecoveryInput['readRecoveryQuarantineMarker'],
  ): RecoveryQuarantineMarker | null;
  hasRecoveryOperationalTrustRootFence(gitCommonDirectory: string): boolean;
  readRecoveryQuarantineMarker(
    storageRoot: string,
  ): RecoveryQuarantineMarker | null;
}

export interface HarnessBootstrapRecoveryCommandBindings {
  input: HarnessBootstrapRecoveryInput;
  discoverRepository(cwd: string): GitState;
  bootstrapInterventionUsage(): string;
  importRecoveryAuthorityDescriptor: RecoveryAuthorityDescriptorImporter;
  readRecoveryAuthorityDescriptor: RecoveryAuthorityDescriptorReader;
  verifyRecoveryAuthorityDescriptor: typeof verifyRecoveryAuthorityDescriptor;
  recoveryOperationalTrustRootDependencies(
    descriptor: RecoveryAuthorityDescriptorV1,
    expectations: RecoveryAuthorityExpectations,
    externalAuditRoot: string,
    repositoryRoot: string,
    overrides: HarnessBootstrapRuntimeOverrides,
  ): RecoveryOperationalTrustRootRestoreDependencies;
  recoveryQuarantineDependencies(
    descriptor: RecoveryAuthorityDescriptorV1,
    expectations: RecoveryAuthorityExpectations,
    envelope: RecoveryQuarantineEnvelope,
    repositoryRoot: string,
    overrides: HarnessBootstrapRuntimeOverrides,
  ): RecoveryQuarantineDependencies;
  executeRecoveryOperationalTrustRootRestore(
    externalEnvelopePath: string,
    privateStoreRoot: string,
    boundary: RecoveryAuthorityImportBoundary,
    dependencies: RecoveryOperationalTrustRootRestoreDependencies,
  ): RecoveryOperationalTrustRootRestoreResult;
  executeRecoveryQuarantineEnter(
    storageRoot: string,
    envelope: RecoveryQuarantineEnvelope,
    dependencies: RecoveryQuarantineDependencies,
  ): RecoveryQuarantineEnterResult;
  executeRecoveryQuarantineRelease(
    storageRoot: string,
    envelope: RecoveryQuarantineEnvelope,
    dependencies: RecoveryQuarantineDependencies,
  ): RecoveryQuarantineReleaseResult;
}
