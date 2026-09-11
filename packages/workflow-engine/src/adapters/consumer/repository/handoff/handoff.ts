import type { ChangeRoutingInspector } from '../../../../modules/lifecycle/change-routing.ts';
import type { HandoffChange, HandoffReadContext } from '../../../../modules/projection/handoff.ts';
export type { HandoffChange, HandoffReadContext } from '../../../../modules/projection/handoff.ts';
import type { ChangeContractReader } from '../../../../modules/planning-provider/change-contract.ts';
/**
 * Projects and validates the handoff document from controlled workflow and
 * routing facts.
 *
 * Invariants:
 * - Validation requires exact projected bytes and section order and rejects
 *   visible commit identities or runtime session identifiers.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  AtomicTextSafetyError,
  replaceTextAtomic,
} from '../../../../runtime/repository-transaction/atomic-text.ts';

import { parseTasks } from '../../../../modules/planning-provider/planning-artifact-parsers.ts';
import { loadWorkflowConfig } from '../../../../runtime/repository-observation/workflow-configuration.ts';
import { type ParsedTask } from '../../../../modules/planning-provider/planning-artifact-types.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import { assertChangeId } from '../../../../foundation/repository-path/repository-path.ts';
import { changeLifecycleRelativePath, parseChangeLifecycleSource, type ChangeRoutingAuthorityPort, type ChangeRoutingInspection, type ChangeRoutingObservation } from '../../../../modules/lifecycle/change-routing.ts';

import {
  repositoryConsumerPath,
  loadRepositoryConsumerConfiguration,
} from '../../../../runtime/repository-observation/repository-consumer.ts';

const LEGACY_SECTIONS = [
  'Current Change',
  'Current Task',
  'Next Task',
  'Current Focus',
  'Known Blockers',
  'References',
];

const ROUTING_SECTIONS = [
  'Current Work',
  'Concurrent Work',
  'Ready Changes',
  'Ready to Resume',
  'Blocked Changes',
  'Parked Changes',
  'Pending Archival',
  'Unassigned Repository Blockers',
  'References',
];



type RepositoryTextReader = (relativePath: string) => string | undefined;



export function renderHandoff(routingInspector: ChangeRoutingInspector, loadChangeContract: ChangeContractReader,
  repositoryRoot: string,
  authorityPort?: ChangeRoutingAuthorityPort,
): string {
  const rendered = projectHandoff(routingInspector, loadChangeContract, repositoryRoot, authorityPort);
  writeTextAtomic(handoffPath(repositoryRoot), rendered);
  return rendered;
}

/**
 * Render from tracked repository facts only. Durable transition and CI replay
 * callers use this projection so Git-common task runtime cannot change bytes.
 */
export function renderHandoffFromTrackedFacts(routingInspector: ChangeRoutingInspector, loadChangeContract: ChangeContractReader, repositoryRoot: string): string {
  const rendered = buildHandoff(routingInspector, loadChangeContract, repositoryRoot, undefined, undefined, {
    contracts: liveContracts(loadChangeContract, repositoryRoot),
    readText: (relativePath) =>
      readTrackedHandoffSource(repositoryRoot, relativePath),
  });
  writeTextAtomic(handoffPath(repositoryRoot), rendered);
  return rendered;
}

export function projectHandoff(routingInspector: ChangeRoutingInspector, loadChangeContract: ChangeContractReader,
  repositoryRoot: string,
  authorityPort?: ChangeRoutingAuthorityPort,
): string {
  return buildHandoff(routingInspector, loadChangeContract,
    repositoryRoot,
    undefined,
    undefined,
    undefined,
    authorityPort,
  );
}

/** Build completion handoff bytes from an exact prospective tasks projection. */
export function projectHandoffForTaskProjection(routingInspector: ChangeRoutingInspector, loadChangeContract: ChangeContractReader,
  repositoryRoot: string,
  requestedChangeId: string,
  projectedTasks: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  return buildHandoff(routingInspector, loadChangeContract, repositoryRoot, undefined, {
    changeId,
    tasks: parseTasks(projectedTasks),
  });
}

/**
 * Render the handoff for one explicit lifecycle-owned change. The existing
 * handoff bytes are deliberately not consulted: generated output is never an
 * authority input for the transition that replaces it.
 */
