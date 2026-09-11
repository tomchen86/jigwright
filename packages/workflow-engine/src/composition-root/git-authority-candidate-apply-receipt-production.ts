/**
 * Publishes and verifies portable receipts for authorized Git candidate
 * application.
 *
 * Invariants:
 * - Portable application receipts require SSH approval evidence.
 */
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { verifySshSignatureWithPublicKey } from '../adapters/signing/ssh/maintainer-signer.ts';
import {
  approvalSubjectDigest,
  type GrantChoice,
} from '../modules/authority/grant-core.ts';
import {
  sshPortableApprovalEvidenceDigest,
  type SshPortableApprovalEvidenceV1,
} from '../modules/authority/grant-approval.ts';
import {
  assertGitAuthorityCandidateApplyParameters,
  assertGitAuthorityCandidateApplyResult,
  gitAuthorityCandidateApplyParametersDigest,
  gitAuthorityCandidateApplyStateBinding,
  GIT_AUTHORITY_CANDIDATE_APPLY_CONSEQUENCE_DIGEST,
  GIT_AUTHORITY_CANDIDATE_APPLY_PARAMETER_SCHEMA_DIGEST,
  GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID,
  type GitAuthorityCandidateApplyParametersV1,
} from '../modules/authority/git-authority-candidate-apply-grant.ts';
import {
  assertGitAuthorityCandidateApplyReceipt,
  canonicalGitAuthorityCandidateApplyReceipt,
  GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_TAG_PREFIX,
  gitAuthorityCandidateApplyReceiptTagRef,
  parseGitAuthorityCandidateApplyReceipt,
  type GitAuthorityCandidateApplyReceiptV1,
} from '../modules/authority/git-authority-candidate-apply-receipt.ts';
import { verifyImmutableGitCandidateObjects } from './immutable-git-candidate-production.ts';
import { parseGrantPolicyV2Document } from '../modules/authority/grant-policy.ts';
import { grantSha256 } from '../modules/authority/grant-primitives.ts';
import {
  discoverRepository,
  runGit,
  runGitBuffer,
} from '../runtime/repository-transaction/git.ts';
import {
  commitFacts,
  gitAuthorityCandidateApplyCommitMessage,
} from '../runtime/repository-transaction/git-transitions.ts';
import {
  grantRecordDigest,
  grantStorePaths,
  parseGrantRecord,
  projectPreparedGrantRecord,
  readGrantRecord,
  type TerminalGrantRecord,
} from '../runtime/storage-journal/grant-store.ts';
import {
  assertGitAuthorityCandidateApplyJournal,
  gitAuthorityCandidateApplyJournalObservation,
  readGitAuthorityCandidateApplyJournal,
  type GitAuthorityCandidateApplyJournalV2,
} from '../runtime/storage-journal/git-authority-candidate-apply-store.ts';
import { investigationRuntimePaths } from '../runtime/session-workspace/paths.ts';
import { runtimePaths } from '../runtime/session-workspace/session-store.ts';
import { readProductionGitBaseAuthorityContext } from './git-authority-candidate-apply-production.ts';

const TAGGER_NAME = 'Jigwright Central Grant';
const TAGGER_EMAIL = 'central-grant@jigwright.dev';
const ZERO_SHA1 = '0'.repeat(40);
const ZERO_SHA256 = '0'.repeat(64);

export type PublishGitAuthorityCandidateApplyReceiptOptions = Readonly<{
  /** Direct integration crash seam after the immutable tag object is made. */
  testAfterTagObject?: () => void;
  /** Direct integration crash seam after the tag ref CAS. */
  testAfterTagRefUpdate?: () => void;
}>;

export type VerifiedGitAuthorityCandidateApplyReceiptV1 = Readonly<{
  tagRef: string;
  tagObject: string;
  targetCommit: string;
  receipt: GitAuthorityCandidateApplyReceiptV1;
  terminalGrantRecord: TerminalGrantRecord;
  journal: GitAuthorityCandidateApplyJournalV2;
}>;

