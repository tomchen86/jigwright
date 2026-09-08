import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
/** Output declarations do not grant transition authority. Only the existing
 * authorityTransitions entry below participates in privileged path ownership. */
const REGISTRY = Object.freeze([
    ...['governance-intake', 'authority'].map((module) => Object.freeze({
        id: `documents.${module}-readme`,
        version: 1,
        target: Object.freeze({
            kind: 'engine-path',
            path: `packages/workflow-engine/src/modules/${module}/README.md`,
        }),
        placement: 'region',
        trigger: Object.freeze([
            { kind: 'command', name: 'documents render' },
        ]),
        drift: 'regenerate',
    })),
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
        ]),
        drift: 'regenerate',
        authorityTransitions: Object.freeze([
            'plan',
            'completion',
        ]),
    }),
    ...[
        ['documents.spec-map', 'docs/SPEC_MAP.md'],
        ['documents.coverage', 'docs/COVERAGE.md'],
        ['documents.requirements', 'docs/REQUIREMENTS.md'],
    ].map(([id, path]) => Object.freeze({
        id,
        version: 1,
        target: Object.freeze({ kind: 'engine-path', path }),
        placement: 'whole-file',
        trigger: Object.freeze([
            { kind: 'command', name: 'documents render' },
        ]),
        drift: 'regenerate',
    })),
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
        ]),
        drift: 'regenerate',
        authorityTransitions: Object.freeze([
            'archive',
            'completion',
            'plan',
            'rollback-completion',
        ]),
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
        trigger: Object.freeze([{ kind: 'transition', name: 'plan' }]),
        drift: 'regenerate',
    }),
    ...[
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
    ].map(([id, path, configKey]) => Object.freeze({
        id,
        version: 1,
        target: Object.freeze({ kind: 'engine-path', path, configKey }),
        placement: 'whole-file',
        trigger: Object.freeze([
            { kind: 'command', name: 'work-item render' },
        ]),
        drift: 'regenerate',
    })),
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
        ]),
        drift: 'report',
    }),
]);
export function projectionDefinitions() {
    return REGISTRY;
}
export function projectionDefinition(id) {
    const definition = REGISTRY.find((entry) => entry.id === id);
    if (!definition) {
        throw workflowError('PROJECTION_ID_UNKNOWN', `Unknown projection: ${id}.`, ExitCode.usage);
    }
    return definition;
}
/**
 * Returns a copy of the reviewed, engine-owned projection registry. Repository
 * policy may enable an entry but cannot add another output path or transition.
 */
export function engineProjectionDefinitions() {
    return REGISTRY.flatMap((definition) => definition.target.kind === 'engine-path' && definition.authorityTransitions
        ? [
            {
                path: definition.target.path,
                transitions: [...definition.authorityTransitions],
            },
        ]
        : []);
}
export function engineProjectionPathsForTransition(transition) {
    return engineProjectionDefinitions()
        .filter(({ transitions }) => transitions.includes(transition))
        .map(({ path }) => path);
}
export function isSemanticProjectionPath(candidate) {
    return (candidate === 'workflow/semantic-ledger/index.json' ||
        /^workflow\/semantic-ledger\/objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{62}\.json$/.test(candidate));
}
export function isEngineProjectionPathForTransition(candidate, transition) {
    return (engineProjectionPathsForTransition(transition).includes(candidate) ||
        (projectionDefinition('semantic.binding-index').authorityTransitions?.includes(transition) === true &&
            isSemanticProjectionPath(candidate)));
}
export function classifyProjectionPaths(changedPaths, taskProjectionPaths, engineProjectionPaths) {
    const changed = sortedUnique(changedPaths);
    const taskProjections = sortedUnique(taskProjectionPaths);
    const engineProjections = sortedUnique(engineProjectionPaths);
    if (changed.length !== changedPaths.length ||
        taskProjections.length !== taskProjectionPaths.length ||
        engineProjections.length !== engineProjectionPaths.length ||
        taskProjections.some((projectionPath) => !changed.includes(projectionPath)) ||
        engineProjections.some((projectionPath) => !changed.includes(projectionPath) ||
            taskProjections.includes(projectionPath))) {
        throw workflowError('PROJECTION_PATH_CLASSIFICATION_INVALID', 'Projection path categories must be disjoint subsets of the exact changed paths.', ExitCode.verification);
    }
    const projections = new Set([...taskProjections, ...engineProjections]);
    return {
        taskPaths: changed.filter((changedPath) => !projections.has(changedPath)),
        taskProjectionPaths: taskProjections,
        engineProjectionPaths: engineProjections,
        changedPaths: changed,
    };
}
function sortedUnique(values) {
    return [...new Set(values)].sort();
}
