import { productionChangeRoutingInspector } from './change-routing-observation-production.ts';
import { loadChangeContract } from './consumer-contract-production.ts';
import { renderHandoffFromTrackedFacts as renderTracked } from '../adapters/consumer/repository/handoff/handoff.ts';

/** Bind live observation while preserving each per-directory read. */
export const renderHandoffFromTrackedFacts = renderTracked.bind(undefined, productionChangeRoutingInspector, loadChangeContract);
