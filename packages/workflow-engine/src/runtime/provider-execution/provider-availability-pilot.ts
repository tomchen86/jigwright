/**
 * Run the bounded reviewed provider availability pilot and expose verification of its durable observation.
 *
 * Invariants:
 * - Probe, invocation authorization, launch, and observation ordering remain exact.
 * - The pilot reports empirical outcomes without creating completion authority.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentRuntimeProbeEvidenceV1 } from '@jigwright/core/agent-runtime-port';
import { loadAiAdapterPolicy } from './ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { loadWorkflowConfig } from '../../adapters/consumer/repository/work-registry/contracts.ts';
import { createEvidenceNode } from '../../adapters/planning/investigation/evidence-node.ts';
import { writeEvidenceNode } from '../storage-journal/evidence-node-store.ts';
import {
  WorkflowError,
  durableFailureMessage,
} from '../../foundation/errors/errors.ts';
import { discoverRepository } from '../repository-transaction/git.ts';
import { investigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  type ProviderRunnerReport,
  createProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  type BlindSurveyManifest,
  blindSurveyIntentDigest,
  providerInvocationManifestDigest,
  BLIND_SURVEY_OUTPUT_SCHEMA,
  ensureProviderExecutionPolicySnapshot,
  createProviderInvocation,
  claimProviderInvocation,
  prepareProviderInvocationAcceptanceBinding,
  BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
  blindSurveyOutputValidator,
  completeProviderInvocationFromRunner,
  readProviderInvocation,
  failProviderInvocation,
} from '../storage-journal/provider-invocation-store.ts';
import {
  type ProviderId,
  listBuiltInProviders,
} from '../../modules/provider-orchestration/provider-registry.ts';
import type {
  ProviderResolution,
  ProviderPreflightOptions,
  ProviderRunInput,
  ProviderRunOptions,
} from './provider-runner.ts';
import { scheduleOrdinaryRole } from '../../modules/provider-orchestration/role-scheduler.ts';
import { admitBuiltInProviderFamilyEvidence } from './agent-runtime-probe-evidence.ts';
import {
  resolvePilotRecordPath,
  readPilotRecord,
  assertProviderAvailabilityPilotRecord,
  pilotInvalid,
  normalizeRunToken,
  PROVIDERS,
  unavailableObservation,
  createPilotRecordPayload,
  sha256,
  writePilotRecord,
  successfulObservation,
  failedObservation,
} from './provider-availability-record.ts';

const PILOT_AUTHORIZATION_SCHEMA =
  'workflow.provider-availability-pilot-authorization.v1';

const PILOT_AUTHORIZATION_OUTPUT_SCHEMA =
  'workflow.provider-availability-pilot-authorization-output.v1';

const PILOT_EVALUATOR = 'provider-availability-pilot.v1';

export type ProviderAvailabilityPilotObservation = Readonly<{
  providerId: ProviderId;
  role: 'plan-reviewer';
  state: 'succeeded' | 'unavailable' | 'failed';
  resolutionStatus: ProviderResolution['status'];
  version: string | null;
  invocationId: string | null;
  requestDigest: string | null;
  outputDigest: string | null;
  authorizationNodeId: string | null;
  achievedIndependence: 'provider-independent' | null;
  grantUsed: false;
  providerLatencyMs: number;
  mutationObservation: Readonly<{
    assurance: 'unchanged-governed-projection';
    unchanged: true;
    beforeDigest: string;
    afterDigest: string;
  }> | null;
  executableSha256: string | null;
  failureCode: string | null;
  cost: Readonly<{
    basis: 'policy-reservation-upper-bound';
    actualUsageReported: false;
    providerCostMicros: number;
    providerTokens: number;
    withinPolicyBudget: boolean;
  }>;
}>;

export type ProviderAvailabilityPilotRecord = Readonly<{
  schemaVersion: 1;
  kind: 'provider-availability-pilot-result.v1';
  pilotId: string;
  authority: 'empirical-observation-only';
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  policyDigest: string;
  startedAt: string;
  completedAt: string;
  decision: 'healthy-two-provider-observed' | 'incomplete';
  accepted: boolean;
  friction: Readonly<{
    providerWaitCount: number;
    collaborationGrantCount: 0;
    humanActionCount: 0;
  }>;
  totalProviderLatencyMs: number;
  totalReservedCostMicros: number;
  totalReservedTokens: number;
  observations: readonly ProviderAvailabilityPilotObservation[];
  recordDigest: string;
}>;

export type ProviderAvailabilityPilotRunResult = Readonly<{
  schemaVersion: 1;
  kind: 'provider-availability-pilot-run.v1';
  recordPath: string;
  record: ProviderAvailabilityPilotRecord;
}>;

type PilotRunOptions = Readonly<{ recordPath?: string }>;

export type ProviderAvailabilityPilotDependencies = Readonly<{
  now: () => Date;
  randomUUID: () => string;
  probe: (
    providerId: ProviderId,
    options: ProviderPreflightOptions,
  ) => AgentRuntimeProbeEvidenceV1;
  runProvider: (
    input: ProviderRunInput,
    options: ProviderRunOptions,
  ) => ProviderRunnerReport;
}>;

/** Compose bounded provider effects without giving them record authority. */
export function createProviderAvailabilityPilotRunner(
  dependencies: ProviderAvailabilityPilotDependencies,
): (
  cwd: string,
  options?: PilotRunOptions,
) => ProviderAvailabilityPilotRunResult {
  return (cwd, options = {}) =>
    runProviderAvailabilityPilotWithDependencies(cwd, options, dependencies);
}

