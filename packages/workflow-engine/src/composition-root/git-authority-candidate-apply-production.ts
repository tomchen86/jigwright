import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../foundation/errors/errors.ts';
import { loadWorkflowConfig } from '../adapters/consumer/repository/work-registry/contracts.ts';
import {
  approvalSubjectDigest,
  type ApprovalSubject,
} from '../modules/authority/grant-core.ts';
import {
  assertGitAuthorityCandidateApplyParameters,
  gitAuthorityCandidateApplyParametersDigest,
  GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID,
  type GitAuthorityCandidateApplyFailureV1,
  type GitAuthorityCandidateApplyObservationV1,
  type GitAuthorityCandidateApplyParametersV1,
  type GitAuthorityCandidateApplyPort,
} from '../modules/authority/git-authority-candidate-apply-grant.ts';
import {
  parseImmutableGitCandidate,
  verifyImmutableGitCandidateAgainstRepository,
  type ImmutableGitCandidateV1,
} from '../modules/authority/immutable-git-candidate.ts';
import { grantSha256 } from '../modules/authority/grant-primitives.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
  listChangedPaths,
  runGit,
  runGitWithEnvironment,
} from '../runtime/repository-transaction/git.ts';
import {
  commitFacts,
  resolveCommitIdentity,
  rollbackExactStaging,
  stageExactPaths,
  updateManagedRef,
} from '../runtime/repository-transaction/git-transitions.ts';
import {
  grantRecordDigest,
  grantStorePaths,
  readGrantRecord,
  type PreparedGrantRecord,
} from '../runtime/storage-journal/grant-store.ts';
import {
  advanceGitAuthorityCandidateApplyJournal,
  createGitAuthorityCandidateApplyJournal,
  gitAuthorityCandidateApplyJournalObservation,
  readGitAuthorityCandidateApplyJournal,
  readOptionalGitAuthorityCandidateApplyJournal,
  type GitAuthorityCandidateApplyJournalV1,
} from '../runtime/storage-journal/git-authority-candidate-apply-store.ts';
import { investigationRuntimePaths } from '../runtime/session-workspace/paths.ts';
import { runtimePaths } from '../runtime/session-workspace/session-store.ts';
import type { TransitionObservationContext } from '../modules/authority/grant-transition-registry.ts';

export type GitAuthorityCandidateApplyCrashPoint =
  | 'prepared'
  | 'index-publication'
  | 'commit-object'
  | 'ref-update'
  | 'terminal';

export type ProductionGitAuthorityCandidateApplyOptions = Readonly<{
  /** Direct integration seam; production composition never provides it. */
  testAfterCrashPoint?: (point: GitAuthorityCandidateApplyCrashPoint) => void;
}>;

export function createProductionGitAuthorityCandidateApplyParameters(
  cwd: string,
  candidateValue: ImmutableGitCandidateV1,
  commitSubject: string,
  options: Readonly<{
    now?: Date;
    environment?: NodeJS.ProcessEnv;
  }> = {},
): GitAuthorityCandidateApplyParametersV1 {
  const candidate = parseImmutableGitCandidate(candidateValue);
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const identity = resolveCommitIdentity(
    repositoryRoot,
    options.environment ?? process.env,
  );
  const timestamp = new Date(options.now ?? new Date());
  if (Number.isNaN(timestamp.getTime())) throw parametersInvalid();
  return assertGitAuthorityCandidateApplyParameters({
    schemaVersion: 1,
    kind: 'git-authority-candidate-apply-parameters.v1',
    candidate,
    candidateDigest: candidate.candidateDigest,
    commitSubject,
    commitIdentity: {
      name: identity.GIT_AUTHOR_NAME,
      email: identity.GIT_AUTHOR_EMAIL,
    },
    commitTimestamp: timestamp.toISOString(),
  });
}

