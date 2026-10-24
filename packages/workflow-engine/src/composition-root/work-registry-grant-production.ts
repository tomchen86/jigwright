/** Binds protected registry transitions to the same production reads and durable writer. */
import { createWorkRegistryGrantService } from '../application/work-registry/work-registry-grant.ts';
import * as registry from './work-registry-production.ts';
export const {
  createWorkRegistryReviewGrantRequest,
  createWorkRegistryPromotionGrantRequest,
  workRegistryGrantTransitionDefinitions,
} = createWorkRegistryGrantService(registry);
