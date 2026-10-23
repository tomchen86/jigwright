/**
 * Parses and evaluates intervention domain requests through a read-only
 * dispatcher.
 *
 * Invariants:
 * - Requests cannot ask the dispatcher to mutate live refs or promote an
 *   engine.
 */
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  advanceEngineAdoption,
  beginHarnessIntervention,
  createWipCheckpoint,
  prepareEngineAdoption,
  verifyHarnessMaintenanceGrant,
  type EngineAdoptionJournal,
  type EngineArtifact,
  type HarnessInterventionRelationship,
  type HarnessMaintenanceGrantEnvelope,
  type ParentChangeState,
  type WipCheckpoint,
  type WipCheckpointInput,
} from '../../modules/authority/intervention-control.ts';

const MAX_REQUEST_BYTES = 1024 * 1024;

export type InterventionControlHumanSignatureVerifier = (
  payload: string,
  signature: string,
  signer: string,
  namespace: string,
) => boolean;

export interface InterventionControlDispatcherDependencies {
  now?: () => Date;
  verifyHumanSignature?: InterventionControlHumanSignatureVerifier;
}

type ParsedRequestCommand =
  | {
      command: 'change-intervene';
      parentChangeId: string;
      request: Record<string, unknown>;
    }
  | {
      command: 'engine-adopt';
      request: Record<string, unknown>;
    };

export type ParsedInterventionControlCommand = ParsedRequestCommand;

export type InterventionControlDispatchResult =
  | {
      kind: 'change-intervene';
      checkpoint: WipCheckpoint;
      parent: ParentChangeState;
      relationship: HarnessInterventionRelationship;
      effectsPerformed: false;
    }
  | {
      kind: 'engine-adopt';
      journal: EngineAdoptionJournal;
      effectsPerformed: false;
    };

/**
 * Parse the bounded M10/M11 command surface. This parser intentionally has no
 * filesystem, Git, process, or signing dependency. Global promotion and live
 * ref mutation are rejected here rather than represented as dispatcher work.
 */
export function parseInterventionControlCommand(
  argv: readonly string[],
): ParsedInterventionControlCommand {
  rejectCallerSuppliedMaintenanceInput(argv);
  rejectEffectfulCommand(argv);

  if (argv[0] === 'change' && argv[1] === 'intervene') {
    if (argv.length !== 5 || !isNonEmpty(argv[2]) || argv[3] !== '--request') {
      throw usage(
        'Usage: change intervene <parent-change-id> --request <json>',
      );
    }
    return {
      command: 'change-intervene',
      parentChangeId: argv[2],
      request: parseRequestJson(argv[4]),
    };
  }

  if (argv[0] === 'engine' && argv[1] === 'adopt') {
    return {
      command: 'engine-adopt',
      request: parseRequestOnly(argv, 'engine adopt'),
    };
  }

  throw workflowError(
    'INTERVENTION_CONTROL_COMMAND_UNSUPPORTED',
    'Unsupported intervention/control-plane command.',
    ExitCode.usage,
  );
}

function rejectCallerSuppliedMaintenanceInput(argv: readonly string[]): void {
  if (
    ((argv[0] === 'change' && argv[1] === 'intervene') ||
      (argv[0] === 'engine' && argv[1] === 'adopt')) &&
    argv.includes('--request')
  ) {
    throw workflowError(
      'INTERVENTION_CALLER_SUPPLIED_MAINTENANCE_INPUT_DISABLED',
      'Production maintenance accepts only durable parent, grant, checkpoint, and artifact records; caller-supplied JSON is disabled.',
      ExitCode.guard,
    );
  }
}

/**
 * Dispatch a parsed M10/M11 request into pure domain functions. Human signed
 * envelopes can only be verified through a callback supplied by the root CLI;
 * this module contains no signer and performs no external effect.
 */
export function dispatchInterventionControlCommand(
  argv: readonly string[],
  dependencies: InterventionControlDispatcherDependencies = {},
): InterventionControlDispatchResult {
  const parsed = parseInterventionControlCommand(argv);
  try {
    switch (parsed.command) {
      case 'change-intervene':
        return dispatchChangeIntervene(parsed);
      case 'engine-adopt':
        return dispatchEngineAdopt(parsed.request, dependencies);
    }
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw workflowError(
      'INTERVENTION_CONTROL_REQUEST_INVALID',
      'Intervention/control-plane request does not match its domain contract.',
      ExitCode.usage,
    );
  }
}

