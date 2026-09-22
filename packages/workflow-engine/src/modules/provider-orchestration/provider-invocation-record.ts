/**
 * Defines invocation identity, lease, and failure facts consumed by execution policy.
 *
 * Invariants:
 * - Field names and optional receipt/failure fields preserve the persisted wire shape.
 */
import type { TaskMandateBinding } from '../authority/task-mandate-contract.ts';
import type {
  ExecutionFailureKind,
  ReadOnlyProbeRequest,
} from './execution-record-types.ts';
import type { ProviderProcessResult } from './provider-contracts.ts';
import type {
  AgentRuntimeCompletionReceipt,
  AgentRuntimeHostExecutionBindingV1,
  AgentRuntimeProcessProgressProjection,
  ProviderInvocationAcceptanceBinding,
  ProviderRuntimeProtocolReceipt,
} from './agent-runtime-port.ts';
import type {
  RepairKind,
  StructuredValidationError,
} from '../authority/execution-governance-repair.ts';
import type { JsonValue } from '../authority/execution-governance-values.ts';
import type { ProviderId, CapabilityPurpose } from './provider-registry.ts';

export type ProviderInvocationFailure = {
  kind: 'retryable' | 'repository-reconciliation-required';
  code: string;
  message: string;
  executionKind?: ExecutionFailureKind;
  retryAfterMs?: number;
  probe?: Readonly<ReadOnlyProbeRequest>;
};

export type ProviderRepairFailureInput = Readonly<{
  repairKind: RepairKind;
  previousOutput: JsonValue;
  validationErrors: StructuredValidationError[];
  targetSchema: JsonValue;
}>;

export type ProviderInvocationFailureInput = {
  expectedRevision: number;
  leaseGeneration: number;
  leaseToken: string;
  failure: ProviderInvocationFailure;
  runtimeEvidence?: Readonly<{
    acceptanceBinding: ProviderInvocationAcceptanceBinding;
    progress: AgentRuntimeProcessProgressProjection;
    protocolReceipt?: ProviderRuntimeProtocolReceipt;
    hostExecutionBinding?: AgentRuntimeHostExecutionBindingV1;
  }>;
  repair?: ProviderRepairFailureInput;
  now?: string;
};

export type ProviderInvocationLease = {
  generation: number;
  workerId: string;
  tokenDigest: string;
  acquiredAt: string;
  expiresAt: string;
};

export type ProviderInvocationRecord = {
  schemaVersion: 1;
  invocationId: string;
  investigationId: string;
  changeId: string;
  mandateBinding?: TaskMandateBinding;
  attempt: number;
  revision: number;
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  providerId: ProviderId;
  purpose: CapabilityPurpose;
  requestDigest: string;
  manifestDigest: string;
  leaseGeneration: number;
  lease: ProviderInvocationLease | null;
  result: ProviderProcessResult | null;
  failure: ProviderInvocationFailure | null;
  /** Absent on historical and synchronous single-shot invocation records. */
  runtimeReceipt?: AgentRuntimeCompletionReceipt;
  createdAt: string;
  updatedAt: string;
};
