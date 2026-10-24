import assert from 'node:assert/strict';
import test from 'node:test';
import {
  prepareTaskDiffExternalReviewReservation,
  prepareTaskDiffExternalReviewBinding,
  prepareTaskDiffExternalContinuationReservation,
  prepareTaskDiffExternalContinuationBinding,
  parseTaskDiffExternalReviewReservation,
  parseTaskDiffExternalReviewBinding,
  parseTaskDiffExternalContinuationReservation,
  parseTaskDiffExternalContinuationBinding,
  taskDiffExternalContinuationTargetDigest,
  reviewBindingMatchesReservation,
  continuationBindingMatchesReservation,
} from '../src/modules/assurance/task-diff-external-authority.ts';
import {
  prepareTaskDiffExternalReviewSubmission,
  prepareTaskDiffExternalChallengeResponse,
  prepareTaskDiffExternalClosureSubmission,
  parseTaskDiffExternalReviewSubmission,
  parseTaskDiffExternalChallengeResponse,
  parseTaskDiffExternalClosureSubmission,
} from '../src/modules/assurance/task-diff-external-content.ts';
import type { TaskDiffExternalDegradedForm } from '../src/modules/assurance/task-diff-external-record.ts';
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

// Captured from a507839 before moving the original runtime implementations.
const expectedDigests = {
  'caller-supplied': [
    'bb6c77284edbac08c0879fb96543ccf385075a81d697007dcd196a92ad980c65',
    '2d44a34bd81d9f5448f4bde488fe1d528e5cccb4b5a26b04ec99d09562ae81fb',
    'f08cabd66dcad0352826b96f60e426a6599bce7f2fc44a8f3aecdc1ace5c8ad6',
    '00334cf17e33cf2534ccefe26db6c3634b5ee1672eebcfd31cb0750bd70c26d8',
    '5c94901152b9cb93b58181f5e53ca03673fe3a921f4deefb35aaa158665b89c4',
    'c3d1d7f7aa2a7ee9ea3c05b826dac4ad44f3f89fd7d923f3086d04b09c1d8f9d',
    '6c8971d4d4a44868c6a43a7b5ded1d89ed076fc834bde75363a48478e2624f97',
  ],
  'direct-human-review': [
    '04b882dce719362b3db0d0bf30430cd5b2aef538780f371c74d8befde8ee6d19',
    'be813e398196d8a78b10a14636fe248ec62621d2256cc36f88785e48c4879293',
    '6cadce77fd5ab54020e0c2fa09ecbbb3d0debb8cce3373d74b33672d8f3ad667',
    '517b3fef1e9c2b02f81a2a0c67f128cae42e2a3ef40cc9bc93f34fb021e5b88b',
    'c10622817cf05d509ccaa9699c1f396ea87a70ba6c8a0b7bbedc0bdf1d0f582f',
    '7adc9dc9710f699e466ba618e0f8ac40c6ade48481caed0e01937ce580509dbd',
    '6e4d597013d19d77a02faa3f5d4f1937f421ec1e123c8316b4336f4215f6fd39',
  ],
} as const;

for (const form of ['caller-supplied', 'direct-human-review'] as const) {
  test(`${form}: seven external record formats retain canonical digests and reject additional authority`, () => {
    const records = prepareRecords(form);
    const entries: readonly [
      Record<string, unknown>,
      (value: unknown) => unknown,
      string,
    ][] = [
      [
        records.submission,
        parseTaskDiffExternalReviewSubmission,
        'recordDigest',
      ],
      [
        records.reservation,
        parseTaskDiffExternalReviewReservation,
        'reservationDigest',
      ],
      [records.binding, parseTaskDiffExternalReviewBinding, 'bindingDigest'],
      [
        records.response,
        parseTaskDiffExternalChallengeResponse,
        'recordDigest',
      ],
      [records.closure, parseTaskDiffExternalClosureSubmission, 'recordDigest'],
      [
        records.continuation,
        parseTaskDiffExternalContinuationReservation,
        'reservationDigest',
      ],
      [
        records.continuationBinding,
        parseTaskDiffExternalContinuationBinding,
        'bindingDigest',
      ],
    ];
    assert.deepEqual(
      entries.map(([record, , key]) => record[key]),
      expectedDigests[form],
    );
    for (const [record, parse, key] of entries) {
      assert.deepEqual(parse(JSON.parse(JSON.stringify(record))), record);
      assertDeeplyFrozen(record);
      assert.throws(
        () => parse(redigest(record, key, { unexpectedAuthority: true })),
        hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
      );
      assert.throws(
        () => parse({ ...record, [key]: digest('wrong-record-digest') }),
        hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
      );
    }
    assert.equal(
      records.reservation.targetDigest,
      records.reservation.subject.subjectDigest,
    );
    for (const forbidden of [
      'sessionId',
      'createdAt',
      'expiresAt',
      'generation',
      'providerId',
    ]) {
      assert.equal(forbidden in records.reservation, false);
    }
    assert.equal(
      records.binding.admittedRoleResultDigest,
      records.bindingInput.admittedRoleResultDigest,
    );
    assert.equal(
      records.binding.directHumanReviewAttestationDigest,
      records.bindingInput.directHumanReviewAttestationDigest,
    );
  });

  test(`${form}: attestation requirements apply to both initial and continuation bindings`, () => {
    const records = prepareRecords(form);
    const invalidAttestation =
      form === 'direct-human-review'
        ? null
        : digest('caller-cannot-claim-attestation');
    assert.throws(
      () =>
        prepareTaskDiffExternalReviewBinding({
          ...records.bindingInput,
          directHumanReviewAttestationDigest: invalidAttestation,
        }),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
    );
    assert.throws(
      () =>
        prepareTaskDiffExternalContinuationBinding({
          ...records.continuationBindingInput,
          directHumanReviewAttestationDigest: invalidAttestation,
        }),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
    );
  });
}

