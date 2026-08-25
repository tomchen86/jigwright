import {
  AGENT_RUNTIME_PORT_V1_CONTRACT_VERSION,
  AgentRuntimePortContractError,
  agentRuntimeContinuityTokenDigestV1,
  agentRuntimeNativeSessionIdDigestV1,
  assertAgentRuntimeAttemptBindingV1,
  assertAgentRuntimeCancelInputV1,
  assertAgentRuntimeDefinitionIdentityV1,
  assertAgentRuntimeResumeInputV1,
  assertAgentRuntimeStartInputV1,
  createAgentRuntimeCancelResultV1,
  createAgentRuntimeEventV1,
  createAgentRuntimeProbeEvidenceV1,
  type AgentRuntimeCancelInputV1,
  type AgentRuntimeCancelResultV1,
  type AgentRuntimeCapabilitiesV1,
  type AgentRuntimeCompletionObservationV1,
  type AgentRuntimeDefinitionIdentityV1,
  type AgentRuntimeEventPayloadV1,
  type AgentRuntimeEventV1,
  type AgentRuntimeExecutableIdentityV1,
  type AgentRuntimeFailedEventV1,
  type AgentRuntimeLaunchDefinitionSourceV1,
  type AgentRuntimePortV1,
  type AgentRuntimePrivateSessionIdentityV1,
  type AgentRuntimeProbeEvidenceV1,
  type AgentRuntimeResumeInputV1,
  type AgentRuntimeStartInputV1,
} from '@jigwright/core/agent-runtime-port';
import { canonicalJson } from '@jigwright/core/canonical-json';

const CANCEL_ACK_TIMEOUT_MS = 250;
const TERMINAL_TOMBSTONE_LIMIT = 256;

export class AgentRuntimeOperationConflictError extends Error {
  readonly code = 'AGENT_RUNTIME_OPERATION_CONFLICT';

  constructor() {
    super('Agent runtime operation is already active or has terminated.');
    this.name = 'AgentRuntimeOperationConflictError';
  }
}

export type HostObservedAgentRuntimeProbeObservationV1 = Readonly<{
  status: AgentRuntimeProbeEvidenceV1['status'];
  executableIdentity: AgentRuntimeExecutableIdentityV1 | null;
  providerVersion: string | null;
  authentication: AgentRuntimeProbeEvidenceV1['authentication'];
  capabilities: AgentRuntimeCapabilitiesV1 | null;
}>;

export type AgentRuntimeDriverEventV1 =
  | Exclude<
      AgentRuntimeEventPayloadV1,
      { type: 'session-started' | 'completed' | 'failed' }
    >
  | Readonly<{
      type: 'failed';
      phase: AgentRuntimeFailedEventV1['phase'];
      code: string;
      elapsedMs: number;
    }>
  | Readonly<{
      type: 'session-started';
      nativeSessionId: string;
      continuityToken: string | null;
      protocolReceiptDigest: string;
      elapsedMs: number;
    }>
  | Readonly<{
      type: 'completed';
      output: unknown;
      observation: Omit<
        AgentRuntimeCompletionObservationV1,
        | 'observationClass'
        | 'definitionDigest'
        | 'assurance'
        | 'sameUserProcessConfined'
      >;
      elapsedMs: number;
    }>;

export type AgentRuntimeDriverControlV1 = Readonly<{
  signal: AbortSignal;
}>;

export interface AgentRuntimeDriverV1<
  Definition extends AgentRuntimeLaunchDefinitionSourceV1 =
    AgentRuntimeDefinitionIdentityV1,
  StartInput extends AgentRuntimeStartInputV1 = AgentRuntimeStartInputV1,
  ResumeInput extends AgentRuntimeResumeInputV1 = AgentRuntimeResumeInputV1,
> {
  probe(
    snapshot: Definition,
  ): Promise<HostObservedAgentRuntimeProbeObservationV1>;
  start(
    snapshot: Definition,
    input: StartInput,
    control: AgentRuntimeDriverControlV1,
  ): AsyncIterable<AgentRuntimeDriverEventV1>;
  resume(
    snapshot: Definition,
    input: ResumeInput,
    control: AgentRuntimeDriverControlV1,
  ): AsyncIterable<AgentRuntimeDriverEventV1>;
  cancel(
    input: AgentRuntimeCancelInputV1,
    control: AgentRuntimeDriverControlV1,
  ): Promise<Readonly<{ acknowledged: boolean; forced: boolean }>>;
}

export type HostObservedAgentRuntimePortOptionsV1<
  Definition extends AgentRuntimeLaunchDefinitionSourceV1,
  StartInput extends AgentRuntimeStartInputV1,
  ResumeInput extends AgentRuntimeResumeInputV1,
> = Readonly<{
  definition: Definition;
  admitDefinition(value: unknown): Definition;
  projectDefinitionIdentity(
    definition: Definition,
  ): AgentRuntimeDefinitionIdentityV1;
  admitStartInput(value: unknown): StartInput;
  admitResumeInput(value: unknown): ResumeInput;
  driver: AgentRuntimeDriverV1<Definition, StartInput, ResumeInput>;
}>;

type RuntimeOperation = {
  readonly binding: ReturnType<typeof assertAgentRuntimeAttemptBindingV1>;
  readonly probe: AgentRuntimeProbeEvidenceV1;
  readonly controller: AbortController;
  readonly startedAt: number;
  state: 'running' | 'cancel-requested' | 'terminal';
  cancellation: Promise<CancellationOutcome> | null;
};

