/** Owns canonical current RED reference identity and its authoring/sealed variants. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  sha256,
  isRecord,
  hasExactKeys,
  isDigest,
  isCanonicalSessionId,
  isTimestamp,
  isRevisionId,
  revisionStateCorrupt,
} from './task-strategy-red-revision-values.ts';

type TaskStrategyCurrentRefBase = Readonly<{
  schemaVersion: 1;
  kind: 'task-strategy-current-ref.v1';
  refDigest: string;
  sessionId: string;
  predecessorTransactionDigest: string | null;
  revisionId: string | null;
  taskContractDigest: string;
  updatedAt: string;
}>;

export type TaskStrategyCurrentRef =
  | (TaskStrategyCurrentRefBase &
      Readonly<{
        state: 'red-authoring';
        transactionDigest: null;
        predecessorTransactionDigest: string;
        revisionId: string;
      }>)
  | (TaskStrategyCurrentRefBase &
      Readonly<{
        state: 'red-sealed';
        transactionDigest: string;
      }>);

export type TaskStrategyCurrentRefInput =
  | Readonly<{
      sessionId: string;
      state: 'red-authoring';
      transactionDigest: null;
      predecessorTransactionDigest: string;
      revisionId: string;
      taskContractDigest: string;
      updatedAt: string;
    }>
  | Readonly<{
      sessionId: string;
      state: 'red-sealed';
      transactionDigest: string;
      predecessorTransactionDigest: string | null;
      revisionId: string | null;
      taskContractDigest: string;
      updatedAt: string;
    }>;

export function createTaskStrategyCurrentRef(
  input: TaskStrategyCurrentRefInput,
): TaskStrategyCurrentRef {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-strategy-current-ref.v1' as const,
    sessionId: input.sessionId,
    state: input.state,
    transactionDigest: input.transactionDigest,
    predecessorTransactionDigest: input.predecessorTransactionDigest,
    revisionId: input.revisionId,
    taskContractDigest: input.taskContractDigest,
    updatedAt: input.updatedAt,
  };
  return parseTaskStrategyCurrentRef({
    ...body,
    refDigest: sha256(canonicalJson(body)),
  });
}

export function parseTaskStrategyCurrentRef(
  value: unknown,
): TaskStrategyCurrentRef {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'refDigest',
      'sessionId',
      'state',
      'transactionDigest',
      'predecessorTransactionDigest',
      'revisionId',
      'taskContractDigest',
      'updatedAt',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-strategy-current-ref.v1' ||
    !isDigest(value.refDigest) ||
    !isCanonicalSessionId(value.sessionId) ||
    !isDigest(value.taskContractDigest) ||
    !isTimestamp(value.updatedAt) ||
    (value.predecessorTransactionDigest !== null &&
      !isDigest(value.predecessorTransactionDigest)) ||
    (value.revisionId !== null && !isRevisionId(value.revisionId))
  ) {
    throw revisionStateCorrupt();
  }
  if (
    value.state === 'red-authoring'
      ? value.transactionDigest !== null ||
        !isDigest(value.predecessorTransactionDigest) ||
        !isRevisionId(value.revisionId)
      : value.state === 'red-sealed'
        ? !isDigest(value.transactionDigest) ||
          (value.predecessorTransactionDigest === null) !==
            (value.revisionId === null) ||
          (value.predecessorTransactionDigest !== null &&
            value.transactionDigest === value.predecessorTransactionDigest)
        : true
  ) {
    throw revisionStateCorrupt();
  }
  const { refDigest, ...body } = value;
  if (refDigest !== sha256(canonicalJson(body))) {
    throw revisionStateCorrupt();
  }
  return Object.freeze(value as TaskStrategyCurrentRef);
}