export function publishGitAuthorityCandidateApplyReceipt(
  cwd: string,
  parametersValue: GitAuthorityCandidateApplyParametersV1,
  challengeId: string,
  options: PublishGitAuthorityCandidateApplyReceiptOptions = {},
): VerifiedGitAuthorityCandidateApplyReceiptV1 {
  const repository = discoverRepository(cwd);
  const parameters =
    assertGitAuthorityCandidateApplyParameters(parametersValue);
  const tagRef = gitAuthorityCandidateApplyReceiptTagRef(challengeId);
  const terminal = readTerminalGrantRecord(
    repository.repositoryRoot,
    parameters,
    challengeId,
  );
  if (terminal.approvalSubject.approvalMethod !== 'ssh') {
    throw receiptNonPortable();
  }
  const receipt = createReceipt(
    repository.repositoryRoot,
    parameters,
    terminal,
  );
  const bindings = assertReceiptBindings(receipt);
  verifyHistoricalAuthority(
    repository.repositoryRoot,
    receipt,
    bindings.evidence,
  );
  verifyImmutableGitCandidateObjects(
    repository.repositoryRoot,
    receipt.parameters.candidate,
  );
  assertExactCommit(repository.repositoryRoot, receipt, bindings.journal);
  const existing = readDirectTagRef(repository.repositoryRoot, tagRef);
  if (existing !== '') {
    let verified: VerifiedGitAuthorityCandidateApplyReceiptV1;
    try {
      verified = readVerifiedGitAuthorityCandidateApplyReceipt(
        repository.repositoryRoot,
        tagRef,
      );
    } catch {
      throw receiptConflict();
    }
    if (canonicalJson(verified.receipt) !== canonicalJson(receipt)) {
      throw receiptConflict();
    }
    return verified;
  }
  const rawTag = canonicalTag(receipt);
  const tagObject = exactUtf8(
    runGitBuffer(repository.repositoryRoot, ['mktag'], {
      input: Buffer.from(rawTag, 'utf8'),
    }),
  ).trim();
  if (!isObjectId(tagObject, receipt.targetCommit.length)) {
    throw receiptInvalid();
  }
  options.testAfterTagObject?.();

  const zero = tagObject.length === 40 ? ZERO_SHA1 : ZERO_SHA256;
  try {
    runGit(repository.repositoryRoot, [
      'update-ref',
      '--no-deref',
      tagRef,
      tagObject,
      zero,
    ]);
  } catch {
    const raced = readDirectTagRef(repository.repositoryRoot, tagRef);
    if (raced !== tagObject) throw receiptConflict();
  }
  options.testAfterTagRefUpdate?.();
  const verified = readVerifiedGitAuthorityCandidateApplyReceipt(
    repository.repositoryRoot,
    tagRef,
  );
  if (canonicalJson(verified.receipt) !== canonicalJson(receipt)) {
    throw receiptConflict();
  }
  return verified;
}

export function readVerifiedGitAuthorityCandidateApplyReceipt(
  cwd: string,
  tagRefOrChallengeId: string,
): VerifiedGitAuthorityCandidateApplyReceiptV1 {
  try {
    const repositoryRoot = discoverRepository(cwd).repositoryRoot;
    const tagRef = tagRefOrChallengeId.startsWith('refs/')
      ? tagRefOrChallengeId
      : gitAuthorityCandidateApplyReceiptTagRef(tagRefOrChallengeId);
    let directObject: string;
    try {
      directObject = readDirectTagRef(repositoryRoot, tagRef);
    } catch {
      throw receiptInvalid();
    }
    if (directObject === '') throw receiptInvalid();
    const raw = exactUtf8(
      runGitBuffer(repositoryRoot, ['cat-file', 'tag', directObject]),
    );
    const boundary = raw.indexOf('\n\n');
    if (boundary < 0) throw receiptInvalid();
    const receipt = parseGitAuthorityCandidateApplyReceipt(
      raw.slice(boundary + 2),
    );
    if (
      tagRef !== gitAuthorityCandidateApplyReceiptTagRef(receipt.challengeId)
    ) {
      throw receiptInvalid();
    }
    const expectedRaw = canonicalTag(receipt);
    if (raw !== expectedRaw) throw receiptInvalid();
    const tagObject = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${directObject}^{tag}`,
    ]).trim();
    if (tagObject !== directObject) throw receiptInvalid();
    const targetCommit = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${directObject}^{commit}`,
    ]).trim();
    if (targetCommit !== receipt.targetCommit) throw receiptInvalid();
    const bindings = assertReceiptBindings(receipt);
    verifyHistoricalAuthority(repositoryRoot, receipt, bindings.evidence);
    verifyImmutableGitCandidateObjects(
      repositoryRoot,
      receipt.parameters.candidate,
    );
    assertExactCommit(repositoryRoot, receipt, bindings.journal);
    return Object.freeze({
      tagRef,
      tagObject,
      targetCommit,
      receipt,
      terminalGrantRecord: bindings.terminal,
      journal: bindings.journal,
    });
  } catch (error) {
    if (isReceiptError(error)) throw error;
    throw receiptInvalid();
  }
}

