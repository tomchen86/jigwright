/** Binds Task Mandate rules to the production repository, persistence and audit services. */
import crypto from 'node:crypto';
import { createTaskMandateOperations } from '../modules/authority/task-mandate.ts';
import { taskMandateStore } from '../runtime/storage-journal/task-mandate-store.ts';
import { taskMandateRepository } from '../runtime/storage-journal/task-mandate-repository.ts';
import {
  deriveAuthorityAuditRepositoryId,
  scanAuthorityAuditLedger,
} from '../runtime/storage-journal/authority-audit-ledger.ts';
import { recordAuthorityAuditEvent } from '../runtime/storage-journal/authority-audit-service.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
} from '../modules/authority/authority-refusal-audit.ts';
import { withRepositoryLifecycleOperation } from '../runtime/session-workspace/session-store.ts';
export const taskMandateOperations = createTaskMandateOperations({
  store: taskMandateStore,
  repository: taskMandateRepository,
  audit: {
    deriveAuthorityAuditRepositoryId,
    scanAuthorityAuditLedger,
    recordAuthorityAuditEvent,
    authorityRefusalDigest,
    withAuthorityRefusalAudit,
  },
  now: () => new Date(),
  newMandateId: crypto.randomUUID,
  withRepositoryLifecycleOperation,
});