export function createProductionGitAuthorityCandidateApplyPort(
  cwd: string,
  options: ProductionGitAuthorityCandidateApplyOptions = {},
): GitAuthorityCandidateApplyPort {
  const git = discoverRepository(cwd);
  const config = loadWorkflowConfig(git.repositoryRoot);
  const runtime = investigationRuntimePaths(
    git.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const lifecycleRuntime = runtimePaths(
    git.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const grantRuntimeRoot = lifecycleRuntime.root;
  const repositoryRoot = git.repositoryRoot;

  return Object.freeze({
    observe(
      parametersValue: GitAuthorityCandidateApplyParametersV1,
      context?: TransitionObservationContext,
    ) {
      const parameters =
        assertGitAuthorityCandidateApplyParameters(parametersValue);
      if (context?.operationId === null || context === undefined) {
        verifyImmutableGitCandidateAgainstRepository(
          repositoryRoot,
          parameters.candidate,
        );
        return pendingObservation(parameters);
      }
      const journal = readGitAuthorityCandidateApplyJournal(
        runtime,
        context.operationId,
      );
      const prepared = readExactPreparedGrant(
        grantStorePaths(grantRuntimeRoot),
        context.challengeId,
        context.operationId,
        journal.approvalSubject,
        parameters,
      );
      assertJournalBinding(
        journal,
        parameters,
        context.challengeId,
        context.operationId,
        journal.approvalSubject,
        grantRecordDigest(prepared),
      );
      return gitAuthorityCandidateApplyJournalObservation(journal);
    },

    async apply(context) {
      const parameters = assertGitAuthorityCandidateApplyParameters(
        context.parameters,
      );
      if (
        approvalSubjectDigest(context.approvalSubject) !==
        context.approvalSubjectDigest
      ) {
        throw workflowError(
          'GIT_AUTHORITY_CANDIDATE_APPLY_GRANT_CHANGED',
          'The exact Central Grant approval subject changed before Git Apply.',
          ExitCode.staleState,
        );
      }
      context.assertLifecycleOwned();
      const prepared = readExactPreparedGrant(
        grantStorePaths(grantRuntimeRoot),
        context.challengeId,
        context.operationId,
        context.approvalSubject,
        parameters,
      );
      const preparedRecordDigest = grantRecordDigest(prepared);
      let journal = readOptionalGitAuthorityCandidateApplyJournal(
        runtime,
        context.operationId,
      );
      if (journal === null) {
        context.assertLifecycleOwned();
        journal = createGitAuthorityCandidateApplyJournal(runtime, {
          parameters,
          challengeId: context.challengeId,
          operationId: context.operationId,
          approvalSubject: context.approvalSubject,
          preparedGrantRecordDigest: preparedRecordDigest,
          commitMessage: exactCommitMessage(
            parameters,
            context.challengeId,
            context.operationId,
            context.approvalSubjectDigest,
            preparedRecordDigest,
          ),
        });
        options.testAfterCrashPoint?.('prepared');
      }
      assertJournalBinding(
        journal,
        parameters,
        context.challengeId,
        context.operationId,
        context.approvalSubject,
        preparedRecordDigest,
      );

      while (true) {
        context.assertLifecycleOwned();
        const current = journal.entries.at(-1)!;
        if (current.phase === 'completed' || current.phase === 'failed') {
          return gitAuthorityCandidateApplyJournalObservation(journal);
        }
        try {
          if (current.phase === 'prepared') {
            ensureExactIndexPublication(repositoryRoot, parameters.candidate);
            options.testAfterCrashPoint?.('index-publication');
            journal = advanceGitAuthorityCandidateApplyJournal(
              runtime,
              journal,
              {
                phase: 'index-published',
                commitHash: null,
                failure: null,
              },
            );
            continue;
          }
          if (current.phase === 'index-published') {
            assertExactIndexPublished(repositoryRoot, parameters.candidate);
            const commitHash = createExactCommitObject(
              repositoryRoot,
              parameters,
              journal.commitMessage,
            );
            options.testAfterCrashPoint?.('commit-object');
            journal = advanceGitAuthorityCandidateApplyJournal(
              runtime,
              journal,
              {
                phase: 'commit-created',
                commitHash,
                failure: null,
              },
            );
            continue;
          }
          if (current.phase === 'commit-created') {
            assertExactIndexPublished(repositoryRoot, parameters.candidate);
            assertExactCommitObject(
              repositoryRoot,
              parameters,
              journal.commitMessage,
              current.commitHash!,
            );
            journal = advanceGitAuthorityCandidateApplyJournal(
              runtime,
              journal,
              {
                phase: 'ref-update-prepared',
                commitHash: current.commitHash,
                failure: null,
              },
            );
            continue;
          }
          if (current.phase === 'ref-update-prepared') {
            assertExactCommitObject(
              repositoryRoot,
              parameters,
              journal.commitMessage,
              current.commitHash!,
            );
            ensureExactRefUpdate(
              repositoryRoot,
              parameters,
              current.commitHash!,
            );
            options.testAfterCrashPoint?.('ref-update');
            journal = advanceGitAuthorityCandidateApplyJournal(
              runtime,
              journal,
              {
                phase: 'ref-updated',
                commitHash: current.commitHash,
                failure: null,
              },
            );
            continue;
          }
          if (current.phase === 'ref-updated') {
            assertExactTerminalGitState(
              repositoryRoot,
              parameters,
              current.commitHash!,
            );
            journal = advanceGitAuthorityCandidateApplyJournal(
              runtime,
              journal,
              {
                phase: 'completed',
                commitHash: current.commitHash,
                failure: null,
              },
            );
            options.testAfterCrashPoint?.('terminal');
            continue;
          }
          throw operationInvalid();
        } catch (error) {
          if (!isNaturalGitStateFailure(error)) throw error;
          journal = recordNaturalFailure(
            runtime,
            repositoryRoot,
            parameters,
            journal,
            error,
          );
        }
      }
    },
  });
}

function pendingObservation(
  parameters: GitAuthorityCandidateApplyParametersV1,
): GitAuthorityCandidateApplyObservationV1 {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'git-authority-candidate-apply-observation.v1',
    phase: 'pending',
    candidateDigest: parameters.candidateDigest,
    parametersDigest: gitAuthorityCandidateApplyParametersDigest(parameters),
    targetRef: parameters.candidate.targetRef,
    expectedOldCommit: parameters.candidate.expectedOldCommit,
    resultTree: parameters.candidate.resultTree,
    challengeId: null,
    operationId: null,
    approvalMethod: null,
    approvalSubjectDigest: null,
    preparedGrantRecordDigest: null,
    commitHash: null,
    failure: null,
    journalDigest: null,
  });
}