export function renderHandoffForChange(routingInspector: ChangeRoutingInspector, loadChangeContract: ChangeContractReader,
  repositoryRoot: string,
  requestedChangeId: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  const rendered = buildHandoff(routingInspector, loadChangeContract, repositoryRoot, changeId);
  writeTextAtomic(handoffPath(repositoryRoot), rendered);
  return rendered;
}

function buildHandoff(routingInspector: ChangeRoutingInspector, loadChangeContract: ChangeContractReader,
  repositoryRoot: string,
  selectedChangeId?: string,
  projectedChange?: HandoffChange,
  readContext?: HandoffReadContext,
  authorityPort?: ChangeRoutingAuthorityPort,
): string {
  const routedSource =
    readContext === undefined
      ? fs.existsSync(path.join(repositoryRoot, changeLifecycleRelativePath))
        ? fs.readFileSync(
            path.join(repositoryRoot, changeLifecycleRelativePath),
            'utf8',
          )
        : undefined
      : readContext.readText(changeLifecycleRelativePath);
  if (routedSource !== undefined) {
    return buildRoutingHandoff(routingInspector,
      repositoryRoot,
      readContext,
      routedSource,
      selectedChangeId,
      projectedChange,
      authorityPort,
    );
  }
  const contract = selectChange(loadChangeContract, 
    repositoryRoot,
    selectedChangeId,
    projectedChange,
    readContext,
  );
  const currentIndex =
    contract === null
      ? -1
      : contract.tasks.findIndex(({ completed }) => !completed);
  const current =
    contract === null || currentIndex === -1
      ? undefined
      : contract.tasks[currentIndex];
  const next =
    contract !== null && current
      ? contract.tasks.slice(currentIndex + 1)[0]
      : undefined;
  const blockers = readBlockers(repositoryRoot, readContext?.readText);
  return [
    '# Current and Next Steps',
    '',
    'This generated handoff contains semantic project state only. Its sources are tracked OpenSpec change records and the Git-native Work Registry.',
    '',
    '## Current Change',
    '',
    contract === null ? 'None.' : `\`${contract.changeId}\``,
    '',
    '## Current Task',
    '',
    contract === null
      ? 'None — no active change.'
      : current
        ? `\`${current.id}\` — ${current.title}`
        : 'None — all tasks are complete.',
    '',
    '## Next Task',
    '',
    next ? `\`${next.id}\` — ${next.title}` : 'None.',
    '',
    '## Current Focus',
    '',
    contract === null
      ? 'No active OpenSpec change; follow the Roadmap for the next explicit transition.'
      : current
        ? current.title
        : 'No implementation tasks remain; follow the Roadmap for the next explicit transition.',
    '',
    '## Known Blockers',
    '',
    ...(blockers.length > 0
      ? blockers.map((blocker) => `- \`${blocker.id}\` — ${blocker.title}`)
      : ['None.']),
    '',
    '## References',
    '',
    '- [Roadmap](ROADMAP.md)',
    '- [Change records](../openspec/changes/)',
    `- [Base specifications](${handoffSpecificationsLink(repositoryRoot, readContext)})`,
    `- [Work backlog](${handoffLink(repositoryRoot, loadRepositoryConsumerConfiguration(repositoryRoot).configuration.workRegistry.backlogPath)})`,
    '- [System architecture](architecture/ARCHITECTURE.md)',
    '',
  ].join('\n');
}

