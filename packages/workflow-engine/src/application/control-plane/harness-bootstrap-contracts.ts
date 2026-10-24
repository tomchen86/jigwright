/**
 * Declares bootstrap recovery status, refusal authority and injectable
 * runtime hooks.
 *
 * Invariants:
 * - Recovery status carries an authority descriptor and an explicit
 *   nullable quarantine marker.
 */
import type { BootstrapHumanSignatureVerifier } from '../../modules/authority/intervention-bootstrap-contract.ts';
import type { MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';
import type { RecoveryAuthorityDescriptorV1 } from '../../modules/authority/recovery-authority-contract.ts';
import type {
  RecoveryQuarantineAuditRecord,
  RecoveryQuarantineMarker,
} from '../../modules/authority/recovery-quarantine-contract.ts';
import type { RecoveryOperationalTrustRootRestoreAuditRecord } from '../../modules/authority/recovery-trust-root-contract.ts';

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
