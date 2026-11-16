/** Parse planning artifact values without observing repository state. */
import type { EvidenceNode } from '@jigwright/core/evidence-node';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  isRecord,
  isStringArray,
} from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { validateClosedEvidenceDag } from '../../foundation/evidence-node/evidence-dag.ts';
import { assertStoredEvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';
import {
  assertTaskId,
  matchesAllowedPath,
  normalizePolicyPath,
} from '../../foundation/repository-path/repository-path.ts';
import type { ChecksConfig } from '../source/check-command.ts';
import { artifactInvalid } from './change-contract-errors.ts';
import type {
  BehaviorContractRef,
  CrossAgentTddExecution,
  DirectReviewedExecution,
  ExecutionArtifact,
  ExecutionTask,
  GuardContract,
  MechanicalTransformExecution,
  ParsedTask,
  PlanReviewArtifact,
  TddSingleAgentExecution,
  TransformationContract,
  TransformationTerm,
} from './planning-artifact-types.ts';

function looksLikeTaskCheckbox(line: string): boolean {
  const match = /^- \[([^\]]*)\](.*)$/.exec(line);
  if (!match) {
    return false;
  }
  if (match[2].startsWith('(') || match[2].startsWith('[')) {
    return false;
  }
  return match[1] === '' || /^[ xX]$/.test(match[1]) || /^\s+\d/.test(match[2]);
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expectedKeys: string[],
): boolean {
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function isTransformationTerm(value: unknown): value is TransformationTerm {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'value']) &&
    ['path', 'content', 'symbol', 'config'].includes(String(value.kind)) &&
    isReferenceTitle(value.value)
  );
}

function areResolvedBehaviorContractRefs(
  value: unknown,
  availableRefs: BehaviorContractRef[],
): value is BehaviorContractRef[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  const available = new Set(availableRefs.map((ref) => canonicalJson(ref)));
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['requirement', 'scenario', 'specPath']) ||
      typeof candidate.specPath !== 'string' ||
      !isDeltaSpecReferencePath(candidate.specPath) ||
      !isReferenceTitle(candidate.requirement) ||
      (candidate.scenario !== null && !isReferenceTitle(candidate.scenario))
    ) {
      return false;
    }
    const key = canonicalJson(candidate);
    if (seen.has(key) || !available.has(key)) {
      return false;
    }
    seen.add(key);
  }
  return true;
}

export function isDeltaSpecReferencePath(value: string): boolean {
  return /^specs\/[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*\/spec\.md$/.test(
    value,
  );
}

export function isReferenceTitle(value: unknown): value is string {
  return (
    isSemanticText(value) &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
    })
  );
}

function isSemanticText(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() !== value || !value) {
    return false;
  }
  const normalized = value.toLowerCase();
  return (
    !normalized.includes('<!--') &&
    !normalized.includes('<todo>') &&
    !normalized.includes('<placeholder>') &&
    normalized !== 'todo' &&
    normalized !== 'tbd'
  );
}

function sameMembers(left: string[], right: string[]): boolean {
  return (
    left.length === right.length && left.every((value) => right.includes(value))
  );
}

