import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
  verifySshSignatureWithPublicKey,
} from '../adapters/signing/ssh/maintainer-signer.ts';
import { createHarnessBootstrapAudit } from '../application/control-plane/harness-bootstrap-audit.ts';
import type { HarnessBootstrapRuntimeOverrides } from '../application/control-plane/harness-bootstrap-contracts.ts';
import { createHarnessBootstrapRecoveryProduction } from '../application/control-plane/harness-bootstrap-production.ts';
import {
  createHarnessBootstrapRecoveryCommands,
  type HarnessBootstrapRecoveryCommandBindings,
} from '../application/control-plane/harness-bootstrap-recovery-commands.ts';
import { type BootstrapInterventionCliDependencies } from '../modules/authority/intervention-bootstrap-contract.ts';
import { parseMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import { verifyRecoveryAuthorityDescriptor } from '../modules/authority/recovery-authority-contract.ts';
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
  const {
    recoveryOperationalTrustRootDependencies,
    recoveryQuarantineDependencies,
  } = createHarnessBootstrapRecoveryProduction({
    RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    verifySshSignatureWithPublicKey,
    productionRecoveryTrustRootAuditSink,
    productionRecoveryQuarantineAuditSink,
  });
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
      readRecoveryQuarantineMarker,
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