type CancellationOutcome =
  | Readonly<{
      confirmed: true;
      acknowledged: boolean;
      forced: boolean;
    }>
  | Readonly<{ confirmed: false }>;

type CachedReadyProbe = Readonly<{
  generation: number;
  evidence: AgentRuntimeProbeEvidenceV1;
}>;

type NormalizedDriverEvent = Readonly<{
  event: AgentRuntimeEventV1;
  privateIdentity: AgentRuntimePrivateSessionIdentityV1 | null;
}>;

type RuntimeExecutionFailure = Readonly<{
  phase:
    'preflight' | 'launch' | 'protocol' | 'output' | 'projection' | 'identity';
  code: string;
  launched: boolean;
}>;

/**
 * Wrap one host implementation in the core-owned v1 contract. The wrapper
 * owns definition admission, operation fencing, public event bounds, timeout,
 * cancellation, and the only raw native-session identity egress capability.
 */
export function createHostObservedAgentRuntimePortV1<
  Definition extends AgentRuntimeLaunchDefinitionSourceV1,
  StartInput extends AgentRuntimeStartInputV1 = AgentRuntimeStartInputV1,
  ResumeInput extends AgentRuntimeResumeInputV1 = AgentRuntimeResumeInputV1,
>(
  options: HostObservedAgentRuntimePortOptionsV1<
    Definition,
    StartInput,
    ResumeInput
  >,
): AgentRuntimePortV1<Definition, StartInput, ResumeInput> {
  if (!isFactoryOptions(options)) throw invalidContract();
  if (!isDriver(options.driver)) throw invalidContract();
  const admitDefinition = options.admitDefinition;
  const projectDefinitionIdentity = options.projectDefinitionIdentity;
  const admitStartInput = options.admitStartInput;
  const admitResumeInput = options.admitResumeInput;
  const driverProbe = options.driver.probe.bind(options.driver);
  const driverStart = options.driver.start.bind(options.driver);
  const driverResume = options.driver.resume.bind(options.driver);
  const driverCancel = options.driver.cancel.bind(options.driver);
  const definitionAdmission = Object.freeze({
    admitDefinition,
    projectDefinitionIdentity,
  });
  const definition = admitDefinition(options.definition);
  rejectThenableContractValue(definition);
  assertDeeplyFrozen(definition);
  const projectedDefinitionIdentity = projectDefinitionIdentity(definition);
  rejectThenableContractValue(projectedDefinitionIdentity);
  const definitionIdentity = assertAgentRuntimeDefinitionIdentityV1(
    projectedDefinitionIdentity,
  );

  const active = new Map<string, RuntimeOperation>();
  const terminalTombstones = new Map<string, string>();
  let readyProbe: CachedReadyProbe | null = null;
  let probeGeneration = 0;
  let cancellationPoisoned = false;
  let cancellationPending = 0;

  const probe = (
    snapshot: Definition,
  ): Promise<AgentRuntimeProbeEvidenceV1> => {
    const admittedSnapshot = admitExactDefinition(
      snapshot,
      definition,
      definitionIdentity,
      definitionAdmission,
    );
    const generation = ++probeGeneration;
    readyProbe = null;
    let pendingObservation: Promise<HostObservedAgentRuntimeProbeObservationV1>;
    try {
      pendingObservation = driverProbe(admittedSnapshot);
    } catch {
      if (generation === probeGeneration) readyProbe = null;
      return Promise.reject(invalidContract());
    }
    return Promise.resolve(pendingObservation).then(
      (observation) => {
        try {
          assertExactProbeObservation(observation);
          const evidence = createAgentRuntimeProbeEvidenceV1({
            authority: 'observation-only',
            observationClass: 'host-observed',
            definition: definitionIdentity,
            status: observation.status,
            executableIdentity: observation.executableIdentity,
            providerVersion: observation.providerVersion,
            authentication: observation.authentication,
            capabilities: observation.capabilities,
          });
          if (generation === probeGeneration) {
            readyProbe =
              evidence.status === 'ready'
                ? Object.freeze({ generation, evidence })
                : null;
          }
          return evidence;
        } catch {
          if (generation === probeGeneration) readyProbe = null;
          throw invalidContract();
        }
      },
      () => {
        if (generation === probeGeneration) readyProbe = null;
        throw invalidContract();
      },
    );
  };

  const start = (
    snapshot: Definition,
    rawInput: StartInput,
  ): AsyncIterable<AgentRuntimeEventV1> => {
    const admittedSnapshot = admitExactDefinition(
      snapshot,
      definition,
      definitionIdentity,
      definitionAdmission,
    );
    const admittedInput = admitStartInput(rawInput);
    rejectThenableContractValue(admittedInput);
    assertDeeplyFrozen(admittedInput);
    const input = projectCoreStartInput(admittedInput);
    assertBindingDefinition(input.binding.definitionDigest, definitionIdentity);
    const cachedProbe = requireReadyProbe(false);
    return singleConsumerStream(input.binding, cachedProbe, (operation) =>
      execute(operation, input, () =>
        driverStart(admittedSnapshot, admittedInput, control(operation)),
      ),
    );
  };

  const resume = (
    snapshot: Definition,
    rawInput: ResumeInput,
  ): AsyncIterable<AgentRuntimeEventV1> => {
    const admittedSnapshot = admitExactDefinition(
      snapshot,
      definition,
      definitionIdentity,
      definitionAdmission,
    );
    const admittedInput = admitResumeInput(rawInput);
    rejectThenableContractValue(admittedInput);
    assertDeeplyFrozen(admittedInput);
    const input = projectCoreResumeInput(admittedInput);
    assertBindingDefinition(input.binding.definitionDigest, definitionIdentity);
    const cachedProbe = requireReadyProbe(true);
    return singleConsumerStream(input.binding, cachedProbe, (operation) =>
      execute(operation, input, () =>
        driverResume(admittedSnapshot, admittedInput, control(operation)),
      ),
    );
  };

  const cancel = async (
    rawInput: AgentRuntimeCancelInputV1,
  ): Promise<AgentRuntimeCancelResultV1> => {
    const input = assertAgentRuntimeCancelInputV1(rawInput);
    assertBindingDefinition(input.binding.definitionDigest, definitionIdentity);
    const operation = active.get(input.binding.operationId);
    if (operation === undefined) {
      const terminalBinding = terminalTombstones.get(input.binding.operationId);
      if (
        terminalBinding !== undefined &&
        terminalBinding !== input.binding.bindingDigest
      ) {
        throw operationConflict();
      }
      return createAgentRuntimeCancelResultV1(input.binding, {
        status:
          terminalBinding === undefined ? 'not-active' : 'already-terminal',
        acknowledged: false,
        forced: false,
      });
    }
    assertOperationBinding(operation, input.binding.bindingDigest);
    const outcome = await requestCancellation(operation, input);
    if (!outcome.confirmed) {
      return createAgentRuntimeCancelResultV1(input.binding, {
        status: 'cancellation-unconfirmed',
        acknowledged: false,
        forced: false,
      });
    }
    return createAgentRuntimeCancelResultV1(input.binding, {
      status: 'cancelled',
      acknowledged: outcome.acknowledged,
      forced: outcome.forced,
    });
  };

  function requireReadyProbe(requireResume: boolean): CachedReadyProbe {
    if (
      readyProbe === null ||
      cancellationPoisoned ||
      cancellationPending > 0 ||
      readyProbe.evidence.status !== 'ready' ||
      readyProbe.evidence.observationClass !== 'host-observed' ||
      readyProbe.evidence.definition.definitionDigest !==
        definitionIdentity.definitionDigest ||
      readyProbe.evidence.executableIdentity === null ||
      readyProbe.evidence.capabilities === null ||
      (requireResume && !readyProbe.evidence.capabilities.resumableAfterTurn)
    ) {
      throw invalidContract();
    }
    return readyProbe;
  }

  function reserveOperation(
    binding: ReturnType<typeof assertAgentRuntimeAttemptBindingV1>,
    cachedProbe: CachedReadyProbe,
  ): RuntimeOperation {
    const current = active.get(binding.operationId);
    const terminalBinding = terminalTombstones.get(binding.operationId);
    if (current !== undefined || terminalBinding !== undefined) {
      throw operationConflict();
    }
    const operation: RuntimeOperation = {
      binding,
      probe: cachedProbe.evidence,
      controller: new AbortController(),
      startedAt: Date.now(),
      state: 'running',
      cancellation: null,
    };
    active.set(binding.operationId, operation);
    return operation;
  }

  function singleConsumerStream(
    binding: ReturnType<typeof assertAgentRuntimeAttemptBindingV1>,
    cachedProbe: CachedReadyProbe,
    create: (
      operation: RuntimeOperation,
    ) => AsyncGenerator<AgentRuntimeEventV1>,
  ): AsyncIterable<AgentRuntimeEventV1> {
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
          if (
            readyProbe !== cachedProbe ||
            cancellationPoisoned ||
            cancellationPending > 0
          ) {
            throw invalidContract();
          }
          const operation = reserveOperation(binding, cachedProbe);
          iterator = create(operation);
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
  }

  async function* execute(
    operation: RuntimeOperation,
    input: AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1,
    createEvents: () => AsyncIterable<AgentRuntimeDriverEventV1>,
  ): AsyncGenerator<AgentRuntimeEventV1> {
    const deadline = Date.now() + input.limits.timeoutMs;
    let iterator: AsyncIterator<AgentRuntimeDriverEventV1> | null = null;
    let eventCount = 0;
    let aggregateBytes = 0;
    let sessionStarted = false;
    let spawnObserved = false;
    let spawnErrorObserved = false;
    let terminal: AgentRuntimeEventV1 | null = null;
    let driverInvoked = false;
    let pendingPrivateIdentity: AgentRuntimePrivateSessionIdentityV1 | null =
      null;
    const privateSecrets =
      input.action === 'resume'
        ? [input.nativeSessionId, input.continuityToken].filter(
            (value): value is string => value !== null,
          )
        : [];
    let executionSettled = false;
    try {
      if (operation.controller.signal.aborted) {
        terminal = createCancellationTerminal(
          operation,
          await cancellationOutcome(operation, 'caller-requested'),
          false,
        );
      } else {
        try {
          driverInvoked = true;
          iterator = createDriverIterator(createEvents);
        } catch {
          throw executionFailure(
            'launch',
            'RUNTIME_DRIVER_START_FAILED',
            false,
          );
        }
      }
      while (terminal === null) {
        if (iterator === null) {
          throw executionFailure(
            'launch',
            'RUNTIME_DRIVER_START_FAILED',
            false,
          );
        }
        let next:
          IteratorResult<AgentRuntimeDriverEventV1> | 'timeout' | 'aborted';
        try {
          next = await nextBeforeDeadline(
            iterator,
            deadline,
            operation.controller.signal,
          );
        } catch {
          throw executionFailure(
            'launch',
            'RUNTIME_DRIVER_FAILED',
            spawnObserved,
          );
        }
        if (next === 'timeout') {
          const outcome = await requestCancellation(
            operation,
            cancelInput(operation, 'deadline'),
          );
          terminal = createCancellationTerminal(
            operation,
            outcome,
            spawnObserved,
          );
          break;
        }
        if (next === 'aborted') {
          terminal = createCancellationTerminal(
            operation,
            await cancellationOutcome(operation, 'caller-requested'),
            spawnObserved,
          );
          break;
        }
        if (next.done) {
          throw executionFailure(
            'protocol',
            'TERMINAL_EVENT_MISSING',
            spawnObserved,
          );
        }
        eventCount += 1;
        if (eventCount > input.limits.maxEventCount) {
          await requestCancellation(
            operation,
            cancelInput(operation, 'shutdown'),
          );
          throw executionFailure(
            'protocol',
            'EVENT_LIMIT_EXCEEDED',
            spawnObserved,
          );
        }
        let normalized: NormalizedDriverEvent;
        try {
          if (!(
            isRecord(next.value) && next.value.type === 'session-started'
          )) {
            assertNoPrivateSecretEcho(
              next.value,
              privateSecrets,
              spawnObserved,
            );
          }
          if (
            input.action === 'start' &&
            input.mode === 'provider-observed-native' &&
            !sessionStarted &&
            isRecord(next.value) &&
            ['semantic-progress', 'completed'].includes(String(next.value.type))
          ) {
            throw executionFailure(
              'identity',
              'SESSION_REQUIRED_BEFORE_PUBLIC_CONTENT',
              spawnObserved,
            );
          }
          normalized = normalizeDriverEvent(
            operation,
            input,
            next.value,
            sessionStarted,
            spawnObserved,
          );
        } catch (error) {
          if (isRuntimeExecutionFailure(error)) throw error;
          const rawType = isRecord(next.value) ? next.value.type : null;
          throw executionFailure(
            rawType === 'completed' ? 'output' : 'protocol',
            rawType === 'completed'
              ? 'OUTPUT_OR_OBSERVATION_INVALID'
              : 'RUNTIME_EVENT_INVALID',
            spawnObserved,
          );
        }
        const event = normalized.event;
        if (normalized.privateIdentity !== null) {
          if (pendingPrivateIdentity !== null) {
            throw executionFailure(
              'identity',
              'DUPLICATE_SESSION_IDENTITY',
              spawnObserved,
            );
          }
          pendingPrivateIdentity = normalized.privateIdentity;
          privateSecrets.push(normalized.privateIdentity.nativeSessionId);
          if (normalized.privateIdentity.continuityToken !== null) {
            privateSecrets.push(normalized.privateIdentity.continuityToken);
          }
        }
        if (event.type === 'process-activity') {
          if (event.activity === 'spawned') {
            if (spawnObserved || spawnErrorObserved) {
              throw executionFailure(
                'protocol',
                'DUPLICATE_OR_LATE_SPAWN_EVIDENCE',
                spawnObserved,
              );
            }
            spawnObserved = true;
          } else if (event.activity === 'spawn-error') {
            if (spawnObserved || spawnErrorObserved) {
              throw executionFailure(
                'protocol',
                'DUPLICATE_OR_LATE_SPAWN_ERROR',
                spawnObserved,
              );
            }
            spawnErrorObserved = true;
          } else if (
            [
              'stdout',
              'stderr',
              'exited',
              'timed-out',
              'output-limit',
            ].includes(event.activity) &&
            !spawnObserved
          ) {
            throw executionFailure(
              'protocol',
              'PROCESS_ACTIVITY_BEFORE_SPAWN',
              false,
            );
          }
        }
        if (event.type === 'session-started') sessionStarted = true;
        assertNoPrivateSecretEcho(event, privateSecrets, spawnObserved);
        const eventBytes = Buffer.byteLength(canonicalJson(event), 'utf8');
        if (aggregateBytes + eventBytes > input.limits.aggregateOutputBytes) {
          await requestCancellation(
            operation,
            cancelInput(operation, 'shutdown'),
          );
          throw executionFailure(
            'output',
            'OUTPUT_LIMIT_EXCEEDED',
            spawnObserved,
          );
        }
        if (isTerminalEvent(event)) {
          terminal = await admitTerminalState(
            operation,
            input,
            event,
            sessionStarted,
            spawnObserved,
          );
          continue;
        }
        if (eventCount === input.limits.maxEventCount) {
          await requestCancellation(
            operation,
            cancelInput(operation, 'shutdown'),
          );
          throw executionFailure(
            'protocol',
            'EVENT_LIMIT_EXCEEDED',
            spawnObserved,
          );
        }
        aggregateBytes += eventBytes;
        yield event;
      }

      if (terminal === null) {
        throw executionFailure(
          'protocol',
          'TERMINAL_EVENT_MISSING',
          spawnObserved,
        );
      }
      if (
        !operation.controller.signal.aborted ||
        terminal.type !== 'cancelled'
      ) {
        if (iterator === null) {
          throw executionFailure(
            'protocol',
            'TERMINAL_EVENT_MISSING',
            spawnObserved,
          );
        }
        const afterTerminal = await nextBeforeDeadline(
          iterator,
          deadline,
          operation.controller.signal,
        );
        if (afterTerminal === 'aborted') {
          throw executionFailure(
            'protocol',
            'CANCELLED_DURING_TERMINAL_CLEANUP',
            spawnObserved,
          );
        }
        if (afterTerminal !== 'timeout' && !afterTerminal.done) {
          throw executionFailure(
            'protocol',
            'POST_TERMINAL_EVENT',
            spawnObserved,
          );
        }
        if (afterTerminal === 'timeout') {
          await requestCancellation(
            operation,
            cancelInput(operation, 'deadline'),
          );
          throw executionFailure(
            'protocol',
            'POST_TERMINAL_STREAM_OPEN',
            spawnObserved,
          );
        }
      }

      if (terminal.type === 'completed' && pendingPrivateIdentity !== null) {
        try {
          const sinkResult: unknown = input.privateSessionIdentitySink(
            pendingPrivateIdentity,
          );
          if (sinkResult !== undefined) {
            observeRejectedThenable(sinkResult);
            throw invalidContract();
          }
        } catch {
          throw executionFailure(
            'identity',
            'PRIVATE_SESSION_SINK_FAILED',
            spawnObserved,
          );
        }
      }
      executionSettled = true;
    } catch (error) {
      if (
        operation.controller.signal.aborted &&
        operation.cancellation !== null
      ) {
        terminal = createCancellationTerminal(
          operation,
          await cancellationOutcome(operation, 'shutdown'),
          spawnObserved,
        );
      } else {
        const failure = isRuntimeExecutionFailure(error)
          ? error
          : executionFailure(
              'protocol',
              'RUNTIME_EVENT_INVALID',
              spawnObserved,
            );
        if (driverInvoked && !operation.controller.signal.aborted) {
          await requestCancellation(
            operation,
            cancelInput(operation, 'shutdown'),
          );
        }
        terminal = createAgentRuntimeEventV1({
          type: 'failed',
          ...failure,
          elapsedMs: elapsed(operation),
        });
      }
      executionSettled = true;
    } finally {
      try {
        if (!executionSettled && !operation.controller.signal.aborted) {
          await requestCancellation(
            operation,
            cancelInput(operation, 'shutdown'),
          );
        }
      } finally {
        try {
          if (iterator !== null) await settleIteratorReturn(iterator);
        } finally {
          terminalize(operation);
        }
      }
    }
    if (terminal === null) {
      throw invalidContract();
    }
    yield terminal;
  }

  function normalizeDriverEvent(
    operation: RuntimeOperation,
    input: AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1,
    raw: AgentRuntimeDriverEventV1,
    sessionAlreadyStarted: boolean,
    spawnObserved: boolean,
  ): NormalizedDriverEvent {
    if (!isRecord(raw) || typeof raw.type !== 'string') {
      throw invalidContract();
    }
    if (raw.type === 'session-started') {
      if (
        !hasExactKeys(raw, [
          'type',
          'nativeSessionId',
          'continuityToken',
          'protocolReceiptDigest',
          'elapsedMs',
        ]) ||
        sessionAlreadyStarted ||
        input.mode === 'single-shot' ||
        typeof raw.nativeSessionId !== 'string' ||
        (raw.continuityToken !== null &&
          typeof raw.continuityToken !== 'string')
      ) {
        throw invalidContract();
      }
      const nativeSessionIdDigest = agentRuntimeNativeSessionIdDigestV1(
        raw.nativeSessionId,
      );
      if (
        input.action === 'resume' &&
        (raw.nativeSessionId !== input.nativeSessionId ||
          nativeSessionIdDigest !== input.nativeSessionIdDigest ||
          raw.continuityToken !== input.continuityToken)
      ) {
        throw invalidContract();
      }
      const identity = Object.freeze({
        schemaVersion: 1 as const,
        kind: 'agent-runtime-private-session-identity.v1' as const,
        action: input.action,
        nativeSessionId: raw.nativeSessionId,
        nativeSessionIdDigest,
        continuityToken: raw.continuityToken,
        protocolReceiptDigest: raw.protocolReceiptDigest,
      });
      return Object.freeze({
        event: createAgentRuntimeEventV1({
          type: 'session-started',
          action: input.action,
          nativeSessionIdDigest,
          continuityTokenDigest:
            raw.continuityToken === null
              ? null
              : agentRuntimeContinuityTokenDigestV1(raw.continuityToken),
          protocolReceiptDigest: raw.protocolReceiptDigest,
          elapsedMs: raw.elapsedMs,
        }),
        privateIdentity: identity,
      });
    }
    if (raw.type === 'failed') {
      if (
        !hasExactKeys(raw, ['type', 'phase', 'code', 'elapsedMs']) ||
        typeof raw.code !== 'string'
      ) {
        throw invalidContract();
      }
      return Object.freeze({
        event: createAgentRuntimeEventV1({
          type: 'failed',
          phase: raw.phase,
          code: 'RUNTIME_DRIVER_REPORTED_FAILURE',
          launched: spawnObserved,
          elapsedMs: raw.elapsedMs,
        }),
        privateIdentity: null,
      });
    }
    if (raw.type === 'completed') {
      if (
        !hasExactKeys(raw, ['type', 'output', 'observation', 'elapsedMs']) ||
        !isRecord(raw.observation) ||
        !hasExactKeys(raw.observation, [
          'executable',
          'providerVersion',
          'projection',
          'residuals',
          'protocolEvidence',
        ])
      ) {
        throw invalidContract();
      }
      const valid = validateOutput(input.output.validate, raw.output);
      if (!valid) {
        throw executionFailure(
          'output',
          'OUTPUT_SCHEMA_INVALID',
          spawnObserved,
        );
      }
      if (
        canonicalJson(raw.observation.executable) !==
          canonicalJson(operation.probe.executableIdentity) ||
        raw.observation.providerVersion !== operation.probe.providerVersion
      ) {
        throw executionFailure(
          'identity',
          'PROBE_LAUNCH_IDENTITY_DRIFT',
          spawnObserved,
        );
      }
      return Object.freeze({
        event: createAgentRuntimeEventV1({
          type: 'completed',
          output: raw.output,
          observation: {
            observationClass: 'host-observed',
            definitionDigest: operation.probe.definition.definitionDigest,
            executable: raw.observation.executable,
            providerVersion: raw.observation.providerVersion,
            assurance: 'unchanged-governed-projection',
            projection: raw.observation.projection,
            sameUserProcessConfined: false,
            residuals: raw.observation.residuals,
            protocolEvidence: raw.observation.protocolEvidence,
          },
          elapsedMs: raw.elapsedMs,
        }),
        privateIdentity: null,
      });
    }
    return Object.freeze({
      event: createAgentRuntimeEventV1(raw as AgentRuntimeEventPayloadV1),
      privateIdentity: null,
    });
  }

  async function admitTerminalState(
    operation: RuntimeOperation,
    input: AgentRuntimeStartInputV1 | AgentRuntimeResumeInputV1,
    event: AgentRuntimeEventV1,
    sessionStarted: boolean,
    spawnObserved: boolean,
  ): Promise<AgentRuntimeEventV1> {
    if (
      event.type === 'completed' &&
      input.mode !== 'single-shot' &&
      !sessionStarted
    ) {
      throw executionFailure(
        'protocol',
        'SESSION_EVIDENCE_MISSING',
        spawnObserved,
      );
    }
    if (operation.controller.signal.aborted && event.type !== 'cancelled') {
      return createCancellationTerminal(
        operation,
        await cancellationOutcome(operation, 'caller-requested'),
        spawnObserved,
      );
    }
    if (event.type === 'cancelled') {
      if (
        operation.cancellation === null ||
        operation.state !== 'cancel-requested'
      ) {
        throw executionFailure(
          'protocol',
          'UNREQUESTED_CANCELLATION',
          spawnObserved,
        );
      }
      const outcome = await cancellationOutcome(operation, 'caller-requested');
      if (!outcome.confirmed) {
        return createCancellationTerminal(operation, outcome, spawnObserved);
      }
      if (
        event.acknowledged !== outcome.acknowledged ||
        event.forced !== outcome.forced
      ) {
        return createAgentRuntimeEventV1({
          type: 'failed',
          phase: 'protocol',
          code: 'CANCELLATION_EVIDENCE_MISMATCH',
          launched: spawnObserved,
          elapsedMs: elapsed(operation),
        });
      }
    }
    return event;
  }

  async function requestCancellation(
    operation: RuntimeOperation,
    input: AgentRuntimeCancelInputV1,
  ): Promise<CancellationOutcome> {
    assertOperationBinding(operation, input.binding.bindingDigest);
    if (operation.cancellation !== null) return operation.cancellation;
    operation.state = 'cancel-requested';
    operation.controller.abort(input.reason);
    cancellationPending += 1;
    let cancellation: Promise<
      Readonly<{ acknowledged: boolean; forced: boolean }>
    >;
    try {
      cancellation = Promise.resolve(driverCancel(input, control(operation)));
    } catch {
      cancellation = Promise.resolve({ acknowledged: false, forced: false });
    }
    operation.cancellation = boundedCancellation(cancellation)
      .then((outcome) => {
        if (!outcome.confirmed) cancellationPoisoned = true;
        return outcome;
      })
      .finally(() => {
        cancellationPending -= 1;
      });
    return operation.cancellation;
  }

  function cancellationOutcome(
    operation: RuntimeOperation,
    fallbackReason: AgentRuntimeCancelInputV1['reason'],
  ): Promise<CancellationOutcome> {
    return (
      operation.cancellation ??
      requestCancellation(operation, cancelInput(operation, fallbackReason))
    );
  }

  function terminalize(operation: RuntimeOperation): void {
    operation.state = 'terminal';
    active.delete(operation.binding.operationId);
    terminalTombstones.delete(operation.binding.operationId);
    terminalTombstones.set(
      operation.binding.operationId,
      operation.binding.bindingDigest,
    );
    while (terminalTombstones.size > TERMINAL_TOMBSTONE_LIMIT) {
      const oldest = terminalTombstones.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      terminalTombstones.delete(oldest);
    }
  }

  return Object.freeze({
    contractVersion: AGENT_RUNTIME_PORT_V1_CONTRACT_VERSION,
    probe,
    start,
    resume,
    cancel,
  });
}

