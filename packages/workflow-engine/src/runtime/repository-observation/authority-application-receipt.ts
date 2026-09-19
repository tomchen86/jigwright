/** Observes receipt tag refs and annotated bytes at each requested Git phase. */
import type { AuthorityApplicationReceiptObservations } from '../../modules/authority/authority-application-receipt.ts';
import { runGit } from '../repository-transaction/git.ts';
import { createMaintainerAuditTag } from '../repository-transaction/maintainer-audit-tag.ts';
import { readTagObject } from '../repository-transaction/git-command.ts';

export const authorityApplicationReceiptRepository: Omit<
  AuthorityApplicationReceiptObservations,
  'verifySshDataSignature'
> = {
  readReceiptTagRefListing(repositoryRoot, prefix) {
    return runGit(repositoryRoot, [
      'for-each-ref',
      '--format=%(refname)',
      `${prefix}*`,
    ]);
  },
  readAnnotatedReceiptTag(repositoryRoot, ref) {
    return readTagObject(repositoryRoot, ref);
  },
  readReceiptTagObjectId(repositoryRoot, ref) {
    return runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${ref}^{tag}`,
    ]).trim();
  },
  resolveReceiptTagRef(repositoryRoot, ref) {
    return runGit(repositoryRoot, ['rev-parse', '--verify', ref], true).trim();
  },
  createMaintainerAuditTag,
};
