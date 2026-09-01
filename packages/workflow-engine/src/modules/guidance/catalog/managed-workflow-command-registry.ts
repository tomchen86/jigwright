export type WorkflowGuidanceStatus =
  'preferred' | 'compatible' | 'read-only' | 'recovery';

export const MANAGED_WORKFLOW_COMMAND_IDS = [
  'guide',
  'route',
  'route-status',
  'task-preflight',
  'open-task',
  'update-base',
  'revise-task',
  'resume-task',
  'resume',
  'status',
  'check',
  'complete-task',
  'finish',
  'review-diff',
  'maintainer-review-diff-attest',
  'authority-plan',
  'finalize',
  'finalize-recover',
  'rollback-completion',
  'commit',
  'abort',
  'boundary-inventory',
  'boundary-vectors',
  'boundary-remap',
] as const;

export type ManagedWorkflowCommandId =
  (typeof MANAGED_WORKFLOW_COMMAND_IDS)[number];

export type WorkflowCommandGuidance = Readonly<{
  id: ManagedWorkflowCommandId;
  usage: readonly string[];
  status: WorkflowGuidanceStatus;
  purpose: string;
  preconditions: readonly string[];
  consequences: readonly string[];
  successors: readonly ManagedWorkflowCommandId[];
}>;

export type WorkflowGuidanceCatalog = Readonly<{
  schemaVersion: 1;
  kind: 'workflow-command-guide.v1';
  catalogVersion: 'managed-task-lifecycle.v3';
  authority: 'advisory';
  commands: readonly WorkflowCommandGuidance[];
}>;

export type ManagedWorkflowCommandDefinition = WorkflowCommandGuidance &
  Readonly<{
    route: readonly string[];
  }>;

export type ManagedWorkflowCommandRegistry = Readonly<{
  entries: readonly ManagedWorkflowCommandDefinition[];
  resolve: (id: string) => WorkflowCommandGuidance;
  resolveRoute: (route: readonly string[]) => WorkflowCommandGuidance;
  usageLines: () => readonly string[];
  renderCatalog: () => WorkflowGuidanceCatalog;
}>;

const FINALIZE_REPLACEMENT =
  'pnpm workflow finalize <session-id> --message <subject> [--full-gate] [--json]';
const OPEN_TASK_REPLACEMENT =
  'pnpm workflow open-task <change-id> [--task <task-id>] [--mandate <mandate-task-id>] [--json]';
const TASK_PREFLIGHT_USAGE =
  'pnpm workflow task-preflight <change-id> [--task <task-id>] [--json]';

