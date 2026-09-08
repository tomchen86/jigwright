/**
 * Defines and validates investigation resolution decisions, nodes, and state identities.
 *
 * Invariants:
 * - Decisions retain their exact schemas, consequences, and advertised availability.
 * - Node and state identities bind the same target, expected state, grant, and timestamp.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  WORKFLOW_SUPERSEDE_REASONS,
  type WorkflowSupersedeReason,
  validateWorkflowSupersedeReason,
} from '../../modules/authority/intervention-control.ts';
import {
  assertChangeId,
  assertInvestigationId,
} from '../session-workspace/paths.ts';
import {
  assertHumanResolutionGrantId,
  exactResolutionTimestamp,
  humanResolutionInvalid,
  humanResolutionObjectUnsafe,
  isBoundedResolutionText,
  isEmptyRecord,
  isSortedUniqueStrings,
} from './investigation-resolution-values.ts';
import {
  type InvestigationSession,
  type InvestigationSessionState,
} from './investigation-session-types.ts';
import {
  deepFreeze,
  hasExactKeys,
  isDigest,
  isRecord,
  isStringArray,
  isTimestamp,
  sha256,
} from './investigation-store-values.ts';

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

export type HumanResolutionDecision =
  | {
      kind: 'resume-with-capability';
      capability: 'reviewer-term-reopen';
      parameters: { additionalUses: 1 };
    }
  | {
      kind: 'close-input';
      input: 'reviewer-terms';
      parameters: Record<string, never>;
    }
  | { kind: 'abort'; parameters: Record<string, never> }
  | {
      kind: 'supersede';
      parameters: {
        successorInvestigationId: string | null;
        reason: WorkflowSupersedeReason;
      };
    }
  | {
      kind: 'quarantine';
      parameters: { reason: string };
    }
  | {
      kind: 'repair';
      operation: 'replace-current-investigation-ref';
      parameters: { successorInvestigationId: string };
    }
  | {
      kind: 'waive-assurance';
      claim: 'reviewer-term-incorporation';
      parameters: Record<string, never>;
    };

export type HumanResolutionConsequences = {
  continuity: 'preserved' | 'broken' | 'not-applicable';
  assurance: 'unchanged' | 'human-waived' | 'degraded';
  claimsWaived: string[];
};

export type HumanResolutionAvailability = {
  kind: HumanResolutionDecision['kind'];
  parameterSchemaDigest: string;
};

export type InvestigationHumanActionBlocker = {
  schemaVersion: 2;
  state: 'human-action-required';
  reasonCode: string;
  blockedTransition: string;
  enteredAt: string;
  facts: Record<string, unknown>;
  availableResolutions: HumanResolutionAvailability[];
};

export type InvestigationResolutionStateEnvelope = {
  schemaVersion: 2;
  workflowKind: 'investigation';
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionDigest: string;
  sessionRevision: number;
  currentRefDigest: string | null;
  startReservationDigest: string | null;
  resolutionHeadNodeId: string | null;
  providerInvocationDigests: Array<{
    invocationId: string;
    files: Array<{ name: string; digest: string }>;
  }>;
  providerRetryReservations: Array<{
    attempt: number;
    previousInvocationId: string;
    invocationId: string;
    reservationDigest: string;
    status: 'committed' | 'pending';
  }>;
  repositoryProviderLeases: Array<{
    invocationId: string;
    investigationId: string;
    changeId: string;
    revision: number;
    leaseGeneration: number;
    leaseDigest: string;
  }>;
  evidenceRefs: Record<string, string> | null;
  evidenceRefsDigest: string | null;
  evidenceRefsClosureDigest: string | null;
  blockerDigest: string | null;
  ambiguityDigest: string | null;
};

export type InvestigationResolutionState = {
  envelope: InvestigationResolutionStateEnvelope;
  currentStateDigest: string;
  currentRefDigest: string | null;
  blocker:
    | InvestigationHumanActionBlocker
    | {
        state: 'actor-resolution-required' | 'human-action-required';
        code: string;
      }
    | null;
  availableResolutions: HumanResolutionAvailability[];
  effectiveState:
    | InvestigationSessionState
    | 'aborted-by-human-resolution'
    | 'superseded-by-human-resolution'
    | 'quarantined-by-human-resolution';
};

export type HumanResolutionTarget = {
  workflowKind: 'investigation';
  changeId: string;
  workflowId: string;
};

export type HumanResolutionExpectedState = {
  reasonCode: string;
  blockedTransition: string;
  stateDigest: string;
  currentRefDigest: string | null;
};

export type HumanResolutionNode = {
  schemaVersion: 1;
  kind: 'human-resolution-node';
  nodeId: string;
  target: HumanResolutionTarget;
  expected: HumanResolutionExpectedState;
  decision: HumanResolutionDecision;
  consequences: HumanResolutionConsequences;
  grantId: string;
  grantDigest: string;
  previousResolutionNodeId: string | null;
  createdAt: string;
};

export function humanResolutionDecisionSchemaDigest(
  kind: HumanResolutionDecision['kind'],
): string {
  return sha256(
    canonicalJson(
      HUMAN_RESOLUTION_DECISION_SCHEMAS[
        kind as keyof typeof HUMAN_RESOLUTION_DECISION_SCHEMAS
      ],
    ),
  );
}

export function assertHumanResolutionDecision(
  value: unknown,
): HumanResolutionDecision {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw humanResolutionInvalid('Human resolution decision is malformed.');
  }
  if (
    value.kind === 'resume-with-capability' &&
    hasExactKeys(value, ['kind', 'capability', 'parameters']) &&
    value.capability === 'reviewer-term-reopen' &&
    isRecord(value.parameters) &&
    hasExactKeys(value.parameters, ['additionalUses']) &&
    value.parameters.additionalUses === 1
  ) {
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'close-input' &&
    hasExactKeys(value, ['kind', 'input', 'parameters']) &&
    value.input === 'reviewer-terms' &&
    isEmptyRecord(value.parameters)
  ) {
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'abort' &&
    hasExactKeys(value, ['kind', 'parameters']) &&
    isEmptyRecord(value.parameters)
  ) {
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'supersede' &&
    hasExactKeys(value, ['kind', 'parameters']) &&
    isRecord(value.parameters) &&
    hasExactKeys(value.parameters, ['successorInvestigationId', 'reason']) &&
    (value.parameters.successorInvestigationId === null ||
      typeof value.parameters.successorInvestigationId === 'string') &&
    typeof value.parameters.reason === 'string'
  ) {
    if (typeof value.parameters.successorInvestigationId === 'string') {
      assertInvestigationId(value.parameters.successorInvestigationId);
    }
    validateWorkflowSupersedeReason(value.parameters.reason);
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'quarantine' &&
    hasExactKeys(value, ['kind', 'parameters']) &&
    isRecord(value.parameters) &&
    hasExactKeys(value.parameters, ['reason']) &&
    isBoundedResolutionText(value.parameters.reason, 4096)
  ) {
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'repair' &&
    hasExactKeys(value, ['kind', 'operation', 'parameters']) &&
    value.operation === 'replace-current-investigation-ref' &&
    isRecord(value.parameters) &&
    hasExactKeys(value.parameters, ['successorInvestigationId']) &&
    typeof value.parameters.successorInvestigationId === 'string'
  ) {
    assertInvestigationId(value.parameters.successorInvestigationId);
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  if (
    value.kind === 'waive-assurance' &&
    hasExactKeys(value, ['kind', 'claim', 'parameters']) &&
    value.claim === 'reviewer-term-incorporation' &&
    isEmptyRecord(value.parameters)
  ) {
    return deepFreeze(structuredClone(value)) as HumanResolutionDecision;
  }
  throw humanResolutionInvalid('Human resolution decision is unsupported.');
}

export function assertHumanResolutionConsequences(
  value: unknown,
): HumanResolutionConsequences {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['continuity', 'assurance', 'claimsWaived']) ||
    !['preserved', 'broken', 'not-applicable'].includes(
      String(value.continuity),
    ) ||
    !['unchanged', 'human-waived', 'degraded'].includes(
      String(value.assurance),
    ) ||
    !isStringArray(value.claimsWaived) ||
    !isSortedUniqueStrings(value.claimsWaived) ||
    value.claimsWaived.some((claim) => !isBoundedResolutionText(claim, 256))
  ) {
    throw humanResolutionInvalid(
      'Human resolution consequences are malformed.',
    );
  }
  return deepFreeze(structuredClone(value)) as HumanResolutionConsequences;
}

export function investigationResolutionStateDigest(
  envelope: InvestigationResolutionStateEnvelope,
): string {
  return sha256(
    canonicalJson({
      schema: HUMAN_RESOLUTION_SCHEMA,
      envelope,
    }),
  );
}

export function investigationCurrentRefDigest(
  input: {
    changeId: string;
    investigationId: string;
  } | null,
): string | null {
  return input === null
    ? null
    : sha256(
        `${canonicalJson({
          schemaVersion: 1,
          changeId: assertChangeId(input.changeId),
          investigationId: assertInvestigationId(input.investigationId),
        })}\n`,
      );
}

export function advertisedHumanResolutions(
  blocker: InvestigationSession['blocker'],
): HumanResolutionAvailability[] {
  const kinds: HumanResolutionDecision['kind'][] = [
    'abort',
    'quarantine',
    'supersede',
  ];
  if (
    blocker !== null &&
    'schemaVersion' in blocker &&
    blocker.schemaVersion === 2 &&
    blocker.reasonCode === 'INVESTIGATION_REVIEWER_REOPEN_LIMIT_REACHED'
  ) {
    kinds.unshift('resume-with-capability', 'close-input', 'waive-assurance');
  }
  return kinds.map((kind) => ({
    kind,
    parameterSchemaDigest: humanResolutionDecisionSchemaDigest(kind),
  }));
}

export function createInvestigationHumanActionBlocker(input: {
  reasonCode: string;
  blockedTransition: string;
  facts: Record<string, unknown>;
  now?: Date;
}): InvestigationHumanActionBlocker {
  if (
    !isBoundedResolutionText(input.reasonCode, 256) ||
    !isBoundedResolutionText(input.blockedTransition, 256) ||
    !isRecord(input.facts)
  ) {
    throw humanResolutionInvalid(
      'Investigation human-action blocker is malformed.',
    );
  }
  const enteredAt = exactResolutionTimestamp(input.now ?? new Date());
  const blocker: InvestigationHumanActionBlocker = {
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
    throw humanResolutionInvalid(
      'Investigation human-action blocker exceeds its fixed bound.',
    );
  }
  return deepFreeze(blocker);
}

export function createHumanResolutionNode(
  input: Omit<HumanResolutionNode, 'schemaVersion' | 'kind' | 'nodeId'>,
): HumanResolutionNode {
  const target = assertHumanResolutionTarget(input.target);
  const expected = assertHumanResolutionExpected(input.expected);
  const decision = assertHumanResolutionDecision(input.decision);
  const consequences = assertHumanResolutionConsequences(input.consequences);
  assertHumanResolutionGrantId(input.grantId);
  if (
    !isDigest(input.grantDigest) ||
    (input.previousResolutionNodeId !== null &&
      !isDigest(input.previousResolutionNodeId)) ||
    exactResolutionTimestamp(new Date(input.createdAt)) !== input.createdAt
  ) {
    throw humanResolutionInvalid('Human resolution node is malformed.');
  }
  assertDecisionConsequences(decision, consequences);
  const semantic = {
    schemaVersion: 1 as const,
    kind: 'human-resolution-node' as const,
    target,
    expected,
    decision,
    consequences,
    grantId: input.grantId,
    grantDigest: input.grantDigest,
    previousResolutionNodeId: input.previousResolutionNodeId,
    createdAt: input.createdAt,
  };
  const node: HumanResolutionNode = {
    ...semantic,
    nodeId: sha256(
      canonicalJson({
        schema: 'human-resolution-node.v1',
        node: semantic,
      }),
    ),
  };
  return deepFreeze(node);
}

export function assertHumanResolutionTarget(
  value: unknown,
): HumanResolutionTarget {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['workflowKind', 'changeId', 'workflowId']) ||
    value.workflowKind !== 'investigation' ||
    typeof value.changeId !== 'string' ||
    typeof value.workflowId !== 'string'
  ) {
    throw humanResolutionInvalid('Human resolution target is malformed.');
  }
  assertChangeId(value.changeId);
  assertInvestigationId(value.workflowId);
  return deepFreeze(structuredClone(value)) as HumanResolutionTarget;
}

function assertHumanResolutionExpected(
  value: unknown,
): HumanResolutionExpectedState {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'reasonCode',
      'blockedTransition',
      'stateDigest',
      'currentRefDigest',
    ]) ||
    !isBoundedResolutionText(value.reasonCode, 256) ||
    !isBoundedResolutionText(value.blockedTransition, 256) ||
    !isDigest(value.stateDigest) ||
    (value.currentRefDigest !== null && !isDigest(value.currentRefDigest))
  ) {
    throw humanResolutionInvalid(
      'Human resolution expected-state binding is malformed.',
    );
  }
  return deepFreeze(structuredClone(value)) as HumanResolutionExpectedState;
}

export function assertHumanResolutionNode(value: unknown): HumanResolutionNode {
  if (
    !isRecord(value) ||
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
    !isTimestamp(value.createdAt)
  ) {
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
  if (
    candidate.nodeId !== value.nodeId ||
    canonicalJson(candidate) !== canonicalJson(value)
  ) {
    throw humanResolutionObjectUnsafe();
  }
  return candidate;
}

function assertDecisionConsequences(
  decision: HumanResolutionDecision,
  consequences: HumanResolutionConsequences,
): void {
  if (
    ['supersede', 'repair'].includes(decision.kind) &&
    consequences.continuity !== 'broken'
  ) {
    throw humanResolutionInvalid(
      'Supersede and repair decisions must declare broken continuity.',
    );
  }
  if (decision.kind === 'abort' && consequences.continuity === 'preserved') {
    throw humanResolutionInvalid(
      'Abort cannot claim preserved workflow continuity.',
    );
  }
  if (
    decision.kind === 'waive-assurance' &&
    (consequences.assurance !== 'human-waived' ||
      !consequences.claimsWaived.includes(decision.claim))
  ) {
    throw humanResolutionInvalid(
      'An assurance waiver must name and downgrade the waived claim.',
    );
  }
  if (
    decision.kind === 'close-input' &&
    consequences.assurance === 'unchanged'
  ) {
    throw humanResolutionInvalid(
      'Closing reviewer input must declare degraded or waived assurance.',
    );
  }
}

export function effectiveHumanResolutionState(
  node: HumanResolutionNode,
  fallback: InvestigationSessionState,
): InvestigationResolutionState['effectiveState'] {
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

export function terminalHumanResolutionState(
  value: InvestigationResolutionState['effectiveState'],
): boolean {
  return (
    value === 'aborted-by-human-resolution' ||
    value === 'superseded-by-human-resolution' ||
    value === 'quarantined-by-human-resolution'
  );
}
