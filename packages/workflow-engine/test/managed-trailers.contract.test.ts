import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';

import {
  ManagedTrailerSyntaxError,
  parseManagedTrailers,
} from '../src/modules/lifecycle/managed-trailers.ts';
import { listRangeCommits } from '../src/entrypoints/ci/ci-git.ts';
import { replayCommitSequence } from '../src/entrypoints/ci/ci-sequence.ts';
import {
  amendPlanCommitMessage,
  amendPlanCommitTrailers,
  archiveCommitMessage,
  authorityCandidateCommitMessage,
  authorityCommitMessage,
  gitAuthorityCandidateApplyCommitMessage,
  managedCommitMessage,
  planningCommitMessage,
  type AmendmentProvenance,
} from '../src/runtime/repository-transaction/git-transitions.ts';
import {
  loadWorkflowConformanceVectors,
  type ManagedMessageConformanceVector,
} from './support/conformance-vectors.ts';
import { createFixtureRepository } from './fixture.ts';

const CENTRAL_CANDIDATE_DIGEST = `sha256:${'a'.repeat(64)}`;
const CENTRAL_APPROVAL_SUBJECT_DIGEST = `sha256:${'b'.repeat(64)}`;
const CENTRAL_PREPARED_GRANT_DIGEST = `sha256:${'c'.repeat(64)}`;
const CENTRAL_CHALLENGE_ID = '11111111-1111-4111-8111-111111111111';
const CENTRAL_OPERATION_ID = '22222222-2222-4222-8222-222222222222';

