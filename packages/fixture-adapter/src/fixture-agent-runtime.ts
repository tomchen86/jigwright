import crypto from 'node:crypto';

import {
  AGENT_RUNTIME_PORT_V1_CONTRACT_VERSION,
  AgentRuntimePortContractError,
  agentRuntimeContinuityTokenDigestV1,
  agentRuntimeNativeSessionIdDigestV1,
  assertAgentRuntimeCancelInputV1,
  assertAgentRuntimeDefinitionIdentityV1,
  assertAgentRuntimeResumeInputV1,
  assertAgentRuntimeStartInputV1,
  createAgentRuntimeCancelResultV1,
  createAgentRuntimeCapabilitiesV1,
  createAgentRuntimeEventV1,
  createAgentRuntimeProbeEvidenceV1,
  type AgentRuntimeAttemptBindingV1,
  type AgentRuntimeCancelResultV1,
  type AgentRuntimeDefinitionIdentityV1,
  type AgentRuntimeEventV1,
  type AgentRuntimeExecutableIdentityV1,
  type AgentRuntimePortV1,
  type AgentRuntimePrivateSessionIdentityV1,
  type AgentRuntimeResumeInputV1,
  type AgentRuntimeStartInputV1,
} from '@jigwright/core/agent-runtime-port';
import { canonicalJson } from '@jigwright/core/canonical-json';

const TERMINAL_TOMBSTONE_LIMIT = 64;
const SESSION_LIMIT = 64;
const FIXTURE_PROVIDER_VERSION = 'fixture-agent-runtime-1';

const FIXTURE_AGENT_RUNTIME_DEFINITION_VALUE_V1 = Object.freeze({
  schemaVersion: 1,
  kind: 'fixture-agent-runtime-definition.v1',
  providerFamily: 'fixture',
  protocol: 'fixture-events-v1',
  definitionDigest:
    '129aa596beb9bea7221ede95c9fcd6e83b29118a298cabcc54b6496ebfa85199',
});

export const FIXTURE_AGENT_RUNTIME_DEFINITION_V1 =
  assertAgentRuntimeDefinitionIdentityV1(
    FIXTURE_AGENT_RUNTIME_DEFINITION_VALUE_V1,
  ) as typeof FIXTURE_AGENT_RUNTIME_DEFINITION_VALUE_V1 &
    AgentRuntimeDefinitionIdentityV1;

export const FIXTURE_AGENT_RUNTIME_EXECUTABLE_IDENTITY_V1 = Object.freeze({
  candidatePath: '/synthetic-fixture/bin/agent-runtime',
  realPath: '/synthetic-fixture/bin/agent-runtime',
  device: '0',
  inode: '1',
  mode: 0o100555,
  uid: 0,
  gid: 0,
  size: 1,
  mtimeNs: '0',
  sha256: '86a8ea21c700476e4363c810426e90e1ba8ef92491f42cbecc2c984b5ea146a9',
}) satisfies AgentRuntimeExecutableIdentityV1;

export class FixtureAgentRuntimeOperationConflictError extends Error {
  readonly code = 'AGENT_RUNTIME_OPERATION_CONFLICT';

  constructor() {
    super('Fixture agent runtime operation is already active or terminal.');
    this.name = 'FixtureAgentRuntimeOperationConflictError';
  }
}

type FixtureOperation = {
  readonly binding: AgentRuntimeAttemptBindingV1;
  readonly controller: AbortController;
  readonly startedAt: number;
  state: 'running' | 'cancel-requested' | 'terminal';
};

type FixtureSession = Readonly<{
  nativeSessionId: string;
  nativeSessionIdDigest: string;
  continuityToken: string;
  predecessorCompletionDigest: string;
}>;

type FixturePrivateSessionIdentity = AgentRuntimePrivateSessionIdentityV1 &
  Readonly<{ continuityToken: string }>;

/** A deterministic second implementation that consumes only public core DTOs. */
export function createFixtureAgentRuntimeV1(): AgentRuntimePortV1<
  typeof FIXTURE_AGENT_RUNTIME_DEFINITION_V1
