/**
 * Applies approved Git candidates and recovers exact ref and index
 * publication.
 *
 * Invariants:
 * - The Central Grant approval subject must remain unchanged before Git
 *   Apply.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../foundation/canonical-json/contract-values.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../foundation/errors/errors.ts';
import {
  approvalSubjectDigest,
  type ApprovalSubject,
} from '../modules/authority/grant-core.ts';
import {
  assertGitAuthorityCandidateApplyParameters,
  assertGitAuthorityCandidateBaseAuthorityContext,
  createGitAuthorityCandidateBaseAuthorityContext,
  gitAuthorityCandidateApplyParametersDigest,
  GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID,
  type GitAuthorityCandidateApplyFailureV1,
  type GitAuthorityCandidateApplyObservationV1,
  type GitAuthorityCandidateApplyParametersV1,
  type GitAuthorityCandidateApplyPort,
  type GitAuthorityCandidateBaseAuthorityContextV1,
} from '../modules/authority/git-authority-candidate-apply-grant.ts';
import {
  parseImmutableGitCandidate,
  type ImmutableGitCandidateV1,
} from '../modules/authority/immutable-git-candidate.ts';
import { verifyImmutableGitCandidateAgainstRepository } from './immutable-git-candidate-production.ts';
import { grantSha256 } from '../modules/authority/grant-primitives.ts';
import { ensurePlainDirectory } from '../runtime/repository-transaction/filesystem-safety.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
  runGit,
  runGitBuffer,
  runGitWithEnvironment,
} from '../runtime/repository-transaction/git.ts';
import {
  commitFacts,
  gitAuthorityCandidateApplyCommitMessage,
  resolveCommitIdentity,
  updateManagedRef,
} from '../runtime/repository-transaction/git-transitions.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../runtime/storage-journal/grant-store.ts';
import {
  grantRecordDigest,
  type PreparedGrantRecord,
} from '../modules/authority/grant-records.ts';
import {
  advanceGitAuthorityCandidateApplyJournal,
  createGitAuthorityCandidateApplyJournal,
  gitAuthorityCandidateApplyStorePaths,
  gitAuthorityCandidateApplyJournalObservation,
  readGitAuthorityCandidateApplyJournal,
  readOptionalGitAuthorityCandidateApplyJournal,
  type GitAuthorityCandidateApplyJournalV2,
} from '../runtime/storage-journal/git-authority-candidate-apply-store.ts';
import { investigationRuntimePaths } from '../runtime/session-workspace/paths.ts';
import { runtimePaths } from '../runtime/session-workspace/session-store.ts';
import type { TransitionObservationContext } from '../modules/authority/grant-transition-registry.ts';

export type GitAuthorityCandidateApplyCrashPoint =
  | 'prepared'
  | 'index-publication'
  | 'index-publication-recorded'
  | 'index-lock-acquired'
  | 'commit-object'
  | 'ref-update'
  | 'terminal';

export type ProductionGitAuthorityCandidateApplyOptions = Readonly<{
  /** Direct integration seam; production composition never provides it. */
  testAfterCrashPoint?: (point: GitAuthorityCandidateApplyCrashPoint) => void;
  /** Direct concurrency seam immediately before the standard index lock. */
  testBeforeIndexPublicationLock?: () => void;
  /** Direct concurrency seam while the operation owns the standard lock. */
  testAfterIndexPublicationLock?: () => void;
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
  const baseAuthorityContext =
    createProductionGitAuthorityCandidateBaseAuthorityContext(
      repositoryRoot,
      candidate,
    );
  return assertGitAuthorityCandidateApplyParameters({
    schemaVersion: 1,
    kind: 'git-authority-candidate-apply-parameters.v1',
    candidate,
    candidateDigest: candidate.candidateDigest,
    baseAuthorityContext,
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
  const repositoryRoot = git.repositoryRoot;

  return Object.freeze({
    observe(
      parametersValue: GitAuthorityCandidateApplyParametersV1,
      context?: TransitionObservationContext,
    ) {
      const parameters =
        assertGitAuthorityCandidateApplyParameters(parametersValue);
      const { runtime, grantRuntimeRoot } = authorityRuntime(
        git.gitCommonDirectory,
        repositoryRoot,
        parameters,
      );
      if (context?.operationId === null || context === undefined) {
        assertSafeIndexMode(
          readExactIndexSnapshot(exactGitIndexPath(repositoryRoot)).mode,
        );
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
      const { runtime, grantRuntimeRoot } = authorityRuntime(
        git.gitCommonDirectory,
        repositoryRoot,
        parameters,
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
        const indexMode = readExactIndexSnapshot(
          exactGitIndexPath(repositoryRoot),
        ).mode;
        assertSafeIndexMode(indexMode);
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
          indexMode,
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
            assertExactPreRefGitState(
              repositoryRoot,
              parameters.candidate,
              journal.indexMode,
            );
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
            assertExactPreRefGitState(
              repositoryRoot,
              parameters.candidate,
              journal.indexMode,
            );
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
              journal.indexMode,
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
            assertExactCommitObject(
              repositoryRoot,
              parameters,
              journal.commitMessage,
              current.commitHash!,
            );
            ensureExactIndexPublicationAfterRef(
              runtime,
              repositoryRoot,
              parameters,
              current.commitHash!,
              context.operationId,
              journal.indexMode,
              options,
            );
            options.testAfterCrashPoint?.('index-publication');
            journal = advanceGitAuthorityCandidateApplyJournal(
              runtime,
              journal,
              {
                phase: 'index-published',
                commitHash: current.commitHash,
                failure: null,
              },
            );
            options.testAfterCrashPoint?.('index-publication-recorded');
            continue;
          }
          if (current.phase === 'index-published') {
            // The durable index-published entry is written only after the
            // exact ref/index/worktree poststate has been verified. Later Git
            // drift is a subsequent event and cannot rewrite this natural
            // completed result during Grant terminal recovery.
            removeExactIndexPublicationWitness(
              runtime,
              repositoryRoot,
              parameters.candidate,
              context.operationId,
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

export function createProductionGitAuthorityCandidateBaseAuthorityContext(
  cwd: string,
  candidateValue: ImmutableGitCandidateV1,
): GitAuthorityCandidateBaseAuthorityContextV1 {
  const candidate = parseImmutableGitCandidate(candidateValue);
  return readProductionGitBaseAuthorityContext(cwd, candidate.expectedOldCommit)
    .context;
}

export function readProductionGitBaseAuthorityContext(
  cwd: string,
  baseCommit: string,
): Readonly<{
  context: GitAuthorityCandidateBaseAuthorityContextV1;
  grantPolicyDocument: string;
}> {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const workflowConfig = readExactRegularBlob(
    repositoryRoot,
    baseCommit,
    'workflow/config.json',
  );
  const grantPolicy = readExactRegularBlob(
    repositoryRoot,
    baseCommit,
    'workflow/grant-policy.json',
  );
  const context = createGitAuthorityCandidateBaseAuthorityContext({
    schemaVersion: 1,
    kind: 'git-authority-candidate-base-authority-context.v1',
    baseCommit,
    workflowConfig: {
      path: 'workflow/config.json',
      objectId: workflowConfig.objectId,
      mode: '100644',
      contentDigest: workflowConfig.contentDigest,
      runtimeDirectory: parseBaseRuntimeDirectory(workflowConfig.document),
    },
    grantPolicy: {
      path: 'workflow/grant-policy.json',
      objectId: grantPolicy.objectId,
      mode: '100644',
      contentDigest: grantPolicy.contentDigest,
    },
  });
  return Object.freeze({
    context,
    grantPolicyDocument: grantPolicy.document,
  });
}

export function readProductionGitAuthorityCandidateBaseGrantPolicyDocument(
  cwd: string,
  parametersValue: GitAuthorityCandidateApplyParametersV1,
): string {
  const parameters =
    assertGitAuthorityCandidateApplyParameters(parametersValue);
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const observed = readExactRegularBlob(
    repositoryRoot,
    parameters.candidate.expectedOldCommit,
    parameters.baseAuthorityContext.grantPolicy.path,
  );
  const expected = parameters.baseAuthorityContext.grantPolicy;
  if (
    observed.objectId !== expected.objectId ||
    observed.contentDigest !== expected.contentDigest
  ) {
    throw authorityContextChanged();
  }
  assertExactBaseWorkflowConfig(repositoryRoot, parameters);
  return observed.document;
}

function authorityRuntime(
  gitCommonDirectory: string,
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
) {
  assertExactBaseWorkflowConfig(repositoryRoot, parameters);
  const runtimeDirectory =
    parameters.baseAuthorityContext.workflowConfig.runtimeDirectory;
  const runtime = investigationRuntimePaths(
    gitCommonDirectory,
    runtimeDirectory,
  );
  return {
    runtime,
    grantRuntimeRoot: runtimePaths(gitCommonDirectory, runtimeDirectory).root,
  };
}

function assertExactBaseWorkflowConfig(
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
): void {
  const expected = assertGitAuthorityCandidateBaseAuthorityContext(
    parameters.baseAuthorityContext,
    parameters.candidate.expectedOldCommit,
  ).workflowConfig;
  const observed = readExactRegularBlob(
    repositoryRoot,
    parameters.candidate.expectedOldCommit,
    expected.path,
  );
  if (
    observed.objectId !== expected.objectId ||
    observed.contentDigest !== expected.contentDigest ||
    parseBaseRuntimeDirectory(observed.document) !== expected.runtimeDirectory
  ) {
    throw authorityContextChanged();
  }
}

function readExactRegularBlob(
  repositoryRoot: string,
  commit: string,
  filePath: 'workflow/config.json' | 'workflow/grant-policy.json',
): Readonly<{
  objectId: string;
  contentDigest: `sha256:${string}`;
  document: string;
}> {
  const listing = exactUtf8(
    runGitBuffer(repositoryRoot, ['ls-tree', '-z', commit, '--', filePath]),
  );
  const match = /^100644 blob ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]+)\0$/u.exec(
    listing,
  );
  if (match?.[2] !== filePath) throw authorityContextChanged();
  const objectId = match[1]!;
  const bytes = runGitBuffer(repositoryRoot, ['cat-file', 'blob', objectId]);
  const observedObjectId = exactUtf8(
    runGitBuffer(repositoryRoot, ['hash-object', '--stdin'], { input: bytes }),
  ).trim();
  if (observedObjectId !== objectId) throw authorityContextChanged();
  return Object.freeze({
    objectId,
    contentDigest: grantSha256(bytes),
    document: exactUtf8(bytes),
  });
}

function parseBaseRuntimeDirectory(document: string): string {
  let value: unknown;
  try {
    value = JSON.parse(document) as unknown;
  } catch {
    throw authorityContextChanged();
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.runtimeDirectory !== 'string' ||
    value.runtimeDirectory.length === 0 ||
    value.runtimeDirectory !== value.runtimeDirectory.normalize('NFC') ||
    value.runtimeDirectory.startsWith('/') ||
    value.runtimeDirectory.endsWith('/') ||
    value.runtimeDirectory
      .split('/')
      .some(
        (segment) => segment === '' || segment === '.' || segment === '..',
      ) ||
    /[\0\\]/u.test(value.runtimeDirectory)
  ) {
    throw authorityContextChanged();
  }
  return value.runtimeDirectory;
}

function exactUtf8(value: Buffer): string {
  const decoded = value.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(value)) {
    throw authorityContextChanged();
  }
  return decoded;
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
  const record = createFileGrantRecordStore(paths).readGrantRecord(challengeId);
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
  journal: GitAuthorityCandidateApplyJournalV2,
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

function assertExactPreRefGitState(
  repositoryRoot: string,
  candidate: ImmutableGitCandidateV1,
  expectedIndexMode: number,
): void {
  const indexMode = readExactIndexSnapshot(
    exactGitIndexPath(repositoryRoot),
  ).mode;
  if (indexMode !== expectedIndexMode) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
  }
  assertSafeIndexMode(expectedIndexMode);
  const ref = readRef(repositoryRoot, candidate.targetRef);
  const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const indexTree = runGit(repositoryRoot, ['write-tree']).trim();
  if (
    ref !== candidate.expectedOldCommit ||
    head !== candidate.expectedOldCommit
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_REF_CHANGED');
  }
  if (indexTree !== candidate.indexTree) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
  }
  verifyImmutableGitCandidateAgainstRepository(repositoryRoot, candidate);
}

function ensureExactIndexPublicationAfterRef(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  commitHash: string,
  operationId: string,
  expectedIndexMode: number,
  options: ProductionGitAuthorityCandidateApplyOptions,
): void {
  options.testBeforeIndexPublicationLock?.();
  publishExactIndexUnderStandardLock(
    runtime,
    repositoryRoot,
    parameters,
    commitHash,
    operationId,
    expectedIndexMode,
    options,
  );
  assertExactTerminalGitState(
    repositoryRoot,
    parameters,
    commitHash,
    expectedIndexMode,
  );
}

function publishExactIndexUnderStandardLock(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  commitHash: string,
  operationId: string,
  expectedIndexMode: number,
  options: ProductionGitAuthorityCandidateApplyOptions,
): void {
  const candidate = parameters.candidate;
  const indexPath = exactGitIndexPath(repositoryRoot);
  const lockPath = `${indexPath}.lock`;
  const witnessPath = exactIndexPublicationWitnessPath(runtime, operationId);
  const observedWitness = fs.lstatSync(witnessPath, {
    throwIfNoEntry: false,
  });
  const observedIndex = fs.lstatSync(indexPath, { throwIfNoEntry: false });
  if (
    observedWitness !== undefined &&
    sameFile(observedIndex, observedWitness)
  ) {
    const witness = ensureExactIndexPublicationWitness(
      repositoryRoot,
      witnessPath,
      candidate.resultTree,
      expectedIndexMode,
    );
    const publishedIndex = readExactIndexSnapshot(indexPath, [2]);
    if (
      !sameFile(publishedIndex, witness) ||
      publishedIndex.mode !== witness.mode ||
      !publishedIndex.bytes.equals(witness.bytes)
    ) {
      throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
    }
    return;
  }

  const preLockOriginal = readExactIndexSnapshot(indexPath);
  if (preLockOriginal.mode !== expectedIndexMode) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
  }
  assertSafeIndexMode(expectedIndexMode);
  const witness = ensureExactIndexPublicationWitness(
    repositoryRoot,
    witnessPath,
    candidate.resultTree,
    expectedIndexMode,
  );
  let preserveOwnedLockForCrash = false;
  let completed = false;
  try {
    let observedLock = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    if (observedLock === undefined) {
      try {
        fs.linkSync(witnessPath, lockPath);
        fsyncDirectory(path.dirname(lockPath));
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
      }
      observedLock = fs.lstatSync(lockPath, { throwIfNoEntry: false });
    }
    const linkedWitness = readExactIndexSnapshot(witnessPath, [2]);
    if (
      !sameFile(observedLock, linkedWitness) ||
      !linkedWitness.bytes.equals(witness.bytes)
    ) {
      if (observedLock !== undefined && !sameFile(observedLock, witness)) {
        throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
      }
      throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
    }
    options.testAfterIndexPublicationLock?.();
    try {
      options.testAfterCrashPoint?.('index-lock-acquired');
    } catch (error) {
      preserveOwnedLockForCrash = true;
      throw error;
    }

    const original = readExactIndexSnapshot(indexPath);
    const observedTree = indexTreeFromBytes(repositoryRoot, original.bytes);
    if (
      !sameFile(original, preLockOriginal) ||
      !original.bytes.equals(preLockOriginal.bytes) ||
      original.mode !== preLockOriginal.mode ||
      (observedTree !== candidate.indexTree &&
        observedTree !== candidate.resultTree)
    ) {
      throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
    }
    assertExactRefAndWorktree(repositoryRoot, parameters, commitHash);
    if (observedTree === candidate.resultTree) {
      completed = true;
      removeExactIndexPublicationWitness(
        runtime,
        repositoryRoot,
        candidate,
        operationId,
      );
      return;
    }

    const exactLinkedWitness = readExactIndexSnapshot(witnessPath, [2]);
    if (!exactLinkedWitness.bytes.equals(witness.bytes)) {
      throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
    }
    assertExactRefAndWorktree(repositoryRoot, parameters, commitHash);
    if (
      !sameFile(fs.lstatSync(indexPath, { throwIfNoEntry: false }), original) ||
      !sameFile(
        fs.lstatSync(lockPath, { throwIfNoEntry: false }),
        exactLinkedWitness,
      )
    ) {
      throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
    }
    fs.renameSync(lockPath, indexPath);
    fsyncDirectory(path.dirname(indexPath));
    const exactPublishedIndex = fs.lstatSync(indexPath, {
      throwIfNoEntry: false,
    });
    if (!sameFile(exactPublishedIndex, exactLinkedWitness)) {
      throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
    }
    completed = true;
  } finally {
    if (!completed && !preserveOwnedLockForCrash) {
      removeExactIndexPublicationWitness(
        runtime,
        repositoryRoot,
        candidate,
        operationId,
      );
    }
  }
}

function assertExactRefEffectBeforeIndex(
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  commitHash: string,
  allowPublishedIndex: boolean,
): void {
  const candidate = parameters.candidate;
  assertExactRefAndWorktree(repositoryRoot, parameters, commitHash);
  const indexTree = runGit(repositoryRoot, ['write-tree']).trim();
  if (
    indexTree !== candidate.indexTree &&
    (!allowPublishedIndex || indexTree !== candidate.resultTree)
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_POSTSTATE_CHANGED');
  }
}

function assertExactRefAndWorktree(
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  commitHash: string,
): void {
  const candidate = parameters.candidate;
  const ref = readRef(repositoryRoot, candidate.targetRef);
  const head = runGit(repositoryRoot, ['rev-parse', 'HEAD']).trim();
  const headTree = runGit(repositoryRoot, ['rev-parse', 'HEAD^{tree}']).trim();
  const worktreeMatchesResult = worktreeMatchesTree(
    repositoryRoot,
    candidate.resultTree,
  );
  if (ref !== commitHash || head !== commitHash) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_REF_CHANGED');
  }
  if (headTree !== candidate.resultTree || !worktreeMatchesResult) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_POSTSTATE_CHANGED');
  }
}

type ExactIndexSnapshot = Readonly<{
  bytes: Buffer;
  dev: number;
  ino: number;
  mode: number;
}>;

function exactIndexPublicationWitnessPath(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  operationId: string,
): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      operationId,
    )
  ) {
    throw operationInvalid();
  }
  const directory = path.join(
    gitAuthorityCandidateApplyStorePaths(runtime).indexPublications,
    operationId,
  );
  return path.join(directory, 'candidate.index');
}

