import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '@jigwright/core/canonical-json';
import { isRecord } from '@jigwright/core/contract-values';

import { renderHandoff } from '../adapters/consumer/repository/handoff/handoff.ts';
import {
  loadWorkflowConfig,
  repositoryHandoffRelativePath,
} from '../adapters/consumer/repository/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import {
  applyChangeRoutingReviewUnderLifecycleLock,
  changeLifecycleRelativePath,
  parseChangeRoutingReview,
  type ChangeRoutingReview,
} from '../modules/lifecycle/change-routing.ts';
import {
  changeRoutingReportRoot,
  changeRoutingReviewDigest,
  createChangeRoutingReport,
  type ManagedChangeRoutingResult,
} from '../modules/lifecycle/change-routing-transaction.ts';
import { replaceTextAtomic } from '../runtime/repository-transaction/atomic-text.ts';
import {
  discoverRepository,
  listChangedPaths,
  runGit,
} from '../runtime/repository-transaction/git.ts';
import {
  createRouteCommitObject,
  listStagedPaths,
  stageExactPaths,
  updateManagedRef,
} from '../runtime/repository-transaction/git-transitions.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../runtime/session-workspace/session-store.ts';
import { productionChangeRoutingAuthorityPort } from './validated-contract-context.ts';
import { productionChangeRoutingContinuationGrantPort } from './change-routing-grant-production.ts';

type RouteJournal = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright.change-routing-transaction.v1';
  phase: 'prepared' | 'staged' | 'commit-created' | 'completed';
  reviewDigest: string;
  baselineHead: string;
  baselineTree: string;
  reportPath: string;
  expectedPaths: readonly string[];
  tree: string | null;
  commitHash: string | null;
}>;

export function applyManagedChangeRoutingReview(
  repositoryRoot: string,
  rawReview: unknown,
  options: Readonly<{ crashAfterCommitObject?: boolean }> = {},
): ManagedChangeRoutingResult {
  const review = parseChangeRoutingReview(rawReview);
  const initial = discoverRepository(repositoryRoot);
  const config = loadWorkflowConfig(initial.repositoryRoot);
  const runtime = runtimePaths(
    initial.gitCommonDirectory,
    config.runtimeDirectory,
  );
  return withRepositoryLifecycleOperation(runtime, () =>
    applyManagedChangeRoutingReviewLocked(
      initial.repositoryRoot,
      runtime.root,
      review,
      options,
    ),
  );
}

function applyManagedChangeRoutingReviewLocked(
  repositoryRoot: string,
  runtimeRoot: string,
  review: ChangeRoutingReview,
  options: Readonly<{ crashAfterCommitObject?: boolean }>,
): ManagedChangeRoutingResult {
  const reviewDigest = changeRoutingReviewDigest(review);
  const reportPath = `${changeRoutingReportRoot}/${reviewDigest}.json`;
  const handoffPath = repositoryHandoffRelativePath(repositoryRoot);
  const expectedPaths = Object.freeze(
    [handoffPath, changeLifecycleRelativePath, reportPath].sort(),
  );
  const journalPath = routeJournalPath(runtimeRoot, reviewDigest);
  let journal = readOptionalRouteJournal(journalPath);
  let replayed = journal !== null;

  if (journal === null) {
    const git = discoverRepository(repositoryRoot);
    if (git.statusEntries.length > 0 || git.branch === null) {
      throw workflowError(
        'CHANGE_ROUTING_TREE_NOT_CLEAN',
        'Managed route apply requires one clean attached-branch tree.',
        ExitCode.conflict,
        { details: { statusEntries: git.statusEntries } },
      );
    }
    journal = Object.freeze({
      schemaVersion: 1 as const,
      kind: 'jigwright.change-routing-transaction.v1' as const,
      phase: 'prepared' as const,
      reviewDigest,
      baselineHead: git.head,
      baselineTree: git.tree,
      reportPath,
      expectedPaths,
      tree: null,
      commitHash: null,
    });
    writeRouteJournal(journalPath, journal);
    replayed = false;
  }

  assertJournalMatches(journal, reviewDigest, reportPath, expectedPaths);
  const current = discoverRepository(repositoryRoot);
  if (
    journal.commitHash !== null &&
    current.head === journal.commitHash &&
    journal.phase !== 'completed'
  ) {
    journal = updateJournal(journalPath, journal, { phase: 'completed' });
  }
  if (journal.phase === 'completed') {
    if (
      journal.commitHash === null ||
      current.head !== journal.commitHash ||
      current.statusEntries.length > 0
    ) {
      throw routeRecoveryAmbiguous();
    }
    return managedResult(review, journal, true);
  }
  if (current.head !== journal.baselineHead) {
    throw routeRecoveryAmbiguous();
  }

  if (journal.phase === 'prepared') {
    applyChangeRoutingReviewUnderLifecycleLock(
      repositoryRoot,
      review,
      productionChangeRoutingAuthorityPort,
      productionChangeRoutingContinuationGrantPort,
    );
    renderHandoff(repositoryRoot, productionChangeRoutingAuthorityPort);
    writeChangeRoutingReport(
      repositoryRoot,
      reportPath,
      createChangeRoutingReport(review, journal, expectedPaths),
    );
    const changedPaths = listChangedPaths(repositoryRoot, journal.baselineHead);
    if (canonicalJson(changedPaths) !== canonicalJson(expectedPaths)) {
      throw workflowError(
        'CHANGE_ROUTING_PROJECTION_SCOPE_CHANGED',
        'Managed route projection changed outside its exact source, handoff, and report paths.',
        ExitCode.staleState,
        { details: { expectedPaths, changedPaths } },
      );
    }
    const staged = stageExactPaths(repositoryRoot, journal.baselineHead, [
      ...expectedPaths,
    ]);
    journal = updateJournal(journalPath, journal, {
      phase: 'staged',
      tree: staged.tree,
    });
  }

  if (journal.phase === 'staged') {
    if (
      journal.tree === null ||
      runGit(repositoryRoot, ['write-tree']).trim() !== journal.tree ||
      canonicalJson(listStagedPaths(repositoryRoot, journal.baselineHead)) !==
        canonicalJson(expectedPaths)
    ) {
      throw routeRecoveryAmbiguous();
    }
    const commitHash = createRouteCommitObject(
      repositoryRoot,
      journal.tree,
      journal.baselineHead,
      reviewDigest,
    );
    journal = updateJournal(journalPath, journal, {
      phase: 'commit-created',
      commitHash,
    });
    if (options.crashAfterCommitObject === true) {
      throw new Error('simulated route crash after commit object');
    }
  }

  if (journal.phase === 'commit-created') {
    if (journal.commitHash === null || journal.tree === null) {
      throw routeRecoveryAmbiguous();
    }
    updateManagedRef(repositoryRoot, journal.baselineHead, journal.commitHash);
    journal = updateJournal(journalPath, journal, { phase: 'completed' });
  }

  return managedResult(review, journal, replayed);
}

