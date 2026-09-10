/**
 * Validates provider process results, runtime receipts, and execution
 * observation bindings.
 *
 * Invariants:
 * - Accepted outputs must match the digest of their schema-bound canonical
 *   content.
 */
import crypto from 'node:crypto';

import {
  assertAgentProviderProfileSnapshot,
  assertKnownBuiltInProviderDefinitionSnapshot,
  type HostWrapperProviderProfileSnapshot,
} from '@jigwright/agent-runtime';
import { assertInvocationId } from '@jigwright/core/runtime-path-kernel';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type {
  ProviderInvocationRequest,
  ProviderProcessResult,
  ProviderExecutableIdentity,
  ProviderRunnerReport,
  ProviderRuntimeObservation,
} from './provider-contracts.ts';
import type {
  AgentRuntimeCompletionReceipt,
  AgentRuntimeProcessProgressProjection,
  ProviderInvocationAcceptanceBinding,
} from './agent-runtime-port.ts';
import {
  assertProviderRuntimeProtocolReceiptForNativeSessionClaim,
  assertProviderRuntimeProtocolReceipt,
  type ProviderRuntimeProtocolReceipt,
} from './agent-runtime-protocol.ts';
import {
  assertAgentRuntimeHostExecutionBindingV1,
  isProviderExecutableIdentity,
  providerDefinitionExecutableBindingDigest,
  type AgentRuntimeHostExecutionBindingV1,
} from './agent-runtime-host-execution-binding.ts';

export {
  isProviderExecutableIdentity,
  providerDefinitionExecutableBindingDigest,
} from './agent-runtime-host-execution-binding.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const PREFIXED_DIGEST = /^sha256:[0-9a-f]{64}$/u;

/**
 * The honest residual soft-containment caveats carried by every current real
 * provider observation. Keeping this identity beside the durable validator
 * prevents the execution and storage readers from drifting apart.
 */
export const PROVIDER_RUNNER_RESIDUALS = Object.freeze([
  'SAME_USER_PROCESS_NOT_CONFINED',
  'SUBPROCESS_TREE_NOT_CONFINED',
  'TRANSIENT_WRITE_RESTORE_NOT_DETECTABLE',
  'TRANSIENT_EXECUTABLE_SUBSTITUTION_NOT_DETECTABLE',
  'UNREACHABLE_OBJECT_WRITES_NOT_OBSERVABLE',
  'GLOBAL_FILESYSTEM_IMMUTABILITY_NOT_PROVEN',
  'PROVIDER_INPUT_CONSUMPTION_NOT_OBSERVABLE',
  'STALE_CONCURRENCY_SLOT_PID_REUSE_NOT_DETECTABLE',
]);

export type ProviderRuntimeEvidenceInvalidFactory = () => Error;

export function assertProviderProcessResult(
  request: ProviderInvocationRequest,
  value: unknown,
  outputValidator: Readonly<{ validate(value: unknown): boolean }>,
  invalid: ProviderRuntimeEvidenceInvalidFactory,
): ProviderProcessResult {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'requestDigest',
      'invocationId',
      'purpose',
      'providerId',
      'output',
      'outputDigest',
      'runtimeObservation',
    ]) ||
    value.requestDigest !== request.requestDigest ||
    value.invocationId !== request.invocationId ||
    value.purpose !== request.purpose ||
    value.providerId !== request.providerId ||
    !isDigest(value.outputDigest)
  ) {
    throw invalid();
  }
  const output = deepFreeze(structuredClone(value.output));
  let accepted = false;
  try {
    accepted = outputValidator.validate(output) === true;
  } catch {
    throw invalid();
  }
  if (
    !accepted ||
    value.outputDigest !==
      sha256(
        canonicalJson({
          id: request.outputSchema.id,
          version: request.outputSchema.version,
          output,
        }),
      )
  ) {
    throw invalid();
  }
  const runtimeObservation = assertProviderRuntimeObservation(
    value.runtimeObservation,
    request,
    invalid,
  );
  return deepFreeze(
    structuredClone({ ...value, output, runtimeObservation }),
  ) as ProviderProcessResult;
}