function ensureExactIndexPublicationWitness(
  repositoryRoot: string,
  witnessPath: string,
  resultTree: string,
  indexMode: number,
): ExactIndexSnapshot {
  assertSafeIndexMode(indexMode);
  const expectedBytes = indexBytesForTree(repositoryRoot, resultTree);
  ensurePlainDirectory(path.dirname(witnessPath));
  const observed = fs.lstatSync(witnessPath, { throwIfNoEntry: false });
  if (observed === undefined) {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(
        witnessPath,
        fs.constants.O_RDWR |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          noFollowFlag(),
        indexMode,
      );
      fs.fchmodSync(descriptor, indexMode);
      fs.writeFileSync(descriptor, expectedBytes);
      fs.fsyncSync(descriptor);
    } catch (error) {
      if (!isNodeError(error) || error.code !== 'EEXIST') throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
    fsyncDirectory(path.dirname(witnessPath));
  }
  const witness = readExactIndexSnapshot(witnessPath, [1, 2]);
  if (
    witness.mode !== indexMode ||
    !witness.bytes.equals(expectedBytes) ||
    indexTreeFromBytes(repositoryRoot, witness.bytes) !== resultTree
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
  }
  return witness;
}

function removeExactIndexPublicationWitness(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  repositoryRoot: string,
  candidate: ImmutableGitCandidateV1,
  operationId: string,
): void {
  const witnessPath = exactIndexPublicationWitnessPath(runtime, operationId);
  const observed = fs.lstatSync(witnessPath, { throwIfNoEntry: false });
  if (observed === undefined) return;
  const witness = readExactIndexSnapshot(witnessPath, [1, 2]);
  if (
    !witness.bytes.equals(
      indexBytesForTree(repositoryRoot, candidate.resultTree),
    ) ||
    indexTreeFromBytes(repositoryRoot, witness.bytes) !== candidate.resultTree
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
  }
  const lockPath = `${exactGitIndexPath(repositoryRoot)}.lock`;
  const lock = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  if (sameFile(lock, witness)) {
    fs.unlinkSync(lockPath);
    fsyncDirectory(path.dirname(lockPath));
  }
  const repeated = fs.lstatSync(witnessPath, { throwIfNoEntry: false });
  if (!sameFile(repeated, witness)) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
  }
  fs.unlinkSync(witnessPath);
  fsyncDirectory(path.dirname(witnessPath));
}

