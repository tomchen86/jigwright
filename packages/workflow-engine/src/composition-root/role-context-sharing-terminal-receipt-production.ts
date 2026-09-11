import {type RoleContextSharingJournalRecord} from '../modules/authority/role-context-sharing-grant-lifecycle-port.ts';
import { ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_SIGNATURE_NAMESPACE_V1, ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_TAG_PREFIX_V1 } from '../modules/authority/role-context-sharing-grant-lifecycle-port.ts';
import type { RoleContextSharingTerminalReceiptPayloadV1, RoleContextSharingTerminalReceiptEnvelopeV1, VerifiedRoleContextSharingTerminalReceiptV1, RoleContextSharingTerminalUseIdentityV1 } from '../modules/authority/role-context-sharing-grant-lifecycle-port.ts';
/**
 * Publishes and verifies portable receipts for terminal role context
 * sharing uses.
 *
 * Invariants:
 * - Verified receipt identities must correspond exactly to the supplied
 *   terminal uses.
 */
import crypto from 'node:crypto';

import { canonicalRoleContextSharingGrantEnvelopeV1 } from '../runtime/grants/optional-grants-package.ts';

import { authorityTagPublishCommand } from '../adapters/remote/github/authority-relay-command.ts';
import {
  assertInteractiveSignerContext,
  createInteractiveSshSigner,
  verifySshSignatureWithPublicKey,
  type InteractiveSignerContext,
} from '../adapters/signing/ssh/maintainer-signer.ts';
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { createMaintainerAuditTag } from '../runtime/repository-transaction/maintainer-audit-tag.ts';
import type { MaintainerSignerProvider } from '../modules/authority/maintainer-signer-port.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from '../modules/authority/maintainer-policy.ts';
import type { ConsumedRoleContextSharingUseEvidenceV1 } from '../modules/authority/role-context-sharing-grant-lifecycle-port.ts';
import {
  discoverRepository,
  runGit,
} from '../runtime/repository-transaction/git.ts';
import {parseRoleContextSharingJournalRecord,readRoleContextSharingRecord} from '../runtime/storage-journal/role-context-sharing-store.ts';




const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const TAG_REF = /^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const SIGNER_IDENTITY = /^[A-Za-z0-9._@+-]{1,128}$/u;
const MAX_ENVELOPE_BYTES = 512 * 1024;
const PAYLOAD_KEYS = [
  'admissionDigest',
  'attestedAt',
  'baselineCommit',
  'consumedAt',
  'expectedBindingDigest',
  'fromState',
  'grantEnvelopeDigest',
  'grantId',
  'kind',
  'policyBlob',
  'repositoryId',
  'repositoryOrigin',
  'reservationReceiptDigest',
  'schemaVersion',
  'signatureNamespace',
  'signer',
  'terminalReceiptDigest',
  'terminalRecord',
  'terminalRecordDigest',
  'terminalState',
  'toState',
  'transitionDigest',
  'useProjectionDigest',
] as const;









export type PublishRoleContextSharingTerminalReceiptOptions = Readonly<{
  now?: Date;
  signer?: MaintainerSignerProvider;
  interactiveContext?: InteractiveSignerContext;
}>;

export function roleContextSharingTerminalReceiptTagRef(
  grantId: string,
): string {
  if (!UUID_V4.test(grantId)) throw receiptInvalid();
  return `${ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_TAG_PREFIX_V1}${grantId}`;
}

export function canonicalRoleContextSharingTerminalReceiptPayloadV1(
  payload: RoleContextSharingTerminalReceiptPayloadV1,
): string {
  const validated = validatePayload(payload);
  return `${canonicalJson(validated)}\n`;
}

export function canonicalRoleContextSharingTerminalReceiptEnvelopeV1(
  envelope: RoleContextSharingTerminalReceiptEnvelopeV1,
): string {
  if (
    !isRecord(envelope) ||
    !hasExactKeys(envelope, ['payload', 'signature'])
  ) {
    throw receiptInvalid();
  }
  const payload = JSON.parse(
    canonicalRoleContextSharingTerminalReceiptPayloadV1(envelope.payload),
  ) as RoleContextSharingTerminalReceiptPayloadV1;
  assertArmoredSignature(envelope.signature);
  return `${canonicalJson({ payload, signature: envelope.signature })}\n`;
}