export function listVerifiedGitAuthorityCandidateApplyReceipts(
  cwd: string,
): readonly VerifiedGitAuthorityCandidateApplyReceiptV1[] {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const refs = runGit(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname)',
    `${GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_TAG_PREFIX}*`,
  ])
    .split('\n')
    .filter(Boolean)
    .sort();
  const receipts = refs.map((ref) =>
    readVerifiedGitAuthorityCandidateApplyReceipt(repositoryRoot, ref),
  );
  for (const select of [
    (receipt: VerifiedGitAuthorityCandidateApplyReceiptV1) =>
      receipt.receipt.challengeId,
    (receipt: VerifiedGitAuthorityCandidateApplyReceiptV1) =>
      receipt.receipt.operationId,
    (receipt: VerifiedGitAuthorityCandidateApplyReceiptV1) =>
      receipt.receipt.terminalGrantRecordDigest,
    (receipt: VerifiedGitAuthorityCandidateApplyReceiptV1) =>
      receipt.receipt.portableEvidenceDigest,
  ]) {
    const identities = receipts.map(select);
    if (new Set(identities).size !== identities.length) {
      throw receiptInvalid();
    }
  }
  return Object.freeze(receipts);
}

function createReceipt(
  repositoryRoot: string,
  expectedParameters: GitAuthorityCandidateApplyParametersV1,
  terminal: TerminalGrantRecord,
): GitAuthorityCandidateApplyReceiptV1 {
  const choice = selectedApplyChoice(terminal);
  const parameters =
    choice.parameters as GitAuthorityCandidateApplyParametersV1;
  if (canonicalJson(parameters) !== canonicalJson(expectedParameters)) {
    throw receiptInvalid();
  }
  const loaded = readProductionGitBaseAuthorityContext(
    repositoryRoot,
    parameters.candidate.expectedOldCommit,
  );
  if (
    canonicalJson(loaded.context) !==
    canonicalJson(parameters.baseAuthorityContext)
  ) {
    throw receiptInvalid();
  }
  const runtimeDirectory =
    parameters.baseAuthorityContext.workflowConfig.runtimeDirectory;
  const repository = discoverRepository(repositoryRoot);
  const journal = readGitAuthorityCandidateApplyJournal(
    investigationRuntimePaths(repository.gitCommonDirectory, runtimeDirectory),
    terminal.operationId,
  );
  const evidence = exactPortableEvidence(terminal);
  const targetCommit = journal.entries.at(-1)?.commitHash;
  if (targetCommit === null || targetCommit === undefined) {
    throw receiptInvalid();
  }
  return assertGitAuthorityCandidateApplyReceipt({
    schemaVersion: 1,
    kind: 'git-authority-candidate-apply-receipt.v1',
    transitionId: GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID,
    targetRef: parameters.candidate.targetRef,
    targetCommit,
    baseCommit: parameters.candidate.expectedOldCommit,
    baseTree: parameters.candidate.expectedOldTree,
    resultTree: parameters.candidate.resultTree,
    parameters,
    parametersDigest: gitAuthorityCandidateApplyParametersDigest(parameters),
    candidateDigest: parameters.candidateDigest,
    baseAuthorityContextDigest: parameters.baseAuthorityContext.contextDigest,
    challengeId: terminal.challenge.challengeId,
    challengeDigest: terminal.challenge.challengeDigest,
    operationId: terminal.operationId,
    poststateDigest: terminal.poststateDigest,
    approvalMethod: 'ssh',
    approvalSubjectDigest: approvalSubjectDigest(terminal.approvalSubject),
    preparedGrantRecordDigest: grantRecordDigest(
      projectPreparedGrantRecord(terminal),
    ),
    terminalGrantRecordDigest: grantRecordDigest(terminal),
    journalDigest: journal.journalDigest,
    portableEvidenceDigest: sshPortableApprovalEvidenceDigest(evidence),
    portablePayloadDigest: grantSha256(evidence.payload),
    portableSignatureDigest: grantSha256(evidence.signature),
    completedAt: terminal.completedAt,
    terminalGrantRecord: terminal,
    journal,
  });
}

