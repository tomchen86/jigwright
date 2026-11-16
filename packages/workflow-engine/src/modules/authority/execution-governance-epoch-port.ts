import type { ContextManifest } from './execution-governance-context.ts';
import type {
  WorkflowContextState,
  EpochCarryForwardDecision,
  EpochTransitionVerification,
} from './execution-governance-context.ts';
import type { RetentionPolicy } from './execution-governance-retention.ts';
import type {
  DurableEpochContextState,
  DurableRetentionCatalog,
} from './execution-governance-store-contracts.ts';
/** Current durable epoch operations supplied by production composition. */
export type ExecutionEpochStore = {
  initializeDurableEpochContextStore: (
    storeRoot: string,
    input: {
      workflow: WorkflowContextState;
      manifest: ContextManifest;
      items: {
        identity: string;
        content: string;
      }[];
      now: Date;
    },
  ) => DurableEpochContextState;
  inspectDurableEpochContextStore: (
    storeRoot: string,
    workflowId: string,
  ) => DurableEpochContextState;
  rolloverDurableEpochContextStore: (
    storeRoot: string,
    input: {
      workflowId: string;
      expectedGeneration: number;
      expectedEpoch: number;
      expectedContextDigest: string;
      nextManifest: ContextManifest;
      items: {
        identity: string;
        content: string;
      }[];
      reason: string;
      restartFrom: string;
      carriedForward: string[];
      carryForwardManifest: {
        sourceWorkflow: string;
        sourceEpoch: number;
        carriedForward: EpochCarryForwardDecision[];
        excluded: EpochCarryForwardDecision[];
      };
      invalidated: string[];
      verification: EpochTransitionVerification | null;
      createdAt: Date;
      policy?: RetentionPolicy;
    },
  ) => DurableEpochContextState;
  inspectDurableRetentionCatalog: (
    storeRoot: string,
    workflowId: string,
  ) => DurableRetentionCatalog;
};
