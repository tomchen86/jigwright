import type { ExecutionEpochStore } from '../modules/authority/execution-governance-epoch-port.ts';
import {
  initializeDurableEpochContextStore,
  inspectDurableEpochContextStore,
  rolloverDurableEpochContextStore,
} from '../runtime/storage-journal/execution-governance-epoch-store.ts';
import { inspectDurableRetentionCatalog } from '../runtime/storage-journal/execution-governance-evidence-store.ts';
/** Bind the required epoch operations to the durable filesystem implementation. */
export const executionEpochStore = {
  initializeDurableEpochContextStore,
  inspectDurableEpochContextStore,
  rolloverDurableEpochContextStore,
  inspectDurableRetentionCatalog,
} satisfies ExecutionEpochStore;
