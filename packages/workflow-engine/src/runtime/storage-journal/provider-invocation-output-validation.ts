/**
 * Validate code-owned provider output schemas, fixed runner results, and runtime evidence bindings.
 *
 * Invariants:
 * - Current schemas, residual lists, output digests, and executable evidence stay exact.
 * - Unsupported output generations and mismatched host evidence remain rejected.
 *
 * Depends on: provider runtime evidence, output contracts, invocation types, and shared errors.
 * Failure modes: Invalid provider output can appear accepted or lose its original repair failure.
 */

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
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
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  validateBlindSurveyOutput,
} from '../../modules/provider-orchestration/blind-survey-output.ts';
import {
  PLAN_REVIEW_OUTPUT_SCHEMA,
  PLAN_REVIEW_OUTPUT_VALIDATOR,
} from '../../modules/assurance/plan-review.ts';
import {
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
  TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
} from '../../modules/assurance/task-diff-review-artifact.ts';
import {
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA,
  TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR,
} from '../../modules/provider-orchestration/task-strategy-provider-contract.ts';
import {
  type ProviderOutputSchemaGeneration,
  type ProviderResidualsGeneration,
  type ProviderInvocationRecord,
  type ProviderInvocationManifest,
} from './provider-invocation-types.ts';
import {
  resultInvalid,
  deepFreeze,
  isRecord,
  sha256,
  invocationInvalid,
} from './provider-invocation-common.ts';

function providerOutputSchemaUnsupported() {
  return workflowError(
    'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED',
    'Provider invocation does not reference a code-owned output schema.',
    ExitCode.verification,
  );
}

function codeOwnedProviderOutputSchema(request: ProviderInvocationRequest) {
  if (request.purpose === 'survey') {
    return BLIND_SURVEY_OUTPUT_SCHEMA;
  }
  if (request.purpose === 'plan-review') {
    return PLAN_REVIEW_OUTPUT_SCHEMA;
  }
  if (request.purpose === 'task-diff-review') {
    if (
      request.outputSchema.id === TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id
    ) {
      return TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA;
    }
    return TASK_DIFF_REVIEW_OUTPUT_SCHEMA;
  }
  if (request.purpose === 'task-implementation') {
    return TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA;
  }
  throw providerOutputSchemaUnsupported();
}

export function providerOutputSchemaGeneration(
  request: ProviderInvocationRequest,
): ProviderOutputSchemaGeneration {
  const codeOwned = codeOwnedProviderOutputSchema(request);
  if (
    request.outputSchema.id !== codeOwned.id ||
    request.outputSchema.version !== codeOwned.version ||
    request.outputSchema.digest !== codeOwned.digest
  ) {
    throw providerOutputSchemaUnsupported();
  }
  return 'code-owned';
}

export function matchesPersistedProviderOutputSchema(
  observed: ProviderInvocationRequest['outputSchema'],
  current: Readonly<{ id: string; version: number; digest: string }>,
): boolean {
  return (
    observed.id === current.id &&
    observed.version === current.version &&
    observed.digest === current.digest
  );
}

export function blindSurveyOutputValidator(request: ProviderInvocationRequest) {
  if (
    request.purpose !== 'survey' ||
    providerOutputSchemaGeneration(request) !== 'code-owned'
  ) {
    throw providerOutputSchemaUnsupported();
  }
  return {
    ...BLIND_SURVEY_OUTPUT_SCHEMA,
    validate(value: unknown): boolean {
      return validateBlindSurveyOutput(value, request.invocationId);
    },
  };
}

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

export function providerOutputValidator(request: ProviderInvocationRequest) {
  if (providerOutputSchemaGeneration(request) !== 'code-owned') {
    throw providerOutputSchemaUnsupported();
  }
  if (request.purpose === 'survey') {
    return blindSurveyOutputValidator(request);
  }
  if (request.purpose === 'plan-review') {
    return PLAN_REVIEW_OUTPUT_VALIDATOR;
  }
  if (request.purpose === 'task-diff-review') {
    if (
      request.outputSchema.id ===
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id &&
      request.outputSchema.version ===
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.version &&
      request.outputSchema.digest ===
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.digest
    ) {
      return TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR;
    }
    return TASK_DIFF_REVIEW_OUTPUT_VALIDATOR;
  }
  if (request.purpose === 'task-implementation') {
    return TASK_STRATEGY_IMPLEMENTATION_OUTPUT_VALIDATOR;
  }
  throw providerOutputSchemaUnsupported();
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
