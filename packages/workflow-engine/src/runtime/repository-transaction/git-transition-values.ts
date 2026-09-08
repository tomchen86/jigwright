/**
 * Validates commit subjects and identities and parses NUL-delimited Git output.
 *
 * Invariants:
 * - Control characters and unsafe identity forms remain rejected.
 * - Identity resolution retains current configuration precedence and error behavior.
 */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { runGit } from './git.ts';

export function validateCommitSubject(subject: string): void {
  if (
    !subject ||
    subject.trim() !== subject ||
    [...subject].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    }) ||
    /^(?:Change|Task|Transition|Grant):/i.test(subject)
  ) {
    throw workflowError(
      'INVALID_COMMIT_SUBJECT',
      'Managed commit subject must be one trimmed line without control characters or trailers.',
      ExitCode.usage,
    );
  }
}

export function resolveCommitIdentity(
  repositoryRoot: string,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const name =
    runGit(
      repositoryRoot,
      ['config', '--local', '--get', 'user.name'],
      true,
    ).trim() || environment.WORKFLOW_GIT_AUTHOR_NAME;
  const email =
    runGit(
      repositoryRoot,
      ['config', '--local', '--get', 'user.email'],
      true,
    ).trim() || environment.WORKFLOW_GIT_AUTHOR_EMAIL;
  if (!isSafeIdentity(name) || !isSafeIdentity(email)) {
    throw workflowError(
      'COMMIT_IDENTITY_REQUIRED',
      'Managed commit requires local Git identity or WORKFLOW_GIT_AUTHOR_NAME and WORKFLOW_GIT_AUTHOR_EMAIL.',
      ExitCode.unsafeEnvironment,
    );
  }
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

function isSafeIdentity(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 31 || codePoint === 127;
    })
  );
}

export function splitNull(value: string): string[] {
  return value.split('\0').filter(Boolean);
}