export function assertProviderRuntimeObservation(
  value: unknown,
  request: ProviderInvocationRequest,
  invalid: ProviderRuntimeEvidenceInvalidFactory,
): ProviderRuntimeObservation | null {
  if (value === null) return null;
  const hasProviderDefinitionSnapshot =
    isRecord(value) && value.providerDefinitionSnapshot !== undefined;
  const hasProviderDefinitionBindingDigest =
    isRecord(value) && value.providerDefinitionBindingDigest !== undefined;
  if (
    !isRecord(value) ||
    hasProviderDefinitionSnapshot !== hasProviderDefinitionBindingDigest ||
    !hasExactKeys(
      value,
      !hasProviderDefinitionSnapshot
        ? [
            'assurance',
            'projection',
            'sameUserProcessConfined',
            'residuals',
            'executable',
            'elapsedMs',
          ]
        : [
            'assurance',
            'projection',
            'sameUserProcessConfined',
            'residuals',
            'executable',
            'elapsedMs',
            'providerDefinitionSnapshot',
            'providerDefinitionBindingDigest',
          ],
    ) ||
    value.assurance !== 'unchanged-governed-projection' ||
    value.sameUserProcessConfined !== false ||
    !isRecord(value.projection) ||
    !hasExactKeys(value.projection, [
      'unchanged',
      'changedCategories',
      'beforeDigest',
      'afterDigest',
    ]) ||
    value.projection.unchanged !== true ||
    !Array.isArray(value.projection.changedCategories) ||
    value.projection.changedCategories.length !== 0 ||
    !isDigest(value.projection.beforeDigest) ||
    value.projection.beforeDigest !== value.projection.afterDigest ||
    canonicalJson(value.residuals) !==
      canonicalJson(PROVIDER_RUNNER_RESIDUALS) ||
    !isProviderExecutableIdentity(value.executable) ||
    !Number.isSafeInteger(value.elapsedMs) ||
    (value.elapsedMs as number) < 0 ||
    (value.elapsedMs as number) > request.limits.timeoutMs
  ) {
    throw invalid();
  }
  if (hasProviderDefinitionSnapshot) {
    let providerDefinitionSnapshot: ProviderRunnerReport['providerDefinitionSnapshot'];
    try {
      providerDefinitionSnapshot = assertProviderDefinitionSnapshotForResult(
        value.providerDefinitionSnapshot,
        request.providerId,
        (value.executable as ProviderExecutableIdentity).candidatePath,
      );
    } catch {
      throw invalid();
    }
    if (
      value.providerDefinitionBindingDigest !==
      providerDefinitionExecutableBindingDigest(
        providerDefinitionDigest(providerDefinitionSnapshot),
        value.executable as ProviderExecutableIdentity,
      )
    ) {
      throw invalid();
    }
  }
  return deepFreeze(structuredClone(value)) as ProviderRuntimeObservation;
}

export function assertProviderDefinitionSnapshotForResult(
  value: unknown,
  providerId: ProviderInvocationRequest['providerId'],
  executableCandidatePath: string,
): ProviderRunnerReport['providerDefinitionSnapshot'] {
  if (isRecord(value) && value.kind === 'agent-provider-profile-snapshot') {
    if (typeof value.platform !== 'string') throw new TypeError();
    const profile = assertAgentProviderProfileSnapshot(
      value,
      value.platform as NodeJS.Platform,
    );
    if (
      profile.trustTier !== 'host-wrapper' ||
      profile.protocol !== 'harness-jsonl-v2' ||
      profile.enabled !== true ||
      profile.family !== providerId ||
      profile.executable !== executableCandidatePath
    ) {
      throw new TypeError();
    }
    return profile;
  }
  return assertKnownBuiltInProviderDefinitionSnapshot(value, {
    providerId,
    executableCandidatePath,
  });
}

