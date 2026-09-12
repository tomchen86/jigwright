/** Observe current repository trust and verify the signed mandate without caching authority. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';
import { taskMandateAuditScope } from '../../modules/authority/task-mandate-audit.ts';
import { canonicalTaskMandatePayload } from '../../modules/authority/task-mandate-records.ts';
import { type TaskMandateServices } from '../../modules/authority/task-mandate-services.ts';
import {
  TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
  type TaskMandateEnvelope,
} from '../../modules/authority/task-mandate-values.ts';
import { assertTaskMandateRepositoryTrust } from '../../modules/authority/task-mandate.ts';

export function validateTaskMandateEnvelopeForRepository(
  services: Pick<TaskMandateServices, 'repository' | 'audit'>,
  repositoryRoot: string,
  envelope: TaskMandateEnvelope,
  providedSigner?: MaintainerSignerProvider,
): void {
  const {
    loadPolicyAt,
    repositoryHead,
    repositoryOrigin,
    createInteractiveSshSigner,
    isPostApprovalAdmissionFailure,
  } = services.repository;
  const { scanAuthorityAuditLedger } = services.audit;
  const payload = envelope.payload;
  const base = loadPolicyAt(repositoryRoot, payload.baseCommit);
  const currentHead = repositoryHead(repositoryRoot);
  const current = loadPolicyAt(repositoryRoot, currentHead);
  const origin = repositoryOrigin(repositoryRoot);
  assertTaskMandateRepositoryTrust(payload, base, current.policy, origin);
  scanAuthorityAuditLedger(taskMandateAuditScope(repositoryRoot, payload));
  const signer =
    providedSigner ?? createInteractiveSshSigner(repositoryRoot, base.policy);
  try {
    signer.verify(
      canonicalTaskMandatePayload(payload),
      envelope.signature,
      payload.signer,
      TASK_MANDATE_SIGNATURE_NAMESPACE_V2,
    );
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) throw error;
    throw workflowError(
      'TASK_MANDATE_SIGNATURE_INVALID',
      'Task mandate signature is invalid for its dedicated domain.',
      ExitCode.verification,
    );
  }
}
