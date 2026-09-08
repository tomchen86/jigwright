/**
 * Binds contract and design dispositions to the implementation being finalized.
 *
 * Invariants:
 * - Document bytes, applicable deltas, session and implementation identify one candidate.
 * - An accepted Grant is recorded as skipped-by-grant and never as a successful review.
 * - Reading or recording decisions does not require a protected Apply Grant or lifecycle lock.
 */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  loadActiveSessionContext,
  runSessionOperation,
} from '../../composition-root/lifecycle-context.ts';
import { approvalSubjectDigest } from '../../modules/authority/grant-core.ts';
import {
  grantHasExactKeys,
  grantSha256,
} from '../../modules/authority/grant-primitives.ts';
import {
  SYSTEM_DOCUMENT_DISPOSITION_TRANSITION,
  assessSystemDocumentDispositions,
  collectSystemDocumentObligations,
  type SystemDocumentDisposition,
  type SystemDocumentObligation,
} from '../../modules/source/document-disposition.ts';
import { sourceDigest } from '../../modules/source/import-dependencies.ts';
import { systemSpecCatalog } from '../../modules/source/system-spec-catalog.ts';
import {
  fingerprintRepositoryProjection,
  listChangedPaths,
} from '../../runtime/repository-transaction/git.ts';
import { readSystemDescriptionSnapshot } from '../../runtime/repository-transaction/system-description-snapshot.ts';
import {
  combineOpenSpecDeltas,
  specDeltaChangesContract,
} from '../../runtime/repository-transaction/archive-delta-verifier.ts';
import {
  readGrantRecord,
  grantStorePaths,
} from '../../runtime/storage-journal/grant-store.ts';
import {
  readSystemDocumentReviewRecord,
  writeSystemDocumentReviewRecord,
} from '../../runtime/storage-journal/system-document-review-store.ts';

export const SYSTEM_DOCUMENT_DISPOSITION_REQUIRED =
  'SYSTEM_DOCUMENT_DISPOSITION_REQUIRED';
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

export function inspectSystemDocumentDispositions(
  cwd: string,
  sessionId: string,
) {
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
      : assessment.missing.length || assessment.invalid.length || recordFailure
        ? ('required' as const)
        : ('reviewed' as const),
    ...(skippedByGrant
      ? { grant: stored!.record.grant as SystemDocumentGrantBinding }
      : {}),
    inputTemplate: {
      schemaVersion: 1 as const,
      candidateDigest: candidate.candidateDigest,
      dispositions: [] as SystemDocumentDisposition[],
    },
  };
}

export function recordSystemDocumentDispositions(
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

export function assertSystemDocumentDispositions(
  cwd: string,
  sessionId: string,
): void {
  const review = inspectSystemDocumentDispositions(cwd, sessionId);
  if (review.status !== 'required') return;
  throw workflowError(
    SYSTEM_DOCUMENT_DISPOSITION_REQUIRED,
    'Confirm, update, or explicitly defer each affected contract and design explanation; an exact Central Grant can skip these document obligations.',
    ExitCode.guard,
    {
      details: {
        ...review,
        reviewCommand: `pnpm workflow documents review ${sessionId} --json`,
      },
    },
  );
}

/** Called only by the registered Grant transition; its terminal receipt validates consumption. */
export function recordSystemDocumentGrantException(
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

export function observeSystemDocumentCandidate(cwd: string, sessionId: string) {
  const { git, session, runtime, config } = loadActiveSessionContext(
    cwd,
    sessionId,
  );
  if (
    path.resolve(session.repositoryRoot) !== path.resolve(git.repositoryRoot) ||
    session.baseline.head !== git.head ||
    session.branch !== git.branch
  )
    throw workflowError(
      'SYSTEM_DOCUMENT_REVIEW_STALE',
      'Read document obligations in the active task worktree at its baseline commit.',
      ExitCode.staleState,
    );
  const before = readSystemDescriptionSnapshot(
    git.repositoryRoot,
    session.baseline.head,
  );
  const after = readSystemDescriptionSnapshot(git.repositoryRoot);
  const documents = collectSystemDocumentObligations(
    before,
    after,
    listChangedPaths(git.repositoryRoot, session.baseline.head),
  );
  const discoveryIssues: string[] = [];
  const specs = documents.some(({ kind }) => kind === 'spec')
    ? [before, after].flatMap((snapshot) => {
        try {
          return systemSpecCatalog(snapshot);
        } catch (error) {
          if (!(error instanceof WorkflowError)) throw error;
          discoveryIssues.push(error.message);
          return [];
        }
      })
    : [];
  const deltaRoot = path.posix.join(
    config.changeRoot,
    session.changeId,
    'specs',
  );
  const boundDocuments: SystemDocumentObligation[] = documents.map(
    (document) => {
      if (document.kind !== 'spec') return document;
      const aliases = [
        ...new Set(
          specs
            .filter(({ path }) => path === document.path)
            .flatMap(({ aliases }) => aliases),
        ),
      ];
      const deltas = aliases
        .flatMap((alias) => {
          const deltaPath = path.posix.join(deltaRoot, alias, 'spec.md');
          const delta = after.readText(deltaPath);
          if (delta === undefined) return [];
          return [{ path: deltaPath, digest: sourceDigest(delta) }];
        })
        .sort((a, b) => a.path.localeCompare(b.path));
      let deltaChangesContract = false;
      if (deltas.length) {
        try {
          deltaChangesContract = specDeltaChangesContract(
            document.path,
            before.readText(document.path) ?? '',
            combineOpenSpecDeltas(
              deltas.map(({ path }) => after.readText(path)!),
            ),
          );
        } catch (error) {
          if (!(error instanceof WorkflowError)) throw error;
        }
      }
      return { ...document, deltas, deltaChangesContract };
    },
  );
  const binding = {
    sessionId,
    changeId: session.changeId,
    taskId: session.taskId,
    worktree: git.repositoryRoot,
    branch: git.branch,
    baselineCommit: session.baseline.head,
    fingerprint: fingerprintRepositoryProjection(
      git.repositoryRoot,
      session.baseline.head,
      git.statusEntries,
    ),
    documents: boundDocuments,
    discoveryIssues,
  };
  return {
    ...binding,
    candidateDigest: grantSha256(canonicalJson(binding)),
    runtimeRoot: runtime.root,
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

function verifiedGrant(
  runtimeRoot: string,
  reportId: string,
  candidateDigest: string,
  value: unknown,
): boolean {
  if (!isRecord(value) || typeof value.challengeId !== 'string') return false;
  try {
    const record = readGrantRecord(
      grantStorePaths(runtimeRoot),
      value.challengeId,
    );
    if (record.state !== 'completed') return false;
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

function reviewInvalid(message: string, details?: Record<string, unknown>) {
  return workflowError(
    'SYSTEM_DOCUMENT_REVIEW_INVALID',
    message,
    ExitCode.guard,
    details === undefined ? {} : { details },
  );
}
