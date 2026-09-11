/**
 * Issues and validates task-revision approvals from an independent trusted
 * signer.
 *
 * Invariants:
 * - issueTaskRevisionApproval refuses unless the signer is trusted and
 *   differs from the binding's actorAuthorityId (external authority).
 * - readAndValidateTaskRevisionApproval rejects the record unless the
 *   recomputed taskRevisionApprovalRecordId equals the requested
 *   approvalId.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadWorkflowConfig } from '../../runtime/repository-observation/workflow-configuration.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { ensurePlainDirectory } from '../../runtime/repository-transaction/filesystem-safety.ts';
import {
  discoverRepository,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  createInteractiveSshSigner,
  verifySshSignatureWithPublicKey,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  assertChangeId,
  assertSessionId,
  assertTaskId,
  normalizePolicyPath,
} from '../../foundation/repository-path/repository-path.ts';
import {
  readContentRecord,
  writeContentRecord,
} from '../../runtime/storage-journal/content-record-store.ts';
import { runtimePaths } from '../../runtime/session-workspace/session-store.ts';
import { createTaskRevisionApprovalContracts } from './task-revision-approval-contracts.ts';

export const TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE =
  'workflow.task-revision-approval.v1' as const;

export const TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT =
  'task-revision-authority-widening-only' as const;

export const TASK_REVISION_APPROVAL_TTL_MINUTES = 5;

export type CreateTaskRevisionApprovalContractsBindings = Readonly<{
  TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT: typeof TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT;
  TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE: typeof TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE;
  TASK_REVISION_APPROVAL_TTL_MINUTES: typeof TASK_REVISION_APPROVAL_TTL_MINUTES;
  assertChangeId: typeof assertChangeId;
  assertSessionId: typeof assertSessionId;
  assertTaskId: typeof assertTaskId;
  normalizePolicyPath: typeof normalizePolicyPath;
}>;
const taskRevisionApprovalContracts = createTaskRevisionApprovalContracts({
  TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT,
  TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
  TASK_REVISION_APPROVAL_TTL_MINUTES,
  assertChangeId,
  assertSessionId,
  assertTaskId,
  normalizePolicyPath,
});
export const {
  taskRevisionApprovalTargetDigest,
  canonicalTaskRevisionApprovalPayload,
  assertTaskRevisionApprovalBinding,
} = taskRevisionApprovalContracts;
const {
  taskRevisionApprovalRecordId,
  assertTaskRevisionApprovalEnvelope,
  assertTaskRevisionApprovalPayload,
  taskRevisionApprovalSignatureNamespace,
  hasExactKeys,
  approvalInvalid,
  assertArmoredSignature,
  exactDate,
  OID,
  approvalStale,
  assertRationale,
  SHA256,
} = taskRevisionApprovalContracts;

export type TaskRevisionApprovalBinding = Readonly<{
  schemaVersion: 1;
  kind: 'task-revision-approval-binding.v1';
  changeId: string;
  taskId: string;
  sessionId: string;
  leaseId: string;
  actorAuthorityId: string;
  baselineCommit: string;
  baselineTree: string;
  priorContractDigest: string;
  candidateContractDigest: string;
  candidatePlanningGenerationId: string;
  implementationFingerprint: string;
  revisionReasonDigest: string;
  previousAllowedPaths: string[];
  nextAllowedPaths: string[];
  previousRequiredChecks: string[];
  nextRequiredChecks: string[];
}>;

export type TaskRevisionApprovalPayload = Readonly<{
  version: 1;
  kind: 'task-revision-approval.v1';
  repositoryId: string;
  repositoryOrigin: string;
  policyBlob: string;
  binding: TaskRevisionApprovalBinding;
  targetDigest: string;
  authorizedEffect: typeof TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT;
  rationale: string;
  issuedAt: string;
  expiresAt: string;
  signer: string;
}>;

export type TaskRevisionApprovalEnvelope = Readonly<{
  payload: TaskRevisionApprovalPayload;
  signatureNamespace: typeof TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE;
  signature: string;
}>;

export type TaskRevisionApprovalIssueRequest = Readonly<{
  binding: TaskRevisionApprovalBinding;
  expectedTargetDigest: string;
  rationale: string;
}>;

export type TaskRevisionApprovalIssueOptions = Readonly<{
  now?: Date;
  signer?: MaintainerSignerProvider;
}>;

export type TaskRevisionApprovalValidationOptions = Readonly<{
  now: Date;
  allowExpired?: boolean;
  verifier?: Pick<MaintainerSignerProvider, 'verify'>;
}>;

export type TaskRevisionApprovalIssueResult = Readonly<{
  approvalId: string;
  recordPath: string;
  envelope: TaskRevisionApprovalEnvelope;
}>;

export function issueTaskRevisionApproval(
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
  const repository = discoverRepository(cwd);
  if (
    repository.head !== binding.baselineCommit ||
    repository.tree !== binding.baselineTree
  ) {
    throw approvalStale(
      'The task-revision approval baseline changed before human authorization.',
    );
  }
  const { policy, policyBlob } = loadPolicyAtCommit(
    repository.repositoryRoot,
    binding.baselineCommit,
  );
  const origin = readRepositoryOrigin(
    repository.repositoryRoot,
    approvalInvalid,
  );
  if (origin !== policy.repository.origin) {
    throw approvalInvalid(
      'Repository origin does not match the trusted approval policy.',
    );
  }
  const signer =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
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
  const directory = approvalDirectory(
    repository.gitCommonDirectory,
    repository.repositoryRoot,
  );
  ensurePrivateApprovalDirectory(directory);
  const approvalId = writeContentRecord(directory, {
    schemaVersion: 1,
    kind: 'task-revision-approval-record.v1',
    createdAt: payload.issuedAt,
    envelope,
  });
  return {
    approvalId,
    recordPath: path.join(directory, `${approvalId}.json`),
    envelope,
  };
}

export function readAndValidateTaskRevisionApproval(
  cwd: string,
  requestedApprovalId: string,
  expectedBinding: TaskRevisionApprovalBinding,
  options: TaskRevisionApprovalValidationOptions,
): TaskRevisionApprovalEnvelope {
  const approvalId = assertApprovalId(requestedApprovalId);
  const binding = assertTaskRevisionApprovalBinding(expectedBinding);
  const repository = discoverRepository(cwd);
  const { policy, policyBlob } = loadPolicyAtCommit(
    repository.repositoryRoot,
    binding.baselineCommit,
  );
  const origin = readRepositoryOrigin(repository.repositoryRoot, approvalStale);
  if (origin !== policy.repository.origin) {
    throw approvalStale(
      'Repository origin changed after task-revision approval preparation.',
    );
  }
  const directory = approvalDirectory(
    repository.gitCommonDirectory,
    repository.repositoryRoot,
  );
  const recordPath = path.join(directory, `${approvalId}.json`);
  let record: ReturnType<typeof readContentRecord>;
  try {
    assertPrivateApprovalDirectory(directory);
    const stats = fs.lstatSync(recordPath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      fs.realpathSync(recordPath) !== path.resolve(recordPath)
    ) {
      throw new Error('unsafe approval record');
    }
    record = readContentRecord(directory, approvalId);
  } catch {
    throw workflowError(
      'TASK_REVISION_APPROVAL_NOT_FOUND',
      `Task-revision approval ${approvalId} is unavailable or unsafe.`,
      ExitCode.staleState,
    );
  }
  if (
    !hasExactKeys(record, ['schemaVersion', 'kind', 'createdAt', 'envelope']) ||
    record.schemaVersion !== 1 ||
    record.kind !== 'task-revision-approval-record.v1'
  ) {
    throw approvalInvalid('Task-revision approval record is malformed.');
  }
  const envelope = assertTaskRevisionApprovalEnvelope(record.envelope);
  if (record.createdAt !== envelope.payload.issuedAt) {
    throw approvalInvalid(
      'Task-revision approval record timestamp does not match its signed payload.',
    );
  }
  if (taskRevisionApprovalRecordId(record.createdAt, envelope) !== approvalId) {
    throw approvalInvalid(
      'Task-revision approval record is not the unique canonical decision record.',
    );
  }
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
      verifySshSignatureWithPublicKey(
        canonicalPayload,
        envelope.signature,
        envelope.payload.signer,
        signer.publicKey,
        taskRevisionApprovalSignatureNamespace(envelope),
      );
    }
  } catch (error) {
    throw approvalSignatureInvalid(error);
  }
  return envelope;
}

function approvalDirectory(
  gitCommonDirectory: string,
  repositoryRoot: string,
): string {
  const config = loadWorkflowConfig(repositoryRoot);
  return path.join(
    runtimePaths(gitCommonDirectory, config.runtimeDirectory).root,
    'task-revision-approvals',
  );
}

function ensurePrivateApprovalDirectory(directory: string): void {
  ensurePlainDirectory(directory);
  assertPrivateApprovalDirectory(directory);
}

function assertPrivateApprovalDirectory(directory: string): void {
  const absolute = path.resolve(directory);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o777) !== 0o700 ||
    fs.realpathSync(absolute) !== absolute
  ) {
    throw approvalInvalid(
      'Task-revision approval storage is not a private canonical directory.',
    );
  }
}

function loadPolicyAtCommit(
  repositoryRoot: string,
  commit: string,
): { policy: MaintainerPolicy; policyBlob: string } {
  if (!OID.test(commit)) {
    throw approvalInvalid('Task-revision approval baseline is invalid.');
  }
  try {
    return {
      policy: parseMaintainerPolicy(
        JSON.parse(
          runGit(repositoryRoot, [
            'show',
            `${commit}:workflow/maintainer-policy.json`,
          ]),
        ),
      ),
      policyBlob: runGit(repositoryRoot, [
        'rev-parse',
        `${commit}:workflow/maintainer-policy.json`,
      ]).trim(),
    };
  } catch {
    throw approvalInvalid(
      'The exact task-revision baseline has no valid maintainer policy.',
    );
  }
}

function readRepositoryOrigin(
  repositoryRoot: string,
  errorFactory: (message: string) => Error,
): string {
  try {
    return runGit(repositoryRoot, ['remote', 'get-url', 'origin']).trim();
  } catch {
    throw errorFactory(
      'The live repository origin is unavailable for task-revision approval.',
    );
  }
}

function assertApprovalId(value: string): string {
  if (!SHA256.test(value)) {
    throw approvalInvalid('Task-revision approval reference is invalid.');
  }
  return value;
}

function approvalSignatureInvalid(_cause: unknown) {
  return workflowError(
    'TASK_REVISION_APPROVAL_SIGNATURE_INVALID',
    'Task-revision approval signature is invalid.',
    ExitCode.verification,
  );
}
