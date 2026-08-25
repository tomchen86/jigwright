import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertAgentRolePlanV2Snapshot,
  createAgentRolePlanV2Snapshot,
  parseAgentRolePlan,
  parseAgentRolePlanV2,
  type AgentRolePlanReaderPort,
  type AgentRolePlanV1,
  type AgentRolePlanV2,
  type AgentRolePlanV2ReaderPort,
  type AgentRolePlanV2Snapshot,
} from '../../modules/provider-orchestration/agent-role-plan.ts';
import { agentRolePlanV2Path } from '../../modules/source/planning-role-policy-paths.ts';
import { runGitBuffer } from './git.ts';

const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const FULL_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TREE_ENTRY = /^(100644) blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/u;
const MAX_AGENT_ROLE_PLAN_BYTES = 64 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function agentRolePlanPath(changeId: string): string {
  if (!CHANGE_ID.test(changeId) || changeId === 'archive') {
    throw planStoreInvalid(
      'Agent-role plan requires one valid non-reserved change ID.',
    );
  }
  return `workflow/agent-plans/${changeId}.json`;
}

export function readCurrentAgentRolePlan(
  repositoryRoot: string,
  changeId: string,
  planningGeneration: string,
): AgentRolePlanV1 | null {
  const root = fs.realpathSync(repositoryRoot);
  const relativePath = agentRolePlanPath(changeId);
  const absolutePath = path.join(root, relativePath);
  const parent = path.dirname(absolutePath);
  const parentStats = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (parentStats === undefined) return null;
  if (
    !parentStats.isDirectory() ||
    parentStats.isSymbolicLink() ||
    fs.realpathSync(parent) !== parent
  ) {
    throw planStoreInvalid(
      'Agent-role plan directory is not a canonical plain directory.',
    );
  }

  const before = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (before === undefined) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o111) !== 0 ||
    before.size > MAX_AGENT_ROLE_PLAN_BYTES
  ) {
    throw planStoreInvalid(
      'Agent-role plan must be one bounded non-executable regular file.',
    );
  }

  const noFollow =
    process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_RDONLY | noFollow,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== 1 ||
      (opened.mode & 0o111) !== 0
    ) {
      throw planStoreInvalid(
        'Agent-role plan identity changed while it was opened.',
      );
    }
    const bytes = fs.readFileSync(descriptor);
    if (
      bytes.length !== opened.size ||
      bytes.length > MAX_AGENT_ROLE_PLAN_BYTES
    ) {
      throw planStoreInvalid(
        'Agent-role plan bytes changed while they were read.',
      );
    }
    return parseAgentRolePlan(
      decodeAgentRolePlan(bytes),
      changeId,
      planningGeneration,
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readPinnedAgentRolePlan(
  repositoryRoot: string,
  commit: string,
  changeId: string,
  planningGeneration: string,
): AgentRolePlanV1 | null {
  if (!FULL_OBJECT_ID.test(commit)) {
    throw planStoreInvalid(
      'Pinned agent-role plan requires one full commit object ID.',
    );
  }
  const repositoryPath = agentRolePlanPath(changeId);
  const entrySource = runGitBuffer(repositoryRoot, [
    'ls-tree',
    '-z',
    '--full-tree',
    commit,
    '--',
    `:(literal)${repositoryPath}`,
  ]);
  if (entrySource.length === 0) return null;

  let entry: RegExpExecArray | null;
  try {
    entry = TREE_ENTRY.exec(UTF8.decode(entrySource));
  } catch {
    entry = null;
  }
  if (entry === null || entry[3] !== repositoryPath) {
    throw planStoreInvalid(
      'Pinned agent-role plan must be one exact non-executable regular blob.',
    );
  }
  const bytes = runGitBuffer(repositoryRoot, ['cat-file', 'blob', entry[2]!]);
  if (bytes.length > MAX_AGENT_ROLE_PLAN_BYTES) {
    throw planStoreInvalid('Pinned agent-role plan exceeds the bounded size.');
  }
  return parseAgentRolePlan(
    decodeAgentRolePlan(bytes),
    changeId,
    planningGeneration,
  );
}

export const agentRolePlanReader: AgentRolePlanReaderPort = Object.freeze({
  readCurrent: readCurrentAgentRolePlan,
  readPinned: readPinnedAgentRolePlan,
});

/** Read only newly authored V2 override bytes from the canonical current path. */
export function readCurrentAgentRolePlanV2(
  repositoryRoot: string,
  changeId: string,
  baseCentralConfigurationDigest: string,
): AgentRolePlanV2 | null {
  const root = fs.realpathSync(repositoryRoot);
  const relativePath = agentRolePlanV2Path(changeId);
  const absolutePath = path.join(root, relativePath);
  const parent = path.dirname(absolutePath);
  const parentStats = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (parentStats === undefined) return null;
  if (
    !parentStats.isDirectory() ||
    parentStats.isSymbolicLink() ||
    fs.realpathSync(parent) !== parent
  ) {
    throw planStoreInvalid(
      'Agent-role plan directory is not a canonical plain directory.',
    );
  }

  const before = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (before === undefined) return null;
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o111) !== 0 ||
    before.size > MAX_AGENT_ROLE_PLAN_BYTES
  ) {
    throw planStoreInvalid(
      'Agent-role plan must be one bounded non-executable regular file.',
    );
  }

  const noFollow =
    process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
  const descriptor = fs.openSync(
    absolutePath,
    fs.constants.O_RDONLY | noFollow,
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.nlink !== 1 ||
      (opened.mode & 0o111) !== 0
    ) {
      throw planStoreInvalid(
        'Agent-role plan identity changed while it was opened.',
      );
    }
    const bytes = fs.readFileSync(descriptor);
    if (
      bytes.length !== opened.size ||
      bytes.length > MAX_AGENT_ROLE_PLAN_BYTES
    ) {
      throw planStoreInvalid(
        'Agent-role plan bytes changed while they were read.',
      );
    }
    return parseAgentRolePlanV2(
      decodeAgentRolePlan(bytes),
      changeId,
      baseCentralConfigurationDigest,
    );
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Read only newly authored V2 override bytes from one exact pinned blob. */
export function readPinnedAgentRolePlanV2(
  repositoryRoot: string,
  commit: string,
  changeId: string,
  baseCentralConfigurationDigest: string,
): AgentRolePlanV2 | null {
  return (
    readPinnedAgentRolePlanV2Snapshot(
      repositoryRoot,
      commit,
      changeId,
      baseCentralConfigurationDigest,
    )?.plan ?? null
  );
}

