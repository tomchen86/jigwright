import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  parseImmutableGitCandidate,
  type ImmutableGitCandidateV1,
} from './immutable-git-candidate.ts';
import type {
  GrantApprovalMethod,
  GrantRequestInput,
  StateBinding,
} from './grant-core.ts';
import {
  grantHasExactKeys,
  grantSha256,
  GRANT_SHA256_DIGEST,
  GRANT_STABLE_ID,
  GRANT_UUID_V4,
} from './grant-primitives.ts';
import type {
  AuthorizedTransitionContext,
  TransitionDefinition,
  TransitionObservationContext,
} from './grant-transition-registry.ts';

export const GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID =
  'git.authority-candidate.apply.v1' as const;

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export type GitAuthorityCandidateCommitIdentityV1 = Readonly<{
  name: string;
  email: string;
}>;

export type GitAuthorityCandidateApplyParametersV1 = Readonly<{
  schemaVersion: 1;
  kind: 'git-authority-candidate-apply-parameters.v1';
  candidate: ImmutableGitCandidateV1;
  candidateDigest: `sha256:${string}`;
  commitSubject: string;
  commitIdentity: GitAuthorityCandidateCommitIdentityV1;
  commitTimestamp: string;
}>;

export type GitAuthorityCandidateApplyPhase =
  | 'pending'
  | 'prepared'
  | 'index-published'
  | 'commit-created'
  | 'ref-update-prepared'
  | 'ref-updated'
  | 'completed'
  | 'failed';

export type GitAuthorityCandidateApplyFailureV1 = Readonly<{
  schemaVersion: 1;
  kind: 'git-authority-candidate-apply-failure.v1';
  code: string;
  observedStateDigest: `sha256:${string}`;
}>;

export type GitAuthorityCandidateApplyObservationV1 = Readonly<{
  schemaVersion: 1;
  kind: 'git-authority-candidate-apply-observation.v1';
  phase: GitAuthorityCandidateApplyPhase;
  candidateDigest: `sha256:${string}`;
  parametersDigest: `sha256:${string}`;
  targetRef: string;
  expectedOldCommit: string;
  resultTree: string;
  challengeId: string | null;
  operationId: string | null;
  approvalMethod: GrantApprovalMethod | null;
  approvalSubjectDigest: `sha256:${string}` | null;
  preparedGrantRecordDigest: `sha256:${string}` | null;
  commitHash: string | null;
  failure: GitAuthorityCandidateApplyFailureV1 | null;
  journalDigest: `sha256:${string}` | null;
}>;

export type GitAuthorityCandidateApplyPort = Readonly<{
  observe(
    parameters: GitAuthorityCandidateApplyParametersV1,
    context?: TransitionObservationContext,
  ): GitAuthorityCandidateApplyObservationV1;
  apply(
    context: AuthorizedTransitionContext<GitAuthorityCandidateApplyParametersV1>,
  ): Promise<GitAuthorityCandidateApplyObservationV1>;
}>;

export const GIT_AUTHORITY_CANDIDATE_APPLY_PARAMETER_SCHEMA_DIGEST =
  grantSha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'git-authority-candidate-apply-parameters.schema.v1',
      required: [
        'candidate',
        'candidateDigest',
        'commitSubject',
        'commitIdentity',
        'commitTimestamp',
      ],
    }),
  );

export const GIT_AUTHORITY_CANDIDATE_APPLY_CONSEQUENCE_DIGEST = grantSha256(
  canonicalJson({
    schemaVersion: 1,
    kind: 'git-authority-candidate-apply-consequence.v1',
    effect: 'apply-one-exact-immutable-git-candidate',
    authority: 'central-grant-core-only',
    policyObservationsAreAuthority: false,
    checkObservationsAreAuthority: false,
    executesCandidateChecks: false,
    gitStateCasRequired: true,
  }),
);

