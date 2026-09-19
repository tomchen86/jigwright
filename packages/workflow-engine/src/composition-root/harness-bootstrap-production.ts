import { recordAuthorityRefusal } from '../runtime/storage-journal/authority-refusal-audit.ts';
import { controlPlaneRecoveryGrantPersistence } from '../runtime/storage-journal/control-plane-recovery-grant.ts';
import { createHarnessBootstrapAudit } from '../application/control-plane/harness-bootstrap-audit.ts';
import { createHarnessBootstrapRecoveryProduction } from '../application/control-plane/harness-bootstrap-production.ts';
import {
  createHarnessBootstrapRecoveryCommands,
  type HarnessBootstrapRecoveryCommandBindings,
} from '../application/control-plane/harness-bootstrap-recovery-commands.ts';
import type { HarnessBootstrapRuntimeOverrides } from '../application/control-plane/harness-bootstrap-contracts.ts';
import { deriveAuthorityAuditRepositoryId } from '../runtime/storage-journal/authority-audit-ledger.ts';
import { recordAuthorityAuditEvent } from '../runtime/storage-journal/authority-audit-service.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { type BootstrapInterventionCliDependencies } from '../modules/authority/intervention-bootstrap-contract.ts';
import { parseMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
  verifySshSignatureWithPublicKey,
} from '../adapters/signing/ssh/maintainer-signer.ts';
import {
  importRecoveryAuthorityDescriptor,
  readRecoveryAuthorityDescriptor,
} from '../runtime/recovery/recovery-authority-store.ts';
import { verifyRecoveryAuthorityDescriptor } from '../modules/authority/recovery-authority-contract.ts';
import {
  executeRecoveryQuarantineEnter,
  executeRecoveryQuarantineRelease,
  readRecoveryQuarantineMarker,
} from '../runtime/recovery/recovery-quarantine.ts';
import { RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE } from '../modules/authority/recovery-trust-root-values.ts';
import { executeRecoveryOperationalTrustRootRestore } from '../runtime/recovery/recovery-trust-root-restore.ts';
import { createHarnessBootstrapParentState } from '../application/control-plane/harness-bootstrap-parent-state.ts';
import {
  observeParentSessions,
  observeParentBindingPath,
} from '../runtime/repository-observation/harness-bootstrap-parent-state.ts';
import {
  readLocalEngineBinding,
  persistTrustedBootstrapSessionSnapshot,
} from '../application/control-plane/intervention-control-bootstrap.ts';
import { readControlPlaneSupervisorState } from '../application/control-plane/intervention-control-updater.ts';
import type { HarnessBootstrapParentBindings } from '../application/control-plane/harness-bootstrap-parent-state.ts';
import { readFileAtRevision } from '../runtime/repository-transaction/git-command.ts';

/** Assemble recovery capabilities around the independently trusted built-in engine identity. */

export function createHarnessBootstrapProduction(
  BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST: HarnessBootstrapParentBindings['BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST'],
) {
  const { resolveHarnessBootstrapParentState } =
    createHarnessBootstrapParentState({
      BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
      observeParentSessions,
      observeParentBindingPath,
      readLocalEngineBinding,
      persistTrustedBootstrapSessionSnapshot,
      readControlPlaneSupervisorState,
    });
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
      presentMaintenanceSummary:
        overrides.presentMaintenanceSummary ??
        ((summary) => {
          process.stderr.write(`\n${summary.humanReadable}\n\n`);
        }),
      resolveParentDurableState: ({ parentChangeId, stateRoot }) =>
        resolveHarnessBootstrapParentState(cwd, parentChangeId, stateRoot),
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
    productionControlPlaneAuditSink,
    productionRecoveryAuditSink,
  } = createHarnessBootstrapAudit({
    recordAuthorityRefusal,
    deriveAuthorityAuditRepositoryId,
    recordAuthorityAuditEvent,
  });
  const {
    recoveryOperationalTrustRootDependencies,
    recoveryQuarantineDependencies,
    createHarnessRecoveryDependencies,
  } = createHarnessBootstrapRecoveryProduction({
    recoveryGrants: controlPlaneRecoveryGrantPersistence,
    RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
    verifySshSignatureWithPublicKey,
    createHarnessBootstrapDependencies,
    productionRecoveryTrustRootAuditSink,
    productionRecoveryQuarantineAuditSink,
    productionControlPlaneAuditSink,
    productionRecoveryAuditSink,
  });
  function createHarnessBootstrapCommandDispatcher({
    bootstrapInterventionStateRoot,
    bootstrapInterventionUsage,
  }: Pick<
    HarnessBootstrapRecoveryCommandBindings,
    'bootstrapInterventionStateRoot' | 'bootstrapInterventionUsage'
  >) {
    return createHarnessBootstrapRecoveryCommands({
      discoverRepository,
      bootstrapInterventionStateRoot,
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
      createHarnessRecoveryDependencies,
    });
  }
  return {
    resolveHarnessBootstrapParentState,
    createHarnessBootstrapDependencies,
    auditHarnessRecoveryRefusal,
    productionRecoveryTrustRootAuditSink,
    productionRecoveryQuarantineAuditSink,
    productionControlPlaneAuditSink,
    productionRecoveryAuditSink,
    recoveryOperationalTrustRootDependencies,
    recoveryQuarantineDependencies,
    createHarnessRecoveryDependencies,
    createHarnessBootstrapCommandDispatcher,
  };
}
export type HarnessBootstrapProduction = ReturnType<
  typeof createHarnessBootstrapProduction
>;
