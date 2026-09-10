/**
 * Binds contract and design dispositions to the implementation being finalized.
 *
 * Invariants:
 * - Document bytes, applicable deltas, session and implementation identify one candidate.
 * - An accepted Grant is recorded as skipped-by-grant and never as a successful review.
 * - Reading or recording decisions does not require a protected Apply Grant or lifecycle lock.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  approvalSubjectDigest,
  type ApprovalSubject,
  type GrantChallenge,
} from '../../modules/authority/grant-core.ts';
import type { TransitionOutcome } from '../../modules/authority/grant-transition-registry.ts';
import { grantHasExactKeys } from '../../modules/authority/grant-primitives.ts';
import {
  SYSTEM_DOCUMENT_DISPOSITION_TRANSITION,
  SYSTEM_DOCUMENT_DISPOSITION_REQUIRED,
  assessSystemDocumentDispositions,
  type SystemDocumentDisposition,
} from '../../modules/source/document-disposition.ts';

import type { SystemDocumentCandidate } from './system-document-candidate.ts';
export type SystemDocumentGrantBinding = Readonly<{
  challengeId: string;
  operationId: string;
  approvalSubjectDigest: `sha256:${string}`;
}>;
export type SystemDocumentReviewInput = Readonly<{
  schemaVersion: 1;
  candidateDigest: string;
  dispositions: readonly SystemDocumentDisposition[];
}>;

export type SystemDocumentDispositionPorts = Readonly<{
  observeSystemDocumentCandidate(
    cwd: string,
    sessionId: string,
  ): SystemDocumentCandidate;
  runSessionOperation<T>(cwd: string, sessionId: string, operation: () => T): T;
  readSystemDocumentReviewRecord(
    runtimeRoot: string,
    candidateDigest: string,
  ): {
    reportId: string;
    record: Readonly<Record<string, unknown>>;
  } | null;
  writeSystemDocumentReviewRecord(
    runtimeRoot: string,
    record: {
      schemaVersion: 1;
      kind: 'system-document-disposition-record.v1';
      createdAt: string;
      candidateDigest: string;
      [key: string]: unknown;
    },
  ): string;
  readCompletedGrant(
    runtimeRoot: string,
    challengeId: string,
  ): {
    challenge: GrantChallenge;
    operationId: string;
    approvalSubject: ApprovalSubject;
    outcome: TransitionOutcome;
  } | null;
}>;

export type SystemDocumentDispositionService = ReturnType<
  typeof createSystemDocumentDispositionService
>;

export function createSystemDocumentDispositionService({
  observeSystemDocumentCandidate,
  runSessionOperation,
  readSystemDocumentReviewRecord,
  writeSystemDocumentReviewRecord,
  readCompletedGrant,
}: SystemDocumentDispositionPorts) {
  function inspectSystemDocumentDispositions(cwd: string, sessionId: string) {
    const candidate = observeSystemDocumentCandidate(cwd, sessionId);
    let stored: ReturnType<typeof readSystemDocumentReviewRecord> = null;
    let recordFailure: string | null = null;
    try {
      stored = readSystemDocumentReviewRecord(
        candidate.runtimeRoot,
        candidate.candidateDigest,
      );
    } catch (error) {
      recordFailure = error instanceof Error ? error.message : String(error);
    }
    let dispositions: readonly SystemDocumentDisposition[] = [];
    if (stored?.record.status === 'reviewed') {
      try {
        dispositions = parseDispositions(stored.record.dispositions);
      } catch (error) {
        recordFailure = error instanceof Error ? error.message : String(error);
      }
    }
    const assessment = assessSystemDocumentDispositions(
      candidate.documents,
      dispositions,
    );
    const skippedByGrant =
      stored?.record.status === 'skipped-by-grant' &&
      verifiedGrant(
        candidate.runtimeRoot,
        stored.reportId,
        candidate.candidateDigest,
        stored.record.grant,
      );
    const { runtimeRoot: _runtimeRoot, ...publicCandidate } = candidate;
    return {
      schemaVersion: 1 as const,
      kind: 'system-document-review.v1' as const,
      ...publicCandidate,
      dispositions,
      ...assessment,
      recordFailure,
      reportId: stored?.reportId ?? null,
      status: skippedByGrant
        ? ('skipped-by-grant' as const)
        : assessment.missing.length ||
            assessment.invalid.length ||
            recordFailure
          ? ('required' as const)
          : ('reviewed' as const),
      ...(skippedByGrant
        ? { grant: stored!.record.grant as SystemDocumentGrantBinding }
        : {}),
      dispositionChoices: [
        {
          disposition: 'still-valid',
          description:
            'Confirm that the present contract or readable explanation still describes the implementation.',
          requiredFields: ['path', 'disposition'],
          optionalFields: ['reason', 'followUpRef'],
        },
        {
          disposition: 'updated',
          description:
            'Record an observed contract or explanation update, including an applicable spec delta.',
          requiredFields: ['path', 'disposition'],
          optionalFields: ['reason', 'followUpRef'],
        },
        {
          disposition: 'later',
          description:
            'Defer this document work with an explicit nonempty reason; followUpRef is optional.',
          requiredFields: ['path', 'disposition', 'reason'],
          optionalFields: ['followUpRef'],
        },
      ] satisfies ReadonlyArray<{
        disposition: SystemDocumentDisposition['disposition'];
        description: string;
        requiredFields: readonly (keyof SystemDocumentDisposition)[];
        optionalFields: readonly (keyof SystemDocumentDisposition)[];
      }>,
      reviewCommand: `pnpm workflow documents review ${sessionId} --json`,
      recordCommand: `pnpm workflow documents review ${sessionId} --input <review.json> --json`,
      inputTemplate: {
        schemaVersion: 1 as const,
        candidateDigest: candidate.candidateDigest,
        dispositions: candidate.documents.map(({ path }) => ({
          path,
          disposition: null,
        })),
      },
    };
  }

  function recordSystemDocumentDispositions(
    cwd: string,
    sessionId: string,
    input: unknown,
  ) {
    return runSessionOperation(cwd, sessionId, () => {
      const candidate = observeSystemDocumentCandidate(cwd, sessionId);
      if (
        !isRecord(input) ||
        !grantHasExactKeys(input, [
          'schemaVersion',
          'candidateDigest',
          'dispositions',
        ]) ||
        input.schemaVersion !== 1
      )
        throw reviewInvalid(
          'Use the inputTemplate returned by documents review.',
        );
      if (input.candidateDigest !== candidate.candidateDigest)
        throw workflowError(
          'SYSTEM_DOCUMENT_REVIEW_STALE',
          'The implementation or its documents changed; inspect and review the current candidate.',
          ExitCode.staleState,
        );
      const dispositions = parseDispositions(input.dispositions);
      const assessment = assessSystemDocumentDispositions(
        candidate.documents,
        dispositions,
      );
      if (assessment.missing.length || assessment.invalid.length)
        throw reviewInvalid(
          'Each affected document needs one supported disposition.',
          assessment,
        );
      writeSystemDocumentReviewRecord(candidate.runtimeRoot, {
        schemaVersion: 1,
        kind: 'system-document-disposition-record.v1',
        createdAt: new Date().toISOString(),
        sessionId,
        baselineCommit: candidate.baselineCommit,
        candidateDigest: candidate.candidateDigest,
        documents: candidate.documents,
        status: 'reviewed',
        dispositions,
      });
      return inspectSystemDocumentDispositions(cwd, sessionId);
    });
  }

  function assertSystemDocumentDispositions(
    cwd: string,
    sessionId: string,
  ): void {
    const review = inspectSystemDocumentDispositions(cwd, sessionId);
    if (review.status !== 'required') return;
    throw workflowError(
      SYSTEM_DOCUMENT_DISPOSITION_REQUIRED,
      'Choose still-valid, updated, or later for each affected contract and design explanation; an exact Central Grant can skip these document obligations.',
      ExitCode.guard,
      { details: review },
    );
  }

  /** Called only by the registered Grant transition; its terminal receipt validates consumption. */
  function recordSystemDocumentGrantException(
    cwd: string,
    sessionId: string,
    expectedDigest: string,
    grant: SystemDocumentGrantBinding,
  ): string {
    return runSessionOperation(cwd, sessionId, () => {
      const candidate = observeSystemDocumentCandidate(cwd, sessionId);
      if (candidate.candidateDigest !== expectedDigest)
        throw workflowError(
          'SYSTEM_DOCUMENT_GRANT_STALE',
          'The document Grant no longer names this candidate.',
          ExitCode.staleState,
        );
      try {
        const existing = readSystemDocumentReviewRecord(
          candidate.runtimeRoot,
          expectedDigest,
        );
        if (
          existing?.record.status === 'skipped-by-grant' &&
          canonicalJson(existing.record.grant) === canonicalJson(grant)
        )
          return existing.reportId;
      } catch {
        /* A fresh immutable record can replace an unreadable prior decision. */
      }
      return writeSystemDocumentReviewRecord(candidate.runtimeRoot, {
        schemaVersion: 1,
        kind: 'system-document-disposition-record.v1',
        createdAt: new Date().toISOString(),
        sessionId,
        baselineCommit: candidate.baselineCommit,
        candidateDigest: expectedDigest,
        documents: candidate.documents,
        dispositions: [],
        status: 'skipped-by-grant',
        grant,
      });
    });
  }

  function verifiedGrant(
    runtimeRoot: string,
    reportId: string,
    candidateDigest: string,
    value: unknown,
  ): boolean {
    if (!isRecord(value) || typeof value.challengeId !== 'string') return false;
    try {
      const record = readCompletedGrant(runtimeRoot, value.challengeId);
      if (record === null) return false;
      const choice = record.challenge.choices.find(
        ({ choiceId }) => choiceId === record.approvalSubject.choiceId,
      );
      return (
        choice?.transitionId === SYSTEM_DOCUMENT_DISPOSITION_TRANSITION &&
        isRecord(choice.parameters) &&
        choice.parameters.candidateDigest === candidateDigest &&
        record.operationId === value.operationId &&
        approvalSubjectDigest(record.approvalSubject) ===
          value.approvalSubjectDigest &&
        record.outcome.outcome === 'completed' &&
        isRecord(record.outcome.details) &&
        record.outcome.details.reportId === reportId
      );
    } catch {
      return false;
    }
  }

  return {
    inspectSystemDocumentDispositions,
    recordSystemDocumentDispositions,
    assertSystemDocumentDispositions,
    observeSystemDocumentCandidate,
    recordSystemDocumentGrantException,
  };
}

function parseDispositions(
  value: unknown,
): readonly SystemDocumentDisposition[] {
  if (!Array.isArray(value))
    throw reviewInvalid('dispositions must be an array.');
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== 'string' ||
      !['still-valid', 'updated', 'later'].includes(
        entry.disposition as string,
      ) ||
      Object.keys(entry).some(
        (key) =>
          !['path', 'disposition', 'reason', 'followUpRef'].includes(key),
      ) ||
      [entry.reason, entry.followUpRef].some(
        (field) =>
          field !== undefined && (typeof field !== 'string' || !field.trim()),
      )
    )
      throw reviewInvalid(
        'Each disposition needs a path and still-valid, updated, or later; reasons and optional references are nonempty text.',
      );
    return entry as SystemDocumentDisposition;
  });
}

function reviewInvalid(message: string, details?: Record<string, unknown>) {
  return workflowError(
    'SYSTEM_DOCUMENT_REVIEW_INVALID',
    message,
    ExitCode.guard,
    details === undefined ? {} : { details },
  );
}
