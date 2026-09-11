import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { validateClosedEvidenceDag } from '../src/foundation/evidence-node/evidence-dag.ts';
import {
  createEvidenceNode,
  type EvidenceNode,
  type EvidenceNodeInput,
} from '../src/foundation/evidence-node/evidence-node.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  evaluatePlanningAssurance,
  type PlanningAssuranceValidator,
} from '../src/modules/assurance/planning-assurance-validator.ts';

const DIGESTS = {
  policy: '1'.repeat(64),
  sourceA: '2'.repeat(64),
  sourceB: '3'.repeat(64),
  sourceC: '4'.repeat(64),
  requirement: '5'.repeat(64),
} as const;

test('closed evidence DAG orders a derivation chain with its sink last', () => {
  const root = evidenceNode('authorization', DIGESTS.sourceA, { ok: true });
  const middle = evidenceNode(
    'provider-result',
    DIGESTS.sourceB,
    { terms: ['a'] },
    { authorization: root },
  );
  const sink = evidenceNode(
    'coverage',
    DIGESTS.sourceC,
    { covered: true },
    { providerResult: middle },
  );

  assert.deepEqual(
    validateClosedEvidenceDag([sink, root, middle]).topologicalNodeIds,
    [root.nodeId, middle.nodeId, sink.nodeId],
  );
});

test('closed evidence DAG rejects a provenance edge outside the validated set', () => {
  const absent = evidenceNode('provider-result', DIGESTS.sourceA, {
    terms: [],
  });
  const child = evidenceNode(
    'coverage',
    DIGESTS.sourceB,
    { covered: true },
    { providerResult: absent },
  );

  assert.throws(
    () => validateClosedEvidenceDag([child]),
    (error: unknown) => isWorkflowError(error, 'EVIDENCE_DAG_INVALID'),
  );
});

test('closed evidence DAG rejects a descendant that records a parent result the parent never produced', () => {
  const parent = evidenceNode('provider-result', DIGESTS.sourceA, {
    terms: ['a'],
  });
  const other = evidenceNode('provider-result', DIGESTS.sourceB, {
    terms: ['b'],
  });
  // The chain-assembly case: dispositions built on one scan, claimed against another.
  const forged = evidenceNode(
    'coverage',
    DIGESTS.sourceC,
    { covered: true },
    { providerResult: parent },
  );
  const swapped = {
    ...forged,
    semanticParentResultDigests: { providerResult: other.resultDigest },
  };

  assert.throws(
    () => validateClosedEvidenceDag([parent, swapped]),
    (error: unknown) => isWorkflowError(error, 'EVIDENCE_DAG_INVALID'),
  );
});

test('closed evidence DAG rejects a provenance cycle', () => {
  const first = evidenceNode('a', DIGESTS.sourceA, { n: 1 });
  const second = evidenceNode('b', DIGESTS.sourceB, { n: 2 }, { first });
  const cyclic = {
    ...first,
    provenanceParentNodeIds: { second: second.nodeId },
    semanticParentResultDigests: { second: second.resultDigest },
  };

  assert.throws(
    () => validateClosedEvidenceDag([cyclic, second]),
    (error: unknown) => isWorkflowError(error, 'EVIDENCE_DAG_INVALID'),
  );
});

test('live and CI loaders share one canonical content-pure planning validator', () => {
  const liveNode = evidenceNode(
    'scan',
    DIGESTS.sourceA,
    { hits: [] },
    {},
    {
      runtimeMetadata: {
        createdAt: '2026-07-23T00:00:00.000Z',
      },
    },
  );
  const ciNode = evidenceNode(
    'scan',
    DIGESTS.sourceA,
    { hits: [] },
    {},
    {
      runtimeMetadata: {
        retryCount: 2,
      },
    },
  );
  assert.equal(ciNode.nodeId, liveNode.nodeId);
  assert.equal(ciNode.resultDigest, liveNode.resultDigest);

  const validator: PlanningAssuranceValidator = {
    version: 'planning-assurance.v1',
    evaluate(input) {
      return {
        accepted:
          (input.subject as { changeId?: string }).changeId ===
            'sample-change' &&
          (input.policy as { required?: boolean }).required === true,
        artifactNames: Object.keys(input.artifacts).sort(),
        subjectKeys: Object.keys(input.subject as Record<string, unknown>),
        artifactRuntimeMetadata: input.artifacts.scan?.runtimeMetadata,
      };
    },
  };
  const loadLive = () => ({
    subject: { tree: DIGESTS.sourceA, changeId: 'sample-change' },
    policy: { version: 1, required: true },
    artifacts: { scan: liveNode },
  });
  const loadCi = () => ({
    subject: { changeId: 'sample-change', tree: DIGESTS.sourceA },
    policy: { required: true, version: 1 },
    artifacts: { scan: ciNode },
  });

  const live = evaluatePlanningAssurance(loadLive(), validator);
  const ci = evaluatePlanningAssurance(loadCi(), validator);
  assert.deepEqual(ci, live);
  assert.deepEqual(live.result, {
    accepted: true,
    artifactNames: ['scan'],
    subjectKeys: ['changeId', 'tree'],
    artifactRuntimeMetadata: {},
  });
  assert.match(live.inputDigest, /^[0-9a-f]{64}$/);
  assert.match(live.resultDigest, /^[0-9a-f]{64}$/);
  assert.equal(live.validatorVersion, 'planning-assurance.v1');
});