const MANAGED_WORKFLOW_COMMAND_DEFINITIONS = [
  {
    id: 'guide',
    route: ['guide'],
    usage: ['pnpm workflow guide [--json]'],
    status: 'read-only',
    purpose: 'Inspect the versioned managed-task workflow command guide.',
    preconditions: [],
    consequences: ['Reads command guidance without changing repository state.'],
    successors: [],
  },
  {
    id: 'boundary-inventory',
    route: ['boundary', 'inventory'],
    usage: ['pnpm workflow boundary inventory [--check] [--json]'],
    status: 'read-only',
    purpose:
      'Inspect or verify the machine-checked T3 consumer-coupling inventory.',
    preconditions: [],
    consequences: [
      'Reads current source and governed artifacts without changing repository state.',
    ],
    successors: [],
  },
  {
    id: 'boundary-vectors',
    route: ['boundary', 'vectors'],
    usage: ['pnpm workflow boundary vectors [--check] [--json]'],
    status: 'read-only',
    purpose: 'Authenticate the public language-neutral conformance corpus.',
    preconditions: [],
    consequences: [
      'Reads and authenticates the corpus without changing repository state.',
    ],
    successors: [],
  },
  {
    id: 'boundary-remap',
    route: ['boundary', 'remap'],
    usage: ['pnpm workflow boundary remap --input <request.json> [--json]'],
    status: 'read-only',
    purpose:
      'Prove one exact mechanical move and project its authority remap manifest.',
    preconditions: [
      'The input identifies adjacent immutable commits, exact rename pairs, and authority-plan metadata.',
    ],
    consequences: [
      'Projects the exact manifest, generated mutations, and regeneration requirement without applying authority.',
    ],
    successors: [],
  },
  {
    id: 'route',
    route: ['route'],
    usage: [
      'pnpm workflow route <prepare --intent <intent.json> --output <review.json> [--grant <challenge-id>]|apply <review.json>|status> [--json]',
    ],
    status: 'preferred',
    purpose:
      'Inspect or apply one exact reviewed repository change-routing transition.',
    preconditions: [
      'Apply requires a prepared review bound to the exact lifecycle source and current task, Manifest, and PlanReview facts.',
    ],
    consequences: [
      'Publishes the controlled routing source by CAS and deterministically refreshes the repository inventory handoff.',
    ],
    successors: ['route-status'],
  },
  {
    id: 'route-status',
    route: ['route', 'status'],
    usage: ['pnpm workflow route status [--json]'],
    status: 'read-only',
    purpose:
      'Inspect the exact current repository routing state before selecting an executable task transition.',
    preconditions: [],
    consequences: [
      'Reads the controlled routing source and current lifecycle facts without changing repository state.',
    ],
    successors: [],
  },
  {
    id: 'task-preflight',
    route: ['task-preflight'],
    usage: [TASK_PREFLIGHT_USAGE],
    status: 'read-only',
    purpose:
      'Inspect the exact task-session admission and isolation binding without acquiring authority or changing repository state.',
    preconditions: [
      'The clean current branch, planning generation, task, and routing admission are valid.',
    ],
    consequences: [
      'Reads current task scope, isolation conflicts, and Task Mandate requirements without creating a lock, lease, session, journal, or Grant.',
    ],
    successors: ['open-task'],
  },
  {
    id: 'open-task',
    route: ['open-task'],
    usage: [OPEN_TASK_REPLACEMENT],
    status: 'preferred',
    purpose:
      'Open the selected or next incomplete task, committing an owned draft only when required.',
    preconditions: [
      'The branch and either owned draft or replayable planning generation are current; a protected task scope requires an exact active Task Mandate.',
    ],
    consequences: [
      'Selects the planning-state transition and activates one exact task session.',
    ],
    successors: ['status', 'check', 'finalize'],
  },
  {
    id: 'update-base',
    route: ['update-base'],
    usage: ['pnpm workflow update-base <change-id> --onto <ref> [--json]'],
    status: 'preferred',
    purpose:
      'Replay one clean finished managed task branch onto a locally available base and revalidate its current planning authority.',
    preconditions: [
      'No active or revising task session exists for the change.',
      'The clean worktree and branch contain one exact committed finished managed task at the current branch HEAD.',
      'The locally available selected base advances shared history.',
    ],
    consequences: [
      'Revalidates the v3 Manifest, PlanReview, and exact task scope, then invalidates prior check evidence.',
    ],
    successors: ['check', 'status'],
  },
  {
    id: 'revise-task',
    route: ['revise-task'],
    usage: ['pnpm workflow revise-task <session-id> --reason <text> [--json]'],
    status: 'preferred',
    purpose: 'Prepare a reviewed planning-only revision of one active task.',
    preconditions: ['The session can enter its revision transaction.'],
    consequences: [
      'Preserves implementation bytes while recording an exact revision transaction.',
    ],
    successors: ['status', 'resume-task'],
  },
  {
    id: 'resume-task',
    route: ['resume-task'],
    usage: [
      'pnpm workflow resume-task <session-id> [--approval <approval-id>] [--json]',
    ],
    status: 'preferred',
    purpose:
      'Resume the exact durable task revision without replaying ceremony.',
    preconditions: [
      'The supplied approval, when required, matches the revision.',
    ],
    consequences: [
      'Advances only the exact persisted revision and preserves same-digest evidence.',
    ],
    successors: ['status', 'check', 'finalize'],
  },
  {
    id: 'resume',
    route: ['resume'],
    usage: [
      'pnpm workflow resume <session-id> [--actor <provider>] [--grant <grant-id>] [--input <typed-envelope.json>] [--json]',
    ],
    status: 'preferred',
    purpose: 'Resume the next exact durable implementation-strategy substate.',
    preconditions: [
      'The active task and any collaboration grant or typed RED-revision input match the current strategy subject.',
    ],
    consequences: [
      'Seals, schedules, or reconciles only the next persisted strategy transition.',
    ],
    successors: ['status'],
  },
  {
    id: 'status',
    route: ['status'],
    usage: ['pnpm workflow status [investigation-or-task-id] [--json]'],
    status: 'read-only',
    purpose: 'Inspect durable investigation, task, and recovery state.',
    preconditions: [],
    consequences: ['Reads state without advancing a transaction.'],
    successors: [],
  },
  {
    id: 'check',
    route: ['check'],
    usage: ['pnpm workflow check <session-id> [--json]'],
    status: 'compatible',
    purpose: 'Produce current check evidence for the compatible task path.',
    preconditions: ['The session and its task scope are current.'],
    consequences: ['Persists check evidence bound to the exact current diff.'],
    successors: ['complete-task', 'finalize'],
  },
  {
    id: 'complete-task',
    route: ['complete-task'],
    usage: ['pnpm workflow complete-task <session-id> [--json]'],
    status: 'compatible',
    purpose: 'Apply the compatible task and document completion projection.',
    preconditions: [
      'Current passing check evidence exists and the actual diff does not require protected Apply authority.',
    ],
    consequences: ['Projects completion but does not stage or commit it.'],
    successors: ['finish', 'rollback-completion'],
  },
  {
    id: 'finish',
    route: ['finish'],
    usage: ['pnpm workflow finish <session-id> [--json]'],
    status: 'compatible',
    purpose: 'Check and stage the compatible exact completion tree.',
    preconditions: [
      'The completion projection and its review gates are current.',
    ],
    consequences: ['Stages the exact authorized tree without committing it.'],
    successors: ['commit'],
  },
  {
    id: 'review-diff',
    route: ['review-diff'],
    usage: [
      'pnpm workflow review-diff <session-id> [--actor <provider>] [--grant <grant-id>] [--json]',
      'pnpm workflow review-diff <session-id> --input <typed-envelope.json> [--grant <grant-id>] [--json]',
      'pnpm workflow review-diff <inspect|status|reconcile> <session-id> [--json]',
    ],
    status: 'preferred',
    purpose: 'Inspect, run, or reconcile the exact required TaskDiff review.',
    preconditions: [
      'The review subject and any collaboration grant match the current candidate.',
    ],
    consequences: [
      'Records advisory review output; only the shared closure verifier can authorize challenge closure.',
    ],
    successors: ['status', 'finalize'],
  },
  {
    id: 'maintainer-review-diff-attest',
    route: ['maintainer', 'review-diff-attest'],
    usage: [
      'pnpm workflow maintainer review-diff-attest <session-id> --input <typed-envelope.json> --grant <grant-id> [--json]',
    ],
    status: 'recovery',
    purpose:
      'Sign and resume one exact durable direct-human TaskDiff review pause at the controlling maintainer terminal.',
    preconditions: [
      'The typed authority-free input, grant, and persisted content reference exactly match the current direct-human pause.',
    ],
    consequences: [
      'Creates the attestation internally and resumes only the already-persisted review transaction.',
    ],
    successors: ['review-diff', 'status'],
  },
  {
    id: 'authority-plan',
    route: ['authority-plan'],
    usage: [
      'pnpm workflow authority-plan prepare --intent <intent.json> [--json]',
      'pnpm workflow authority-plan status <plan-id> [--json]',
      'pnpm workflow authority-plan approve-and-apply <plan-id> [--json]',
      'pnpm workflow authority-plan resume <plan-id> [--json]',
      'pnpm workflow authority-plan attest <plan-id> [--json]',
    ],
    status: 'preferred',
    purpose:
      'Prepare, inspect, and resume one durable whole-round authority transaction while keeping signing, push, and merge human-controlled.',
    preconditions: [
      'Prepare receives an exact authority intent on the matching clean work branch; approve and attest run only at the controlling maintainer terminal.',
    ],
    consequences: [
      'Persists each local ceremony, remote handoff, merge observation, attestation, and terminal completion as an immutable authority-plan revision.',
    ],
    successors: [],
  },
  {
    id: 'finalize',
    route: ['finalize'],
    usage: [FINALIZE_REPLACEMENT],
    status: 'preferred',
    purpose:
      'Check, project, stage, and commit one exact ordinary candidate tree.',
    preconditions: [
      'The session, strategy evidence, reconciliation, and TaskDiff review gate are current.',
      'The actual implementation diff contains no protected or unclassified path; otherwise use the returned human-only V2 Apply recovery.',
    ],
    consequences: [
      'Runs targeted task checks; when the change closes (or escalation is explicit), terminal policy replaces only declared covered checks and commits the exact checked tree.',
    ],
    successors: ['status'],
  },
  {
    id: 'finalize-recover',
    route: ['finalize-recover'],
    usage: [
      'pnpm workflow finalize-recover <session-id> [--cancel <transaction-id> --reason <text>] [--json]',
    ],
    status: 'recovery',
    purpose:
      'Resume or explicitly cancel one exact durable finalize transaction.',
    preconditions: [
      "The requested transaction is the session's exact active journal.",
    ],
    consequences: [
      'Reconciles only the persisted transaction phase and never invents a replacement.',
    ],
    successors: ['status', 'finalize'],
  },
  {
    id: 'rollback-completion',
    route: ['rollback-completion'],
    usage: [
      'pnpm workflow rollback-completion <session-id> --reason <text> [--json]',
    ],
    status: 'recovery',
    purpose: 'Restore an uncommitted compatible completion projection.',
    preconditions: [
      'The session has a completion projection but is not finished.',
    ],
    consequences: [
      'Restores exact projection bytes and records the rollback reason.',
    ],
    successors: ['status', 'check', 'finalize'],
  },
  {
    id: 'commit',
    route: ['commit'],
    usage: ['pnpm workflow commit <session-id> --message <subject> [--json]'],
    status: 'compatible',
    purpose:
      'Commit an exact tree already staged by a compatible lifecycle path.',
    preconditions: [
      'The staged tree and finish evidence are exact and current.',
    ],
    consequences: [
      'Creates the managed task commit with engine-owned trailers.',
    ],
    successors: ['status'],
  },
  {
    id: 'abort',
    route: ['abort'],
    usage: ['pnpm workflow abort <session-id> --reason <text> [--json]'],
    status: 'preferred',
    purpose:
      'Abandon an active pre-completion session without discarding files.',
    preconditions: ['The session has not completed, finished, or committed.'],
    consequences: ['Records abandonment and releases the lifecycle lock.'],
    successors: ['status'],
  },
] as const satisfies readonly ManagedWorkflowCommandDefinition[];

