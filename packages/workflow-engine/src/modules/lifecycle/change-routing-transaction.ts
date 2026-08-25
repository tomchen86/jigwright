import crypto from 'node:crypto';

import { canonicalJson } from '@jigwright/core/canonical-json';
import { isRecord } from '@jigwright/core/contract-values';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  parseChangeRoutingReview,
  type ChangeRoutingReview,
} from './change-routing.ts';

export const changeRoutingReportRoot = 'workflow/change-routing-reports';

export type ChangeRoutingReport = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright.change-routing-report.v1';
  reviewDigest: string;
  expectedParent: string;
  expectedParentTree: string;
  nextSourceDigest: string;
  changedPaths: readonly string[];
  review: ChangeRoutingReview;
}>;

export type ManagedChangeRoutingResult = Readonly<{
  sourceDigest: string;
  reviewDigest: string;
  reportPath: string;
  commitHash: string;
  replayed: boolean;
}>;

export function changeRoutingReviewDigest(review: ChangeRoutingReview): string {
  return crypto
    .createHash('sha256')
    .update(canonicalJson(review))
    .digest('hex');
}

export function createChangeRoutingReport(
  review: ChangeRoutingReview,
  baseline: Readonly<{ baselineHead: string; baselineTree: string }>,
  changedPaths: readonly string[],
): ChangeRoutingReport {
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'jigwright.change-routing-report.v1' as const,
    reviewDigest: changeRoutingReviewDigest(review),
    expectedParent: baseline.baselineHead,
    expectedParentTree: baseline.baselineTree,
    nextSourceDigest: review.nextSourceDigest,
    changedPaths: Object.freeze([...changedPaths]),
    review,
  });
}

export function parseChangeRoutingReport(value: unknown): ChangeRoutingReport {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join('\0') !==
      'changedPaths\0expectedParent\0expectedParentTree\0kind\0nextSourceDigest\0review\0reviewDigest\0schemaVersion' ||
    value.schemaVersion !== 1 ||
    value.kind !== 'jigwright.change-routing-report.v1' ||
    typeof value.reviewDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.reviewDigest) ||
    typeof value.expectedParent !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.expectedParent) ||
    typeof value.expectedParentTree !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.expectedParentTree) ||
    typeof value.nextSourceDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.nextSourceDigest) ||
    !Array.isArray(value.changedPaths) ||
    !value.changedPaths.every((entry) => typeof entry === 'string')
  ) {
    throw reportInvalid();
  }
  const review = parseChangeRoutingReview(value.review);
  if (
    changeRoutingReviewDigest(review) !== value.reviewDigest ||
    review.nextSourceDigest !== value.nextSourceDigest
  ) {
    throw reportInvalid();
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'jigwright.change-routing-report.v1' as const,
    reviewDigest: value.reviewDigest,
    expectedParent: value.expectedParent,
    expectedParentTree: value.expectedParentTree,
    nextSourceDigest: value.nextSourceDigest,
    changedPaths: Object.freeze([...value.changedPaths]),
    review,
  });
}

function reportInvalid() {
  return workflowError(
    'CHANGE_ROUTING_REPORT_INVALID',
    'The tracked change-routing report is malformed or does not bind its exact review.',
    ExitCode.verification,
  );
}