export function createGitAuthorityCandidateApplyGrantRequest(
  port: GitAuthorityCandidateApplyPort,
  candidateParameters: GitAuthorityCandidateApplyParametersV1,
  proposedReason: string,
): GrantRequestInput {
  const parameters =
    assertGitAuthorityCandidateApplyParameters(candidateParameters);
  const observation = assertMatchingObservation(
    port.observe(parameters),
    parameters,
    undefined,
  );
  if (observation.phase !== 'pending') throw stateChanged();
  return Object.freeze({
    sourceModuleId: 'git-authority-candidate-apply',
    failureCode: 'exact-git-authority-candidate-approval-required',
    facts: Object.freeze({
      repositoryId: parameters.candidate.repositoryId,
      repositoryOrigin: parameters.candidate.repositoryOrigin,
      targetRef: parameters.candidate.targetRef,
      expectedOldCommit: parameters.candidate.expectedOldCommit,
      expectedOldTree: parameters.candidate.expectedOldTree,
      resultTree: parameters.candidate.resultTree,
      candidateDigest: parameters.candidateDigest,
      manifestDigest: parameters.candidate.manifestDigest,
      policyObservations: parameters.candidate.policyObservations,
      policyObservationsDigest: parameters.candidate.policyObservationsDigest,
      checkObservations: parameters.candidate.checkObservations,
      checkObservationsDigest: parameters.candidate.checkObservationsDigest,
      commitSubject: parameters.commitSubject,
      commitIdentity: parameters.commitIdentity,
      commitTimestamp: parameters.commitTimestamp,
    }),
    stateBinding: gitAuthorityCandidateApplyStateBinding(observation),
    candidates: Object.freeze([
      Object.freeze({
        transitionId: GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID,
        parameters,
        allowedReasonCodes: Object.freeze([
          'approve-exact-git-authority-candidate',
        ]),
        reasonRequired: true,
        proposedReason: exactText(proposedReason),
      }),
    ]),
  });
}

export function gitAuthorityCandidateApplyGrantTransitionDefinitions(
  port: GitAuthorityCandidateApplyPort,
): readonly TransitionDefinition<GitAuthorityCandidateApplyParametersV1>[] {
  return Object.freeze([
    Object.freeze({
      transitionId: GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID,
      parameterSchemaDigest:
        GIT_AUTHORITY_CANDIDATE_APPLY_PARAMETER_SCHEMA_DIGEST,
      consequenceDigest: GIT_AUTHORITY_CANDIDATE_APPLY_CONSEQUENCE_DIGEST,
      resolutionKind: 'non-retry' as const,
      allowedApprovalMethods: ['human-presence', 'ssh'] as const,
      validateParameters: assertGitAuthorityCandidateApplyParameters,
      renderTrustedChoice(parameters: GitAuthorityCandidateApplyParametersV1) {
        return Object.freeze({
          title: `Apply exact Git candidate to ${parameters.candidate.targetRef}`,
          consequences: Object.freeze([
            `Create one commit with exact tree ${parameters.candidate.resultTree} and parent ${parameters.candidate.expectedOldCommit}.`,
            `Advance only ${parameters.candidate.targetRef} by exact compare-and-swap and publish the exact candidate tree to the real index.`,
            'Treat policy and check observations as facts only; this transition does not execute checks or add a second authority decision.',
          ]),
        });
      },
      observeState(
        parameters: GitAuthorityCandidateApplyParametersV1,
        context?: TransitionObservationContext,
      ) {
        return gitAuthorityCandidateApplyStateBinding(
          assertMatchingObservation(
            port.observe(parameters, context),
            parameters,
            context,
          ),
        );
      },
      async execute(
        context: AuthorizedTransitionContext<GitAuthorityCandidateApplyParametersV1>,
      ) {
        const parameters = assertGitAuthorityCandidateApplyParameters(
          context.parameters,
        );
        context.assertLifecycleOwned();
        const observation = assertMatchingObservation(
          await port.apply({ ...context, parameters }),
          parameters,
          {
            challengeId: context.challengeId,
            operationId: context.operationId,
          },
        );
        context.assertLifecycleOwned();
        if (
          (observation.phase !== 'completed' &&
            observation.phase !== 'failed') ||
          observation.approvalMethod !==
            context.approvalSubject.approvalMethod ||
          observation.approvalSubjectDigest !== context.approvalSubjectDigest
        ) {
          throw workflowError(
            'GIT_AUTHORITY_CANDIDATE_APPLY_RESULT_INVALID',
            'The exact Git authority operation did not publish a terminal result.',
            ExitCode.verification,
          );
        }
        return Object.freeze({
          outcome: observation.phase === 'completed' ? 'completed' : 'failed',
          details: Object.freeze({
            schemaVersion: 1,
            kind: 'git-authority-candidate-apply-result.v1',
            transitionId: GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID,
            candidateDigest: observation.candidateDigest,
            targetRef: observation.targetRef,
            expectedOldCommit: observation.expectedOldCommit,
            resultTree: observation.resultTree,
            challengeId: observation.challengeId,
            operationId: observation.operationId,
            approvalMethod: observation.approvalMethod,
            approvalSubjectDigest: observation.approvalSubjectDigest,
            preparedGrantRecordDigest: observation.preparedGrantRecordDigest,
            commitHash: observation.commitHash,
            failure: observation.failure,
            journalDigest: observation.journalDigest,
          }),
        });
      },
    }),
  ]);
}

export function gitAuthorityCandidateApplyParametersDigest(
  value: GitAuthorityCandidateApplyParametersV1,
): `sha256:${string}` {
  return grantSha256(
    `workflow.git-authority-candidate-apply-parameters.v1\n${canonicalJson(
      assertGitAuthorityCandidateApplyParameters(value),
    )}`,
  );
}

