/**
 * Validates propose requests and reconstructs exact caller envelopes from durable state.
 *
 * Invariants:
 * - Envelope kinds and normalized intent retain their exact supported shapes and bindings.
 * - Authorization evidence binds actor, assignment, grant, baseline, and protected base.
 * - Generated scan acceptance identifies the current investigation and saturated terms.
 */

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type ActorSignal } from '../../modules/authority/actor-identity.ts';
import {
  type ProviderInvocationRequest,
  PROPOSE_POLICY_DIGEST,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  type ProposeGrantAuthorization,
  assertProposeGrantAuthorization,
} from './plan-review-contracts.ts';
import {
  hasExactKeys,
  isBaseline,
  isRecord,
  isStringArray,
  PROPOSE_AUTHORIZATION_OUTPUT_SCHEMA,
  PROPOSE_AUTHORIZATION_SCHEMA,
  proposeAuthorizationInvalid,
  proposeInputInvalid,
  sha256,
} from './propose-common.ts';
import {
  assertExemptionPlanningContributionEnvelope,
  assertPlanningContributionEnvelope,
  assertPlanReviewDispositionsEnvelope,
  assertPlanReviewProgressEnvelope,
  assertPlanReviewRetryEnvelope,
  assertProviderProgressEnvelope,
  assertProviderRetryEnvelope,
  checkpointPayloadTemplate,
  createProviderProgressEnvelope,
  isCanonicalSourceReferenceArray,
  withEnvelopeTemplate,
} from './propose-input.ts';
import type {
  InvestigationScanSaturationAcceptanceEnvelope,
  InvestigationStatus,
  ProposeRuntime,
} from './propose-runtime.ts';
import type { BlindSurveyManifest } from '../../modules/investigation/manifest/blind-survey-manifest.ts';
import type { NormalizedChangeIntent } from '../../modules/source/change-intent.ts';
import {
  type InvestigationExemptionRequest,
  type ProposeInput,
  type ProposeOutput,
  type ProposeStartInput,
  type ProposeWork,
} from './propose-types.ts';

export function createScanSaturationAcceptanceEnvelope(
  services: Pick<ProposeRuntime, 'investigation'>,
  output: ProposeOutput,
): InvestigationScanSaturationAcceptanceEnvelope {
  if (
    output.state !== 'scan-saturation-acceptance-required' ||
    !isRecord(output.inputSchema) ||
    output.inputSchema.kind !== 'scan-saturation-acceptance' ||
    !isRecord(output.inputSchema.binding) ||
    !Array.isArray(output.inputSchema.saturatedTermIds)
  ) {
    throw workflowError(
      'INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_NOT_AVAILABLE',
      'The propose wrapper is not waiting for scan saturation acceptance.',
      ExitCode.guard,
    );
  }
  return services.investigation.assertInvestigationScanSaturationAcceptanceEnvelope(
    {
      schemaVersion: 1,
      kind: 'scan-saturation-acceptance',
      ...output.inputSchema.binding,
      saturatedTermIds: output.inputSchema.saturatedTermIds,
      acknowledgeIncompleteScan: true,
    },
  );
}

export function inputSchemaForStatus(
  services: Pick<ProposeRuntime, 'provider' | 'workspace'>,
  cwd: string,
  status: InvestigationStatus,
  work: ProposeWork,
): Record<string, unknown> | null {
  if (status.checkpoint !== null) {
    const binding = {
      investigationId: status.investigationId,
      changeId: status.changeId,
      expectedRevision: status.revision,
      baseline: status.baseline,
      intentDigest: status.intentDigest,
      blindManifestDigest: status.blindManifestDigest,
    };
    return {
      schemaVersion: 1,
      kind: 'investigation-checkpoint',
      checkpointKind: status.checkpoint.kind,
      checkpointId: status.checkpoint.checkpointId,
      binding,
      // The exact envelope to submit: copy it, replace every <...> placeholder,
      // and keep the rest byte-for-byte. Unfilled placeholders are rejected.
      template: {
        schemaVersion: 1,
        kind: status.checkpoint.kind,
        checkpointId: status.checkpoint.checkpointId,
        ...binding,
        payload: checkpointPayloadTemplate(status.checkpoint.kind, work),
      },
    };
  }
  if (
    status.nextAction === 'wait-for-provider' ||
    status.nextAction === 'resume-provider-result'
  ) {
    return withEnvelopeTemplate({
      schemaVersion: 1,
      kind: 'provider-progress',
      binding: createProviderProgressEnvelope(status),
    });
  }
  if (
    status.nextAction === 'retry-provider' &&
    status.provider.state === 'failed' &&
    status.provider.failure?.kind === 'retryable'
  ) {
    const context = services.workspace.loadInvestigationRuntimeContext(cwd);
    const request = services.provider.readProviderInvocationRequest(
      context.runtime,
      status.providerInvocationId,
    );
    return withEnvelopeTemplate({
      schemaVersion: 1,
      kind: 'provider-retry',
      binding: {
        investigationId: status.investigationId,
        changeId: status.changeId,
        expectedRevision: status.revision,
        baseline: status.baseline,
        intentDigest: status.intentDigest,
        blindManifestDigest: status.blindManifestDigest,
        failedInvocation: {
          invocationId: status.providerInvocationId,
          attempt: status.provider.attempt,
          revision: status.provider.revision,
          requestDigest: request.requestDigest,
          failureDigest: sha256(canonicalJson(status.provider.failure)),
        },
      },
      requiredAcknowledgement: {
        acknowledgeProviderCost: true,
      },
    });
  }
  return null;
}