function assertReceiptBindings(receipt: GitAuthorityCandidateApplyReceiptV1) {
  const terminal = parseGrantRecord(receipt.terminalGrantRecord);
  const journal = assertGitAuthorityCandidateApplyJournal(receipt.journal);
  if (terminal.state !== 'completed') throw receiptInvalid();
  const choice = selectedApplyChoice(terminal);
  const parameters =
    choice.parameters as GitAuthorityCandidateApplyParametersV1;
  const prepared = projectPreparedGrantRecord(terminal);
  const evidence = exactPortableEvidence(terminal);
  const terminalEntry = journal.entries.at(-1);
  const poststate = gitAuthorityCandidateApplyStateBinding(
    gitAuthorityCandidateApplyJournalObservation(journal),
  );
  if (
    receipt.transitionId !== choice.transitionId ||
    canonicalJson(receipt.parameters) !== canonicalJson(parameters) ||
    receipt.parametersDigest !==
      gitAuthorityCandidateApplyParametersDigest(parameters) ||
    receipt.challengeId !== terminal.challenge.challengeId ||
    receipt.challengeDigest !== terminal.challenge.challengeDigest ||
    receipt.operationId !== terminal.operationId ||
    receipt.poststateDigest !== terminal.poststateDigest ||
    receipt.approvalSubjectDigest !==
      approvalSubjectDigest(terminal.approvalSubject) ||
    receipt.preparedGrantRecordDigest !== grantRecordDigest(prepared) ||
    receipt.terminalGrantRecordDigest !== grantRecordDigest(terminal) ||
    receipt.journalDigest !== journal.journalDigest ||
    receipt.portableEvidenceDigest !==
      sshPortableApprovalEvidenceDigest(evidence) ||
    receipt.portablePayloadDigest !== grantSha256(evidence.payload) ||
    receipt.portableSignatureDigest !== grantSha256(evidence.signature) ||
    receipt.completedAt !== terminal.completedAt ||
    terminal.poststateDigest !== poststate.digest ||
    journal.challengeId !== receipt.challengeId ||
    journal.operationId !== receipt.operationId ||
    journal.approvalMethod !== 'ssh' ||
    journal.approvalSubjectDigest !== receipt.approvalSubjectDigest ||
    canonicalJson(journal.approvalSubject) !==
      canonicalJson(terminal.approvalSubject) ||
    journal.preparedGrantRecordDigest !== receipt.preparedGrantRecordDigest ||
    canonicalJson(journal.parameters) !== canonicalJson(parameters) ||
    terminalEntry?.phase !== 'completed' ||
    terminalEntry.commitHash !== receipt.targetCommit ||
    Date.parse(terminal.completedAt) < Date.parse(evidence.verifiedAt) ||
    !isExactApplyOutcome(terminal, journal)
  ) {
    throw receiptInvalid();
  }
  return Object.freeze({ terminal, journal, evidence });
}

function selectedApplyChoice(terminal: TerminalGrantRecord): GrantChoice {
  const choice = terminal.challenge.choices.find(
    ({ choiceId }) => choiceId === terminal.approvalSubject.choiceId,
  );
  if (
    choice === undefined ||
    choice.transitionId !== GIT_AUTHORITY_CANDIDATE_APPLY_TRANSITION_ID ||
    choice.parameterSchemaDigest !==
      GIT_AUTHORITY_CANDIDATE_APPLY_PARAMETER_SCHEMA_DIGEST ||
    choice.consequenceDigest !==
      GIT_AUTHORITY_CANDIDATE_APPLY_CONSEQUENCE_DIGEST ||
    choice.resolutionKind !== 'non-retry' ||
    canonicalJson(choice.allowedApprovalMethods) !==
      canonicalJson(['human-presence', 'ssh'])
  ) {
    throw receiptInvalid();
  }
  assertGitAuthorityCandidateApplyParameters(choice.parameters);
  return choice;
}