function buildRoutingHandoff(routingInspector: ChangeRoutingInspector,
  repositoryRoot: string,
  readContext: HandoffReadContext | undefined,
  sourceBytes: string,
  selectedChangeId?: string,
  projectedChange?: HandoffChange,
  authorityPort?: ChangeRoutingAuthorityPort,
): string {
  const observedInspection =
    readContext === undefined
      ? routingInspector(repositoryRoot, authorityPort)
      : inspectCommittedRouting(readContext, sourceBytes);
  const inspection = projectRoutingInspection(
    observedInspection,
    selectedChangeId,
    projectedChange,
  );
  const primary =
    inspection.primaryChangeId === null
      ? undefined
      : inspection.changes.find(
          ({ changeId }) => changeId === inspection.primaryChangeId,
        );
  const blockers = readBlockers(repositoryRoot, readContext?.readText);
  const unassigned = blockers;
  return [
    '# Current and Next Steps',
    '',
    'This generated repository inventory is derived from controlled lifecycle, task, Work Registry, and archive facts.',
    '',
    '## Current Work',
    '',
    primary
      ? `\`${primary.changeId}\` — ${stateLabel(primary)}`
      : 'None — no managed primary focus.',
    '',
    '## Concurrent Work',
    '',
    ...renderRoutingChanges(
      inspection.changes.filter(({ state }) => state === 'concurrent'),
    ),
    '',
    '## Ready Changes',
    '',
    ...renderRoutingChanges(
      inspection.changes.filter(({ state }) => state === 'ready'),
    ),
    '',
    '## Ready to Resume',
    '',
    ...renderRoutingChanges(
      inspection.changes.filter(({ state }) => state === 'resume-available'),
    ),
    '',
    '## Blocked Changes',
    '',
    ...renderRoutingChanges(
      inspection.changes.filter(
        ({ state }) => state === 'blocked' || state === 'recovery-required',
      ),
    ),
    '',
    '## Parked Changes',
    '',
    ...renderRoutingChanges(
      inspection.changes.filter(({ state }) => state === 'parked'),
    ),
    '',
    '## Pending Archival',
    '',
    ...renderRoutingChanges(
      inspection.changes.filter(
        ({ state }) => state === 'completed-awaiting-archive',
      ),
    ),
    '',
    '## Unassigned Repository Blockers',
    '',
    ...(unassigned.length > 0
      ? unassigned.map((blocker) => `- \`${blocker.id}\` — ${blocker.title}`)
      : ['None.']),
    '',
    '## References',
    '',
    '- [Roadmap](ROADMAP.md)',
    '- [Change lifecycle](../openspec/change-lifecycle.json)',
    '- [Change records](../openspec/changes/)',
    `- [Base specifications](${handoffSpecificationsLink(repositoryRoot, readContext)})`,
    `- [Work backlog](${handoffLink(repositoryRoot, loadRepositoryConsumerConfiguration(repositoryRoot).configuration.workRegistry.backlogPath)})`,
    '',
  ].join('\n');
}

function projectRoutingInspection(
  inspection: ChangeRoutingInspection,
  selectedChangeId?: string,
  projectedChange?: HandoffChange,
): ChangeRoutingInspection {
  if (
    selectedChangeId !== undefined &&
    !inspection.changes.some(({ changeId }) => changeId === selectedChangeId)
  ) {
    throw invalidHandoff(
      'HANDOFF_CHANGE_INVALID',
      'The lifecycle-owned handoff change has no tracked task contract.',
    );
  }
  if (projectedChange === undefined) return inspection;
  const projected = inspection.changes.find(
    ({ changeId }) => changeId === projectedChange.changeId,
  );
  if (projected === undefined) {
    throw invalidHandoff(
      'HANDOFF_CHANGE_INVALID',
      'The prospective handoff change has no tracked task contract.',
    );
  }
  const completed =
    projectedChange.tasks.length > 0 &&
    projectedChange.tasks.every(
      ({ completed: taskCompleted }) => taskCompleted,
    );
  const changes = inspection.changes.map((change) => {
    if (change.changeId === projectedChange.changeId) {
      return Object.freeze({
        ...change,
        state: completed
          ? ('completed-awaiting-archive' as const)
          : change.state,
        tasks: Object.freeze(
          projectedChange.tasks.map((task) => Object.freeze({ ...task })),
        ),
      });
    }
    if (
      completed &&
      change.state === 'blocked' &&
      change.blocker?.kind === 'change' &&
      change.blocker.id === projectedChange.changeId &&
      change.blocker.resumeCondition === 'done'
    ) {
      return Object.freeze({
        ...change,
        state: 'resume-available' as const,
      });
    }
    return change;
  });
  return Object.freeze({
    ...inspection,
    primaryChangeId:
      completed && inspection.primaryChangeId === projectedChange.changeId
        ? null
        : inspection.primaryChangeId,
    changes: Object.freeze(changes),
  });
}

