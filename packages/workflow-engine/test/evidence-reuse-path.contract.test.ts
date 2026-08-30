import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { parsePlanReviewArtifact } from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import * as evidenceReusePath from '../src/adapters/planning/investigation/evidence-reuse-path.ts';
import {
  createConvergenceRecord,
  createDescendantReuseProof,
} from '../src/adapters/planning/investigation/evidence-convergence.ts';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

test('evidence reuse production surface exports only the PlanReview validator', () => {
  assert.deepEqual(Object.keys(evidenceReusePath), [
    'validateTrackedEvidenceReusePaths',
  ]);
});

test('tracked PlanReview evidence reuse requires an exact current-parent and proof ref pair', () => {
  const oldParent = createEvidenceNode({
    type: 'fixture-parent',
    nodeSchema: 'fixture.parent.v1',
    evaluator: 'fixture.parent.v1',
    policyDigest: 'a'.repeat(64),
    exactInputDigests: { source: 'b'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.parent-output.v1',
    output: { equivalent: true },
    runtimeMetadata: {},
  });
  const newParent = createEvidenceNode({
    type: 'fixture-parent',
    nodeSchema: 'fixture.parent.v1',
    evaluator: 'fixture.parent.v1',
    policyDigest: 'a'.repeat(64),
    exactInputDigests: { source: 'c'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.parent-output.v1',
    output: { equivalent: true },
    runtimeMetadata: {},
  });
  const descendant = createEvidenceNode({
    type: 'fixture-descendant',
    nodeSchema: 'fixture.descendant.v1',
    evaluator: 'fixture.descendant.v1',
    policyDigest: 'd'.repeat(64),
    exactInputDigests: { requirement: 'e'.repeat(64) },
    semanticParentResultDigests: { source: oldParent.resultDigest },
    provenanceParentNodeIds: { source: oldParent.nodeId },
    outputSchema: 'fixture.descendant-output.v1',
    output: { valid: true },
    runtimeMetadata: {},
  });
  const convergence = createConvergenceRecord({
    oldParent,
    newParent,
    validatorVersion: 'evidence-currentness.v1',
    runtimeMetadata: {},
  });
  const reuseProof = createDescendantReuseProof({
    descendant,
    parentRole: 'source',
    oldParent,
    newParent,
    convergenceRecord: convergence,
    validatorVersion: 'evidence-currentness.v1',
    runtimeMetadata: {},
  });
  assert.equal(convergence.nodeSchema, 'workflow.evidence-convergence.v1');
  assert.equal(
    convergence.outputSchema,
    'workflow.evidence-convergence-output.v1',
  );
  assert.equal(reuseProof.nodeSchema, 'workflow.evidence-reuse-proof.v1');
  assert.equal(
    reuseProof.outputSchema,
    'workflow.evidence-reuse-proof-output.v1',
  );
  const nodes = [
    oldParent,
    newParent,
    descendant,
    convergence,
    reuseProof,
  ].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
  const base = {
    schemaVersion: 1 as const,
    kind: 'plan-review-artifact' as const,
    changeId: 'demo-change',
    nodes,
    currentRefs: { planReview: descendant.nodeId },
  };
  const roleDigest = crypto
    .createHash('sha256')
    .update('source', 'utf8')
    .digest('hex');
  const currentParentRef = `current-parent/${descendant.nodeId}/${roleDigest}`;
  const reuseProofRef = `reuse-proof/${descendant.nodeId}/${roleDigest}`;

  for (const currentRefs of [
    base.currentRefs,
    { ...base.currentRefs, [currentParentRef]: newParent.nodeId },
    { ...base.currentRefs, [reuseProofRef]: reuseProof.nodeId },
  ]) {
    assert.throws(
      () => parsePlanReviewArtifact({ ...base, currentRefs }, 'demo-change'),
      (error) => workflowCode(error) === 'INVALID_PLAN_REVIEW_ARTIFACT',
    );
  }

  const current = {
    ...base,
    currentRefs: {
      ...base.currentRefs,
      [currentParentRef]: newParent.nodeId,
      [reuseProofRef]: reuseProof.nodeId,
    },
  };
  assert.deepEqual(parsePlanReviewArtifact(current, 'demo-change'), current);
});

function workflowCode(error: unknown): string | null {
  return error instanceof WorkflowError ? error.code : null;
}