test('recomputed digests cannot make reservation policy or targets disagree with their subject and Grant', () => {
  const { reservation, continuation } = prepareRecords('caller-supplied');
  for (const [record, parse] of [
    [reservation, parseTaskDiffExternalReviewReservation],
    [continuation, parseTaskDiffExternalContinuationReservation],
  ] as const) {
    for (const changes of [
      { policyDigest: digest('other-policy') },
      { subjectDigest: digest('other-subject') },
      { targetDigest: digest('other-target') },
      {
        grant: {
          ...record.grant,
          grantTargetDigest: digest('other-grant-target'),
        },
      },
    ]) {
      assert.throws(
        () => parse(redigest(record, 'reservationDigest', changes)),
        hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
      );
    }
  }
  assert.throws(
    () =>
      parseTaskDiffExternalContinuationReservation(
        redigest(continuation, 'reservationDigest', {
          responseDigest: digest('different-response'),
        }),
      ),
    hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
  );
});

test('a structurally valid binding still requires its exact reservation lineage', () => {
  const { reservation, binding, continuation, continuationBinding } =
    prepareRecords('direct-human-review');
  assert.equal(reviewBindingMatchesReservation(binding, reservation), true);
  assert.equal(
    continuationBindingMatchesReservation(continuationBinding, continuation),
    true,
  );
  for (const field of [
    'reservationDigest',
    'inputDigest',
    'contentNodeId',
    'contentResultDigest',
  ] as const) {
    const changedReview = parseTaskDiffExternalReviewBinding(
      redigest(binding, 'bindingDigest', {
        [field]: digest(`changed-${field}`),
      }),
    );
    const changedContinuation = parseTaskDiffExternalContinuationBinding(
      redigest(continuationBinding, 'bindingDigest', {
        [field]: digest(`changed-${field}`),
      }),
    );
    assert.equal(
      reviewBindingMatchesReservation(changedReview, reservation),
      false,
    );
    assert.equal(
      continuationBindingMatchesReservation(changedContinuation, continuation),
      false,
    );
  }
  const changedGrant = {
    ...binding.grant,
    grantEnvelopeDigest: digest('replacement-envelope'),
  };
  assert.equal(
    reviewBindingMatchesReservation(
      parseTaskDiffExternalReviewBinding(
        redigest(binding, 'bindingDigest', { grant: changedGrant }),
      ),
      reservation,
    ),
    false,
  );
});

test('external content and continuation contribution carry no closure authority', () => {
  // Independently computed from sorted canonical JSON with stdlib SHA-256.
  assert.equal(
    taskDiffExternalContinuationTargetDigest({
      subjectDigest: '0'.repeat(64),
      reviewRecordDigest: '1'.repeat(64),
      responseDigest: '2'.repeat(64),
    }),
    'd5785d615b309acd7b7568024edf6c76645fd1342d0b0f5a6176b49b56e13d58',
  );
  const { submission, response, closure, continuationBinding } =
    prepareRecords('caller-supplied');
  assert.deepEqual(response.response.subjectDigest, response.subjectDigest);
  assert.equal(
    response.response.reviewRecordDigest,
    response.reviewRecordDigest,
  );
  assert.equal(response.response.responseDigest, response.responseDigest);
  for (const content of [submission, response, closure]) {
    for (const forbidden of [
      'grant',
      'grantUseDigest',
      'authorityNodeId',
      'admittedRoleResultDigest',
      'finalAssurance',
    ]) {
      assert.equal(forbidden in content, false);
    }
  }
  for (const forbidden of [
    'verdict',
    'disposition',
    'accepted',
    'closed',
    'finalAssurance',
  ]) {
    assert.equal(forbidden in continuationBinding, false);
    assert.throws(
      () =>
        parseTaskDiffExternalContinuationBinding(
          redigest(continuationBinding, 'bindingDigest', { [forbidden]: true }),
        ),
      hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
    );
  }
  assert.equal(
    closure.submission.proposedDispositions[0]!.decision,
    'rebutted',
  );
  assert.equal(closure.targetDigest, continuationBinding.targetDigest);
  assert.notEqual(closure.targetDigest, closure.subjectDigest);
  assert.notEqual(
    closure.targetDigest,
    taskDiffExternalContinuationTargetDigest({
      ...closure,
      responseDigest: digest('changed-response'),
    }),
  );
  assert.throws(
    () =>
      prepareTaskDiffExternalChallengeResponse({
        subject: reviewSubject('wrong-subject'),
        response: response.response,
      }),
    hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
  );
  assert.throws(
    () =>
      parseTaskDiffExternalClosureSubmission(
        redigest(closure, 'recordDigest', {
          reviewRecordDigest: digest('different-review'),
        }),
      ),
    hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
  );
  assert.throws(
    () =>
      parseTaskDiffExternalReviewSubmission(
        redigest(submission, 'recordDigest', {
          reviewScopeDigest: digest('different-scope'),
        }),
      ),
    hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
  );
  assert.throws(
    () =>
      parseTaskDiffExternalChallengeResponse(
        redigest(response, 'recordDigest', {
          responseDigest: digest('different-response'),
        }),
      ),
    hasCode('TASK_DIFF_EXTERNAL_REVIEW_STATE_INVALID'),
  );
});