function admitExactDefinition<
  Definition extends AgentRuntimeLaunchDefinitionSourceV1,
>(
  candidate: unknown,
  configured: Definition,
  configuredIdentity: AgentRuntimeDefinitionIdentityV1,
  admission: Readonly<{
    admitDefinition(value: unknown): Definition;
    projectDefinitionIdentity(
      definition: Definition,
    ): AgentRuntimeDefinitionIdentityV1;
  }>,
): Definition {
  const admitted = admission.admitDefinition(candidate);
  rejectThenableContractValue(admitted);
  assertDeeplyFrozen(admitted);
  const projectedIdentity = admission.projectDefinitionIdentity(admitted);
  rejectThenableContractValue(projectedIdentity);
  const identity = assertAgentRuntimeDefinitionIdentityV1(projectedIdentity);
  if (
    canonicalJson(admitted) !== canonicalJson(configured) ||
    canonicalJson(identity) !== canonicalJson(configuredIdentity)
  ) {
    throw invalidContract();
  }
  return admitted;
}

function assertDeeplyFrozen(value: unknown): void {
  const seen = new Set<object>();
  const visit = (candidate: unknown): void => {
    if (typeof candidate !== 'object' || candidate === null) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (!Object.isFrozen(candidate)) throw invalidContract();
    for (const entry of Object.values(candidate as Record<string, unknown>)) {
      visit(entry);
    }
  };
  visit(value);
}

