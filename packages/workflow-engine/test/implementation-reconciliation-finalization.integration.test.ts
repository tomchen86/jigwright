import { maintainerManifestOperations } from '../src/composition-root/maintainer-manifest-production.ts';
import { reviewedGeneratedAssets } from '../src/composition-root/planning-provider-authoring-production.ts';
import { productionTaskStrategyExecutionGate } from '../src/composition-root/task-strategy-gate-production.ts';
import { productionChangeRoutingAdmissionReader } from '../src/composition-root/change-routing-observation-production.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  inspectImplementationReconciliation,
  recordImplementationReconciliation,
} from '../src/composition-root/implementation-reconciliation-production.ts';
import {
  completeTask,
  finalizeTask,
} from './support/local-engine-selection-host.ts';
import {
  PLAN_REVIEW_COVERAGE,
  planReviewProviderSubmission,
} from '../src/modules/assurance/plan-review.ts';
import { type PlanReviewSubmission } from '../src/modules/assurance/plan-review-report.ts';

import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  PROVIDER_RUNNER_RESIDUALS,
  type ProviderRunnerReport,
} from '../src/runtime/provider-execution/provider-runner.ts';
import { runProviderWorker } from '../src/entrypoints/worker/provider-worker.ts';
import {
  createPlanningContributionEnvelope,
  createPlanReviewProgressEnvelope,
  getProposeStatus,
  resumePropose,
} from '../src/composition-root/propose-production.ts';
import {
  ledgerIndexPath,
  readLedgerEntry,
  readLedgerIndex,
} from '../src/runtime/storage-journal/semantic-ledger-store.ts';
import { checkSession } from './support/local-engine-selection-host.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import {
  applyChangeRoutingReview,
  prepareChangeRoutingReview,
} from '../src/composition-root/change-routing-production.ts';
import {
  builtInProviderDefinitionSnapshotForTest,
  builtInProviderExecutableIdentityForTest,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';

const CHANGE_ID = 'implementation-reconciliation';
const TARGET = 'src/feature.ts';
const TARGET_CONTENT =
  "export const reconciledValue = 'InitialReconciledValue';\n";

test('all task-finalization paths require and replay exact implementation reconciliation', () => {
  const repository = createReconciliationFixture();
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      CHANGE_ID,
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, TARGET),
      "export const reconciledValue = 'UpdatedReconciledValue';\n",
    );

    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      (error) =>
        isWorkflowError(error, 'IMPLEMENTATION_RECONCILIATION_REQUIRED'),
    );

    const request = inspectImplementationReconciliation(repository, CHANGE_ID);
    assert.equal(request.schemaVersion, 2);
    assert.equal(request.requirementId, 'implementation-reconciliation');
    assert.match(request.requirementDigest, /^[0-9a-f]{64}$/);
    assert.match(request.investigationManifestDigest, /^[0-9a-f]{64}$/);
    assert.equal(request.sessionId, session.sessionId);
    assert.deepEqual(
      request.plannedMutations.map(({ path: targetPath }) => targetPath),
      [TARGET],
    );
    assert.ok(request.changedRanges.length > 0);
    assert.ok(request.termDelta.newTerms.length > 0);
    assert.ok(request.termDelta.affectedGroups.length > 0);
    const submission = exactReconciliationSubmission(request);
    assert.throws(
      () =>
        recordImplementationReconciliation(repository, CHANGE_ID, {
          ...submission,
          termDispositions: [],
        }),
      (error) =>
        isWorkflowError(error, 'IMPLEMENTATION_TERM_DISPOSITION_REQUIRED'),
    );
    const recorded = recordImplementationReconciliation(
      repository,
      CHANGE_ID,
      submission,
    );
    assert.match(recorded.reportId, /^[0-9a-f]{64}$/);
    const ledgerIndex = readLedgerIndex(repository);
    const currentEntryId =
      ledgerIndex.subjects[request.plannedMutations[0]!.subjectId]
        ?.currentEntryId;
    assert.ok(currentEntryId);
    const ledgerEntry = readLedgerEntry(repository, currentEntryId);
    assert.equal(ledgerEntry.subject.path, TARGET);
    assert.equal(
      ledgerEntry.binding.sourceDigest,
      `sha256:${sha256("export const reconciledValue = 'UpdatedReconciledValue';\n")}`,
    );

    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
    );
    satisfyCurrentTaskDiffReview(repository, session.sessionId, TARGET);
    const finished = finalizeTask(repository, session.sessionId);
    assert.ok(finished.stagedPaths.includes(TARGET));
    assert.ok(finished.stagedPaths.includes(ledgerIndexPath()));
    assert.ok(
      finished.stagedPaths.some((candidatePath) =>
        candidatePath.startsWith('workflow/semantic-ledger/objects/'),
      ),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('projected single-pass finalize consumes the same immutable reconciliation record', () => {
  const repository = createReconciliationFixture();
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      CHANGE_ID,
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, TARGET),
      "export const reconciledValue = 'ProjectedReconciledValue';\n",
    );
    recordExactReconciliation(repository);

    const ledgerPath = path.join(repository, ledgerIndexPath());
    const ledgerBytes = fs.readFileSync(ledgerPath, 'utf8');
    fs.writeFileSync(
      ledgerPath,
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'semantic-ledger-index',
        subjects: {},
      })}\n`,
    );
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'IMPLEMENTATION_RECONCILIATION_STALE'),
    );
    fs.writeFileSync(ledgerPath, ledgerBytes);

    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'TASK_DIFF_REVIEW_REQUIRED'),
    );
    satisfyCurrentTaskDiffReview(repository, session.sessionId, TARGET);
    const finalized = finalizeTask(repository, session.sessionId);
    assert.ok(finalized.stagedPaths.includes(TARGET));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('unaccounted ranges and post-record source drift fail closed', () => {
  const repository = createReconciliationFixture();
  try {
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      CHANGE_ID,
      '1.1',
    );
    fs.writeFileSync(
      path.join(repository, TARGET),
      "export const reconciledValue = 'DriftReconciledValue';\n",
    );
    const request = inspectImplementationReconciliation(repository, CHANGE_ID);
    assert.throws(
      () =>
        recordImplementationReconciliation(repository, CHANGE_ID, {
          ...request,
          actualMutations: [],
        }),
      (error) => isWorkflowError(error, 'SEMANTIC_MUTATION_UNACCOUNTED'),
    );

    recordExactReconciliation(repository);
    fs.appendFileSync(
      path.join(repository, TARGET),
      'export const postRecordDrift = true;\n',
    );
    const drifted = inspectImplementationReconciliation(repository, CHANGE_ID);
    assert.throws(
      () =>
        recordImplementationReconciliation(
          repository,
          CHANGE_ID,
          exactReconciliationSubmission(drifted),
        ),
      (error) =>
        isWorkflowError(error, 'IMPLEMENTATION_TERM_ESCALATION_REQUIRED'),
    );
    checkSession(
      maintainerManifestOperations,
      productionTaskStrategyExecutionGate,
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
    );
    assert.throws(
      () => completeTask(repository, session.sessionId),
      (error) => isWorkflowError(error, 'IMPLEMENTATION_RECONCILIATION_STALE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createReconciliationFixture(): string {
  const fixture = driveProposeToDispositions(CHANGE_ID, {
    mainTerm: 'reconciledValue',
    surveyTerm: 'reconciledValue',
    explicitPaths: [TARGET],
    explicitSymbols: ['reconciledValue'],
    authorPlanningProviderBinding: true,
    files: {
      [TARGET]: TARGET_CONTENT,
      'workflow/maintainer-policy.json': fs.readFileSync(
        path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
        'utf8',
      ),
      'workflow/path-roles.json': `${canonicalJson({
        schemaVersion: 1,
        kind: 'path-role-registry',
        roles: { ordinary: ['src/**'] },
      })}\n`,
    },
  });
  const afterDispositions = fixture.submit({
    dispositions: (fixture.output.work?.groups ?? []).map(({ groupId }) => ({
      groupId,
      classification: 'load-bearing' as const,
      rationale: 'The production value is the reviewed mutation target.',
      author: 'codex',
    })),
  });
  const sealed = fixture.submit({
    answers: (afterDispositions.work?.fullBlobManifest ?? []).map(
      ({ manifestEntryId }) => ({
        manifestEntryId,
        why: 'This file owns the reviewed production value.',
        protectedInvariant: 'The exported value remains a valid constant.',
        reviewerQuestion:
          'Does implementation preserve the reviewed constant contract?',
        answer: 'Yes, reconciliation binds the exact changed ranges.',
        semanticAuthor: 'codex',
        readComplete: true as const,
      }),
    ),
  });
  assert.equal(sealed.state, 'awaiting-planning-contribution');
  const materialized = resumePropose(
    fixture.repository,
    CHANGE_ID,
    createPlanningContributionEnvelope(sealed, reconciliationPlanningPayload()),
  );
  assert.equal(materialized.state, 'waiting-for-plan-review');
  const invocationId = materialized.planReview!.invocationId;
  runProviderWorker(fixture.repository, invocationId, {
    runner(input): ProviderRunnerReport {
      return fakePlanReviewRunnerReport(
        input.request,
        planReviewProviderSubmission(noChallengeSubmission()),
        input.invocationDirectory,
      );
    },
  });
  const completed = resumePropose(
    fixture.repository,
    CHANGE_ID,
    createPlanReviewProgressEnvelope(
      getProposeStatus(fixture.repository, fixture.investigationId),
    ),
  );
  assert.equal(completed.state, 'planning-complete');

  const investigation = JSON.parse(
    fs.readFileSync(
      path.join(
        fixture.repository,
        'openspec/changes',
        CHANGE_ID,
        'investigation.json',
      ),
      'utf8',
    ),
  ) as {
    schemaVersion: number;
    manifestDigest: string;
    applicability: {
      kind: string;
      semanticDelta: {
        investigationRequirements: Array<{
          kind?: string;
          requirementId: string;
          reconciliation?: { kind: string; changeId: string };
        }>;
      };
    };
  };
  assert.equal(investigation.schemaVersion, 3);
  assert.match(investigation.manifestDigest, /^[0-9a-f]{64}$/);
  assert.equal(investigation.applicability.kind, 'ordinary');
  const requirement =
    investigation.applicability.semanticDelta.investigationRequirements.filter(
      ({ kind }) => kind === 'implementation-reconciliation-requirement',
    );
  assert.equal(requirement.length, 1);
  assert.equal(requirement[0]!.requirementId, 'implementation-reconciliation');
  assert.equal(
    requirement[0]!.reconciliation?.kind,
    'implementation-reconciliation-requirement',
  );
  assert.equal(requirement[0]!.reconciliation?.changeId, CHANGE_ID);
  const routingReview = prepareChangeRoutingReview(fixture.repository, {
    schemaVersion: 1,
    action: { kind: 'focus', changeId: CHANGE_ID },
  });
  applyChangeRoutingReview(fixture.repository, routingReview);
  git(fixture.repository, ['add', '--', 'openspec/change-lifecycle.json']);
  git(fixture.repository, ['commit', '-m', 'Focus reconciliation fixture']);
  return fixture.repository;
}

function recordExactReconciliation(repository: string): void {
  const request = inspectImplementationReconciliation(repository, CHANGE_ID);
  recordImplementationReconciliation(
    repository,
    CHANGE_ID,
    exactReconciliationSubmission(request),
  );
}

function exactReconciliationSubmission(
  request: ReturnType<typeof inspectImplementationReconciliation>,
) {
  return {
    ...request,
    termDispositions: request.termDelta.affectedGroups.map(({ groupId }) => ({
      groupId,
      classification: 'load-bearing',
      rationale:
        'The new implementation term is part of the reviewed production mutation.',
      author: 'codex',
    })),
    actualMutations: [
      {
        subjectId: request.plannedMutations[0]!.subjectId,
        disposition: 'existing-subject-changed',
        whatChanged: 'The planned production value changed.',
        whyChanged: 'The implementation now fulfils the reviewed plan.',
        preservedInvariants: request.plannedMutations[0]!.invariantsToPreserve,
        removedInvariants: [],
        ranges: request.changedRanges,
      },
    ],
  };
}

function reconciliationPlanningPayload() {
  return {
    proposal: '# Proposal\n\nBind implementation changes to reviewed intent.\n',
    design: [
      '# Design',
      '',
      'The engine reconciles every production range before completion.',
      '',
      '## Investigation Ledger',
      '',
      '<!-- workflow:investigation-ledger:start v1 -->',
      '',
      '<!-- workflow:investigation-ledger:end v1 -->',
      '',
    ].join('\n'),
    specs: [
      {
        path: 'specs/demo/spec.md',
        content: [
          '# Delta',
          '',
          '## ADDED Requirements',
          '',
          '### Requirement: Implementation reconciliation',
          '',
          'The system SHALL reconcile reviewed intent with exact implementation ranges.',
          '',
          '#### Scenario: A production range is unexplained',
          '',
          '- **WHEN** implementation changes an unexplained production range',
          '- **THEN** task completion is blocked',
          '',
        ].join('\n'),
      },
    ],
    tasks: '# Tasks\n\n- [ ] 1.1 Reconcile implementation ranges\n',
    guard: {
      schemaVersion: 1 as const,
      changeId: CHANGE_ID,
      tasks: {
        '1.1': {
          allowedPaths: [TARGET],
          requiredChecks: ['fixture'],
        },
      },
    },
    executionTasks: {
      '1.1': {
        strategy: 'direct-reviewed' as const,
        enforcement: 'available' as const,
        allowedPaths: [TARGET],
        requiredChecks: ['fixture'],
        diffReview: 'policy-required' as const,
        exemptionKind: 'narrowly-scoped-non-behavioral' as const,
        exemptionReason:
          'The fixture exercises workflow reconciliation without product behavior.',
      },
    },
  };
}

function noChallengeSubmission(): PlanReviewSubmission {
  return {
    schemaVersion: 2,
    verdict: 'advisory-approve',
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'repository-location',
          path: TARGET,
          line: 1,
          observation: 'The exact production mutation target was reviewed.',
        },
        {
          kind: 'planning-location',
          path: `openspec/changes/${CHANGE_ID}/proposal.md`,
          line: 1,
          observation: 'The reviewed proposal requires exact reconciliation.',
        },
      ],
    },
    findings: [],
    proposedTerms: [],
    suggestions: [],
    residualRisk:
      'Task checks still determine whether implementation is correct.',
    uncertainty:
      'The reviewer cannot prove runtime behavior from planning artifacts.',
  };
}

function fakePlanReviewRunnerReport(
  request: ProviderInvocationRequest,
  semanticOutput: unknown,
  invocationDirectory: string,
): ProviderRunnerReport {
  const runtime = path.join(invocationDirectory, 'runtime');
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const [name, content] of [
    ['prompt.json', '{}\n'],
    ['schema.json', '{}\n'],
    ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
  ] as const) {
    fs.writeFileSync(path.join(runtime, name), content, { mode: 0o600 });
  }
  return {
    invocationId: request.invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
    assurance: 'unchanged-governed-projection',
    projection: {
      unchanged: true,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false,
    residuals: [...PROVIDER_RUNNER_RESIDUALS],
    executable: builtInProviderExecutableIdentityForTest(request.providerId),
    elapsedMs: 5,
    providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
      request.providerId,
    ),
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
