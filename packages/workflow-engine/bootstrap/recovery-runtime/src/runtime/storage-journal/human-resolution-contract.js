/**
 * Defines and validates investigation resolution decisions, nodes, and state identities.
 *
 * Invariants:
 * - Decisions retain their exact schemas, consequences, and advertised availability.
 * - Node and state identities bind the same target, expected state, grant, and timestamp.
 *
 * Depends on: investigation session types, resolution value checks, and canonical JSON.
 * Failure modes: a resolution changes unauthorized consequences or no longer replays against its target.
 */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { WORKFLOW_SUPERSEDE_REASONS, validateWorkflowSupersedeReason, } from "../../modules/authority/intervention-control.js";
import { assertChangeId, assertInvestigationId, } from "../session-workspace/paths.js";
import { assertHumanResolutionGrantId, exactResolutionTimestamp, humanResolutionInvalid, humanResolutionObjectUnsafe, isBoundedResolutionText, isEmptyRecord, isSortedUniqueStrings, } from "./investigation-resolution-values.js";
import { deepFreeze, hasExactKeys, isDigest, isRecord, isStringArray, isTimestamp, sha256, } from "./investigation-store-values.js";
const HUMAN_RESOLUTION_SCHEMA = 'investigation-human-resolution.v2';
const HUMAN_RESOLUTION_DECISION_SCHEMAS = Object.freeze({
    'resume-with-capability': {
        schemaVersion: 1,
        kind: 'resume-with-capability',
        capability: 'reviewer-term-reopen',
        parameters: { additionalUses: { type: 'integer', minimum: 1, maximum: 1 } },
    },
    'close-input': {
        schemaVersion: 1,
        kind: 'close-input',
        input: 'reviewer-terms',
        parameters: {},
    },
    abort: {
        schemaVersion: 1,
        kind: 'abort',
        parameters: {},
    },
    supersede: {
        schemaVersion: 2,
        kind: 'supersede',
        parameters: {
            successorInvestigationId: {
                type: ['investigation-id', 'null'],
            },
            reason: {
                type: 'enum',
                values: [...WORKFLOW_SUPERSEDE_REASONS],
            },
        },
    },
    quarantine: {
        schemaVersion: 1,
        kind: 'quarantine',
        parameters: {
            reason: { type: 'non-empty-string', maxBytes: 4096 },
        },
    },
    repair: {
        schemaVersion: 1,
        kind: 'repair',
        operation: 'replace-current-investigation-ref',
        parameters: {
            successorInvestigationId: { type: 'investigation-id' },
        },
    },
    'waive-assurance': {
        schemaVersion: 1,
        kind: 'waive-assurance',
        claim: 'reviewer-term-incorporation',
        parameters: {},
    },
});
export function humanResolutionDecisionSchemaDigest(kind) {
    return sha256(canonicalJson(HUMAN_RESOLUTION_DECISION_SCHEMAS[kind]));
}
export function assertHumanResolutionDecision(value) {
    if (!isRecord(value) || typeof value.kind !== 'string') {
        throw humanResolutionInvalid('Human resolution decision is malformed.');
    }
    if (value.kind === 'resume-with-capability' &&
        hasExactKeys(value, ['kind', 'capability', 'parameters']) &&
        value.capability === 'reviewer-term-reopen' &&
        isRecord(value.parameters) &&
        hasExactKeys(value.parameters, ['additionalUses']) &&
        value.parameters.additionalUses === 1) {
        return deepFreeze(structuredClone(value));
    }
    if (value.kind === 'close-input' &&
        hasExactKeys(value, ['kind', 'input', 'parameters']) &&
        value.input === 'reviewer-terms' &&
        isEmptyRecord(value.parameters)) {
        return deepFreeze(structuredClone(value));
    }
    if (value.kind === 'abort' &&
        hasExactKeys(value, ['kind', 'parameters']) &&
        isEmptyRecord(value.parameters)) {
        return deepFreeze(structuredClone(value));
    }
    if (value.kind === 'supersede' &&
        hasExactKeys(value, ['kind', 'parameters']) &&
        isRecord(value.parameters) &&
        hasExactKeys(value.parameters, ['successorInvestigationId', 'reason']) &&
        (value.parameters.successorInvestigationId === null ||
            typeof value.parameters.successorInvestigationId === 'string') &&
        typeof value.parameters.reason === 'string') {
        if (typeof value.parameters.successorInvestigationId === 'string') {
            assertInvestigationId(value.parameters.successorInvestigationId);
        }
        validateWorkflowSupersedeReason(value.parameters.reason);
        return deepFreeze(structuredClone(value));
    }
    if (value.kind === 'quarantine' &&
        hasExactKeys(value, ['kind', 'parameters']) &&
        isRecord(value.parameters) &&
        hasExactKeys(value.parameters, ['reason']) &&
        isBoundedResolutionText(value.parameters.reason, 4096)) {
        return deepFreeze(structuredClone(value));
    }
    if (value.kind === 'repair' &&
        hasExactKeys(value, ['kind', 'operation', 'parameters']) &&
        value.operation === 'replace-current-investigation-ref' &&
        isRecord(value.parameters) &&
        hasExactKeys(value.parameters, ['successorInvestigationId']) &&
        typeof value.parameters.successorInvestigationId === 'string') {
        assertInvestigationId(value.parameters.successorInvestigationId);
        return deepFreeze(structuredClone(value));
    }
    if (value.kind === 'waive-assurance' &&
        hasExactKeys(value, ['kind', 'claim', 'parameters']) &&
        value.claim === 'reviewer-term-incorporation' &&
        isEmptyRecord(value.parameters)) {
        return deepFreeze(structuredClone(value));
    }
    throw humanResolutionInvalid('Human resolution decision is unsupported.');
}
export function assertHumanResolutionConsequences(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['continuity', 'assurance', 'claimsWaived']) ||
        !['preserved', 'broken', 'not-applicable'].includes(String(value.continuity)) ||
        !['unchanged', 'human-waived', 'degraded'].includes(String(value.assurance)) ||
        !isStringArray(value.claimsWaived) ||
        !isSortedUniqueStrings(value.claimsWaived) ||
        value.claimsWaived.some((claim) => !isBoundedResolutionText(claim, 256))) {
        throw humanResolutionInvalid('Human resolution consequences are malformed.');
    }
    return deepFreeze(structuredClone(value));
}
export function investigationResolutionStateDigest(envelope) {
    return sha256(canonicalJson({
        schema: HUMAN_RESOLUTION_SCHEMA,
        envelope,
    }));
}
export function investigationCurrentRefDigest(input) {
    return input === null
        ? null
        : sha256(`${canonicalJson({
            schemaVersion: 1,
            changeId: assertChangeId(input.changeId),
            investigationId: assertInvestigationId(input.investigationId),
        })}\n`);
}
export function advertisedHumanResolutions(blocker) {
    const kinds = [
        'abort',
        'quarantine',
        'supersede',
    ];
    if (blocker !== null &&
        'schemaVersion' in blocker &&
        blocker.schemaVersion === 2 &&
        blocker.reasonCode === 'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED') {
        kinds.unshift('resume-with-capability', 'close-input', 'waive-assurance');
    }
    return kinds.map((kind) => ({
        kind,
        parameterSchemaDigest: humanResolutionDecisionSchemaDigest(kind),
    }));
}
export function createInvestigationHumanActionBlocker(input) {
    if (!isBoundedResolutionText(input.reasonCode, 256) ||
        !isBoundedResolutionText(input.blockedTransition, 256) ||
        !isRecord(input.facts)) {
        throw humanResolutionInvalid('Investigation human-action blocker is malformed.');
    }
    const enteredAt = exactResolutionTimestamp(input.now ?? new Date());
    const blocker = {
        schemaVersion: 2,
        state: 'human-action-required',
        reasonCode: input.reasonCode,
        blockedTransition: input.blockedTransition,
        enteredAt,
        facts: structuredClone(input.facts),
        availableResolutions: advertisedHumanResolutions({
            schemaVersion: 2,
            state: 'human-action-required',
            reasonCode: input.reasonCode,
            blockedTransition: input.blockedTransition,
            enteredAt,
            facts: structuredClone(input.facts),
            availableResolutions: [],
        }),
    };
    if (Buffer.byteLength(canonicalJson(blocker), 'utf8') > 65_536) {
        throw humanResolutionInvalid('Investigation human-action blocker exceeds its fixed bound.');
    }
    return deepFreeze(blocker);
}
export function createHumanResolutionNode(input) {
    const target = assertHumanResolutionTarget(input.target);
    const expected = assertHumanResolutionExpected(input.expected);
    const decision = assertHumanResolutionDecision(input.decision);
    const consequences = assertHumanResolutionConsequences(input.consequences);
    assertHumanResolutionGrantId(input.grantId);
    if (!isDigest(input.grantDigest) ||
        (input.previousResolutionNodeId !== null &&
            !isDigest(input.previousResolutionNodeId)) ||
        exactResolutionTimestamp(new Date(input.createdAt)) !== input.createdAt) {
        throw humanResolutionInvalid('Human resolution node is malformed.');
    }
    assertDecisionConsequences(decision, consequences);
    const semantic = {
        schemaVersion: 1,
        kind: 'human-resolution-node',
        target,
        expected,
        decision,
        consequences,
        grantId: input.grantId,
        grantDigest: input.grantDigest,
        previousResolutionNodeId: input.previousResolutionNodeId,
        createdAt: input.createdAt,
    };
    const node = {
        ...semantic,
        nodeId: sha256(canonicalJson({
            schema: 'human-resolution-node.v1',
            node: semantic,
        })),
    };
    return deepFreeze(node);
}
export function assertHumanResolutionTarget(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, ['workflowKind', 'changeId', 'workflowId']) ||
        value.workflowKind !== 'investigation' ||
        typeof value.changeId !== 'string' ||
        typeof value.workflowId !== 'string') {
        throw humanResolutionInvalid('Human resolution target is malformed.');
    }
    assertChangeId(value.changeId);
    assertInvestigationId(value.workflowId);
    return deepFreeze(structuredClone(value));
}
function assertHumanResolutionExpected(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'reasonCode',
            'blockedTransition',
            'stateDigest',
            'currentRefDigest',
        ]) ||
        !isBoundedResolutionText(value.reasonCode, 256) ||
        !isBoundedResolutionText(value.blockedTransition, 256) ||
        !isDigest(value.stateDigest) ||
        (value.currentRefDigest !== null && !isDigest(value.currentRefDigest))) {
        throw humanResolutionInvalid('Human resolution expected-state binding is malformed.');
    }
    return deepFreeze(structuredClone(value));
}
export function assertHumanResolutionNode(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'schemaVersion',
            'kind',
            'nodeId',
            'target',
            'expected',
            'decision',
            'consequences',
            'grantId',
            'grantDigest',
            'previousResolutionNodeId',
            'createdAt',
        ]) ||
        value.schemaVersion !== 1 ||
        value.kind !== 'human-resolution-node' ||
        !isDigest(value.nodeId) ||
        typeof value.grantId !== 'string' ||
        !isDigest(value.grantDigest) ||
        (value.previousResolutionNodeId !== null &&
            !isDigest(value.previousResolutionNodeId)) ||
        !isTimestamp(value.createdAt)) {
        throw humanResolutionObjectUnsafe();
    }
    const candidate = createHumanResolutionNode({
        target: assertHumanResolutionTarget(value.target),
        expected: assertHumanResolutionExpected(value.expected),
        decision: assertHumanResolutionDecision(value.decision),
        consequences: assertHumanResolutionConsequences(value.consequences),
        grantId: assertHumanResolutionGrantId(value.grantId),
        grantDigest: value.grantDigest,
        previousResolutionNodeId: value.previousResolutionNodeId,
        createdAt: value.createdAt,
    });
    if (candidate.nodeId !== value.nodeId ||
        canonicalJson(candidate) !== canonicalJson(value)) {
        throw humanResolutionObjectUnsafe();
    }
    return candidate;
}
function assertDecisionConsequences(decision, consequences) {
    if (['supersede', 'repair'].includes(decision.kind) &&
        consequences.continuity !== 'broken') {
        throw humanResolutionInvalid('Supersede and repair decisions must declare broken continuity.');
    }
    if (decision.kind === 'abort' && consequences.continuity === 'preserved') {
        throw humanResolutionInvalid('Abort cannot claim preserved workflow continuity.');
    }
    if (decision.kind === 'waive-assurance' &&
        (consequences.assurance !== 'human-waived' ||
            !consequences.claimsWaived.includes(decision.claim))) {
        throw humanResolutionInvalid('An assurance waiver must name and downgrade the waived claim.');
    }
    if (decision.kind === 'close-input' &&
        consequences.assurance === 'unchanged') {
        throw humanResolutionInvalid('Closing reviewer input must declare degraded or waived assurance.');
    }
}
export function effectiveHumanResolutionState(node, fallback) {
    if (node.decision.kind === 'abort') {
        return 'aborted-by-human-resolution';
    }
    if (node.decision.kind === 'supersede' || node.decision.kind === 'repair') {
        return 'superseded-by-human-resolution';
    }
    if (node.decision.kind === 'quarantine') {
        return 'quarantined-by-human-resolution';
    }
    return fallback;
}
export function terminalHumanResolutionState(value) {
    return (value === 'aborted-by-human-resolution' ||
        value === 'superseded-by-human-resolution' ||
        value === 'quarantined-by-human-resolution');
}
