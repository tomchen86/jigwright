/** Immutable commit replay operations; caller-owned semantic services are required. */
import { canonicalJson } from '@jigwright/core/canonical-json';
import { changeRoutingReportRoot } from '../../../modules/lifecycle/change-routing-transaction.ts';
import { parseRepositoryConsumerConfiguration as parseCommittedRepositoryConsumerConfiguration } from '../../../modules/repository-consumer/repository-consumer-policy.ts';
import { parseChangeRoutingReport } from '../../../modules/lifecycle/change-routing-transaction.ts';
import { changeLifecycleRelativePath } from '../../../modules/lifecycle/change-routing.ts';
import { parseChangeLifecycleSource } from '../../../modules/lifecycle/change-routing.ts';
import { listCommitPaths } from './ci-git.ts';
import { readFileAtCommit } from '../../repository-transaction/git-command.ts';
import { treeAtCommit } from './ci-git.ts';
import type { RangeCommit } from '../../../modules/assurance/commit-replay/ci-git.ts';
import { HANDOFF_PATH } from '../../../modules/assurance/commit-replay/ci-routing.ts';
import { digestBytes } from '../../../modules/assurance/commit-replay/ci-routing.ts';
import { routeReportInvalid } from '../../../modules/assurance/commit-replay/ci-routing.ts';
import { routeInvalid } from '../../../modules/assurance/commit-replay/ci-routing.ts';

export function validateCiRouteCommit(
  repositoryRoot: string,
  commit: RangeCommit & {
    trailers: Extract<NonNullable<RangeCommit['trailers']>, { kind: 'route' }>;
  },
): void {
  const reportPath = `${changeRoutingReportRoot}/${commit.trailers.routingReview}.json`;
  const expectedPaths = [
    committedHandoffPath(repositoryRoot, commit.hash),
    changeLifecycleRelativePath,
    reportPath,
  ].sort();
  const changedPaths = listCommitPaths(repositoryRoot, commit).sort();
  if (canonicalJson(changedPaths) !== canonicalJson(expectedPaths)) {
    throw routeInvalid(
      'CI_CHANGE_ROUTING_SCOPE_INVALID',
      'A route commit must change exactly the controlled source, handoff, and digest-addressed report.',
    );
  }
  const reportBytes = readFileAtCommit(repositoryRoot, commit.hash, reportPath);
  if (reportBytes === undefined) throw routeReportInvalid();
  let reportValue: unknown;
  try {
    reportValue = JSON.parse(reportBytes) as unknown;
  } catch {
    throw routeReportInvalid();
  }
  const report = parseChangeRoutingReport(reportValue);
  if (
    reportBytes !== `${JSON.stringify(report, null, 2)}\n` ||
    report.reviewDigest !== commit.trailers.routingReview ||
    report.expectedParent !== commit.parents[0] ||
    canonicalJson(report.changedPaths) !== canonicalJson(expectedPaths) ||
    report.expectedParentTree !==
      treeAtCommit(repositoryRoot, commit.parents[0]!)
  ) {
    throw routeReportInvalid();
  }
  const sourceBytes = readFileAtCommit(
    repositoryRoot,
    commit.hash,
    changeLifecycleRelativePath,
  );
  if (sourceBytes === undefined) throw routeReportInvalid();
  let sourceValue: unknown;
  try {
    sourceValue = JSON.parse(sourceBytes) as unknown;
  } catch {
    throw routeReportInvalid();
  }
  const source = parseChangeLifecycleSource(sourceValue);
  if (
    sourceBytes !== `${JSON.stringify(source, null, 2)}\n` ||
    digestBytes(sourceBytes) !== report.nextSourceDigest
  ) {
    throw routeReportInvalid();
  }
  const parentSource = readFileAtCommit(
    repositoryRoot,
    commit.parents[0]!,
    changeLifecycleRelativePath,
  );
  const expectedParentSourceDigest =
    parentSource === undefined ? null : digestBytes(parentSource);
  if (expectedParentSourceDigest !== report.review.expectedSourceDigest) {
    throw routeInvalid(
      'CI_CHANGE_ROUTING_CAS_INVALID',
      'The route review does not bind the exact parent lifecycle source.',
    );
  }
}

function committedHandoffPath(repositoryRoot: string, commit: string): string {
  const bytes = readFileAtCommit(
    repositoryRoot,
    commit,
    'workflow/repository-consumer.json',
  );
  if (bytes === undefined) return HANDOFF_PATH;
  try {
    return parseCommittedRepositoryConsumerConfiguration(JSON.parse(bytes))
      .documents.handoffPath;
  } catch {
    throw routeReportInvalid();
  }
}