export function parseRoleContextSharingTerminalReceiptEnvelopeV1(
  raw: string,
): RoleContextSharingTerminalReceiptEnvelopeV1 {
  try {
    if (
      typeof raw !== 'string' ||
      Buffer.byteLength(raw) > MAX_ENVELOPE_BYTES ||
      !raw.endsWith('\n')
    ) {
      throw new Error('invalid terminal receipt bytes');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['payload', 'signature']) ||
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, PAYLOAD_KEYS) ||
      typeof value.signature !== 'string'
    ) {
      throw new Error('invalid terminal receipt shape');
    }
    const envelope = {
      payload: validatePayload(
        value.payload as RoleContextSharingTerminalReceiptPayloadV1,
      ),
      signature: value.signature,
    };
    if (
      canonicalRoleContextSharingTerminalReceiptEnvelopeV1(envelope) !== raw
    ) {
      throw new Error('noncanonical terminal receipt');
    }
    return envelope;
  } catch (error) {
    if (isReceiptError(error)) throw error;
    throw receiptInvalid();
  }
}

export function listRoleContextSharingTerminalReceiptTagRefs(
  repositoryRoot: string,
): string[] {
  return runGit(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname)',
    `${ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_TAG_PREFIX_V1}*`,
  ])
    .split('\n')
    .filter(Boolean)
    .sort();
}

export function listVerifiedRoleContextSharingTerminalReceipts(
  repositoryRoot: string,
): VerifiedRoleContextSharingTerminalReceiptV1[] {
  const receipts = listRoleContextSharingTerminalReceiptTagRefs(
    repositoryRoot,
  ).map((ref) => readAndVerifyReceiptTag(repositoryRoot, ref));
  assertUniqueReceiptUses(receipts);
  return receipts;
}

export function assertRoleContextSharingTerminalReceiptUseBijection(
  receipts: readonly VerifiedRoleContextSharingTerminalReceiptV1[],
  uses: readonly RoleContextSharingTerminalUseIdentityV1[],
): void {
  assertUniqueReceiptUses(receipts);
  const receiptIdentities = receipts
    .map(({ envelope }) => terminalUseIdentityFromReceipt(envelope.payload))
    .sort(compareTerminalUseIdentity);
  const useIdentities = uses
    .map(validateTerminalUseIdentity)
    .sort(compareTerminalUseIdentity);
  if (canonicalJson(receiptIdentities) !== canonicalJson(useIdentities)) {
    throw receiptBijectionInvalid();
  }
}

/**
 * Read every protected R-007 terminal receipt and verify it only against the
 * immutable maintainer policy named by its historical baseline. The caller's
 * checkout contributes no journal state and no candidate-embedded projection.
 */
export function readVerifiedRoleContextSharingTerminalReceipt(
  repositoryRoot: string,
  evidence: ConsumedRoleContextSharingUseEvidenceV1,
): VerifiedRoleContextSharingTerminalReceiptV1 {
  try {
    loadHistoricalPolicy(
      repositoryRoot,
      evidence.expectedBinding.baselineCommit,
    );
  } catch {
    throw receiptUnavailable();
  }
  const receipts =
    listVerifiedRoleContextSharingTerminalReceipts(repositoryRoot);
  const expectedRef = roleContextSharingTerminalReceiptTagRef(evidence.grantId);
  const receipt = receipts.find(({ tagRef }) => tagRef === expectedRef);
  if (receipt === undefined) throw receiptUnavailable();
  const payload = receipt.envelope.payload;
  if (
    payload.grantId !== evidence.grantId ||
    payload.baselineCommit !== evidence.expectedBinding.baselineCommit ||
    payload.policyBlob !== evidence.expectedBinding.policyBlob ||
    payload.grantEnvelopeDigest !==
      sha256(canonicalRoleContextSharingGrantEnvelopeV1(evidence.envelope)) ||
    payload.expectedBindingDigest !==
      sha256(canonicalJson(evidence.expectedBinding)) ||
    payload.transitionDigest !== evidence.expectedBinding.targetDigest ||
    payload.reservationReceiptDigest !== evidence.reservationReceiptDigest ||
    payload.terminalReceiptDigest !== evidence.terminalReceiptDigest ||
    payload.terminalRecordDigest !== evidence.terminalRecordDigest ||
    payload.useProjectionDigest !== evidence.useProjectionDigest ||
    payload.admissionDigest !== evidence.use.admissionDigest ||
    canonicalJson(payload.terminalRecord.envelope) !==
      canonicalJson(evidence.envelope) ||
    canonicalJson(payload.terminalRecord.expectedBinding) !==
      canonicalJson(evidence.expectedBinding) ||
    canonicalJson(payload.terminalRecord.use) !== canonicalJson(evidence.use)
  ) {
    throw receiptInvalid();
  }
  return receipt;
}