/** Read and bind the exact 100644 V2 plan blob from one full commit object. */
export function readPinnedAgentRolePlanV2Snapshot(
  repositoryRoot: string,
  commit: string,
  changeId: string,
  baseCentralConfigurationDigest: string,
): AgentRolePlanV2Snapshot | null {
  if (!FULL_OBJECT_ID.test(commit)) {
    throw planStoreInvalid(
      'Pinned agent-role plan requires one full commit object ID.',
    );
  }
  let objectType: Buffer;
  try {
    objectType = runGitBuffer(repositoryRoot, ['cat-file', '-t', commit]);
  } catch {
    throw planStoreInvalid(
      'Pinned agent-role plan commit object is unavailable.',
    );
  }
  if (!objectType.equals(Buffer.from('commit\n', 'utf8'))) {
    throw planStoreInvalid(
      'Pinned agent-role plan requires one exact commit object.',
    );
  }
  const repositoryPath = agentRolePlanV2Path(changeId);
  const entrySource = runGitBuffer(repositoryRoot, [
    'ls-tree',
    '-z',
    '--full-tree',
    commit,
    '--',
    `:(literal)${repositoryPath}`,
  ]);
  if (entrySource.length === 0) return null;

  let entry: RegExpExecArray | null;
  try {
    entry = TREE_ENTRY.exec(UTF8.decode(entrySource));
  } catch {
    entry = null;
  }
  if (entry === null || entry[3] !== repositoryPath) {
    throw planStoreInvalid(
      'Pinned agent-role plan must be one exact non-executable regular blob.',
    );
  }
  const bytes = runGitBuffer(repositoryRoot, ['cat-file', 'blob', entry[2]!]);
  if (bytes.length > MAX_AGENT_ROLE_PLAN_BYTES) {
    throw planStoreInvalid('Pinned agent-role plan exceeds the bounded size.');
  }
  const plan = parseAgentRolePlanV2(
    decodeAgentRolePlan(bytes),
    changeId,
    baseCentralConfigurationDigest,
  );
  try {
    return createAgentRolePlanV2Snapshot({
      pinnedCommit: commit,
      blobObjectId: entry[2]!,
      plan,
    });
  } catch {
    throw planStoreInvalid(
      'Pinned agent-role plan does not match its tracked blob identity.',
    );
  }
}

/** Re-read the exact commit tree/blob and reject a caller-rebound V2 snapshot. */
export function assertPinnedAgentRolePlanV2Snapshot(
  repositoryRoot: string,
  snapshot: AgentRolePlanV2Snapshot,
): AgentRolePlanV2Snapshot {
  let admitted: AgentRolePlanV2Snapshot;
  try {
    admitted = assertAgentRolePlanV2Snapshot(snapshot);
  } catch {
    throw planStoreInvalid('Pinned agent-role plan snapshot is invalid.');
  }
  const pinned = readPinnedAgentRolePlanV2Snapshot(
    repositoryRoot,
    admitted.pinnedCommit,
    admitted.plan.changeId,
    admitted.plan.baseCentralConfigurationDigest,
  );
  if (pinned === null || canonicalJson(pinned) !== canonicalJson(admitted)) {
    throw planStoreInvalid(
      'Pinned agent-role plan snapshot does not match its exact commit tree and blob.',
    );
  }
  return pinned;
}

export const agentRolePlanV2Reader: AgentRolePlanV2ReaderPort = Object.freeze({
  readCurrent: readCurrentAgentRolePlanV2,
  readPinned: readPinnedAgentRolePlanV2,
});

function decodeAgentRolePlan(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw planStoreInvalid('Agent-role plan must be canonical UTF-8 JSON.');
  }
}

function planStoreInvalid(message: string): ReturnType<typeof workflowError> {
  return workflowError(
    'AGENT_ROLE_PLAN_INVALID',
    message,
    ExitCode.verification,
  );
}