export function providerDefinitionDigest(
  snapshot: ProviderRunnerReport['providerDefinitionSnapshot'],
): string {
  return 'profileDigest' in snapshot
    ? (snapshot as HostWrapperProviderProfileSnapshot).profileDigest
    : snapshot.definitionDigest;
}

export function assertAgentRuntimeCompletionReceipt(
  value: unknown,
  invalid: ProviderRuntimeEvidenceInvalidFactory,
): AgentRuntimeCompletionReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'invocationId',
      'requestDigest',
      'leasedRevision',
      'terminalRevision',
      'leaseGeneration',
      'executionJobId',
      'executionAttemptId',
      'executionRevision',
      'executionStateDigest',
      'acceptanceBindingDigest',
      'terminalState',
      'launched',
      'progress',
      'acceptanceBinding',
      'failureCode',
      'hostExecutionBinding',
      'protocolReceipt',
      'terminalDisposition',
      'receiptDigest',
    ]) ||
    value.schemaVersion !== 4 ||
    value.kind !== 'agent-runtime-completion-receipt' ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.requestDigest) ||
    !Number.isSafeInteger(value.leasedRevision) ||
    (value.leasedRevision as number) < 0 ||
    !Number.isSafeInteger(value.terminalRevision) ||
    value.terminalRevision !== (value.leasedRevision as number) + 1 ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 1 ||
    typeof value.executionJobId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/u.test(value.executionJobId) ||
    typeof value.executionAttemptId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u.test(value.executionAttemptId) ||
    !Number.isSafeInteger(value.executionRevision) ||
    (value.executionRevision as number) < 0 ||
    !isDigest(value.executionStateDigest) ||
    !isDigest(value.acceptanceBindingDigest) ||
    (value.terminalState !== 'succeeded' && value.terminalState !== 'failed') ||
    !['accepted', 'failed-before-result', 'rejected-after-result'].includes(
      String(value.terminalDisposition),
    ) ||
    (value.failureCode !== null &&
      (typeof value.failureCode !== 'string' ||
        value.failureCode.length === 0 ||
        Buffer.byteLength(value.failureCode, 'utf8') > 512)) ||
    value.launched !== true ||
    !isDigest(value.receiptDigest)
  ) {
    throw invalid();
  }
  try {
    assertInvocationId(value.invocationId, invalid);
  } catch {
    throw invalid();
  }
  const progress = assertAgentRuntimeProcessProgress(value.progress, invalid);
  const acceptanceBinding = assertProviderInvocationAcceptanceBinding(
    value.acceptanceBinding,
    invalid,
  );
  let protocolReceipt: ProviderRuntimeProtocolReceipt | null;
  let hostExecutionBinding: AgentRuntimeHostExecutionBindingV1 | null;
  try {
    hostExecutionBinding =
      value.hostExecutionBinding === null
        ? null
        : assertAgentRuntimeHostExecutionBindingV1(value.hostExecutionBinding);
    protocolReceipt =
      value.protocolReceipt === null
        ? null
        : hostExecutionBinding?.nativeSessionClaim === null ||
            hostExecutionBinding === null
          ? assertProviderRuntimeProtocolReceipt(value.protocolReceipt, {
              invocationId: value.invocationId,
              requestDigest: value.requestDigest,
              attemptId: value.executionAttemptId,
            })
          : assertProviderRuntimeProtocolReceiptForNativeSessionClaim(
              value.protocolReceipt,
              hostExecutionBinding.nativeSessionClaim,
            );
  } catch {
    throw invalid();
  }
  if (
    (value.terminalState === 'succeeded' &&
      progress.processState !== 'exited') ||
    (value.terminalState === 'succeeded' &&
      (value.terminalDisposition !== 'accepted' ||
        value.failureCode !== null)) ||
    (value.terminalState === 'failed' &&
      (value.terminalDisposition === 'accepted' ||
        typeof value.failureCode !== 'string')) ||
    (value.terminalDisposition === 'rejected-after-result' &&
      (value.terminalState !== 'failed' ||
        progress.processState !== 'exited' ||
        protocolReceipt?.terminal !== 'result' ||
        protocolReceipt.outputSlot !== 'primary' ||
        protocolReceipt.errorCode !== null ||
        protocolReceipt.cancellation.acknowledged ||
        protocolReceipt.cancellation.forced)) ||
    (value.terminalDisposition === 'failed-before-result' &&
      protocolReceipt?.terminal === 'result') ||
    acceptanceBinding.receiptRequirement !== 'schema-v4' ||
    acceptanceBinding.invocationId !== value.invocationId ||
    acceptanceBinding.requestDigest !== value.requestDigest ||
    acceptanceBinding.invocationRevision !== value.leasedRevision ||
    acceptanceBinding.leaseGeneration !== value.leaseGeneration ||
    acceptanceBinding.executionJobId !== value.executionJobId ||
    acceptanceBinding.executionAttemptId !== value.executionAttemptId ||
    acceptanceBinding.executionRevision !== value.executionRevision ||
    acceptanceBinding.executionStateDigest !== value.executionStateDigest ||
    acceptanceBinding.bindingDigest !== value.acceptanceBindingDigest ||
    (protocolReceipt !== null &&
      ((value.terminalState === 'succeeded' &&
        (protocolReceipt.terminal !== 'result' ||
          protocolReceipt.outputSlot !== 'primary' ||
          protocolReceipt.errorCode !== null ||
          protocolReceipt.cancellation.acknowledged ||
          protocolReceipt.cancellation.forced)) ||
        (value.terminalDisposition === 'failed-before-result' &&
          ((protocolReceipt.terminal === 'error' &&
            progress.processState !== 'exited') ||
            (protocolReceipt.terminal === 'cancelled' &&
              progress.processState !== 'cancelled'))) ||
        progress.lastProviderActivityElapsedMs === null ||
        progress.stdoutBytes < protocolReceipt.aggregateBytes)) ||
    hostExecutionBindingMismatch(
      hostExecutionBinding,
      protocolReceipt,
      value.terminalState,
      value.invocationId,
      value.requestDigest,
      value.executionAttemptId,
      value.acceptanceBindingDigest,
    ) ||
    sha256(
      canonicalJson(
        Object.fromEntries(
          Object.entries(value).filter(([key]) => key !== 'receiptDigest'),
        ),
      ),
    ) !== value.receiptDigest
  ) {
    throw invalid();
  }
  return deepFreeze(
    structuredClone({
      ...value,
      progress,
      acceptanceBinding,
      protocolReceipt,
      hostExecutionBinding,
    }) as AgentRuntimeCompletionReceipt,
  );
}

