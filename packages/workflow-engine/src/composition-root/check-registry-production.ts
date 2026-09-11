/**
 * Selects the tracked repository check registry for production consumers.
 *
 * Invariants:
 * - The exported production port is the same object as the workflow check
 *   registry adapter.
 */
import { workflowCheckRegistryPort } from '../adapters/consumer/repository/work-registry/check-registry-adapter.ts';

/** Production CheckRegistry composition for the tracked repository contract. */
export const productionCheckRegistryPort = workflowCheckRegistryPort;
