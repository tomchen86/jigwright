import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertApprovalSubject,
  approvalSubjectDigest,
  type ApprovalSubject,
  type GrantApprovalMethod,
} from '../../modules/authority/grant-core.ts';
import {
  assertGitAuthorityCandidateApplyParameters,
  gitAuthorityCandidateApplyParametersDigest,
  type GitAuthorityCandidateApplyFailureV1,
  type GitAuthorityCandidateApplyObservationV1,
  type GitAuthorityCandidateApplyParametersV1,
  type GitAuthorityCandidateApplyPhase,
} from '../../modules/authority/git-authority-candidate-apply-grant.ts';
import {
  grantHasExactKeys,
  grantSha256,
  GRANT_SHA256_DIGEST,
  GRANT_STABLE_ID,
  GRANT_UUID_V4,
} from '../../modules/authority/grant-primitives.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  createPrivateCanonicalJson,
  readPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from './investigation-session-store.ts';

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export type GitAuthorityCandidateApplyJournalEntryV2 = Readonly<{
  revision: number;
  phase: Exclude<GitAuthorityCandidateApplyPhase, 'pending'>;
  previousEntryDigest: `sha256:${string}` | null;
  commitHash: string | null;
  failure: GitAuthorityCandidateApplyFailureV1 | null;
  entryDigest: `sha256:${string}`;
}>;

export type GitAuthorityCandidateApplyJournalV2 = Readonly<{
  schemaVersion: 2;
  kind: 'git-authority-candidate-apply-journal.v2';
  parameters: GitAuthorityCandidateApplyParametersV1;
  parametersDigest: `sha256:${string}`;
  challengeId: string;
  operationId: string;
  approvalSubject: ApprovalSubject;
  approvalMethod: GrantApprovalMethod;
  approvalSubjectDigest: `sha256:${string}`;
  preparedGrantRecordDigest: `sha256:${string}`;
  commitMessage: string;
  indexMode: number;
  entries: readonly GitAuthorityCandidateApplyJournalEntryV2[];
  journalDigest: `sha256:${string}`;
}>;

export type GitAuthorityCandidateApplyStorePaths = Readonly<{
  root: string;
  journals: string;
  indexPublications: string;
}>;

export function gitAuthorityCandidateApplyStorePaths(
  runtime: InvestigationRuntimePaths,
): GitAuthorityCandidateApplyStorePaths {
  const root = path.join(runtime.root, 'git-authority-candidate-apply-v2');
  return Object.freeze({
    root,
    journals: path.join(root, 'journals'),
    indexPublications: path.join(root, 'index-publications'),
  });
}

export function createGitAuthorityCandidateApplyJournal(
  runtime: InvestigationRuntimePaths,
  input: Readonly<{
    parameters: GitAuthorityCandidateApplyParametersV1;
    challengeId: string;
    operationId: string;
    approvalSubject: ApprovalSubject;
    preparedGrantRecordDigest: `sha256:${string}`;
    commitMessage: string;
    indexMode: number;
  }>,
): GitAuthorityCandidateApplyJournalV2 {
  const parameters = assertGitAuthorityCandidateApplyParameters(
    input.parameters,
  );
  const approvalSubject = assertApprovalSubject(input.approvalSubject);
  if (
    !GRANT_UUID_V4.test(input.challengeId) ||
    !GRANT_UUID_V4.test(input.operationId) ||
    !GRANT_SHA256_DIGEST.test(input.preparedGrantRecordDigest) ||
    typeof input.commitMessage !== 'string' ||
    input.commitMessage.length === 0 ||
    Buffer.byteLength(input.commitMessage) > 16_384 ||
    !input.commitMessage.endsWith('\n') ||
    input.commitMessage.includes('\0') ||
    !isSafeIndexMode(input.indexMode)
  ) {
    throw journalInvalid();
  }
  const entry = createEntry(0, 'prepared', null, null, null);
  const body = {
    schemaVersion: 2 as const,
    kind: 'git-authority-candidate-apply-journal.v2' as const,
    parameters,
    parametersDigest: gitAuthorityCandidateApplyParametersDigest(parameters),
    challengeId: input.challengeId,
    operationId: input.operationId,
    approvalSubject,
    approvalMethod: approvalSubject.approvalMethod,
    approvalSubjectDigest: approvalSubjectDigest(approvalSubject),
    preparedGrantRecordDigest: input.preparedGrantRecordDigest,
    commitMessage: input.commitMessage,
    indexMode: input.indexMode,
    entries: Object.freeze([entry]),
  };
  const journal = assertGitAuthorityCandidateApplyJournal({
    ...body,
    journalDigest: journalDigest(body),
  });
  createPrivateCanonicalJson(
    runtime,
    journalPath(runtime, input.operationId),
    journal,
    journalInvalid,
    'GIT_AUTHORITY_CANDIDATE_APPLY_JOURNAL_COLLISION',
  );
  return readGitAuthorityCandidateApplyJournal(runtime, input.operationId);
}