export function gitAuthorityCandidateApplyStateBinding(
  value: GitAuthorityCandidateApplyObservationV1,
): StateBinding {
  const observation = assertGitAuthorityCandidateApplyObservation(value);
  return Object.freeze({
    kind: 'git-authority-candidate-apply-state.v1',
    digest: grantSha256(
      `workflow.git-authority-candidate-apply-state.v1\n${canonicalJson(
        observation,
      )}`,
    ),
  });
}

export function assertGitAuthorityCandidateApplyParameters(
  value: unknown,
): GitAuthorityCandidateApplyParametersV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'candidate',
      'candidateDigest',
      'commitSubject',
      'commitIdentity',
      'commitTimestamp',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'git-authority-candidate-apply-parameters.v1' ||
    typeof value.candidateDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.candidateDigest) ||
    typeof value.commitSubject !== 'string' ||
    !isCommitSubject(value.commitSubject) ||
    typeof value.commitTimestamp !== 'string' ||
    !isExactTimestamp(value.commitTimestamp)
  ) {
    throw parametersInvalid();
  }
  const candidate = safelyParseCandidate(value.candidate);
  const commitIdentity = assertCommitIdentity(value.commitIdentity);
  if (value.candidateDigest !== candidate.candidateDigest) {
    throw parametersInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'git-authority-candidate-apply-parameters.v1',
    candidate,
    candidateDigest: value.candidateDigest as `sha256:${string}`,
    commitSubject: value.commitSubject,
    commitIdentity,
    commitTimestamp: value.commitTimestamp,
  });
}

export function assertGitAuthorityCandidateApplyObservation(
  value: unknown,
): GitAuthorityCandidateApplyObservationV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'phase',
      'candidateDigest',
      'parametersDigest',
      'targetRef',
      'expectedOldCommit',
      'resultTree',
      'challengeId',
      'operationId',
      'approvalMethod',
      'approvalSubjectDigest',
      'preparedGrantRecordDigest',
      'commitHash',
      'failure',
      'journalDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'git-authority-candidate-apply-observation.v1' ||
    ![
      'pending',
      'prepared',
      'index-published',
      'commit-created',
      'ref-update-prepared',
      'ref-updated',
      'completed',
      'failed',
    ].includes(String(value.phase)) ||
    typeof value.candidateDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.candidateDigest) ||
    typeof value.parametersDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.parametersDigest) ||
    typeof value.targetRef !== 'string' ||
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u.test(
      value.targetRef,
    ) ||
    typeof value.expectedOldCommit !== 'string' ||
    !COMMIT_OID.test(value.expectedOldCommit) ||
    typeof value.resultTree !== 'string' ||
    !COMMIT_OID.test(value.resultTree) ||
    (value.challengeId !== null &&
      (typeof value.challengeId !== 'string' ||
        !GRANT_UUID_V4.test(value.challengeId))) ||
    (value.operationId !== null &&
      (typeof value.operationId !== 'string' ||
        !GRANT_UUID_V4.test(value.operationId))) ||
    (value.approvalMethod !== null &&
      value.approvalMethod !== 'human-presence' &&
      value.approvalMethod !== 'ssh') ||
    (value.approvalSubjectDigest !== null &&
      (typeof value.approvalSubjectDigest !== 'string' ||
        !GRANT_SHA256_DIGEST.test(value.approvalSubjectDigest))) ||
    (value.preparedGrantRecordDigest !== null &&
      (typeof value.preparedGrantRecordDigest !== 'string' ||
        !GRANT_SHA256_DIGEST.test(value.preparedGrantRecordDigest))) ||
    (value.commitHash !== null &&
      (typeof value.commitHash !== 'string' ||
        !COMMIT_OID.test(value.commitHash))) ||
    (value.journalDigest !== null &&
      (typeof value.journalDigest !== 'string' ||
        !GRANT_SHA256_DIGEST.test(value.journalDigest)))
  ) {
    throw observationInvalid();
  }
  const failure =
    value.failure === null ? null : assertApplyFailure(value.failure);
  const phase = value.phase as GitAuthorityCandidateApplyPhase;
  const isPending = phase === 'pending';
  if (
    (isPending &&
      (value.challengeId !== null ||
        value.operationId !== null ||
        value.approvalMethod !== null ||
        value.approvalSubjectDigest !== null ||
        value.preparedGrantRecordDigest !== null ||
        value.commitHash !== null ||
        failure !== null ||
        value.journalDigest !== null)) ||
    (!isPending &&
      (value.challengeId === null ||
        value.operationId === null ||
        value.approvalMethod === null ||
        value.approvalSubjectDigest === null ||
        value.preparedGrantRecordDigest === null ||
        value.journalDigest === null)) ||
    (phase === 'completed' &&
      (value.commitHash === null || failure !== null)) ||
    ((phase === 'prepared' || phase === 'index-published') &&
      value.commitHash !== null) ||
    ([
      'commit-created',
      'ref-update-prepared',
      'ref-updated',
      'completed',
    ].includes(phase) &&
      value.commitHash === null) ||
    (phase === 'failed' && failure === null) ||
    (phase !== 'failed' && failure !== null)
  ) {
    throw observationInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'git-authority-candidate-apply-observation.v1',
    phase,
    candidateDigest: value.candidateDigest as `sha256:${string}`,
    parametersDigest: value.parametersDigest as `sha256:${string}`,
    targetRef: value.targetRef,
    expectedOldCommit: value.expectedOldCommit,
    resultTree: value.resultTree,
    challengeId: value.challengeId as string | null,
    operationId: value.operationId as string | null,
    approvalMethod: value.approvalMethod as GrantApprovalMethod | null,
    approvalSubjectDigest: value.approvalSubjectDigest as
      `sha256:${string}` | null,
    preparedGrantRecordDigest: value.preparedGrantRecordDigest as
      `sha256:${string}` | null,
    commitHash: value.commitHash as string | null,
    failure,
    journalDigest: value.journalDigest as `sha256:${string}` | null,
  });
}

