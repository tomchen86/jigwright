/** Binds Task Mandate rules to the production repository, persistence and audit services. */
import crypto from 'node:crypto';
import { createTaskMandateOperations } from '../application/control-plane/task-mandate.ts';
import { taskMandateStore } from '../runtime/storage-journal/task-mandate-store.ts';
import { taskMandateRepository } from '../runtime/storage-journal/task-mandate-repository.ts';
import { scanAuthorityAuditLedger } from '../runtime/storage-journal/authority-audit-ledger.ts';
import { recordAuthorityAuditEvent } from '../runtime/storage-journal/authority-audit-service.ts';
import { withAuthorityRefusalAudit } from '../modules/authority/authority-refusal-audit.ts';
import { withRepositoryLifecycleOperation } from '../runtime/session-workspace/session-store.ts';
export const taskMandateOperations = createTaskMandateOperations({
  store: taskMandateStore,
  repository: taskMandateRepository,
  audit: {
    scanAuthorityAuditLedger,
    recordAuthorityAuditEvent,

    withAuthorityRefusalAudit,
  },
  now: () => new Date(),
  newMandateId: crypto.randomUUID,
  withRepositoryLifecycleOperation,
});