export function verifyProviderAvailabilityPilot(
  cwd: string,
  requestedRecordPath: string,
): ProviderAvailabilityPilotRecord {
  const repository = discoverRepository(cwd);
  const recordPath = resolvePilotRecordPath(
    repository.repositoryRoot,
    requestedRecordPath,
  );
  const value = readPilotRecord(recordPath);
  return assertProviderAvailabilityPilotRecord(
    repository.repositoryRoot,
    value,
  );
}

function runProviderAvailabilityPilotWithDependencies(
  cwd: string,
  options: PilotRunOptions,
  dependencies: ProviderAvailabilityPilotDependencies,
): ProviderAvailabilityPilotRunResult {
  const repository = discoverRepository(cwd);
  if (repository.statusEntries.length !== 0) {
    throw pilotInvalid(
      'Provider availability pilot requires a clean exact-baseline worktree.',
    );
  }
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const loadedPolicy = loadAiAdapterPolicy(repository.repositoryRoot);
  const runtime = investigationRuntimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const startedAt = dependencies.now().toISOString();
  const runToken = normalizeRunToken(dependencies.randomUUID());
  const pilotId = `provider-availability-${runToken}`;
  const recordPath =
    options.recordPath ??
    `workflow/provider-availability-pilots/${pilotId}.json`;
  resolvePilotRecordPath(repository.repositoryRoot, recordPath);
  const preflightDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-provider-availability-'),
  );
  const observations: ProviderAvailabilityPilotObservation[] = [];
  try {
    for (const providerId of PROVIDERS) {
      const { resolution } = admitBuiltInProviderFamilyEvidence(
        dependencies.probe(providerId, {
          platform: process.platform,
          enabled: loadedPolicy.policy.providers[providerId].enabled,
          sourceEnvironment: process.env,
          temporaryDirectory: preflightDirectory,
        }),
        providerId,
      );
      const reservation =
        loadedPolicy.policy.retryAccounting.reservations[providerId];
      if (resolution.status !== 'available') {
        observations.push(
          unavailableObservation(
            providerId,
            resolution,
            reservation,
            loadedPolicy.policy.retryAccounting,
          ),
        );
        continue;
      }
      observations.push(
        runAvailableProvider({
          repository,
          config,
          runtime,
          loadedPolicy,
          pilotId,
          runToken,
          providerId,
          resolution,
          dependencies,
        }),
      );
    }
  } finally {
    fs.rmSync(preflightDirectory, { recursive: true, force: true });
  }

  const completedAt = dependencies.now().toISOString();
  const payload = createPilotRecordPayload({
    pilotId,
    repositoryId: config.repositoryName,
    baseCommit: repository.head,
    baseTree: repository.tree,
    policyDigest: loadedPolicy.digest,
    startedAt,
    completedAt,
    observations,
  });
  const record: ProviderAvailabilityPilotRecord = Object.freeze({
    ...payload,
    recordDigest: sha256(canonicalJson(payload)),
  });
  assertProviderAvailabilityPilotRecord(repository.repositoryRoot, record);
  writePilotRecord(
    resolvePilotRecordPath(repository.repositoryRoot, recordPath),
    record,
  );
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'provider-availability-pilot-run.v1' as const,
    recordPath,
    record,
  });
}