function inspectCommittedRouting(
  readContext: HandoffReadContext,
  sourceBytes: string,
): ChangeRoutingInspection {
  let value: unknown;
  try {
    value = JSON.parse(sourceBytes) as unknown;
  } catch {
    throw invalidHandoff(
      'HANDOFF_CHANGE_LIFECYCLE_INVALID',
      'Committed change lifecycle source is invalid.',
    );
  }
  const source = parseChangeLifecycleSource(value);
  if (sourceBytes !== `${JSON.stringify(source, null, 2)}\n`) {
    throw invalidHandoff(
      'HANDOFF_CHANGE_LIFECYCLE_INVALID',
      'Committed change lifecycle source is not canonical.',
    );
  }
  const records = new Map(
    source.records.map((record) => [record.changeId, record]),
  );
  const completed = new Set(
    readContext.contracts
      .filter(
        ({ tasks }) =>
          tasks.length > 0 && tasks.every((task) => task.completed),
      )
      .map(({ changeId }) => changeId),
  );
  const changes = [...readContext.contracts]
    .sort((left, right) => left.changeId.localeCompare(right.changeId))
    .map((contract): ChangeRoutingObservation => {
      const record = records.get(contract.changeId) ?? {
        changeId: contract.changeId,
        disposition: 'ready' as const,
        reason: null,
        taskId: null,
        blocker: null,
      };
      const blockerSatisfied =
        record.blocker?.kind === 'change' &&
        record.blocker.resumeCondition !== 'manual' &&
        completed.has(record.blocker.id);
      const state = completed.has(contract.changeId)
        ? ('completed-awaiting-archive' as const)
        : record.disposition === 'blocked'
          ? blockerSatisfied
            ? ('resume-available' as const)
            : ('blocked' as const)
          : record.disposition === 'parked'
            ? ('parked' as const)
            : source.primaryChangeId === contract.changeId
              ? ('primary' as const)
              : source.concurrentChangeIds.includes(contract.changeId)
                ? ('concurrent' as const)
                : ('ready' as const);
      return Object.freeze({
        changeId: contract.changeId,
        state,
        reason: record.reason,
        taskId: record.taskId,
        blocker: record.blocker,
        tasks: Object.freeze(
          contract.tasks.map((task) => Object.freeze({ ...task })),
        ),
      });
    });
  return Object.freeze({
    schemaVersion: 1 as const,
    sourcePresent: true,
    sourceDigest: null,
    primaryChangeId:
      source.primaryChangeId !== null &&
      changes.some(
        ({ changeId, state }) =>
          changeId === source.primaryChangeId &&
          state !== 'completed-awaiting-archive',
      )
        ? source.primaryChangeId
        : null,
    concurrentChangeIds: Object.freeze(
      source.concurrentChangeIds.filter((changeId) =>
        changes.some(
          (change) =>
            change.changeId === changeId &&
            change.state !== 'completed-awaiting-archive',
        ),
      ),
    ),
    changes: Object.freeze(changes),
  });
}

function renderRoutingChanges(
  changes: readonly ChangeRoutingObservation[],
): string[] {
  if (changes.length === 0) return ['None.'];
  return changes.map((change) => {
    const reason = change.reason === null ? '' : ` — ${change.reason}`;
    const blocker =
      change.blocker === null
        ? ''
        : ` [${change.blocker.kind}:${change.blocker.id}; resume=${change.blocker.resumeCondition}]`;
    return `- \`${change.changeId}\` — ${stateLabel(change)}${reason}${blocker}`;
  });
}

function stateLabel(change: ChangeRoutingObservation): string {
  if (change.state === 'primary' || change.state === 'revising') {
    const task = change.tasks.find(({ completed }) => !completed);
    return task ? `task ${task.id}: ${task.title}` : change.state;
  }
  return change.state;
}

export function validateHandoff(routingInspector: ChangeRoutingInspector, loadChangeContract: ChangeContractReader,
  repositoryRoot: string,
  readContext?: HandoffReadContext,
): void {
  const expected = buildHandoff(routingInspector, loadChangeContract,
    repositoryRoot,
    undefined,
    undefined,
    readContext,
  );
  assertHandoffBytes(repositoryRoot, expected, readContext?.readText);
}