function projectCoreStartInput(
  input: AgentRuntimeStartInputV1,
): AgentRuntimeStartInputV1 {
  return assertAgentRuntimeStartInputV1({
    action: input.action,
    mode: input.mode,
    binding: input.binding,
    repositoryRoot: input.repositoryRoot,
    workingDirectory: input.workingDirectory,
    runtimeDirectory: input.runtimeDirectory,
    prompt: input.prompt,
    output: input.output,
    governedInputs: input.governedInputs,
    limits: input.limits,
    privateSessionIdentitySink: input.privateSessionIdentitySink,
  });
}

function projectCoreResumeInput(
  input: AgentRuntimeResumeInputV1,
): AgentRuntimeResumeInputV1 {
  return assertAgentRuntimeResumeInputV1({
    action: input.action,
    mode: input.mode,
    binding: input.binding,
    repositoryRoot: input.repositoryRoot,
    workingDirectory: input.workingDirectory,
    runtimeDirectory: input.runtimeDirectory,
    prompt: input.prompt,
    output: input.output,
    governedInputs: input.governedInputs,
    limits: input.limits,
    privateSessionIdentitySink: input.privateSessionIdentitySink,
    nativeSessionId: input.nativeSessionId,
    nativeSessionIdDigest: input.nativeSessionIdDigest,
    predecessorCompletionDigest: input.predecessorCompletionDigest,
    continuityToken: input.continuityToken,
  });
}

