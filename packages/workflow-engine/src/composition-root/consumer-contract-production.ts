import { parsePlanReviewArtifact } from './plan-review-artifact-production.ts';
/** Bind low-level contract observations to full current Work Registry admission. */
import { createChangeContractReaders } from '../runtime/repository-validation/change-contract-reader.ts';
import { workRegistryQueries } from './work-registry-read-production.ts';
export const { loadChangeContract, loadCommittedChangeContract } =
  createChangeContractReaders(
    workRegistryQueries.readCurrentChangeOrigin,
    parsePlanReviewArtifact,
  );
