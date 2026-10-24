/** Inspect retained intervention metadata and coordinate its authorized disposition. */
import crypto from 'node:crypto';
import path from 'node:path';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import type { BootstrapInterventionCliDependencies } from '../../modules/authority/intervention-bootstrap-contract.ts';
import type { VerifyAuthorityAuditEvents } from '../../modules/authority/authority-audit-contract.ts';
import type { HumanRevocationAuthorizer } from '../../modules/authority/human-revocation-contract.ts';
import type { discoverRepository } from '../../runtime/repository-transaction/git-working-state.ts';
import type { runtimePaths } from '../../runtime/session-workspace/workflow-session-records.ts';
import type {
  abandonPersistedIntervention,
  assertPersistedInterventionAbandonable,
} from '../../runtime/storage-journal/intervention-abandonment.ts';
import type { readLocalEngineBinding } from '../../runtime/storage-journal/intervention-parent-binding.ts';
import type { readPersistedIntervention } from '../../runtime/storage-journal/intervention-plan-store.ts';
import type {
  readMaintenanceGrantForParent,
  revokeMaintenanceGrantForParent,
} from './intervention-maintenance.ts';

type InterventionMetadataDispositionOperations = {
  discoverRepository: typeof discoverRepository;
  runtimePaths: typeof runtimePaths;
  readMaintenanceGrantForParent: typeof readMaintenanceGrantForParent;
  assertPersistedInterventionAbandonable: typeof assertPersistedInterventionAbandonable;
  verifyAuthorityAuditEvents: VerifyAuthorityAuditEvents;
  revokeMaintenanceGrantForParent: typeof revokeMaintenanceGrantForParent;
  authorizeHumanRevocation: HumanRevocationAuthorizer;
  abandonPersistedIntervention: typeof abandonPersistedIntervention;
  readPersistedIntervention: typeof readPersistedIntervention;
  readLocalEngineBinding: typeof readLocalEngineBinding;
};

export function createInterventionMetadataDisposition({
  discoverRepository,
  runtimePaths,
  readMaintenanceGrantForParent,
  assertPersistedInterventionAbandonable,
  verifyAuthorityAuditEvents,
  revokeMaintenanceGrantForParent,
  authorizeHumanRevocation,
  abandonPersistedIntervention,
  readPersistedIntervention,
  readLocalEngineBinding,
}: InterventionMetadataDispositionOperations) {
  function inspect(cwd: string, parentChangeId: string) {
    const repository = discoverRepository(cwd);
    const stateRoot = interventionStateRoot(repository.gitCommonDirectory);
    const intervention = readPersistedIntervention(stateRoot, parentChangeId);
    const bindingPath = parentBindingPath(stateRoot, parentChangeId);
    return {
      stateRoot,
      bindingPath,
      parentChangeId,
      checkpointId: intervention.checkpoint.checkpointId,
      workspaceId: intervention.childWorkspace.workspaceId,
      intervention,
      parentSession: readOptionalParentSession(bindingPath),
      effectsPerformed: false,
    };
  }

  function revoke(
    cwd: string,
    parentChangeId: string,
    reason: string,
    dependencies: BootstrapInterventionCliDependencies,
  ) {
    const repository = discoverRepository(cwd);
    const stateRoot = interventionStateRoot(repository.gitCommonDirectory);
    const before = readMaintenanceGrantForParent(stateRoot, parentChangeId);
    if (!dependencies.verifyHumanSignature) {
      throw workflowError(
        'INTERVENTION_MAINTENANCE_APPROVAL_UI_REQUIRED',
        'Maintenance revocation requires a trusted historical signature verifier.',
        ExitCode.unsafeEnvironment,
      );
    }
    const bindingPath = parentBindingPath(stateRoot, parentChangeId);
    assertPersistedInterventionAbandonable(stateRoot, bindingPath, {
      parentChangeId,
      interventionChangeId: before.interventionChangeId,
      checkpointId: before.checkpointId,
      grantId: before.envelope.payload.grantId,
    });
    verifyAuthorityAuditEvents({
      externalAuditRoot: before.authorityAudit.externalAuditRoot,
      repositoryRoot: repository.repositoryRoot,
      repositoryId: before.authorityAudit.repositoryId,
    });
    const revoked = revokeMaintenanceGrantForParent(
      authorizeHumanRevocation,
      repository.repositoryRoot,
      stateRoot,
      parentChangeId,
      {
        reason,
        now: dispositionNow(dependencies),
        signer: dependencies.maintenanceSigner,
        verifyHumanSignature: dependencies.verifyHumanSignature,
        testAfterAudit: dependencies.testHooks?.afterAuthorityAuditRecorded,
      },
    );
    const abandoned = abandonPersistedIntervention(stateRoot, bindingPath, {
      parentChangeId,
      interventionChangeId: revoked.interventionChangeId,
      checkpointId: revoked.checkpointId,
      grantId: revoked.envelope.payload.grantId,
      grantRecordDigest: revoked.recordDigest,
      reason: revoked.revocationReason!,
      at: revoked.revokedAt!,
      testAfterIntentPersisted:
        dependencies.testHooks?.afterAbandonmentIntentPersisted,
    });
    return {
      stateRoot,
      bindingPath,
      parentChangeId,
      checkpointId: revoked.checkpointId,
      effectsPerformed:
        before.state !== 'revoked' || abandoned.effectsPerformed,
    };
  }

  function interventionStateRoot(gitCommonDirectory: string): string {
    return path.join(
      runtimePaths(gitCommonDirectory, 'workflow-engine').root,
      'intervention-control',
    );
  }

  function readOptionalParentSession(bindingPath: string) {
    try {
      return readLocalEngineBinding(bindingPath);
    } catch (error) {
      if (
        error instanceof WorkflowError &&
        error.code === 'BOOTSTRAP_BINDING_NOT_FOUND'
      ) {
        return null;
      }
      throw error;
    }
  }

  return { inspect, revoke };
}

function parentBindingPath(stateRoot: string, parentChangeId: string): string {
  const identity = crypto
    .createHash('sha256')
    .update(`parent-session\0${parentChangeId}`)
    .digest('hex');
  return path.join(stateRoot, 'local-parent-sessions', `${identity}.json`);
}

function dispositionNow(
  dependencies: BootstrapInterventionCliDependencies,
): Date {
  const now = dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw workflowError(
      'INTERVENTION_BOOTSTRAP_CLOCK_INVALID',
      'Bootstrap CLI clock returned an invalid date.',
      ExitCode.unsafeEnvironment,
    );
  }
  return new Date(now.getTime());
}