function assertMatchingObservation(
  value: GitAuthorityCandidateApplyObservationV1,
  parameters: GitAuthorityCandidateApplyParametersV1,
  context: TransitionObservationContext | undefined,
): GitAuthorityCandidateApplyObservationV1 {
  const observation = assertGitAuthorityCandidateApplyObservation(value);
  if (
    observation.candidateDigest !== parameters.candidateDigest ||
    observation.parametersDigest !==
      gitAuthorityCandidateApplyParametersDigest(parameters) ||
    observation.targetRef !== parameters.candidate.targetRef ||
    observation.expectedOldCommit !== parameters.candidate.expectedOldCommit ||
    observation.resultTree !== parameters.candidate.resultTree ||
    (context !== undefined &&
      context.operationId !== null &&
      (observation.challengeId !== context.challengeId ||
        observation.operationId !== context.operationId))
  ) {
    throw stateChanged();
  }
  return observation;
}

function assertCommitIdentity(
  value: unknown,
): GitAuthorityCandidateCommitIdentityV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, ['name', 'email']) ||
    typeof value.name !== 'string' ||
    !isSafeIdentity(value.name) ||
    typeof value.email !== 'string' ||
    !isSafeIdentity(value.email)
  ) {
    throw parametersInvalid();
  }
  return Object.freeze({ name: value.name, email: value.email });
}

function assertApplyFailure(
  value: unknown,
): GitAuthorityCandidateApplyFailureV1 {
  if (
    !isRecord(value) ||
    !grantHasExactKeys(value, [
      'schemaVersion',
      'kind',
      'code',
      'observedStateDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'git-authority-candidate-apply-failure.v1' ||
    typeof value.code !== 'string' ||
    !GRANT_STABLE_ID.test(value.code) ||
    typeof value.observedStateDigest !== 'string' ||
    !GRANT_SHA256_DIGEST.test(value.observedStateDigest)
  ) {
    throw observationInvalid();
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'git-authority-candidate-apply-failure.v1',
    code: value.code,
    observedStateDigest: value.observedStateDigest as `sha256:${string}`,
  });
}

function safelyParseCandidate(value: unknown): ImmutableGitCandidateV1 {
  try {
    return parseImmutableGitCandidate(value);
  } catch {
    throw parametersInvalid();
  }
}

function isCommitSubject(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value) <= 200 &&
    value.trim() === value &&
    !/[\r\n\0]/u.test(value)
  );
}

function isSafeIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value) <= 320 &&
    value.trim() === value &&
    !/[\p{Cc}\r\n]/u.test(value)
  );
}

function isExactTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function exactText(value: string): string {
  if (
    value.length === 0 ||
    Buffer.byteLength(value) > 2048 ||
    value.trim() !== value ||
    /[\0\r]/u.test(value)
  ) {
    throw parametersInvalid();
  }
  return value;
}

function parametersInvalid() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_PARAMETERS_INVALID',
    'Exact Git authority candidate Apply parameters are invalid.',
    ExitCode.guard,
  );
}

function observationInvalid() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_OBSERVATION_INVALID',
    'Exact Git authority candidate Apply observation is invalid.',
    ExitCode.guard,
  );
}

function stateChanged() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_STATE_CHANGED',
    'The exact Git authority candidate Apply state changed.',
    ExitCode.staleState,
  );
}