function writeChangeRoutingReport(
  repositoryRoot: string,
  reportPath: string,
  report: ReturnType<typeof createChangeRoutingReport>,
): void {
  const absolutePath = path.join(repositoryRoot, reportPath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  replaceTextAtomic(absolutePath, `${JSON.stringify(report, null, 2)}\n`, {
    allowCreate: true,
    defaultMode: 0o644,
  });
}

function routeJournalPath(runtimeRoot: string, reviewDigest: string): string {
  return path.join(
    runtimeRoot,
    'change-routing',
    'transactions',
    `${reviewDigest}.json`,
  );
}

function readOptionalRouteJournal(filePath: string): RouteJournal | null {
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw routeRecoveryAmbiguous();
  }
  try {
    return parseRouteJournal(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    throw routeRecoveryAmbiguous();
  }
}

function parseRouteJournal(value: unknown): RouteJournal {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join('\0') !==
      'baselineHead\0baselineTree\0commitHash\0expectedPaths\0kind\0phase\0reportPath\0reviewDigest\0schemaVersion\0tree' ||
    value.schemaVersion !== 1 ||
    value.kind !== 'jigwright.change-routing-transaction.v1' ||
    !['prepared', 'staged', 'commit-created', 'completed'].includes(
      String(value.phase),
    ) ||
    typeof value.reviewDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.reviewDigest) ||
    typeof value.baselineHead !== 'string' ||
    typeof value.baselineTree !== 'string' ||
    typeof value.reportPath !== 'string' ||
    !Array.isArray(value.expectedPaths) ||
    !value.expectedPaths.every((entry) => typeof entry === 'string') ||
    (value.tree !== null && typeof value.tree !== 'string') ||
    (value.commitHash !== null && typeof value.commitHash !== 'string')
  ) {
    throw routeRecoveryAmbiguous();
  }
  return Object.freeze(value as unknown as RouteJournal);
}

function writeRouteJournal(filePath: string, journal: RouteJournal): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  replaceTextAtomic(filePath, `${canonicalJson(journal)}\n`, {
    allowCreate: true,
    defaultMode: 0o600,
  });
}

function updateJournal(
  filePath: string,
  journal: RouteJournal,
  patch: Partial<RouteJournal>,
): RouteJournal {
  const next = Object.freeze({ ...journal, ...patch });
  writeRouteJournal(filePath, next);
  return next;
}

function assertJournalMatches(
  journal: RouteJournal,
  reviewDigest: string,
  reportPath: string,
  expectedPaths: readonly string[],
): void {
  if (
    journal.reviewDigest !== reviewDigest ||
    journal.reportPath !== reportPath ||
    canonicalJson(journal.expectedPaths) !== canonicalJson(expectedPaths)
  ) {
    throw routeRecoveryAmbiguous();
  }
}

function managedResult(
  review: ChangeRoutingReview,
  journal: RouteJournal,
  replayed: boolean,
): ManagedChangeRoutingResult {
  if (journal.commitHash === null || journal.phase !== 'completed') {
    throw routeRecoveryAmbiguous();
  }
  return Object.freeze({
    sourceDigest: review.nextSourceDigest,
    reviewDigest: journal.reviewDigest,
    reportPath: journal.reportPath,
    commitHash: journal.commitHash,
    replayed,
  });
}

function routeRecoveryAmbiguous() {
  return workflowError(
    'CHANGE_ROUTING_RECOVERY_AMBIGUOUS',
    'The managed route transaction no longer matches its exact baseline, index, or commit.',
    ExitCode.staleState,
  );
}
