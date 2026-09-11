import assert from 'node:assert/strict';
import test from 'node:test';
import {
  processProviderFailureRetry,
  publishReplacement,
} from '../src/application/provider-retry/provider-failure-retry.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import { BLIND_SURVEY_OUTPUT_SCHEMA } from '../src/modules/provider-orchestration/blind-survey-output.ts';
import type { ProviderInvocationRecord } from '../src/modules/provider-orchestration/provider-invocation-record.ts';
import type {
  ProviderFailureRetryPorts,
  ProviderRetryPublication,
} from '../src/modules/provider-orchestration/provider-retry-service-port.ts';
import type { ProviderAutomaticRetrySchedule } from '../src/modules/provider-orchestration/provider-retry-schedule.ts';
import type { RetryDecision } from '../src/modules/provider-orchestration/execution-core.ts';
import type { ConsumedPlanReviewReplayPort } from '../src/modules/assurance/planning-assurance-validator.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';

const now = '2026-08-03T08:00:00.000Z';
const hasCode = (code: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === code;

function fixture(purpose: ProviderInvocationRecord['purpose'] = 'survey') {
  const request = createProviderInvocationRequest({
    invocationId: 'invocation-failed',
    nonce: 'invocation-failed-nonce-000000',
    purpose,
    providerId: 'claude',
    roleAssignment: {
      role:
        purpose === 'task-implementation'
          ? 'task-implementer'
          : purpose === 'task-diff-review'
            ? 'task-diff-reviewer'
            : 'plan-reviewer',
      providerId: 'claude',
      sessionId: 'provider-session-retry',
      targetDigest: '1'.repeat(64),
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: 'fixture',
    baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40),
    targetDigest: '1'.repeat(64),
    inputManifestDigest: '3'.repeat(64),
    authorizationNodeId: '4'.repeat(64),
    writeAllowedPaths: [],
    outputSchema: BLIND_SURVEY_OUTPUT_SCHEMA,
    evaluatorVersion: 'blind-survey.v1',
    policyDigest: '5'.repeat(64),
    limits: { timeoutMs: 1000, aggregateOutputBytes: 4096 },
  });
  const failed: ProviderInvocationRecord = {
    schemaVersion: 1,
    invocationId: request.invocationId,
    investigationId: 'investigation-retry',
    changeId: 'demo-change',
    attempt: 1,
    revision: 2,
    state: 'failed',
    providerId: request.providerId,
    purpose,
    requestDigest: request.requestDigest,
    manifestDigest: request.inputManifestDigest,
    leaseGeneration: 1,
    lease: null,
    result: null,
    failure: {
      kind: 'retryable',
      code: 'NETWORK_TRANSIENT',
      message: 'Network interrupted.',
    },
    createdAt: now,
    updatedAt: now,
  };
  const events: string[] = [];
  const schedule = {
    route: 'provider-replacement',
    state: 'scheduled',
    notBefore: now,
    failedInvocationId: failed.invocationId,
  } as ProviderAutomaticRetrySchedule;
  const state = {
    existing: null as ProviderAutomaticRetrySchedule | null,
    reservation: null as {
      previousInvocationId: string;
      invocationId: string;
    } | null,
    decision: undefined as RetryDecision | undefined,
    publicationError: null as Error | null,
    planReviewInvocationId: 'invocation-review-next' as string | undefined,
    surveyAttempt: 2,
    forwardedReplay: undefined as ConsumedPlanReviewReplayPort | undefined,
  };
  const publication: ProviderRetryPublication = {
    readSurveyReservation(record) {
      assert.equal(record, failed);
      events.push('reservation');
      return state.reservation;
    },
    readSurveyInput() {
      events.push('survey-input');
      return {
        request,
        revision: 7,
        policyDigest: '6'.repeat(64),
        limits: { timeoutMs: 2000, aggregateOutputBytes: 8192 },
        identity: 'replacement-identity',
      };
    },
    publishSurvey(record, revision, replacement) {
      events.push('survey-publish');
      if (state.publicationError) throw state.publicationError;
      assert.equal(record, failed);
      assert.equal(revision, 7);
      assert.equal(
        replacement.inputManifestDigest,
        request.inputManifestDigest,
      );
      assert.equal(
        replacement.authorizationNodeId,
        request.authorizationNodeId,
      );
      assert.equal(replacement.policyDigest, '6'.repeat(64));
      assert.deepEqual(replacement.limits, {
        timeoutMs: 2000,
        aggregateOutputBytes: 8192,
      });
      assert.ok(replacement.retryExplanation);
      return {
        invocationId: replacement.invocationId,
        attempt: state.surveyAttempt,
      };
    },
    publishPlanReview(record, replay) {
      events.push('review-publish');
      assert.equal(record, failed);
      state.forwardedReplay = replay;
      if (state.publicationError) throw state.publicationError;
      return state.planReviewInvocationId;
    },
  };
  const ports: ProviderFailureRetryPorts = {
    runtime: {
      readSchedule(id) {
        assert.equal(id, failed.invocationId);
        events.push('schedule');
        return state.existing;
      },
      readFailure() {
        events.push('failure');
        return { failed, request };
      },
      persistProbe() {
        events.push('persist-probe');
        return { ...schedule, route: 'environment-probe' };
      },
      persistReplacement(record, jobId, id, createdAt) {
        events.push('persist-replacement');
        assert.equal(record, failed);
        assert.match(jobId, /^job-provider-/);
        assert.equal(createdAt, now);
        assert.notEqual(id, failed.invocationId);
        return schedule;
      },
      continueSchedule(value, time) {
        events.push('continue');
        assert.equal(value, schedule);
        assert.equal(time, now);
        return { kind: 'replacement-scheduled', schedule: value };
      },
    },
    inspectDecision() {
      events.push('decision');
      return state.decision;
    },
    publication,
  };
  return { request, failed, events, schedule, state, ports, publication };
}

test('existing durable schedule bypasses lifecycle publication and failure reads', () => {
  const f = fixture();
  f.state.existing = f.schedule;
  assert.equal(
    processProviderFailureRetry(f.ports, f.failed.invocationId, { now }).kind,
    'replacement-scheduled',
  );
  assert.deepEqual(f.events, ['schedule', 'continue']);
});

test('Survey routes through the exact owner then persists and continues the replacement', () => {
  const f = fixture();
  assert.equal(
    processProviderFailureRetry(f.ports, f.failed.invocationId, { now }).kind,
    'replacement-scheduled',
  );
  assert.deepEqual(f.events, [
    'schedule',
    'failure',
    'decision',
    'reservation',
    'survey-input',
    'survey-publish',
    'persist-replacement',
    'continue',
  ]);
});

test('matching Survey reservation replays its identity without publishing or rereading inputs', () => {
  const f = fixture();
  f.state.reservation = {
    previousInvocationId: f.failed.invocationId,
    invocationId: 'invocation-existing',
  };
  assert.equal(
    publishReplacement(f.publication, f.failed),
    'invocation-existing',
  );
  assert.deepEqual(f.events, ['reservation']);
  f.state.reservation.previousInvocationId = 'different';
  assert.throws(
    () => publishReplacement(f.publication, f.failed),
    hasCode('PROVIDER_RETRY_SCHEDULE_UNSAFE'),
  );
});

test('PlanReview uses its owner with the exact consumed-role replay port', () => {
  const f = fixture('plan-review');
  const replay = {} as ConsumedPlanReviewReplayPort;
  assert.equal(
    processProviderFailureRetry(f.ports, f.failed.invocationId, {
      now,
      consumedRoleResultReplay: replay,
    }).kind,
    'replacement-scheduled',
  );
  assert.equal(f.state.forwardedReplay, replay);
  assert.deepEqual(f.events, [
    'schedule',
    'failure',
    'decision',
    'review-publish',
    'persist-replacement',
    'continue',
  ]);
});

for (const purpose of ['task-diff-review', 'task-implementation'] as const) {
  test(`${purpose} never enters Survey or PlanReview replacement publication`, () => {
    const f = fixture(purpose);
    const result = processProviderFailureRetry(f.ports, f.failed.invocationId, {
      now,
    });
    assert.equal(result.kind, 'decision-denied');
    assert.deepEqual(f.events, ['schedule', 'failure']);
  });
}

test('a lifecycle retry refusal re-observes the decision without persisting a schedule', () => {
  const f = fixture('plan-review');
  f.state.publicationError = workflowError(
    'PLAN_REVIEW_RETRY_GRANT_REQUIRED',
    'Grant needed.',
    ExitCode.guard,
  );
  const result = processProviderFailureRetry(f.ports, f.failed.invocationId, {
    now,
  });
  assert.equal(result.kind, 'decision-denied');
  assert.deepEqual(f.events, [
    'schedule',
    'failure',
    'decision',
    'review-publish',
    'decision',
  ]);
});

test('unrelated lifecycle failures propagate without publishing a retry schedule', () => {
  const f = fixture('plan-review');
  const error = new Error('unexpected');
  f.state.publicationError = error;
  assert.throws(
    () => processProviderFailureRetry(f.ports, f.failed.invocationId, { now }),
    (caught) => caught === error,
  );
  assert.deepEqual(f.events, [
    'schedule',
    'failure',
    'decision',
    'review-publish',
  ]);
});

test('publisher must return a new PlanReview identity and exactly the next Survey attempt', () => {
  const review = fixture('plan-review');
  review.state.planReviewInvocationId = review.failed.invocationId;
  assert.throws(
    () => publishReplacement(review.publication, review.failed),
    hasCode('PROVIDER_RETRY_SCHEDULE_UNSAFE'),
  );
  const survey = fixture();
  survey.state.surveyAttempt = 3;
  assert.throws(
    () => publishReplacement(survey.publication, survey.failed),
    hasCode('PROVIDER_RETRY_SCHEDULE_UNSAFE'),
  );
});
