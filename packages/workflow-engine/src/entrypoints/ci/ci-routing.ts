/**
 * Verifies routing commits and their canonical report and lifecycle-source
 * bindings.
 *
 * Invariants:
 * - A route commit changes exactly the handoff, lifecycle source and review
 *   report, with the report bound to its parent.
 */
import crypto from 'node:crypto';

import { canonicalJson } from '@jigwright/core/canonical-json';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  changeRoutingReportRoot,
  parseCommittedRepositoryConsumerConfiguration,
  parseChangeRoutingReport,
  changeLifecycleRelativePath,
  parseChangeLifecycleSource,
} from '../../composition-root/change-routing-production.ts';
import {
  listCommitPaths,
  readFileAtCommit,
  treeAtCommit,
  type RangeCommit,
} from './ci-git.ts';

const HANDOFF_PATH = 'docs/CURRENT_AND_NEXT_STEPS.md';

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

function digestBytes(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function routeReportInvalid() {
  return routeInvalid(
    'CI_CHANGE_ROUTING_REPORT_INVALID',
    'The route commit report is missing, malformed, non-canonical, or does not bind the committed projection.',
  );
}

function routeInvalid(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}