/**
 * Human-only production transition from one already-consumed local journal to
 * a protected immutable audit tag. It never reserves or consumes a grant and
 * therefore cannot weaken the live verifier's assertCurrent boundary.
 */
export function publishRoleContextSharingTerminalReceipt(
  cwd: string,
  grantId: string,
  options: PublishRoleContextSharingTerminalReceiptOptions = {},
): Readonly<{
  tagRef: string;
  tagObject: string;
  target: string;
  envelope: RoleContextSharingTerminalReceiptEnvelopeV1;
  publishCommand: string;
}> {
  const repository = discoverRepository(cwd);
  let record: RoleContextSharingJournalRecord;
  try {
    record = readRoleContextSharingRecord(
      repository.gitCommonDirectory,
      grantId,
    );
  } catch {
    throw receiptUnavailable();
  }
  if (
    record.state !== 'consumed' ||
    record.expectedBinding === null ||
    record.use === null
  ) {
    throw receiptUnavailable();
  }
  const historical = loadHistoricalPolicy(
    repository.repositoryRoot,
    record.expectedBinding.baselineCommit,
  );
  const tagRef = roleContextSharingTerminalReceiptTagRef(grantId);
  const existing = runGit(
    repository.repositoryRoot,
    ['rev-parse', '--verify', tagRef],
    true,
  ).trim();
  if (existing) {
    const verified = readAndVerifyReceiptTag(repository.repositoryRoot, tagRef);
    if (
      verified.envelope.payload.terminalRecordDigest !== record.recordDigest ||
      canonicalJson(verified.envelope.payload.terminalRecord) !==
        canonicalJson(record)
    ) {
      throw receiptConflict();
    }
    return publicationResult(verified);
  }

  assertInteractiveSignerContext(
    options.interactiveContext ?? {
      stdinIsTty: process.stdin.isTTY === true,
      stdoutIsTty: process.stdout.isTTY === true,
      stderrIsTty: process.stderr.isTTY === true,
    },
  );
  const signer =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, historical.policy);
  signer.assertHumanPresent();
  const signerIdentity = signer.identity();
  if (
    !historical.policy.trustedSigners.some(
      ({ identity }) => identity === signerIdentity,
    )
  ) {
    throw receiptSignatureInvalid();
  }
  const payload = createPayload(
    record,
    historical.policy,
    historical.policyBlob,
    signerIdentity,
    exactDate(options.now ?? new Date()),
  );
  const canonicalPayload =
    canonicalRoleContextSharingTerminalReceiptPayloadV1(payload);
  const signature = signer.sign(
    canonicalPayload,
    ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_SIGNATURE_NAMESPACE_V1,
  );
  signer.verify(
    canonicalPayload,
    signature,
    signerIdentity,
    ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_SIGNATURE_NAMESPACE_V1,
  );
  const envelope = { payload, signature };
  createMaintainerAuditTag(
    repository.repositoryRoot,
    payload.baselineCommit,
    tagRef,
    canonicalRoleContextSharingTerminalReceiptEnvelopeV1(envelope),
    signerIdentity,
  );
  const verified = readAndVerifyReceiptTag(repository.repositoryRoot, tagRef);
  if (
    canonicalRoleContextSharingTerminalReceiptEnvelopeV1(verified.envelope) !==
    canonicalRoleContextSharingTerminalReceiptEnvelopeV1(envelope)
  ) {
    throw receiptConflict();
  }
  return publicationResult(verified);
}

