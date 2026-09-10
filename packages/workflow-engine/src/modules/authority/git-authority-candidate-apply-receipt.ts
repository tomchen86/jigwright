/**
 * Encodes and validates the portable receipt for a Git authority candidate
 * application.
 *
 * Invariants:
 * - A receipt is SSH-only: its approvalMethod must equal 'ssh'.
 * - Embedded apply parameters must match the receipt target ref, base,
 *   result tree and bound identities.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertGitAuthorityCandidateApplyParameters,
  gitAuthorityCandidateApplyParametersDigest,
  GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID,
  type GitAuthorityCandidateApplyParametersV1,
} from './git-authority-candidate-apply-grant.ts';
import {
  grantHasExactKeys,
  grantSha256,
  GRANT_SHA256_DIGEST,
  GRANT_UUID_V4,
} from './grant-primitives.ts';

export const GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_TAG_PREFIX =
  'refs/tags/workflow-central-grant/' as const;

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TARGET_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

export type GitAuthorityCandidateApplyReceiptV1 = Readonly<{
  schemaVersion: 1;
  kind: 'git-authority-candidate-apply-receipt.v1';
  transitionId: typeof GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID;
  targetRef: string;
  targetCommit: string;
  baseCommit: string;
  baseTree: string;
  resultTree: string;
  parameters: GitAuthorityCandidateApplyParametersV1;
  parametersDigest: `sha256:${string}`;
  candidateDigest: `sha256:${string}`;
  baseAuthorityContextDigest: `sha256:${string}`;
  challengeId: string;
  challengeDigest: `sha256:${string}`;
  operationId: string;
  poststateDigest: `sha256:${string}`;
  approvalMethod: 'ssh';
  approvalSubjectDigest: `sha256:${string}`;
  preparedGrantRecordDigest: `sha256:${string}`;
  terminalGrantRecordDigest: `sha256:${string}`;
  journalDigest: `sha256:${string}`;
  portableEvidenceDigest: `sha256:${string}`;
  portablePayloadDigest: `sha256:${string}`;
  portableSignatureDigest: `sha256:${string}`;
  completedAt: string;
  terminalGrantRecord: Readonly<Record<string, unknown>>;
  journal: Readonly<Record<string, unknown>>;
}>;

const RECEIPT_KEYS = [
  'schemaVersion',
  'kind',
  'transitionId',
  'targetRef',
  'targetCommit',
  'baseCommit',
  'baseTree',
  'resultTree',
  'parameters',
  'parametersDigest',
  'candidateDigest',
  'baseAuthorityContextDigest',
  'challengeId',
  'challengeDigest',
  'operationId',
  'poststateDigest',
  'approvalMethod',
  'approvalSubjectDigest',
  'preparedGrantRecordDigest',
  'terminalGrantRecordDigest',
  'journalDigest',
  'portableEvidenceDigest',
  'portablePayloadDigest',
  'portableSignatureDigest',
  'completedAt',
  'terminalGrantRecord',
  'journal',
] as const;

export function gitAuthorityCandidateApplyReceiptTagRef(
  challengeId: string,
): string {
  if (!GRANT_UUID_V4.test(challengeId)) throw receiptInvalid();
  return `${GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_TAG_PREFIX}${challengeId}`;
}

export function canonicalGitAuthorityCandidateApplyReceipt(
  value: GitAuthorityCandidateApplyReceiptV1,
): string {
  return `${canonicalJson(assertGitAuthorityCandidateApplyReceipt(value))}\n`;
}

export function parseGitAuthorityCandidateApplyReceipt(
  raw: string,
): GitAuthorityCandidateApplyReceiptV1 {
  try {
    if (
      typeof raw !== 'string' ||
      Buffer.byteLength(raw, 'utf8') > MAX_RECEIPT_BYTES ||
      !raw.endsWith('\n')
    ) {
      throw receiptInvalid();
    }
    const receipt = assertGitAuthorityCandidateApplyReceipt(
      JSON.parse(raw) as unknown,
    );
    if (`${canonicalJson(receipt)}\n` !== raw) throw receiptInvalid();
    return receipt;
  } catch (error) {
    if (isReceiptError(error)) throw error;
    throw receiptInvalid();
  }
}

export function assertGitAuthorityCandidateApplyReceipt(
  value: unknown,
): GitAuthorityCandidateApplyReceiptV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, RECEIPT_KEYS) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'git-authority-candidate-apply-receipt.v1' ||
    value.transitionId !== GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID ||
    typeof value.targetRef !== 'string' ||
    !TARGET_REF.test(value.targetRef) ||
    typeof value.targetCommit !== 'string' ||
    !COMMIT_OID.test(value.targetCommit) ||
    typeof value.baseCommit !== 'string' ||
    !COMMIT_OID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !COMMIT_OID.test(value.baseTree) ||
    typeof value.resultTree !== 'string' ||
    !COMMIT_OID.test(value.resultTree) ||
    value.baseTree === value.resultTree ||
    !isDigest(value.parametersDigest) ||
    !isDigest(value.candidateDigest) ||
    !isDigest(value.baseAuthorityContextDigest) ||
    typeof value.challengeId !== 'string' ||
    !GRANT_UUID_V4.test(value.challengeId) ||
    !isDigest(value.challengeDigest) ||
    typeof value.operationId !== 'string' ||
    !GRANT_UUID_V4.test(value.operationId) ||
    !isDigest(value.poststateDigest) ||
    value.approvalMethod !== 'ssh' ||
    !isDigest(value.approvalSubjectDigest) ||
    !isDigest(value.preparedGrantRecordDigest) ||
    !isDigest(value.terminalGrantRecordDigest) ||
    !isDigest(value.journalDigest) ||
    !isDigest(value.portableEvidenceDigest) ||
    !isDigest(value.portablePayloadDigest) ||
    !isDigest(value.portableSignatureDigest) ||
    typeof value.completedAt !== 'string' ||
    !isCanonicalTimestamp(value.completedAt) ||
    !isRecord(value.terminalGrantRecord) ||
    !isRecord(value.journal)
  ) {
    throw receiptInvalid();
  }
  const parameters = assertGitAuthorityCandidateApplyParameters(
    value.parameters,
  );
  if (
    parameters.candidate.targetRef !== value.targetRef ||
    parameters.candidate.expectedOldCommit !== value.baseCommit ||
    parameters.candidate.expectedOldTree !== value.baseTree ||
    parameters.candidate.resultTree !== value.resultTree ||
    parameters.candidateDigest !== value.candidateDigest ||
    gitAuthorityCandidateApplyParametersDigest(parameters) !==
      value.parametersDigest ||
    parameters.baseAuthorityContext.contextDigest !==
      value.baseAuthorityContextDigest
  ) {
    throw receiptInvalid();
  }
  const receipt = deepFreeze({
    schemaVersion: 1 as const,
    kind: 'git-authority-candidate-apply-receipt.v1' as const,
    transitionId: GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID,
    targetRef: value.targetRef,
    targetCommit: value.targetCommit,
    baseCommit: value.baseCommit,
    baseTree: value.baseTree,
    resultTree: value.resultTree,
    parameters,
    parametersDigest: value.parametersDigest as `sha256:${string}`,
    candidateDigest: value.candidateDigest as `sha256:${string}`,
    baseAuthorityContextDigest:
      value.baseAuthorityContextDigest as `sha256:${string}`,
    challengeId: value.challengeId,
    challengeDigest: value.challengeDigest as `sha256:${string}`,
    operationId: value.operationId,
    poststateDigest: value.poststateDigest as `sha256:${string}`,
    approvalMethod: 'ssh' as const,
    approvalSubjectDigest: value.approvalSubjectDigest as `sha256:${string}`,
    preparedGrantRecordDigest:
      value.preparedGrantRecordDigest as `sha256:${string}`,
    terminalGrantRecordDigest:
      value.terminalGrantRecordDigest as `sha256:${string}`,
    journalDigest: value.journalDigest as `sha256:${string}`,
    portableEvidenceDigest: value.portableEvidenceDigest as `sha256:${string}`,
    portablePayloadDigest: value.portablePayloadDigest as `sha256:${string}`,
    portableSignatureDigest:
      value.portableSignatureDigest as `sha256:${string}`,
    completedAt: value.completedAt,
    terminalGrantRecord: value.terminalGrantRecord,
    journal: value.journal,
  });
  if (
    Buffer.byteLength(canonicalJson(receipt), 'utf8') + 1 >
    MAX_RECEIPT_BYTES
  ) {
    throw receiptInvalid();
  }
  return receipt;
}

export function gitAuthorityCandidateApplyReceiptDigest(
  value: GitAuthorityCandidateApplyReceiptV1,
): `sha256:${string}` {
  return grantSha256(
    `workflow.git-authority-candidate-apply-receipt.v1\n${canonicalJson(
      assertGitAuthorityCandidateApplyReceipt(value),
    )}`,
  );
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === 'string' && GRANT_SHA256_DIGEST.test(value);
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach((entry) => deepFreeze(entry));
  }
  return value;
}

function isReceiptError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_INVALID'
  );
}

function receiptInvalid() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_INVALID',
    'The portable Central Git Apply receipt is malformed or inconsistent.',
    ExitCode.guard,
  );
}