export function parseExecutionArtifact(
  value: unknown,
  expectedChangeId: string,
  tasks: ParsedTask[],
  guard: GuardContract,
  checks: ChecksConfig,
  behaviorContracts: BehaviorContractRef[],
): ExecutionArtifact {
  const invalid = () =>
    artifactInvalid(
      'INVALID_EXECUTION_ARTIFACT',
      'execution.json does not match schema version 1.',
    );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['changeId', 'kind', 'schemaVersion', 'tasks']) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'execution-artifact' ||
    value.changeId !== expectedChangeId ||
    !isRecord(value.tasks) ||
    Object.keys(value.tasks).length === 0
  ) {
    throw invalid();
  }
  const expectedTaskIds = tasks.map(({ id }) => id);
  const executionTaskIds = Object.keys(value.tasks);
  if (
    !sameMembers(executionTaskIds, expectedTaskIds) ||
    !sameMembers(executionTaskIds, Object.keys(guard.tasks))
  ) {
    throw invalid();
  }

  const parsedTasks: Record<string, ExecutionTask> = {};
  for (const taskId of expectedTaskIds) {
    const policy = guard.tasks[taskId];
    const task = tasks.find(({ id }) => id === taskId);
    const candidate = value.tasks[taskId];
    if (!policy || !task || !isRecord(candidate)) {
      throw invalid();
    }
    const commonKeys = [
      'allowedPaths',
      'diffReview',
      'enforcement',
      'requiredChecks',
      'strategy',
    ];
    if (
      !isStringArray(candidate.allowedPaths) ||
      !isStringArray(candidate.requiredChecks) ||
      JSON.stringify(candidate.allowedPaths) !==
        JSON.stringify(policy.allowedPaths) ||
      JSON.stringify(candidate.requiredChecks) !==
        JSON.stringify(policy.requiredChecks) ||
      (candidate.enforcement !== 'available' &&
        candidate.enforcement !== 'planned') ||
      (candidate.diffReview !== 'required' &&
        candidate.diffReview !== 'policy-required') ||
      candidate.requiredChecks.some(
        (checkId) => !Object.hasOwn(checks.checks, checkId),
      )
    ) {
      throw invalid();
    }

    if (
      candidate.strategy === 'cross-agent-tdd' ||
      candidate.strategy === 'tdd-single-agent'
    ) {
      if (
        !hasExactKeys(candidate, [
          ...commonKeys,
          'behaviorContractRefs',
          'fixturePathScopes',
          'greenChecks',
          'implementationPathScopes',
          'redCheck',
          'requiredImplementerIndependence',
          'testPathScopes',
        ]) ||
        !areResolvedBehaviorContractRefs(
          candidate.behaviorContractRefs,
          behaviorContracts,
        ) ||
        !isScopePartition(
          candidate.testPathScopes,
          policy.allowedPaths,
          true,
        ) ||
        !isScopePartition(candidate.fixturePathScopes, policy.allowedPaths) ||
        !isScopePartition(
          candidate.implementationPathScopes,
          policy.allowedPaths,
          true,
        ) ||
        !implementationScopesAreDisjoint(
          candidate.implementationPathScopes,
          candidate.testPathScopes,
          candidate.fixturePathScopes,
        ) ||
        typeof candidate.redCheck !== 'string' ||
        !isStringArray(candidate.greenChecks) ||
        JSON.stringify(candidate.greenChecks) !==
          JSON.stringify(policy.requiredChecks) ||
        !candidate.greenChecks.includes(candidate.redCheck) ||
        candidate.enforcement !== 'planned' ||
        candidate.requiredImplementerIndependence !==
          (candidate.strategy === 'cross-agent-tdd'
            ? 'session-independent'
            : 'none')
      ) {
        throw invalid();
      }
      parsedTasks[taskId] = candidate as
        CrossAgentTddExecution | TddSingleAgentExecution;
      continue;
    }

    if (candidate.strategy === 'mechanical-transform') {
      if (
        !hasExactKeys(candidate, [...commonKeys, 'transformationContract']) ||
        candidate.enforcement !== 'planned' ||
        !isTransformationContract(
          candidate.transformationContract,
          policy.allowedPaths,
        )
      ) {
        throw invalid();
      }
      parsedTasks[taskId] = candidate as MechanicalTransformExecution;
      continue;
    }

    if (candidate.strategy === 'direct-reviewed') {
      if (
        !hasExactKeys(candidate, [
          ...commonKeys,
          'exemptionKind',
          'exemptionReason',
        ]) ||
        ![
          'documentation-only',
          'formatting-only',
          'dependency-only',
          'narrowly-scoped-non-behavioral',
        ].includes(String(candidate.exemptionKind)) ||
        !isSemanticText(candidate.exemptionReason)
      ) {
        throw invalid();
      }
      parsedTasks[taskId] = candidate as DirectReviewedExecution;
      continue;
    }
    throw invalid();
  }

  return {
    schemaVersion: 1,
    kind: 'execution-artifact',
    changeId: expectedChangeId,
    tasks: parsedTasks,
  };
}

