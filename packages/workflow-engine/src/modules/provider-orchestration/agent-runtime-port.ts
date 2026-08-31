import type { ContextManifest } from '../lifecycle/context-manifest-contract.ts';
import type {
  ProviderInvocationRequest,
  ProviderOutputValidator,
  ProviderRunnerReport,
} from './provider-contracts.ts';
import type { ProviderId } from './provider-registry.ts';
import type {
  HostWrapperProviderProfileSnapshot,
  ProviderWrapperSessionProtocolBinding,
} from '@jigwright/agent-runtime';
import type {
  ProviderWrapperProtocolDeclaration,
  ProviderRuntimeProtocolReceipt,
} from './agent-runtime-protocol.ts';
import type { AgentRuntimeAssignmentBindingV1 } from './agent-runtime-assignment-binding.ts';
import type {
  AgentRuntimeHostExecutionBindingV1,
  AgentRuntimeHostProbeEvidenceV1,
} from './agent-runtime-host-execution-binding.ts';
import type {
  ProviderNativeSessionClaimV1,
  ProviderNativeSessionCompletionTerminalV1,
} from './provider-native-session.ts';

export type {
  ProviderRuntimeProtocolReceipt,
  ProviderWrapperProtocolReceipt,
} from './agent-runtime-protocol.ts';
export type { AgentRuntimeAssignmentBindingV1 } from './agent-runtime-assignment-binding.ts';
export type {
  AgentRuntimeHostExecutionBindingV1,
  AgentRuntimeHostProbeEvidenceV1,
} from './agent-runtime-host-execution-binding.ts';

/** JSON data accepted as one exact provider's semantic-output schema. */
export type AgentRuntimeJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentRuntimeJsonValue[]
  | { readonly [key: string]: AgentRuntimeJsonValue | undefined };

/**
 * One engine-owned input whose exact file or directory closure participates in
 * the pre/post provider projection comparison.
 */
export type AgentRuntimeGovernedInput =
  | { id: string; path: string; kind?: 'file' }
  | {
      id: string;
      path: string;
      kind: 'directory-closure';
      expectedFiles: string[];
      mutableContentPaths: string[];
    };

/** The durable prompt-context identity bound to one accepted provider result. */
export type ProviderPromptContextBinding = Readonly<{
  ownerWorkflowId: string;
  purpose: ProviderInvocationRequest['purpose'];
  workflowId: string;
  generation: number;
  epoch: number;
  contextDigest: string;
  manifest: ContextManifest;
}>;

/** The repair lineage/evidence identity bound to one accepted provider result. */
export type ProviderRepairAuthorityBinding = Readonly<{
  invocationId: string;
  lineagePath: string;
  lineageDigest: string | null;
  currentEvidencePath: string;
  evidencePath: string | null;
  evidenceDigest: string | null;
}>;

/**
 * The complete plain binding a single-shot runtime must keep governed while it
 * launches a provider. Storage creates and validates this value; the runtime
 * only observes it and binds its projection to the same durable authority.
 */
export type ProviderInvocationAcceptanceBinding = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-acceptance-binding';
  invocationId: string;
  requestDigest: string;
  ownerWorkflowId: string;
  invocationRevision: number;
  leaseGeneration: number;
  context: ProviderPromptContextBinding;
  executionJobId: string;
  executionAttemptId: string;
  executionRevision: number;
  executionStateDigest: string;
  receiptRequirement: 'schema-v4' | 'synchronous-no-activity';
  repair: ProviderRepairAuthorityBinding;
  bindingDigest: string;
}>;

/**
 * Exact durable role-assignment facts projected into the public v1 runtime
 * binding. Native provider session IDs and continuity tokens are deliberately
 * absent; they remain private runtime state.
 */
/** Private durable turn authority carried only by the production composition. */
export type AgentRuntimeNativeSessionTurnControllerV1 = Readonly<{
  profile: HostWrapperProviderProfileSnapshot;
  assignmentBinding: AgentRuntimeAssignmentBindingV1;
  invocationBinding: Readonly<{
    requestDigest: string;
    inputManifestDigest: string;
    targetDigest: string;
    policyDigest: string;
  }>;
  nextAction(): 'start' | 'resume';
  claim(
    input: Readonly<{
      attemptId: string;
      expectedAction: 'start' | 'resume';
    }>,
  ): Readonly<{
    claim: ProviderNativeSessionClaimV1;
    claimDigest: string;
    predecessorCompletionDigest: string | null;
    binding: ProviderWrapperSessionProtocolBinding;
  }>;
  complete(
    input: Readonly<{
      claimDigest: string;
      terminal: ProviderNativeSessionCompletionTerminalV1;
    }>,
  ): Readonly<{ completionDigest: string }>;
}>;