function exactPortableEvidence(
  terminal: TerminalGrantRecord,
): SshPortableApprovalEvidenceV1 {
  if (
    terminal.approvalSubject.approvalMethod !== 'ssh' ||
    terminal.audit.approvalMethod !== 'ssh' ||
    terminal.proofModules.length !== 1
  ) {
    throw receiptNonPortable();
  }
  const proof = terminal.proofModules[0]!;
  if (
    proof.moduleId !== 'grant-proof-ssh' ||
    proof.version !== '1' ||
    proof.claim !== 'ssh-signature' ||
    proof.portableEvidence === null
  ) {
    throw receiptNonPortable();
  }
  return proof.portableEvidence;
}

function verifyHistoricalAuthority(
  repositoryRoot: string,
  receipt: GitAuthorityCandidateApplyReceiptV1,
  evidence: SshPortableApprovalEvidenceV1,
): void {
  const loaded = readProductionGitBaseAuthorityContext(
    repositoryRoot,
    receipt.baseCommit,
  );
  if (
    canonicalJson(loaded.context) !==
    canonicalJson(receipt.parameters.baseAuthorityContext)
  ) {
    throw receiptInvalid();
  }
  const policy = parseGrantPolicyV2Document(loaded.grantPolicyDocument).policy;
  const ssh = policy.optionalSsh;
  const trusted = ssh?.trustedSigners.find(
    ({ identity }) => identity === evidence.identity,
  );
  if (
    ssh === undefined ||
    trusted === undefined ||
    evidence.signatureNamespace !== ssh.signatureNamespace
  ) {
    throw receiptInvalid();
  }
  verifySshSignatureWithPublicKey(
    evidence.payload,
    evidence.signature,
    evidence.identity,
    trusted.publicKey,
    evidence.signatureNamespace,
  );
}

function assertExactCommit(
  repositoryRoot: string,
  receipt: GitAuthorityCandidateApplyReceiptV1,
  journal: GitAuthorityCandidateApplyJournalV2,
): void {
  const facts = commitFacts(repositoryRoot, receipt.targetCommit);
  const expectedMessage = `${gitAuthorityCandidateApplyCommitMessage(
    receipt.parameters.commitSubject,
    {
      candidateDigest: receipt.candidateDigest,
      challengeId: receipt.challengeId,
      operationId: receipt.operationId,
      approvalSubjectDigest: receipt.approvalSubjectDigest,
      preparedGrantRecordDigest: receipt.preparedGrantRecordDigest,
    },
  )}\n`;
  const timestamp = Math.floor(
    Date.parse(receipt.parameters.commitTimestamp) / 1000,
  );
  const identity = receipt.parameters.commitIdentity;
  const expectedRaw = [
    `tree ${receipt.resultTree}`,
    `parent ${receipt.baseCommit}`,
    `author ${identity.name} <${identity.email}> ${timestamp} +0000`,
    `committer ${identity.name} <${identity.email}> ${timestamp} +0000`,
    '',
    expectedMessage,
  ].join('\n');
  const rawCommit = exactUtf8(
    runGitBuffer(repositoryRoot, ['cat-file', 'commit', receipt.targetCommit]),
  );
  const rehashed = exactUtf8(
    runGitBuffer(repositoryRoot, ['hash-object', '-t', 'commit', '--stdin'], {
      input: Buffer.from(rawCommit, 'utf8'),
    }),
  ).trim();
  if (
    facts.hash !== receipt.targetCommit ||
    canonicalJson(facts.parents) !== canonicalJson([receipt.baseCommit]) ||
    facts.tree !== receipt.resultTree ||
    facts.message !== expectedMessage ||
    journal.commitMessage !== expectedMessage ||
    rawCommit !== expectedRaw ||
    rehashed !== receipt.targetCommit
  ) {
    throw receiptInvalid();
  }
}