export function readOptionalGitAuthorityCandidateApplyJournal(
  runtime: InvestigationRuntimePaths,
  operationId: string,
): GitAuthorityCandidateApplyJournalV2 | null {
  if (!GRANT_UUID_V4.test(operationId)) throw journalInvalid();
  const filePath = journalPath(runtime, operationId);
  const observed = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (observed === undefined) return null;
  return assertGitAuthorityCandidateApplyJournal(
    readPrivateCanonicalJson(runtime, filePath, journalInvalid),
  );
}

export function readGitAuthorityCandidateApplyJournal(
  runtime: InvestigationRuntimePaths,
  operationId: string,
): GitAuthorityCandidateApplyJournalV2 {
  const journal = readOptionalGitAuthorityCandidateApplyJournal(
    runtime,
    operationId,
  );
  if (journal === null) {
    throw workflowError(
      'GIT_AUTHORITY_CANDIDATE_APPLY_JOURNAL_MISSING',
      'The exact current-v2 Git authority Apply journal is missing.',
      ExitCode.staleState,
    );
  }
  return journal;
}

export function advanceGitAuthorityCandidateApplyJournal(
  runtime: InvestigationRuntimePaths,
  currentValue: GitAuthorityCandidateApplyJournalV2,
  update: Readonly<{
    phase: Exclude<GitAuthorityCandidateApplyPhase, 'pending' | 'prepared'>;
    commitHash: string | null;
    failure: GitAuthorityCandidateApplyFailureV1 | null;
  }>,
): GitAuthorityCandidateApplyJournalV2 {
  const current = assertGitAuthorityCandidateApplyJournal(currentValue);
  const observed = readGitAuthorityCandidateApplyJournal(
    runtime,
    current.operationId,
  );
  if (observed.journalDigest !== current.journalDigest) {
    throw workflowError(
      'GIT_AUTHORITY_CANDIDATE_APPLY_JOURNAL_CHANGED',
      'The exact Git authority Apply journal changed concurrently.',
      ExitCode.staleState,
    );
  }
  const prior = current.entries.at(-1)!;
  assertPhaseTransition(prior.phase, update.phase);
  const entry = createEntry(
    prior.revision + 1,
    update.phase,
    prior.entryDigest,
    update.commitHash,
    update.failure,
  );
  const body = {
    schemaVersion: current.schemaVersion,
    kind: current.kind,
    parameters: current.parameters,
    parametersDigest: current.parametersDigest,
    challengeId: current.challengeId,
    operationId: current.operationId,
    approvalSubject: current.approvalSubject,
    approvalMethod: current.approvalMethod,
    approvalSubjectDigest: current.approvalSubjectDigest,
    preparedGrantRecordDigest: current.preparedGrantRecordDigest,
    commitMessage: current.commitMessage,
    indexMode: current.indexMode,
    entries: Object.freeze([...current.entries, entry]),
  };
  const next = assertGitAuthorityCandidateApplyJournal({
    ...body,
    journalDigest: journalDigest(body),
  });
  writePrivateCanonicalJsonAtomic(
    runtime,
    journalPath(runtime, current.operationId),
    next,
    journalInvalid,
  );
  return readGitAuthorityCandidateApplyJournal(runtime, current.operationId);
}

export function gitAuthorityCandidateApplyJournalObservation(
  value: GitAuthorityCandidateApplyJournalV2,
): GitAuthorityCandidateApplyObservationV1 {
  const journal = assertGitAuthorityCandidateApplyJournal(value);
  const current = journal.entries.at(-1)!;
  return Object.freeze({
    schemaVersion: 1,
    kind: 'git-authority-candidate-apply-observation.v1',
    phase: current.phase,
    candidateDigest: journal.parameters.candidateDigest,
    parametersDigest: journal.parametersDigest,
    targetRef: journal.parameters.candidate.targetRef,
    expectedOldCommit: journal.parameters.candidate.expectedOldCommit,
    resultTree: journal.parameters.candidate.resultTree,
    challengeId: journal.challengeId,
    operationId: journal.operationId,
    approvalMethod: journal.approvalMethod,
    approvalSubjectDigest: journal.approvalSubjectDigest,
    preparedGrantRecordDigest: journal.preparedGrantRecordDigest,
    commitHash: current.commitHash,
    failure: current.failure,
    journalDigest: journal.journalDigest,
  });
}