function assertBindingDefinition(
  definitionDigest: string,
  definition: AgentRuntimeDefinitionIdentityV1,
): void {
  if (definitionDigest !== definition.definitionDigest) throw invalidContract();
}

function assertExactProbeObservation(
  value: unknown,
): asserts value is HostObservedAgentRuntimeProbeObservationV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'status',
      'executableIdentity',
      'providerVersion',
      'authentication',
      'capabilities',
    ])
  ) {
    throw invalidContract();
  }
}

function isDriver(value: unknown): value is AgentRuntimeDriverV1 {
  return (
    isRecord(value) &&
    typeof value.probe === 'function' &&
    typeof value.start === 'function' &&
    typeof value.resume === 'function' &&
    typeof value.cancel === 'function'
  );
}

function isFactoryOptions(value: unknown): value is Readonly<{
  admitDefinition(value: unknown): unknown;
  projectDefinitionIdentity(value: unknown): AgentRuntimeDefinitionIdentityV1;
  admitStartInput(value: unknown): AgentRuntimeStartInputV1;
  admitResumeInput(value: unknown): AgentRuntimeResumeInputV1;
}> {
  return (
    isRecord(value) &&
    typeof value.admitDefinition === 'function' &&
    typeof value.projectDefinitionIdentity === 'function' &&
    typeof value.admitStartInput === 'function' &&
    typeof value.admitResumeInput === 'function'
  );
}

