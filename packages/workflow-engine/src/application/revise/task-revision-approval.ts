/** Coordinates exact approval rules with required repository, signing and storage capabilities. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { MaintainerDataSignatureVerifier } from '../../modules/authority/maintainer-signer-port.ts';
import {
  TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT,
  TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
  TASK_REVISION_APPROVAL_TTL_MINUTES,
  approvalInvalid,
  approvalStale,
  assertApprovalId,
  assertArmoredSignature,
  assertRationale,
  assertTaskRevisionApprovalBinding,
  assertTaskRevisionApprovalPayload,
  assertTaskRevisionApprovalRecord,
  canonicalTaskRevisionApprovalPayload,
  exactDate,
  taskRevisionApprovalSignatureNamespace,
  taskRevisionApprovalTargetDigest,
  type TaskRevisionApprovalBinding,
  type TaskRevisionApprovalEnvelope,
  type TaskRevisionApprovalIssueOptions,
  type TaskRevisionApprovalIssueRequest,
  type TaskRevisionApprovalIssueResult,
  type TaskRevisionApprovalPayload,
  type TaskRevisionApprovalValidationOptions,
  type TaskRevisionApprovalRepository,
  type TaskRevisionApprovalRecords,
  type TaskRevisionApprovalSignerFactory,
} from '../../modules/authority/task-revision-approval-contracts.ts';

export function issueTaskRevisionApproval(
  repositoryObservations: TaskRevisionApprovalRepository,
  approvalRecords: TaskRevisionApprovalRecords,
  createSigner: TaskRevisionApprovalSignerFactory,
  cwd: string,
  requested: TaskRevisionApprovalIssueRequest,
  options: TaskRevisionApprovalIssueOptions = {},
): TaskRevisionApprovalIssueResult {
  const binding = assertTaskRevisionApprovalBinding(requested.binding);
  const targetDigest = taskRevisionApprovalTargetDigest(binding);
  if (requested.expectedTargetDigest !== targetDigest) {
    throw approvalInvalid(
      'The requested task-revision approval target does not match the exact candidate.',
    );
  }
  const rationale = assertRationale(requested.rationale);
  const repository = repositoryObservations.inspect(cwd);
  if (
    repository.head !== binding.baselineCommit ||
    repository.tree !== binding.baselineTree
  ) {
    throw approvalStale(
      'The task-revision approval baseline changed before human authorization.',
    );
  }
  const { policy, policyBlob } = repositoryObservations.policyAt(
    repository.repositoryRoot,
    binding.baselineCommit,
  );
  const origin = readRepositoryOrigin(
    repositoryObservations,
    repository.repositoryRoot,
    approvalInvalid,
  );
  if (origin !== policy.repository.origin) {
    throw approvalInvalid(
      'Repository origin does not match the trusted approval policy.',
    );
  }
  const signer =
    options.signer ?? createSigner(repository.repositoryRoot, policy);
  signer.assertHumanPresent();
  const signerIdentity = signer.identity();
  if (
    signerIdentity === binding.actorAuthorityId ||
    !policy.trustedSigners.some(({ identity }) => identity === signerIdentity)
  ) {
    throw approvalInvalid(
      'Task-revision approval must come from a trusted authority external to the benefiting session.',
    );
  }
  const now = exactDate(options.now ?? new Date());
  const payload: TaskRevisionApprovalPayload = {
    version: 1,
    kind: 'task-revision-approval.v1',
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob,
    binding,
    targetDigest,
    authorizedEffect: TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT,
    rationale,
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() +
        Math.min(policy.maxTtlMinutes, TASK_REVISION_APPROVAL_TTL_MINUTES) *
          60_000,
    ).toISOString(),
    signer: signerIdentity,
  };
  assertTaskRevisionApprovalPayload(payload, policy, policyBlob, binding, {
    now,
  });
  const canonicalPayload = canonicalTaskRevisionApprovalPayload(payload);
  let signature: string;
  try {
    signature = signer.sign(
      canonicalPayload,
      TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
    );
    assertArmoredSignature(signature);
    signer.verify(
      canonicalPayload,
      signature,
      signerIdentity,
      TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
    );
  } catch (error) {
    throw approvalSignatureInvalid(error);
  }
  const envelope: TaskRevisionApprovalEnvelope = Object.freeze({
    payload,
    signatureNamespace: TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
    signature,
  });
  const publication = approvalRecords.publish(repository, {
    schemaVersion: 1,
    kind: 'task-revision-approval-record.v1',
    createdAt: payload.issuedAt,
    envelope,
  });
  return { ...publication, envelope };
}

export function readAndValidateTaskRevisionApproval(
  repositoryObservations: TaskRevisionApprovalRepository,
  approvalRecords: TaskRevisionApprovalRecords,
  verifySignature: MaintainerDataSignatureVerifier,
  cwd: string,
  requestedApprovalId: string,
  expectedBinding: TaskRevisionApprovalBinding,
  options: TaskRevisionApprovalValidationOptions,
): TaskRevisionApprovalEnvelope {
  const approvalId = assertApprovalId(requestedApprovalId);
  const binding = assertTaskRevisionApprovalBinding(expectedBinding);
  const repository = repositoryObservations.inspect(cwd);
  const { policy, policyBlob } = repositoryObservations.policyAt(
    repository.repositoryRoot,
    binding.baselineCommit,
  );
  const origin = readRepositoryOrigin(
    repositoryObservations,
    repository.repositoryRoot,
    approvalStale,
  );
  if (origin !== policy.repository.origin) {
    throw approvalStale(
      'Repository origin changed after task-revision approval preparation.',
    );
  }
  const record = approvalRecords.read(repository, approvalId);
  const envelope = assertTaskRevisionApprovalRecord(record, approvalId);
  assertTaskRevisionApprovalPayload(
    envelope.payload,
    policy,
    policyBlob,
    binding,
    options,
  );
  const signer = policy.trustedSigners.find(
    ({ identity }) => identity === envelope.payload.signer,
  );
  if (!signer) {
    throw approvalInvalid('Task-revision approval signer is not trusted.');
  }
  const canonicalPayload = canonicalTaskRevisionApprovalPayload(
    envelope.payload,
  );
  try {
    if (options.verifier) {
      options.verifier.verify(
        canonicalPayload,
        envelope.signature,
        envelope.payload.signer,
        taskRevisionApprovalSignatureNamespace(envelope),
      );
    } else {
      verifySignature(
        canonicalPayload,
        envelope.signature,
        signer,
        taskRevisionApprovalSignatureNamespace(envelope),
        'TASK_REVISION_APPROVAL_SIGNATURE_INVALID',
      );
    }
  } catch (error) {
    throw approvalSignatureInvalid(error);
  }
  return envelope;
}

function readRepositoryOrigin(
  observations: TaskRevisionApprovalRepository,
  repositoryRoot: string,
  errorFactory: (message: string) => Error,
): string {
  try {
    return observations.origin(repositoryRoot);
  } catch {
    throw errorFactory(
      'The live repository origin is unavailable for task-revision approval.',
    );
  }
}

function approvalSignatureInvalid(_cause: unknown) {
  return workflowError(
    'TASK_REVISION_APPROVAL_SIGNATURE_INVALID',
    'Task-revision approval signature is invalid.',
    ExitCode.verification,
  );
}
