import {
  DIGEST,
  GIT_OBJECT_ID,
  CHECK_ID,
  prepareTaskStrategyGreenFailureRecord,
  parseTaskStrategyGreenFailureRecord,
  parseCheckDefinition,
  parsePassedCheck,
  evidenceMatchesDefinition,
  isCheckDefinition,
  isPatchHead,
  greenFailureStateInvalid,
  assertGitObjectId,
  isGitObjectId,
  isDigest,
  isCanonicalTimestamp,
  hasExactKeys,
  isRecord,
  sha256,
} from '../../modules/provider-orchestration/task-strategy-correction-record.ts';
export {
  DIGEST,
  GIT_OBJECT_ID,
  CHECK_ID,
  prepareTaskStrategyGreenFailureRecord,
  parseTaskStrategyGreenFailureRecord,
  parseCheckDefinition,
  parsePassedCheck,
  evidenceMatchesDefinition,
  isCheckDefinition,
  isPatchHead,
  greenFailureStateInvalid,
  assertGitObjectId,
  isGitObjectId,
  isDigest,
  isCanonicalTimestamp,
  hasExactKeys,
  isRecord,
  sha256,
} from '../../modules/provider-orchestration/task-strategy-correction-record.ts';
/**
 * Persists task-strategy green failures and correction policy records.
 *
 * Invariants:
 * - Failure fingerprints and patch heads retain exact canonical binding and replay checks.
 * - Private writes and correction locks keep their existing order and scope.
 */
import crypto from 'node:crypto';
import path from 'node:path';

import { DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING } from '../provider-policy/ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  parseObservedCheckFailure,
  type CheckEvidence,
  type ObservedCheckFailure,
} from '../../foundation/check-evidence/check-evidence.ts';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  createPrivateCanonicalJson,
  privatePathExists,
  readPrivateCanonicalJson,
  withPrivateRuntimeLock,
} from '../journal-primitives/investigation-private-files.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';

export const DEFAULT_TASK_STRATEGY_CORRECTION_POLICY: TaskStrategyCorrectionPolicy =
  Object.freeze({
    maxRepairAttempts: DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.maxRepairAttempts,
    maxSameFailureFingerprint:
      DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING.maxSameFailureFingerprint,
  });

export function parseTaskStrategyCorrectionPolicy(
  value: unknown,
): TaskStrategyCorrectionPolicy {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['maxRepairAttempts', 'maxSameFailureFingerprint']) ||
    !isBoundedPositiveInteger(
      value.maxRepairAttempts,
      DEFAULT_TASK_STRATEGY_CORRECTION_POLICY.maxRepairAttempts,
    ) ||
    !isBoundedPositiveInteger(
      value.maxSameFailureFingerprint,
      DEFAULT_TASK_STRATEGY_CORRECTION_POLICY.maxSameFailureFingerprint,
    )
  ) {
    throw workflowError(
      'TASK_STRATEGY_CORRECTION_POLICY_INVALID',
      'Task-strategy correction policy is invalid or exceeds code-owned bounds.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    maxRepairAttempts: value.maxRepairAttempts as number,
    maxSameFailureFingerprint: value.maxSameFailureFingerprint as number,
  });
}

export function createTaskStrategyGreenFailureRecord(
  paths: InvestigationRuntimePaths,
  input: TaskStrategyGreenFailureInput,
): TaskStrategyGreenFailureRecord {
  const prepared = prepareTaskStrategyGreenFailureRecord(input);
  return withPrivateRuntimeLock(
    paths,
    greenFailureLockPath(paths, prepared.sessionId, prepared.candidateTree),
    () => {
      const existing = readTaskStrategyGreenFailureRecord(
        paths,
        prepared.sessionId,
        prepared.candidateTree,
      );
      if (existing !== null) {
        if (
          existing.subjectDigest === prepared.subjectDigest &&
          existing.failingCheck.failureFingerprint ===
            prepared.failingCheck.failureFingerprint
        ) {
          return existing;
        }
        throw greenFailureConflict();
      }
      createPrivateCanonicalJson(
        paths,
        greenFailurePath(paths, prepared.sessionId, prepared.candidateTree),
        prepared,
        greenFailureStateInvalid,
        'TASK_STRATEGY_GREEN_FAILURE_CONFLICT',
      );
      const stored = readTaskStrategyGreenFailureRecord(
        paths,
        prepared.sessionId,
        prepared.candidateTree,
      );
      if (stored === null || stored.recordDigest !== prepared.recordDigest) {
        throw greenFailureStateInvalid();
      }
      return stored;
    },
    'TASK_STRATEGY_GREEN_FAILURE_BUSY',
    greenFailureStateInvalid,
  );
}

export function readTaskStrategyGreenFailureRecord(
  paths: InvestigationRuntimePaths,
  requestedSessionId: string,
  requestedCandidateTree: string,
): TaskStrategyGreenFailureRecord | null {
  const sessionId = assertSessionId(requestedSessionId);
  const candidateTree = assertGitObjectId(requestedCandidateTree);
  const target = greenFailurePath(paths, sessionId, candidateTree);
  if (!privatePathExists(paths, target, greenFailureStateInvalid)) return null;
  const record = parseTaskStrategyGreenFailureRecord(
    readPrivateCanonicalJson(paths, target, greenFailureStateInvalid),
  );
  if (
    record.sessionId !== sessionId ||
    record.candidateTree !== candidateTree
  ) {
    throw greenFailureStateInvalid();
  }
  return record;
}

function greenFailurePath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  candidateTree: string,
): string {
  return path.join(
    paths.refs,
    'task-strategy-green-failures',
    sessionId,
    `${candidateTree}.json`,
  );
}

function greenFailureLockPath(
  paths: InvestigationRuntimePaths,
  sessionId: string,
  candidateTree: string,
): string {
  return path.join(
    paths.locks,
    'task-strategy-green-failures',
    `${sessionId}-${candidateTree}.lock`,
  );
}

function greenFailureConflict() {
  return workflowError(
    'TASK_STRATEGY_GREEN_FAILURE_CONFLICT',
    'A different GREEN failure is already bound to this candidate tree.',
    ExitCode.conflict,
  );
}

function isBoundedPositiveInteger(value: unknown, maximum: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= maximum
  );
}

import type {
  TaskStrategyCorrectionPolicy,
  TaskStrategyGreenCheckDefinition,
  TaskStrategyPatchHead,
  TaskStrategyGreenFailureRecord,
  TaskStrategyGreenFailureInput,
} from '../../modules/provider-orchestration/task-strategy-correction-record.ts';
export type {
  TaskStrategyCorrectionPolicy,
  TaskStrategyGreenCheckDefinition,
  TaskStrategyPatchHead,
  TaskStrategyGreenFailureRecord,
  TaskStrategyGreenFailureInput,
} from '../../modules/provider-orchestration/task-strategy-correction-record.ts';
