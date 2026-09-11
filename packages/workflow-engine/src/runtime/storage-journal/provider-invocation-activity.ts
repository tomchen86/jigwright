/**
 * Publishes and reads what a running provider invocation has been observed
 * doing, while it runs.
 *
 * Invariants:
 * - Activity is observation only: publishing never fails a run and a missing,
 *   superseded or unreadable publication reads as not-observed.
 * - A publication carries the lease generation that wrote it, so activity left
 *   by a superseded worker is never read as current.
 */
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { AgentRuntimeProcessProgressProjection } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import { assertAgentRuntimeProcessProgress } from '../../modules/provider-orchestration/provider-runtime-evidence.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import { providerInvocationDirectory } from './provider-invocation-common.ts';
import {
  privatePathExists,
  readPrivateCanonicalJson,
  writePrivateCanonicalJsonAtomic,
} from './investigation-private-files.ts';
import {
  hasExactKeys,
  isRecord,
  isTimestamp,
} from '../../modules/investigation/domain/investigation-store-values.ts';

/** Long enough to stay cheap over a half-hour run, short enough to answer
 * "is it still running?" without waiting. */
export const PROVIDER_ACTIVITY_HEARTBEAT_MS = 5_000;

export type ProviderInvocationActivityPublication = Readonly<{
  schemaVersion: 1;
  kind: 'provider-invocation-activity.v1';
  invocationId: string;
  leaseGeneration: number;
  workerId: string;
  progress: AgentRuntimeProcessProgressProjection;
  observedAt: string;
}>;

/**
 * What the current lease has been observed doing. `not-observed` is the honest
 * answer when nothing published: it means unknown, never "never started".
 */
export type ProviderInvocationActivity = Readonly<{
  state: 'not-observed' | AgentRuntimeProcessProgressProjection['processState'];
  observedAt: string | null;
  staleMs: number | null;
  eventCount: number;
  stdoutBytes: number;
  stderrBytes: number;
}>;

const NOT_OBSERVED: ProviderInvocationActivity = Object.freeze({
  state: 'not-observed' as const,
  observedAt: null,
  staleMs: null,
  eventCount: 0,
  stdoutBytes: 0,
  stderrBytes: 0,
});

function activityInvalid() {
  return workflowError(
    'PROVIDER_INVOCATION_ACTIVITY_INVALID',
    'Provider invocation activity is not a readable private publication.',
    ExitCode.verification,
  );
}

export function providerInvocationActivityPath(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): string {
  return path.join(
    providerInvocationDirectory(paths, invocationId),
    'activity.json',
  );
}

/**
 * Best effort by contract: a run that cannot publish its activity keeps
 * running, and the stale publication it leaves behind reads as stale.
 */
export function publishProviderInvocationActivity(
  paths: InvestigationRuntimePaths,
  input: Readonly<{
    invocationId: string;
    leaseGeneration: number;
    workerId: string;
    progress: AgentRuntimeProcessProgressProjection;
    observedAt?: string;
  }>,
): void {
  const publication: ProviderInvocationActivityPublication = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'provider-invocation-activity.v1' as const,
    invocationId: input.invocationId,
    leaseGeneration: input.leaseGeneration,
    workerId: input.workerId,
    progress: input.progress,
    observedAt: input.observedAt ?? new Date().toISOString(),
  });
  try {
    writePrivateCanonicalJsonAtomic(
      paths,
      providerInvocationActivityPath(paths, input.invocationId),
      publication,
      activityInvalid,
    );
  } catch {
    // Observation only. A publication that cannot be written must not end a
    // provider run that is otherwise healthy.
  }
}

export function readProviderInvocationActivity(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): ProviderInvocationActivityPublication | null {
  const filePath = providerInvocationActivityPath(paths, invocationId);
  try {
    if (!privatePathExists(paths, filePath, activityInvalid)) return null;
    const value = readPrivateCanonicalJson(paths, filePath, activityInvalid);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'invocationId',
        'leaseGeneration',
        'workerId',
        'progress',
        'observedAt',
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'provider-invocation-activity.v1' ||
      value.invocationId !== invocationId ||
      !Number.isSafeInteger(value.leaseGeneration) ||
      (value.leaseGeneration as number) < 0 ||
      typeof value.workerId !== 'string' ||
      value.workerId.length === 0 ||
      !isTimestamp(value.observedAt)
    ) {
      return null;
    }
    return Object.freeze({
      schemaVersion: 1 as const,
      kind: 'provider-invocation-activity.v1' as const,
      invocationId,
      leaseGeneration: value.leaseGeneration as number,
      workerId: value.workerId,
      progress: assertAgentRuntimeProcessProgress(
        value.progress,
        activityInvalid,
      ),
      observedAt: value.observedAt as string,
    });
  } catch {
    return null;
  }
}

/**
 * Answers "has this lease been observed running?" without ever turning an
 * unreadable observation into a claim about the process.
 */
export function inspectProviderInvocationActivity(
  paths: InvestigationRuntimePaths,
  invocation: Readonly<{ invocationId: string; leaseGeneration: number }>,
  now: () => number = Date.now,
): ProviderInvocationActivity {
  const published = readProviderInvocationActivity(
    paths,
    invocation.invocationId,
  );
  if (
    published === null ||
    published.leaseGeneration !== invocation.leaseGeneration
  ) {
    return NOT_OBSERVED;
  }
  const observedAtMs = Date.parse(published.observedAt);
  return Object.freeze({
    state: published.progress.processState,
    observedAt: published.observedAt,
    staleMs: Number.isNaN(observedAtMs)
      ? null
      : Math.max(0, now() - observedAtMs),
    eventCount: published.progress.eventCount,
    stdoutBytes: published.progress.stdoutBytes,
    stderrBytes: published.progress.stderrBytes,
  });
}

/**
 * Publishes the current projection now and on every tick until stopped, so a
 * run that is still alive keeps saying so and a run that died stops.
 */
export function startProviderInvocationActivityHeartbeat(
  paths: InvestigationRuntimePaths,
  input: Readonly<{
    invocationId: string;
    leaseGeneration: number;
    workerId: string;
    progress: () => AgentRuntimeProcessProgressProjection;
  }>,
  intervalMs: number = PROVIDER_ACTIVITY_HEARTBEAT_MS,
): Readonly<{ stop: () => void }> {
  const publish = (): void => {
    publishProviderInvocationActivity(paths, {
      invocationId: input.invocationId,
      leaseGeneration: input.leaseGeneration,
      workerId: input.workerId,
      progress: input.progress(),
    });
  };
  publish();
  const timer = setInterval(publish, intervalMs);
  timer.unref?.();
  return Object.freeze({
    stop: (): void => {
      clearInterval(timer);
      publish();
    },
  });
}
