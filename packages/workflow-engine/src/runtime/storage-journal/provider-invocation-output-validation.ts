/**
 * Validate code-owned provider output schemas, fixed runner results, and runtime evidence bindings.
 *
 * Invariants:
 * - Current schemas, residual lists, output digests, and executable evidence stay exact.
 * - Unsupported output generations and mismatched host evidence remain rejected.
 */

import {
  providerOutputSchemaGeneration,
  providerOutputValidator,
} from '../../modules/assurance/provider-output-contract.ts';
export {
  providerOutputSchemaGeneration,
  matchesPersistedProviderOutputSchema,
  blindSurveyOutputValidator,
  providerOutputValidator,
} from '../../modules/assurance/provider-output-contract.ts';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  type ProviderInvocationRequest,
  type ProviderProcessResult,
  type ProviderRunnerReport,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import type { AgentRuntimeHostExecutionBindingV1 } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import { assertAgentRuntimeHostExecutionBindingV1 } from '../../modules/provider-orchestration/agent-runtime-host-execution-binding.ts';
import {
  PROVIDER_RUNNER_RESIDUALS,
  assertProviderProcessResult,
  isProviderExecutableIdentity,
  assertProviderDefinitionSnapshotForResult,
  providerDefinitionExecutableBindingDigest,
  providerDefinitionDigest,
  assertProviderRuntimeObservation,
} from '../../modules/provider-orchestration/provider-runtime-evidence.ts';
import type { ProviderResidualsGeneration } from '../../modules/provider-orchestration/provider-invocation-lifecycle.ts';
import type { ProviderInvocationRecord } from '../../modules/provider-orchestration/provider-invocation-record.ts';
import type { ProviderInvocationManifest } from './provider-invocation-manifest-validation.ts';
import {
  resultInvalid,
  deepFreeze,
  isRecord,
  sha256,
  invocationInvalid,
} from './provider-invocation-common.ts';

function classifyProviderResiduals(
  value: unknown,
): ProviderResidualsGeneration {
  if (
    !Array.isArray(value) ||
    canonicalJson(value) !== canonicalJson(PROVIDER_RUNNER_RESIDUALS)
  ) {
    throw resultInvalid();
  }
  return deepFreeze({
    generation: 'current',
    missing: [],
  }) as ProviderResidualsGeneration;
}

/**
 * Report the residuals generation a durable record carries, or null when it
 * holds no runtime observation to carry one. Classified from the record rather
 * than from the request, because residuals are what the run observed and not
 * what it was asked to do.
 */
export function providerResidualsGeneration(
  record: ProviderInvocationRecord,
): ProviderResidualsGeneration | null {
  const residuals = record.result?.runtimeObservation?.residuals;
  return residuals === undefined ? null : classifyProviderResiduals(residuals);
}

export function assertProviderResult(
  request: ProviderInvocationRequest,
  value: unknown,
): ProviderProcessResult {
  return assertProviderProcessResult(
    request,
    value,
    providerOutputValidator(request),
    resultInvalid,
  );
}

export function providerResultFromRunnerReport(
  request: ProviderInvocationRequest,
  report: ProviderRunnerReport,
): ProviderProcessResult {
  if (
    !isRecord(report) ||
    report.invocationId !== request.invocationId ||
    report.providerId !== request.providerId ||
    report.purpose !== request.purpose ||
    report.requestDigest !== request.requestDigest ||
    report.providerDefinitionSnapshot === undefined ||
    report.semanticOutputDigest !== sha256(canonicalJson(report.semanticOutput))
  ) {
    throw resultInvalid();
  }
  const validator = providerOutputValidator(request);
  let accepted: boolean;
  try {
    accepted = validator.validate(report.semanticOutput) === true;
  } catch {
    throw resultInvalid();
  }
  if (!accepted) {
    throw resultInvalid();
  }
  const output = deepFreeze(structuredClone(report.semanticOutput));
  let providerDefinitionSnapshot: ProviderRunnerReport['providerDefinitionSnapshot'];
  try {
    if (!isProviderExecutableIdentity(report.executable)) throw resultInvalid();
    providerDefinitionSnapshot = assertProviderDefinitionSnapshotForResult(
      report.providerDefinitionSnapshot,
      request.providerId,
      report.executable.candidatePath,
    );
  } catch {
    throw resultInvalid();
  }
  const hostWrapperProfile =
    'profileDigest' in providerDefinitionSnapshot &&
    providerDefinitionSnapshot.trustTier === 'host-wrapper';
  const hostWrapperProtocolReceipt =
    report.wrapperProtocolReceipt?.kind ===
    'provider-wrapper-session-protocol-receipt';
  let hostExecutionBinding: AgentRuntimeHostExecutionBindingV1 | null = null;
  try {
    hostExecutionBinding =
      report.hostExecutionBinding === undefined
        ? null
        : assertAgentRuntimeHostExecutionBindingV1(report.hostExecutionBinding);
  } catch {
    throw resultInvalid();
  }
  const providerDefinitionBindingDigest =
    providerDefinitionExecutableBindingDigest(
      providerDefinitionDigest(providerDefinitionSnapshot),
      report.executable,
    );
  if (
    hostWrapperProfile !== hostWrapperProtocolReceipt ||
    hostWrapperProfile !== (hostExecutionBinding !== null) ||
    (hostExecutionBinding !== null &&
      (hostExecutionBinding.phase !== 'native-terminal' ||
        hostExecutionBinding.probe === null ||
        canonicalJson(
          hostExecutionBinding.assignmentBinding.providerProfileSnapshot,
        ) !== canonicalJson(providerDefinitionSnapshot) ||
        hostExecutionBinding.assignmentBinding.definitionDigest !==
          providerDefinitionDigest(providerDefinitionSnapshot) ||
        hostExecutionBinding.assignmentBinding.dataAuthorizationPolicyDigest !==
          request.policyDigest ||
        hostExecutionBinding.assignmentBinding.inputManifestDigest !==
          request.inputManifestDigest ||
        hostExecutionBinding.assignmentBinding.targetDigest !==
          request.targetDigest ||
        hostExecutionBinding.probe.providerDefinitionBindingDigest !==
          providerDefinitionBindingDigest))
  ) {
    throw resultInvalid();
  }
  const providerDefinitionEvidence = {
    providerDefinitionSnapshot,
    providerDefinitionBindingDigest,
  };
  const runtimeObservation = assertProviderRuntimeObservation(
    {
      assurance: report.assurance,
      projection: report.projection,
      sameUserProcessConfined: report.sameUserProcessConfined,
      residuals: report.residuals,
      executable: report.executable,
      elapsedMs: report.elapsedMs,
      ...providerDefinitionEvidence,
    },
    request,
    resultInvalid,
  );
  return deepFreeze({
    requestDigest: request.requestDigest,
    invocationId: request.invocationId,
    purpose: request.purpose,
    providerId: request.providerId,
    output,
    outputDigest: sha256(
      canonicalJson({
        id: request.outputSchema.id,
        version: request.outputSchema.version,
        output,
      }),
    ),
    runtimeObservation,
  });
}

export function assertProviderResultManifestBinding(
  manifest: ProviderInvocationManifest,
  result: ProviderProcessResult,
): void {
  if (manifest.kind !== 'task-strategy-implementation-manifest') return;
  if (
    !isRecord(result.output) ||
    result.output.sessionId !== manifest.subject.sessionId ||
    result.output.sourceTree !== manifest.subject.sourceTree
  ) {
    throw invocationInvalid();
  }
}
