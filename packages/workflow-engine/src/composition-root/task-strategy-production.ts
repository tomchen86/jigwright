import { taskMandateOperations } from './task-mandate-production.ts';
import { reviewedGeneratedAssets } from './planning-provider-authoring-production.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
import {
  beginTaskStrategyRedRevision,
  continueTaskStrategyRedRevision,
} from './task-strategy-red-revision-production.ts';
/** Binds task-strategy retry observations at the production boundary. */
import { createTaskStrategyImplementationLifecycle } from '../application/execute-task/task-strategy-implementation-lifecycle.ts';
import { roleResultAdmission } from './role-admission-production.ts';
import { resumeTaskStrategy as resume } from '../application/execute-task/task-strategy-lifecycle.ts';
import { readProviderRetryAccountingEvidence } from '../runtime/storage-journal/provider-retry-accounting-reader.ts';

const implementation = createTaskStrategyImplementationLifecycle(
  productionChangeContract,
  roleResultAdmission,
  taskMandateOperations,
);
export const beginTaskStrategyImplementation =
  implementation.beginTaskStrategyImplementation.bind(
    undefined,
    readProviderRetryAccountingEvidence,
  );
export const resumeTaskStrategy = resume.bind(
  undefined,
  reviewedGeneratedAssets,
  productionChangeContract,
  implementation,
  { beginTaskStrategyRedRevision, continueTaskStrategyRedRevision },
  readProviderRetryAccountingEvidence,
);
export const {
  inspectTaskStrategyImplementation,
  assertTaskStrategyImplementationProviderOwnerCurrent,
} = implementation;

export type * from '../application/execute-task/task-strategy-implementation-lifecycle.ts';
export type * from '../application/execute-task/task-strategy-lifecycle.ts';

import { inspectTaskStrategyLifecycle as inspectTaskStrategyLifecycleWithRouting } from '../application/execute-task/task-strategy-lifecycle.ts';
export const inspectTaskStrategyLifecycle =
  inspectTaskStrategyLifecycleWithRouting.bind(
    undefined,
    reviewedGeneratedAssets,
    productionChangeContract,
  );