function readExactPreparedGrant(
  paths: ReturnType<typeof grantStorePaths>,
  challengeId: string,
  operationId: string,
  subject: ApprovalSubject,
  parameters: GitAuthorityCandidateApplyParametersV1,
): PreparedGrantRecord {
  const record = readGrantRecord(paths, challengeId);
  const choice = record.challenge.choices.find(
    ({ choiceId }) => choiceId === subject.choiceId,
  );
  if (
    record.state !== 'prepared' ||
    record.operationId !== operationId ||
    canonicalJson(record.approvalSubject) !== canonicalJson(subject) ||
    choice?.transitionId !== GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID ||
    canonicalJson(choice.parameters) !== canonicalJson(parameters)
  ) {
    throw workflowError(
      'GIT_AUTHORITY_CANDIDATE_APPLY_GRANT_CHANGED',
      'The exact prepared Central Grant changed before Git Apply.',
      ExitCode.staleState,
    );
  }
  return record;
}

function assertJournalBinding(
  journal: GitAuthorityCandidateApplyJournalV1,
  parameters: GitAuthorityCandidateApplyParametersV1,
  challengeId: string,
  operationId: string,
  approvalSubject?: ApprovalSubject,
  preparedGrantRecordDigest?: `sha256:${string}`,
): void {
  if (
    canonicalJson(journal.parameters) !== canonicalJson(parameters) ||
    journal.parametersDigest !==
      gitAuthorityCandidateApplyParametersDigest(parameters) ||
    journal.challengeId !== challengeId ||
    journal.operationId !== operationId ||
    journal.commitMessage !==
      exactCommitMessage(
        parameters,
        challengeId,
        operationId,
        journal.approvalSubjectDigest,
        journal.preparedGrantRecordDigest,
      ) ||
    (approvalSubject !== undefined &&
      (canonicalJson(journal.approvalSubject) !==
        canonicalJson(approvalSubject) ||
        journal.approvalSubjectDigest !==
          approvalSubjectDigest(approvalSubject))) ||
    (preparedGrantRecordDigest !== undefined &&
      journal.preparedGrantRecordDigest !== preparedGrantRecordDigest)
  ) {
    throw workflowError(
      'GIT_AUTHORITY_CANDIDATE_APPLY_JOURNAL_CHANGED',
      'The durable Git Apply operation no longer matches its exact Central Grant.',
      ExitCode.staleState,
    );
  }
}

