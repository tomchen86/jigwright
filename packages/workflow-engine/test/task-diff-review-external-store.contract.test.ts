import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { investigationRuntimePaths } from '../src/runtime/paths/runtime-paths.ts';
import {
  assertTaskDiffExternalReviewStoreInventory,
  createTaskDiffExternalChallengeResponse,
  createTaskDiffExternalClosureSubmission,
  createTaskDiffExternalReviewSubmission,
  listTaskDiffExternalContinuationReservations,
  listTaskDiffExternalReviewReservations,
  listTaskDiffExternalReviewBindings,
  createTaskDiffExternalContinuationBinding,
  createTaskDiffExternalContinuationReservation,
  createTaskDiffExternalReviewBinding,
  createTaskDiffExternalReviewReservation,
  readTaskDiffExternalChallengeResponse,
  readTaskDiffExternalClosureSubmission,
  readTaskDiffExternalReviewSubmission,
  readTaskDiffExternalContinuationBinding,
  readTaskDiffExternalContinuationReservation,
  readTaskDiffExternalReviewBinding,
  readTaskDiffExternalReviewReservation,
  taskDiffExternalContinuationBindingPath,
  taskDiffExternalContinuationReservationPath,
  taskDiffExternalChallengeResponsePath,
  taskDiffExternalClosureSubmissionPath,
  taskDiffExternalReviewSubmissionPath,
  taskDiffExternalReviewBindingPath,
  taskDiffExternalReviewReservationPath,
} from '../src/runtime/storage-journal/task-diff-review-external-store.ts';
import {
  prepareTaskDiffExternalContinuationBinding,
  prepareTaskDiffExternalContinuationReservation,
  prepareTaskDiffExternalReviewBinding,
  prepareTaskDiffExternalReviewReservation,
  taskDiffExternalContinuationTargetDigest,
} from '../src/modules/assurance/task-diff-external-authority.ts';
import {
  prepareTaskDiffExternalChallengeResponse,
  prepareTaskDiffExternalClosureSubmission,
  prepareTaskDiffExternalReviewSubmission,
} from '../src/modules/assurance/task-diff-external-content.ts';
import type { TaskDiffReviewContinuationSubmission } from '../src/modules/assurance/task-diff-review-artifact-record.ts';
import { deriveTaskDiffReviewCandidatePlan } from '../src/modules/assurance/task-diff-review.ts';
import {
  reviewSubject,
  challengeResponse,
  reviewSubmission,
  grantReference,
  implementationActor,
  digest,
  hasCode,
} from './support/task-diff-external-record-fixture.ts';