function createPayload(
  record: RoleContextSharingJournalRecord,
  policy: MaintainerPolicy,
  policyBlob: string,
  signer: string,
  attestedAt: Date,
): RoleContextSharingTerminalReceiptPayloadV1 {
  if (
    record.state !== 'consumed' ||
    record.expectedBinding === null ||
    record.use === null ||
    record.reservation === null ||
    record.receipts.length !== 2 ||
    record.receiptDigests.length !== 2 ||
    record.transitionDigest === null
  ) {
    throw receiptUnavailable();
  }
  const consumedAt = record.receipts[1]!.occurredAt;
  if (attestedAt.getTime() < Date.parse(consumedAt)) {
    throw receiptInvalid();
  }
  return validatePayload({
    schemaVersion: 1,
    kind: 'role-context-sharing-terminal-receipt.v1',
    signatureNamespace:
      ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_SIGNATURE_NAMESPACE_V1,
    grantId: record.grantId,
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob,
    baselineCommit: record.expectedBinding.baselineCommit,
    grantEnvelopeDigest: sha256(
      canonicalRoleContextSharingGrantEnvelopeV1(record.envelope),
    ),
    expectedBindingDigest: sha256(canonicalJson(record.expectedBinding)),
    transitionDigest: record.transitionDigest,
    fromState: 'reserved',
    toState: 'consumed',
    terminalState: 'consumed',
    reservationReceiptDigest: record.receiptDigests[0]!,
    terminalReceiptDigest: record.receiptDigests[1]!,
    terminalRecordDigest: record.recordDigest,
    useProjectionDigest: sha256(canonicalJson(record.use)),
    admissionDigest: record.use.admissionDigest,
    consumedAt,
    attestedAt: attestedAt.toISOString(),
    signer,
    terminalRecord: structuredClone(record),
  });
}

function readAndVerifyReceiptTag(
  repositoryRoot: string,
  ref: string,
): VerifiedRoleContextSharingTerminalReceiptV1 {
  try {
    if (!TAG_REF.test(ref)) throw new Error('invalid ref');
    const raw = runGit(repositoryRoot, ['cat-file', 'tag', ref]);
    const separator = raw.indexOf('\n\n');
    if (separator === -1) throw new Error('tag body missing');
    const envelope = parseRoleContextSharingTerminalReceiptEnvelopeV1(
      raw.slice(separator + 2),
    );
    const payload = envelope.payload;
    const expectedRef = roleContextSharingTerminalReceiptTagRef(
      payload.grantId,
    );
    const headers = raw.slice(0, separator).split('\n');
    const expectedTaggerPrefix = `tagger ${payload.signer} <workflow-maintainer@users.noreply.github.com> `;
    const taggerSuffix = headers[3]?.slice(expectedTaggerPrefix.length);
    if (
      ref !== expectedRef ||
      headers.length !== 4 ||
      headers[0] !== `object ${payload.baselineCommit}` ||
      headers[1] !== 'type commit' ||
      headers[2] !== `tag ${ref.slice('refs/tags/'.length)}` ||
      !headers[3]!.startsWith(expectedTaggerPrefix) ||
      !/^[0-9]+ [+-][0-9]{4}$/u.test(taggerSuffix ?? '')
    ) {
      throw new Error('tag headers differ');
    }
    const historical = loadHistoricalPolicy(
      repositoryRoot,
      payload.baselineCommit,
    );
    if (
      payload.policyBlob !== historical.policyBlob ||
      payload.repositoryId !== historical.policy.repository.id ||
      payload.repositoryOrigin !== historical.policy.repository.origin ||
      ref !== roleContextSharingTerminalReceiptTagRef(payload.grantId)
    ) {
      throw new Error('historical policy binding differs');
    }
    const trusted = historical.policy.trustedSigners.find(
      ({ identity }) => identity === payload.signer,
    );
    if (trusted === undefined) throw new Error('untrusted receipt signer');
    verifySshSignatureWithPublicKey(
      canonicalRoleContextSharingTerminalReceiptPayloadV1(payload),
      envelope.signature,
      trusted.identity,
      trusted.publicKey,
      ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_SIGNATURE_NAMESPACE_V1,
    );
    const target = runGit(repositoryRoot, [
      'rev-parse',
      '--verify',
      `${ref}^{commit}`,
    ]).trim();
    if (target !== payload.baselineCommit) {
      throw new Error('tag target differs');
    }
    return Object.freeze({
      tagRef: ref,
      tagObject: runGit(repositoryRoot, [
        'rev-parse',
        '--verify',
        `${ref}^{tag}`,
      ]).trim(),
      target,
      envelope,
      policy: historical.policy,
    });
  } catch (error) {
    if (isReceiptError(error)) throw error;
    throw receiptInvalid();
  }
}