function hostExecutionBindingMismatch(
  binding: AgentRuntimeHostExecutionBindingV1 | null | undefined,
  protocolReceipt: ProviderRuntimeProtocolReceipt | null | undefined,
  terminalState: 'succeeded' | 'failed',
  invocationId: string,
  requestDigest: string,
  executionAttemptId: string,
  acceptanceBindingDigest: string,
): boolean {
  if (binding === undefined) return false;
  const sessionReceipt =
    protocolReceipt?.kind === 'provider-wrapper-session-protocol-receipt';
  if (sessionReceipt && binding?.phase !== 'native-terminal') return true;
  if (
    binding?.phase === 'native-terminal' &&
    protocolReceipt !== null &&
    protocolReceipt !== undefined &&
    !sessionReceipt
  ) {
    return true;
  }
  if (
    terminalState === 'succeeded' &&
    binding !== null &&
    (binding?.phase !== 'native-terminal' || !sessionReceipt)
  ) {
    return true;
  }
  if (binding === null) return false;
  if (
    binding.probe !== null &&
    (binding.probe.invocationId !== invocationId ||
      binding.probe.requestDigest !== requestDigest ||
      binding.probe.executionAttemptId !== executionAttemptId ||
      binding.probe.acceptanceBindingDigest !== acceptanceBindingDigest)
  ) {
    return true;
  }
  return (
    binding.nativeSessionClaim !== null &&
    (binding.nativeSessionClaim.invocationId !== invocationId ||
      binding.nativeSessionClaim.requestDigest !== requestDigest ||
      binding.nativeSessionClaim.attemptId !== executionAttemptId)
  );
}

