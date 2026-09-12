/** Task Mandate use cases bind required effects once and preserve lifecycle publication order. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { assertChangeId } from '../../foundation/repository-path/repository-path.ts';
import {
  deriveAuthorityAuditRepositoryId,
  sha256Digest,
  type AuthorityAuditRecordedEvent,
} from '../../modules/authority/authority-audit-contract.ts';
import { type MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';
import {
  type TaskMandateOperationOptions,
  type TaskMandateOptions,
} from '../../modules/authority/task-mandate-access-contract.ts';
import { taskMandateRefusalBinding } from '../../modules/authority/task-mandate-audit.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import {
  assertTaskMandateChange,
  assertTaskMandateTaskId,
  isPreparationOperation,
} from '../../modules/authority/task-mandate-policy.ts';
import {
  canonicalTaskMandatePayload,
  canonicalTaskMandateRecord,
  createInitialTaskMandateRecord,
  createTaskMandatePayload,
  parseCurrentTaskMandateRecord,
  parseTaskMandateRequest,
  validateTaskMandatePayload,
} from '../../modules/authority/task-mandate-records.ts';
import { type TaskMandateServices } from '../../modules/authority/task-mandate-services.ts';
import {
  assertExternalAuditRoot,
  assertMandateId,
  assertRevocationReason,
  assertSignature,
  exactDate,
  isWorkflowFailure,
  TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
  unsafeStore,
  type TaskMandateEnvelope,
  type TaskMandateInspection,
  type TaskMandateOperation,
  type TaskMandatePayload,
  type TaskMandateRecord,
  type TaskMandateRequest,
} from '../../modules/authority/task-mandate-values.ts';
import {
  assertRecordActive,
  inspectRecord,
  taskMandateBinding,
} from '../../modules/authority/task-mandate.ts';
import {
  appendTaskMandateAuthorizationAudit,
  appendTaskMandateRevocationAudit,
} from './task-mandate-audit.ts';
import { createTaskMandateProviderLifecycle } from './task-mandate-provider-lifecycle.ts';
import { validateTaskMandateEnvelopeForRepository } from './task-mandate-trust.ts';

export type AuthorizeTaskMandateOptions = TaskMandateOptions & {
  mandateId?: string;
  externalAuditRoot?: string;
};
export type RevokeTaskMandateOptions = TaskMandateOptions & {
  reason: string;
};
export function createTaskMandateOperations(services: TaskMandateServices) {
  const {
    authorizeTaskMandateProviderReservation,
    authorizeTaskMandateProviderReservationUnderLifecycleLock,
    assertActiveTaskMandateBindingUnderLifecycleLock,
    recordTaskMandateProviderInvocation,
    recordTaskMandateProviderInvocationUnderLifecycleLock,
  } = createTaskMandateProviderLifecycle(services);
  const {
    now: clockNow,
    newMandateId,
    withRepositoryLifecycleOperation,
  } = services;
  const {
    discoverRepository,
    loadPolicyAt,
    repositoryHead,
    repositoryOrigin,
    createInteractiveSshSigner,
  } = services.repository;
  const {
    taskMandateStorePaths,
    ensureStore,
    readTaskRecord,
    taskRecordPath,
    taskHistoryPath,
    createPrivateFileAtomic,
    replacePrivateFileAtomic,
    readPrivateFile,
    fsyncDirectory,
    exists: mandateFileExists,
    move: moveMandateFile,
  } = services.store;
  const {
    scanAuthorityAuditLedger,

    withAuthorityRefusalAudit,
  } = services.audit;

  function authorizeTaskMandate(
    cwd: string,
    requested: TaskMandateRequest,
    options: AuthorizeTaskMandateOptions = {},
  ): {
    mandateId: string;
    recordPath: string;
    envelope: TaskMandateEnvelope;
    audit: AuthorityAuditRecordedEvent;
  } {
    const request = parseTaskMandateRequest(requested);
    const context = loadTrustContext(cwd);
    const externalAuditRoot = assertExternalAuditRoot(
      options.externalAuditRoot,
    );
    scanAuthorityAuditLedger({
      externalAuditRoot,
      repositoryRoot: context.repository.repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(
        context.policy.repository.id,
      ),
    });
    const now = exactDate(options.now ?? clockNow());
    const mandateId = assertMandateId(options.mandateId ?? newMandateId());
    const paths = taskMandateStorePaths(context.repository.gitCommonDirectory);
    const existingActive = taskRecordPath(paths.active, request.taskId);
    const existingTerminal = taskRecordPath(paths.terminal, request.taskId);
    if (mandateFileExists(existingActive)) {
      throw workflowError(
        'TASK_MANDATE_EXISTS',
        `Task ${request.taskId} already has an active mandate.`,
        ExitCode.conflict,
      );
    }
    if (mandateFileExists(existingTerminal)) {
      const terminal = parseCurrentTaskMandateRecord(
        readPrivateFile(existingTerminal),
      );
      validateTaskMandateEnvelopeForRepository(
        services,
        context.repository.repositoryRoot,
        terminal.envelope,
        options.signer,
      );
    }
    const signer =
      options.signer ??
      createInteractiveSshSigner(
        context.repository.repositoryRoot,
        context.policy,
      );

    signer.assertHumanPresent();
    const identity = signer.identity();
    if (
      !context.policy.trustedSigners.some(({ identity: id }) => id === identity)
    ) {
      throw workflowError(
        'TASK_MANDATE_SIGNER_UNTRUSTED',
        'Task mandate signer is not trusted by the exact base policy.',
        ExitCode.verification,
      );
    }
    const payload: TaskMandatePayload = createTaskMandatePayload(
      request,
      context,
      mandateId,
      externalAuditRoot,
      now,
      identity,
    );
    validateTaskMandatePayload(payload);
    let signature: string;
    try {
      signature = signer.sign(
        canonicalTaskMandatePayload(payload),
        TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
      );
      assertSignature(signature);
      signer.verify(
        canonicalTaskMandatePayload(payload),
        signature,
        identity,
        TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
      );
    } catch (error) {
      if (isWorkflowFailure(error)) throw error;
      throw workflowError(
        'TASK_MANDATE_SIGNATURE_INVALID',
        'Task mandate signature could not be created or verified.',
        ExitCode.verification,
      );
    }
    const envelope = { payload, signature };
    const record: TaskMandateRecord = createInitialTaskMandateRecord(
      request,
      envelope,
      mandateId,
      externalAuditRoot,
      now,
    );
    const recordPath = withRepositoryLifecycleOperation(
      paths.runtime,
      (assertOwned) => {
        ensureStore(paths);
        assertOwned();
        const active = taskRecordPath(paths.active, request.taskId);
        const terminal = taskRecordPath(paths.terminal, request.taskId);
        if (mandateFileExists(active)) {
          throw workflowError(
            'TASK_MANDATE_EXISTS',
            `Task ${request.taskId} already has an active mandate.`,
            ExitCode.conflict,
          );
        }
        if (mandateFileExists(terminal)) {
          const previous = parseCurrentTaskMandateRecord(
            readPrivateFile(terminal),
          );
          const history = taskHistoryPath(
            paths.history,
            request.taskId,
            previous.mandateId,
          );
          if (mandateFileExists(history)) throw unsafeStore();
          moveMandateFile(terminal, history);
          fsyncDirectory(paths.terminal);
          fsyncDirectory(paths.history);
        }
        createPrivateFileAtomic(active, canonicalTaskMandateRecord(record));
        assertOwned();
        return active;
      },
    );
    const audit = appendTaskMandateAuthorizationAudit(
      services.audit,
      context.repository.repositoryRoot,
      record,
      exactDate(options.now ?? clockNow()),
    );
    return { mandateId, recordPath, envelope, audit };
  }

  function inspectTaskMandate(
    cwd: string,
    requestedTaskId: string,
    options: TaskMandateOptions = {},
  ): TaskMandateInspection {
    const taskId = assertTaskMandateTaskId(requestedTaskId);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    const record = readTaskRecord(paths, taskId);
    validateTaskMandateEnvelopeForRepository(
      services,
      repository.repositoryRoot,
      record.envelope,
      options.signer,
    );
    return inspectRecord(record, exactDate(options.now ?? clockNow()));
  }

  function inspectActiveTaskMandateBinding(
    cwd: string,
    requestedTaskId: string,
    options: TaskMandateOptions = {},
  ): TaskMandateBinding {
    return withActiveTaskMandateBinding(
      cwd,
      requestedTaskId,
      options,
      (binding) => binding,
    );
  }

  function withActiveTaskMandateBinding<T>(
    cwd: string,
    requestedTaskId: string,
    options: TaskMandateOptions,
    operation: (binding: TaskMandateBinding, assertOwned: () => void) => T,
  ): T {
    const taskId = assertTaskMandateTaskId(requestedTaskId);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
      const record = readTaskRecord(paths, taskId);
      validateTaskMandateEnvelopeForRepository(
        services,
        repository.repositoryRoot,
        record.envelope,
        options.signer,
      );
      const auditNow = exactDate(options.now ?? clockNow());
      assertRecordActive(record, auditNow);
      appendTaskMandateAuthorizationAudit(
        services.audit,
        repository.repositoryRoot,
        record,
        auditNow,
      );
      assertOwned();
      return operation(taskMandateBinding(record), assertOwned);
    });
  }

  function authorizeTaskMandateOperation(
    cwd: string,
    requestedTaskId: string,
    operation: Exclude<TaskMandateOperation, { kind: 'provider-call' }>,
    options: TaskMandateOperationOptions,
  ): {
    authorized: true;
    mandateId: string;
    taskId: string;
    binding: TaskMandateBinding;
  } {
    const taskId = assertTaskMandateTaskId(requestedTaskId);
    const changeId = assertChangeId(options.changeId);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
      const record = readTaskRecord(paths, taskId);
      validateTaskMandateEnvelopeForRepository(
        services,
        repository.repositoryRoot,
        record.envelope,
        options.signer,
      );
      const now = exactDate(options.now ?? clockNow());
      const refusalBinding = taskMandateRefusalBinding(
        repository.repositoryRoot,
        record,
        'task-mandate.operation',
        {
          changeId,
          operationKind: operation.kind,
        },
      );
      return withAuthorityRefusalAudit(refusalBinding, { now }, () => {
        assertRecordActive(record, now);
        assertTaskMandateChange(record, changeId);
        appendTaskMandateAuthorizationAudit(
          services.audit,
          repository.repositoryRoot,
          record,
          now,
        );
        assertOwned();
        if (!isPreparationOperation(operation.kind)) {
          throw workflowError(
            'TASK_MANDATE_EFFECT_NOT_AUTHORIZED',
            `Task mandate does not authorize ${operation.kind}.`,
            ExitCode.guard,
          );
        }
        record.lastActivityAt = now.toISOString();
        replacePrivateFileAtomic(
          taskRecordPath(paths.active, taskId),
          canonicalTaskMandateRecord(record),
        );
        assertOwned();
        return {
          authorized: true as const,
          mandateId: record.mandateId,
          taskId,
          binding: taskMandateBinding(record),
        };
      });
    });
  }

  function revokeTaskMandate(
    cwd: string,
    requestedTaskId: string,
    options: RevokeTaskMandateOptions,
  ): TaskMandateInspection {
    const taskId = assertTaskMandateTaskId(requestedTaskId);
    const reason = assertRevocationReason(options.reason);
    const repository = discoverRepository(cwd);
    const paths = taskMandateStorePaths(repository.gitCommonDirectory);
    return withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
      ensureStore(paths);
      const terminalPath = taskRecordPath(paths.terminal, taskId);
      if (mandateFileExists(terminalPath)) {
        const terminal = parseCurrentTaskMandateRecord(
          readPrivateFile(terminalPath),
        );
        validateTaskMandateEnvelopeForRepository(
          services,
          repository.repositoryRoot,
          terminal.envelope,
          options.signer,
        );
        if (terminal.schemaVersion === 2) {
          appendTaskMandateAuthorizationAudit(
            services.audit,
            repository.repositoryRoot,
            terminal,
            exactDate(options.now ?? clockNow()),
          );
          appendTaskMandateRevocationAudit(
            services.audit,
            repository.repositoryRoot,
            terminal,
            exactDate(options.now ?? clockNow()),
          );
        }
        return inspectRecord(terminal, exactDate(options.now ?? clockNow()));
      }
      const record = readTaskRecord(paths, taskId);
      validateTaskMandateEnvelopeForRepository(
        services,
        repository.repositoryRoot,
        record.envelope,
        options.signer,
      );
      const now = exactDate(options.now ?? clockNow());
      const refusalBinding = taskMandateRefusalBinding(
        repository.repositoryRoot,
        record,
        'task-mandate.revoke',
        { reasonDigest: sha256Digest(canonicalJson(reason)) },
      );
      return withAuthorityRefusalAudit(refusalBinding, { now }, () => {
        appendTaskMandateAuthorizationAudit(
          services.audit,
          repository.repositoryRoot,
          record,
          now,
        );
        const signer =
          options.signer ?? currentSigner(repository.repositoryRoot);
        signer.assertHumanPresent();
        const currentPolicy = loadPolicyAt(
          repository.repositoryRoot,
          repository.head,
        ).policy;
        if (
          !currentPolicy.trustedSigners.some(
            ({ identity }) => identity === signer.identity(),
          )
        ) {
          throw workflowError(
            'TASK_MANDATE_SIGNER_UNTRUSTED',
            'Task mandate revocation requires a currently trusted signer.',
            ExitCode.verification,
          );
        }
        record.state = 'revoked';
        record.revokedAt = now.toISOString();
        record.revocationReason = reason;
        assertOwned();
        const activePath = taskRecordPath(paths.active, taskId);
        moveMandateFile(activePath, terminalPath);
        replacePrivateFileAtomic(
          terminalPath,
          canonicalTaskMandateRecord(record),
        );
        assertOwned();
        appendTaskMandateRevocationAudit(
          services.audit,
          repository.repositoryRoot,
          record,
          now,
        );
        assertOwned();
        return inspectRecord(record, now);
      });
    });
  }

  function loadTrustContext(cwd: string) {
    const repository = discoverRepository(cwd);
    const loaded = loadPolicyAt(repository.repositoryRoot, repository.head);
    const origin = repositoryOrigin(repository.repositoryRoot);
    if (origin !== loaded.policy.repository.origin) {
      throw workflowError(
        'TASK_MANDATE_REPOSITORY_MISMATCH',
        'Repository origin differs from its trusted task mandate policy.',
        ExitCode.guard,
      );
    }
    return { repository, ...loaded };
  }

  function currentSigner(repositoryRoot: string): MaintainerSignerProvider {
    const head = repositoryHead(repositoryRoot);
    return createInteractiveSshSigner(
      repositoryRoot,
      loadPolicyAt(repositoryRoot, head).policy,
    );
  }

  return {
    authorizeTaskMandate,
    inspectTaskMandate,
    inspectActiveTaskMandateBinding,
    withActiveTaskMandateBinding,
    authorizeTaskMandateOperation,
    authorizeTaskMandateProviderReservation,
    authorizeTaskMandateProviderReservationUnderLifecycleLock,
    assertActiveTaskMandateBindingUnderLifecycleLock,
    recordTaskMandateProviderInvocation,
    recordTaskMandateProviderInvocationUnderLifecycleLock,
    revokeTaskMandate,
  };
}