test('external review reservation and binding are session-free exact authority references', () => {
  for (const degradedForm of [
    'caller-supplied',
    'direct-human-review',
  ] as const) {
    const fixture = createStoreFixture();
    try {
      const subject = reviewSubject(degradedForm);
      assert.equal(fs.existsSync(fixture.paths.root), false);
      const plan = deriveTaskDiffReviewCandidatePlan({ current: subject });
      assert.equal(plan.action, 'review');
      if (plan.action !== 'review') throw new Error('expected review scope');
      const submission = createTaskDiffExternalReviewSubmission(fixture.paths, {
        subject,
        reviewScope: plan.scope,
        submission: reviewSubmission(subject),
        inputDigest: digest(`${degradedForm}:review-input`),
      });
      const reservationInput = {
        subject,
        policyDigest: subject.reviewPolicyDigest,
        inputDigest: digest(`${degradedForm}:review-input`),
        reviewScopeDigest: plan.scope.scopeDigest,
        submissionRecordDigest: submission.recordDigest,
        contentNodeId: digest(`${degradedForm}:review-node`),
        contentResultDigest: digest(`${degradedForm}:review-result`),
        implementationActor: implementationActor(),
        grant: grantReference(degradedForm, 'review', subject.subjectDigest),
      };
      const prepared =
        prepareTaskDiffExternalReviewReservation(reservationInput);
      const stored = createTaskDiffExternalReviewReservation(
        fixture.paths,
        reservationInput,
      );
      assert.deepEqual(stored, prepared);
      assert.deepEqual(
        createTaskDiffExternalReviewReservation(
          fixture.paths,
          reservationInput,
        ),
        stored,
      );
      assert.deepEqual(
        readTaskDiffExternalReviewReservation(
          fixture.paths,
          subject.subjectDigest,
          reservationInput.grant.grantEnvelopeDigest,
        ),
        stored,
      );
      const replacement = createTaskDiffExternalReviewReservation(
        fixture.paths,
        {
          ...reservationInput,
          grant: {
            ...reservationInput.grant,
            grantId:
              degradedForm === 'caller-supplied'
                ? '00000000-0000-4000-8000-000000000011'
                : '00000000-0000-4000-8000-000000000012',
            grantEnvelopeDigest: digest(`${degradedForm}:replacement-envelope`),
          },
        },
      );
      assert.equal(
        replacement.grant.grantTransitionDigest,
        stored.grant.grantTransitionDigest,
      );
      assert.notEqual(
        replacement.grant.grantEnvelopeDigest,
        stored.grant.grantEnvelopeDigest,
      );
      assert.equal(
        listTaskDiffExternalReviewReservations(
          fixture.paths,
          subject.subjectDigest,
        ).length,
        2,
      );
      assert.throws(
        () =>
          createTaskDiffExternalReviewReservation(fixture.paths, {
            ...reservationInput,
            inputDigest: digest('conflicting-review-input'),
          }),
        hasCode('TASK_DIFF_EXTERNAL_REVIEW_RESERVATION_CONFLICT'),
      );

      const bindingInput = {
        reservation: stored,
        grantUseDigest: digest(`${degradedForm}:grant-use`),
        admittedRoleResultDigest: digest(`${degradedForm}:role-result`),
        directHumanReviewAttestationDigest:
          degradedForm === 'direct-human-review'
            ? digest('direct-human-review-attestation')
            : null,
        contentNodeId: stored.contentNodeId,
        contentResultDigest: stored.contentResultDigest,
        authorityNodeId: digest(`${degradedForm}:authority-node`),
        authorityResultDigest: digest(`${degradedForm}:authority-result`),
        reviewRecordDigest: digest(`${degradedForm}:review-record`),
      };
      const preparedBinding =
        prepareTaskDiffExternalReviewBinding(bindingInput);
      const binding = createTaskDiffExternalReviewBinding(
        fixture.paths,
        bindingInput,
      );
      assert.deepEqual(binding, preparedBinding);
      assert.deepEqual(
        createTaskDiffExternalReviewBinding(fixture.paths, bindingInput),
        binding,
      );
      assert.deepEqual(
        readTaskDiffExternalReviewBinding(fixture.paths, subject.subjectDigest),
        binding,
      );
      assert.deepEqual(listTaskDiffExternalReviewBindings(fixture.paths), [
        binding,
      ]);
      assert.throws(
        () =>
          createTaskDiffExternalReviewBinding(fixture.paths, {
            ...bindingInput,
            reviewRecordDigest: digest('conflicting-review-record'),
          }),
        hasCode('TASK_DIFF_EXTERNAL_REVIEW_BINDING_CONFLICT'),
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('challenge continuation uses a second subject/review/response target without closure semantics', () => {
  const fixture = createStoreFixture();
  try {
    const subject = reviewSubject('continuation');
    const reviewRecordDigest = digest('review-record');
    const responseDigest = digest('challenge-response');
    const targetDigest = taskDiffExternalContinuationTargetDigest({
      subjectDigest: subject.subjectDigest,
      reviewRecordDigest,
      responseDigest,
    });
    const inputDigest = digest('continuation-advisory-input');
    createTaskDiffExternalClosureSubmission(fixture.paths, {
      subject,
      submission: {
        schemaVersion: 1,
        reviewRecordDigest,
        responseDigest,
        proposedDispositions: [
          {
            challengeId: digest('continuation-challenge'),
            decision: 'rebutted',
            rationale: 'The exact response rebuts the advisory challenge.',
            supersededBy: null,
          },
        ],
      },
      inputDigest,
    });

    const reservationInput = {
      subject,
      policyDigest: subject.reviewPolicyDigest,
      reviewRecordDigest,
      responseDigest,
      inputDigest,
      contentNodeId: digest('continuation-node'),
      contentResultDigest: digest('continuation-result'),
      grant: grantReference(
        'direct-human-review',
        'continuation',
        targetDigest,
      ),
    };
    const prepared =
      prepareTaskDiffExternalContinuationReservation(reservationInput);
    assert.equal(prepared.targetDigest, targetDigest);
    assert.equal(prepared.contentNodeId, reservationInput.contentNodeId);
    assert.equal(
      prepared.contentResultDigest,
      reservationInput.contentResultDigest,
    );
    const reservation = createTaskDiffExternalContinuationReservation(
      fixture.paths,
      reservationInput,
    );
    assert.deepEqual(reservation, prepared);
    assert.deepEqual(
      readTaskDiffExternalContinuationReservation(
        fixture.paths,
        targetDigest,
        reservationInput.grant.grantEnvelopeDigest,
      ),
      reservation,
    );
    assert.deepEqual(
      listTaskDiffExternalContinuationReservations(fixture.paths, targetDigest),
      [reservation],
    );

    const bindingInput = {
      reservation,
      grantUseDigest: digest('continuation-grant-use'),
      admittedRoleResultDigest: digest('continuation-role-result'),
      directHumanReviewAttestationDigest: digest(
        'continuation-human-attestation',
      ),
      contentNodeId: reservation.contentNodeId,
      contentResultDigest: reservation.contentResultDigest,
      authorityNodeId: digest('continuation-authority-node'),
      authorityResultDigest: digest('continuation-authority-result'),
    };
    const preparedBinding =
      prepareTaskDiffExternalContinuationBinding(bindingInput);
    const binding = createTaskDiffExternalContinuationBinding(
      fixture.paths,
      bindingInput,
    );
    assert.deepEqual(binding, preparedBinding);
    assert.deepEqual(
      readTaskDiffExternalContinuationBinding(fixture.paths, targetDigest),
      binding,
    );
  } finally {
    fixture.dispose();
  }
});

test('external challenge responses are immutable complete content keyed by exact review and subject', () => {
  const fixture = createStoreFixture();
  try {
    const subject = reviewSubject('challenge-response');
    const response = challengeResponse(subject, 'challenge-response');
    const input = { subject, response };
    const prepared = prepareTaskDiffExternalChallengeResponse(input);

    assert.equal(fs.existsSync(fixture.paths.root), false);
    const stored = createTaskDiffExternalChallengeResponse(
      fixture.paths,
      input,
    );
    assert.deepEqual(stored, prepared);
    assert.deepEqual(
      createTaskDiffExternalChallengeResponse(fixture.paths, input),
      stored,
    );
    assert.deepEqual(
      readTaskDiffExternalChallengeResponse(
        fixture.paths,
        subject.subjectDigest,
        response.reviewRecordDigest,
        response.responseDigest,
      ),
      stored,
    );
    assert.throws(
      () =>
        readTaskDiffExternalChallengeResponse(
          fixture.paths,
          digest('wrong-subject'),
          response.reviewRecordDigest,
          response.responseDigest,
        ),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
    );

    const conflicting = challengeResponse(subject, 'conflicting-response', {
      reviewRecordDigest: response.reviewRecordDigest,
    });
    const replacement = createTaskDiffExternalChallengeResponse(fixture.paths, {
      subject,
      response: conflicting,
    });
    assert.notEqual(replacement.recordDigest, stored.recordDigest);
    assert.deepEqual(
      readTaskDiffExternalChallengeResponse(
        fixture.paths,
        subject.subjectDigest,
        conflicting.reviewRecordDigest,
        conflicting.responseDigest,
      ),
      replacement,
    );
    assert.throws(
      () =>
        readTaskDiffExternalChallengeResponse(
          fixture.paths,
          subject.subjectDigest,
          response.reviewRecordDigest,
        ),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
    );
    fs.writeFileSync(
      taskDiffExternalChallengeResponsePath(
        fixture.paths,
        response.reviewRecordDigest,
        response.responseDigest,
      ),
      `${canonicalJson({ ...stored, unexpectedAuthority: true })}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () => assertTaskDiffExternalReviewStoreInventory(fixture.paths),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
    );
  } finally {
    fixture.dispose();
  }
});

test('external closure submissions persist exact advisory content without authority', () => {
  const fixture = createStoreFixture();
  try {
    const subject = reviewSubject('closure-submission');
    const reviewRecordDigest = digest('closure-review-record');
    const responseDigest = digest('closure-response');
    const targetDigest = taskDiffExternalContinuationTargetDigest({
      subjectDigest: subject.subjectDigest,
      reviewRecordDigest,
      responseDigest,
    });
    const submission: TaskDiffReviewContinuationSubmission = {
      schemaVersion: 1,
      reviewRecordDigest,
      responseDigest,
      proposedDispositions: [
        {
          challengeId: digest('closure-challenge'),
          decision: 'rebutted',
          rationale: 'The exact response rebuts the advisory challenge.',
          supersededBy: null,
        },
      ],
    };
    const inputDigest = digest('closure-input');
    const input = { subject, submission, inputDigest };
    const prepared = prepareTaskDiffExternalClosureSubmission(input);

    const stored = createTaskDiffExternalClosureSubmission(
      fixture.paths,
      input,
    );
    assert.deepEqual(stored, prepared);
    assert.deepEqual(
      createTaskDiffExternalClosureSubmission(fixture.paths, input),
      stored,
    );
    assert.deepEqual(
      readTaskDiffExternalClosureSubmission(
        fixture.paths,
        targetDigest,
        inputDigest,
      ),
      stored,
    );
    assert.throws(
      () =>
        createTaskDiffExternalClosureSubmission(fixture.paths, {
          ...input,
          submission: {
            ...submission,
            proposedDispositions: submission.proposedDispositions.map(
              (entry) => ({ ...entry, decision: 'accepted' as const }),
            ),
          },
        }),
      hasCode('TASK_DIFF_EXTERNAL_CLOSURE_SUBMISSION_CONFLICT'),
    );
  } finally {
    fixture.dispose();
  }
});

test('external review submissions preserve replacement inputs for the same subject and scope without authority poisoning', () => {
  const fixture = createStoreFixture();
  try {
    const subject = reviewSubject('review-submission');
    const plan = deriveTaskDiffReviewCandidatePlan({ current: subject });
    assert.equal(plan.action, 'review');
    if (plan.action !== 'review') throw new Error('expected review scope');
    const inputA = {
      subject,
      reviewScope: plan.scope,
      submission: reviewSubmission(subject),
      inputDigest: digest('review-submission-input-a'),
    };
    const preparedA = prepareTaskDiffExternalReviewSubmission(inputA);

    assert.equal(fs.existsSync(fixture.paths.root), false);
    assert.equal(preparedA.subjectDigest, subject.subjectDigest);
    assert.equal(preparedA.reviewScopeDigest, plan.scope.scopeDigest);
    assert.deepEqual(preparedA.reviewScope, plan.scope);
    assert.deepEqual(preparedA.submission, inputA.submission);
    assert.equal(preparedA.inputDigest, inputA.inputDigest);
    for (const forbidden of [
      'grant',
      'participant',
      'provider',
      'session',
      'createdat',
      'closure',
    ]) {
      assert.equal(
        Object.keys(preparedA).join(' ').toLowerCase().includes(forbidden),
        false,
      );
    }

    const storedA = createTaskDiffExternalReviewSubmission(
      fixture.paths,
      inputA,
    );
    assert.deepEqual(storedA, preparedA);
    assert.deepEqual(
      createTaskDiffExternalReviewSubmission(fixture.paths, inputA),
      storedA,
    );
    assert.deepEqual(
      readTaskDiffExternalReviewSubmission(
        fixture.paths,
        subject.subjectDigest,
        plan.scope.scopeDigest,
        inputA.inputDigest,
      ),
      storedA,
    );
    const inputB = {
      ...inputA,
      inputDigest: digest('review-submission-input-b'),
      submission: {
        ...inputA.submission,
        residualRisk: 'Replacement review B has independently bound content.',
      },
    };
    const storedB = createTaskDiffExternalReviewSubmission(
      fixture.paths,
      inputB,
    );
    assert.notEqual(storedB.recordDigest, storedA.recordDigest);
    assert.deepEqual(
      readTaskDiffExternalReviewSubmission(
        fixture.paths,
        subject.subjectDigest,
        plan.scope.scopeDigest,
        inputB.inputDigest,
      ),
      storedB,
    );
    assert.throws(
      () =>
        readTaskDiffExternalReviewSubmission(
          fixture.paths,
          subject.subjectDigest,
          plan.scope.scopeDigest,
        ),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
    );
    assert.throws(
      () =>
        prepareTaskDiffExternalReviewSubmission({
          ...inputA,
          reviewScope: {
            ...plan.scope,
            currentSubjectDigest: digest('wrong-subject'),
          },
        }),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
    );
  } finally {
    fixture.dispose();
  }
});

test('external binding requires its exact durable reservation and rejects cross-lineage publication', () => {
  const fixture = createStoreFixture();
  try {
    const subject = reviewSubject('lineage');
    const plan = deriveTaskDiffReviewCandidatePlan({ current: subject });
    assert.equal(plan.action, 'review');
    if (plan.action !== 'review') throw new Error('expected review scope');
    const submission = createTaskDiffExternalReviewSubmission(fixture.paths, {
      subject,
      reviewScope: plan.scope,
      submission: reviewSubmission(subject),
      inputDigest: digest('lineage-input'),
    });
    const reservation = prepareTaskDiffExternalReviewReservation({
      subject,
      policyDigest: subject.reviewPolicyDigest,
      inputDigest: digest('lineage-input'),
      reviewScopeDigest: plan.scope.scopeDigest,
      submissionRecordDigest: submission.recordDigest,
      contentNodeId: digest('lineage-node'),
      contentResultDigest: digest('lineage-result'),
      implementationActor: implementationActor(),
      grant: grantReference(
        'caller-supplied',
        'lineage',
        subject.subjectDigest,
      ),
    });
    const bindingInput = {
      reservation,
      grantUseDigest: digest('lineage-grant-use'),
      admittedRoleResultDigest: digest('lineage-role-result'),
      directHumanReviewAttestationDigest: null,
      contentNodeId: reservation.contentNodeId,
      contentResultDigest: reservation.contentResultDigest,
      authorityNodeId: digest('lineage-authority-node'),
      authorityResultDigest: digest('lineage-authority-result'),
      reviewRecordDigest: digest('lineage-review'),
    };
    assert.throws(
      () => createTaskDiffExternalReviewBinding(fixture.paths, bindingInput),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
    );

    createTaskDiffExternalReviewReservation(fixture.paths, {
      subject,
      policyDigest: subject.reviewPolicyDigest,
      inputDigest: digest('lineage-input'),
      reviewScopeDigest: plan.scope.scopeDigest,
      submissionRecordDigest: submission.recordDigest,
      contentNodeId: digest('lineage-node'),
      contentResultDigest: digest('lineage-result'),
      implementationActor: implementationActor(),
      grant: grantReference(
        'caller-supplied',
        'lineage',
        subject.subjectDigest,
      ),
    });
    assert.throws(
      () =>
        createTaskDiffExternalReviewBinding(fixture.paths, {
          ...bindingInput,
          reservation: {
            ...reservation,
            reservationDigest: digest('unrelated-reservation'),
          },
        }),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
    );
  } finally {
    fixture.dispose();
  }
});

test('external store inventory rejects malformed names, symlinks, and non-exact records', () => {
  for (const corruption of [
    'malformed-name',
    'symlink',
    'extra-key',
  ] as const) {
    const fixture = createStoreFixture();
    try {
      const subject = reviewSubject(corruption);
      const plan = deriveTaskDiffReviewCandidatePlan({ current: subject });
      assert.equal(plan.action, 'review');
      if (plan.action !== 'review') throw new Error('expected review scope');
      const submission = createTaskDiffExternalReviewSubmission(fixture.paths, {
        subject,
        reviewScope: plan.scope,
        submission: reviewSubmission(subject),
        inputDigest: digest(`${corruption}:input`),
      });
      const input = {
        subject,
        policyDigest: subject.reviewPolicyDigest,
        inputDigest: digest(`${corruption}:input`),
        reviewScopeDigest: plan.scope.scopeDigest,
        submissionRecordDigest: submission.recordDigest,
        contentNodeId: digest(`${corruption}:review-node`),
        contentResultDigest: digest(`${corruption}:review-result`),
        implementationActor: implementationActor(),
        grant: grantReference(
          'caller-supplied',
          corruption,
          subject.subjectDigest,
        ),
      };
      const reservation = createTaskDiffExternalReviewReservation(
        fixture.paths,
        input,
      );
      const directory = path.dirname(
        taskDiffExternalReviewReservationPath(
          fixture.paths,
          subject.subjectDigest,
          input.grant.grantEnvelopeDigest,
        ),
      );
      if (corruption === 'malformed-name') {
        fs.writeFileSync(
          path.join(directory, 'not-a-digest.json'),
          `${canonicalJson(reservation)}\n`,
          { mode: 0o600 },
        );
      } else if (corruption === 'symlink') {
        fs.symlinkSync(
          taskDiffExternalReviewReservationPath(
            fixture.paths,
            subject.subjectDigest,
            input.grant.grantEnvelopeDigest,
          ),
          path.join(
            directory,
            `${digest('symlink')}.${input.grant.grantEnvelopeDigest}.json`,
          ),
        );
      } else {
        fs.writeFileSync(
          taskDiffExternalReviewReservationPath(
            fixture.paths,
            subject.subjectDigest,
            input.grant.grantEnvelopeDigest,
          ),
          `${canonicalJson({ ...reservation, unexpected: true })}\n`,
          { mode: 0o600 },
        );
      }
      assert.throws(
        () => assertTaskDiffExternalReviewStoreInventory(fixture.paths),
        hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
      );
    } finally {
      fixture.dispose();
    }
  }
});

test('all external store paths are digest-keyed and phase-separated', () => {
  const fixture = createStoreFixture();
  try {
    const subjectDigest = digest('path-subject');
    const continuationDigest = digest('path-continuation');
    const transitionDigest = digest('path-transition');
    const scopeDigest = digest('path-scope');
    assert.match(
      taskDiffExternalReviewReservationPath(
        fixture.paths,
        subjectDigest,
        transitionDigest,
      ),
      /review-reservations\/[0-9a-f]{64}\.[0-9a-f]{64}\.json$/,
    );
    assert.match(
      taskDiffExternalReviewBindingPath(fixture.paths, subjectDigest),
      /review-bindings\/[0-9a-f]{64}\.json$/,
    );
    assert.match(
      taskDiffExternalContinuationReservationPath(
        fixture.paths,
        continuationDigest,
        transitionDigest,
      ),
      /continuation-reservations\/[0-9a-f]{64}\.[0-9a-f]{64}\.json$/,
    );
    assert.match(
      taskDiffExternalContinuationBindingPath(
        fixture.paths,
        continuationDigest,
      ),
      /continuation-bindings\/[0-9a-f]{64}\.json$/,
    );
    assert.match(
      taskDiffExternalChallengeResponsePath(
        fixture.paths,
        continuationDigest,
        transitionDigest,
      ),
      /responses\/[0-9a-f]{64}\.[0-9a-f]{64}\.json$/,
    );
    assert.match(
      taskDiffExternalClosureSubmissionPath(
        fixture.paths,
        continuationDigest,
        transitionDigest,
      ),
      /closure-submissions\/[0-9a-f]{64}\.[0-9a-f]{64}\.json$/,
    );
    assert.match(
      taskDiffExternalReviewSubmissionPath(
        fixture.paths,
        subjectDigest,
        scopeDigest,
      ),
      /submissions\/[0-9a-f]{64}\.[0-9a-f]{64}\.json$/,
    );
  } finally {
    fixture.dispose();
  }
});

function createStoreFixture() {
  const base = fs.mkdtempSync(
    path.join(os.tmpdir(), 'task-diff-external-review-store-'),
  );
  return {
    paths: investigationRuntimePaths(base, 'workflow-engine'),
    dispose() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