export function assertProviderInvocationAcceptanceBinding(
  value: unknown,
  invalid: ProviderRuntimeEvidenceInvalidFactory,
): ProviderInvocationAcceptanceBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'invocationId',
      'requestDigest',
      'ownerWorkflowId',
      'invocationRevision',
      'leaseGeneration',
      'context',
      'executionJobId',
      'executionAttemptId',
      'executionRevision',
      'executionStateDigest',
      'receiptRequirement',
      'repair',
      'bindingDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-invocation-acceptance-binding' ||
    typeof value.invocationId !== 'string' ||
    !isDigest(value.requestDigest) ||
    typeof value.ownerWorkflowId !== 'string' ||
    !Number.isSafeInteger(value.invocationRevision) ||
    (value.invocationRevision as number) < 0 ||
    !Number.isSafeInteger(value.leaseGeneration) ||
    (value.leaseGeneration as number) < 1 ||
    typeof value.executionJobId !== 'string' ||
    !/^[a-z0-9][a-z0-9._:-]{0,255}$/u.test(value.executionJobId) ||
    typeof value.executionAttemptId !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,511}$/u.test(value.executionAttemptId) ||
    !Number.isSafeInteger(value.executionRevision) ||
    (value.executionRevision as number) < 0 ||
    !isDigest(value.executionStateDigest) ||
    (value.receiptRequirement !== 'schema-v4' &&
      value.receiptRequirement !== 'synchronous-no-activity') ||
    !isDigest(value.bindingDigest) ||
    !isProviderPromptContextBinding(value.context) ||
    !isProviderRepairAuthorityBinding(value.repair) ||
    value.context.ownerWorkflowId !== value.ownerWorkflowId ||
    value.repair.invocationId !== value.invocationId
  ) {
    throw invalid();
  }
  const payload = { ...value };
  delete payload.bindingDigest;
  if (sha256(canonicalJson(payload)) !== value.bindingDigest) throw invalid();
  return deepFreeze(
    structuredClone(value) as ProviderInvocationAcceptanceBinding,
  );
}

export function assertAgentRuntimeProcessProgress(
  value: unknown,
  invalid: ProviderRuntimeEvidenceInvalidFactory,
): AgentRuntimeProcessProgressProjection {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'processState',
      'eventCount',
      'stdoutBytes',
      'stderrBytes',
      'lastProcessActivityElapsedMs',
      'lastProviderActivityElapsedMs',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'agent-runtime-process-progress' ||
    ![
      'not-started',
      'running',
      'exited',
      'timed-out',
      'cancelled',
      'output-limit',
      'spawn-error',
      'protocol-error',
    ].includes(String(value.processState)) ||
    !Number.isSafeInteger(value.eventCount) ||
    (value.eventCount as number) < 0 ||
    !Number.isSafeInteger(value.stdoutBytes) ||
    (value.stdoutBytes as number) < 0 ||
    !Number.isSafeInteger(value.stderrBytes) ||
    (value.stderrBytes as number) < 0 ||
    !isNullableNonnegativeInteger(value.lastProcessActivityElapsedMs) ||
    !isNullableNonnegativeInteger(value.lastProviderActivityElapsedMs) ||
    ((value.eventCount as number) === 0) !==
      (value.lastProcessActivityElapsedMs === null) ||
    (value.lastProviderActivityElapsedMs !== null &&
      (value.lastProcessActivityElapsedMs === null ||
        (value.lastProviderActivityElapsedMs as number) >
          (value.lastProcessActivityElapsedMs as number)))
  ) {
    throw invalid();
  }
  return deepFreeze(
    structuredClone(value) as AgentRuntimeProcessProgressProjection,
  );
}

