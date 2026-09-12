/** Binds the same approval operations for issuance and revision recovery. */
import {
  issueTaskRevisionApproval as issue,
  readAndValidateTaskRevisionApproval as read,
} from '../application/revise/task-revision-approval.ts';
import { taskRevisionApprovalRepository } from '../runtime/repository-observation/task-revision-approval.ts';
import { taskRevisionApprovalRecords } from '../runtime/storage-journal/task-revision-approval.ts';
import {
  createInteractiveSshSigner,
  verifySshSignatureWithPublicKey,
} from '../adapters/signing/ssh/maintainer-signer.ts';
import type { MaintainerDataSignatureVerifier } from '../modules/authority/maintainer-signer-port.ts';
import type { TaskRevisionApprovalReader } from '../modules/authority/task-revision-approval-contracts.ts';

const verifySignature: MaintainerDataSignatureVerifier = (
  payload,
  signature,
  signer,
  namespace,
) =>
  verifySshSignatureWithPublicKey(
    payload,
    signature,
    signer.identity,
    signer.publicKey,
    namespace,
  );

export const issueTaskRevisionApproval = issue.bind(
  undefined,
  taskRevisionApprovalRepository,
  taskRevisionApprovalRecords,
  createInteractiveSshSigner,
);
export const readAndValidateTaskRevisionApproval: TaskRevisionApprovalReader =
  read.bind(
    undefined,
    taskRevisionApprovalRepository,
    taskRevisionApprovalRecords,
    verifySignature,
  );
