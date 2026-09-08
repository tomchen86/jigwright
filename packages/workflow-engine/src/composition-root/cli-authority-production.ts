import {
  discoverRepository,
  runGit,
} from '../runtime/repository-transaction/git.ts';
import {
  assertInteractiveSignerContext,
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../adapters/signing/ssh/maintainer-signer.ts';
import { parseMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import {
  inspectActiveTaskMandateBinding,
  type TaskMandateBinding,
} from '../modules/authority/task-mandate.ts';
import type { ControlPlaneTaskMandateBinding } from '../modules/authority/intervention-control.ts';
import {
  assertSameControlPlaneTaskMandateBinding,
  type ControlPlaneTaskMandateValidationPhase,
  type ControlPlaneApprovalSummaryV3,
  type ControlPlaneUpdaterAuditRecord,
} from '../application/control-plane/intervention-control-updater.ts';
import type { ControlPlanePromotionReviewSummaryV3 } from '../application/control-plane/control-plane-promotion-producer.ts';
import {
  deriveAuthorityAuditRepositoryId,
  type AuthorityAuditEventType,
  type AuthorityAuditResult,
} from '../runtime/storage-journal/authority-audit-ledger.ts';
import { recordAuthorityAuditEvent } from '../runtime/storage-journal/authority-audit-service.ts';
import {
  createConsumedCollaborationGrantReplayVerifier,
  createCurrentAuthoritativeCollaborationGrantVerifier,
  createCurrentAuthoritativeRoleContextSharingGrantVerifier,
} from './grant-verifier-composition.ts';
import { productionRoleContextSharingGrantLifecyclePort } from './role-context-sharing-grant-lifecycle-production.ts';
import { readCollaborationGrantInspection } from '../runtime/storage-journal/collaboration-grant-store.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';

export function interventionControlDependencies(cwd: string) {
  return {
    now: () => new Date(),
    verifyHumanSignature(
      payload: string,
      signature: string,
      signer: string,
      namespace: string,
    ): boolean {
      try {
        const repository = discoverRepository(cwd);
        const policy = parseMaintainerPolicy(
          JSON.parse(
            runGit(repository.repositoryRoot, [
              'show',
              `${repository.head}:workflow/maintainer-policy.json`,
            ]),
          ),
        );
        const verifier = createInteractiveSshSigner(
          repository.repositoryRoot,
          policy,
        );
        verifier.verify(payload, signature, signer, namespace);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function controlPlaneUpdaterDependencies(
  cwd: string,
  controlPlaneTaskMandateBindingFromTaskMandate: (
    binding: TaskMandateBinding,
  ) => ControlPlaneTaskMandateBinding,
) {
  const human = interventionControlDependencies(cwd);
  const repository = discoverRepository(cwd);
  let resolvedApprovalSigner: MaintainerSignerProvider | null = null;
  const resolveApprovalSigner = (): MaintainerSignerProvider => {
    if (resolvedApprovalSigner === null) {
      const policy = parseMaintainerPolicy(
        JSON.parse(
          runGit(repository.repositoryRoot, [
            'show',
            `${repository.head}:workflow/maintainer-policy.json`,
          ]),
        ),
      );
      resolvedApprovalSigner = createInteractiveSshSigner(
        repository.repositoryRoot,
        policy,
      );
    }
    return resolvedApprovalSigner;
  };
  const approvalSigner: MaintainerSignerProvider = {
    assertHumanPresent(): void {
      assertInteractiveSignerContext({
        stdinIsTty: process.stdin.isTTY === true,
        stdoutIsTty: process.stdout.isTTY === true,
        stderrIsTty: process.stderr.isTTY === true,
      });
      resolveApprovalSigner().assertHumanPresent();
    },
    identity: () => resolveApprovalSigner().identity(),
    sign: (payload, namespace) =>
      resolveApprovalSigner().sign(payload, namespace),
    verify: (payload, signature, identity, namespace) =>
      resolveApprovalSigner().verify(payload, signature, identity, namespace),
  };
  return {
    ...human,
    approvalSigner,
    resolveTaskMandateBinding(parentTaskId: string) {
      return controlPlaneTaskMandateBindingFromTaskMandate(
        inspectActiveTaskMandateBinding(cwd, parentTaskId),
      );
    },
    revalidateTaskMandateBinding(
      binding: Parameters<typeof assertSameControlPlaneTaskMandateBinding>[0],
      _phase: ControlPlaneTaskMandateValidationPhase,
    ): void {
      const current = controlPlaneTaskMandateBindingFromTaskMandate(
        inspectActiveTaskMandateBinding(cwd, binding.parentTaskId),
      );
      assertSameControlPlaneTaskMandateBinding(binding, current);
    },
    presentApprovalSummaryV3(summary: ControlPlaneApprovalSummaryV3): void {
      process.stderr.write(`\n${summary.humanReadable}\n\n`);
    },
    presentReviewSummary(summary: ControlPlanePromotionReviewSummaryV3): void {
      process.stderr.write(`\n${summary.humanReadable}\n\n`);
    },
    consumedGrantIds: new Set<string>(),
    auditSink: {
      append(record: ControlPlaneUpdaterAuditRecord): void {
        recordAuthorityAuditEvent(
          {
            externalAuditRoot: record.externalAuditRoot,
            repositoryRoot: repository.repositoryRoot,
            repositoryId: deriveAuthorityAuditRepositoryId(record.repositoryId),
          },
          {
            eventType: controlPlaneAuditEventType(record),
            occurredAt: record.recordedAt,
            idempotencyKey: record.recordId,
            grantDigest: record.grantEnvelopeDigest,
            candidateBundleDigest: record.promotionBundleDigest,
            prestateDigest: null,
            poststateDigest: record.evidenceDigest,
            actor: {
              kind: 'engine',
              identity: 'control-plane-updater',
            },
            taskId: record.parentTaskId,
            changeId: record.changeId,
            workflowId: record.txId,
            command: {
              name: 'control-plane.update',
              argvDigest: record.recordDigest,
            },
            providerInvocation: null,
            externalEffect: null,
            result: controlPlaneAuditResult(record),
            outcomeDigest: record.recordDigest,
            errorCode: null,
          },
        );
      },
    },
  };
}

function controlPlaneAuditEventType(
  record: ControlPlaneUpdaterAuditRecord,
): AuthorityAuditEventType {
  switch (record.event) {
    case 'prepared':
      return 'control-plane-grant';
    case 'switched':
      return 'cas';
    case 'rollback-required':
    case 'rolled-back':
      return 'rollback';
    case 'finalized':
      return 'grant-consume';
    default:
      return 'poststate';
  }
}

function controlPlaneAuditResult(
  record: ControlPlaneUpdaterAuditRecord,
): AuthorityAuditResult {
  switch (record.event) {
    case 'finalized':
      return 'succeeded';
    case 'rolled-back':
      return 'rolled-back';
    default:
      return 'recorded';
  }
}

export function currentCollaborationGrantSelection(
  cwd: string,
  grantId: string,
) {
  const repository = discoverRepository(cwd);
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  return Object.freeze({
    grantId,
    verifier: createCurrentAuthoritativeCollaborationGrantVerifier(policy),
  });
}

export function currentRoleContextSharingGrantSelection(
  cwd: string,
  grantId: string,
) {
  const repository = discoverRepository(cwd);
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  return Object.freeze({
    grantId,
    lifecycle: productionRoleContextSharingGrantLifecyclePort,
    verifier: createCurrentAuthoritativeRoleContextSharingGrantVerifier(policy),
  });
}

function maintainerPolicyAtCommit(repositoryRoot: string, commit: string) {
  return parseMaintainerPolicy(
    JSON.parse(
      runGit(repositoryRoot, [
        'show',
        `${commit}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
}

export function taskDiffCollaborationGrantSelection(
  cwd: string,
  grantId: string,
) {
  const repository = discoverRepository(cwd);
  const inspection = readCollaborationGrantInspection(
    repository.gitCommonDirectory,
    grantId,
  );
  if (inspection?.state === 'consumed') {
    if (inspection.use === undefined) {
      throw workflowError(
        'COLLABORATION_GRANT_CONSUMED_REPLAY_VERIFIER_UNAVAILABLE',
        'The terminal-only Collaboration Grant replay verifier is unavailable.',
        ExitCode.guard,
      );
    }
    const historicalPolicy = maintainerPolicyAtCommit(
      repository.repositoryRoot,
      inspection.use.envelope.payload.baselineCommit,
    );
    return Object.freeze({
      grantId,
      consumedReplayVerifier:
        createConsumedCollaborationGrantReplayVerifier(historicalPolicy),
    });
  }
  const currentPolicy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${repository.head}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  return Object.freeze({
    grantId,
    verifier:
      createCurrentAuthoritativeCollaborationGrantVerifier(currentPolicy),
    consumedReplayVerifier:
      createConsumedCollaborationGrantReplayVerifier(currentPolicy),
  });
}

export function taskDiffConsumedCollaborationGrantReplayVerifier(
  cwd: string,
  grantId: string,
) {
  const repository = discoverRepository(cwd);
  const inspection = readCollaborationGrantInspection(
    repository.gitCommonDirectory,
    grantId,
  );
  if (inspection?.state !== 'consumed' || inspection.use === undefined) {
    throw workflowError(
      'TASK_DIFF_EXTERNAL_RECONCILIATION_GRANT_NOT_CONSUMED',
      'External TaskDiffReview reconciliation currently requires the exact Grant to have reached its durable consumed state.',
      ExitCode.guard,
    );
  }
  const historicalPolicy = maintainerPolicyAtCommit(
    repository.repositoryRoot,
    inspection.use.envelope.payload.baselineCommit,
  );
  return createConsumedCollaborationGrantReplayVerifier(historicalPolicy);
}