function validatePayload(
  value: RoleContextSharingTerminalReceiptPayloadV1,
): RoleContextSharingTerminalReceiptPayloadV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, PAYLOAD_KEYS) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'role-context-sharing-terminal-receipt.v1' ||
    value.signatureNamespace !==
      ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_SIGNATURE_NAMESPACE_V1 ||
    !UUID_V4.test(value.grantId) ||
    !boundedText(value.repositoryId, 512) ||
    !boundedText(value.repositoryOrigin, 2_048) ||
    !OBJECT_ID.test(value.policyBlob) ||
    !OBJECT_ID.test(value.baselineCommit) ||
    !DIGEST.test(value.grantEnvelopeDigest) ||
    !DIGEST.test(value.expectedBindingDigest) ||
    !DIGEST.test(value.transitionDigest) ||
    value.fromState !== 'reserved' ||
    value.toState !== 'consumed' ||
    value.terminalState !== 'consumed' ||
    !DIGEST.test(value.reservationReceiptDigest) ||
    !DIGEST.test(value.terminalReceiptDigest) ||
    !DIGEST.test(value.terminalRecordDigest) ||
    !DIGEST.test(value.useProjectionDigest) ||
    !DIGEST.test(value.admissionDigest) ||
    !canonicalIso(value.consumedAt) ||
    !canonicalIso(value.attestedAt) ||
    Date.parse(value.attestedAt) < Date.parse(value.consumedAt) ||
    !SIGNER_IDENTITY.test(value.signer) ||
    !isRecord(value.terminalRecord)
  ) {
    throw receiptInvalid();
  }
  const record = parseRoleContextSharingJournalRecord(
    `${canonicalJson(value.terminalRecord)}\n`,
  );
  if (
    record.state !== 'consumed' ||
    record.expectedBinding === null ||
    record.use === null ||
    record.reservation === null ||
    record.receipts.length !== 2 ||
    record.receiptDigests.length !== 2 ||
    record.transitionDigest === null ||
    value.grantId !== record.grantId ||
    value.repositoryId !== record.expectedBinding.repositoryId ||
    value.repositoryOrigin !== record.expectedBinding.repositoryOrigin ||
    value.policyBlob !== record.expectedBinding.policyBlob ||
    value.baselineCommit !== record.expectedBinding.baselineCommit ||
    value.grantEnvelopeDigest !==
      sha256(canonicalRoleContextSharingGrantEnvelopeV1(record.envelope)) ||
    value.expectedBindingDigest !==
      sha256(canonicalJson(record.expectedBinding)) ||
    value.transitionDigest !== record.transitionDigest ||
    value.transitionDigest !== record.expectedBinding.targetDigest ||
    value.reservationReceiptDigest !== record.receiptDigests[0] ||
    value.terminalReceiptDigest !== record.receiptDigests[1] ||
    value.terminalRecordDigest !== record.recordDigest ||
    value.useProjectionDigest !== sha256(canonicalJson(record.use)) ||
    value.admissionDigest !== record.use.admissionDigest ||
    value.consumedAt !== record.receipts[1]!.occurredAt
  ) {
    throw receiptInvalid();
  }
  return Object.freeze({ ...value, terminalRecord: record });
}

function loadHistoricalPolicy(
  repositoryRoot: string,
  baselineCommit: string,
): Readonly<{ policy: MaintainerPolicy; policyBlob: string }> {
  if (!OBJECT_ID.test(baselineCommit)) throw receiptInvalid();
  const raw = runGit(repositoryRoot, [
    'show',
    `${baselineCommit}:workflow/maintainer-policy.json`,
  ]);
  const policy = parseMaintainerPolicy(JSON.parse(raw));
  const policyBlob = runGit(repositoryRoot, [
    'rev-parse',
    `${baselineCommit}:workflow/maintainer-policy.json`,
  ]).trim();
  if (!OBJECT_ID.test(policyBlob)) throw receiptInvalid();
  return Object.freeze({ policy, policyBlob });
}

