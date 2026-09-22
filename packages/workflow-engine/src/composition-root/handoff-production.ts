import { productionChangeRoutingInspector } from './change-routing-observation-production.ts';
import { loadChangeContract } from './consumer-contract-production.ts';
import {
  projectHandoff,
  projectHandoffForTaskProjection,
  renderHandoff,
  renderHandoffForChange,
  renderHandoffFromTrackedFacts as renderTracked,
  validateHandoff,
  validateHandoffForChange,
} from '../adapters/consumer/repository/handoff/handoff.ts';
import type { HandoffDocumentOperations } from '../modules/projection/handoff.ts';

/** Bind operations without observing repository state until each invocation. */
export const handoffDocuments = {
  projectHandoff: projectHandoff.bind(
    undefined,
    productionChangeRoutingInspector,
    loadChangeContract,
  ),
  projectHandoffForTaskProjection: projectHandoffForTaskProjection.bind(
    undefined,
    productionChangeRoutingInspector,
    loadChangeContract,
  ),
  renderHandoff: renderHandoff.bind(
    undefined,
    productionChangeRoutingInspector,
    loadChangeContract,
  ),
  renderHandoffForChange: renderHandoffForChange.bind(
    undefined,
    productionChangeRoutingInspector,
    loadChangeContract,
  ),
  validateHandoff: validateHandoff.bind(
    undefined,
    productionChangeRoutingInspector,
    loadChangeContract,
  ),
  validateHandoffForChange: validateHandoffForChange.bind(
    undefined,
    productionChangeRoutingInspector,
    loadChangeContract,
  ),
} satisfies HandoffDocumentOperations;

/** Bind live observation while preserving each per-directory read. */
export const renderHandoffFromTrackedFacts = renderTracked.bind(
  undefined,
  productionChangeRoutingInspector,
  loadChangeContract,
);