export function assertGitAuthorityCandidateApplyJournal(
  value: unknown,
): GitAuthorityCandidateApplyJournalV2 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'parameters',
      'parametersDigest',
      'challengeId',
      'operationId',
      'approvalSubject',
      'approvalMethod',
      'approvalSubjectDigest',
      'preparedGrantRecordDigest',
      'commitMessage',
      'indexMode',
      'entries',
      'journalDigest',
    ]) ||
    value.schemaVersion !== 2 ||
    value.kind !== 'git-authority-candidate-apply-journal.v2' ||
    typeof value.parametersDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.parametersDigest) ||
    typeof value.challengeId !== 'string' ||
    !GRANT_UUID_V4.test(value.challengeId) ||
    typeof value.operationId !== 'string' ||
    !GRANT_UUID_V4.test(value.operationId) ||
    (value.approvalMethod !== 'human-presence' &&
      value.approvalMethod !== 'ssh') ||
    typeof value.approvalSubjectDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.approvalSubjectDigest) ||
    typeof value.preparedGrantRecordDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.preparedGrantRecordDigest) ||
    typeof value.commitMessage !== 'string' ||
    value.commitMessage.length === 0 ||
    Buffer.byteLength(value.commitMessage) > 16_384 ||
    !value.commitMessage.endsWith('\n') ||
    value.commitMessage.includes('\0') ||
    !isSafeIndexMode(value.indexMode) ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0 ||
    value.entries.length > 16 ||
    typeof value.journalDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.journalDigest)
  ) {
    throw journalInvalid();
  }
  const parameters = assertGitAuthorityCandidateApplyParameters(
    value.parameters,
  );
  const subject = assertApprovalSubject(value.approvalSubject);
  const entries = value.entries.map((entry, index) =>
    assertEntry(entry, index),
  );
  if (
    value.parametersDigest !==
      gitAuthorityCandidateApplyParametersDigest(parameters) ||
    value.approvalMethod !== subject.approvalMethod ||
    value.approvalSubjectDigest !== approvalSubjectDigest(subject) ||
    entries[0]!.phase !== 'prepared' ||
    entries[0]!.previousEntryDigest !== null ||
    entries.some(
      (entry, index) =>
        index > 0 &&
        (entry.previousEntryDigest !== entries[index - 1]!.entryDigest ||
          !isAllowedPhaseTransition(entries[index - 1]!.phase, entry.phase)),
    )
  ) {
    throw journalInvalid();
  }
  const body = {
    schemaVersion: 2 as const,
    kind: 'git-authority-candidate-apply-journal.v2' as const,
    parameters,
    parametersDigest: value.parametersDigest as `sha256:${string}`,
    challengeId: value.challengeId,
    operationId: value.operationId,
    approvalSubject: subject,
    approvalMethod: value.approvalMethod as GrantApprovalMethod,
    approvalSubjectDigest: value.approvalSubjectDigest as `sha256:${string}`,
    preparedGrantRecordDigest:
      value.preparedGrantRecordDigest as `sha256:${string}`,
    commitMessage: value.commitMessage,
    indexMode: value.indexMode,
    entries: Object.freeze(entries),
  };
  if (value.journalDigest !== journalDigest(body)) throw journalInvalid();
  return Object.freeze({
    ...body,
    journalDigest: value.journalDigest as `sha256:${string}`,
  });
}

