import fs from 'node:fs';
import path from 'node:path';

import {
  AtomicTextSafetyError,
  replaceTextAtomic,
} from '../../../../runtime/repository-transaction/atomic-text.ts';
import {
  loadChangeContract,
  loadWorkflowConfig,
  parseTasks,
  type ParsedTask,
} from '../work-registry/contracts.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  readIssueData,
  type RepositoryTextReader,
} from '../documents/issues.ts';
import { assertChangeId } from '../../../../runtime/session-workspace/paths.ts';
import {
  changeLifecycleRelativePath,
  inspectChangeRouting,
  parseChangeLifecycleSource,
  type ChangeRoutingAuthorityPort,
  type ChangeRoutingInspection,
  type ChangeRoutingObservation,
} from '../../../../modules/lifecycle/change-routing.ts';
import {
  repositoryConsumerPath,
  repositoryDocumentConfiguration,
  repositoryWorkRegistryConfiguration,
} from '../../../../modules/repository-consumer/repository-consumer-config.ts';

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

export type HandoffChange = {
  changeId: string;
  tasks: ParsedTask[];
};

export type HandoffReadContext = Readonly<{
  contracts: readonly HandoffChange[];
  readText: RepositoryTextReader;
}>;

export function renderHandoff(
  repositoryRoot: string,
  authorityPort?: ChangeRoutingAuthorityPort,
): string {
  const rendered = projectHandoff(repositoryRoot, authorityPort);
  writeTextAtomic(handoffPath(repositoryRoot), rendered);
  return rendered;
}

export function projectHandoff(
  repositoryRoot: string,
  authorityPort?: ChangeRoutingAuthorityPort,
): string {
  return buildHandoff(
    repositoryRoot,
    undefined,
    undefined,
    undefined,
    authorityPort,
  );
}

/** Build completion handoff bytes from an exact prospective tasks projection. */
export function projectHandoffForTaskProjection(
  repositoryRoot: string,
  requestedChangeId: string,
  projectedTasks: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  return buildHandoff(repositoryRoot, undefined, {
    changeId,
    tasks: parseTasks(projectedTasks),
  });
}

/**
 * Render the handoff for one explicit lifecycle-owned change. The existing
 * handoff bytes are deliberately not consulted: generated output is never an
 * authority input for the transition that replaces it.
 */
export function renderHandoffForChange(
  repositoryRoot: string,
  requestedChangeId: string,
): string {
  const changeId = assertChangeId(requestedChangeId);
  const rendered = buildHandoff(repositoryRoot, changeId);
  writeTextAtomic(handoffPath(repositoryRoot), rendered);
  return rendered;
}

function buildHandoff(
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
    return buildRoutingHandoff(
      repositoryRoot,
      readContext,
      routedSource,
      selectedChangeId,
      projectedChange,
      authorityPort,
    );
  }
  const contract = selectChange(
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
  const registryEnabled = hasWorkRegistryInventory(
    repositoryRoot,
    readContext?.readText,
  );
  return [
    '# Current and Next Steps',
    '',
    registryEnabled
      ? 'This generated handoff contains semantic project state only. Its sources are tracked OpenSpec change records and the Git-native Work Registry.'
      : 'This generated handoff contains semantic project state only. Its sources are tracked OpenSpec change records and structured issue data.',
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
      ? blockers.map((issue) => `- \`${issue.id}\` — ${issue.title}`)
      : ['None.']),
    '',
    '## References',
    '',
    '- [Roadmap](ROADMAP.md)',
    '- [Change records](../openspec/changes/)',
    '- [Base specifications](../openspec/specs/)',
    ...(registryEnabled
      ? [
          `- [Work backlog](${handoffLink(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).backlogPath)})`,
        ]
      : []),
    `- [Issue log](${handoffLink(repositoryRoot, repositoryDocumentConfiguration(repositoryRoot).issueLogPath)})`,
    '- [System architecture](architecture/ARCHITECTURE.md)',
    '',
  ].join('\n');
}

