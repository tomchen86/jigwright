import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import * as durableBindings from '../src/modules/assurance/task-diff-review-binding-codec.ts';
import {
  bindingInputs,
  goldenRecords,
} from './support/task-diff-review-binding-fixture.ts';
import {
  createTaskDiffReviewReservation,
  createTaskDiffReviewResultBinding,
  createTaskDiffFinalAssuranceBinding,
  createTaskDiffReviewLineageSupersession,
  taskDiffReviewReservationPath,
  taskDiffReviewResultPath,
  taskDiffReviewContinuationReservationPath,
  taskDiffReviewContinuationResultPath,
  taskDiffFinalAssurancePath,
  taskDiffReviewLineageSupersessionPath,
} from '../src/runtime/storage-journal/task-diff-review-store.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  createTaskDiffReviewChallengeResponse,
  createTaskDiffReviewRecord,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import {
  createTaskDiffReviewContinuationReservation,
  createTaskDiffReviewContinuationResultBinding,
  listAllTaskDiffReviewContinuationReservations,
  listAllTaskDiffReviewContinuationResultBindings,
  listAllTaskDiffReviewReservations,
  listAllTaskDiffReviewResultBindings,
} from '../src/runtime/storage-journal/task-diff-review-store.ts';
import {
  createTaskDiffReviewSubject,
  deriveTaskDiffReviewCandidatePlan,
  TASK_DIFF_REVIEW_COVERAGE,
} from '../src/modules/assurance/task-diff-review.ts';