function dispatchChangeIntervene(
  parsed: Extract<ParsedRequestCommand, { command: 'change-intervene' }>,
): Extract<InterventionControlDispatchResult, { kind: 'change-intervene' }> {
  assertExactKeys(
    parsed.request,
    ['checkpoint', 'interventionChangeId', 'parent'],
    'INTERVENTION_CONTROL_REQUEST_INVALID',
  );
  if (!isRecord(parsed.request.parent)) {
    throw invalidRequest();
  }
  if (parsed.request.parent.changeId !== parsed.parentChangeId) {
    throw workflowError(
      'INTERVENTION_CONTROL_PARENT_ARGUMENT_MISMATCH',
      'Parent argument does not match request parent state.',
      ExitCode.verification,
    );
  }
  const checkpoint = createWipCheckpoint(
    parsed.request.checkpoint as WipCheckpointInput,
  );
  const projection = beginHarnessIntervention(
    parsed.request.parent as unknown as ParentChangeState,
    parsed.request.interventionChangeId as string,
    checkpoint,
  );
  return {
    kind: 'change-intervene',
    checkpoint,
    ...projection,
    effectsPerformed: false,
  };
}

function dispatchEngineAdopt(
  request: Record<string, unknown>,
  dependencies: InterventionControlDispatcherDependencies,
): Extract<InterventionControlDispatchResult, { kind: 'engine-adopt' }> {
  if (request.action === 'prepare') {
    if (!hasSignedEnvelope(request.maintenanceGrantEnvelope)) {
      throw workflowError(
        'INTERVENTION_CONTROL_HUMAN_SIGNED_ENVELOPE_REQUIRED',
        'Engine adoption preparation requires a human-signed maintenance envelope.',
        ExitCode.guard,
      );
    }
    const verifyHumanSignature = requireHumanVerifier(dependencies);
    assertExactKeys(
      request,
      [
        'action',
        'artifact',
        'checkpoint',
        'maintenanceGrantEnvelope',
        'parent',
        'priorLocalAdoptions',
        'relationship',
        'txId',
      ],
      'INTERVENTION_CONTROL_REQUEST_INVALID',
    );
    const now = dispatcherNow(dependencies);
    const maintenanceGrant = verifyHarnessMaintenanceGrant(
      request.maintenanceGrantEnvelope as HarnessMaintenanceGrantEnvelope,
      {
        now,
        parent: request.parent as ParentChangeState,
        relationship: request.relationship as HarnessInterventionRelationship,
        checkpoint: request.checkpoint as WipCheckpoint,
        verifyHumanSignature,
      },
    );
    const journal = prepareEngineAdoption({
      txId: request.txId as string,
      parent: request.parent as ParentChangeState,
      relationship: request.relationship as HarnessInterventionRelationship,
      checkpoint: request.checkpoint as WipCheckpoint,
      artifact: request.artifact as EngineArtifact,
      maintenanceGrant,
      priorLocalAdoptions: request.priorLocalAdoptions as number,
      now,
    });
    return { kind: 'engine-adopt', journal, effectsPerformed: false };
  }

  if (request.action === 'transition') {
    assertExactKeys(
      request,
      ['action', 'event', 'journal'],
      'INTERVENTION_CONTROL_REQUEST_INVALID',
    );
    const journal = advanceEngineAdoption(
      request.journal as EngineAdoptionJournal,
      request.event as Parameters<typeof advanceEngineAdoption>[1],
    );
    return { kind: 'engine-adopt', journal, effectsPerformed: false };
  }

  throw workflowError(
    'INTERVENTION_CONTROL_ENGINE_ADOPT_ACTION_UNSUPPORTED',
    'Engine adopt request action must be prepare or transition.',
    ExitCode.usage,
  );
}

function parseRequestOnly(
  argv: readonly string[],
  usagePrefix: string,
): Record<string, unknown> {
  if (argv.length !== 4 || argv[2] !== '--request') {
    throw usage(`Usage: ${usagePrefix} --request <json>`);
  }
  return parseRequestJson(argv[3]);
}