> {
  const definition = assertAgentRuntimeDefinitionIdentityV1(
    FIXTURE_AGENT_RUNTIME_DEFINITION_V1,
  ) as typeof FIXTURE_AGENT_RUNTIME_DEFINITION_V1;
  const capabilities = createAgentRuntimeCapabilitiesV1({
    structuredStreaming: true,
    structuredOutput: true,
    resumableAfterTurn: true,
    forkable: false,
    reattachableInFlight: false,
    cancellationAck: true,
    usageReporting: 'actual',
  });
  const active = new Map<string, FixtureOperation>();
  const tombstones = new Map<string, string>();
  const sessions = new Map<string, FixtureSession>();
  const activeSessionDigests = new Set<string>();
  let probed = false;

  const reserve = (binding: AgentRuntimeAttemptBindingV1): FixtureOperation => {
    if (
      active.has(binding.operationId) ||
      tombstones.has(binding.operationId)
    ) {
      throw operationConflict();
    }
    const operation: FixtureOperation = {
      binding,
      controller: new AbortController(),
      startedAt: Date.now(),
      state: 'running',
    };
    active.set(binding.operationId, operation);
    return operation;
  };

  const terminalize = (operation: FixtureOperation): void => {
    operation.state = 'terminal';
    active.delete(operation.binding.operationId);
    tombstones.delete(operation.binding.operationId);
    tombstones.set(
      operation.binding.operationId,
      operation.binding.bindingDigest,
    );
    while (tombstones.size > TERMINAL_TOMBSTONE_LIMIT) {
      const oldest = tombstones.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      tombstones.delete(oldest);
    }
  };

  const executionStream = (
    binding: AgentRuntimeAttemptBindingV1,
    input: AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1,
    resumeSession: FixtureSession | null,
  ): AsyncIterable<AgentRuntimeEventV1> => {
    let consumed = false;
    return Object.freeze({
      [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEventV1> {
        if (consumed) throw operationConflict();
        consumed = true;
        let iterator: AsyncIterator<AgentRuntimeEventV1> | null = null;
        let closed = false;
        const initialize = (): AsyncIterator<AgentRuntimeEventV1> => {
          if (closed) throw operationConflict();
          if (iterator !== null) return iterator;
          if (!probed) throw invalidContract();
          if (
            resumeSession !== null &&
            (sessions.get(resumeSession.nativeSessionIdDigest) !==
              resumeSession ||
              activeSessionDigests.has(resumeSession.nativeSessionIdDigest))
          ) {
            throw invalidContract();
          }
          const operation = reserve(binding);
          if (resumeSession !== null) {
            activeSessionDigests.add(resumeSession.nativeSessionIdDigest);
          }
          iterator = runFixture(
            operation,
            input,
            resumeSession,
            sessions,
            (terminalOperation) => {
              if (resumeSession !== null) {
                activeSessionDigests.delete(
                  resumeSession.nativeSessionIdDigest,
                );
              }
              terminalize(terminalOperation);
            },
          );
          return iterator;
        };
        return Object.freeze({
          next(): Promise<IteratorResult<AgentRuntimeEventV1>> {
            if (closed) {
              return Promise.resolve({ done: true, value: undefined });
            }
            try {
              return Promise.resolve(initialize().next());
            } catch (error) {
              return Promise.reject(error);
            }
          },
          return(): Promise<IteratorResult<AgentRuntimeEventV1>> {
            closed = true;
            if (iterator === null || iterator.return === undefined) {
              return Promise.resolve({ done: true, value: undefined });
            }
            try {
              return Promise.resolve(iterator.return());
            } catch (error) {
              return Promise.reject(error);
            }
          },
          throw(error?: unknown): Promise<IteratorResult<AgentRuntimeEventV1>> {
            closed = true;
            if (iterator === null || iterator.throw === undefined) {
              return Promise.reject(error);
            }
            try {
              return Promise.resolve(iterator.throw(error));
            } catch (thrown) {
              return Promise.reject(thrown);
            }
          },
        });
      },
    });
  };

  const port: AgentRuntimePortV1<typeof FIXTURE_AGENT_RUNTIME_DEFINITION_V1> = {
    contractVersion: AGENT_RUNTIME_PORT_V1_CONTRACT_VERSION,
    probe(snapshot) {
      assertExactDefinition(snapshot, definition);
      probed = true;
      return Promise.resolve(
        createAgentRuntimeProbeEvidenceV1({
          authority: 'observation-only',
          observationClass: 'synthetic-fixture',
          definition,
          status: 'ready',
          executableIdentity: FIXTURE_AGENT_RUNTIME_EXECUTABLE_IDENTITY_V1,
          providerVersion: FIXTURE_PROVIDER_VERSION,
          authentication: 'not-observed',
          capabilities,
        }),
      );
    },
    start(snapshot, rawInput) {
      assertExactDefinition(snapshot, definition);
      const input = assertAgentRuntimeStartInputV1(rawInput);
      assertBindingDefinition(input.binding, definition);
      if (!probed) throw invalidContract();
      return executionStream(input.binding, input, null);
    },
    resume(snapshot, rawInput) {
      assertExactDefinition(snapshot, definition);
      const input = assertAgentRuntimeResumeInputV1(rawInput);
      assertBindingDefinition(input.binding, definition);
      if (!probed) throw invalidContract();
      const resumeSession = assertResumeSession(input, sessions);
      return executionStream(input.binding, input, resumeSession);
    },
    async cancel(rawInput): Promise<AgentRuntimeCancelResultV1> {
      const input = assertAgentRuntimeCancelInputV1(rawInput);
      assertBindingDefinition(input.binding, definition);
      const operation = active.get(input.binding.operationId);
      if (operation === undefined) {
        const tombstone = tombstones.get(input.binding.operationId);
        if (
          tombstone !== undefined &&
          tombstone !== input.binding.bindingDigest
        ) {
          throw operationConflict();
        }
        return createAgentRuntimeCancelResultV1(input.binding, {
          status: tombstone === undefined ? 'not-active' : 'already-terminal',
          acknowledged: false,
          forced: false,
        });
      }
      if (operation.binding.bindingDigest !== input.binding.bindingDigest) {
        throw operationConflict();
      }
      operation.state = 'cancel-requested';
      operation.controller.abort(input.reason);
      return createAgentRuntimeCancelResultV1(input.binding, {
        status: 'cancelled',
        acknowledged: true,
        forced: false,
      });
    },
  };
  return Object.freeze(port);
}

async function* runFixture(
  operation: FixtureOperation,
  input: AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1,
  resumeSession: FixtureSession | null,
  sessions: Map<string, FixtureSession>,
  terminalize: (operation: FixtureOperation) => void,
): AsyncGenerator<AgentRuntimeEventV1> {
  let eventCount = 0;
  let aggregateBytes = 0;
  let terminalDelivered = false;
  let executionCompleted = false;
  const bounded = (event: AgentRuntimeEventV1): AgentRuntimeEventV1 => {
    eventCount += 1;
    const eventBytes = Buffer.byteLength(canonicalJson(event), 'utf8');
    if (
      eventCount > input.limits.maxEventCount ||
      aggregateBytes + eventBytes > input.limits.aggregateOutputBytes ||
      Date.now() - operation.startedAt > input.limits.timeoutMs
    ) {
      throw invalidContract();
    }
    aggregateBytes += eventBytes;
    return event;
  };
  try {
    const preSessionEvents = [
      createAgentRuntimeEventV1({
        type: 'process-activity',
        activity: 'spawned',
        elapsedMs: 0,
      }),
      createAgentRuntimeEventV1({
        type: 'provider-activity',
        phase: 'model',
        elapsedMs: 1,
      }),
    ];
    for (const event of preSessionEvents) {
      if (operation.controller.signal.aborted) {
        const terminal = createAgentRuntimeEventV1({
          type: 'cancelled',
          acknowledged: true,
          forced: false,
          elapsedMs: elapsed(operation),
        });
        terminalDelivered = true;
        executionCompleted = true;
        yield terminal;
        return;
      }
      yield bounded(event);
    }

    const sessionIdentity = createFixtureSessionIdentity(
      operation,
      input,
      resumeSession,
    );
    if (sessionIdentity !== null) {
      yield bounded(
        createAgentRuntimeEventV1({
          type: 'session-started',
          action: input.action,
          nativeSessionIdDigest: sessionIdentity.nativeSessionIdDigest,
          continuityTokenDigest: agentRuntimeContinuityTokenDigestV1(
            sessionIdentity.continuityToken,
          ),
          protocolReceiptDigest: sessionIdentity.protocolReceiptDigest,
          elapsedMs: 2,
        }),
      );
    }
    if (operation.controller.signal.aborted) {
      terminalDelivered = true;
      executionCompleted = true;
      yield createAgentRuntimeEventV1({
        type: 'cancelled',
        acknowledged: true,
        forced: false,
        elapsedMs: elapsed(operation),
      });
      return;
    }

    const contentEvents = [
      createAgentRuntimeEventV1({
        type: 'semantic-progress',
        summary: 'fixture-result-ready',
        elapsedMs: 3,
      }),
      createAgentRuntimeEventV1({
        type: 'usage',
        basis: 'actual',
        inputTokens: Buffer.byteLength(input.prompt, 'utf8'),
        outputTokens: 1,
        costMicros: 0,
        elapsedMs: 4,
      }),
    ];
    for (const event of contentEvents) {
      if (operation.controller.signal.aborted) {
        terminalDelivered = true;
        executionCompleted = true;
        yield createAgentRuntimeEventV1({
          type: 'cancelled',
          acknowledged: true,
          forced: false,
          elapsedMs: elapsed(operation),
        });
        return;
      }
      yield bounded(event);
    }

    const promptDigest = sha256(input.prompt);
    const completionDigest = sha256(
      canonicalJson({
        schemaVersion: 1,
        kind: 'fixture-agent-runtime-completion.v1',
        bindingDigest: input.binding.bindingDigest,
        action: input.action,
        promptDigest,
        predecessorCompletionDigest:
          input.action === 'resume' ? input.predecessorCompletionDigest : null,
      }),
    );
    const output = Object.freeze({
      fixture: true,
      action: input.action,
      promptDigest,
      completionDigest,
    });
    const valid = validateFixtureOutput(input.output.validate, output);
    if (!valid) throw invalidContract();
    const projectionDigest = sha256(canonicalJson(input.governedInputs));
    const terminal = bounded(
      createAgentRuntimeEventV1({
        type: 'completed',
        output,
        observation: {
          observationClass: 'synthetic-fixture',
          definitionDigest:
            FIXTURE_AGENT_RUNTIME_DEFINITION_V1.definitionDigest,
          executable: FIXTURE_AGENT_RUNTIME_EXECUTABLE_IDENTITY_V1,
          providerVersion: FIXTURE_PROVIDER_VERSION,
          assurance: 'unchanged-governed-projection',
          projection: {
            unchanged: true,
            changedCategories: [],
            beforeDigest: projectionDigest,
            afterDigest: projectionDigest,
          },
          sameUserProcessConfined: false,
          residuals: [],
          protocolEvidence: {
            schemaVersion: 1,
            kind: 'fixture-agent-runtime-protocol-evidence.v1',
            action: input.action,
          },
        },
        elapsedMs: 5,
      }),
    );
    if (sessionIdentity !== null) {
      const sinkResult: unknown =
        input.privateSessionIdentitySink(sessionIdentity);
      if (sinkResult !== undefined) {
        observeRejectedThenable(sinkResult);
        throw invalidContract();
      }
      const session = Object.freeze({
        nativeSessionId: sessionIdentity.nativeSessionId,
        nativeSessionIdDigest: sessionIdentity.nativeSessionIdDigest,
        continuityToken: sessionIdentity.continuityToken ?? '',
        predecessorCompletionDigest: completionDigest,
      });
      sessions.delete(session.nativeSessionIdDigest);
      sessions.set(session.nativeSessionIdDigest, session);
      while (sessions.size > SESSION_LIMIT) {
        const oldest = sessions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        sessions.delete(oldest);
      }
    }
    terminalDelivered = true;
    executionCompleted = true;
    yield terminal;
  } catch {
    if (!terminalDelivered) {
      executionCompleted = true;
      yield operation.controller.signal.aborted
        ? createAgentRuntimeEventV1({
            type: 'cancelled',
            acknowledged: true,
            forced: false,
            elapsedMs: elapsed(operation),
          })
        : createAgentRuntimeEventV1({
            type: 'failed',
            phase: 'output',
            code: 'FIXTURE_EXECUTION_INVALID',
            launched: true,
            elapsedMs: elapsed(operation),
          });
    }
  } finally {
    if (!executionCompleted && !operation.controller.signal.aborted) {
      operation.state = 'cancel-requested';
      operation.controller.abort('shutdown');
    }
    terminalize(operation);
  }
}

function createFixtureSessionIdentity(
  operation: FixtureOperation,
  input: AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1,
  resumeSession: FixtureSession | null,
): FixturePrivateSessionIdentity | null {
  if (input.mode === 'single-shot') return null;
  const nativeSessionId =
    input.action === 'resume'
      ? (resumeSession?.nativeSessionId ?? '')
      : `fixture-native-${operation.binding.bindingDigest}`;
  const continuityToken =
    input.action === 'resume'
      ? (resumeSession?.continuityToken ?? '')
      : `fixture-continuity-${operation.binding.bindingDigest}`;
  const nativeSessionIdDigest =
    agentRuntimeNativeSessionIdDigestV1(nativeSessionId);
  const protocolReceiptDigest = sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'fixture-agent-runtime-protocol-receipt.v1',
      action: input.action,
      nativeSessionIdDigest,
      bindingDigest: input.binding.bindingDigest,
    }),
  );
  return Object.freeze({
    schemaVersion: 1,
    kind: 'agent-runtime-private-session-identity.v1',
    action: input.action,
    nativeSessionId,
    nativeSessionIdDigest,
    continuityToken,
    protocolReceiptDigest,
  });
}