export function validateHandoffForChange(routingInspector: ChangeRoutingInspector, loadChangeContract: ChangeContractReader,
  repositoryRoot: string,
  requestedChangeId: string,
): void {
  const changeId = assertChangeId(requestedChangeId);
  const expected = buildHandoff(routingInspector, loadChangeContract, repositoryRoot, changeId);
  assertHandoffBytes(repositoryRoot, expected);
}

function assertHandoffBytes(
  repositoryRoot: string,
  expected: string,
  readText?: RepositoryTextReader,
): void {
  let actual: string;
  try {
    const source = readText
      ? readText(
          loadRepositoryConsumerConfiguration(repositoryRoot).configuration
            .documents.handoffPath,
        )
      : fs.readFileSync(handoffPath(repositoryRoot), 'utf8');
    if (source === undefined) throw new Error('handoff is missing');
    actual = source;
  } catch {
    throw invalidHandoff('HANDOFF_MISSING', 'Generated handoff is missing.');
  }
  const sections = [...actual.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  const expectedSections =
    fs.existsSync(path.join(repositoryRoot, changeLifecycleRelativePath)) ||
    readText?.(changeLifecycleRelativePath) !== undefined
      ? ROUTING_SECTIONS
      : LEGACY_SECTIONS;
  if (
    actual !== expected ||
    JSON.stringify(sections) !== JSON.stringify(expectedSections) ||
    /\b[0-9a-f]{40,64}\b/i.test(actual) ||
    /session-[A-Za-z0-9-]+/.test(actual)
  ) {
    throw invalidHandoff(
      'HANDOFF_DRIFT',
      'Semantic handoff differs from its controlled sources.',
    );
  }
}

function selectChange(loadChangeContract: ChangeContractReader, 
  repositoryRoot: string,
  explicitChangeId?: string,
  projectedChange?: HandoffChange,
  readContext?: HandoffReadContext,
): HandoffChange | null {
  const contracts = readContext
    ? readContext.contracts.map((contract) => ({
        changeId: contract.changeId,
        tasks: contract.tasks.map((task) => ({ ...task })),
      }))
    : liveContracts(loadChangeContract, repositoryRoot);
  if (projectedChange) {
    const projectedIndex = contracts.findIndex(
      ({ changeId }) => changeId === projectedChange.changeId,
    );
    if (projectedIndex < 0) {
      throw invalidHandoff(
        'HANDOFF_CHANGE_INVALID',
        'The prospective handoff change has no tracked task contract.',
      );
    }
    contracts[projectedIndex] = {
      ...contracts[projectedIndex],
      tasks: projectedChange.tasks,
    };
  }
  const active = contracts.filter((contract) =>
    contract.tasks.some(({ completed }) => !completed),
  );
  if (explicitChangeId !== undefined) {
    const explicit = contracts.find(
      (contract) => contract.changeId === explicitChangeId,
    );
    if (!explicit) {
      throw invalidHandoff(
        'HANDOFF_CHANGE_INVALID',
        'The lifecycle-owned handoff change has no tracked task contract.',
      );
    }
    return explicit;
  }
  if (active.length === 1) {
    return active[0];
  }
  if (active.length === 0) return null;
  throw invalidHandoff(
    'HANDOFF_CHANGE_AMBIGUOUS',
    'The handoff requires at most one active change.',
  );
}

function liveContracts(loadChangeContract: ChangeContractReader, repositoryRoot: string): HandoffChange[] {
  const config = loadWorkflowConfig(repositoryRoot);
  const root = path.join(repositoryRoot, config.changeRoot);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .map((entry) => loadChangeContract(repositoryRoot, entry.name));
}

function readTrackedHandoffSource(
  repositoryRoot: string,
  relativePath: string,
): string | undefined {
  const sourcePath = repositoryConsumerPath(repositoryRoot, relativePath);
  const stats = fs.lstatSync(sourcePath, { throwIfNoEntry: false });
  if (stats === undefined) return undefined;
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw invalidHandoff(
      'HANDOFF_SOURCE_UNSAFE',
      'A tracked handoff source is not one plain file.',
    );
  }
  return fs.readFileSync(sourcePath, 'utf8');
}

