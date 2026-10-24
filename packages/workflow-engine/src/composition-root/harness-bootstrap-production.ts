import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
  verifySshSignatureWithPublicKey,
} from '../adapters/signing/ssh/maintainer-signer.ts';
import { createHarnessBootstrapAudit } from '../application/control-plane/harness-bootstrap-audit.ts';
import type {
  HarnessBootstrapRecoveryCommandBindings,
  HarnessBootstrapRuntimeOverrides,
} from '../application/control-plane/harness-bootstrap-contracts.ts';
import { createHarnessBootstrapRecoveryCommands } from '../application/control-plane/harness-bootstrap-recovery-commands.ts';
import { type BootstrapInterventionCliDependencies } from '../modules/authority/intervention-bootstrap-contract.ts';
import { parseMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import {
  verifyRecoveryAuthorityDescriptor,
  type RecoveryAuthorityDescriptorV1,
  type RecoveryAuthorityExpectations,
} from '../modules/authority/recovery-authority-contract.ts';
import type {
  RecoveryQuarantineDependencies,
  RecoveryQuarantineEnvelope,
} from '../modules/authority/recovery-quarantine-contract.ts';
import type { RecoveryOperationalTrustRootRestoreDependencies } from '../modules/authority/recovery-trust-root-contract.ts';
import {
  ensureRecoveryAuthorityStateRoot,
  hasRecoveryOperationalTrustRootFence,
  readExternalRecoveryEnvelope,
  readExternalRecoveryExpectations,
  readExternalRecoveryInput,
  readExternalRecoveryTrustRootAuditRoot,
  readOptionalRecoveryQuarantineMarker,
  requireRecoveryAuthorityStateRoot,
} from '../runtime/recovery/harness-bootstrap-external-input.ts';
import { RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE } from '../modules/authority/recovery-trust-root-values.ts';
import {
  importRecoveryAuthorityDescriptor,
  readRecoveryAuthorityDescriptor,
} from '../runtime/recovery/recovery-authority-store.ts';
import {
  executeRecoveryQuarantineEnter,
  executeRecoveryQuarantineRelease,
  readRecoveryQuarantineMarker,
} from '../runtime/recovery/recovery-quarantine.ts';
import { executeRecoveryOperationalTrustRootRestore } from '../runtime/recovery/recovery-trust-root-restore.ts';
import { readFileAtRevision } from '../runtime/repository-transaction/git-command.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { deriveAuthorityAuditRepositoryId } from '../runtime/storage-journal/authority-audit-ledger.ts';
import { recordAuthorityAuditEvent } from '../runtime/storage-journal/authority-audit-service.ts';
import { recordAuthorityRefusal } from '../runtime/storage-journal/authority-refusal-audit.ts';

/** Assemble recovery capabilities around the independently trusted built-in engine identity. */

export function createHarnessBootstrapProduction() {
  function createHarnessBootstrapDependencies(
    cwd: string,
    overrides: HarnessBootstrapRuntimeOverrides = {},
  ): BootstrapInterventionCliDependencies {
    let resolvedSigner = overrides.maintenanceSigner;
    const resolveSigner = (): MaintainerSignerProvider => {
      if (resolvedSigner === undefined) {
        const repository = discoverRepository(cwd);
        const policy = parseMaintainerPolicy(
          JSON.parse(
            readFileAtRevision(
              repository.repositoryRoot,
              repository.head,
              'workflow/maintainer-policy.json',
            ),
          ),
        );
        resolvedSigner = createInteractiveSshSigner(
          repository.repositoryRoot,
          policy,
        );
      }
      return resolvedSigner;
    };
    return {
      now: overrides.now ?? (() => new Date()),
      maintenanceSigner: {
        assertHumanPresent: () => resolveSigner().assertHumanPresent(),
        identity: () => resolveSigner().identity(),
        sign: (payload, namespace) => resolveSigner().sign(payload, namespace),
        verify: (payload, signature, identity, namespace) =>
          resolveSigner().verify(payload, signature, identity, namespace),
      },
      verifyHumanSignature(
        payload: string,
        signature: string,
        signerIdentity: string,
        namespace: string,
      ): boolean {
        if (overrides.verifyHumanSignature) {
          return overrides.verifyHumanSignature(
            payload,
            signature,
            signerIdentity,
            namespace,
          );
        }
        try {
          resolveSigner().verify(payload, signature, signerIdentity, namespace);
          return true;
        } catch {
          return false;
        }
      },
    };
  }
  const {
    auditHarnessRecoveryRefusal,
    productionRecoveryTrustRootAuditSink,
    productionRecoveryQuarantineAuditSink,
  } = createHarnessBootstrapAudit({
    recordAuthorityRefusal,
    deriveAuthorityAuditRepositoryId,
    recordAuthorityAuditEvent,
  });
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

  function createHarnessBootstrapCommandDispatcher({
    bootstrapInterventionUsage,
  }: Pick<
    HarnessBootstrapRecoveryCommandBindings,
    'bootstrapInterventionUsage'
  >) {
    return createHarnessBootstrapRecoveryCommands({
      discoverRepository,
      bootstrapInterventionUsage,
      importRecoveryAuthorityDescriptor,
      readRecoveryAuthorityDescriptor,
      verifyRecoveryAuthorityDescriptor,
      executeRecoveryOperationalTrustRootRestore,
      executeRecoveryQuarantineEnter,
      executeRecoveryQuarantineRelease,
      input: {
        readExternalRecoveryExpectations,
        readExternalRecoveryInput,
        readExternalRecoveryEnvelope,
        readExternalRecoveryTrustRootAuditRoot,
        ensureRecoveryAuthorityStateRoot,
        requireRecoveryAuthorityStateRoot,
        readOptionalRecoveryQuarantineMarker,
        hasRecoveryOperationalTrustRootFence,
        readRecoveryQuarantineMarker,
      },
      recoveryOperationalTrustRootDependencies,
      recoveryQuarantineDependencies,
    });
  }
  return {
    createHarnessBootstrapDependencies,
    auditHarnessRecoveryRefusal,
    productionRecoveryTrustRootAuditSink,
    productionRecoveryQuarantineAuditSink,
    recoveryOperationalTrustRootDependencies,
    recoveryQuarantineDependencies,
    createHarnessBootstrapCommandDispatcher,
  };
}
export type HarnessBootstrapProduction = ReturnType<
  typeof createHarnessBootstrapProduction
>;