test('all six actual stores preserve golden wire bytes and canonical pure records', () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-diff-binding-store-'),
  );
  const paths = investigationRuntimePaths(base, 'workflow-engine');
  const input = bindingInputs();
  try {
    const cases = [
      {
        name: 'reservation',
        create: () => createTaskDiffReviewReservation(paths, input.reservation),
        prepare: () =>
          durableBindings.prepareTaskDiffReviewReservation(input.reservation),
        target: taskDiffReviewReservationPath(
          paths,
          input.reservation.sessionId,
          input.reservation.subject.subjectDigest,
        ),
      },
      {
        name: 'result',
        create: () => createTaskDiffReviewResultBinding(paths, input.result),
        prepare: () =>
          durableBindings.prepareTaskDiffReviewResultBinding(input.result),
        target: taskDiffReviewResultPath(
          paths,
          input.result.sessionId,
          input.result.subjectDigest,
        ),
      },
      {
        name: 'continuationReservation',
        create: () =>
          createTaskDiffReviewContinuationReservation(
            paths,
            input.continuationReservation,
          ),
        prepare: () =>
          durableBindings.prepareTaskDiffReviewContinuationReservation(
            input.continuationReservation,
          ),
        target: taskDiffReviewContinuationReservationPath(
          paths,
          input.continuationReservation.sessionId,
          input.continuationReservation.review.recordDigest,
        ),
      },
      {
        name: 'continuationResult',
        create: () =>
          createTaskDiffReviewContinuationResultBinding(
            paths,
            input.continuationResult,
          ),
        prepare: () =>
          durableBindings.prepareTaskDiffReviewContinuationResultBinding(
            input.continuationResult,
          ),
        target: taskDiffReviewContinuationResultPath(
          paths,
          input.continuationResult.sessionId,
          input.continuationResult.reviewRecordDigest,
        ),
      },
      {
        name: 'finalAssurance',
        create: () =>
          createTaskDiffFinalAssuranceBinding(paths, input.finalAssurance),
        prepare: () =>
          durableBindings.prepareTaskDiffFinalAssuranceBinding(
            input.finalAssurance,
          ),
        target: taskDiffFinalAssurancePath(
          paths,
          input.finalAssurance.subjectDigest,
        ),
      },
      {
        name: 'supersession',
        create: () =>
          createTaskDiffReviewLineageSupersession(paths, input.supersession),
        prepare: () =>
          durableBindings.prepareTaskDiffReviewLineageSupersession(
            input.supersession,
          ),
        target: taskDiffReviewLineageSupersessionPath(
          paths,
          input.supersession.predecessorReview.recordDigest,
        ),
      },
    ] as const;
    for (const entry of cases) {
      const created = entry.create();
      assert.deepEqual(created, entry.prepare());
      const bytes = fs.readFileSync(entry.target, 'utf8');
      assert.deepEqual(JSON.parse(bytes), created);
      assert.equal(digest(bytes), goldenRecords[entry.name].wireSha256);
      assert.equal(fs.statSync(entry.target).mode & 0o777, 0o600);
      const mtimeMs = fs.statSync(entry.target).mtimeMs;
      assert.deepEqual(entry.create(), created);
      assert.equal(fs.readFileSync(entry.target, 'utf8'), bytes);
      assert.equal(fs.statSync(entry.target).mtimeMs, mtimeMs);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('provider continuation inventory spans sessions and excludes exact global namespaces', () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-diff-review-store-'),
  );
  const paths = investigationRuntimePaths(base, 'workflow-engine');
  try {
    const second = createContinuation(paths, 'session-b', 'b');
    const first = createContinuation(paths, 'session-a', 'a');
    for (const namespace of [
      'external-authority',
      'final-assurance',
      'lineage-supersessions',
    ]) {
      fs.mkdirSync(path.join(paths.refs, 'task-diff-reviews', namespace), {
        recursive: true,
        mode: 0o700,
      });
    }

    assert.deepEqual(listAllTaskDiffReviewContinuationReservations(paths), [
      first.reservation,
      second.reservation,
    ]);
    assert.deepEqual(listAllTaskDiffReviewContinuationResultBindings(paths), [
      first.binding,
      second.binding,
    ]);
    assert.deepEqual(listAllTaskDiffReviewReservations(paths), []);
    assert.deepEqual(listAllTaskDiffReviewResultBindings(paths), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('provider continuation rejects the superseded output schema identity', () => {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-diff-review-store-'),
  );
  const paths = investigationRuntimePaths(base, 'workflow-engine');
  try {
    assert.throws(
      () =>
        createContinuation(
          paths,
          'session-superseded',
          'superseded',
          'expense-app.workflow.task-diff-review-continuation-output',
        ),
      (error: unknown) =>
        error instanceof Error &&
        'code' in error &&
        (error as Error & { code: string }).code ===
          'TASK_DIFF_REVIEW_STORE_UNSAFE',
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

function createContinuation(
  paths: ReturnType<typeof investigationRuntimePaths>,
  sessionId: string,
  seed: string,
  outputSchemaId: string = TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id,
) {
  const subject = createTaskDiffReviewSubject({
    repositoryId: 'github:tomchen86/expense-app',
    changeId: 'demo-change',
    taskId: '1.1',
    baseCommit: 'a'.repeat(40),
    baseTree: 'b'.repeat(40),
    candidateTree: digest(`${seed}:candidate`).slice(0, 40),
    transitions: [
      {
        path: `src/${seed}.ts`,
        before: null,
        after: {
          mode: '100644',
          objectId: digest(`${seed}:after`).slice(0, 40),
        },
      },
    ],
    taskContractDigest: digest('task-contract'),
    requiredCheckPolicyDigest: digest('check-policy'),
    checkEvidenceDigest: digest(`${seed}:checks`),
    planningGenerationId: digest('planning-generation'),
    planTargetDigest: digest('plan-target'),
    planReviewNodeId: digest('plan-review'),
    planningAssuranceDigest: digest('planning-assurance'),
    reviewRequirement: {
      required: true,
      basis: 'explicit',
      riskPaths: [],
    },
  });
  const plan = deriveTaskDiffReviewCandidatePlan({ current: subject });
  if (plan.action !== 'review') throw new Error('review expected');
  const evidence = {
    kind: 'repository-location' as const,
    path: `src/${seed}.ts`,
    line: 1,
    blobObjectId: subject.transitions[0]!.after!.objectId,
    observation: 'The exact candidate requires one challenge response.',
  };
  const review = createTaskDiffReviewRecord({
    subject,
    reviewScope: plan.scope,
    assignment: {
      implementerPrincipalId: 'provider:codex',
      implementerProviderId: 'codex',
      implementationSessionId: `${sessionId}-implementation`,
      reviewerPrincipalId: 'provider:claude',
      reviewerProviderId: 'claude',
      reviewerSessionId: `${sessionId}-review`,
      achievedIndependence: 'provider-independent',
      degradedForm: null,
      grantUseDigest: null,
    },
    submission: {
      schemaVersion: 1,
      verdict: 'advisory-reject',
      coverage: [...TASK_DIFF_REVIEW_COVERAGE],
      scopeAssessment: { kind: 'challenges' },
      findings: [
        {
          kind: 'challenge',
          severity: 'high',
          category: 'correctness-and-invariants',
          currentChangeImpact: 'required',
          summary: 'The exact candidate needs a bounded correction.',
          evidence: [evidence],
        },
      ],
      suggestions: [],
      riskPathDispositions: [],
      residualRisk: 'The challenge remains open.',
      uncertainty: 'Review is bound to this exact subject.',
    },
  });
  const challenge = review.challenges[0]!;
  const response = createTaskDiffReviewChallengeResponse({
    review,
    responses: [
      {
        challengeId: challenge.challengeId,
        rationale: 'The exact evidence rebuts the challenge.',
        evidence: [
          {
            kind: 'planning-node',
            nodeId: digest(`${seed}:response-node`),
            resultDigest: digest(`${seed}:response-result`),
            observation: 'The correction is bound to the reviewed subject.',
          },
        ],
      },
    ],
  });
  const continuationSessionId = `${sessionId}-continuation`;
  const assignment = {
    role: 'task-diff-reviewer' as const,
    providerId: 'claude' as const,
    sessionId: continuationSessionId,
    targetDigest: subject.subjectDigest,
    requiredIndependence: 'provider-independent' as const,
    achievedIndependence: 'provider-independent' as const,
  };
  const manifest = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-continuation-manifest' as const,
    changeId: subject.changeId,
    taskId: subject.taskId,
    sessionId,
    repositoryId: 'expense-app',
    repositoryIdentity: subject.repositoryId,
    baseCommit: subject.baseCommit,
    baseTree: subject.baseTree,
    subject,
    review,
    response,
    capabilityProfile: 'repository-read-only' as const,
  };
  const request = createProviderInvocationRequest({
    invocationId: `invocation-continuation-${seed}`,
    nonce: `continuation-${seed}-nonce-000000`,
    purpose: 'task-diff-review',
    providerId: 'claude',
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only',
    repositoryId: 'expense-app',
    baseCommit: subject.baseCommit,
    baseTree: subject.baseTree,
    targetDigest: subject.subjectDigest,
    inputManifestDigest: digest(manifest),
    authorizationNodeId: digest(`${seed}:authorization`),
    writeAllowedPaths: [],
    outputSchema: {
      ...TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
      id: outputSchemaId,
    },
    evaluatorVersion: 'task-diff-review-continuation.v1',
    policyDigest: subject.reviewPolicyDigest,
    limits: { timeoutMs: 60_000, aggregateOutputBytes: 262_144 },
  });
  const reservation = createTaskDiffReviewContinuationReservation(paths, {
    ownerInvestigationId: `investigation-continuation-${seed}`,
    sessionId,
    changeId: subject.changeId,
    taskId: subject.taskId,
    repositoryRoot: paths.base,
    gitCommonDirectory: paths.base,
    branch: 'work/demo-change',
    baseline: { head: subject.baseCommit, tree: subject.baseTree },
    mandateBinding: null,
    subject,
    implementationActor: {
      providerId: 'codex',
      sessionId,
      principalId: 'provider:codex',
      identityAssurance: 'self-declared',
      engineSpawned: false,
    },
    review,
    response,
    manifest,
    request,
    authorizationNodeId: request.authorizationNodeId,
    reservationNodeId: digest(`${seed}:reservation-node`),
    createdAt: '2026-08-13T00:00:00.000Z',
  });
  const binding = createTaskDiffReviewContinuationResultBinding(paths, {
    ownerInvestigationId: reservation.ownerInvestigationId,
    sessionId,
    subjectDigest: subject.subjectDigest,
    reviewRecordDigest: review.recordDigest,
    responseDigest: response.responseDigest,
    invocationId: request.invocationId,
    requestDigest: request.requestDigest,
    outputDigest: digest(`${seed}:output`),
    runtimeObservationDigest: digest(`${seed}:observation`),
    providerResultNodeId: digest(`${seed}:result-node`),
    providerResultDigest: digest(`${seed}:result`),
    submission: {
      schemaVersion: 1,
      reviewRecordDigest: review.recordDigest,
      responseDigest: response.responseDigest,
      proposedDispositions: [
        {
          challengeId: challenge.challengeId,
          decision: 'rebutted',
          rationale: 'The exact response rebuts the challenge.',
          supersededBy: null,
        },
      ],
    },
    createdAt: '2026-08-13T00:01:00.000Z',
  });
  return { reservation, binding };
}

function digest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJson(value))
    .digest('hex');
}