export function createManagedWorkflowCommandRegistry(
  definitions: readonly ManagedWorkflowCommandDefinition[],
): ManagedWorkflowCommandRegistry {
  const entries = Object.freeze(definitions.map(freezeDefinition));
  const byId = new Map<string, WorkflowCommandGuidance>();
  const byRoute = new Map<string, WorkflowCommandGuidance>();
  const usageLines: string[] = [];
  const seenUsage = new Set<string>();

  for (const entry of entries) {
    if (byId.has(entry.id)) {
      throw new Error('Managed workflow command IDs must be unique.');
    }
    const routeKey = commandRouteKey(entry.route);
    if (byRoute.has(routeKey)) {
      throw new Error('Managed workflow command routes must be unique.');
    }
    if (
      !entry.id ||
      entry.route.length === 0 ||
      entry.route.some((segment) => !segment || /\s/u.test(segment)) ||
      entry.usage.length === 0 ||
      entry.usage.some((line) => !line.startsWith('pnpm workflow ')) ||
      !entry.purpose ||
      entry.consequences.length === 0
    ) {
      throw new Error(`Managed workflow command is invalid: ${entry.id}`);
    }
    for (const usage of entry.usage) {
      if (seenUsage.has(usage)) {
        throw new Error('Managed workflow command usage lines must be unique.');
      }
      seenUsage.add(usage);
      usageLines.push(usage);
    }
    const guidance = projectGuidance(entry);
    byId.set(entry.id, guidance);
    byRoute.set(routeKey, guidance);
  }

  for (const entry of entries) {
    const unknownSuccessor = entry.successors.find((id) => !byId.has(id));
    if (unknownSuccessor !== undefined) {
      throw new Error(
        `Managed workflow command ${entry.id} has unknown successor: ${unknownSuccessor}`,
      );
    }
  }

  const commands = Object.freeze(entries.map(({ id }) => byId.get(id)!));
  const catalog: WorkflowGuidanceCatalog = Object.freeze({
    schemaVersion: 1,
    kind: 'workflow-command-guide.v1',
    catalogVersion: 'managed-task-lifecycle.v3',
    authority: 'advisory',
    commands,
  });
  const frozenUsageLines = Object.freeze(usageLines);

  return Object.freeze({
    entries,
    resolve(id: string): WorkflowCommandGuidance {
      const entry = byId.get(id);
      if (!entry) throw new Error(`Unknown workflow guidance command: ${id}`);
      return entry;
    },
    resolveRoute(route: readonly string[]): WorkflowCommandGuidance {
      const entry = byRoute.get(commandRouteKey(route));
      if (!entry) {
        throw new Error(
          `Unknown workflow guidance command route: ${route.join(' ')}`,
        );
      }
      return entry;
    },
    usageLines(): readonly string[] {
      return frozenUsageLines;
    },
    renderCatalog(): WorkflowGuidanceCatalog {
      return catalog;
    },
  });
}