function createDriverIterator(
  createEvents: () => AsyncIterable<AgentRuntimeDriverEventV1>,
): AsyncIterator<AgentRuntimeDriverEventV1> {
  const iterable: unknown = createEvents();
  rejectThenableContractValue(iterable);
  if (
    iterable === null ||
    (typeof iterable !== 'object' && typeof iterable !== 'function')
  ) {
    throw invalidContract();
  }
  const iteratorMethod: unknown = Reflect.get(iterable, Symbol.asyncIterator);
  if (typeof iteratorMethod !== 'function') throw invalidContract();
  const iterator: unknown = Reflect.apply(iteratorMethod, iterable, []);
  rejectThenableContractValue(iterator);
  if (
    iterator === null ||
    (typeof iterator !== 'object' && typeof iterator !== 'function') ||
    typeof Reflect.get(iterator, 'next') !== 'function'
  ) {
    throw invalidContract();
  }
  return iterator as AsyncIterator<AgentRuntimeDriverEventV1>;
}

function control(operation: RuntimeOperation): AgentRuntimeDriverControlV1 {
  return Object.freeze({ signal: operation.controller.signal });
}

function cancelInput(
  operation: RuntimeOperation,
  reason: AgentRuntimeCancelInputV1['reason'],
): AgentRuntimeCancelInputV1 {
  return Object.freeze({
    binding: operation.binding,
    reason,
  });
}

