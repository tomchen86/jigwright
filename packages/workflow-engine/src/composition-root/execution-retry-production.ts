import { taskMandateOperations } from './task-mandate-production.ts';
/** Binds retry previews, requests and publication to production proposal and accounting capabilities. */
import { productionProposeOperations } from './propose-production.ts';
import { readProviderRetryAccountingEvidence } from '../runtime/storage-journal/provider-retry-accounting-reader.ts';
import {
  previewExecutionJobRetry as previewJob,
  requestExecutionJobRetry as requestJob,
} from '../application/control-plane/execution-job-retry.ts';
import {
  previewExecutionReplacementRequest as previewReplacement,
  requestExecutionReplacement as requestReplacement,
  executeGrantedReplacement as executeReplacement,
} from '../application/control-plane/execution-replacement.ts';

const dependencies = {
  taskMandate: taskMandateOperations,
  ...productionProposeOperations,
  readProviderRetryAccountingEvidence,
};
export const previewExecutionJobRetry = previewJob.bind(
  undefined,
  dependencies,
);
export const requestExecutionJobRetry = requestJob.bind(
  undefined,
  dependencies,
);
export const previewExecutionReplacementRequest = previewReplacement.bind(
  undefined,
  dependencies,
);
export const requestExecutionReplacement = requestReplacement.bind(
  undefined,
  dependencies,
);
export const executeGrantedReplacement = executeReplacement.bind(
  undefined,
  dependencies,
);
export {
  listExecutionReplacementGrantRequestDigests,
  SimulatedExecutionReplacementCrash,
} from '../application/control-plane/execution-replacement.ts';
export type * from '../application/control-plane/execution-replacement.ts';