function assertResumeSession(
  input: AgentRuntimeResumeInputV1,
  sessions: ReadonlyMap<string, FixtureSession>,
): FixtureSession {
  const session = sessions.get(input.nativeSessionIdDigest);
  if (
    session === undefined ||
    input.continuityToken === null ||
    session.nativeSessionId !== input.nativeSessionId ||
    session.nativeSessionIdDigest !== input.nativeSessionIdDigest ||
    session.continuityToken !== input.continuityToken ||
    session.predecessorCompletionDigest !== input.predecessorCompletionDigest
  ) {
    throw invalidContract();
  }
  return session;
}

function elapsed(operation: FixtureOperation): number {
  return Math.max(0, Date.now() - operation.startedAt);
}

function validateFixtureOutput(
  validate: (value: unknown) => boolean,
  value: unknown,
): boolean {
  try {
    const result: unknown = validate(value);
    if (result === true) return true;
    observeRejectedThenable(result);
    return false;
  } catch {
    return false;
  }
}

function observeRejectedThenable(value: unknown): void {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return;
  }
  try {
    if (typeof Reflect.get(value, 'then') !== 'function') return;
    void Promise.resolve(value).catch(() => undefined);
  } catch {
    // The sink already violated the synchronous contract. Failure stays typed.
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function assertExactDefinition(
  candidate: AgentRuntimeDefinitionIdentityV1,
  expected: AgentRuntimeDefinitionIdentityV1,
): void {
  const admitted = assertAgentRuntimeDefinitionIdentityV1(candidate);
  if (canonicalJson(admitted) !== canonicalJson(expected)) {
    throw invalidContract();
  }
}

function assertBindingDefinition(
  binding: AgentRuntimeAttemptBindingV1,
  definition: AgentRuntimeDefinitionIdentityV1,
): void {
  if (binding.definitionDigest !== definition.definitionDigest) {
    throw invalidContract();
  }
}

function invalidContract(): AgentRuntimePortContractError {
  return new AgentRuntimePortContractError();
}

function operationConflict(): FixtureAgentRuntimeOperationConflictError {
  return new FixtureAgentRuntimeOperationConflictError();
}