function prepareRecords(form: TaskDiffExternalDegradedForm) {
  const subject = reviewSubject(form);
  const plan = deriveTaskDiffReviewCandidatePlan({ current: subject });
  assert.equal(plan.action, 'review');
  if (plan.action !== 'review') throw new Error('expected review scope');
  const submission = prepareTaskDiffExternalReviewSubmission({
    subject,
    reviewScope: plan.scope,
    submission: reviewSubmission(subject),
    inputDigest: digest('review-input'),
  });
  const reservation = prepareTaskDiffExternalReviewReservation({
    subject,
    policyDigest: subject.reviewPolicyDigest,
    inputDigest: submission.inputDigest,
    reviewScopeDigest: submission.reviewScopeDigest,
    submissionRecordDigest: submission.recordDigest,
    contentNodeId: digest('review-node'),
    contentResultDigest: digest('review-result'),
    implementationActor: implementationActor(),
    grant: grantReference(form, 'review', subject.subjectDigest),
  });
  const bindingInput = {
    reservation,
    grantUseDigest: digest('review-use'),
    admittedRoleResultDigest: digest('review-role-result'),
    directHumanReviewAttestationDigest:
      form === 'direct-human-review' ? digest('review-attestation') : null,
    contentNodeId: reservation.contentNodeId,
    contentResultDigest: reservation.contentResultDigest,
    authorityNodeId: digest('review-authority-node'),
    authorityResultDigest: digest('review-authority-result'),
    reviewRecordDigest: digest('review-record'),
  };
  const binding = prepareTaskDiffExternalReviewBinding(bindingInput);
  const response = prepareTaskDiffExternalChallengeResponse({
    subject,
    response: challengeResponse(subject, 'response', {
      reviewRecordDigest: binding.reviewRecordDigest,
    }),
  });
  const closure = prepareTaskDiffExternalClosureSubmission({
    subject,
    submission: {
      schemaVersion: 1,
      reviewRecordDigest: response.reviewRecordDigest,
      responseDigest: response.responseDigest,
      proposedDispositions: [
        {
          challengeId: response.response.responses[0]!.challengeId,
          decision: 'rebutted',
          rationale: 'The exact response rebuts the advisory challenge.',
          supersededBy: null,
        },
      ],
    },
    inputDigest: digest('closure-input'),
  });
  const continuation = prepareTaskDiffExternalContinuationReservation({
    subject,
    policyDigest: subject.reviewPolicyDigest,
    reviewRecordDigest: response.reviewRecordDigest,
    responseDigest: response.responseDigest,
    inputDigest: closure.inputDigest,
    contentNodeId: digest('closure-node'),
    contentResultDigest: digest('closure-result'),
    grant: grantReference(form, 'continuation', closure.targetDigest),
  });
  const continuationBindingInput = {
    reservation: continuation,
    grantUseDigest: digest('closure-use'),
    admittedRoleResultDigest: digest('closure-role-result'),
    directHumanReviewAttestationDigest:
      form === 'direct-human-review' ? digest('closure-attestation') : null,
    contentNodeId: continuation.contentNodeId,
    contentResultDigest: continuation.contentResultDigest,
    authorityNodeId: digest('closure-authority-node'),
    authorityResultDigest: digest('closure-authority-result'),
  };
  const continuationBinding = prepareTaskDiffExternalContinuationBinding(
    continuationBindingInput,
  );
  return {
    submission,
    reservation,
    binding,
    response,
    closure,
    continuation,
    continuationBinding,
    bindingInput,
    continuationBindingInput,
  };
}

function redigest(
  value: Record<string, unknown>,
  key: string,
  changes: Record<string, unknown>,
) {
  const body = { ...value, ...changes };
  delete body[key];
  return { ...body, [key]: digest(body) };
}

function assertDeeplyFrozen(value: unknown): void {
  if (value !== null && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) assertDeeplyFrozen(child);
  }
}
