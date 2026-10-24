import {
  reviewSubject,
  reviewSubmission,
  implementationActor,
  digest,
} from './task-diff-external-record-fixture.ts';
import {
  createTaskDiffReviewRecord,
  createTaskDiffReviewChallengeResponse,
  createTaskDiffFinalAssuranceRecord,
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
} from '../../src/modules/assurance/task-diff-review-artifact.ts';
import { deriveTaskDiffReviewCandidatePlan } from '../../src/modules/assurance/task-diff-review.ts';
import { createProviderInvocationRequest } from '../../src/modules/provider-orchestration/provider-contracts.ts';
import type { AdmittedRoleResult } from '../../src/modules/provider-orchestration/role-admission-contracts.ts';
import type {
  TaskDiffReviewScope,
  TaskDiffReviewSubject,
} from '../../src/modules/assurance/task-diff-review-record.ts';

export { digest };

export function bindingInputs(
  seed = 'binding-current',
  sessionId = 'session-binding',
) {
  const subject = reviewSubject(seed);
  const plan = deriveTaskDiffReviewCandidatePlan({ current: subject });
  if (plan.action !== 'review') throw new Error('review expected');
  const review = createReview(subject, plan.scope, true);
  const response = createTaskDiffReviewChallengeResponse({
    review,
    responses: [
      {
        challengeId: review.challenges[0]!.challengeId,
        rationale: 'The pinned evidence answers this challenge.',
        evidence: [review.challenges[0]!.evidence[0]!],
      },
    ],
  });
  const submission = {
    schemaVersion: 1 as const,
    reviewRecordDigest: review.recordDigest,
    responseDigest: response.responseDigest,
    proposedDispositions: [
      {
        challengeId: review.challenges[0]!.challengeId,
        decision: 'rebutted' as const,
        rationale: 'The exact evidence rebuts the challenge.',
        supersededBy: null,
      },
    ],
  };
  const assignment = {
    role: 'task-diff-reviewer' as const,
    providerId: 'claude' as const,
    sessionId: `${sessionId}-review`,
    targetDigest: subject.subjectDigest,
    requiredIndependence: 'session-independent' as const,
    achievedIndependence: 'provider-independent' as const,
  };
  const manifest = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-manifest' as const,
    changeId: subject.changeId,
    taskId: subject.taskId,
    sessionId,
    repositoryId: 'binding-fixture',
    repositoryIdentity: subject.repositoryId,
    baseCommit: subject.baseCommit,
    baseTree: subject.baseTree,
    subject,
    reviewScope: plan.scope,
    capabilityProfile: 'repository-read-only' as const,
  };
  const continuationManifest = {
    schemaVersion: 1 as const,
    kind: 'task-diff-review-continuation-manifest' as const,
    changeId: subject.changeId,
    taskId: subject.taskId,
    sessionId,
    repositoryId: manifest.repositoryId,
    repositoryIdentity: subject.repositoryId,
    baseCommit: subject.baseCommit,
    baseTree: subject.baseTree,
    subject,
    review,
    response,
    capabilityProfile: 'repository-read-only' as const,
  };
  const requestInput = {
    invocationId: `invocation-${seed}`,
    nonce: `${seed}-nonce-000000`,
    purpose: 'task-diff-review' as const,
    providerId: 'claude' as const,
    roleAssignment: assignment,
    capabilityProfile: 'repository-read-only' as const,
    repositoryId: manifest.repositoryId,
    baseCommit: subject.baseCommit,
    baseTree: subject.baseTree,
    targetDigest: subject.subjectDigest,
    inputManifestDigest: digest(manifest),
    authorizationNodeId: digest('authorization'),
    writeAllowedPaths: [],
    outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-diff-review.v1',
    policyDigest: subject.reviewPolicyDigest,
    limits: { timeoutMs: 60_000, aggregateOutputBytes: 262_144 },
  };
  const request = createProviderInvocationRequest(requestInput);
  const continuationRequest = createProviderInvocationRequest({
    ...requestInput,
    invocationId: `invocation-continuation-${seed}`,
    roleAssignment: { ...assignment, sessionId: `${sessionId}-continuation` },
    inputManifestDigest: digest(continuationManifest),
    outputSchema: TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
    evaluatorVersion: 'task-diff-review-continuation.v1',
  });
  const commonReservation = {
    ownerInvestigationId: `investigation-${seed}`,
    sessionId,
    changeId: subject.changeId,
    taskId: subject.taskId,
    repositoryRoot: '/fixture/review-repository',
    gitCommonDirectory: '/fixture/review-repository/.git',
    branch: 'work/binding-fixture',
    baseline: { head: subject.baseCommit, tree: subject.baseTree },
    mandateBinding: null,
    subject,
    implementationActor: implementationActor(),
    authorizationNodeId: request.authorizationNodeId,
    reservationNodeId: digest('reservation-node'),
    createdAt: '2026-08-13T00:00:00.000Z',
  };
  const roleSemantic = {
    schemaVersion: 1 as const,
    form: 'ordinary-provider' as const,
    role: 'task-diff-reviewer' as const,
    targetDigest: subject.subjectDigest,
    assignment,
    author: implementationActor(),
    participant: {
      ...implementationActor(),
      providerId: 'claude' as const,
      principalId: 'provider:claude',
      sessionId: assignment.sessionId,
      engineSpawned: true,
    },
    orchestration: 'engine-spawned-provider' as const,
    requiredIndependence: assignment.requiredIndependence,
    achievedIndependence: assignment.achievedIndependence,
    content: {
      kind: 'task-diff-review' as const,
      nodeId: digest('content-node'),
      resultDigest: digest('content-result'),
      outputSchema: TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
      evaluator: 'task-diff-review.v1',
      policyDigest: subject.reviewPolicyDigest,
      contentDigest: review.recordDigest,
      current: true as const,
    },
    providerInvocation: {
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      outputDigest: digest('output'),
      providerId: 'claude' as const,
      sessionId: assignment.sessionId,
      targetDigest: subject.subjectDigest,
      engineSpawned: true as const,
    },
    grantUse: null,
    directHumanReviewAttestation: null,
  };
  const roleResult: AdmittedRoleResult = {
    ...roleSemantic,
    resultDigest: digest({
      schema: 'admitted-role-result.v1',
      ...roleSemantic,
    }),
  };
  const commonResult = {
    ownerInvestigationId: commonReservation.ownerInvestigationId,
    sessionId,
    subjectDigest: subject.subjectDigest,
    outputDigest: digest('output'),
    runtimeObservationDigest: digest('runtime-observation'),
    providerResultNodeId: digest('result-node'),
    providerResultDigest: digest('result'),
    createdAt: '2026-08-13T00:01:00.000Z',
  };
  const reviewerAuthority = {
    kind: 'engine-attributed-provider-reviewer' as const,
    principalId: 'provider:claude',
    providerId: 'claude' as const,
    policyDigest: subject.reviewPolicyDigest,
  };
  const authorityCommon = {
    schemaVersion: 1 as const,
    kind: 'task-diff-authenticated-reviewer-authority.v1' as const,
    subjectDigest: subject.subjectDigest,
    reviewRecordDigest: review.recordDigest,
    authority: reviewerAuthority,
  };
  const assurance = createTaskDiffFinalAssuranceRecord({
    subject,
    review,
    response,
    submission,
    reviewerAuthority,
    authenticatedReviewAuthority: {
      ...authorityCommon,
      stage: 'review',
      responseDigest: null,
      authorityNodeId: digest('review-authority-node'),
      authorityResultDigest: digest('review-authority-result'),
    },
    authenticatedChallengeClosureAuthority: {
      ...authorityCommon,
      stage: 'challenge-closure',
      responseDigest: response.responseDigest,
      authorityNodeId: digest('closure-authority-node'),
      authorityResultDigest: digest('closure-authority-result'),
    },
  });
  const predecessorSubject = reviewSubject('binding-predecessor');
  const predecessorPlan = deriveTaskDiffReviewCandidatePlan({
    current: predecessorSubject,
  });
  if (predecessorPlan.action !== 'review') throw new Error('review expected');
  const predecessorReview = createReview(
    predecessorSubject,
    predecessorPlan.scope,
    false,
  );
  const successorPlan = deriveTaskDiffReviewCandidatePlan({
    current: subject,
    predecessor: {
      subject: predecessorSubject,
      reviewRecordDigest: predecessorReview.recordDigest,
      finalAssuranceCommitmentDigest: null,
    },
  });
  if (successorPlan.action !== 'review')
    throw new Error('successor review expected');
  const successorReview = createReview(subject, successorPlan.scope, false);
  return {
    reservation: { ...commonReservation, manifest, request },
    result: {
      ...commonResult,
      invocationId: request.invocationId,
      requestDigest: request.requestDigest,
      providerObservationNodeId: digest('observation-node'),
      providerObservationDigest: digest('observation'),
      roleResult,
      review,
    },
    continuationReservation: {
      ...commonReservation,
      review,
      response,
      manifest: continuationManifest,
      request: continuationRequest,
    },
    continuationResult: {
      ...commonResult,
      reviewRecordDigest: review.recordDigest,
      responseDigest: response.responseDigest,
      invocationId: continuationRequest.invocationId,
      requestDigest: continuationRequest.requestDigest,
      submission,
    },
    finalAssurance: {
      subjectDigest: subject.subjectDigest,
      assuranceNodeId: digest('assurance-node'),
      assuranceResultDigest: digest('assurance-result'),
      assurance,
      createdAt: '2026-08-13T00:02:00.000Z',
    },
    supersession: {
      predecessorSubject,
      predecessorReview,
      successorSubject: subject,
      successorReview,
      successorReviewScope: successorPlan.scope,
      successorReviewScopeDigest: successorPlan.scope.scopeDigest,
    },
  };
}

