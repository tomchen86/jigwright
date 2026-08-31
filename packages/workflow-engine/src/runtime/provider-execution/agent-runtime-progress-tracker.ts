import type {
  AgentRuntimeProcessActivity,
  AgentRuntimeProcessProgressProjection,
} from '../../modules/provider-orchestration/agent-runtime-port.ts';

export type AgentRuntimeProgressTracker = Readonly<{
  record(event: AgentRuntimeProcessActivity): void;
  assertSuccessfulCompletion(): void;
  snapshot(): AgentRuntimeProcessProgressProjection;
}>;

export function createAgentRuntimeProgressTracker(): AgentRuntimeProgressTracker {
  let processState: AgentRuntimeProcessProgressProjection['processState'] =
    'not-started';
  let eventCount = 0;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let lastProcessActivityElapsedMs: number | null = null;
  let lastProviderActivityElapsedMs: number | null = null;

  const record = (event: AgentRuntimeProcessActivity): void => {
    if (!isAgentRuntimeActivityType(event.type)) {
      throw new TypeError('Agent Runtime activity type is unknown.');
    }
    if (
      !Number.isSafeInteger(event.elapsedMs) ||
      event.elapsedMs < 0 ||
      (lastProcessActivityElapsedMs !== null &&
        event.elapsedMs < lastProcessActivityElapsedMs)
    ) {
      throw new TypeError('Agent Runtime activity elapsed time is invalid.');
    }
    if (processState !== 'not-started' && processState !== 'running') {
      throw new TypeError('Agent Runtime emitted activity after termination.');
    }
    if (event.type === 'spawned') {
      if (processState !== 'not-started' || event.bytes !== undefined) {
        throw new TypeError('Agent Runtime emitted an invalid spawn event.');
      }
      processState = 'running';
    } else if (event.type === 'stdout' || event.type === 'stderr') {
      if (
        processState !== 'running' ||
        !Number.isSafeInteger(event.bytes) ||
        event.bytes! < 0
      ) {
        throw new TypeError('Agent Runtime emitted invalid stream activity.');
      }
      if (event.type === 'stdout') stdoutBytes += event.bytes!;
      else stderrBytes += event.bytes!;
      if (!Number.isSafeInteger(stdoutBytes + stderrBytes)) {
        throw new TypeError('Agent Runtime activity byte count overflowed.');
      }
      lastProviderActivityElapsedMs = event.elapsedMs;
    } else {
      if (event.bytes !== undefined) {
        throw new TypeError('Agent Runtime termination carried byte data.');
      }
      processState = event.type;
    }
    eventCount += 1;
    if (!Number.isSafeInteger(eventCount)) {
      throw new TypeError('Agent Runtime activity event count overflowed.');
    }
    lastProcessActivityElapsedMs = event.elapsedMs;
  };

  return Object.freeze({
    record,
    assertSuccessfulCompletion(): void {
      if (processState !== 'exited') {
        throw new TypeError(
          'Agent Runtime completed without an observed successful process exit.',
        );
      }
    },
    snapshot(): AgentRuntimeProcessProgressProjection {
      return Object.freeze({
        schemaVersion: 1,
        kind: 'agent-runtime-process-progress',
        processState,
        eventCount,
        stdoutBytes,
        stderrBytes,
        lastProcessActivityElapsedMs,
        lastProviderActivityElapsedMs,
      });
    },
  });
}

function isAgentRuntimeActivityType(
  value: unknown,
): value is AgentRuntimeProcessActivity['type'] {
  return (
    value === 'spawned' ||
    value === 'stdout' ||
    value === 'stderr' ||
    value === 'exited' ||
    value === 'timed-out' ||
    value === 'cancelled' ||
    value === 'output-limit' ||
    value === 'spawn-error' ||
    value === 'protocol-error'
  );
}