export function parsePlanReviewEvidenceArtifact(
  value: unknown,
  expectedChangeId: string,
  exactKeys: string[],
): PlanReviewArtifact {
  const invalid = () =>
    artifactInvalid(
      'INVALID_PLAN_REVIEW_ARTIFACT',
      'plan-review-artifact does not match schema version 1.',
    );
  if (
    !isRecord(value) ||
    !hasExactKeys(value, exactKeys) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'plan-review-artifact' ||
    value.changeId !== expectedChangeId ||
    !Array.isArray(value.nodes) ||
    value.nodes.length === 0 ||
    !isRecord(value.currentRefs) ||
    Object.keys(value.currentRefs).length === 0
  ) {
    throw invalid();
  }
  const nodes = value.nodes.map((node) =>
    assertStoredEvidenceNode(node, invalid),
  );
  try {
    validateEvidenceArtifactNodes(nodes);
  } catch {
    throw invalid();
  }
  const nodeIds = nodes.map(({ nodeId }) => nodeId);
  if (
    new Set(nodeIds).size !== nodeIds.length ||
    JSON.stringify(nodeIds) !== JSON.stringify([...nodeIds].sort()) ||
    nodes.some(({ runtimeMetadata }) => Object.keys(runtimeMetadata).length > 0)
  ) {
    throw invalid();
  }
  const nodeIdSet = new Set(nodeIds);
  if (
    nodes.some((node) =>
      Object.values(node.provenanceParentNodeIds).some(
        (parentNodeId) => !nodeIdSet.has(parentNodeId),
      ),
    )
  ) {
    throw invalid();
  }
  const currentRefs: Record<string, string> = {};
  for (const [role, nodeId] of Object.entries(value.currentRefs)) {
    if (
      !/^[a-zA-Z0-9]+(?:[._:/-][a-zA-Z0-9]+)*$/.test(role) ||
      typeof nodeId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(nodeId) ||
      !nodeIdSet.has(nodeId)
    ) {
      throw invalid();
    }
    currentRefs[role] = nodeId;
  }
  return {
    schemaVersion: 1,
    kind: 'plan-review-artifact',
    changeId: expectedChangeId,
    nodes,
    currentRefs,
  };
}

function validateEvidenceArtifactNodes(nodes: EvidenceNode[]): void {
  validateClosedEvidenceDag(nodes);
}

export function parseTasks(markdown: string): ParsedTask[] {
  const tasks: ParsedTask[] = [];
  const seen = new Set<string>();
  const lines = markdown.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^- \[([ xX])\] (\d+(?:\.\d+)+)\s+(.+)$/.exec(lines[index]);
    if (!match || match[3].trim().length === 0) {
      if (looksLikeTaskCheckbox(lines[index])) {
        throw workflowError(
          'MALFORMED_TASK_LINE',
          `Malformed workflow task at line ${index + 1}.`,
          ExitCode.guard,
          { details: { lineNumber: index + 1 } },
        );
      }
      continue;
    }
    const id = assertTaskId(match[2]);
    if (seen.has(id)) {
      throw workflowError(
        'DUPLICATE_TASK_ID',
        `Duplicate task ID in tasks.md: ${id}`,
        ExitCode.guard,
      );
    }
    seen.add(id);
    const titleParts = [match[3].trim()];
    while (/^\s{2,}\S/.test(lines[index + 1] ?? '')) {
      titleParts.push(lines[index + 1].trim());
      index += 1;
    }
    tasks.push({
      id,
      completed: match[1].toLowerCase() === 'x',
      title: titleParts.join(' '),
    });
  }

  return tasks;
}

function isScopePartition(
  value: unknown,
  allowedPaths: string[],
  requireNonEmpty = false,
): value is string[] {
  return (
    isStringArray(value) &&
    (!requireNonEmpty || value.length > 0) &&
    new Set(value).size === value.length &&
    value.every((scope) => isPolicyScopeInside(scope, allowedPaths))
  );
}

function implementationScopesAreDisjoint(
  implementationScopes: string[],
  testScopes: string[],
  fixtureScopes: string[],
): boolean {
  return implementationScopes.every((implementationScope) =>
    [...testScopes, ...fixtureScopes].every(
      (redScope) => !policyScopesOverlap(implementationScope, redScope),
    ),
  );
}

function policyScopesOverlap(left: string, right: string): boolean {
  try {
    const normalizedLeft = normalizePolicyPath(left);
    const normalizedRight = normalizePolicyPath(right);
    const leftPrefix = normalizedLeft.endsWith('/**');
    const rightPrefix = normalizedRight.endsWith('/**');
    if (!leftPrefix && !rightPrefix) {
      return normalizedLeft === normalizedRight;
    }
    if (!leftPrefix) {
      return matchesAllowedPath(normalizedLeft, normalizedRight);
    }
    if (!rightPrefix) {
      return matchesAllowedPath(normalizedRight, normalizedLeft);
    }
    return (
      matchesAllowedPath(normalizedLeft.slice(0, -3), normalizedRight) ||
      matchesAllowedPath(normalizedRight.slice(0, -3), normalizedLeft)
    );
  } catch {
    return true;
  }
}