function isProviderPromptContextBinding(value: unknown): value is {
  ownerWorkflowId: string;
  purpose: ProviderInvocationRequest['purpose'];
  workflowId: string;
  generation: number;
  epoch: number;
  contextDigest: string;
  manifest: Record<string, unknown>;
} {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'ownerWorkflowId',
      'purpose',
      'workflowId',
      'generation',
      'epoch',
      'contextDigest',
      'manifest',
    ]) ||
    typeof value.ownerWorkflowId !== 'string' ||
    ![
      'survey',
      'plan-review',
      'task-diff-review',
      'task-implementation',
    ].includes(String(value.purpose)) ||
    typeof value.workflowId !== 'string' ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 0 ||
    !Number.isSafeInteger(value.epoch) ||
    (value.epoch as number) < 0 ||
    !isPrefixedDigest(value.contextDigest) ||
    !isContextManifest(value.manifest)
  ) {
    return false;
  }
  return (
    value.manifest.workflowId === value.workflowId &&
    value.manifest.epoch === value.epoch &&
    value.manifest.contextDigest === value.contextDigest
  );
}

function isContextManifest(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'workflowId',
      'epoch',
      'contractVersion',
      'baselineDigest',
      'intentDigest',
      'termSetDigest',
      'planningSnapshotDigest',
      'contextDigest',
      'items',
    ]) &&
    value.schemaVersion === 1 &&
    value.kind === 'epoch-context-manifest' &&
    typeof value.workflowId === 'string' &&
    Number.isSafeInteger(value.epoch) &&
    (value.epoch as number) >= 0 &&
    Number.isSafeInteger(value.contractVersion) &&
    (value.contractVersion as number) >= 1 &&
    isPrefixedDigest(value.baselineDigest) &&
    isPrefixedDigest(value.intentDigest) &&
    isPrefixedDigest(value.termSetDigest) &&
    isPrefixedDigest(value.planningSnapshotDigest) &&
    isPrefixedDigest(value.contextDigest) &&
    Array.isArray(value.items) &&
    value.items.every(
      (item) =>
        isRecord(item) &&
        hasExactKeys(item, ['identity', 'digest']) &&
        typeof item.identity === 'string' &&
        item.identity.length > 0 &&
        isPrefixedDigest(item.digest),
    )
  );
}

function isProviderRepairAuthorityBinding(value: unknown): value is {
  invocationId: string;
} {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'invocationId',
      'lineagePath',
      'lineageDigest',
      'currentEvidencePath',
      'evidencePath',
      'evidenceDigest',
    ]) &&
    typeof value.invocationId === 'string' &&
    typeof value.lineagePath === 'string' &&
    value.lineagePath.length > 0 &&
    (value.lineageDigest === null || isPrefixedDigest(value.lineageDigest)) &&
    typeof value.currentEvidencePath === 'string' &&
    value.currentEvidencePath.length > 0 &&
    ((value.evidencePath === null && value.evidenceDigest === null) ||
      (typeof value.evidencePath === 'string' &&
        value.evidencePath.length > 0 &&
        isPrefixedDigest(value.evidenceDigest)))
  );
}

function isNullableNonnegativeInteger(value: unknown): boolean {
  return (
    value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && DIGEST.test(value);
}

function isPrefixedDigest(value: unknown): value is string {
  return typeof value === 'string' && PREFIXED_DIGEST.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