export function assertProposeInput(
  services: Pick<ProposeRuntime, 'investigation'>,
  value: unknown,
): ProposeInput {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw proposeInputInvalid();
  }
  if (value.kind === 'planning-contribution') {
    return assertPlanningContributionEnvelope(value);
  }
  if (value.kind === 'exemption-planning-contribution') {
    return assertExemptionPlanningContributionEnvelope(value);
  }
  if (value.kind === 'scan-saturation-acceptance') {
    return services.investigation.assertInvestigationScanSaturationAcceptanceEnvelope(
      value,
    );
  }
  if (value.kind === 'provider-progress') {
    return assertProviderProgressEnvelope(value);
  }
  if (value.kind === 'provider-retry') {
    return assertProviderRetryEnvelope(value);
  }
  if (value.kind === 'plan-review-retry') {
    return assertPlanReviewRetryEnvelope(value);
  }
  if (value.kind === 'plan-review-progress') {
    return assertPlanReviewProgressEnvelope(value);
  }
  if (value.kind === 'plan-review-dispositions') {
    return assertPlanReviewDispositionsEnvelope(value);
  }
  return services.investigation.assertInvestigationCheckpointEnvelope(value);
}

function assertNormalizedIntent(
  services: Pick<ProposeRuntime, 'provider'>,
  value: unknown,
): NormalizedChangeIntent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'summary',
      'sourceRefs',
      'explicitPaths',
      'explicitSymbols',
      'explicitConfigKeys',
      'renamePairs',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.summary !== 'string' ||
    value.summary.trim().length === 0 ||
    !isCanonicalSourceReferenceArray(value.sourceRefs) ||
    !isStringArray(value.explicitPaths) ||
    !isStringArray(value.explicitSymbols) ||
    !isStringArray(value.explicitConfigKeys) ||
    !Array.isArray(value.renamePairs)
  ) {
    throw workflowError(
      'PROPOSE_INTENT_INVALID',
      'Propose intent does not match normalized intent schema version 1.',
      ExitCode.usage,
    );
  }
  const renamePairs = value.renamePairs.map((pair) => {
    if (
      !isRecord(pair) ||
      !hasExactKeys(pair, ['from', 'to']) ||
      typeof pair.from !== 'string' ||
      pair.from.length === 0 ||
      typeof pair.to !== 'string' ||
      pair.to.length === 0
    ) {
      throw workflowError(
        'PROPOSE_INTENT_INVALID',
        'Propose rename pairs are malformed.',
        ExitCode.usage,
      );
    }
    return { from: pair.from, to: pair.to };
  });
  const intent: NormalizedChangeIntent = {
    schemaVersion: 1,
    summary: value.summary,
    sourceRefs: [...value.sourceRefs],
    explicitPaths: [...value.explicitPaths],
    explicitSymbols: [...value.explicitSymbols],
    explicitConfigKeys: [...value.explicitConfigKeys],
    renamePairs,
  };
  const probe: BlindSurveyManifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId: 'intent-validation',
    repositoryId: 'intent-validation',
    baseCommit: '0'.repeat(40),
    baseTree: '0'.repeat(40),
    normalizedIntent: intent,
    architectureQuestion: 'Validate the normalized intent shape.',
    capabilityProfile: 'repository-read-only',
  };
  services.provider.blindSurveyIntentDigest(
    Object.freeze(probe) as BlindSurveyManifest,
  );
  return intent;
}

