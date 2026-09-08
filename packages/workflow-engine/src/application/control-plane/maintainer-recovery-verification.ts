// maintainer recovery verification; repository effects remain bound by the public module.
import type {
  MaintainerRecoveryVerificationBindings,
  MaintainerRecoveryVerificationBindingsTypes,
} from './maintainer-recovery.ts';
type AuthoritySession =
  MaintainerRecoveryVerificationBindingsTypes['AuthoritySession'];
type AuthorityCommitJournal =
  MaintainerRecoveryVerificationBindingsTypes['AuthorityCommitJournal'];

export function createMaintainerRecoveryVerification(
  bindings: () => MaintainerRecoveryVerificationBindings,
) {
  function verifyCreatedAuthorityCommit(
    cwd: string,
    session: AuthoritySession,
    journal: AuthorityCommitJournal,
  ): void {
    const boundServices: MaintainerRecoveryVerificationBindings = bindings();
    const { assertJournalMatchesSession, recoveryError, requireCommitHash } =
      boundServices;

    assertJournalMatchesSession(journal, session);
    if (journal.state !== 'commit-created') {
      throw recoveryError(
        'AUTHORITY_JOURNAL_COMMIT_MISSING',
        'Authority commit verification requires a created commit object.',
      );
    }
    verifyJournaledCommit(cwd, session, journal, requireCommitHash(journal));
  }

  function verifyJournaledCommit(
    cwd: string,
    session: AuthoritySession,
    journal: AuthorityCommitJournal,
    commitHash: string,
  ): void {
    const boundServices: MaintainerRecoveryVerificationBindings = bindings();
    const {
      discoverRepository,
      recoveryError,
      commitFacts,
      parseManagedTrailers,
      digest,
      commitChangedPaths,
    } = boundServices;

    const git = discoverRepository(cwd);
    if (
      git.repositoryRealPath !== journal.repositoryRoot ||
      git.gitCommonDirectory !== session.gitCommonDirectory ||
      git.branch !== journal.branch
    ) {
      throw recoveryError(
        'AUTHORITY_RECOVERY_REPOSITORY_DIVERGED',
        'Authority recovery repository or branch differs from the journal.',
      );
    }
    const facts = commitFacts(git.repositoryRoot, commitHash);
    const expectedMessage = expectedAuthorityMessage(session, journal.subject);
    const trailers = parseManagedTrailers(facts.message);
    const exactTrailers =
      trailers?.kind === 'authority-candidate' &&
      trailers.changeId === journal.changeId;
    if (
      JSON.stringify(facts.parents) !== JSON.stringify([journal.baseCommit]) ||
      facts.tree !== journal.expectedTree ||
      facts.message !== `${expectedMessage}\n` ||
      digest(facts.message) !== journal.messageDigest ||
      JSON.stringify(commitChangedPaths(git.repositoryRoot, commitHash)) !==
        JSON.stringify(journal.allowedPaths) ||
      !exactTrailers
    ) {
      throw recoveryError(
        'AUTHORITY_COMMIT_INVALID',
        'The journaled commit does not match the exact authority transaction.',
      );
    }
    verifyCommitSignature(git.repositoryRoot, session, commitHash);
  }

  function expectedAuthorityMessage(
    session: AuthoritySession,
    subject: string,
  ): string {
    const boundServices: MaintainerRecoveryVerificationBindings = bindings();
    const { authorityCandidateCommitMessage } = boundServices;

    return authorityCandidateCommitMessage(subject, session.changeId);
  }

  function verifyCommitSignature(
    repositoryRoot: string,
    session: AuthoritySession,
    commitHash: string,
  ): void {
    const boundServices: MaintainerRecoveryVerificationBindings = bindings();
    const {
      runGit,
      parseMaintainerPolicy,
      recoveryError,
      fs,
      path,
      os,
      isPostApprovalAdmissionFailure,
    } = boundServices;

    const policyContent = runGit(repositoryRoot, [
      'show',
      `${session.baseCommit}:workflow/maintainer-policy.json`,
    ]);
    const policy = parseMaintainerPolicy(JSON.parse(policyContent));
    const policyBlob = runGit(repositoryRoot, [
      'rev-parse',
      `${session.baseCommit}:workflow/maintainer-policy.json`,
    ]).trim();
    const signer = policy.trustedSigners.find(
      ({ identity }) => identity === session.signer,
    );
    if (!signer || policyBlob !== session.policyBlob) {
      throw recoveryError(
        'AUTHORITY_COMMIT_SIGNER_INVALID',
        'The journaled signer is not trusted by the exact parent policy.',
      );
    }
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-authority-verify-'),
    );
    fs.chmodSync(temporaryDirectory, 0o700);
    const allowedSigners = path.join(temporaryDirectory, 'allowed-signers');
    try {
      fs.writeFileSync(
        allowedSigners,
        `${signer.identity} ${signer.publicKey}\n`,
        { mode: 0o600 },
      );
      const verification = runGit(repositoryRoot, [
        '-c',
        'gpg.format=ssh',
        '-c',
        `gpg.ssh.allowedSignersFile=${allowedSigners}`,
        'show',
        '-s',
        '--format=%G?%x00%GS%x00%GF',
        commitHash,
      ]).trimEnd();
      const [status, identity, fingerprint] = verification.split('\0');
      if (
        status !== 'G' ||
        identity !== signer.identity ||
        fingerprint !== signer.fingerprint
      ) {
        throw new Error('signature mismatch');
      }
    } catch (error) {
      if (isPostApprovalAdmissionFailure(error)) throw error;
      throw recoveryError(
        'AUTHORITY_COMMIT_SIGNATURE_INVALID',
        'The authority commit signature is missing, invalid, or untrusted.',
      );
    } finally {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  }
  return {
    verifyCreatedAuthorityCommit,
    verifyJournaledCommit,
    expectedAuthorityMessage,
  };
}
