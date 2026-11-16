/** Reads pinned profile/tree content and current filesystem facts only when requested by manifest rules. */
import fs from 'node:fs';
import path from 'node:path';
import { runGit, listChangedPaths } from '../repository-transaction/git.ts';
import type { MaintainerManifestObservations } from '../../modules/authority/maintainer-manifest.ts';
import { readFileAtRevision } from '../repository-transaction/git-command.ts';

export const maintainerManifestObservations: MaintainerManifestObservations = {
  readProfilesAtTrustBase(repositoryRoot, trustBaseCommit) {
    return readFileAtRevision(
      repositoryRoot,
      trustBaseCommit,
      'workflow/maintainer-profiles.json',
    );
  },
  listChangedPaths,
  readTrustBaseTreeEntry(repositoryRoot, trustBaseCommit, filePath) {
    return runGit(
      repositoryRoot,
      ['ls-tree', '-z', trustBaseCommit, '--', filePath],
      true,
    );
  },
  readWorktreeMetadata(repositoryRoot, filePath) {
    const absolute = path.join(repositoryRoot, filePath);
    const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stats) return undefined;
    return {
      regularFile: stats.isFile(),
      symbolicLink: stats.isSymbolicLink(),
      mode: stats.mode,
    };
  },
  readWorktreeBytes(repositoryRoot, filePath) {
    return fs.readFileSync(path.join(repositoryRoot, filePath));
  },
};