export function assertProposeStartInput(
  services: Pick<ProposeRuntime, 'provider'>,
  value: unknown,
): ProposeStartInput {
  if (isRecord(value) && value.kind === 'investigation-exemption-request') {
    if (
      !hasExactKeys(value, ['schemaVersion', 'kind', 'intent', 'exemption']) ||
      value.schemaVersion !== 1 ||
      !isRecord(value.exemption) ||
      !hasExactKeys(value.exemption, [
        'category',
        'declaredPaths',
        'declaredChangeClasses',
        'rationale',
        'semanticAuthor',
        'nonTrivialBehaviorReliance',
        'researchBudgetMinutes',
      ]) ||
      typeof value.exemption.category !== 'string' ||
      !isStringArray(value.exemption.declaredPaths) ||
      !isStringArray(value.exemption.declaredChangeClasses) ||
      typeof value.exemption.rationale !== 'string' ||
      !isRecord(value.exemption.semanticAuthor) ||
      value.exemption.nonTrivialBehaviorReliance !== 'none-declared' ||
      (value.exemption.researchBudgetMinutes !== null &&
        !Number.isInteger(value.exemption.researchBudgetMinutes))
    ) {
      throw proposeInputInvalid();
    }
    return {
      schemaVersion: 1,
      kind: 'investigation-exemption-request',
      intent: assertNormalizedIntent(services, value.intent),
      exemption: structuredClone(
        value.exemption,
      ) as InvestigationExemptionRequest['exemption'],
    };
  }
  return assertNormalizedIntent(services, value);
}

export function readProposeAuthorization(
  services: Pick<ProposeRuntime, 'evidence' | 'provider'>,
  paths: ReturnType<
    ProposeRuntime['workspace']['loadInvestigationRuntimeContext']
  >['runtime'],
  request: ProviderInvocationRequest,
): {
  actor: {
    providerId: 'codex' | 'claude';
    assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
  };
  signals: ActorSignal[];
  protectedBase: {
    ref: string;
    commit: string;
  };
  grantAuthorization: ProposeGrantAuthorization | null;
} {
  const node = services.evidence.readEvidenceNode(
    paths,
    request.authorizationNodeId,
  );
  const output = node.output;
  if (
    node.type !== 'propose-authorization' ||
    node.nodeSchema !== PROPOSE_AUTHORIZATION_SCHEMA ||
    node.evaluator !== 'workflow-propose.v1' ||
    node.policyDigest !== PROPOSE_POLICY_DIGEST ||
    node.outputSchema !== PROPOSE_AUTHORIZATION_OUTPUT_SCHEMA ||
    !isRecord(output) ||
    !hasExactKeys(output, [
      'actor',
      'signals',
      'assignment',
      'grantAuthorization',
      'intent',
      'baseline',
      'protectedBase',
    ]) ||
    !isRecord(output.actor) ||
    !hasExactKeys(output.actor, ['providerId', 'assurance']) ||
    !['codex', 'claude'].includes(output.actor.providerId as string) ||
    !['self-declared', 'runtime-hint', 'adapter-assigned'].includes(
      output.actor.assurance as string,
    ) ||
    !Array.isArray(output.signals) ||
    !isBaseline(output.baseline) ||
    !isRecord(output.protectedBase) ||
    !hasExactKeys(output.protectedBase, ['ref', 'commit']) ||
    typeof output.protectedBase.ref !== 'string' ||
    output.protectedBase.ref.length === 0 ||
    typeof output.protectedBase.commit !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(output.protectedBase.commit) ||
    canonicalJson(output.baseline) !==
      canonicalJson({
        head: request.baseCommit,
        tree: request.baseTree,
      }) ||
    canonicalJson(output.assignment) !== canonicalJson(request.roleAssignment)
  ) {
    throw proposeAuthorizationInvalid();
  }
  const actor = output.actor as {
    providerId: 'codex' | 'claude';
    assurance: 'self-declared' | 'runtime-hint' | 'adapter-assigned';
  };
  const signals = output.signals.map((signal) => {
    if (
      !isRecord(signal) ||
      !hasExactKeys(signal, ['source', 'name', 'providerId', 'assurance']) ||
      !['explicit', 'runtime-hint'].includes(signal.source as string) ||
      typeof signal.name !== 'string' ||
      signal.name.length === 0 ||
      signal.providerId !== actor.providerId ||
      !['self-declared', 'runtime-hint'].includes(signal.assurance as string)
    ) {
      throw proposeAuthorizationInvalid();
    }
    return signal as ActorSignal;
  });
  const intent = assertNormalizedIntent(services, output.intent);
  const grantAuthorization = assertProposeGrantAuthorization(
    output.grantAuthorization,
    actor,
    request,
  );
  if (
    node.exactInputDigests.actorResolution !==
      sha256(canonicalJson({ actor, signals })) ||
    node.exactInputDigests.assignment !==
      sha256(canonicalJson(request.roleAssignment)) ||
    node.exactInputDigests.grantAuthorization !==
      sha256(canonicalJson(grantAuthorization)) ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(output.baseline)) ||
    node.exactInputDigests.intent !== sha256(canonicalJson(intent)) ||
    node.exactInputDigests.protectedBase !==
      sha256(canonicalJson(output.protectedBase))
  ) {
    throw proposeAuthorizationInvalid();
  }
  return {
    actor,
    signals,
    grantAuthorization,
    protectedBase: output.protectedBase as {
      ref: string;
      commit: string;
    },
  };
}
