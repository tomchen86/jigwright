/**
 * Composes bootstrap recovery signers, signature verification and audit
 * dependencies.
 *
 * Invariants:
 * - Trust-root signature checks require the expected namespace, signer
 *   identity and fingerprint.
 */
import type {
  RecoveryAuthorityDescriptorV1,
  RecoveryAuthorityExpectations,
} from '../../modules/authority/recovery-authority-contract.ts';
import type {
  RecoveryQuarantineDependencies,
  RecoveryQuarantineEnvelope,
} from '../../modules/authority/recovery-quarantine-contract.ts';
import type { RecoveryOperationalTrustRootRestoreDependencies } from '../../modules/authority/recovery-trust-root-contract.ts';
import type { createHarnessBootstrapAudit } from './harness-bootstrap-audit.ts';
import type { HarnessBootstrapRuntimeOverrides } from './harness-bootstrap-contracts.ts';
export interface HarnessBootstrapRecoveryProductionBindings extends Pick<
  ReturnType<typeof createHarnessBootstrapAudit>,
  | 'productionRecoveryTrustRootAuditSink'
  | 'productionRecoveryQuarantineAuditSink'
> {
  RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE: typeof import('../../modules/authority/recovery-trust-root-values.ts').RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE;
  verifySshSignatureWithPublicKey(
    payload: string,
    signature: string,
    identity: string,
    publicKey: string,
    namespace: string,
  ): void;
}

export function createHarnessBootstrapRecoveryProduction(
  bindings: HarnessBootstrapRecoveryProductionBindings,
) {
  const {
    RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    verifySshSignatureWithPublicKey,
    productionRecoveryTrustRootAuditSink,
    productionRecoveryQuarantineAuditSink,
  } = bindings;

  function recoveryOperationalTrustRootDependencies(
    descriptor: RecoveryAuthorityDescriptorV1,
    expectations: RecoveryAuthorityExpectations,
    externalAuditRoot: string,
    repositoryRoot: string,
    overrides: HarnessBootstrapRuntimeOverrides,
  ): RecoveryOperationalTrustRootRestoreDependencies {
    return {
      authorityDescriptor: descriptor,
      authorityExpectations: expectations,
      externalAuditRoot,
      now: overrides.now?.() ?? new Date(),
      verifyHumanSignature(payload, signature, identity, namespace) {
        if (
          namespace !== RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE ||
          identity !== descriptor.signer.identity ||
          descriptor.signer.fingerprint !== expectations.signerFingerprint
        ) {
          return false;
        }
        try {
          verifySshSignatureWithPublicKey(
            payload,
            signature,
            identity,
            descriptor.signer.publicKey,
            namespace,
          );
          return true;
        } catch {
          return false;
        }
      },
      appendAudit:
        overrides.recoveryTrustRootAuditSink?.append ??
        productionRecoveryTrustRootAuditSink(repositoryRoot).append,
    };
  }

  function recoveryQuarantineDependencies(
    descriptor: RecoveryAuthorityDescriptorV1,
    expectations: RecoveryAuthorityExpectations,
    envelope: RecoveryQuarantineEnvelope,
    repositoryRoot: string,
    overrides: HarnessBootstrapRuntimeOverrides,
  ): RecoveryQuarantineDependencies {
    const externalAuditRoot = envelope.payload.externalAuditRoot;
    return {
      authorityDescriptor: descriptor,
      authorityExpectations: expectations,
      externalAuditRoot,
      now: overrides.now?.() ?? new Date(),
      verifyHumanSignature(payload, signature, identity, namespace) {
        if (
          identity !== descriptor.signer.identity ||
          descriptor.signer.fingerprint !== expectations.signerFingerprint
        ) {
          return false;
        }
        try {
          verifySshSignatureWithPublicKey(
            payload,
            signature,
            identity,
            descriptor.signer.publicKey,
            namespace,
          );
          return true;
        } catch {
          return false;
        }
      },
      appendAudit:
        overrides.recoveryQuarantineAuditSink?.append ??
        productionRecoveryQuarantineAuditSink(repositoryRoot).append,
    };
  }

  return {
    recoveryOperationalTrustRootDependencies,
    recoveryQuarantineDependencies,
  };
}