async function boundedCancellation(
  pending: Promise<Readonly<{ acknowledged: boolean; forced: boolean }>>,
): Promise<CancellationOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unconfirmed = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CANCEL_ACK_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([pending.catch(() => null), unconfirmed]);
    try {
      if (
        !isRecord(result) ||
        !hasExactKeys(result, ['acknowledged', 'forced']) ||
        typeof result.acknowledged !== 'boolean' ||
        typeof result.forced !== 'boolean' ||
        result.acknowledged === result.forced
      ) {
        return Object.freeze({ confirmed: false });
      }
      return Object.freeze({
        confirmed: true,
        acknowledged: result.acknowledged,
        forced: result.forced,
      });
    } catch {
      return Object.freeze({ confirmed: false });
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function nextBeforeDeadline<T>(
  iterator: AsyncIterator<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<IteratorResult<T> | 'timeout' | 'aborted'> {
  if (signal.aborted) return 'aborted';
  const remaining = deadline - Date.now();
  if (remaining <= 0) return 'timeout';
  const next = Promise.resolve(iterator.next());
  void next.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), remaining);
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>((resolve) => {
    onAbort = () => resolve('aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    return await Promise.race([next, timeout, aborted]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function createCancellationTerminal(
  operation: RuntimeOperation,
  outcome: CancellationOutcome,
  launched: boolean,
): AgentRuntimeEventV1 {
  if (!outcome.confirmed) {
    return createAgentRuntimeEventV1({
      type: 'failed',
      phase: 'protocol',
      code: 'CANCELLATION_UNCONFIRMED',
      launched,
      elapsedMs: elapsed(operation),
    });
  }
  return createAgentRuntimeEventV1({
    type: 'cancelled',
    acknowledged: outcome.acknowledged,
    forced: outcome.forced,
    elapsedMs: elapsed(operation),
  });
}

async function settleIteratorReturn<T>(
  iterator: AsyncIterator<T>,
): Promise<void> {
  let returnMethod: unknown;
  try {
    returnMethod = Reflect.get(iterator, 'return');
  } catch {
    return;
  }
  if (returnMethod === undefined) return;
  if (typeof returnMethod !== 'function') return;
  let returned: PromiseLike<IteratorResult<T>> | IteratorResult<T>;
  try {
    returned = Reflect.apply(returnMethod, iterator, []) as
      PromiseLike<IteratorResult<T>> | IteratorResult<T>;
  } catch {
    return;
  }
  const pending = Promise.resolve(returned).then(
    () => undefined,
    () => undefined,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, CANCEL_ACK_TIMEOUT_MS);
  });
  try {
    await Promise.race([pending, bounded]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function elapsed(operation: RuntimeOperation): number {
  return Math.max(0, Date.now() - operation.startedAt);
}

function executionFailure(
  phase: RuntimeExecutionFailure['phase'],
  code: string,
  launched: boolean,
): RuntimeExecutionFailure {
  return Object.freeze({ phase, code, launched });
}

function validateOutput(
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

function rejectThenableContractValue(value: unknown): void {
  if (observeRejectedThenable(value)) throw invalidContract();
}

function observeRejectedThenable(value: unknown): boolean {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return false;
  }
  try {
    if (typeof Reflect.get(value, 'then') !== 'function') return false;
    void Promise.resolve(value).catch(() => undefined);
    return true;
  } catch {
    return true;
  }
}

function assertNoPrivateSecretEcho(
  value: unknown,
  privateSecrets: readonly string[],
  launched: boolean,
): void {
  const containsSecret = (text: string): boolean =>
    privateSecrets.some((secret) => text.includes(secret));
  const visit = (candidate: unknown): boolean => {
    if (typeof candidate === 'string') return containsSecret(candidate);
    if (typeof candidate === 'number' || typeof candidate === 'bigint') {
      return containsSecret(String(candidate));
    }
    if (Array.isArray(candidate)) return candidate.some(visit);
    if (!isRecord(candidate)) return false;
    return Object.entries(candidate).some(
      ([key, entry]) => containsSecret(key) || visit(entry),
    );
  };
  if (privateSecrets.length > 0 && visit(value)) {
    throw executionFailure('identity', 'PRIVATE_SESSION_SECRET_ECHO', launched);
  }
}

function isRuntimeExecutionFailure(
  value: unknown,
): value is RuntimeExecutionFailure {
  return (
    isRecord(value) &&
    typeof value.phase === 'string' &&
    typeof value.code === 'string' &&
    typeof value.launched === 'boolean'
  );
}

function isTerminalEvent(event: AgentRuntimeEventV1): boolean {
  return (
    event.type === 'completed' ||
    event.type === 'failed' ||
    event.type === 'cancelled'
  );
}

function assertOperationBinding(
  operation: RuntimeOperation,
  bindingDigest: string,
): void {
  if (operation.binding.bindingDigest !== bindingDigest) {
    throw operationConflict();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function invalidContract(): AgentRuntimePortContractError {
  return new AgentRuntimePortContractError();
}

function operationConflict(): AgentRuntimeOperationConflictError {
  return new AgentRuntimeOperationConflictError();
}