function isPolicyScopeInside(scope: string, allowedPaths: string[]): boolean {
  try {
    const normalizedScope = normalizePolicyPath(scope);
    if (!normalizedScope.endsWith('/**')) {
      return allowedPaths.some((allowedPath) =>
        matchesAllowedPath(normalizedScope, allowedPath),
      );
    }
    const scopeBase = normalizedScope.slice(0, -3);
    return allowedPaths.some((allowedPath) => {
      const normalizedAllowed = normalizePolicyPath(allowedPath);
      return (
        normalizedAllowed.endsWith('/**') &&
        matchesAllowedPath(scopeBase, normalizedAllowed)
      );
    });
  } catch {
    return false;
  }
}

function isTransformationContract(
  value: unknown,
  allowedPaths: string[],
): value is TransformationContract {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'examples',
      'fileScopes',
      'oldTerms',
      'redInapplicableReason',
      'replacementTerms',
      'retainedDispositions',
      'rule',
    ]) ||
    !isSemanticText(value.rule) ||
    !isSemanticText(value.redInapplicableReason) ||
    !isScopePartition(value.fileScopes, allowedPaths, true) ||
    !Array.isArray(value.examples) ||
    value.examples.length === 0 ||
    !Array.isArray(value.oldTerms) ||
    value.oldTerms.length === 0 ||
    !Array.isArray(value.replacementTerms) ||
    value.replacementTerms.length === 0 ||
    !Array.isArray(value.retainedDispositions)
  ) {
    return false;
  }
  const oldTerms = value.oldTerms as unknown[];
  const replacementTerms = value.replacementTerms as unknown[];
  const examplesValid = value.examples.every(
    (example) =>
      isRecord(example) &&
      hasExactKeys(example, ['after', 'before']) &&
      isSemanticText(example.before) &&
      isSemanticText(example.after) &&
      example.before !== example.after,
  );
  const terms = [...oldTerms, ...replacementTerms];
  if (
    !examplesValid ||
    !terms.every(isTransformationTerm) ||
    oldTerms.length !== replacementTerms.length ||
    oldTerms.some(
      (term, index) =>
        isTransformationTerm(term) &&
        isTransformationTerm(replacementTerms[index]) &&
        term.kind !== replacementTerms[index]!.kind,
    )
  ) {
    return false;
  }
  const oldTermKeys = new Set(oldTerms.map((term) => canonicalJson(term)));
  const replacementTermKeys = new Set(
    replacementTerms.map((term) => canonicalJson(term)),
  );
  if (
    new Set(value.examples.map((example) => canonicalJson(example))).size !==
      value.examples.length ||
    oldTermKeys.size !== value.oldTerms.length ||
    replacementTermKeys.size !== value.replacementTerms.length ||
    [...oldTermKeys].some((term) => replacementTermKeys.has(term))
  ) {
    return false;
  }
  const oldSurfaceKeys = oldTerms.map((term) =>
    canonicalJson({
      surface:
        isTransformationTerm(term) && term.kind === 'path' ? 'path' : 'content',
      value: isTransformationTerm(term) ? term.value : '',
    }),
  );
  if (new Set(oldSurfaceKeys).size !== oldSurfaceKeys.length) return false;
  const retainedDispositions = value.retainedDispositions as unknown[];
  const dispositionKeys = retainedDispositions.map((disposition) => {
    if (!isRecord(disposition)) return null;
    let dispositionPath: string;
    try {
      if (typeof disposition.path !== 'string') return null;
      dispositionPath = normalizePolicyPath(disposition.path);
    } catch {
      return null;
    }
    if (
      !hasExactKeys(disposition, ['mutationClass', 'path', 'reason', 'term']) ||
      !isTransformationTerm(disposition.term) ||
      !oldTermKeys.has(canonicalJson(disposition.term)) ||
      dispositionPath !== disposition.path ||
      !['append-only', 'immutable', 'historical-reference'].includes(
        String(disposition.mutationClass),
      ) ||
      !isSemanticText(disposition.reason)
    ) {
      return null;
    }
    return canonicalJson({
      mutationClass: disposition.mutationClass,
      path: dispositionPath,
      term: disposition.term,
    });
  });
  return (
    dispositionKeys.every((key): key is string => key !== null) &&
    new Set(dispositionKeys).size === dispositionKeys.length &&
    dispositionKeys.every(
      (key, index) => index === 0 || dispositionKeys[index - 1]! < key,
    )
  );
}
