/** Publishes the exact maintainer annotated tag through a private temporary file. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  runGit,
  runGitWithEnvironment,
  isPostApprovalAdmissionFailure,
} from './git.ts';

export function createMaintainerAuditTag(
  repositoryRoot: string,
  baseCommit: string,
  tagRef: string,
  message: string,
  signerIdentity: string,
): string {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-grant-tag-'),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  const messagePath = path.join(temporaryDirectory, 'message');
  try {
    fs.writeFileSync(messagePath, message, { encoding: 'utf8', mode: 0o600 });
    const shortName = tagRef.slice('refs/tags/'.length);
    runGitWithEnvironment(
      repositoryRoot,
      [
        'tag',
        '--annotate',
        '--cleanup=verbatim',
        '--file',
        messagePath,
        shortName,
        baseCommit,
      ],
      {
        GIT_COMMITTER_NAME: signerIdentity,
        GIT_COMMITTER_EMAIL: 'workflow-maintainer@users.noreply.github.com',
      },
    );
    return runGit(repositoryRoot, ['rev-parse', `${tagRef}^{tag}`]).trim();
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) throw error;
    if (
      runGit(repositoryRoot, ['rev-parse', '--verify', tagRef], true).trim()
    ) {
      throw grantExists(tagRef.slice(policyTagPrefixLength(tagRef)));
    }
    throw error;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function policyTagPrefixLength(tagRef: string): number {
  return tagRef.lastIndexOf('/') + 1;
}

function grantExists(grantId: string) {
  return workflowError(
    'MAINTAINER_GRANT_EXISTS',
    `Maintainer grant ${grantId} already has local state or an audit tag.`,
    ExitCode.conflict,
  );
}