test('planning validators receive a deeply frozen canonical snapshot', () => {
  const source = {
    subject: {
      changeId: 'sample-change',
      nested: { value: 1 },
    },
    policy: { required: true },
    artifacts: {
      scan: evidenceNode('scan', DIGESTS.sourceA, { hits: [] }),
    },
  };
  const result = evaluatePlanningAssurance(source, {
    version: 'planning-assurance.v1',
    evaluate(input) {
      assert.equal(Object.isFrozen(input), true);
      assert.equal(Object.isFrozen(input.subject), true);
      assert.equal(
        Object.isFrozen(
          (input.subject as { nested: Record<string, unknown> }).nested,
        ),
        true,
      );
      assert.equal(Object.isFrozen(input.artifacts), true);
      assert.equal(Object.isFrozen(input.artifacts.scan), true);
      assert.throws(() => {
        (input.subject as { nested: { value: number } }).nested.value = 2;
      }, TypeError);
      return { accepted: true };
    },
  });

  assert.deepEqual(result.result, { accepted: true });
  assert.equal(source.subject.nested.value, 1);
});

test('planning validator results are detached and frozen before digesting', () => {
  const evaluatorResult = {
    accepted: true,
    nested: { count: 1 },
  };
  const result = evaluatePlanningAssurance(
    {
      subject: { changeId: 'sample-change' },
      policy: { required: true },
      artifacts: {
        scan: evidenceNode('scan', DIGESTS.sourceA, { hits: [] }),
      },
    },
    {
      version: 'planning-assurance.v1',
      evaluate: () => evaluatorResult,
    },
  );

  evaluatorResult.nested.count = 2;
  assert.deepEqual(result.result, {
    accepted: true,
    nested: { count: 1 },
  });
  assert.equal(Object.isFrozen(result.result), true);
  assert.equal(
    Object.isFrozen((result.result as { nested: object }).nested),
    true,
  );
});

test('planning assurance snapshots validator identity exactly once', () => {
  const input = {
    subject: { changeId: 'sample-change' },
    policy: { required: true },
    artifacts: {
      scan: evidenceNode('scan', DIGESTS.sourceA, { hits: [] }),
    },
  };
  let versionReads = 0;
  const changingValidator: PlanningAssuranceValidator = {
    get version() {
      versionReads += 1;
      return versionReads === 1
        ? 'planning-assurance.v1'
        : 'planning-assurance.v2';
    },
    evaluate: () => ({ accepted: true }),
  };
  const changing = evaluatePlanningAssurance(input, changingValidator);
  const stable = evaluatePlanningAssurance(input, {
    version: 'planning-assurance.v1',
    evaluate: () => ({ accepted: true }),
  });

  assert.equal(versionReads, 1);
  assert.deepEqual(changing, stable);
  assert.throws(
    () =>
      evaluatePlanningAssurance(input, {
        version: '',
        evaluate: () => ({ accepted: true }),
      }),
    (error) => isWorkflowError(error, 'PLANNING_ASSURANCE_VALIDATOR_INVALID'),
  );
});

test('planning result identity binds the validator version', () => {
  const input = {
    subject: { changeId: 'sample-change' },
    policy: { required: true },
    artifacts: {
      scan: evidenceNode('scan', DIGESTS.sourceA, { hits: [] }),
    },
  };
  const first = evaluatePlanningAssurance(input, {
    version: 'planning-assurance.v1',
    evaluate: () => ({ accepted: true }),
  });
  const second = evaluatePlanningAssurance(input, {
    version: 'planning-assurance.v2',
    evaluate: () => ({ accepted: true }),
  });

  assert.equal(first.validatorVersion, 'planning-assurance.v1');
  assert.equal(second.validatorVersion, 'planning-assurance.v2');
  assert.notEqual(first.inputDigest, second.inputDigest);
  assert.notEqual(first.resultDigest, second.resultDigest);
});

function digestString(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function evidenceNode(
  type: string,
  sourceDigest: string,
  output: unknown,
  parents: Record<string, EvidenceNode> = {},
  override: Partial<EvidenceNodeInput> = {},
): EvidenceNode {
  return createEvidenceNode({
    type,
    nodeSchema: 'expense-app.workflow.evidence-node.v1',
    evaluator: 'fixture-evaluator.v1',
    policyDigest: DIGESTS.policy,
    exactInputDigests: { source: sourceDigest },
    semanticParentResultDigests: Object.fromEntries(
      Object.entries(parents).map(([role, parent]) => [
        role,
        parent.resultDigest,
      ]),
    ),
    provenanceParentNodeIds: Object.fromEntries(
      Object.entries(parents).map(([role, parent]) => [role, parent.nodeId]),
    ),
    outputSchema: 'expense-app.workflow.fixture-output.v1',
    output,
    runtimeMetadata: {},
    ...override,
  });
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
