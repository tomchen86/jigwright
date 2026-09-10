/**
 * Builds and verifies canonical parent bindings and prepared descendant
 * trees for Grants.
 *
 * Invariants:
 * - `assertGrantParentBindingV1` rebuilds the binding and rejects it unless
 *   the recomputed `bindingDigest` equals the supplied one.
 * - A prepared-descendant tree must already be in canonical
 *   depth-then-challengeId order (nodes are compared against their sorted
 *   form), with unique challengeIds that exclude the root.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  grantHasExactKeys,
  grantSha256,
  GRANT_SHA256_DIGEST,
  GRANT_STABLE_ID,
  GRANT_UUID_V4,
} from './grant-primitives.ts';

export type GrantParentBindingV1 = Readonly<{
  schemaVersion: 1;
  kind: 'grant-parent-binding.v1';
  relationKind: string;
  parentChallengeId: string;
  parentChallengeDigest: `sha256:${string}`;
  parentOperationId: string;
  parentApprovalSubjectDigest: `sha256:${string}`;
  parentStateBindingDigest: `sha256:${string}`;
  parentParametersDigest: `sha256:${string}`;
  parentPreparedRecordDigest: `sha256:${string}`;
  relationshipFactsDigest: `sha256:${string}`;
  bindingDigest: `sha256:${string}`;
}>;

export type PreparedGrantDescendantNodeV1 = Readonly<{
  schemaVersion: 1;
  kind: 'prepared-grant-descendant.v1';
  depth: number;
  challengeId: string;
  challengeDigest: `sha256:${string}`;
  operationId: string;
  approvalSubjectDigest: `sha256:${string}`;
  stateBindingDigest: `sha256:${string}`;
  preparedRecordDigest: `sha256:${string}`;
  parentBinding: GrantParentBindingV1;
}>;

export type PreparedGrantDescendantTreeV1 = Readonly<{
  schemaVersion: 1;
  kind: 'prepared-grant-descendant-tree.v1';
  rootChallengeId: string;
  rootPreparedRecordDigest: `sha256:${string}`;
  nodes: readonly PreparedGrantDescendantNodeV1[];
  treeDigest: `sha256:${string}`;
}>;

type GrantParentBindingBodyV1 = Omit<GrantParentBindingV1, 'bindingDigest'>;

export function createGrantParentBindingV1(
  candidate: GrantParentBindingBodyV1,
): GrantParentBindingV1 {
  const body = assertBindingBody(candidate);
  return Object.freeze({
    ...body,
    bindingDigest: grantSha256(
      `workflow.grant-parent-binding.v1\n${canonicalJson(body)}`,
    ),
  });
}

export function assertGrantParentBindingV1(
  value: unknown,
): GrantParentBindingV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'relationKind',
      'parentChallengeId',
      'parentChallengeDigest',
      'parentOperationId',
      'parentApprovalSubjectDigest',
      'parentStateBindingDigest',
      'parentParametersDigest',
      'parentPreparedRecordDigest',
      'relationshipFactsDigest',
      'bindingDigest',
    ]) ||
    typeof value.bindingDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.bindingDigest)
  ) {
    throw parentBindingInvalid();
  }
  const binding = createGrantParentBindingV1({
    schemaVersion: value.schemaVersion as 1,
    kind: value.kind as 'grant-parent-binding.v1',
    relationKind: value.relationKind as string,
    parentChallengeId: value.parentChallengeId as string,
    parentChallengeDigest: value.parentChallengeDigest as `sha256:${string}`,
    parentOperationId: value.parentOperationId as string,
    parentApprovalSubjectDigest:
      value.parentApprovalSubjectDigest as `sha256:${string}`,
    parentStateBindingDigest:
      value.parentStateBindingDigest as `sha256:${string}`,
    parentParametersDigest: value.parentParametersDigest as `sha256:${string}`,
    parentPreparedRecordDigest:
      value.parentPreparedRecordDigest as `sha256:${string}`,
    relationshipFactsDigest:
      value.relationshipFactsDigest as `sha256:${string}`,
  });
  if (binding.bindingDigest !== value.bindingDigest) {
    throw parentBindingInvalid();
  }
  return binding;
}

export function createPreparedGrantDescendantTreeV1(
  candidate: Omit<PreparedGrantDescendantTreeV1, 'treeDigest'>,
): PreparedGrantDescendantTreeV1 {
  if (
    candidate.schemaVersion !== 1 ||
    candidate.kind !== 'prepared-grant-descendant-tree.v1' ||
    !GRANT_UUID_V4.test(candidate.rootChallengeId) ||
    !GRANT_SHA256_DIGEST.test(candidate.rootPreparedRecordDigest) ||
    !Array.isArray(candidate.nodes) ||
    candidate.nodes.length > 64
  ) {
    throw parentBindingInvalid();
  }
  const nodes = candidate.nodes.map(assertPreparedGrantDescendantNodeV1);
  const sorted = [...nodes].sort(
    (left, right) =>
      left.depth - right.depth ||
      left.challengeId.localeCompare(right.challengeId),
  );
  if (
    new Set(sorted.map(({ challengeId }) => challengeId)).size !==
      sorted.length ||
    canonicalJson(nodes) !== canonicalJson(sorted) ||
    sorted.some(({ challengeId }) => challengeId === candidate.rootChallengeId)
  ) {
    throw parentBindingInvalid();
  }
  const body = Object.freeze({
    schemaVersion: 1 as const,
    kind: 'prepared-grant-descendant-tree.v1' as const,
    rootChallengeId: candidate.rootChallengeId,
    rootPreparedRecordDigest: candidate.rootPreparedRecordDigest,
    nodes: Object.freeze(sorted),
  });
  return Object.freeze({
    ...body,
    treeDigest: grantSha256(
      `workflow.prepared-grant-descendant-tree.v1\n${canonicalJson(body)}`,
    ),
  });
}

export function assertPreparedGrantDescendantTreeV1(
  value: unknown,
): PreparedGrantDescendantTreeV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'rootChallengeId',
      'rootPreparedRecordDigest',
      'nodes',
      'treeDigest',
    ]) ||
    !Array.isArray(value.nodes) ||
    typeof value.treeDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.treeDigest)
  ) {
    throw parentBindingInvalid();
  }
  const tree = createPreparedGrantDescendantTreeV1({
    schemaVersion: value.schemaVersion as 1,
    kind: value.kind as 'prepared-grant-descendant-tree.v1',
    rootChallengeId: value.rootChallengeId as string,
    rootPreparedRecordDigest:
      value.rootPreparedRecordDigest as `sha256:${string}`,
    nodes: value.nodes as PreparedGrantDescendantNodeV1[],
  });
  if (tree.treeDigest !== value.treeDigest) throw parentBindingInvalid();
  return tree;
}

export function assertPreparedGrantDescendantNodeV1(
  value: unknown,
): PreparedGrantDescendantNodeV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'depth',
      'challengeId',
      'challengeDigest',
      'operationId',
      'approvalSubjectDigest',
      'stateBindingDigest',
      'preparedRecordDigest',
      'parentBinding',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'prepared-grant-descendant.v1' ||
    !Number.isSafeInteger(value.depth) ||
    (value.depth as number) < 1 ||
    (value.depth as number) > 64 ||
    typeof value.challengeId !== 'string' ||
    !GRANT_UUID_V4.test(value.challengeId) ||
    typeof value.challengeDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.challengeDigest) ||
    typeof value.operationId !== 'string' ||
    !GRANT_UUID_V4.test(value.operationId) ||
    typeof value.approvalSubjectDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.approvalSubjectDigest) ||
    typeof value.stateBindingDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.stateBindingDigest) ||
    typeof value.preparedRecordDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.preparedRecordDigest)
  ) {
    throw parentBindingInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'prepared-grant-descendant.v1',
    depth: value.depth as number,
    challengeId: value.challengeId,
    challengeDigest: value.challengeDigest as `sha256:${string}`,
    operationId: value.operationId,
    approvalSubjectDigest: value.approvalSubjectDigest as `sha256:${string}`,
    stateBindingDigest: value.stateBindingDigest as `sha256:${string}`,
    preparedRecordDigest: value.preparedRecordDigest as `sha256:${string}`,
    parentBinding: assertGrantParentBindingV1(value.parentBinding),
  });
}

function assertBindingBody(value: GrantParentBindingBodyV1) {
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'grant-parent-binding.v1' ||
    !GRANT_STABLE_ID.test(value.relationKind) ||
    !GRANT_UUID_V4.test(value.parentChallengeId) ||
    !GRANT_SHA256_DIGEST.test(value.parentChallengeDigest) ||
    !GRANT_UUID_V4.test(value.parentOperationId) ||
    !GRANT_SHA256_DIGEST.test(value.parentApprovalSubjectDigest) ||
    !GRANT_SHA256_DIGEST.test(value.parentStateBindingDigest) ||
    !GRANT_SHA256_DIGEST.test(value.parentParametersDigest) ||
    !GRANT_SHA256_DIGEST.test(value.parentPreparedRecordDigest) ||
    !GRANT_SHA256_DIGEST.test(value.relationshipFactsDigest)
  ) {
    throw parentBindingInvalid();
  }
  return Object.freeze({ ...value });
}

function parentBindingInvalid() {
  return workflowError(
    'GRANT_PARENT_BINDING_INVALID',
    'Grant parent binding is malformed or no longer exact.',
    ExitCode.guard,
  );
}