function parseRequestJson(raw: string): Record<string, unknown> {
  if (
    typeof raw !== 'string' ||
    raw.length === 0 ||
    Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BYTES
  ) {
    throw workflowError(
      'INTERVENTION_CONTROL_REQUEST_JSON_INVALID',
      'Request JSON is empty or exceeds the one-megabyte limit.',
      ExitCode.usage,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw workflowError(
      'INTERVENTION_CONTROL_REQUEST_JSON_INVALID',
      'Request is not valid JSON.',
      ExitCode.usage,
    );
  }
  if (!isRecord(value)) {
    throw workflowError(
      'INTERVENTION_CONTROL_REQUEST_JSON_INVALID',
      'Request JSON must be an object.',
      ExitCode.usage,
    );
  }
  rejectMutationIntent(value);
  return value;
}

function rejectEffectfulCommand(argv: readonly string[]): void {
  if (
    (argv[0] === 'engine' || argv[0] === 'control-plane') &&
    argv[1] === 'promote'
  ) {
    throw workflowError(
      'INTERVENTION_CONTROL_GLOBAL_PROMOTION_FORBIDDEN',
      'This dispatcher cannot promote a repository-default engine.',
      ExitCode.guard,
    );
  }
  if (
    argv[0] === 'control-plane' &&
    ['apply', 'commit', 'execute', 'switch-ref', 'update-ref'].includes(
      argv[1] ?? '',
    )
  ) {
    throw workflowError(
      'INTERVENTION_CONTROL_LIVE_REF_MUTATION_FORBIDDEN',
      'This dispatcher cannot mutate a live ref or apply a control-plane candidate.',
      ExitCode.guard,
    );
  }
}

const LIVE_MUTATION_KEYS = new Set([
  'applyToRef',
  'atomicSwitch',
  'commitRef',
  'liveRef',
  'promote',
  'pushRef',
  'refMutation',
  'targetRef',
  'updateRef',
]);

function rejectMutationIntent(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      rejectMutationIntent(item);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (LIVE_MUTATION_KEYS.has(key)) {
      const code =
        key === 'promote'
          ? 'INTERVENTION_CONTROL_GLOBAL_PROMOTION_FORBIDDEN'
          : 'INTERVENTION_CONTROL_LIVE_REF_MUTATION_FORBIDDEN';
      throw workflowError(
        code,
        'Request asks this read-only dispatcher to perform a forbidden mutation.',
        ExitCode.guard,
      );
    }
    rejectMutationIntent(child);
  }
}

function requireHumanVerifier(
  dependencies: InterventionControlDispatcherDependencies,
): InterventionControlHumanSignatureVerifier {
  if (dependencies.verifyHumanSignature === undefined) {
    throw workflowError(
      'INTERVENTION_CONTROL_HUMAN_VERIFIER_REQUIRED',
      'The root CLI must inject a trusted human signature verifier.',
      ExitCode.guard,
    );
  }
  return dependencies.verifyHumanSignature;
}

function dispatcherNow(
  dependencies: InterventionControlDispatcherDependencies,
): Date {
  const now = dependencies.now?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw workflowError(
      'INTERVENTION_CONTROL_CLOCK_INVALID',
      'Dispatcher clock returned an invalid date.',
      ExitCode.unsafeEnvironment,
    );
  }
  return new Date(now.getTime());
}

function hasSignedEnvelope(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.payload) &&
    typeof value.signature === 'string' &&
    value.signature.trim().length > 0
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  code: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw workflowError(
      code,
      'Request fields do not match the selected command contract.',
      ExitCode.usage,
      { details: { expected: sortedExpected, actual } },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isNonEmpty(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim() === value && value.length > 0
  );
}

function invalidRequest(): WorkflowError {
  return workflowError(
    'INTERVENTION_CONTROL_REQUEST_INVALID',
    'Intervention/control-plane request does not match its domain contract.',
    ExitCode.usage,
  );
}

function usage(message: string): WorkflowError {
  return workflowError('INTERVENTION_CONTROL_USAGE', message, ExitCode.usage);
}