function createReview(
  subject: TaskDiffReviewSubject,
  reviewScope: TaskDiffReviewScope,
  challenge: boolean,
) {
  const submission = reviewSubmission(subject);
  return createTaskDiffReviewRecord({
    subject,
    reviewScope,
    assignment: {
      implementerPrincipalId: 'provider:codex',
      implementerProviderId: 'codex',
      implementationSessionId: 'task-diff-session',
      reviewerPrincipalId: 'provider:claude',
      reviewerProviderId: 'claude',
      reviewerSessionId: `review-${subject.candidateTree}`,
      achievedIndependence: 'provider-independent',
      degradedForm: null,
      grantUseDigest: null,
    },
    submission: challenge
      ? {
          ...submission,
          verdict: 'advisory-reject',
          scopeAssessment: { kind: 'challenges' },
          findings: [
            {
              kind: 'challenge',
              severity: 'high',
              category: 'correctness-and-invariants',
              currentChangeImpact: 'required',
              summary: 'The exact candidate needs one response.',
              evidence: [
                {
                  kind: 'repository-location',
                  path: subject.changedPaths[0]!,
                  line: 1,
                  blobObjectId: subject.transitions[0]!.after!.objectId,
                  observation: 'Check the pinned candidate behavior.',
                },
              ],
            },
          ],
        }
      : submission,
  });
}

