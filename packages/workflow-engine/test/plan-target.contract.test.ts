import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  createPlanTarget,
  type PlanTargetInput,
} from '../src/modules/assurance/plan-target.ts';
import {
  DIGESTS,
  planTargetInput,
  authoredComponent,
  mixedComponent,
  tasksComponent,
  structuredComponent,
  policyComponent,
  isWorkflowError,
} from './plan-review-contract-fixture.ts';

test('plan target canonicalizes only enumerated component semantics', () => {
  const original = createPlanTarget(planTargetInput());

  const reorderedStructured = planTargetInput();
  structuredComponent(reorderedStructured, 'guard').value = {
    tasks: { '1.1': { requiredChecks: ['fixture'], allowedPaths: ['src/**'] } },
    changeId: 'demo-change',
    schemaVersion: 1,
  };
  assert.equal(
    createPlanTarget(reorderedStructured).targetDigest,
    original.targetDigest,
  );

  const crlf = planTargetInput();
  authoredComponent(crlf, 'proposal').content = authoredComponent(
    crlf,
    'proposal',
  ).content.replaceAll('\n', '\r\n');
  assert.equal(createPlanTarget(crlf).targetDigest, original.targetDigest);

  const checked = planTargetInput();
  tasksComponent(checked).content = tasksComponent(checked).content.replace(
    '- [ ] 1.1',
    '- [x] 1.1',
  );
  assert.equal(createPlanTarget(checked).targetDigest, original.targetDigest);

  for (const mutate of [
    (input: PlanTargetInput) => {
      authoredComponent(input, 'proposal').content =
        '# Proposal\n\nDo not preserve the behavior.\n';
    },
    (input: PlanTargetInput) => {
      tasksComponent(input).content =
        '# Tasks changed\n\n## Work\n\n- [ ] 1.1 Implement behavior\n';
    },
    (input: PlanTargetInput) => {
      mixedComponent(input).authoredRegions[0] = '# Design changed\n\n';
    },
    (input: PlanTargetInput) => {
      mixedComponent(input).managedProjection.sourceNodes[0]!.resultDigest =
        'c'.repeat(64);
    },
    (input: PlanTargetInput) => {
      mixedComponent(input).managedProjection.rendererDigest = 'd'.repeat(64);
    },
    (input: PlanTargetInput) => {
      policyComponent(input, 'review-policy').digest = 'e'.repeat(64);
    },
  ]) {
    const changed = planTargetInput();
    mutate(changed);
    assert.notEqual(
      createPlanTarget(changed).targetDigest,
      original.targetDigest,
    );
  }
});

test('plan target normalizes only managed task checkboxes and supports complete multi-clause specs', () => {
  const unchecked = planTargetInput();
  tasksComponent(unchecked).content +=
    '\n## Notes\n\n- [ ] Ordinary authored checklist\n';
  const checkedAuthoredChecklist = structuredClone(unchecked);
  tasksComponent(checkedAuthoredChecklist).content = tasksComponent(
    checkedAuthoredChecklist,
  ).content.replace(
    '- [ ] Ordinary authored checklist',
    '- [x] Ordinary authored checklist',
  );
  assert.notEqual(
    createPlanTarget(unchecked).targetDigest,
    createPlanTarget(checkedAuthoredChecklist).targetDigest,
  );

  const multipleClauses = planTargetInput();
  multipleClauses.components.push({
    kind: 'requirement-clause',
    role: 'requirement-clause',
    path: 'openspec/changes/demo-change/specs/demo/spec.md',
    requirement: 'Demo',
    scenario: 'Also works',
    content:
      '#### Scenario: Also works\n\n- **WHEN** another path runs\n- **THEN** it works\n',
  });
  const target = createPlanTarget(multipleClauses);
  assert.equal(
    target.components.filter(
      ({ role, path }) =>
        role === 'requirement-clause' &&
        path === 'openspec/changes/demo-change/specs/demo/spec.md',
    ).length,
    2,
  );

  const traversal = planTargetInput();
  authoredComponent(traversal, 'proposal').path = '../outside.md';
  assert.throws(
    () => createPlanTarget(traversal),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );
});