/** Complete input for the current synchronous single-shot compatibility path. */
export type AgentRuntimeSingleShotInput = {
  providerId: ProviderId;
  repositoryRoot: string;
  invocationDirectory: string;
  request: ProviderInvocationRequest;
  semanticOutputSchema: AgentRuntimeJsonValue;
  outputValidator: ProviderOutputValidator;
  governedRuntimeInputs: AgentRuntimeGovernedInput[];
  acceptanceBinding: ProviderInvocationAcceptanceBinding;
  reviewSnapshotRoot: string | null;
  sourceEnvironment: NodeJS.ProcessEnv;
  /** Present only after current v3 assignment composition succeeds. */
  assignmentBinding?: AgentRuntimeAssignmentBindingV1;
  /** Present only for one selected durable host-wrapper native-session slot. */
  nativeSessionTurn?: AgentRuntimeNativeSessionTurnControllerV1;
  /** Adapter-owned opt-in; built-in Codex/Claude inputs intentionally omit it. */
  wrapperProtocol?: ProviderWrapperProtocolDeclaration;
};

/** Code-owned host selection for one synchronous single-shot launch. */
export type AgentRuntimeSingleShotOptions = {
  platform: NodeJS.Platform;
};

export type AgentRuntimeProcessTermination =
  | 'exited'
  | 'timed-out'
  | 'cancelled'
  | 'output-limit'
  | 'spawn-error'
  | 'protocol-error';

/** Process-level liveness/activity only; protocol semantics remain adapter-owned. */
export type AgentRuntimeProcessActivity = Readonly<{
  type: 'spawned' | 'stdout' | 'stderr' | AgentRuntimeProcessTermination;
  elapsedMs: number;
  bytes?: number;
}>;

/** Bounded process-only progress that is safe to retain without transcripts. */
export type AgentRuntimeProcessProgressProjection = Readonly<{
  schemaVersion: 1;
  kind: 'agent-runtime-process-progress';
  processState: 'not-started' | 'running' | AgentRuntimeProcessTermination;
  eventCount: number;
  stdoutBytes: number;
  stderrBytes: number;
  lastProcessActivityElapsedMs: number | null;
  lastProviderActivityElapsedMs: number | null;
}>;

/**
 * Versioned terminal evidence for one async single-shot launch. The receipt is
 * engine-stamped from the leased invocation and its exact Job/Attempt
 * acceptance binding; provider output cannot choose any identity field.
 */
type AgentRuntimeCompletionReceiptFields = Readonly<{
  kind: 'agent-runtime-completion-receipt';
  invocationId: string;
  requestDigest: string;
  leasedRevision: number;
  terminalRevision: number;
  leaseGeneration: number;
  executionJobId: string;
  executionAttemptId: string;
  executionRevision: number;
  executionStateDigest: string;
  acceptanceBindingDigest: string;
  terminalState: 'succeeded' | 'failed';
  launched: true;
  progress: AgentRuntimeProcessProgressProjection;
  receiptDigest: string;
}>;

/** Current exact receipt with full acceptance and optional host authority. */
export type AgentRuntimeCompletionReceiptV4 = Omit<
  AgentRuntimeCompletionReceiptFields,
  'terminalState'
> &
  Readonly<{
    schemaVersion: 4;
    terminalState: 'succeeded' | 'failed';
    terminalDisposition:
      'accepted' | 'failed-before-result' | 'rejected-after-result';
    failureCode: string | null;
    acceptanceBinding: ProviderInvocationAcceptanceBinding;
    protocolReceipt: ProviderRuntimeProtocolReceipt | null;
    hostExecutionBinding: AgentRuntimeHostExecutionBindingV1 | null;
  }>;

export type AgentRuntimeCompletionReceipt = AgentRuntimeCompletionReceiptV4;

/** Additive async controls for the single-shot compatibility launch. */
export type AgentRuntimeAsyncSingleShotOptions = AgentRuntimeSingleShotOptions &
  Readonly<{
    signal?: AbortSignal;
    onActivity?: (event: AgentRuntimeProcessActivity) => void;
    /**
     * Validated aggregate receipt only; never raw wrapper output. Observer
     * failure has no process-control or terminal-classification authority.
     */
    onProtocolReceipt?: (receipt: ProviderRuntimeProtocolReceipt) => void;
    /** Exact validated pre-claim probe evidence for failure retention. */
    onHostProbeEvidence?: (evidence: AgentRuntimeHostProbeEvidenceV1) => void;
    /** Exact public assignment/claim/completion authority; no raw native ID. */
    onHostExecutionBinding?: (
      binding: AgentRuntimeHostExecutionBindingV1,
    ) => void;
  }>;

/** The existing runner report is the single-shot compatibility result. */
export type AgentRuntimeSingleShotReport = ProviderRunnerReport;

/**
 * Core-owned execution port for the landed synchronous provider behavior.
 * The async compatibility method adds process activity/cancellation without
 * claiming protocol-level progress, resumable sessions, or in-flight reattach.
 */
export interface AgentRuntimePort {
  runSingleShot(
    input: AgentRuntimeSingleShotInput,
    options: AgentRuntimeSingleShotOptions,
  ): AgentRuntimeSingleShotReport;
  runSingleShotAsync?(
    input: AgentRuntimeSingleShotInput,
    options: AgentRuntimeAsyncSingleShotOptions,
  ): Promise<AgentRuntimeSingleShotReport>;
}

export type { ProviderRunnerReport } from './provider-contracts.ts';