// Captured from the six original storage creators at f77a16ad before refactoring.
export const goldenRecords = {
  reservation: {
    digest: '04f22565f62a0d95af4957319da4cddca79bb0df60d6e9db70a8d5373b5b467c',
    wireSha256:
      '1b6f17f2226fe0de338bb47009d53bcb47c63a5d53cfbb1acbcd7a1186c72803',
  },
  result: {
    digest: '3ca581a11743a89fba1fbfdc81b58ff815a78c195c1c15cddf437b046f821dc9',
    wireSha256:
      '7ba87cc9631dee99e1edc17aa037e3acdadf3af662bfffbb42b9b5137d6eb055',
  },
  continuationReservation: {
    digest: 'c4f48bdff595772a3f6a95e7210e0e261ce2147f6097ab42233aa03bcba85753',
    wireSha256:
      'c0ca2a88902c666c3c083b9497b3238e16cd61eb4942e72caf6ca07b1170649d',
  },
  continuationResult: {
    digest: '1ca3aac916e66110dd8425126e147ec72da02a4b9b80e0f7a83727610685e92b',
    wireSha256:
      'eb53709ad8433639c021c6cf43ad42ea92fcd5fe3306ec01f81b03d47241a10b',
  },
  finalAssurance: {
    digest: 'bb472d6f26b46bf9ede4f9aeee67df0c2f192e12659ed233220948193a9eea75',
    wireSha256:
      '4b97bf5e1f75f737f15e9d8fea99559d0dc1b750632d5fc2a5dd6538f9b4b192',
  },
  supersession: {
    digest: '98ad6986662c2e4a1c7a9064ce6e3159ea3192aa2dda160656e5c766a719655a',
    wireSha256:
      'c6382653e3a779bb432b41cf52e4a2e3d44c5c9e47d77b9be48e22ceeb5d41fa',
  },
} as const;
