/**
 * Creates managed commit objects and performs guarded managed ref updates.
 *
 * Invariants:
 * - Commit trees, parents, identities, and messages use the same exact command arguments.
 * - Ref updates keep compare-and-swap expectations and current failure behavior.
 */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  type DocumentationClosureRecord,
  encodeDocumentationClosure,
} from '../managed-documents/contracts/documentation-closure.ts';
import {
  type AmendmentProvenance,
  amendPlanCommitTrailers,
} from './git-commit-messages.ts';
import {
  resolveCommitIdentity,
  validateCommitSubject,
} from './git-transition-values.ts';
import { runGit, runGitBuffer, runGitWithEnvironment } from './git.ts';

export function createManagedCommitObject(
  repositoryRoot: string,
  tree: string,
  parent: string,
  subject: string,
  changeId: string,
  taskId: string,
  environment: NodeJS.ProcessEnv = process.env,
  documentationClosure: DocumentationClosureRecord | null = null,
): string {
  validateCommitSubject(subject);
  const identity = resolveCommitIdentity(repositoryRoot, environment);
  return runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      subject,
      ...(documentationClosure === null
        ? []
        : ['-m', encodeDocumentationClosure(documentationClosure)]),
      '-m',
      `Change: ${changeId}\nTask: ${taskId}`,
    ],
    identity,
  ).trim();
}

export function createPlanningCommitObject(
  repositoryRoot: string,
  tree: string,
  parent: string,
  changeId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const subject = `Plan ${changeId}`;
  validateCommitSubject(subject);
  const identity = resolveCommitIdentity(repositoryRoot, environment);
  return runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      subject,
      '-m',
      `Change: ${changeId}\nTransition: plan`,
    ],
    identity,
  ).trim();
}

export function createRouteCommitObject(
  repositoryRoot: string,
  tree: string,
  parent: string,
  routingReview: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!/^[0-9a-f]{64}$/.test(routingReview)) {
    throw workflowError(
      'CHANGE_ROUTING_REVIEW_DIGEST_INVALID',
      'A route commit requires one exact review digest.',
      ExitCode.guard,
    );
  }
  const subject = 'Route managed changes';
  validateCommitSubject(subject);
  const identity = resolveCommitIdentity(repositoryRoot, environment);
  return runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      subject,
      '-m',
      `Transition: route\nRouting-Review: ${routingReview}`,
    ],
    identity,
  ).trim();
}

export function createArchiveCommitObject(
  repositoryRoot: string,
  tree: string,
  parent: string,
  changeId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const subject = `Archive ${changeId}`;
  validateCommitSubject(subject);
  const identity = resolveCommitIdentity(repositoryRoot, environment);
  return runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      subject,
      '-m',
      `Change: ${changeId}\nTransition: archive`,
    ],
    identity,
  ).trim();
}

export function createSignedAuthorityCommitObject(
  repositoryRoot: string,
  tree: string,
  parent: string,
  subject: string,
  changeId: string,
  grantId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  validateCommitSubject(subject);
  const identity = resolveCommitIdentity(repositoryRoot, environment);
  return runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-S',
      '-m',
      subject,
      '-m',
      `Change: ${changeId}\nTransition: authority-maintenance\nGrant: ${grantId}`,
    ],
    identity,
  ).trim();
}

/**
 * Create the immutable commit object used by a v2 candidate bundle. Its Git
 * identity deliberately excludes an apply grant: a later one-shot grant signs
 * the candidate bundle digest and may be reissued without rebuilding or
 * resigning the candidate itself.
 */
export function createSignedAuthorityCandidateCommitObject(
  repositoryRoot: string,
  tree: string,
  parent: string,
  subject: string,
  changeId: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  validateCommitSubject(subject);
  const identity = resolveCommitIdentity(repositoryRoot, environment);
  return runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-S',
      '-m',
      subject,
      '-m',
      `Change: ${changeId}\nTransition: authority-candidate`,
    ],
    identity,
  ).trim();
}

export function updateManagedRef(
  repositoryRoot: string,
  expectedHead: string,
  commitHash: string,
  ref = 'HEAD',
): void {
  runGit(repositoryRoot, [
    'update-ref',
    '-m',
    'workflow managed commit',
    ref,
    commitHash,
    expectedHead,
  ]);
  if (runGit(repositoryRoot, ['rev-parse', ref]).trim() !== commitHash) {
    throw workflowError(
      'COMMIT_REF_UPDATE_FAILED',
      'The branch ref did not advance to the authorized commit.',
      ExitCode.staleState,
    );
  }
}

export function updateManagedRefs(
  repositoryRoot: string,
  updates: readonly {
    ref: string;
    expectedHead: string;
    commitHash: string;
  }[],
): void {
  runGitBuffer(
    repositoryRoot,
    [
      'update-ref',
      '--no-deref',
      '--stdin',
      '-z',
      '-m',
      'workflow managed commit',
    ],
    {
      input: Buffer.from(
        [
          'start',
          ...updates.flatMap(({ ref, expectedHead, commitHash }) => [
            `update ${ref}`,
            commitHash,
            expectedHead,
          ]),
          'prepare',
          'commit',
          '',
        ].join('\0'),
      ),
    },
  );
}

export function createAmendPlanCommitObject(
  repositoryRoot: string,
  tree: string,
  parent: string,
  changeId: string,
  provenance: AmendmentProvenance,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const subject = `Amend plan ${changeId}`;
  validateCommitSubject(subject);
  const identity = resolveCommitIdentity(repositoryRoot, environment);
  return runGitWithEnvironment(
    repositoryRoot,
    [
      'commit-tree',
      tree,
      '-p',
      parent,
      '-m',
      subject,
      '-m',
      amendPlanCommitTrailers(changeId, provenance),
    ],
    identity,
  ).trim();
}