function runAvailableProvider(input: {
  repository: ReturnType<typeof discoverRepository>;
  config: ReturnType<typeof loadWorkflowConfig>;
  runtime: ReturnType<typeof investigationRuntimePaths>;
  loadedPolicy: ReturnType<typeof loadAiAdapterPolicy>;
  pilotId: string;
  runToken: string;
  providerId: ProviderId;
  resolution: ProviderResolution;
  dependencies: ProviderAvailabilityPilotDependencies;
}): ProviderAvailabilityPilotObservation {
  const {
    repository,
    config,
    runtime,
    loadedPolicy,
    pilotId,
    runToken,
    providerId,
    resolution,
    dependencies,
  } = input;
  const counterparty = providerId === 'codex' ? 'claude' : 'codex';
  const changeId = `provider-availability-${providerId}-${runToken}`;
  const investigationId = `investigation-${changeId}`;
  const invocationId = `invocation-${changeId}`;
  const manifest: BlindSurveyManifest = {
    schemaVersion: 1,
    kind: 'blind-survey-manifest',
    changeId,
    repositoryId: config.repositoryName,
    baseCommit: repository.head,
    baseTree: repository.tree,
    normalizedIntent: {
      schemaVersion: 1,
      summary:
        'Observe whether the ordinary Codex and Claude read-only provider pair is callable.',
      sourceRefs: [],
      explicitPaths: [],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    architectureQuestion:
      'Identify one exact repository term that demonstrates read-only repository access. Do not propose changes.',
    capabilityProfile: 'repository-read-only',
  };
  const targetDigest = blindSurveyIntentDigest(manifest);
  const scheduled = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    author: {
      providerId: counterparty,
      sessionId: `${pilotId}-${counterparty}-author`,
      principalId: counterparty,
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    },
    targetDigest,
    candidates: [
      {
        providerId,
        sessionId: `${pilotId}-${providerId}-survey`,
        enabled: true,
        available: true,
      },
    ],
  });
  if (scheduled.outcome !== 'assigned') {
    throw pilotInvalid(
      'The healthy provider could not receive an ordinary role.',
    );
  }
  const authorizationNode = createEvidenceNode({
    type: 'provider-availability-pilot-authorization',
    nodeSchema: PILOT_AUTHORIZATION_SCHEMA,
    evaluator: PILOT_EVALUATOR,
    policyDigest: loadedPolicy.digest,
    exactInputDigests: {
      assignment: sha256(canonicalJson(scheduled.assignment)),
      baseline: sha256(
        canonicalJson({ head: repository.head, tree: repository.tree }),
      ),
      pilot: sha256(canonicalJson({ pilotId, providerId })),
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: PILOT_AUTHORIZATION_OUTPUT_SCHEMA,
    output: {
      authority: 'empirical-observation-only',
      transitionAuthorized: false,
      assignment: scheduled.assignment,
    },
    runtimeMetadata: {},
  });
  writeEvidenceNode(runtime, authorizationNode);
  const request = createProviderInvocationRequest({
    invocationId,
    nonce: `${pilotId}-${providerId}`,
    purpose: 'survey',
    providerId,
    roleAssignment: scheduled.assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: config.repositoryName,
    baseCommit: repository.head,
    baseTree: repository.tree,
    targetDigest,
    inputManifestDigest: providerInvocationManifestDigest(manifest),
    authorizationNodeId: authorizationNode.nodeId,
    writeAllowedPaths: [],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey-evaluator.v1',
    policyDigest: loadedPolicy.digest,
    limits: {
      timeoutMs: loadedPolicy.policy.limits.timeoutMs,
      aggregateOutputBytes: loadedPolicy.policy.limits.aggregateOutputBytes,
    },
  });
  ensureProviderExecutionPolicySnapshot(runtime, request, loadedPolicy);
  const prepared = createProviderInvocation(runtime, {
    investigationId,
    changeId,
    attempt: 1,
    manifest,
    request,
  });
  const claim = claimProviderInvocation(runtime, invocationId, {
    workerId: `${pilotId}-${providerId}`,
    leaseDurationMs: request.limits.timeoutMs,
    expectedRevision: prepared.revision,
  });
  const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
    runtime,
    invocationId,
    'synchronous-no-activity',
  );
  try {
    const report = dependencies.runProvider(
      {
        providerId,
        repositoryRoot: repository.repositoryRoot,
        invocationDirectory: path.join(runtime.invocations, invocationId),
        request,
        semanticOutputSchema: BLIND_SURVEY_PROVIDER_OUTPUT_SCHEMA,
        outputValidator: blindSurveyOutputValidator(request),
        governedRuntimeInputs: [],
        acceptanceBinding,
        reviewSnapshotRoot: null,
        sourceEnvironment: process.env,
      },
      { platform: process.platform },
    );
    const terminal = completeProviderInvocationFromRunner(
      runtime,
      invocationId,
      {
        expectedRevision: claim.record.revision,
        leaseGeneration: claim.record.leaseGeneration,
        leaseToken: claim.leaseToken,
        report,
        acceptanceBinding,
      },
    );
    if (terminal.state !== 'succeeded' || terminal.result === null) {
      throw pilotInvalid('The provider result did not reach terminal success.');
    }
    return successfulObservation(
      providerId,
      resolution,
      request,
      authorizationNode.nodeId,
      report,
      loadedPolicy.policy.retryAccounting.reservations[providerId],
      loadedPolicy.policy.retryAccounting,
    );
  } catch (error) {
    const current = readProviderInvocation(runtime, invocationId);
    if (current.state !== 'leased') throw error;
    const code =
      error instanceof WorkflowError
        ? error.code
        : 'PROVIDER_AVAILABILITY_PILOT_PROVIDER_FAILED';
    failProviderInvocation(runtime, invocationId, {
      expectedRevision: claim.record.revision,
      leaseGeneration: claim.record.leaseGeneration,
      leaseToken: claim.leaseToken,
      failure: {
        kind: 'retryable',
        code,
        message: durableFailureMessage(
          `Provider availability observation failed durably (${code})`,
          error,
        ),
      },
    });
    return failedObservation(
      providerId,
      resolution,
      request,
      authorizationNode.nodeId,
      code,
      loadedPolicy.policy.retryAccounting.reservations[providerId],
      loadedPolicy.policy.retryAccounting,
    );
  }
}

// Keep the pair pinned to the complete built-in registry. Adding a provider is
// a schema change, not an implicit widening of the empirical claim.
if (
  canonicalJson(listBuiltInProviders().map(({ id }) => id)) !==
  canonicalJson(PROVIDERS)
) {
  throw pilotInvalid('The provider availability pilot registry is stale.');
}