function ensureExactIndexPublication(
  repositoryRoot: string,
  candidate: ImmutableGitCandidateV1,
): void {
  const ref = readRef(repositoryRoot, candidate.targetRef);
  const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const indexTree = runGit(repositoryRoot, ['write-tree']).trim();
  if (
    ref !== candidate.expectedOldCommit ||
    head !== candidate.expectedOldCommit
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_REF_CHANGED');
  }
  if (indexTree === candidate.resultTree) {
    assertExactIndexPublished(repositoryRoot, candidate);
    return;
  }
  if (indexTree !== candidate.indexTree) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
  }
  verifyImmutableGitCandidateAgainstRepository(repositoryRoot, candidate);
  stageExactPaths(
    repositoryRoot,
    candidate.expectedOldCommit,
    candidate.manifest.files.map(({ path: filePath }) => filePath),
    {
      expectedTree: candidate.resultTree,
      expectedPreviousIndexTree: candidate.indexTree,
    },
  );
  assertExactIndexPublished(repositoryRoot, candidate);
}

function assertExactIndexPublished(
  repositoryRoot: string,
  candidate: ImmutableGitCandidateV1,
): void {
  const expectedPaths = candidate.manifest.files.map(
    ({ path: filePath }) => filePath,
  );
  const ref = readRef(repositoryRoot, candidate.targetRef);
  const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const indexTree = runGit(repositoryRoot, ['write-tree']).trim();
  const changedPaths = listChangedPaths(
    repositoryRoot,
    candidate.expectedOldCommit,
  );
  const unstaged = nulPaths(
    runGit(repositoryRoot, ['diff', '--name-only', '-z', '--']),
  );
  const staged = nulPaths(
    runGit(repositoryRoot, [
      'diff',
      '--cached',
      '--name-only',
      '-z',
      candidate.expectedOldCommit,
      '--',
    ]),
  );
  if (
    ref !== candidate.expectedOldCommit ||
    head !== candidate.expectedOldCommit ||
    indexTree !== candidate.resultTree ||
    canonicalJson(changedPaths) !== canonicalJson(expectedPaths) ||
    canonicalJson(staged) !== canonicalJson(expectedPaths) ||
    unstaged.length !== 0
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
  }
}

function createExactCommitObject(
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  commitMessage: string,
): string {
  const trailers = commitMessage
    .slice(parameters.commitSubject.length + 2)
    .trimEnd();
  const hash = runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      parameters.candidate.resultTree,
      '-p',
      parameters.candidate.expectedOldCommit,
      '-m',
      parameters.commitSubject,
      '-m',
      trailers,
    ],
    commitEnvironment(parameters),
  ).trim();
  assertExactCommitObject(repositoryRoot, parameters, commitMessage, hash);
  return hash;
}

