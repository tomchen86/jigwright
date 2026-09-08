// maintainer recovery journal; repository effects remain bound by the public module.
import type {
  MaintainerRecoveryJournalBindings,
  MaintainerRecoveryJournalBindingsTypes,
} from './maintainer-recovery.ts';
type AuthorityCommitJournal =
  MaintainerRecoveryJournalBindingsTypes['AuthorityCommitJournal'];
type AuthorityCommitJournalState =
  MaintainerRecoveryJournalBindingsTypes['AuthorityCommitJournalState'];
type AuthoritySession =
  MaintainerRecoveryJournalBindingsTypes['AuthoritySession'];

export function createMaintainerRecoveryJournal(
  bindings: () => MaintainerRecoveryJournalBindings,
) {
  function readAuthorityCommitJournal(
    gitCommonDirectory: string,
    requestedSessionId: string,
  ): AuthorityCommitJournal {
    const boundServices: MaintainerRecoveryJournalBindings = bindings();
    const {
      assertSessionId,
      path,
      maintainerGrantStorePaths,
      fs,
      recoveryError,
    } = boundServices;

    const sessionId = assertSessionId(requestedSessionId);
    const journalPath = path.join(
      maintainerGrantStorePaths(gitCommonDirectory).journals,
      `${sessionId}.json`,
    );
    const stats = fs.lstatSync(journalPath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw recoveryError(
        'AUTHORITY_JOURNAL_INVALID',
        'Authority recovery journal is missing or unsafe.',
      );
    }
    try {
      const raw = fs.readFileSync(journalPath, 'utf8');
      const value = JSON.parse(raw) as unknown;
      if (raw !== `${JSON.stringify(value)}\n`) {
        throw new Error('invalid journal');
      }
      if (!isJournal(value) || value.sessionId !== sessionId) {
        throw new Error('invalid journal');
      }
      return value;
    } catch {
      throw recoveryError(
        'AUTHORITY_JOURNAL_INVALID',
        'Authority recovery journal is malformed.',
      );
    }
  }

  function transitionJournal(
    gitCommonDirectory: string,
    expected: AuthorityCommitJournal,
    expectedState: AuthorityCommitJournalState,
    update: Partial<AuthorityCommitJournal> & {
      state: AuthorityCommitJournalState;
      updatedAt: string;
    },
  ): AuthorityCommitJournal {
    const boundServices: MaintainerRecoveryJournalBindings = bindings();
    const { recoveryError } = boundServices;

    const current = readAuthorityCommitJournal(
      gitCommonDirectory,
      expected.sessionId,
    );
    if (
      current.state !== expectedState ||
      JSON.stringify(current) !== JSON.stringify(expected)
    ) {
      throw recoveryError(
        'AUTHORITY_JOURNAL_DIVERGED',
        'Authority journal changed during its transaction.',
      );
    }
    const next = { ...current, ...update };
    writeJournal(gitCommonDirectory, next, false);
    return next;
  }

  function writeJournal(
    gitCommonDirectory: string,
    journal: AuthorityCommitJournal,
    create: boolean,
  ): void {
    const boundServices: MaintainerRecoveryJournalBindings = bindings();
    const { maintainerGrantStorePaths, fs, path, recoveryError, crypto } =
      boundServices;

    const directory = maintainerGrantStorePaths(gitCommonDirectory).journals;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStats = fs.lstatSync(directory);
    if (
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      fs.realpathSync(directory) !== path.resolve(directory)
    ) {
      throw recoveryError(
        'AUTHORITY_JOURNAL_DIRECTORY_UNSAFE',
        'Authority journal directory is unsafe.',
      );
    }
    fs.chmodSync(directory, 0o700);
    const target = path.join(directory, `${journal.sessionId}.json`);
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(journal)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      if (create) {
        fs.linkSync(temporary, target);
        fs.unlinkSync(temporary);
      } else {
        fs.renameSync(temporary, target);
      }
      const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
      fs.fsyncSync(directoryDescriptor);
      fs.closeSync(directoryDescriptor);
    } catch (error) {
      if (create && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw recoveryError(
          'AUTHORITY_JOURNAL_EXISTS',
          'Authority session already has a commit transaction.',
        );
      }
      throw error;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  }

  function assertJournalMatchesSession(
    journal: AuthorityCommitJournal,
    session: AuthoritySession,
  ): void {
    const boundServices: MaintainerRecoveryJournalBindings = bindings();
    const { canonicalJson, recoveryError } = boundServices;

    if (
      journal.sessionId !== session.sessionId ||
      journal.grantId !== session.grantId ||
      journal.changeId !== session.changeId ||
      journal.repositoryRoot !== session.repositoryRoot ||
      journal.branch !== session.branch ||
      journal.baseCommit !== session.baseCommit ||
      journal.policyBlob !== session.policyBlob ||
      journal.signer !== session.signer ||
      canonicalJson(journal.mandateBinding) !==
        canonicalJson(session.mandateBinding) ||
      JSON.stringify(journal.allowedPaths) !==
        JSON.stringify([...journal.allowedPaths].sort()) ||
      journal.allowedPaths.some(
        (entry) => !session.allowedPaths.includes(entry),
      )
    ) {
      throw recoveryError(
        'AUTHORITY_JOURNAL_SESSION_MISMATCH',
        'Authority journal does not match the pinned authority session.',
      );
    }
  }

  function isJournal(value: unknown): value is AuthorityCommitJournal {
    const boundServices: MaintainerRecoveryJournalBindings = bindings();
    const { isRecord, CURRENT_JOURNAL_KEYS, isPrefixedDigest, isTimestamp } =
      boundServices;

    if (!isRecord(value)) return false;
    return (
      hasExactKeys(value, CURRENT_JOURNAL_KEYS) &&
      value.schemaVersion === 4 &&
      hasValidJournalCore(value) &&
      (value.mandateBinding === null ||
        isJournalTaskMandateBinding(value.mandateBinding)) &&
      (value.externalAuditRoot === null ||
        typeof value.externalAuditRoot === 'string') &&
      (value.auditRepositoryId === null ||
        isPrefixedDigest(value.auditRepositoryId)) &&
      (value.casAuditRecordDigest === null ||
        isPrefixedDigest(value.casAuditRecordDigest)) &&
      (value.poststateAuditRecordDigest === null ||
        isPrefixedDigest(value.poststateAuditRecordDigest)) &&
      (value.consumeAuditRecordDigest === null ||
        isPrefixedDigest(value.consumeAuditRecordDigest)) &&
      (value.errorAuditRecordDigest === null ||
        isPrefixedDigest(value.errorAuditRecordDigest)) &&
      (value.rollbackAuditRecordDigest === null ||
        isPrefixedDigest(value.rollbackAuditRecordDigest)) &&
      (value.refUpdatedAt === null || isTimestamp(value.refUpdatedAt)) &&
      (value.poststateVerifiedAt === null ||
        isTimestamp(value.poststateVerifiedAt)) &&
      (value.consumedAt === null || isTimestamp(value.consumedAt)) &&
      (value.rollbackStartedAt === null ||
        isTimestamp(value.rollbackStartedAt)) &&
      (value.rolledBackAt === null || isTimestamp(value.rolledBackAt))
    );
  }

  function isJournalTaskMandateBinding(value: unknown): boolean {
    const boundServices: MaintainerRecoveryJournalBindings = bindings();
    const { isRecord, path } = boundServices;

    if (!isRecord(value)) return false;
    return (
      hasExactKeys(
        value,
        [
          'schemaVersion',
          'mandateTaskId',
          'mandateId',
          'mandateDigest',
          'changeId',
          'externalAuditRoot',
        ].sort(),
      ) &&
      value.schemaVersion === 1 &&
      typeof value.mandateTaskId === 'string' &&
      typeof value.mandateId === 'string' &&
      typeof value.mandateDigest === 'string' &&
      /^[0-9a-f]{64}$/.test(value.mandateDigest) &&
      typeof value.changeId === 'string' &&
      typeof value.externalAuditRoot === 'string' &&
      path.isAbsolute(value.externalAuditRoot) &&
      path.normalize(value.externalAuditRoot) === value.externalAuditRoot
    );
  }

  function hasValidJournalCore(value: Record<string, unknown>): boolean {
    const boundServices: MaintainerRecoveryJournalBindings = bindings();
    const { isObjectId, isTimestamp } = boundServices;

    return (
      [
        'preparing',
        'commit-created',
        'cas-prepared',
        'ref-updated',
        'rollback-prepared',
        'rolled-back',
        'consumed',
        'audited',
        'revoked',
      ].includes(String(value.state)) &&
      typeof value.sessionId === 'string' &&
      typeof value.grantId === 'string' &&
      typeof value.changeId === 'string' &&
      typeof value.repositoryRoot === 'string' &&
      typeof value.branch === 'string' &&
      typeof value.subject === 'string' &&
      typeof value.signer === 'string' &&
      Array.isArray(value.allowedPaths) &&
      value.allowedPaths.every((entry) => typeof entry === 'string') &&
      isObjectId(value.baseCommit) &&
      isObjectId(value.expectedTree) &&
      isObjectId(value.previousIndexTree) &&
      isObjectId(value.policyBlob) &&
      typeof value.messageDigest === 'string' &&
      /^[0-9a-f]{64}$/.test(value.messageDigest) &&
      (value.commitHash === null || isObjectId(value.commitHash)) &&
      (value.reason === null || typeof value.reason === 'string') &&
      isTimestamp(value.createdAt) &&
      isTimestamp(value.updatedAt)
    );
  }

  function hasExactKeys(
    value: Record<string, unknown>,
    expected: string[],
  ): boolean {
    const actual = Object.keys(value).sort();
    return (
      actual.length === expected.length &&
      actual.every((entry, index) => entry === expected[index])
    );
  }
  return {
    readAuthorityCommitJournal,
    transitionJournal,
    writeJournal,
    assertJournalMatchesSession,
  };
}