function assertUniqueReceiptUses(
  receipts: readonly VerifiedRoleContextSharingTerminalReceiptV1[],
): void {
  const grantIds = new Set<string>();
  const envelopeDigests = new Set<string>();
  const useProjectionDigests = new Set<string>();
  const admissionDigests = new Set<string>();
  for (const receipt of receipts) {
    const payload = receipt.envelope.payload;
    if (
      grantIds.has(payload.grantId) ||
      envelopeDigests.has(payload.grantEnvelopeDigest) ||
      useProjectionDigests.has(payload.useProjectionDigest) ||
      admissionDigests.has(payload.admissionDigest)
    ) {
      throw receiptDuplicate();
    }
    grantIds.add(payload.grantId);
    envelopeDigests.add(payload.grantEnvelopeDigest);
    useProjectionDigests.add(payload.useProjectionDigest);
    admissionDigests.add(payload.admissionDigest);
  }
}

function terminalUseIdentityFromReceipt(
  payload: RoleContextSharingTerminalReceiptPayloadV1,
): RoleContextSharingTerminalUseIdentityV1 {
  return Object.freeze({
    grantId: payload.grantId,
    signedEnvelopeDigest: payload.grantEnvelopeDigest,
    transitionDigest: payload.transitionDigest,
    useProjectionDigest: payload.useProjectionDigest,
    admissionDigest: payload.admissionDigest,
  });
}

function validateTerminalUseIdentity(
  use: RoleContextSharingTerminalUseIdentityV1,
): RoleContextSharingTerminalUseIdentityV1 {
  if (
    !isRecord(use) ||
    !hasExactKeys(use, [
      'admissionDigest',
      'grantId',
      'signedEnvelopeDigest',
      'transitionDigest',
      'useProjectionDigest',
    ]) ||
    !UUID_V4.test(use.grantId) ||
    !DIGEST.test(use.signedEnvelopeDigest) ||
    !DIGEST.test(use.transitionDigest) ||
    !DIGEST.test(use.useProjectionDigest) ||
    !DIGEST.test(use.admissionDigest)
  ) {
    throw receiptBijectionInvalid();
  }
  return Object.freeze({ ...use });
}

function compareTerminalUseIdentity(
  left: RoleContextSharingTerminalUseIdentityV1,
  right: RoleContextSharingTerminalUseIdentityV1,
): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

function publicationResult(
  receipt: VerifiedRoleContextSharingTerminalReceiptV1,
) {
  return Object.freeze({
    tagRef: receipt.tagRef,
    tagObject: receipt.tagObject,
    target: receipt.target,
    envelope: receipt.envelope,
    publishCommand: authorityTagPublishCommand(
      receipt.policy.repository.origin,
      receipt.tagRef,
    ),
  });
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
  );
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value) <= maxBytes
  );
}

function canonicalIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw receiptInvalid();
  }
  return new Date(value.getTime());
}

function assertArmoredSignature(signature: string): void {
  if (
    typeof signature !== 'string' ||
    Buffer.byteLength(signature) > 16_384 ||
    !signature.startsWith('-----BEGIN SSH SIGNATURE-----\n') ||
    !signature.endsWith('-----END SSH SIGNATURE-----\n')
  ) {
    throw receiptInvalid();
  }
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isReceiptError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    String(error.code).startsWith('ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_')
  );
}

function receiptUnavailable() {
  return workflowError(
    'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_UNAVAILABLE',
    'The immutable role-context-sharing terminal receipt is unavailable.',
    ExitCode.verification,
    {
      recovery:
        'A controlling-terminal maintainer must attest the consumed local record and publish its protected audit tag.',
    },
  );
}

function receiptInvalid() {
  return workflowError(
    'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_INVALID',
    'The immutable role-context-sharing terminal receipt is invalid.',
    ExitCode.verification,
  );
}

function receiptSignatureInvalid() {
  return workflowError(
    'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_SIGNATURE_INVALID',
    'The role-context-sharing terminal receipt signer is not trusted by its historical policy.',
    ExitCode.verification,
  );
}

function receiptConflict() {
  return workflowError(
    'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_CONFLICT',
    'The immutable role-context-sharing terminal receipt tag already differs.',
    ExitCode.conflict,
  );
}

function receiptDuplicate() {
  return workflowError(
    'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_DUPLICATE',
    'Protected role-context-sharing terminal receipt history reuses a grant, signed envelope, or exact terminal use.',
    ExitCode.staleState,
  );
}

function receiptBijectionInvalid() {
  return workflowError(
    'ROLE_CONTEXT_SHARING_TERMINAL_RECEIPT_BIJECTION_INVALID',
    'Protected role-context-sharing terminal receipts do not exactly match tracked historical terminal uses.',
    ExitCode.verification,
  );
}