test('CI parses the exact Central Apply block and rejects pre-cutover replay', () => {
  const repository = createFixtureRepository();
  try {
    const base = git(repository, ['rev-parse', 'HEAD']).trim();
    const message = gitAuthorityCandidateApplyCommitMessage(
      'Grant: Apply exact Central candidate',
      {
        candidateDigest: CENTRAL_CANDIDATE_DIGEST,
        challengeId: CENTRAL_CHALLENGE_ID,
        operationId: CENTRAL_OPERATION_ID,
        approvalSubjectDigest: CENTRAL_APPROVAL_SUBJECT_DIGEST,
        preparedGrantRecordDigest: CENTRAL_PREPARED_GRANT_DIGEST,
      },
    );
    git(repository, ['commit', '--quiet', '--allow-empty', '-m', message]);
    const head = git(repository, ['rev-parse', 'HEAD']).trim();

    const commits = listRangeCommits(repository, base, head);
    assert.deepEqual(commits[0]?.trailers, {
      kind: 'central-authority',
      transition: 'git.authority-candidate.apply.v1',
      candidateDigest: CENTRAL_CANDIDATE_DIGEST,
      challengeId: CENTRAL_CHALLENGE_ID,
      operationId: CENTRAL_OPERATION_ID,
      approvalSubjectDigest: CENTRAL_APPROVAL_SUBJECT_DIGEST,
      preparedGrantRecordDigest: CENTRAL_PREPARED_GRANT_DIGEST,
    });
    assert.throws(
      () => replayCommitSequence(repository, commits, new Map()),
      (error) =>
        error instanceof Error &&
        'code' in error &&
        error.code === 'CI_AUTHORITY_COMMIT_INVALID',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('Central Apply renderer and parser share one exact subject and provenance boundary', () => {
  const provenance = {
    candidateDigest: CENTRAL_CANDIDATE_DIGEST,
    challengeId: CENTRAL_CHALLENGE_ID,
    operationId: CENTRAL_OPERATION_ID,
    approvalSubjectDigest: CENTRAL_APPROVAL_SUBJECT_DIGEST,
    preparedGrantRecordDigest: CENTRAL_PREPARED_GRANT_DIGEST,
  };
  const rendered = gitAuthorityCandidateApplyCommitMessage(
    'Grant: Apply exact Central candidate',
    provenance,
  );
  assert.deepEqual(parseManagedTrailers(rendered), {
    kind: 'central-authority',
    transition: 'git.authority-candidate.apply.v1',
    ...provenance,
  });

  for (const subject of [
    '',
    ' padded',
    'x'.repeat(201),
    'control\u0001subject',
    'split\u2028subject',
  ]) {
    assert.throws(
      () => gitAuthorityCandidateApplyCommitMessage(subject, provenance),
      hasCode('INVALID_COMMIT_SUBJECT'),
      JSON.stringify(subject),
    );
  }
  for (const invalid of [
    { ...provenance, candidateDigest: `sha256:${'A'.repeat(64)}` },
    { ...provenance, challengeId: '11111111-1111-5111-8111-111111111111' },
    { ...provenance, operationId: 'not-an-operation' },
    { ...provenance, approvalSubjectDigest: 'b'.repeat(64) },
    { ...provenance, preparedGrantRecordDigest: `sha256:${'c'.repeat(63)}` },
    { ...provenance, extra: 'not-exact' },
  ]) {
    assert.throws(
      () =>
        gitAuthorityCandidateApplyCommitMessage(
          'Grant: Apply exact Central candidate',
          invalid,
        ),
      hasCode('INVALID_MANAGED_TRAILERS'),
    );
  }
});

test('language-neutral managed trailer vectors preserve historical parsing', () => {
  const vectors = loadWorkflowConformanceVectors(import.meta.dirname);
  for (const vector of vectors.managedTrailers) {
    if (vector.outcome.state === 'parsed') {
      assert.deepEqual(
        parseManagedTrailers(vector.message),
        vector.outcome.value,
        vector.id,
      );
    } else if (vector.outcome.state === 'unmanaged') {
      assert.equal(parseManagedTrailers(vector.message), undefined, vector.id);
    } else {
      assert.throws(
        () => parseManagedTrailers(vector.message),
        ManagedTrailerSyntaxError,
        vector.id,
      );
    }
  }
});

test('landed managed message renderers preserve exact bytes and round-trip', () => {
  const vectors = loadWorkflowConformanceVectors(import.meta.dirname);
  for (const vector of vectors.managedMessages) {
    const rendered = renderManagedMessage(vector);
    assert.equal(rendered, vector.message, vector.id);
    assert.equal(rendered.endsWith('\n'), false, vector.id);
    assert.deepEqual(parseManagedTrailers(rendered), vector.parsed, vector.id);
    if (vector.renderer === 'amend-plan') {
      const provenance = amendmentProvenance(vector.input);
      assert.equal(
        amendPlanCommitTrailers(field(vector.input, 'changeId'), provenance),
        vector.message.split('\n\n')[1],
        vector.id,
      );
    }
  }
});

test('managed trailer parser returns one canonical transition kind', () => {
  assert.deepEqual(
    parseManagedTrailers('Complete task\n\nChange: demo-change\nTask: 1.2\n'),
    { kind: 'task', changeId: 'demo-change', taskId: '1.2' },
  );
  assert.deepEqual(
    parseManagedTrailers(
      'Repair authority\n\nChange: demo-change\nTransition: authority-maintenance\nGrant: 11111111-1111-4111-8111-111111111111\n',
    ),
    {
      kind: 'authority',
      changeId: 'demo-change',
      transition: 'authority-maintenance',
      grantId: '11111111-1111-4111-8111-111111111111',
    },
  );
  assert.deepEqual(
    parseManagedTrailers(
      'Freeze authority candidate\n\nChange: demo-change\nTransition: authority-candidate\n',
    ),
    {
      kind: 'authority-candidate',
      changeId: 'demo-change',
      transition: 'authority-candidate',
    },
  );
  assert.deepEqual(
    parseManagedTrailers(
      'Plan demo-change\n\nChange: demo-change\nTransition: plan\n',
    ),
    { kind: 'plan', changeId: 'demo-change', transition: 'plan' },
  );
  assert.deepEqual(
    parseManagedTrailers(
      'Archive demo-change\n\nChange: demo-change\nTransition: archive',
    ),
    { kind: 'archive', changeId: 'demo-change', transition: 'archive' },
  );
});

test('managed trailer parser leaves truly unmanaged messages alone', () => {
  assert.equal(parseManagedTrailers('Add ordinary behavior\n'), undefined);
  assert.equal(
    parseManagedTrailers(
      'Document context\n\nThis paragraph mentions Change: in prose.\n\nSigned-off-by: Dev <dev@example.test>\n',
    ),
    undefined,
  );
});

test('managed trailer parser rejects every non-canonical reserved block', () => {
  const invalidMessages = [
    // Mixed kinds and duplicate reserved lines.
    'Mixed\n\nChange: demo-change\nTask: 1.1\nTransition: plan\n',
    'Mixed\n\nChange: demo-change\nTransition: plan\nTask: 1.1\n',
    'Duplicate\n\nChange: demo-change\nChange: demo-change\nTask: 1.1\n',
    'Duplicate\n\nChange: demo-change\nTask: 1.1\nTask: 1.1\n',
    // Case, whitespace, ordering, and separators are exact.
    'Case\n\nchange: demo-change\nTask: 1.1\n',
    'Case\n\nChange: demo-change\ntransition: plan\n',
    'Spacing\n\nChange : demo-change\nTask: 1.1\n',
    'Spacing\n\nChange:\tdemo-change\nTask: 1.1\n',
    'Spacing\n\nChange:  demo-change\nTask: 1.1\n',
    'Spacing\n\nChange: demo-change \nTask: 1.1\n',
    'Order\n\nTask: 1.1\nChange: demo-change\n',
    'Separator\nChange: demo-change\nTask: 1.1\n',
    'Trailing blank\n\nChange: demo-change\nTask: 1.1\n\n',
    // Unknown values and extra reserved lines fail closed.
    'Unknown\n\nChange: demo-change\nTransition: deploy\n',
    'Unknown\n\nChange: demo-change\nTask: one\n',
    'Extra\n\nTransition: plan\n\nChange: demo-change\nTask: 1.1\n',
    'Extra\n\nTask: 9.9\n\nChange: demo-change\nTransition: plan\n',
    'Missing pair\n\nChange: demo-change\n',
    'Missing pair\n\nTask: 1.1\n',
    'Missing pair\n\nTransition: archive\n',
    'Missing grant\n\nChange: demo-change\nTransition: authority-maintenance\n',
    'Candidate with grant\n\nChange: demo-change\nTransition: authority-candidate\nGrant: 11111111-1111-4111-8111-111111111111\n',
    'Mixed authority\n\nChange: demo-change\nTask: 1.1\nTransition: authority-maintenance\nGrant: 11111111-1111-4111-8111-111111111111\n',
    'Bad grant\n\nChange: demo-change\nTransition: authority-maintenance\nGrant: not-a-grant\n',
    [
      'Central partial',
      '',
      'Transition: git.authority-candidate.apply.v1',
      `Candidate: ${CENTRAL_CANDIDATE_DIGEST}`,
    ].join('\n'),
    [
      'Central case',
      '',
      'Transition: git.authority-candidate.apply.v1',
      `candidate: ${CENTRAL_CANDIDATE_DIGEST}`,
      `Grant-Challenge: ${CENTRAL_CHALLENGE_ID}`,
      `Grant-Operation: ${CENTRAL_OPERATION_ID}`,
      `Approval-Subject: ${CENTRAL_APPROVAL_SUBJECT_DIGEST}`,
      `Prepared-Grant: ${CENTRAL_PREPARED_GRANT_DIGEST}`,
    ].join('\n'),
    [
      'Central order',
      '',
      'Transition: git.authority-candidate.apply.v1',
      `Grant-Challenge: ${CENTRAL_CHALLENGE_ID}`,
      `Candidate: ${CENTRAL_CANDIDATE_DIGEST}`,
      `Grant-Operation: ${CENTRAL_OPERATION_ID}`,
      `Approval-Subject: ${CENTRAL_APPROVAL_SUBJECT_DIGEST}`,
      `Prepared-Grant: ${CENTRAL_PREPARED_GRANT_DIGEST}`,
    ].join('\n'),
    [
      'Central duplicate',
      '',
      'Transition: git.authority-candidate.apply.v1',
      `Candidate: ${CENTRAL_CANDIDATE_DIGEST}`,
      `Grant-Challenge: ${CENTRAL_CHALLENGE_ID}`,
      `Grant-Operation: ${CENTRAL_OPERATION_ID}`,
      `Approval-Subject: ${CENTRAL_APPROVAL_SUBJECT_DIGEST}`,
      `Prepared-Grant: ${CENTRAL_PREPARED_GRANT_DIGEST}`,
      `Prepared-Grant: ${CENTRAL_PREPARED_GRANT_DIGEST}`,
    ].join('\n'),
  ];

  for (const message of invalidMessages) {
    assert.throws(
      () => parseManagedTrailers(message),
      (error) => error instanceof ManagedTrailerSyntaxError,
      message,
    );
  }
});

function renderManagedMessage(vector: ManagedMessageConformanceVector): string {
  const input = vector.input;
  switch (vector.renderer) {
    case 'task':
      return managedCommitMessage(
        field(input, 'subject'),
        field(input, 'changeId'),
        field(input, 'taskId'),
      );
    case 'plan':
      return planningCommitMessage(field(input, 'changeId'));
    case 'amend-plan':
      return amendPlanCommitMessage(
        field(input, 'changeId'),
        amendmentProvenance(input),
      );
    case 'archive':
      return archiveCommitMessage(field(input, 'changeId'));
    case 'authority':
      return authorityCommitMessage(
        field(input, 'subject'),
        field(input, 'changeId'),
        field(input, 'grantId'),
      );
    case 'authority-candidate':
      return authorityCandidateCommitMessage(
        field(input, 'subject'),
        field(input, 'changeId'),
      );
    case 'central-authority':
      return gitAuthorityCandidateApplyCommitMessage(field(input, 'subject'), {
        candidateDigest: field(input, 'candidateDigest'),
        challengeId: field(input, 'challengeId'),
        operationId: field(input, 'operationId'),
        approvalSubjectDigest: field(input, 'approvalSubjectDigest'),
        preparedGrantRecordDigest: field(input, 'preparedGrantRecordDigest'),
      });
  }
}

function amendmentProvenance(
  input: Readonly<Record<string, string>>,
): AmendmentProvenance {
  const executionImpact = field(input, 'executionImpact');
  if (executionImpact !== 'none' && executionImpact !== 'required') {
    throw new Error('Amend-plan vector execution impact is invalid.');
  }
  return {
    planningGeneration: field(input, 'planningGeneration'),
    amendsPlanningGeneration: field(input, 'amendsPlanningGeneration'),
    executionImpact,
    planReview: field(input, 'planReview'),
  };
}

function field(input: Readonly<Record<string, string>>, key: string): string {
  const value = input[key];
  assert.equal(typeof value, 'string');
  return value;
}

function git(repository: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', repository, ...args], {
    encoding: 'utf8',
  });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    error instanceof Error && 'code' in error && error.code === code;
}

test('managed trailer identifiers use their exact canonical grammar', () => {
  for (const message of [
    'Bad change\n\nChange: Demo-change\nTask: 1.1\n',
    'Bad change\n\nChange: demo_change\nTransition: plan\n',
    'Bad task\n\nChange: demo-change\nTask: 1\n',
    'Bad task\n\nChange: demo-change\nTask: 1.a\n',
  ]) {
    assert.throws(
      () => parseManagedTrailers(message),
      ManagedTrailerSyntaxError,
    );
  }
});