function isExactApplyOutcome(
  terminal: TerminalGrantRecord,
  journal: GitAuthorityCandidateApplyJournalV2,
): boolean {
  if (terminal.outcome.outcome !== 'completed') return false;
  let value;
  try {
    value = assertGitAuthorityCandidateApplyResult(terminal.outcome.details);
  } catch {
    return false;
  }
  return (
    value.candidateDigest === journal.parameters.candidateDigest &&
    value.targetRef === journal.parameters.candidate.targetRef &&
    value.expectedOldCommit ===
      journal.parameters.candidate.expectedOldCommit &&
    value.resultTree === journal.parameters.candidate.resultTree &&
    value.challengeId === journal.challengeId &&
    value.operationId === journal.operationId &&
    value.approvalMethod === 'ssh' &&
    value.approvalSubjectDigest === journal.approvalSubjectDigest &&
    value.preparedGrantRecordDigest === journal.preparedGrantRecordDigest &&
    value.commitHash === journal.entries.at(-1)?.commitHash &&
    value.failure === null &&
    value.journalDigest === journal.journalDigest
  );
}

function canonicalTag(receipt: GitAuthorityCandidateApplyReceiptV1): string {
  const tagRef = gitAuthorityCandidateApplyReceiptTagRef(receipt.challengeId);
  const seconds = Math.floor(Date.parse(receipt.completedAt) / 1000);
  if (!Number.isSafeInteger(seconds)) throw receiptInvalid();
  return [
    `object ${receipt.targetCommit}`,
    'type commit',
    `tag ${tagRef.slice('refs/tags/'.length)}`,
    `tagger ${TAGGER_NAME} <${TAGGER_EMAIL}> ${seconds} +0000`,
    '',
    canonicalGitAuthorityCandidateApplyReceipt(receipt),
  ].join('\n');
}

function readTerminalGrantRecord(
  repositoryRoot: string,
  parameters: GitAuthorityCandidateApplyParametersV1,
  challengeId: string,
): TerminalGrantRecord {
  const runtimeDirectory =
    parameters.baseAuthorityContext.workflowConfig.runtimeDirectory;
  const repository = discoverRepository(repositoryRoot);
  const record = readGrantRecord(
    grantStorePaths(
      runtimePaths(repository.gitCommonDirectory, runtimeDirectory).root,
    ),
    challengeId,
  );
  if (record.state !== 'completed') throw receiptUnavailable();
  if (
    canonicalJson(selectedApplyChoice(record).parameters) !==
    canonicalJson(parameters)
  ) {
    throw receiptInvalid();
  }
  return record;
}

function readDirectTagRef(repositoryRoot: string, ref: string): string {
  const raw = runGit(
    repositoryRoot,
    ['for-each-ref', '--format=%(objectname)%00%(symref)', ref],
    true,
  );
  if (raw === '') return '';
  const line = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const [objectId, symbolic, ...extra] = line.split('\0');
  if (
    extra.length !== 0 ||
    symbolic !== '' ||
    objectId === undefined ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(objectId)
  ) {
    throw receiptConflict();
  }
  return objectId;
}

function isObjectId(value: string, length: number): boolean {
  return (
    (length === 40 || length === 64) &&
    value.length === length &&
    /^[0-9a-f]+$/u.test(value)
  );
}

function exactUtf8(value: Buffer): string {
  const text = value.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(value)) throw receiptInvalid();
  return text;
}

function isReceiptError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    [
      'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_INVALID',
      'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_CONFLICT',
      'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_NON_PORTABLE',
      'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_UNAVAILABLE',
    ].includes(String(error.code))
  );
}

function receiptInvalid() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_INVALID',
    'The portable Central Git Apply receipt is invalid or cannot be verified.',
    ExitCode.verification,
  );
}

function receiptConflict() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_CONFLICT',
    'The Central Git Apply receipt tag is already owned by different bytes.',
    ExitCode.staleState,
  );
}

function receiptNonPortable() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_NON_PORTABLE',
    'Human-presence Central Grants are intentionally non-portable and publish no receipt.',
    ExitCode.guard,
  );
}

function receiptUnavailable() {
  return workflowError(
    'GIT_AUTHORITY_CANDIDATE_APPLY_RECEIPT_UNAVAILABLE',
    'A completed SSH Central Git Apply terminal is required before publication.',
    ExitCode.staleState,
  );
}