function assertExactCommitObject(
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  commitMessage: string,
  commitHash: string,
): void {
  const facts = commitFacts(repositoryRoot, commitHash);
  if (
    facts.hash !== commitHash ||
    facts.parents.length !== 1 ||
    facts.parents[0] !== parameters.candidate.expectedOldCommit ||
    facts.tree !== parameters.candidate.resultTree ||
    facts.message !== commitMessage ||
    createExactCommitObjectUnchecked(
      repositoryRoot,
      parameters,
      commitMessage,
    ) !== commitHash
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_COMMIT_CHANGED');
  }
}

function createExactCommitObjectUnchecked(
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  commitMessage: string,
): string {
  const trailers = commitMessage
    .slice(parameters.commitSubject.length + 2)
    .trimEnd();
  return runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      parameters.candidate.resultTree,
      '-p',
      parameters.candidate.expectedOldCommit,
      '-m',
      parameters.commitSubject,
      '-m',
      trailers,
    ],
    commitEnvironment(parameters),
  ).trim();
}

function ensureExactRefUpdate(
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  commitHash: string,
): void {
  const current = readRef(repositoryRoot, parameters.candidate.targetRef);
  if (current === commitHash) {
    assertExactTerminalGitState(repositoryRoot, parameters, commitHash);
    return;
  }
  if (current !== parameters.candidate.expectedOldCommit) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_REF_CHANGED');
  }
  assertExactIndexPublished(repositoryRoot, parameters.candidate);
  updateManagedRef(
    repositoryRoot,
    parameters.candidate.expectedOldCommit,
    commitHash,
    parameters.candidate.targetRef,
  );
  assertExactTerminalGitState(repositoryRoot, parameters, commitHash);
}

function assertExactTerminalGitState(
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  commitHash: string,
): void {
  const discovered = discoverRepository(repositoryRoot);
  const ref = readRef(repositoryRoot, parameters.candidate.targetRef);
  const indexTree = runGit(repositoryRoot, ['write-tree']).trim();
  if (
    discovered.head !== commitHash ||
    discovered.tree !== parameters.candidate.resultTree ||
    ref !== commitHash ||
    indexTree !== parameters.candidate.resultTree ||
    discovered.statusEntries.length !== 0
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_POSTSTATE_CHANGED');
  }
}

function recordNaturalFailure(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  journal: GitAuthorityCandidateApplyJournalV1,
  error: WorkflowError,
): GitAuthorityCandidateApplyJournalV1 {
  const current = journal.entries.at(-1)!;
  const ref = readRef(repositoryRoot, parameters.candidate.targetRef);
  const indexTree = runGit(repositoryRoot, ['write-tree']).trim();
  if (
    ref === parameters.candidate.expectedOldCommit &&
    indexTree === parameters.candidate.resultTree
  ) {
    rollbackExactStaging(
      repositoryRoot,
      parameters.candidate.indexTree,
      parameters.candidate.resultTree,
      error,
    );
  }
  const commitHash = current.commitHash;
  const failure: GitAuthorityCandidateApplyFailureV1 = Object.freeze({
    schemaVersion: 1,
    kind: 'git-authority-candidate-apply-failure.v1',
    code: normalizedFailureCode(error.code),
    observedStateDigest: observedGitStateDigest(
      repositoryRoot,
      parameters.candidate.targetRef,
    ),
  });
  return advanceGitAuthorityCandidateApplyJournal(runtime, journal, {
    phase: 'failed',
    commitHash,
    failure,
  });
}

