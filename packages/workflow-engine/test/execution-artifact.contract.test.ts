import test from 'node:test';
import {
  createFixtureRepository,
  writeManagedChangeArtifacts,
} from './fixture.ts';
import assert from 'node:assert/strict';
import {
  parseExecutionArtifact,
  loadChangeContract,
  parsePlanReviewArtifact,
} from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import path from 'node:path';
import fs from 'node:fs';
import {
  buildCurrentV3Investigation,
  publishCurrentV3Investigation,
  isWorkflowError,
} from './support/current-contract-fixture.ts';

test('engine artifact validators reject noncanonical, forged, over-keyed, and scope-expanding inputs', () => {
  const repository = createFixtureRepository();
  try {
    const { investigation, execution, planReview } =
      writeManagedChangeArtifacts(repository);
    const currentInvestigation = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, currentInvestigation).outcome,
      'published',
    );
    assert.deepEqual(
      parseExecutionArtifact(
        execution,
        'demo-change',
        loadChangeContract(repository, 'demo-change').tasks,
        loadChangeContract(repository, 'demo-change').guard,
        loadChangeContract(repository, 'demo-change').checks,
        loadChangeContract(repository, 'demo-change').behaviorContracts,
      ),
      execution,
    );
    assert.deepEqual(
      parsePlanReviewArtifact(planReview, 'demo-change'),
      planReview,
    );

    assert.throws(
      () =>
        parsePlanReviewArtifact(
          { ...planReview, changeId: 'another-change' },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_PLAN_REVIEW_ARTIFACT'),
    );
    assert.throws(
      () =>
        parsePlanReviewArtifact(
          {
            ...planReview,
            currentRefs: { planReview: '9'.repeat(64) },
          },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_PLAN_REVIEW_ARTIFACT'),
    );
    const expandedExecution = structuredClone(execution);
    expandedExecution.tasks['1.1']!.allowedPaths = ['outside/**'];
    const contract = loadChangeContract(repository, 'demo-change');
    assert.throws(
      () =>
        parseExecutionArtifact(
          expandedExecution,
          'demo-change',
          contract.tasks,
          contract.guard,
          contract.checks,
          contract.behaviorContracts,
        ),
      (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
    );

    const investigationPath = path.join(
      repository,
      'openspec/changes/demo-change/investigation.json',
    );
    fs.writeFileSync(
      investigationPath,
      `${JSON.stringify(investigation, null, 2)}\n`,
    );
    assert.throws(
      () => loadChangeContract(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('execution artifacts use one exact strategy variant per task without claiming execution', () => {
  const repository = createFixtureRepository();
  try {
    writeManagedChangeArtifacts(repository);
    const currentInvestigation = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, currentInvestigation).outcome,
      'published',
    );
    const contract = loadChangeContract(repository, 'demo-change');
    const common = {
      enforcement: 'planned' as const,
      allowedPaths: ['src/**'],
      requiredChecks: ['fixture'],
      diffReview: 'required' as const,
    };
    const transformationContract = {
      rule: 'Rename the reviewed symbol exactly.',
      examples: [{ before: 'OLD_NAME', after: 'NEW_NAME' }],
      fileScopes: ['src/features/**'],
      oldTerms: [{ kind: 'symbol' as const, value: 'OLD_NAME' }],
      replacementTerms: [{ kind: 'symbol' as const, value: 'NEW_NAME' }],
      retainedDispositions: [],
      redInapplicableReason:
        'Exact-byte closure and registered checks specify this codemod.',
    };
    const variants = [
      {
        ...common,
        strategy: 'cross-agent-tdd' as const,
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: null,
          },
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Demo succeeds',
          },
        ],
        testPathScopes: ['src/__tests__/**'],
        fixturePathScopes: ['src/__tests__/fixtures/**'],
        implementationPathScopes: ['src/features/**'],
        redCheck: 'fixture',
        greenChecks: ['fixture'],
        requiredImplementerIndependence: 'session-independent' as const,
      },
      {
        ...common,
        strategy: 'mechanical-transform' as const,
        transformationContract,
      },
      {
        ...common,
        strategy: 'direct-reviewed' as const,
        exemptionKind: 'documentation-only' as const,
        exemptionReason: 'Only authored documentation changes.',
      },
      {
        ...common,
        strategy: 'tdd-single-agent' as const,
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Demo succeeds',
          },
        ],
        testPathScopes: ['src/__tests__/**'],
        fixturePathScopes: ['src/__tests__/fixtures/**'],
        implementationPathScopes: ['src/features/**'],
        redCheck: 'fixture',
        greenChecks: ['fixture'],
        requiredImplementerIndependence: 'none' as const,
      },
    ];

    for (const task of variants) {
      const artifact = {
        schemaVersion: 1 as const,
        kind: 'execution-artifact' as const,
        changeId: 'demo-change',
        tasks: { '1.1': task },
      };
      assert.deepEqual(
        parseExecutionArtifact(
          artifact,
          'demo-change',
          contract.tasks,
          contract.guard,
          contract.checks,
          contract.behaviorContracts,
        ),
        artifact,
      );
    }

    const invalid = [
      {
        ...variants[0],
        strategy: 'unknown-strategy',
      },
      {
        ...variants[1],
        exemptionReason: 'mixed union branch',
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          examples: [],
        },
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          fileScopes: ['outside/**'],
        },
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          replacementTerms: [],
        },
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          replacementTerms: [{ kind: 'symbol' as const, value: 'OLD_NAME' }],
        },
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          retainedDispositions: [
            {
              term: { kind: 'symbol' as const, value: 'OLD_NAME' },
              path: 'outside/reference.md',
              mutationClass: 'live' as const,
              reason:
                'A live residual cannot be dispositioned outside mutation authority.',
            },
          ],
        },
      },
      {
        ...variants[2],
        requiredChecks: ['unregistered'],
      },
      {
        ...variants[2],
        allowedPaths: [],
      },
      {
        ...variants[2],
        exemptionKind: 'legacy-bootstrap',
        legacyBootstrap: 'establish-investigation-first-planning',
      },
      {
        ...variants[0],
        enforcement: 'available',
      },
      {
        ...variants[1],
        enforcement: 'available',
      },
      {
        ...variants[0],
        behaviorContractRefs: ['specs/demo/spec.md#demo'],
      },
      {
        ...variants[0],
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Missing behavior',
            scenario: null,
          },
        ],
      },
      {
        ...variants[0],
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Missing scenario',
          },
        ],
      },
      {
        ...variants[0],
        implementationPathScopes: ['src/__tests__/fixtures/**'],
      },
      {
        ...variants[0],
        testPathScopes: ['outside/**'],
      },
      {
        ...variants[0],
        requiredImplementerIndependence: 'none',
      },
      {
        ...variants[3],
        requiredImplementerIndependence: 'session-independent',
      },
    ];
    for (const task of invalid) {
      assert.throws(
        () =>
          parseExecutionArtifact(
            {
              schemaVersion: 1,
              kind: 'execution-artifact',
              changeId: 'demo-change',
              tasks: { '1.1': task },
            },
            'demo-change',
            contract.tasks,
            contract.guard,
            contract.checks,
            contract.behaviorContracts,
          ),
        (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
      );
    }
    assert.throws(
      () =>
        parseExecutionArtifact(
          {
            schemaVersion: 1,
            kind: 'execution-artifact',
            changeId: 'demo-change',
            tasks: {},
          },
          'demo-change',
          [],
          { schemaVersion: 1, changeId: 'demo-change', tasks: {} },
          contract.checks,
          contract.behaviorContracts,
        ),
      (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
    );

    const overbroadBootstrap = {
      schemaVersion: 1 as const,
      kind: 'execution-artifact' as const,
      changeId: 'establish-investigation-first-planning',
      tasks: {
        '1.1': {
          ...variants[2],
          exemptionKind: 'legacy-bootstrap' as const,
          legacyBootstrap: 'establish-investigation-first-planning' as const,
        },
      },
    };
    assert.throws(
      () =>
        parseExecutionArtifact(
          overbroadBootstrap,
          overbroadBootstrap.changeId,
          contract.tasks,
          contract.guard,
          contract.checks,
          contract.behaviorContracts,
        ),
      (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
    );

    const bootstrapTasks = [
      { id: '6.8', completed: true, title: 'Activate the schema.' },
      { id: '7.1', completed: false, title: 'Adopt the schema.' },
    ];
    const bootstrapGuard = {
      schemaVersion: 1 as const,
      changeId: 'establish-investigation-first-planning',
      tasks: {
        '6.8': {
          allowedPaths: ['src/**'],
          requiredChecks: ['fixture'],
        },
        '7.1': {
          allowedPaths: ['src/**'],
          requiredChecks: ['fixture'],
        },
      },
    };
    const bootstrapExecution = {
      schemaVersion: 1 as const,
      kind: 'execution-artifact' as const,
      changeId: 'establish-investigation-first-planning',
      tasks: {
        '6.8': variants[2],
        '7.1': {
          ...variants[2],
          exemptionKind: 'legacy-bootstrap' as const,
          exemptionReason:
            'Adopt the named pre-T2 plan under its reviewed bootstrap.',
          legacyBootstrap: 'establish-investigation-first-planning' as const,
        },
      },
    };
    for (const tasks of [
      bootstrapTasks,
      bootstrapTasks.map((task) => ({ ...task, completed: true })),
    ]) {
      assert.throws(
        () =>
          parseExecutionArtifact(
            bootstrapExecution,
            bootstrapExecution.changeId,
            tasks,
            bootstrapGuard,
            contract.checks,
            contract.behaviorContracts,
          ),
        (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
