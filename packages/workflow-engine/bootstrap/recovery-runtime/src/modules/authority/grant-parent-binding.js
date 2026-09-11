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
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { isRecord } from "../../foundation/canonical-json/contract-values.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { grantHasExactKeys, grantSha256, GRANT_SHA256_DIGEST, GRANT_STABLE_ID, GRANT_UUID_V4, } from "./grant-primitives.js";
export function createGrantParentBindingV1(candidate) {
    const body = assertBindingBody(candidate);
    return Object.freeze({
        ...body,
        bindingDigest: grantSha256(`workflow.grant-parent-binding.v1\n${canonicalJson(body)}`),
    });
}
export function assertGrantParentBindingV1(value) {
    if (!isRecord(value) ||
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
        !GRANT_SHA256_DIGEST.test(value.bindingDigest)) {
        throw parentBindingInvalid();
    }
    const binding = createGrantParentBindingV1({
        schemaVersion: value.schemaVersion,
        kind: value.kind,
        relationKind: value.relationKind,
        parentChallengeId: value.parentChallengeId,
        parentChallengeDigest: value.parentChallengeDigest,
        parentOperationId: value.parentOperationId,
        parentApprovalSubjectDigest: value.parentApprovalSubjectDigest,
        parentStateBindingDigest: value.parentStateBindingDigest,
        parentParametersDigest: value.parentParametersDigest,
        parentPreparedRecordDigest: value.parentPreparedRecordDigest,
        relationshipFactsDigest: value.relationshipFactsDigest,
    });
    if (binding.bindingDigest !== value.bindingDigest) {
        throw parentBindingInvalid();
    }
    return binding;
}
export function createPreparedGrantDescendantTreeV1(candidate) {
    if (candidate.schemaVersion !== 1 ||
        candidate.kind !== 'prepared-grant-descendant-tree.v1' ||
        !GRANT_UUID_V4.test(candidate.rootChallengeId) ||
        !GRANT_SHA256_DIGEST.test(candidate.rootPreparedRecordDigest) ||
        !Array.isArray(candidate.nodes) ||
        candidate.nodes.length > 64) {
        throw parentBindingInvalid();
    }
    const nodes = candidate.nodes.map(assertPreparedGrantDescendantNodeV1);
    const sorted = [...nodes].sort((left, right) => left.depth - right.depth ||
        left.challengeId.localeCompare(right.challengeId));
    if (new Set(sorted.map(({ challengeId }) => challengeId)).size !==
        sorted.length ||
        canonicalJson(nodes) !== canonicalJson(sorted) ||
        sorted.some(({ challengeId }) => challengeId === candidate.rootChallengeId)) {
        throw parentBindingInvalid();
    }
    const body = Object.freeze({
        schemaVersion: 1,
        kind: 'prepared-grant-descendant-tree.v1',
        rootChallengeId: candidate.rootChallengeId,
        rootPreparedRecordDigest: candidate.rootPreparedRecordDigest,
        nodes: Object.freeze(sorted),
    });
    return Object.freeze({
        ...body,
        treeDigest: grantSha256(`workflow.prepared-grant-descendant-tree.v1\n${canonicalJson(body)}`),
    });
}
export function assertPreparedGrantDescendantTreeV1(value) {
    if (!isRecord(value) ||
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
        !GRANT_SHA256_DIGEST.test(value.treeDigest)) {
        throw parentBindingInvalid();
    }
    const tree = createPreparedGrantDescendantTreeV1({
        schemaVersion: value.schemaVersion,
        kind: value.kind,
        rootChallengeId: value.rootChallengeId,
        rootPreparedRecordDigest: value.rootPreparedRecordDigest,
        nodes: value.nodes,
    });
    if (tree.treeDigest !== value.treeDigest)
        throw parentBindingInvalid();
    return tree;
}
export function assertPreparedGrantDescendantNodeV1(value) {
    if (!isRecord(value) ||
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
        value.depth < 1 ||
        value.depth > 64 ||
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
        !GRANT_SHA256_DIGEST.test(value.preparedRecordDigest)) {
        throw parentBindingInvalid();
    }
    return Object.freeze({
        schemaVersion: 1,
        kind: 'prepared-grant-descendant.v1',
        depth: value.depth,
        challengeId: value.challengeId,
        challengeDigest: value.challengeDigest,
        operationId: value.operationId,
        approvalSubjectDigest: value.approvalSubjectDigest,
        stateBindingDigest: value.stateBindingDigest,
        preparedRecordDigest: value.preparedRecordDigest,
        parentBinding: assertGrantParentBindingV1(value.parentBinding),
    });
}
function assertBindingBody(value) {
    if (value.schemaVersion !== 1 ||
        value.kind !== 'grant-parent-binding.v1' ||
        !GRANT_STABLE_ID.test(value.relationKind) ||
        !GRANT_UUID_V4.test(value.parentChallengeId) ||
        !GRANT_SHA256_DIGEST.test(value.parentChallengeDigest) ||
        !GRANT_UUID_V4.test(value.parentOperationId) ||
        !GRANT_SHA256_DIGEST.test(value.parentApprovalSubjectDigest) ||
        !GRANT_SHA256_DIGEST.test(value.parentStateBindingDigest) ||
        !GRANT_SHA256_DIGEST.test(value.parentParametersDigest) ||
        !GRANT_SHA256_DIGEST.test(value.parentPreparedRecordDigest) ||
        !GRANT_SHA256_DIGEST.test(value.relationshipFactsDigest)) {
        throw parentBindingInvalid();
    }
    return Object.freeze({ ...value });
}
function parentBindingInvalid() {
    return workflowError('GRANT_PARENT_BINDING_INVALID', 'Grant parent binding is malformed or no longer exact.', ExitCode.guard);
}