function exactCommitMessage(
  parameters: GitAuthorityCandidateApplyParametersV1,
  challengeId: string,
  operationId: string,
  subjectDigest: `sha256:${string}`,
  preparedRecordDigest: `sha256:${string}`,
): string {
  return [
    parameters.commitSubject,
    '',
    `Transition: ${GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID}`,
    `Candidate: ${parameters.candidateDigest}`,
    `Grant-Challenge: ${challengeId}`,
    `Grant-Operation: ${operationId}`,
    `Approval-Subject: ${subjectDigest}`,
    `Prepared-Grant: ${preparedRecordDigest}`,
    '',
  ].join('\n');
}

function commitEnvironment(
  parameters: GitAuthorityCandidateApplyParametersV1,
): NodeJS.ProcessEnv {
  return {
    GIT_AUTHOR_NAME: parameters.commitIdentity.name,
    GIT_AUTHOR_EMAIL: parameters.commitIdentity.email,
    GIT_COMMITTER_NAME: parameters.commitIdentity.name,
    GIT_COMMITTER_EMAIL: parameters.commitIdentity.email,
    GIT_AUTHOR_DATE: parameters.commitTimestamp,
    GIT_COMMITTER_DATE: parameters.commitTimestamp,
  };
}

function observedGitStateDigest(
  repositoryRoot: string,
  targetRef: string,
): `sha256:${string}` {
  const discovered = discoverRepository(repositoryRoot);
  return grantSha256(
    `workflow.git-authority-candidate-apply-observed-state.v1\n${canonicalJson({
      head: discovered.head,
      tree: discovered.tree,
      targetRef,
      targetRefValue: readRef(repositoryRoot, targetRef),
      indexTree: runGit(repositoryRoot, ['write-tree']).trim(),
      worktreeStateDigest: grantSha256(
        fingerprintWorkingState(
          repositoryRoot,
          discovered.head,
          discovered.statusEntries,
        ),
      ),
    })}`,
  );
}

function readRef(repositoryRoot: string, targetRef: string): string {
  return runGit(
    repositoryRoot,
    ['rev-parse', '--verify', targetRef],
    true,
  ).trim();
}

function nulPaths(value: string): readonly string[] {
  return Object.freeze(value.split('\0').filter(Boolean).sort());
}

function isNaturalGitStateFailure(error: unknown): error is WorkflowError {
  if (!(error instanceof WorkflowError)) return false;
  return (
    error.code.startsWith('IMMUTABLE_GIT_CANDIDATE_') ||
    [
      'FINISH_PATHS_CHANGED',
      'STAGING_ALREADY_PRESENT',
      'FINALIZE_PROJECTION_CHANGED',
      'STAGING_INDEX_DIVERGED',
      'STAGED_PATHS_MISMATCH',
      'WORKTREE_INDEX_MISMATCH',
      'COMMIT_REF_UPDATE_FAILED',
      'GIT_COMMAND_FAILED',
      'GIT_AUTHORITY_CANDIDATE_APPLY_REF_CHANGED',
      'GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED',
      'GIT_AUTHORITY_CANDIDATE_APPLY_COMMIT_CHANGED',
      'GIT_AUTHORITY_CANDIDATE_APPLY_POSTSTATE_CHANGED',
    ].includes(error.code)
  );
}

function normalizedFailureCode(code: string): string {
  const normalized = code.toLowerCase().replaceAll('_', '-');
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(normalized)
    ? normalized
    : 'git-state-changed';
}

function gitStateChanged(code: string): WorkflowError {
  return workflowError(
    code,
    'The exact Git authority candidate state changed during Apply.',
    ExitCode.staleState,
  );
}

function parametersInvalid() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_PARAMETERS_INVALID',
    'Exact Git authority candidate Apply parameters are invalid.',
    ExitCode.guard,
  );
}

function operationInvalid() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_OPERATION_INVALID',
    'The exact Git authority candidate Apply operation is invalid.',
    ExitCode.guard,
  );
}