function assertEntry(
  value: unknown,
  expectedRevision: number,
): GitAuthorityCandidateApplyJournalEntryV2 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'revision',
      'phase',
      'previousEntryDigest',
      'commitHash',
      'failure',
      'entryDigest',
    ]) ||
    value.revision !== expectedRevision ||
    ![
      'prepared',
      'index-published',
      'commit-created',
      'ref-update-prepared',
      'ref-updated',
      'completed',
      'failed',
    ].includes(String(value.phase)) ||
    (value.previousEntryDigest !== null &&
      (typeof value.previousEntryDigest !== 'string' ||
        !GRANT_SHA256_DIGEST.test(value.previousEntryDigest))) ||
    (value.commitHash !== null &&
      (typeof value.commitHash !== 'string' ||
        !COMMIT_OID.test(value.commitHash))) ||
    typeof value.entryDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.entryDigest)
  ) {
    throw journalInvalid();
  }
  const phase = value.phase as Exclude<
    GitAuthorityCandidateApplyPhase,
    'pending'
  >;
  const failure = value.failure === null ? null : assertFailure(value.failure);
  if (
    (phase === 'prepared' && value.commitHash !== null) ||
    ([
      'index-published',
      'commit-created',
      'ref-update-prepared',
      'ref-updated',
      'completed',
    ].includes(phase) &&
      value.commitHash === null) ||
    (phase === 'failed' && failure === null) ||
    (phase !== 'failed' && failure !== null)
  ) {
    throw journalInvalid();
  }
  const body = {
    revision: value.revision,
    phase,
    previousEntryDigest: value.previousEntryDigest as `sha256:${string}` | null,
    commitHash: value.commitHash as string | null,
    failure,
  };
  if (value.entryDigest !== entryDigest(body)) throw journalInvalid();
  return Object.freeze({
    ...body,
    entryDigest: value.entryDigest as `sha256:${string}`,
  });
}

function assertFailure(value: unknown): GitAuthorityCandidateApplyFailureV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'code',
      'observedStateDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'git-authority-candidate-apply-failure.v1' ||
    typeof value.code !== 'string' ||
    !GRANT_STABLE_ID.test(value.code) ||
    typeof value.observedStateDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.observedStateDigest)
  ) {
    throw journalInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'git-authority-candidate-apply-failure.v1',
    code: value.code,
    observedStateDigest: value.observedStateDigest as `sha256:${string}`,
  });
}

function createEntry(
  revision: number,
  phase: Exclude<GitAuthorityCandidateApplyPhase, 'pending'>,
  previousEntryDigest: `sha256:${string}` | null,
  commitHash: string | null,
  failure: GitAuthorityCandidateApplyFailureV1 | null,
): GitAuthorityCandidateApplyJournalEntryV2 {
  const body = { revision, phase, previousEntryDigest, commitHash, failure };
  return Object.freeze({ ...body, entryDigest: entryDigest(body) });
}

function entryDigest(value: unknown): `sha256:${string}` {
  return grantSha256(
    `workflow.git-authority-candidate-apply-journal-entry.v2\n${canonicalJson(
      value,
    )}`,
  );
}

function journalDigest(value: unknown): `sha256:${string}` {
  return grantSha256(
    `workflow.git-authority-candidate-apply-journal.v2\n${canonicalJson(value)}`,
  );
}

function isSafeIndexMode(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (value & 0o600) === 0o600 &&
    (value & 0o7111) === 0 &&
    (value & 0o002) === 0
  );
}

function assertPhaseTransition(
  previous: Exclude<GitAuthorityCandidateApplyPhase, 'pending'>,
  next: Exclude<GitAuthorityCandidateApplyPhase, 'pending' | 'prepared'>,
): void {
  if (!isAllowedPhaseTransition(previous, next)) throw journalInvalid();
}

function isAllowedPhaseTransition(
  previous: Exclude<GitAuthorityCandidateApplyPhase, 'pending'>,
  next: Exclude<GitAuthorityCandidateApplyPhase, 'pending'>,
): boolean {
  if (next === 'failed')
    return previous !== 'completed' && previous !== 'failed';
  return (
    (previous === 'prepared' && next === 'commit-created') ||
    (previous === 'commit-created' && next === 'ref-update-prepared') ||
    (previous === 'ref-update-prepared' && next === 'ref-updated') ||
    (previous === 'ref-updated' && next === 'index-published') ||
    (previous === 'index-published' && next === 'completed')
  );
}

function journalPath(
  runtime: InvestigationRuntimePaths,
  operationId: string,
): string {
  if (!GRANT_UUID_V4.test(operationId)) throw journalInvalid();
  return path.join(
    gitAuthorityCandidateApplyStorePaths(runtime).journals,
    `${operationId}.json`,
  );
}

function journalInvalid() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_JOURNAL_INVALID',
    'The exact current-v2 Git authority Apply journal is invalid or unsafe.',
    ExitCode.guard,
  );
}
