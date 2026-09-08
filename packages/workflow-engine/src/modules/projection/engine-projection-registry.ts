import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type EngineProjectionTransition =
  'archive' | 'completion' | 'plan' | 'rollback-completion';

export type EngineProjectionDefinition = {
  path: string;
  transitions: EngineProjectionTransition[];
};

export type ProjectionPathClassification = {
  taskPaths: string[];
  taskProjectionPaths: string[];
  engineProjectionPaths: string[];
  changedPaths: string[];
};

export type ProjectionId =
  | 'handoff.current-and-next-steps'
  | 'investigation.why-ledger'
  | 'registry.backlog'
  | 'registry.inventory'
  | 'registry.work-history'
  | 'documents.spec-map'
  | 'documents.coverage'
  | 'documents.requirements'
  | 'semantic.binding-index'
  | 'guidance.agent-section';

export type ProjectionDefinition = Readonly<{
  id: ProjectionId;
  version: number;
  target:
    | Readonly<{ kind: 'engine-path'; path: string; configKey?: string }>
    | Readonly<{ kind: 'user-declared'; configKey: string }>;
  placement: 'whole-file' | 'region';
  trigger: readonly Readonly<{
    kind: 'transition' | 'command' | 'init';
    name: string;
  }>[];
  drift: 'regenerate' | 'report';
  authorityTransitions?: readonly EngineProjectionTransition[];
}>;

/** Output declarations do not grant transition authority. Only the existing
 * authorityTransitions entry below participates in privileged path ownership. */
const REGISTRY: readonly ProjectionDefinition[] = Object.freeze([
  Object.freeze({
    id: 'semantic.binding-index',
    version: 1,
    target: Object.freeze({
      kind: 'engine-path',
      path: 'workflow/semantic-ledger/index.json',
    }),
    placement: 'whole-file',
    trigger: Object.freeze([
      { kind: 'transition', name: 'plan' },
      { kind: 'transition', name: 'completion' },
    ] as const),
    drift: 'regenerate',
    authorityTransitions: Object.freeze([
      'plan',
      'completion',
    ] satisfies EngineProjectionTransition[]),
  }),
  ...(
    [
      ['documents.spec-map', 'docs/SPEC_MAP.md'],
      ['documents.coverage', 'docs/COVERAGE.md'],
      ['documents.requirements', 'docs/REQUIREMENTS.md'],
    ] as const
  ).map(([id, path]) =>
    Object.freeze({
      id,
      version: 1,
      target: Object.freeze({ kind: 'engine-path' as const, path }),
      placement: 'whole-file' as const,
      trigger: Object.freeze([
        { kind: 'command', name: 'documents render' },
      ] as const),
      drift: 'regenerate' as const,
    }),
  ),
  Object.freeze({
    id: 'handoff.current-and-next-steps',
    version: 1,
    target: Object.freeze({
      kind: 'engine-path',
      path: 'docs/CURRENT_AND_NEXT_STEPS.md',
      configKey: 'documents.handoffPath',
    }),
    placement: 'whole-file',
    trigger: Object.freeze([
      { kind: 'transition', name: 'managed-lifecycle' },
    ] as const),
    drift: 'regenerate',
    authorityTransitions: Object.freeze([
      'archive',
      'completion',
      'plan',
      'rollback-completion',
    ] satisfies EngineProjectionTransition[]),
  }),
  Object.freeze({
    id: 'investigation.why-ledger',
    version: 1,
    target: Object.freeze({
      kind: 'engine-path',
      path: '<changeRoot>/<changeId>/design.md',
      configKey: 'changeRoot',
    }),
    placement: 'region',
    trigger: Object.freeze([{ kind: 'transition', name: 'plan' }] as const),
    drift: 'regenerate',
  }),
  ...(
    [
      ['registry.backlog', 'docs/BACKLOG.md', 'workRegistry.backlogPath'],
      [
        'registry.inventory',
        'docs/work-registry/inventory.json',
        'workRegistry.inventoryPath',
      ],
      [
        'registry.work-history',
        'docs/work-history/<year>.md',
        'workRegistry.historyRoot',
      ],
    ] as const
  ).map(([id, path, configKey]) =>
    Object.freeze({
      id,
      version: 1,
      target: Object.freeze({ kind: 'engine-path' as const, path, configKey }),
      placement: 'whole-file' as const,
      trigger: Object.freeze([
        { kind: 'command', name: 'work-item render' },
      ] as const),
      drift: 'regenerate' as const,
    }),
  ),
  Object.freeze({
    id: 'guidance.agent-section',
    version: 1,
    target: Object.freeze({
      kind: 'user-declared',
      configKey: 'agent-guidance.targets',
    }),
    placement: 'region',
    trigger: Object.freeze([
      { kind: 'command', name: 'guidance install' },
      { kind: 'command', name: 'guidance refresh' },
      { kind: 'init', name: 'confirmed-targets' },
    ] as const),
    drift: 'report',
  }),
]);