function exactGitIndexPath(repositoryRoot: string): string {
  const raw = runGit(repositoryRoot, [
    'rev-parse',
    '--path-format=absolute',
    '--git-path',
    'index',
  ]);
  const resolved = raw.trim();
  if (
    raw !== `${resolved}\n` ||
    !path.isAbsolute(resolved) ||
    path.normalize(resolved) !== resolved ||
    fs.realpathSync(path.dirname(resolved)) !== path.dirname(resolved)
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
  }
  return resolved;
}

function readExactIndexSnapshot(
  indexPath: string,
  allowedLinkCounts: readonly number[] = [1],
): ExactIndexSnapshot {
  const before = fs.lstatSync(indexPath, { throwIfNoEntry: false });
  if (
    !before?.isFile() ||
    before.isSymbolicLink() ||
    !allowedLinkCounts.includes(before.nlink)
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
  }
  const descriptor = fs.openSync(
    indexPath,
    fs.constants.O_RDONLY | noFollowFlag(),
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      !allowedLinkCounts.includes(opened.nlink) ||
      !sameFile(before, opened)
    ) {
      throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
    }
    const bytes = fs.readFileSync(descriptor);
    const after = fs.lstatSync(indexPath, { throwIfNoEntry: false });
    if (!sameFile(after, opened) || opened.size !== bytes.length) {
      throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
    }
    return Object.freeze({
      bytes,
      dev: opened.dev,
      ino: opened.ino,
      mode: opened.mode & 0o7777,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function indexBytesForTree(repositoryRoot: string, tree: string): Buffer {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'git-authority-apply-index-'),
  );
  const indexPath = path.join(temporaryDirectory, 'index');
  const environment = { GIT_INDEX_FILE: indexPath };
  try {
    runGitWithEnvironment(repositoryRoot, ['read-tree', tree], environment);
    if (
      runGitWithEnvironment(
        repositoryRoot,
        ['write-tree'],
        environment,
      ).trim() !== tree
    ) {
      throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
    }
    return fs.readFileSync(indexPath);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function indexTreeFromBytes(repositoryRoot: string, bytes: Buffer): string {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'git-authority-apply-index-'),
  );
  const indexPath = path.join(temporaryDirectory, 'index');
  try {
    fs.writeFileSync(indexPath, bytes, { flag: 'wx', mode: 0o600 });
    return runGitWithEnvironment(repositoryRoot, ['write-tree'], {
      GIT_INDEX_FILE: indexPath,
    }).trim();
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function sameFile(
  observed: Pick<fs.Stats, 'dev' | 'ino'> | undefined,
  expected: Pick<fs.Stats, 'dev' | 'ino'> | ExactIndexSnapshot,
): boolean {
  return (
    observed !== undefined &&
    observed.dev === expected.dev &&
    observed.ino === expected.ino
  );
}

function noFollowFlag(): number {
  return process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW;
}

function assertSafeIndexMode(mode: number): void {
  if (
    !Number.isInteger(mode) ||
    (mode & 0o600) !== 0o600 ||
    (mode & 0o7111) !== 0 ||
    (mode & 0o002) !== 0
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_INDEX_CHANGED');
  }
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

function worktreeMatchesTree(repositoryRoot: string, tree: string): boolean {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'git-authority-apply-index-'),
  );
  const environment = {
    GIT_INDEX_FILE: path.join(temporaryDirectory, 'index'),
  };
  try {
    runGitWithEnvironment(repositoryRoot, ['read-tree', tree], environment);
    return (
      runGitWithEnvironment(
        repositoryRoot,
        ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
        environment,
      ).length === 0
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
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
  expectedIndexMode: number,
): void {
  const current = readRef(repositoryRoot, parameters.candidate.targetRef);
  if (current === commitHash) {
    assertExactRefEffectBeforeIndex(
      repositoryRoot,
      parameters,
      commitHash,
      false,
    );
    return;
  }
  if (current !== parameters.candidate.expectedOldCommit) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_REF_CHANGED');
  }
  assertExactPreRefGitState(
    repositoryRoot,
    parameters.candidate,
    expectedIndexMode,
  );
  updateManagedRef(
    repositoryRoot,
    parameters.candidate.expectedOldCommit,
    commitHash,
    parameters.candidate.targetRef,
  );
  assertExactRefEffectBeforeIndex(
    repositoryRoot,
    parameters,
    commitHash,
    false,
  );
}

function assertExactTerminalGitState(
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  commitHash: string,
  expectedIndexMode: number,
): void {
  const discovered = discoverRepository(repositoryRoot);
  const ref = readRef(repositoryRoot, parameters.candidate.targetRef);
  const indexTree = runGit(repositoryRoot, ['write-tree']).trim();
  const indexMode = readExactIndexSnapshot(
    exactGitIndexPath(repositoryRoot),
    [1, 2],
  ).mode;
  if (
    discovered.head !== commitHash ||
    discovered.tree !== parameters.candidate.resultTree ||
    ref !== commitHash ||
    indexTree !== parameters.candidate.resultTree ||
    indexMode !== expectedIndexMode ||
    discovered.statusEntries.length !== 0
  ) {
    throw gitStateChanged('GIT_AUTHORITY_CANDIDATE_APPLY_POSTSTATE_CHANGED');
  }
}

function recordNaturalFailure(
  runtime: ReturnType<typeof investigationRuntimePaths>,
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  journal: GitAuthorityCandidateApplyJournalV2,
  error: WorkflowError,
): GitAuthorityCandidateApplyJournalV2 {
  const current = journal.entries.at(-1)!;
  removeExactIndexPublicationWitness(
    runtime,
    repositoryRoot,
    parameters.candidate,
    journal.operationId,
  );
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
  return `${gitAuthorityCandidateApplyCommitMessage(parameters.commitSubject, {
    candidateDigest: parameters.candidateDigest,
    challengeId,
    operationId,
    approvalSubjectDigest: subjectDigest,
    preparedGrantRecordDigest: preparedRecordDigest,
  })}\n`;
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
  const indexTree = indexTreeFromBytes(
    repositoryRoot,
    readExactIndexSnapshot(exactGitIndexPath(repositoryRoot)).bytes,
  );
  return grantSha256(
    `workflow.git-authority-candidate-apply-observed-state.v1\n${canonicalJson({
      head: discovered.head,
      tree: discovered.tree,
      targetRef,
      targetRefValue: readRef(repositoryRoot, targetRef),
      indexTree,
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
  return Object.freeze(
    value.split('\0').filter(Boolean).sort(compareCanonicalUtf8),
  );
}

function compareCanonicalUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
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

function authorityContextChanged() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_AUTHORITY_CONTEXT_CHANGED',
    'The exact base Git authority context is missing, unsafe, or changed.',
    ExitCode.staleState,
  );
}

function operationInvalid() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_OPERATION_INVALID',
    'The exact Git authority candidate Apply operation is invalid.',
    ExitCode.guard,
  );
}