function readBlockers(repositoryRoot: string, readText?: RepositoryTextReader) {
  const inventory = readWorkRegistryInventory(repositoryRoot, readText);
  if (inventory === null) return [];
  const blocked = new Set(inventory.blockedItemIds);
  return inventory.items
    .filter((item) => item.stage !== 'closed' && blocked.has(item.id))
    .map((item) => ({ id: item.id, title: item.title }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

type WorkRegistryHandoffInventory = Readonly<{
  items: readonly Readonly<{
    id: string;
    title: string;
    stage: string;
    aliases: readonly string[];
  }>[];
  blockedItemIds: readonly string[];
}>;

function readWorkRegistryInventory(
  repositoryRoot: string,
  readText?: RepositoryTextReader,
): WorkRegistryHandoffInventory | null {
  const workRegistry =
    loadRepositoryConsumerConfiguration(repositoryRoot).configuration
      .workRegistry;
  const inventoryPath = workRegistry.inventoryPath;
  const source = readText
    ? readText(inventoryPath)
    : fs.existsSync(repositoryConsumerPath(repositoryRoot, inventoryPath))
      ? fs.readFileSync(
          repositoryConsumerPath(repositoryRoot, inventoryPath),
          'utf8',
        )
      : undefined;
  if (source === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw invalidHandoff(
      'HANDOFF_WORK_REGISTRY_INVALID',
      'Generated Work Registry inventory is invalid.',
    );
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Array.isArray((value as { items?: unknown }).items) ||
    !(value as { items: unknown[] }).items.every(
      (item) =>
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        typeof (item as { id?: unknown }).id === 'string' &&
        /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test((item as { id: string }).id) &&
        typeof (item as { title?: unknown }).title === 'string' &&
        Array.isArray((item as { aliases?: unknown }).aliases) &&
        (item as { aliases: unknown[] }).aliases.every(
          (alias) => typeof alias === 'string',
        ) &&
        ['inbox', 'backlog', 'active', 'closed'].includes(
          String((item as { stage?: unknown }).stage),
        ),
    ) ||
    !Array.isArray((value as { blockedItemIds?: unknown }).blockedItemIds) ||
    !(value as { blockedItemIds: unknown[] }).blockedItemIds.every(
      (id) =>
        typeof id === 'string' && /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(id),
    )
  ) {
    throw invalidHandoff(
      'HANDOFF_WORK_REGISTRY_INVALID',
      'Generated Work Registry inventory is invalid.',
    );
  }
  return value as WorkRegistryHandoffInventory;
}

function writeTextAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw invalidHandoff(
      'HANDOFF_PATH_UNSAFE',
      'Managed handoff path is not a plain file.',
    );
  }
  if (existing && fs.readFileSync(filePath, 'utf8') === content) {
    return;
  }
  try {
    replaceTextAtomic(filePath, content, {
      allowCreate: true,
      defaultMode: existing?.mode ?? 0o644,
    });
  } catch (error) {
    if (error instanceof AtomicTextSafetyError) {
      throw invalidHandoff(
        'HANDOFF_PATH_UNSAFE',
        'Managed handoff path is not a plain file.',
      );
    }
    throw error;
  }
}

function handoffPath(repositoryRoot: string): string {
  return repositoryConsumerPath(
    repositoryRoot,
    loadRepositoryConsumerConfiguration(repositoryRoot).configuration.documents
      .handoffPath,
  );
}

function handoffLink(repositoryRoot: string, targetPath: string): string {
  const handoff =
    loadRepositoryConsumerConfiguration(repositoryRoot).configuration.documents
      .handoffPath;
  return path.posix.relative(path.posix.dirname(handoff), targetPath);
}

function handoffSpecificationsLink(
  repositoryRoot: string,
  readContext?: HandoffReadContext,
): string {
  const mapPath = 'docs/SPEC_MAP.md';
  const map = readContext
    ? readContext.readText(mapPath)
    : readTrackedHandoffSource(repositoryRoot, mapPath);
  return map === undefined
    ? `${handoffLink(repositoryRoot, 'openspec/specs')}/`
    : handoffLink(repositoryRoot, mapPath);
}

function invalidHandoff(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}