test('mixed target dependencies are order-insensitive and reject duplicate identities', () => {
  const first = planTargetInput();
  mixedComponent(first).managedProjection.sourceNodes.push({
    nodeId: 'c'.repeat(64),
    resultDigest: 'd'.repeat(64),
  });
  const reversed = structuredClone(first);
  mixedComponent(reversed).managedProjection.sourceNodes.reverse();
  assert.equal(
    createPlanTarget(first).targetDigest,
    createPlanTarget(reversed).targetDigest,
  );

  const duplicate = structuredClone(first);
  mixedComponent(duplicate).managedProjection.sourceNodes.push(
    structuredClone(
      mixedComponent(duplicate).managedProjection.sourceNodes[0]!,
    ),
  );
  assert.throws(
    () => createPlanTarget(duplicate),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );

  const unicodePaths = planTargetInput();
  unicodePaths.components.push(
    {
      kind: 'policy',
      role: 'policy',
      path: 'workflow/\u00e9-policy',
      name: 'composed-policy',
      version: 1,
      digest: 'c'.repeat(64),
    },
    {
      kind: 'policy',
      role: 'policy',
      path: 'workflow/e\u0301-policy',
      name: 'decomposed-policy',
      version: 1,
      digest: 'd'.repeat(64),
    },
  );
  const reversedUnicodePaths = structuredClone(unicodePaths);
  reversedUnicodePaths.components.reverse();
  assert.equal(
    createPlanTarget(unicodePaths).targetDigest,
    createPlanTarget(reversedUnicodePaths).targetDigest,
  );
});

test('structured target semantics exclude only code-owned runtime metadata', () => {
  const first = planTargetInput();
  structuredComponent(first, 'investigation').value = {
    schemaVersion: 1,
    kind: 'investigation-artifact',
    currentRefs: { sealedInvestigation: DIGESTS.investigationNode },
    nodes: [
      {
        nodeId: DIGESTS.investigationNode,
        resultDigest: DIGESTS.investigationResult,
        runtimeMetadata: {
          elapsedMs: 10,
          pid: 123,
          displayOrder: 1,
        },
      },
    ],
  };
  const runtimeChanged = structuredClone(first);
  const runtimeNode = (
    structuredComponent(runtimeChanged, 'investigation').value as {
      nodes: Array<{ runtimeMetadata: Record<string, number> }>;
    }
  ).nodes[0]!;
  runtimeNode.runtimeMetadata = {
    elapsedMs: 999,
    pid: 456,
    displayOrder: 2,
  };
  assert.equal(
    createPlanTarget(first).targetDigest,
    createPlanTarget(runtimeChanged).targetDigest,
  );

  const semanticChanged = structuredClone(first);
  (
    structuredComponent(semanticChanged, 'investigation').value as {
      currentRefs: { sealedInvestigation: string };
    }
  ).currentRefs.sealedInvestigation = 'f'.repeat(64);
  assert.notEqual(
    createPlanTarget(first).targetDigest,
    createPlanTarget(semanticChanged).targetDigest,
  );
});

test('plan target enforces exact typed closure, ordering, and review exclusion', () => {
  const input = planTargetInput();
  input.components.reverse();
  const target = createPlanTarget(input);

  assert.deepEqual(
    target.components.map(({ role, path }) => [role, path]),
    [...target.components]
      .sort((left, right) =>
        `${left.role}\0${left.path}`.localeCompare(
          `${right.role}\0${right.path}`,
        ),
      )
      .map(({ role, path }) => [role, path]),
  );
  assert.equal(
    target.components.some(({ path }) => path.endsWith('plan-review.json')),
    false,
  );
  assert.equal(JSON.stringify(target).includes('runtimeMetadata'), false);
  assert.equal(Object.isFrozen(target), true);
  assert.equal(Object.isFrozen(target.components), true);

  const missing = planTargetInput();
  missing.components = missing.components.filter(
    (component) => component.role !== 'design',
  );
  assert.throws(
    () => createPlanTarget(missing),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );

  const duplicate = planTargetInput();
  duplicate.components.push(
    structuredClone(authoredComponent(duplicate, 'proposal')),
  );
  assert.throws(
    () => createPlanTarget(duplicate),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );

  const review = planTargetInput();
  review.components.push({
    kind: 'structured-json',
    role: 'plan-review',
    path: 'openspec/changes/demo-change/plan-review.json',
    schemaDigest: DIGESTS.structured,
    value: {},
  } as never);
  assert.throws(
    () => createPlanTarget(review),
    (error) => isWorkflowError(error, 'PLAN_TARGET_INVALID'),
  );
});