export function projectionDefinitions(): readonly ProjectionDefinition[] {
  return REGISTRY;
}

export function projectionDefinition(id: string): ProjectionDefinition {
  const definition = REGISTRY.find((entry) => entry.id === id);
  if (!definition) {
    throw workflowError(
      'PROJECTION_ID_UNKNOWN',
      `Unknown projection: ${id}.`,
      ExitCode.usage,
    );
  }
  return definition;
}

/**
 * Returns a copy of the reviewed, engine-owned projection registry. Repository
 * policy may enable an entry but cannot add another output path or transition.
 */
export function engineProjectionDefinitions(): EngineProjectionDefinition[] {
  return REGISTRY.flatMap((definition) =>
    definition.target.kind === 'engine-path' && definition.authorityTransitions
      ? [
          {
            path: definition.target.path,
            transitions: [...definition.authorityTransitions],
          },
        ]
      : [],
  );
}

export function engineProjectionPathsForTransition(
  transition: EngineProjectionTransition,
): string[] {
  return engineProjectionDefinitions()
    .filter(({ transitions }) => transitions.includes(transition))
    .map(({ path }) => path);
}

export function isSemanticProjectionPath(candidate: string): boolean {
  return (
    candidate === 'workflow/semantic-ledger/index.json' ||
    /^workflow\/semantic-ledger\/objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{62}\.json$/.test(
      candidate,
    )
  );
}

export function isEngineProjectionPathForTransition(
  candidate: string,
  transition: EngineProjectionTransition,
): boolean {
  return (
    engineProjectionPathsForTransition(transition).includes(candidate) ||
    (projectionDefinition(
      'semantic.binding-index',
    ).authorityTransitions?.includes(transition) === true &&
      isSemanticProjectionPath(candidate))
  );
}

export function classifyProjectionPaths(
  changedPaths: string[],
  taskProjectionPaths: string[],
  engineProjectionPaths: string[],
): ProjectionPathClassification {
  const changed = sortedUnique(changedPaths);
  const taskProjections = sortedUnique(taskProjectionPaths);
  const engineProjections = sortedUnique(engineProjectionPaths);
  if (
    changed.length !== changedPaths.length ||
    taskProjections.length !== taskProjectionPaths.length ||
    engineProjections.length !== engineProjectionPaths.length ||
    taskProjections.some(
      (projectionPath) => !changed.includes(projectionPath),
    ) ||
    engineProjections.some(
      (projectionPath) =>
        !changed.includes(projectionPath) ||
        taskProjections.includes(projectionPath),
    )
  ) {
    throw workflowError(
      'PROJECTION_PATH_CLASSIFICATION_INVALID',
      'Projection path categories must be disjoint subsets of the exact changed paths.',
      ExitCode.verification,
    );
  }
  const projections = new Set([...taskProjections, ...engineProjections]);
  return {
    taskPaths: changed.filter((changedPath) => !projections.has(changedPath)),
    taskProjectionPaths: taskProjections,
    engineProjectionPaths: engineProjections,
    changedPaths: changed,
  };
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
