/** Publishes the exact canonical attestation envelope as an annotated Git tag. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGitWithEnvironment } from './git.ts';
export function createAttestationTag(
  repositoryRoot: string,
  targetCommit: string,
  tagRef: string,
  message: string,
  signerIdentity: string,
): void {
  const temporaryDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-attestation-tag-'),
  );
  fs.chmodSync(temporaryDirectory, 0o700);
  const messagePath = path.join(temporaryDirectory, 'message');
  try {
    fs.writeFileSync(messagePath, message, { encoding: 'utf8', mode: 0o600 });
    runGitWithEnvironment(
      repositoryRoot,
      [
        'tag',
        '--annotate',
        '--cleanup=verbatim',
        '--file',
        messagePath,
        tagRef.slice('refs/tags/'.length),
        targetCommit,
      ],
      {
        GIT_COMMITTER_NAME: signerIdentity,
        GIT_COMMITTER_EMAIL: 'workflow-maintainer@users.noreply.github.com',
      },
    );
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
