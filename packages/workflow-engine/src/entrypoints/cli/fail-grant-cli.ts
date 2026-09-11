/**
 * Converts supported workflow refusals into exact Central Grant challenges.
 *
 * Invariants:
 * - Change-routing challenges require the resume intent that produced the
 *   refusal.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  assertProtectedTaskApplyRecoveryGrantRequiredDetails,
  assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails,
  parseChangeRoutingIntent,
  observeChangeRoutingContinuationState,
} from '../../composition-root/cli-command-services.ts';
import type {
  ProtectedTaskApplyRecoveryGrantRequiredDetailsV1,
  ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1,
  WorkItemReviewV1,
  WorkRegistryGrantRequiredDetailsV1,
} from '../../composition-root/cli-command-services.ts';

import {
  requestProtectedTaskApplyDescendantSettlementGrant,
  requestProtectedTaskApplyGrant,
  requestProtectedTaskApplyRecoveryGrant,
  requestChangeRoutingContinuationGrant,
  requestChangeRoleAssignmentGrant,
  requestProtectedBaseInitializationGrant,
  requestWorkRegistryReviewGrant,
  requestWorkRegistryPromotionGrant,
} from '../../composition-root/grant-production.ts';

import {
  type CommandResult,
  plainRecord,
  exactKeys,
  shellCommandArgument,
} from './cli-input.ts';

export async function createProtectedTaskApplyDescendantSettlementFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: typeof requestProtectedTaskApplyDescendantSettlementGrant = requestProtectedTaskApplyDescendantSettlementGrant,
): Promise<CommandResult | null> {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== 'PROTECTED_TASK_APPLY_DESCENDANT_SETTLEMENT_GRANT_REQUIRED'
  ) {
    return null;
  }
  const details = protectedTaskApplyDescendantSettlementRequiredDetails(
    error.details,
  );
  if (details === null) return null;
  const expectedArgs =
    details.action === 'cancel'
      ? [
          'finalize-recover',
          details.sessionId,
          '--cancel',
          details.transactionId,
          '--reason',
          details.reason,
        ]
      : ['abort', details.sessionId, '--reason', details.reason];
  if (canonicalJson(args) !== canonicalJson(expectedArgs)) return null;
  const grant = await requestGrant(
    cwd,
    details,
    `Settle only the ${details.preparedDescendantTree.nodes.length} exact prepared child Grant(s) bound to protected Apply ${details.parentChallengeId}; preserve every observed effect truthfully, then retry ${details.action}.`,
  );
  return {
    command: args[0]!,
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      sessionId: details.sessionId,
      transactionId: details.transactionId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        details,
      },
      grant,
      transitionAppliesOnDecision: false,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        recoveryCommand: `pnpm workflow grant human recover ${grant.challengeId} --json`,
        observeAfterDecision: `pnpm workflow status ${details.sessionId} --json`,
        retryAfterDecision:
          details.action === 'cancel'
            ? `pnpm workflow finalize-recover ${details.sessionId} --cancel ${details.transactionId} --reason ${JSON.stringify(details.reason)} --json`
            : `pnpm workflow abort ${details.sessionId} --reason ${JSON.stringify(details.reason)} --json`,
      },
    },
  };
}

type ChangeRoutingGrantChallenge = Readonly<{
  challengeId: string;
  challengeDigest: string;
}>;

export async function createProtectedTaskApplyFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: typeof requestProtectedTaskApplyGrant = requestProtectedTaskApplyGrant,
): Promise<CommandResult | null> {
  const fullGate = args.length === 5 && args[4] === '--full-gate';
  if (
    (args.length !== 4 && !fullGate) ||
    args[0] !== 'finalize' ||
    args[2] !== '--message' ||
    !(error instanceof WorkflowError) ||
    error.code !== 'PROTECTED_TASK_APPLY_REQUIRED'
  ) {
    return null;
  }
  const sessionId = args[1];
  const commitMessage = args[3];
  const details = protectedTaskApplyRequiredDetails(error.details);
  if (
    sessionId === undefined ||
    commitMessage === undefined ||
    details === null
  ) {
    return null;
  }
  const grant = await requestGrant(
    cwd,
    sessionId,
    commitMessage,
    fullGate,
    details,
    `Authorize only the exact checked finalize of protected task ${details.taskId} for ${details.changeId}; preserve its Task Mandate, baseline, paths, checks, TaskDiffReview, projection, and managed-commit boundaries.`,
  );
  return {
    command: 'finalize',
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      sessionId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        details,
      },
      grant,
      transitionAppliesOnDecision: true,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        recoveryCommand: `pnpm workflow grant human recover ${grant.challengeId} --json`,
        observeAfterDecision: `pnpm workflow status ${sessionId} --json`,
      },
    },
  };
}

export async function createProtectedTaskApplyRecoveryFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: typeof requestProtectedTaskApplyRecoveryGrant = requestProtectedTaskApplyRecoveryGrant,
): Promise<CommandResult | null> {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== 'PROTECTED_TASK_APPLY_RECOVERY_GRANT_REQUIRED'
  ) {
    return null;
  }
  const details = protectedTaskApplyRecoveryRequiredDetails(error.details);
  if (details === null) return null;
  const expectedArgs =
    details.action === 'cancel'
      ? [
          'finalize-recover',
          details.sessionId,
          '--cancel',
          details.transactionId,
          '--reason',
          details.reason,
        ]
      : ['abort', details.sessionId, '--reason', details.reason];
  if (canonicalJson(args) !== canonicalJson(expectedArgs)) return null;
  const grant = await requestGrant(
    cwd,
    details,
    details.action === 'cancel'
      ? `Cancel only protected finalize transaction ${details.transactionId}, restore its exact projection, record its parent Apply as failed, and leave session ${details.sessionId} active.`
      : `Cancel only protected finalize transaction ${details.transactionId}, restore its exact projection, record its parent Apply as failed, then abort session ${details.sessionId}.`,
  );
  return {
    command: args[0]!,
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      sessionId: details.sessionId,
      transactionId: details.transactionId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        details,
      },
      grant,
      transitionAppliesOnDecision: true,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        recoveryCommand: `pnpm workflow grant human recover ${grant.challengeId} --json`,
        observeAfterDecision: `pnpm workflow status ${details.sessionId} --json`,
      },
    },
  };
}

function protectedTaskApplyRecoveryRequiredDetails(
  value: unknown,
): ProtectedTaskApplyRecoveryGrantRequiredDetailsV1 | null {
  try {
    return assertProtectedTaskApplyRecoveryGrantRequiredDetails(value);
  } catch {
    return null;
  }
}

function protectedTaskApplyDescendantSettlementRequiredDetails(
  value: unknown,
): ProtectedTaskApplyDescendantSettlementGrantRequiredDetailsV1 | null {
  try {
    return assertProtectedTaskApplyDescendantSettlementGrantRequiredDetails(
      value,
    );
  } catch {
    return null;
  }
}

function protectedTaskApplyRequiredDetails(value: unknown): Readonly<{
  changeId: string;
  taskId: string;
  mandateTaskId: string;
  changedPaths: readonly string[];
  roles: readonly string[];
  matchedPatterns: readonly string[];
  unclassifiedScope: boolean;
}> | null {
  if (
    !plainRecord(value) ||
    !exactKeys(value, [
      'changeId',
      'taskId',
      'mandateTaskId',
      'changedPaths',
      'roles',
      'matchedPatterns',
      'unclassifiedScope',
    ]) ||
    typeof value.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.changeId) ||
    typeof value.taskId !== 'string' ||
    value.taskId.length === 0 ||
    typeof value.mandateTaskId !== 'string' ||
    value.mandateTaskId.length === 0 ||
    !isExactStringArray(value.changedPaths, true) ||
    !isExactStringArray(value.roles, false) ||
    !isExactStringArray(value.matchedPatterns, false) ||
    typeof value.unclassifiedScope !== 'boolean'
  ) {
    return null;
  }
  return Object.freeze({
    changeId: value.changeId,
    taskId: value.taskId,
    mandateTaskId: value.mandateTaskId,
    changedPaths: Object.freeze([...value.changedPaths]),
    roles: Object.freeze([...value.roles]),
    matchedPatterns: Object.freeze([...value.matchedPatterns]),
    unclassifiedScope: value.unclassifiedScope,
  });
}

function isExactStringArray(
  value: unknown,
  requireEntry: boolean,
): value is string[] {
  return (
    Array.isArray(value) &&
    (!requireEntry || value.length > 0) &&
    value.every(
      (entry) =>
        typeof entry === 'string' &&
        entry.length > 0 &&
        entry.trim() === entry &&
        !/\p{Cc}/u.test(entry),
    ) &&
    new Set(value).size === value.length
  );
}

export type ChangeRoutingGrantRequest = (
  cwd: string,
  changeId: string,
  proposedReason: string,
  expected: Readonly<{
    sourceDigest: `sha256:${string}`;
    stateBindingDigest: `sha256:${string}`;
  }>,
) => Promise<ChangeRoutingGrantChallenge>;

export async function createChangeRoutingFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: ChangeRoutingGrantRequest = requestChangeRoutingContinuationGrant,
): Promise<CommandResult | null> {
  if (
    args.length !== 6 ||
    args[0] !== 'route' ||
    args[1] !== 'prepare' ||
    args[2] !== '--intent' ||
    args[4] !== '--output' ||
    !(error instanceof WorkflowError) ||
    error.code !== 'CHANGE_ROUTING_GRANT_REQUIRED'
  ) {
    return null;
  }
  const details = changeRoutingGrantRequiredDetails(error.details);
  if (details === null) return null;
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const intentPath = path.resolve(repositoryRoot, args[3]!);
  let intent: ReturnType<typeof parseChangeRoutingIntent>;
  try {
    intent = parseChangeRoutingIntent(
      JSON.parse(fs.readFileSync(intentPath, 'utf8')) as unknown,
    );
  } catch {
    throw workflowError(
      'CHANGE_ROUTING_GRANT_STATE_CHANGED',
      'The exact resume intent changed before its Central Grant challenge could be created.',
      ExitCode.staleState,
    );
  }
  if (
    intent.action.kind !== 'resume' ||
    intent.action.changeId !== details.changeId ||
    intent.action.grantChallengeId !== undefined
  ) {
    throw workflowError(
      'CHANGE_ROUTING_GRANT_STATE_CHANGED',
      'The exact resume intent no longer matches the protected continuation refusal.',
      ExitCode.staleState,
    );
  }
  const current = observeChangeRoutingContinuationState(
    repositoryRoot,
    details.changeId,
  );
  if (
    current.sourceDigest !== details.sourceDigest ||
    current.digest !== details.stateBindingDigest
  ) {
    throw workflowError(
      'CHANGE_ROUTING_GRANT_STATE_CHANGED',
      'The protected routing record changed before its Central Grant challenge could be created.',
      ExitCode.staleState,
    );
  }
  const grant = await requestGrant(
    repositoryRoot,
    details.changeId,
    `Authorize only this exact protected routing record for ${details.changeId} to return to ready; preserve its source digest, blocker identity, review, managed commit, and no-auto-focus boundary.`,
    {
      sourceDigest: details.sourceDigest,
      stateBindingDigest: details.stateBindingDigest,
    },
  );
  return {
    command: 'route',
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      changeId: details.changeId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        details,
      },
      grant,
      transitionAppliesOnDecision: false,
      inputSchema: {
        schemaVersion: 1,
        kind: 'change-routing-central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        grantChallengeId: grant.challengeId,
        retryAfterDecision: `pnpm workflow route prepare --intent ${shellCommandArgument(args[3]!)} --output ${shellCommandArgument(args[5]!)} --grant ${shellCommandArgument(grant.challengeId)} --json`,
      },
    },
  };
}

function changeRoutingGrantRequiredDetails(value: unknown): Readonly<{
  schemaVersion: 1;
  kind: 'change-routing-grant-required.v1';
  changeId: string;
  sourceDigest: `sha256:${string}`;
  stateBindingDigest: `sha256:${string}`;
}> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const details = value as Record<string, unknown>;
  if (
    Object.keys(details).sort().join('\0') !==
      'changeId\0kind\0schemaVersion\0sourceDigest\0stateBindingDigest' ||
    details.schemaVersion !== 1 ||
    details.kind !== 'change-routing-grant-required.v1' ||
    typeof details.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(details.changeId) ||
    typeof details.sourceDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(details.sourceDigest) ||
    typeof details.stateBindingDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(details.stateBindingDigest)
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    kind: 'change-routing-grant-required.v1',
    changeId: details.changeId,
    sourceDigest: details.sourceDigest as `sha256:${string}`,
    stateBindingDigest: details.stateBindingDigest as `sha256:${string}`,
  };
}

export async function createRoleAssignmentFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: typeof requestChangeRoleAssignmentGrant = requestChangeRoleAssignmentGrant,
): Promise<CommandResult | null> {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== 'AGENT_RUNTIME_GRANT_REQUIRED'
  ) {
    return null;
  }
  const invocationId =
    typeof error.details?.invocationId === 'string'
      ? error.details.invocationId
      : args[0] === 'provider-worker' && typeof args[1] === 'string'
        ? args[1]
        : null;
  if (invocationId === null) return null;
  const grant = await requestGrant(
    cwd,
    invocationId,
    'Authorize only this exact prepared provider invocation to use its current below-floor role assignment; preserve all provider, data-authorization, executable-identity, and stale-state checks.',
  );
  return {
    command: args[0] ?? 'provider-worker',
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      invocationId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      grant,
      providerInvocationState: 'prepared',
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        retryAfterDecision: `pnpm workflow provider-worker ${invocationId} --json`,
      },
    },
  };
}

export async function createProposeProtectedBaseFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  requestGrant: typeof requestProtectedBaseInitializationGrant = requestProtectedBaseInitializationGrant,
): Promise<CommandResult | null> {
  if (
    !(error instanceof WorkflowError) ||
    error.code !== 'PROPOSE_PROTECTED_BASE_UNAVAILABLE'
  ) {
    return null;
  }
  // The intent-level facades (`now`, `finding convert --now`) start the same
  // propose and must reach the same Fail-Grant decision instead of a raw error.
  const startsPropose =
    args[0] === 'propose' ||
    args[0] === 'now' ||
    (args[0] === 'finding' && args.includes('--now'));
  const changeId =
    args[0] === 'propose'
      ? args[1]
      : typeof error.details?.changeId === 'string'
        ? error.details.changeId
        : undefined;
  if (!startsPropose || changeId === undefined) return null;
  const grant = await requestGrant(
    cwd,
    'Choose create-only initialization of a local protected base or the empty canonical remote from the exact current commit so governed planning can continue.',
  );
  return {
    command: args[0]!,
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      changeId,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        ...(error.details ? { details: error.details } : {}),
      },
      grant,
      initializationPending: true,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        retryAfterDecision: 'rerun the same propose command',
      },
    },
  };
}

type WorkRegistryGrantChallenge = Readonly<{
  challengeId: string;
  challengeDigest: string;
}>;

type WorkRegistryFailGrantDependencies = Readonly<{
  requestReview(
    cwd: string,
    workItemId: string,
    review: WorkItemReviewV1,
    proposedReason: string,
  ): Promise<WorkRegistryGrantChallenge>;
  requestPromotion(
    cwd: string,
    workItemId: string,
    changeId: string,
    expectedDigest: string,
    proposedReason: string,
  ): Promise<WorkRegistryGrantChallenge>;
}>;

const WORK_REGISTRY_FAIL_GRANT_DEPENDENCIES: WorkRegistryFailGrantDependencies =
  Object.freeze({
    requestReview: requestWorkRegistryReviewGrant,
    requestPromotion: requestWorkRegistryPromotionGrant,
  });

export async function createWorkRegistryFailGrantResult(
  args: readonly string[],
  cwd: string,
  error: unknown,
  dependencies: WorkRegistryFailGrantDependencies = WORK_REGISTRY_FAIL_GRANT_DEPENDENCIES,
): Promise<CommandResult | null> {
  if (
    (args[0] !== 'work-item' && args[0] !== 'now') ||
    !(error instanceof WorkflowError) ||
    error.code !== 'WORK_REGISTRY_GRANT_REQUIRED'
  ) {
    return null;
  }
  const details = workRegistryGrantRequiredDetails(error.details);
  if (details === null || !workRegistryArgsMatch(args, details)) return null;
  const proposedReason =
    details.operation === 'review'
      ? `Authorize only this exact ${details.review.action} Work Registry transition for ${details.workItemId}; the Human Gate decision applies the digest-bound mutation and any state change requires a fresh Grant.`
      : `Authorize only this exact Work Registry promotion of ${details.workItemId} to ${details.changeId}; the Human Gate decision applies the digest-bound mutation and any state change requires a fresh Grant.`;
  const grant =
    details.operation === 'review'
      ? await dependencies.requestReview(
          cwd,
          details.workItemId,
          details.review,
          proposedReason,
        )
      : await dependencies.requestPromotion(
          cwd,
          details.workItemId,
          details.changeId,
          details.expectedDigest,
          proposedReason,
        );
  return {
    command: args[0],
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      workItemId: details.workItemId,
      transition: details.transition,
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: error.code,
        message: error.message,
        details,
      },
      grant,
      transitionAppliesOnDecision: true,
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
        decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
        recoveryCommand: `pnpm workflow grant human recover ${grant.challengeId} --json`,
        observeAfterDecision: `pnpm workflow work-item show ${details.workItemId} --json`,
      },
    },
  };
}

function workRegistryGrantRequiredDetails(
  value: unknown,
): WorkRegistryGrantRequiredDetailsV1 | null {
  if (
    !plainRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'work-registry-grant-required.v1' ||
    typeof value.workItemId !== 'string' ||
    !/^WORK-[0-9A-HJKMNP-TV-Z]{26}$/u.test(value.workItemId)
  ) {
    return null;
  }
  if (
    value.operation === 'review' &&
    (value.transition === 'intake' || value.transition === 'prioritize') &&
    exactKeys(value, [
      'kind',
      'operation',
      'review',
      'schemaVersion',
      'transition',
      'workItemId',
    ])
  ) {
    const review = workItemReview(value.review);
    const transition =
      review?.action === 'prioritize' ? 'prioritize' : 'intake';
    if (review !== null && value.transition === transition) {
      return { ...value, review } as WorkRegistryGrantRequiredDetailsV1;
    }
  }
  if (
    value.operation === 'promote' &&
    value.transition === 'promote' &&
    exactKeys(value, [
      'changeId',
      'expectedDigest',
      'kind',
      'operation',
      'schemaVersion',
      'transition',
      'workItemId',
    ]) &&
    typeof value.changeId === 'string' &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.changeId) &&
    typeof value.expectedDigest === 'string' &&
    /^sha256:[0-9a-f]{64}$/u.test(value.expectedDigest)
  ) {
    return value as WorkRegistryGrantRequiredDetailsV1;
  }
  return null;
}

function workRegistryArgsMatch(
  args: readonly string[],
  details: WorkRegistryGrantRequiredDetailsV1,
): boolean {
  if (details.operation === 'review') {
    return (
      args.length === 5 &&
      args[1] === 'review' &&
      args[2] === details.workItemId &&
      args[3] === '--input'
    );
  }
  if (args[0] === 'now') {
    return (
      args.length === 2 &&
      args[1] === details.workItemId &&
      details.changeId ===
        `work-${details.workItemId.slice('WORK-'.length).toLowerCase()}`
    );
  }
  return (
    args.length === 7 &&
    args[1] === 'promote' &&
    args[2] === details.workItemId &&
    args[3] === '--change' &&
    args[4] === details.changeId &&
    args[5] === '--expected' &&
    args[6] === details.expectedDigest
  );
}

function workItemReview(value: unknown): WorkItemReviewV1 | null {
  if (
    !plainRecord(value) ||
    typeof value.expectedDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.expectedDigest)
  ) {
    return null;
  }
  if (
    value.action === 'accept' &&
    exactKeys(value, ['action', 'expectedDigest', 'summary']) &&
    typeof value.summary === 'string' &&
    value.summary.length > 0 &&
    Buffer.byteLength(value.summary, 'utf8') <= 2_000 &&
    !value.summary.includes('\0')
  ) {
    return value as WorkItemReviewV1;
  }
  if (
    value.action === 'prioritize' &&
    exactKeys(value, ['action', 'blockedBy', 'expectedDigest', 'lane']) &&
    ['now', 'next', 'later', 'icebox'].includes(String(value.lane)) &&
    Array.isArray(value.blockedBy) &&
    value.blockedBy.every(
      (entry) =>
        typeof entry === 'string' &&
        /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/u.test(entry),
    ) &&
    new Set(value.blockedBy).size === value.blockedBy.length
  ) {
    return value as WorkItemReviewV1;
  }
  if (
    value.action === 'decline' &&
    exactKeys(value, ['action', 'expectedDigest', 'outcome']) &&
    ['declined', 'duplicate', 'obsolete'].includes(String(value.outcome))
  ) {
    return value as WorkItemReviewV1;
  }
  return null;
}
