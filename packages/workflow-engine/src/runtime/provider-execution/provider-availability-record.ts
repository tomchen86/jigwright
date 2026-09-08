/**
 * Build, validate, and persist exact provider availability pilot observations.
 *
 * Invariants:
 * - Record schemas, canonical digest bytes, observation limits, and atomic writes stay unchanged.
 * - Rejected records never become verified availability evidence.
 *
 * Depends on: provider resolution contracts, Git identity formats, and bounded filesystem reads.
 * Failure modes: Invalid observations or altered record identities can be accepted as current.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type AiAdapterProviderReservation,
  loadAiAdapterPolicy,
  parseAiAdapterPolicyDocument,
} from './ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import {
  WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';
import { runGit } from '../repository-transaction/git.ts';
import { normalizeExactRepositoryPath } from '../session-workspace/paths.ts';
import {
  type ProviderInvocationRequest,
  type ProviderRunnerReport,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import { type ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import type { ProviderResolution } from './provider-runner.ts';
import {
  type ProviderAvailabilityPilotObservation,
  type ProviderAvailabilityPilotRecord,
} from './provider-availability-pilot.ts';

const SHA256 = /^[0-9a-f]{64}$/u;

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

const PILOT_RECORD_PATH =
  /^workflow\/provider-availability-pilots\/[a-z0-9][a-z0-9-]{0,127}\.json$/u;

export const PROVIDERS = Object.freeze(['codex', 'claude'] as const);

export function successfulObservation(
  providerId: ProviderId,
  resolution: ProviderResolution,
  request: ProviderInvocationRequest,
  authorizationNodeId: string,
  report: ProviderRunnerReport,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
): ProviderAvailabilityPilotObservation {
  return Object.freeze({
    providerId,
    role: 'plan-reviewer' as const,
    state: 'succeeded' as const,
    resolutionStatus: 'available' as const,
    version: resolution.version ?? null,
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    outputDigest: report.semanticOutputDigest,
    authorizationNodeId,
    achievedIndependence: 'provider-independent' as const,
    grantUsed: false as const,
    providerLatencyMs: report.elapsedMs,
    mutationObservation: Object.freeze({
      assurance: 'unchanged-governed-projection' as const,
      unchanged: true as const,
      beforeDigest: report.projection.beforeDigest,
      afterDigest: report.projection.afterDigest,
    }),
    executableSha256: report.executable.sha256,
    failureCode: null,
    cost: costObservation(providerId, reservation, accounting),
  });
}

export function unavailableObservation(
  providerId: ProviderId,
  resolution: ProviderResolution,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
): ProviderAvailabilityPilotObservation {
  return Object.freeze({
    providerId,
    role: 'plan-reviewer' as const,
    state: 'unavailable' as const,
    resolutionStatus: resolution.status,
    version: resolution.version ?? null,
    invocationId: null,
    requestDigest: null,
    outputDigest: null,
    authorizationNodeId: null,
    achievedIndependence: null,
    grantUsed: false as const,
    providerLatencyMs: 0,
    mutationObservation: null,
    executableSha256: resolution.executable?.sha256 ?? null,
    failureCode: null,
    cost: costObservation(providerId, reservation, accounting),
  });
}

export function failedObservation(
  providerId: ProviderId,
  resolution: ProviderResolution,
  request: ProviderInvocationRequest,
  authorizationNodeId: string,
  failureCode: string,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
): ProviderAvailabilityPilotObservation {
  return Object.freeze({
    providerId,
    role: 'plan-reviewer' as const,
    state: 'failed' as const,
    resolutionStatus: 'available' as const,
    version: resolution.version ?? null,
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    outputDigest: null,
    authorizationNodeId,
    achievedIndependence: 'provider-independent' as const,
    grantUsed: false as const,
    providerLatencyMs: 0,
    mutationObservation: null,
    executableSha256: resolution.executable?.sha256 ?? null,
    failureCode,
    cost: costObservation(providerId, reservation, accounting),
  });
}

function costObservation(
  providerId: ProviderId,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
) {
  return Object.freeze({
    basis: 'policy-reservation-upper-bound' as const,
    actualUsageReported: false as const,
    providerCostMicros: reservation.providerCostMicros,
    providerTokens: reservation.providerTokens,
    withinPolicyBudget:
      reservation.providerCostMicros <= accounting.maxProviderCostMicros &&
      reservation.providerTokens <= accounting.maxProviderTokens &&
      accounting.providerLimits[providerId] >= 1,
  });
}

export function createPilotRecordPayload(input: {
  pilotId: string;
  repositoryId: string;
  baseCommit: string;
  baseTree: string;
  policyDigest: string;
  startedAt: string;
  completedAt: string;
  observations: readonly ProviderAvailabilityPilotObservation[];
}) {
  const accepted = input.observations.every(
    ({ state, cost }) => state === 'succeeded' && cost.withinPolicyBudget,
  );
  return {
    schemaVersion: 1 as const,
    kind: 'provider-availability-pilot-result.v1' as const,
    pilotId: input.pilotId,
    authority: 'empirical-observation-only' as const,
    repositoryId: input.repositoryId,
    baseCommit: input.baseCommit,
    baseTree: input.baseTree,
    policyDigest: input.policyDigest,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    decision: accepted
      ? ('healthy-two-provider-observed' as const)
      : ('incomplete' as const),
    accepted,
    friction: {
      providerWaitCount: input.observations.filter(
        ({ state }) => state !== 'succeeded',
      ).length,
      collaborationGrantCount: 0 as const,
      humanActionCount: 0 as const,
    },
    totalProviderLatencyMs: input.observations.reduce(
      (sum, { providerLatencyMs }) => sum + providerLatencyMs,
      0,
    ),
    totalReservedCostMicros: input.observations.reduce(
      (sum, { cost }) => sum + cost.providerCostMicros,
      0,
    ),
    totalReservedTokens: input.observations.reduce(
      (sum, { cost }) => sum + cost.providerTokens,
      0,
    ),
    observations: [...input.observations],
  };
}

export function assertProviderAvailabilityPilotRecord(
  repositoryRoot: string,
  value: unknown,
): ProviderAvailabilityPilotRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'pilotId',
      'authority',
      'repositoryId',
      'baseCommit',
      'baseTree',
      'policyDigest',
      'startedAt',
      'completedAt',
      'decision',
      'accepted',
      'friction',
      'totalProviderLatencyMs',
      'totalReservedCostMicros',
      'totalReservedTokens',
      'observations',
      'recordDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'provider-availability-pilot-result.v1' ||
    typeof value.pilotId !== 'string' ||
    !/^provider-availability-[a-z0-9]{32}$/u.test(value.pilotId) ||
    value.authority !== 'empirical-observation-only' ||
    typeof value.repositoryId !== 'string' ||
    value.repositoryId.length === 0 ||
    typeof value.baseCommit !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseCommit) ||
    typeof value.baseTree !== 'string' ||
    !GIT_OBJECT_ID.test(value.baseTree) ||
    typeof value.policyDigest !== 'string' ||
    !SHA256.test(value.policyDigest) ||
    !isTimestamp(value.startedAt) ||
    !isTimestamp(value.completedAt) ||
    Date.parse(value.completedAt) < Date.parse(value.startedAt) ||
    (value.decision !== 'healthy-two-provider-observed' &&
      value.decision !== 'incomplete') ||
    typeof value.accepted !== 'boolean' ||
    !isRecord(value.friction) ||
    !hasExactKeys(value.friction, [
      'providerWaitCount',
      'collaborationGrantCount',
      'humanActionCount',
    ]) ||
    !isNonNegativeInteger(value.friction.providerWaitCount) ||
    value.friction.collaborationGrantCount !== 0 ||
    value.friction.humanActionCount !== 0 ||
    !isNonNegativeInteger(value.totalProviderLatencyMs) ||
    !isNonNegativeInteger(value.totalReservedCostMicros) ||
    !isNonNegativeInteger(value.totalReservedTokens) ||
    !Array.isArray(value.observations) ||
    value.observations.length !== PROVIDERS.length ||
    typeof value.recordDigest !== 'string' ||
    !SHA256.test(value.recordDigest)
  ) {
    throw pilotInvalid();
  }
  const policyContent = runGit(repositoryRoot, [
    'show',
    `${value.baseCommit}:workflow/ai-adapter-policy.json`,
  ]);
  const loadedPolicy = parseAiAdapterPolicyDocument(policyContent);
  const baseTree = runGit(repositoryRoot, [
    'rev-parse',
    `${value.baseCommit}^{tree}`,
  ]).trim();
  const config = JSON.parse(
    runGit(repositoryRoot, [
      'show',
      `${value.baseCommit}:workflow/config.json`,
    ]),
  ) as unknown;
  if (
    loadedPolicy.digest !== value.policyDigest ||
    baseTree !== value.baseTree ||
    !isRecord(config) ||
    config.repositoryName !== value.repositoryId
  ) {
    throw pilotInvalid();
  }
  const observations = value.observations.map((observation, index) =>
    assertPilotObservation(
      observation,
      PROVIDERS[index]!,
      loadedPolicy.policy.retryAccounting.reservations[PROVIDERS[index]!],
      loadedPolicy.policy.retryAccounting,
      loadedPolicy.policy.limits.timeoutMs,
    ),
  );
  const expectedPayload = createPilotRecordPayload({
    pilotId: value.pilotId,
    repositoryId: value.repositoryId,
    baseCommit: value.baseCommit,
    baseTree: value.baseTree,
    policyDigest: value.policyDigest,
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    observations,
  });
  const actualPayload = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== 'recordDigest'),
  );
  if (
    canonicalJson(expectedPayload) !== canonicalJson(actualPayload) ||
    value.recordDigest !== sha256(canonicalJson(expectedPayload))
  ) {
    throw pilotInvalid();
  }
  return Object.freeze(
    structuredClone(value),
  ) as ProviderAvailabilityPilotRecord;
}

function assertPilotObservation(
  value: unknown,
  expectedProviderId: ProviderId,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
  timeoutMs: number,
): ProviderAvailabilityPilotObservation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerId',
      'role',
      'state',
      'resolutionStatus',
      'version',
      'invocationId',
      'requestDigest',
      'outputDigest',
      'authorizationNodeId',
      'achievedIndependence',
      'grantUsed',
      'providerLatencyMs',
      'mutationObservation',
      'executableSha256',
      'failureCode',
      'cost',
    ]) ||
    value.providerId !== expectedProviderId ||
    value.role !== 'plan-reviewer' ||
    !['succeeded', 'unavailable', 'failed'].includes(value.state as string) ||
    !isResolutionStatus(value.resolutionStatus) ||
    (value.version !== null && typeof value.version !== 'string') ||
    value.grantUsed !== false ||
    !isNonNegativeInteger(value.providerLatencyMs) ||
    value.providerLatencyMs > timeoutMs ||
    (value.executableSha256 !== null &&
      (typeof value.executableSha256 !== 'string' ||
        !SHA256.test(value.executableSha256))) ||
    !isCostObservation(value.cost, expectedProviderId, reservation, accounting)
  ) {
    throw pilotInvalid();
  }
  const boundStrings = [
    value.invocationId,
    value.requestDigest,
    value.outputDigest,
    value.authorizationNodeId,
  ];
  if (value.state === 'succeeded') {
    if (
      value.resolutionStatus !== 'available' ||
      typeof value.invocationId !== 'string' ||
      !isInvocationId(value.invocationId) ||
      [value.requestDigest, value.outputDigest, value.authorizationNodeId].some(
        (entry) => typeof entry !== 'string' || !SHA256.test(entry),
      ) ||
      value.achievedIndependence !== 'provider-independent' ||
      value.failureCode !== null ||
      !isRecord(value.mutationObservation) ||
      !hasExactKeys(value.mutationObservation, [
        'assurance',
        'unchanged',
        'beforeDigest',
        'afterDigest',
      ]) ||
      value.mutationObservation.assurance !== 'unchanged-governed-projection' ||
      value.mutationObservation.unchanged !== true ||
      typeof value.mutationObservation.beforeDigest !== 'string' ||
      !SHA256.test(value.mutationObservation.beforeDigest) ||
      value.mutationObservation.afterDigest !==
        value.mutationObservation.beforeDigest ||
      value.executableSha256 === null
    ) {
      throw pilotInvalid();
    }
  } else if (value.state === 'unavailable') {
    if (
      value.resolutionStatus === 'available' ||
      boundStrings.some((entry) => entry !== null) ||
      value.achievedIndependence !== null ||
      value.providerLatencyMs !== 0 ||
      value.mutationObservation !== null ||
      value.failureCode !== null
    ) {
      throw pilotInvalid();
    }
  } else if (
    value.resolutionStatus !== 'available' ||
    typeof value.invocationId !== 'string' ||
    !isInvocationId(value.invocationId) ||
    typeof value.requestDigest !== 'string' ||
    !SHA256.test(value.requestDigest) ||
    value.outputDigest !== null ||
    typeof value.authorizationNodeId !== 'string' ||
    !SHA256.test(value.authorizationNodeId) ||
    value.achievedIndependence !== 'provider-independent' ||
    value.providerLatencyMs !== 0 ||
    value.mutationObservation !== null ||
    typeof value.failureCode !== 'string' ||
    value.failureCode.length === 0
  ) {
    throw pilotInvalid();
  }
  return Object.freeze(
    structuredClone(value),
  ) as ProviderAvailabilityPilotObservation;
}

function isCostObservation(
  value: unknown,
  providerId: ProviderId,
  reservation: AiAdapterProviderReservation,
  accounting: ReturnType<
    typeof loadAiAdapterPolicy
  >['policy']['retryAccounting'],
): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [
      'basis',
      'actualUsageReported',
      'providerCostMicros',
      'providerTokens',
      'withinPolicyBudget',
    ]) &&
    value.basis === 'policy-reservation-upper-bound' &&
    value.actualUsageReported === false &&
    value.providerCostMicros === reservation.providerCostMicros &&
    value.providerTokens === reservation.providerTokens &&
    value.withinPolicyBudget ===
      (reservation.providerCostMicros <= accounting.maxProviderCostMicros &&
        reservation.providerTokens <= accounting.maxProviderTokens &&
        accounting.providerLimits[providerId] >= 1)
  );
}

export function resolvePilotRecordPath(
  repositoryRoot: string,
  requestedPath: string,
): string {
  let normalized: string;
  try {
    normalized = normalizeExactRepositoryPath(requestedPath);
  } catch {
    throw pilotInvalid('The pilot record path is invalid.');
  }
  if (!PILOT_RECORD_PATH.test(normalized)) {
    throw pilotInvalid(
      'The pilot record must use the governed pilot directory.',
    );
  }
  return path.join(repositoryRoot, normalized);
}

export function writePilotRecord(
  recordPath: string,
  record: ProviderAvailabilityPilotRecord,
): void {
  const directory = path.dirname(recordPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStats = fs.lstatSync(directory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw pilotInvalid('The pilot record directory is unsafe.');
  }
  const noFollow =
    process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(
      recordPath,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        noFollow,
      0o600,
    );
    fs.writeFileSync(descriptor, `${canonicalJson(record)}\n`);
    fs.fsyncSync(descriptor);
  } catch (error) {
    throw pilotInvalid('The pilot record could not be created.', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function readPilotRecord(recordPath: string): unknown {
  const noFollow =
    process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(recordPath, fs.constants.O_RDONLY | noFollow);
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > 1024 * 1024) {
      throw pilotInvalid();
    }
    return JSON.parse(fs.readFileSync(descriptor, 'utf8'));
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw pilotInvalid('The pilot record is unreadable.', error);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function normalizeRunToken(value: string): string {
  const token = value.replaceAll('-', '').toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(token)) throw pilotInvalid();
  return token;
}

function isResolutionStatus(
  value: unknown,
): value is ProviderResolution['status'] {
  return [
    'disabled',
    'unsupported-platform',
    'absent',
    'unsafe-candidate',
    'incompatible',
    'unauthenticated',
    'available',
  ].includes(value as string);
}

function isInvocationId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) ===
    canonicalJson([...expected].sort())
  );
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function pilotInvalid(
  message = 'Provider availability pilot is invalid.',
  cause?: unknown,
) {
  return workflowError(
    'PROVIDER_AVAILABILITY_PILOT_INVALID',
    message,
    ExitCode.guard,
    cause === undefined
      ? undefined
      : {
          details: {
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        },
  );
}
