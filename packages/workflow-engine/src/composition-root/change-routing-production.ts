/**
 * Binds route review and admission operations to production authority and
 * continuation ports.
 *
 * Invariants:
 * - Prepare and apply wrappers supply both the current-authority and
 *   continuation-Grant ports.
 */
export { applyManagedChangeRoutingReview } from './change-routing-transaction-production.ts';

import {
  applyChangeRoutingReview as applyChangeRoutingReviewKernel,
  assertChangeRoutingAdmission as assertChangeRoutingAdmissionKernel,
  inspectChangeRouting as inspectChangeRoutingKernel,
  prepareChangeRoutingReview as prepareChangeRoutingReviewKernel,
} from '../modules/lifecycle/change-routing.ts';
import { productionChangeRoutingAuthorityPort } from './validated-contract-context.ts';
import { productionChangeRoutingContinuationGrantPort } from './change-routing-grant-production.ts';
import { parseRepositoryConsumerConfiguration } from '../modules/repository-consumer/repository-consumer-config.ts';

export const parseCommittedRepositoryConsumerConfiguration = (value: unknown) =>
  parseRepositoryConsumerConfiguration(value);

export const prepareChangeRoutingReview = (
  repositoryRoot: string,
  rawIntent: unknown,
) =>
  prepareChangeRoutingReviewKernel(
    repositoryRoot,
    rawIntent,
    productionChangeRoutingAuthorityPort,
    productionChangeRoutingContinuationGrantPort,
  );

export const applyChangeRoutingReview = (
  repositoryRoot: string,
  rawReview: unknown,
) =>
  applyChangeRoutingReviewKernel(
    repositoryRoot,
    rawReview,
    productionChangeRoutingAuthorityPort,
    productionChangeRoutingContinuationGrantPort,
  );

export const inspectChangeRouting = (repositoryRoot: string) =>
  inspectChangeRoutingKernel(
    repositoryRoot,
    productionChangeRoutingAuthorityPort,
  );

export const assertChangeRoutingAdmission = (
  repositoryRoot: string,
  requestedChangeId: string,
) =>
  assertChangeRoutingAdmissionKernel(
    repositoryRoot,
    requestedChangeId,
    productionChangeRoutingAuthorityPort,
  );

export {
  changeRoutingReportRoot,
  parseChangeRoutingReport,
} from '../modules/lifecycle/change-routing-transaction.ts';
export {
  changeLifecycleRelativePath,
  parseChangeLifecycleSource,
} from '../modules/lifecycle/change-routing.ts';