function buildRoutingHandoff(
  repositoryRoot: string,
  readContext: HandoffReadContext | undefined,
  sourceBytes: string,
  selectedChangeId?: string,
  projectedChange?: HandoffChange,
  authorityPort?: ChangeRoutingAuthorityPort,
): string {
  const observedInspection =
    readContext === undefined
      ? inspectChangeRouting(repositoryRoot, authorityPort)
      : inspectCommittedRouting(repositoryRoot, readContext, sourceBytes);
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
  const assignedBlockerIds = new Set(
    inspection.changes.flatMap(({ blocker }) =>
      blocker?.kind === 'issue' ? [blocker.id] : [],
    ),
  );
  const unassigned = blockers.filter(
    (issue) => !assignedBlockerIds.has(issue.id),
  );
  const registryEnabled = hasWorkRegistryInventory(
    repositoryRoot,
    readContext?.readText,
  );
  return [
    '# Current and Next Steps',
    '',
    registryEnabled
      ? 'This generated repository inventory is derived from controlled lifecycle, task, Work Registry, and archive facts.'
      : 'This generated repository inventory is derived from controlled lifecycle, task, issue, and archive facts.',
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
      ? unassigned.map((issue) => `- \`${issue.id}\` — ${issue.title}`)
      : ['None.']),
    '',
    '## References',
    '',
    '- [Roadmap](ROADMAP.md)',
    '- [Change lifecycle](../openspec/change-lifecycle.json)',
    '- [Change records](../openspec/changes/)',
    '- [Base specifications](../openspec/specs/)',
    ...(registryEnabled
      ? [
          `- [Work backlog](${handoffLink(repositoryRoot, repositoryWorkRegistryConfiguration(repositoryRoot).backlogPath)})`,
        ]
      : []),
    `- [Issue log](${handoffLink(repositoryRoot, repositoryDocumentConfiguration(repositoryRoot).issueLogPath)})`,
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
  repositoryRoot: string,
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
  const issueData = (() => {
    try {
      return readIssueData(repositoryRoot, readContext.readText).issues;
    } catch {
      return [];
    }
  })();
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
        record.blocker?.resumeCondition !== 'manual' &&
        (record.blocker?.kind === 'issue'
          ? issueData.some(
              (issue) =>
                issue.id === record.blocker?.id && issue.closed !== undefined,
            )
          : record.blocker?.kind === 'change'
            ? completed.has(record.blocker.id)
            : false);
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

export function validateHandoff(
  repositoryRoot: string,
  readContext?: HandoffReadContext,
): void {
  const expected = buildHandoff(
    repositoryRoot,
    undefined,
    undefined,
    readContext,
  );
  assertHandoffBytes(repositoryRoot, expected, readContext?.readText);
}

export function validateHandoffForChange(
  repositoryRoot: string,
  requestedChangeId: string,
): void {
  const changeId = assertChangeId(requestedChangeId);
  const expected = buildHandoff(repositoryRoot, changeId);
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
      ? readText(repositoryDocumentConfiguration(repositoryRoot).handoffPath)
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

function selectChange(
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
    : liveContracts(repositoryRoot);
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

function liveContracts(repositoryRoot: string): HandoffChange[] {
  const config = loadWorkflowConfig(repositoryRoot);
  const root = path.join(repositoryRoot, config.changeRoot);
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
    .map((entry) => loadChangeContract(repositoryRoot, entry.name));
}

function readBlockers(repositoryRoot: string, readText?: RepositoryTextReader) {
  const inventory = readWorkRegistryInventory(repositoryRoot, readText);
  if (inventory !== null) {
    const blocked = new Set(inventory.blockedItemIds);
    const registryBlockers = inventory.items
      .filter((item) => item.stage !== 'closed' && blocked.has(item.id))
      .map((item) => ({ id: item.id, title: item.title }));
    const legacyBlockers = readLegacyIssueBlockers(repositoryRoot, readText)
      .map((issue) => {
        const item = inventory.items.find((candidate) =>
          candidate.aliases.includes(issue.id),
        );
        return item === undefined
          ? { id: issue.id, title: issue.title }
          : { id: item.id, title: item.title };
      })
      .filter(
        (candidate) => !registryBlockers.some(({ id }) => id === candidate.id),
      );
    return [...registryBlockers, ...legacyBlockers].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }
  return readLegacyIssueBlockers(repositoryRoot, readText);
}

function readLegacyIssueBlockers(
  repositoryRoot: string,
  readText?: RepositoryTextReader,
) {
  const issueSourcePath =
    repositoryDocumentConfiguration(repositoryRoot).issueSourcePath;
  if (
    readText
      ? readText(issueSourcePath) === undefined
      : !fs.existsSync(path.join(repositoryRoot, issueSourcePath))
  ) {
    return [];
  }
  return readIssueData(repositoryRoot, readText).issues.filter(
    (issue) => issue.status === 'blocked' && !issue.closed,
  );
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

function hasWorkRegistryInventory(
  repositoryRoot: string,
  readText?: RepositoryTextReader,
): boolean {
  return readWorkRegistryInventory(repositoryRoot, readText) !== null;
}

function readWorkRegistryInventory(
  repositoryRoot: string,
  readText?: RepositoryTextReader,
): WorkRegistryHandoffInventory | null {
  const inventoryPath =
    repositoryWorkRegistryConfiguration(repositoryRoot).inventoryPath;
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
    repositoryDocumentConfiguration(repositoryRoot).handoffPath,
  );
}

function handoffLink(repositoryRoot: string, targetPath: string): string {
  const handoff = repositoryDocumentConfiguration(repositoryRoot).handoffPath;
  return path.posix.relative(path.posix.dirname(handoff), targetPath);
}

function invalidHandoff(code: string, message: string) {
  return workflowError(code, message, ExitCode.verification);
}
