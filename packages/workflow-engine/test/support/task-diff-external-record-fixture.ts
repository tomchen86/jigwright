import crypto from 'node:crypto';
import { canonicalJson } from '../../src/foundation/canonical-json/canonical-json.ts';
import { createTaskDiffReviewSubject } from '../../src/modules/assurance/task-diff-review.ts';
import type { TaskDiffReviewSubject } from '../../src/modules/assurance/task-diff-review-record.ts';
import type {
  TaskDiffReviewChallengeResponseRecord,
  TaskDiffReviewSubmission,
} from '../../src/modules/assurance/task-diff-review-artifact-record.ts';

export function reviewSubject(seed: string): TaskDiffReviewSubject {
  return createTaskDiffReviewSubject({
    repositoryId: 'github:tomchen86/expense-app',
    changeId: 'external-review-store',
    taskId: '2.4',
    baseCommit: '1'.repeat(40),
    baseTree: '2'.repeat(40),
    candidateTree: digest(`${seed}:candidate-tree`),
    transitions: [
      {
        path: `src/${seed}.ts`,
        before: null,
        after: { mode: '100644', objectId: digest(`${seed}:after`) },
      },
    ],
    taskContractDigest: digest('task-contract'),
    requiredCheckPolicyDigest: digest('check-policy'),
    checkEvidenceDigest: digest(`${seed}:check-evidence`),
    planningGenerationId: digest('planning-generation'),
    planTargetDigest: digest('plan-target'),
    planReviewNodeId: digest('plan-review-node'),
    planningAssuranceDigest: digest('planning-assurance'),
    reviewRequirement: {
      required: true,
      basis: 'explicit',
      riskPaths: [],
    },
  });
}

export function challengeResponse(
  subject: TaskDiffReviewSubject,
  seed: string,
  options: { reviewRecordDigest?: string } = {},
): TaskDiffReviewChallengeResponseRecord {
  const body = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-challenge-response.v1' as const,
    reviewRecordDigest:
      options.reviewRecordDigest ?? digest(`${seed}:review-record`),
    subjectDigest: subject.subjectDigest,
    responses: [
      {
        challengeId: digest(`${seed}:challenge`),
        rationale: `Exact response for ${seed}.`,
        evidence: [
          {
            kind: 'planning-node' as const,
            nodeId: digest(`${seed}:node`),
            resultDigest: digest(`${seed}:result`),
            observation: `Bound evidence for ${seed}.`,
          },
        ],
      },
    ],
  };
  return { ...body, responseDigest: digest(body) };
}

export function reviewSubmission(
  subject: TaskDiffReviewSubject,
): TaskDiffReviewSubmission {
  return {
    schemaVersion: 1,
    verdict: 'advisory-approve',
    coverage: [...subject.coverage],
    scopeAssessment: {
      kind: 'no-challenge',
      evidence: [
        {
          kind: 'repository-location',
          path: subject.changedPaths[0]!,
          line: 1,
          blobObjectId: subject.transitions[0]!.after!.objectId,
          observation: 'The exact candidate preserves the reviewed contract.',
        },
      ],
    },
    findings: [],
    suggestions: [],
    riskPathDispositions: [],
    residualRisk: 'No release-blocking residual risk was identified.',
    uncertainty: 'Review is limited to the exact bound subject and scope.',
  };
}

export function grantReference(
  degradedForm: 'caller-supplied' | 'direct-human-review',
  seed: string,
  grantTargetDigest: string,
) {
  return {
    degradedForm,
    grantId:
      degradedForm === 'caller-supplied'
        ? '00000000-0000-4000-8000-000000000001'
        : '00000000-0000-4000-8000-000000000002',
    grantEnvelopeDigest: digest(`${seed}:grant-envelope`),
    grantTransitionDigest: digest(`${seed}:grant-transition`),
    grantTargetDigest,
  } as const;
}

export function implementationActor() {
  return {
    providerId: 'codex' as const,
    sessionId: 'task-diff-session',
    principalId: 'provider:codex',
    identityAssurance: 'self-declared' as const,
    engineSpawned: false,
  };
}

export function digest(value: unknown): string {
  return crypto
    .createHash('sha256')
    .update(typeof value === 'string' ? value : canonicalJson(value))
    .digest('hex');
}

export function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === code;
}
