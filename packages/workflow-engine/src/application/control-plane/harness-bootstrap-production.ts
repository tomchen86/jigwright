import type {
  RecoveryAuthorityDescriptorV1,
  RecoveryAuthorityExpectations,
} from '../../modules/authority/recovery-authority-contract.ts';
import type { HarnessBootstrapRuntimeOverrides } from './harness-bootstrap-contracts.ts';
import type { RecoveryOperationalTrustRootRestoreDependencies } from '../../modules/authority/recovery-trust-root-contract.ts';
import type {
  RecoveryQuarantineEnvelope,
  RecoveryQuarantineDependencies,
} from '../../modules/authority/recovery-quarantine-contract.ts';
import type { ControlPlaneRecoveryExecutorDependencies } from './intervention-control-updater.ts';
import type { MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { BootstrapDependencies } from './intervention-control-bootstrap.ts';
import type { createHarnessBootstrapAudit } from './harness-bootstrap-audit.ts';
export interface HarnessBootstrapRecoveryProductionBindings extends Pick<
  ReturnType<typeof createHarnessBootstrapAudit>,
  | 'productionRecoveryTrustRootAuditSink'
  | 'productionRecoveryQuarantineAuditSink'
  | 'productionControlPlaneAuditSink'
  | 'productionRecoveryAuditSink'
> {
  RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE: typeof import('../../modules/authority/recovery-trust-root-values.ts').RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE;
  verifySshSignatureWithPublicKey(
    payload: string,
    signature: string,
    identity: string,
    publicKey: string,
    namespace: string,
  ): void;
  createHarnessBootstrapDependencies(
    cwd: string,
    overrides: HarnessBootstrapRuntimeOverrides,
  ): BootstrapDependencies & { maintenanceSigner?: MaintainerSignerProvider };
}

export function createHarnessBootstrapRecoveryProduction(
  bindings: HarnessBootstrapRecoveryProductionBindings,
) {
  const {
    RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    verifySshSignatureWithPublicKey,
    createHarnessBootstrapDependencies,
    productionRecoveryTrustRootAuditSink,
    productionRecoveryQuarantineAuditSink,
    productionControlPlaneAuditSink,
    productionRecoveryAuditSink,
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

  function createHarnessRecoveryDependencies(
    cwd: string,
    repositoryRoot: string,
    overrides: HarnessBootstrapRuntimeOverrides,
  ): {
    dependencies: ControlPlaneRecoveryExecutorDependencies;
    signer: MaintainerSignerProvider;
  } {
    const bootstrapDependencies = createHarnessBootstrapDependencies(cwd, {
      ...overrides,
      maintenanceSigner:
        overrides.recoverySigner ?? overrides.maintenanceSigner,
    });
    const signer =
      overrides.recoverySigner ?? bootstrapDependencies.maintenanceSigner;
    if (signer === undefined) {
      throw workflowError(
        'HARNESS_RECOVERY_SIGNER_REQUIRED',
        'Sealed recovery requires a controlling-terminal human signer.',
        ExitCode.unsafeEnvironment,
      );
    }
    const verifyHumanSignature = bootstrapDependencies.verifyHumanSignature;
    if (verifyHumanSignature === undefined) {
      throw workflowError(
        'HARNESS_RECOVERY_VERIFIER_REQUIRED',
        'Sealed recovery requires the trusted root signature verifier.',
        ExitCode.unsafeEnvironment,
      );
    }
    return {
      signer,
      dependencies: {
        now: overrides.now ?? (() => new Date()),
        consumedGrantIds: new Set<string>(),
        verifyHumanSignature,
        auditSink:
          overrides.controlPlaneAuditSink ??
          productionControlPlaneAuditSink(repositoryRoot),
        recoveryAuditSink:
          overrides.recoveryAuditSink ??
          productionRecoveryAuditSink(repositoryRoot),
      },
    };
  }

  return {
    recoveryOperationalTrustRootDependencies,
    recoveryQuarantineDependencies,
    createHarnessRecoveryDependencies,
  };
}