export const MANAGED_WORKFLOW_COMMAND_REGISTRY =
  createManagedWorkflowCommandRegistry(MANAGED_WORKFLOW_COMMAND_DEFINITIONS);

export function resolveManagedWorkflowCommand(
  id: string,
): WorkflowCommandGuidance {
  return MANAGED_WORKFLOW_COMMAND_REGISTRY.resolve(id);
}

export function resolveManagedWorkflowCommandRoute(
  route: readonly string[],
): WorkflowCommandGuidance {
  return MANAGED_WORKFLOW_COMMAND_REGISTRY.resolveRoute(route);
}

export function managedWorkflowCommandUsageLines(): readonly string[] {
  return MANAGED_WORKFLOW_COMMAND_REGISTRY.usageLines();
}

export function renderManagedWorkflowGuidanceCatalog(): WorkflowGuidanceCatalog {
  return MANAGED_WORKFLOW_COMMAND_REGISTRY.renderCatalog();
}

function freezeDefinition(
  value: ManagedWorkflowCommandDefinition,
): ManagedWorkflowCommandDefinition {
  return Object.freeze({
    id: value.id,
    route: Object.freeze([...value.route]),
    usage: Object.freeze([...value.usage]),
    status: value.status,
    purpose: value.purpose,
    preconditions: Object.freeze([...value.preconditions]),
    consequences: Object.freeze([...value.consequences]),
    successors: Object.freeze([...value.successors]),
  });
}

function projectGuidance(
  entry: ManagedWorkflowCommandDefinition,
): WorkflowCommandGuidance {
  return Object.freeze({
    id: entry.id,
    usage: entry.usage,
    status: entry.status,
    purpose: entry.purpose,
    preconditions: entry.preconditions,
    consequences: entry.consequences,
    successors: entry.successors,
  });
}

function commandRouteKey(route: readonly string[]): string {
  return route.join('\0');
}
