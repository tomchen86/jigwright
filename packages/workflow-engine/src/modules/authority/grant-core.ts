/**
 * Turns a blocked operation into one bounded, human-decidable Grant challenge and binds the chosen resolution to it.
 *
 * Invariants:
 * - Every challenge offers at least one non-retry resolution, so a decision is always available and never only "try again".
 * - Choice identities are unique within a challenge, and an approval selects one of that challenge's own choices.
 * - A challenge expires within the fixed bound, and an expired challenge cannot be approved.
 * - An approval subject binds the exact challenge digest and an approval method the selected resolution allows.
 */
import crypto from 'node:crypto';

import type {
  CentralGrantChallengeRefV1,
  CentralGrantChallengeV1,
  CentralGrantChoiceV1,
  CentralGrantRequestInputV1,
  CentralGrantStateBindingV1,
  CentralGrantTransitionCandidateV1,
} from '@jigwright/core/central-grant-port';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  copyGrantDate,
  deepFreezeGrant as deepFreeze,
  freezeGrantCanonical as freezeCanonical,
  GRANT_SESSION_NONCE as SESSION_NONCE,
  GRANT_SHA256_DIGEST as SHA256_DIGEST,
  GRANT_STABLE_ID as STABLE_ID,
  GRANT_UUID_V4 as UUID_V4,
  grantHasExactKeys as hasExactKeys,
  grantSha256 as sha256,
  parseGrantTimestamp,
} from './grant-primitives.ts';
import type { TransitionRegistry } from './grant-transition-registry.ts';

const MAX_CHALLENGE_TTL_MS = 30 * 60_000;
const MAX_REASON_LENGTH = 2048;

export const GRANT_APPROVAL_METHODS = ['human-presence', 'ssh'] as const;
export type GrantApprovalMethod = (typeof GRANT_APPROVAL_METHODS)[number];

export type StateBinding = CentralGrantStateBindingV1;
export type TransitionCandidate = CentralGrantTransitionCandidateV1;
export type GrantRequestInput<TFacts = unknown> =
  CentralGrantRequestInputV1<TFacts>;
export type GrantChoice = CentralGrantChoiceV1<GrantApprovalMethod>;
export type GrantChallenge = CentralGrantChallengeV1<
  unknown,
  GrantApprovalMethod
>;
export type GrantChallengeRef = CentralGrantChallengeRefV1;

export type ApprovalSubject = Readonly<{
  schemaVersion: 1;
  kind: 'grant-approval-subject.v1';
  challengeDigest: `sha256:${string}`;
  choiceId: `sha256:${string}`;
  approvalMethod: GrantApprovalMethod;
  reasonCode: string;
  reason: string;
  reasonDigest: `sha256:${string}`;
  stateDigest: `sha256:${string}`;
  expiresAt: string;
  sessionNonce: string;
}>;

export function createGrantChallenge(
  requested: GrantRequestInput,
  registry: TransitionRegistry,
  options: Readonly<{
    challengeId?: string;
    now?: Date;
    expiresAt: string;
  }>,
): GrantChallenge {
  assertExactKeys(requested, [
    'sourceModuleId',
    'failureCode',
    'facts',
    'stateBinding',
    'candidates',
  ]);
  if (
    !STABLE_ID.test(requested.sourceModuleId) ||
    !STABLE_ID.test(requested.failureCode) ||
    !isRecord(requested.stateBinding) ||
    !hasExactKeys(requested.stateBinding, ['kind', 'digest']) ||
    !STABLE_ID.test(requested.stateBinding.kind) ||
    !SHA256_DIGEST.test(requested.stateBinding.digest) ||
    !Array.isArray(requested.candidates) ||
    requested.candidates.length < 1
  ) {
    throw grantInvalid('GRANT_REQUEST_INVALID', 'Grant request is malformed.');
  }
  const now = exactDate(options.now ?? new Date());
  const expiresAt = exactTimestamp(options.expiresAt);
  if (
    expiresAt.getTime() <= now.getTime() ||
    expiresAt.getTime() - now.getTime() > MAX_CHALLENGE_TTL_MS
  ) {
    throw grantInvalid(
      'GRANT_CHALLENGE_BOUNDS_INVALID',
      'Grant challenge expiry is invalid.',
    );
  }
  const challengeId = options.challengeId ?? crypto.randomUUID();
  if (!UUID_V4.test(challengeId)) {
    throw grantInvalid(
      'GRANT_CHALLENGE_ID_INVALID',
      'Grant challenge ID is invalid.',
    );
  }
  const facts = freezeCanonical(requested.facts);
  const choices = requested.candidates.map((candidate) =>
    createChoice(candidate, registry),
  );
  if (
    new Set(choices.map(({ choiceId }) => choiceId)).size !== choices.length
  ) {
    throw grantInvalid(
      'GRANT_CHOICE_DUPLICATE',
      'Grant challenge choices must be unique.',
    );
  }
  if (!choices.some(({ resolutionKind }) => resolutionKind === 'non-retry')) {
    throw grantInvalid(
      'GRANT_NON_RETRY_RESOLUTION_REQUIRED',
      'Grant challenge requires at least one non-retry resolution.',
    );
  }
  const payload = {
    schemaVersion: 1 as const,
    kind: 'grant-challenge.v1' as const,
    challengeId,
    sourceModuleId: requested.sourceModuleId,
    failureCode: requested.failureCode,
    facts,
    factsDigest: sha256(canonicalJson(facts)),
    stateBinding: freezeCanonical(requested.stateBinding) as StateBinding,
    choices,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  return deepFreeze({
    ...payload,
    challengeDigest: sha256(canonicalJson(payload)),
  });
}

export function createApprovalSubject(
  challenge: GrantChallenge,
  decision: Readonly<{
    choiceId: string;
    approvalMethod: GrantApprovalMethod;
    reasonCode: string;
    reason: string;
    sessionNonce: string;
  }>,
  options: Readonly<{ now?: Date }> = {},
): ApprovalSubject {
  challenge = assertGrantChallenge(challenge);
  const now = exactDate(options.now ?? new Date());
  if (exactTimestamp(challenge.expiresAt).getTime() < now.getTime()) {
    throw workflowError(
      'GRANT_CHALLENGE_EXPIRED',
      'Grant challenge has expired.',
      ExitCode.staleState,
    );
  }
  const choice = challenge.choices.find(
    ({ choiceId }) => choiceId === decision.choiceId,
  );
  if (choice === undefined) {
    throw grantInvalid(
      'GRANT_CHOICE_NOT_FOUND',
      'Selected grant choice is unavailable.',
    );
  }
  if (!GRANT_APPROVAL_METHODS.includes(decision.approvalMethod)) {
    throw grantInvalid(
      'GRANT_APPROVAL_METHOD_INVALID',
      'Selected grant approval method is unavailable.',
    );
  }
  if (!choice.allowedApprovalMethods.includes(decision.approvalMethod)) {
    throw grantInvalid(
      'GRANT_APPROVAL_METHOD_NOT_ALLOWED',
      'Selected grant approval method is not allowed for this transition.',
    );
  }
  if (
    !STABLE_ID.test(decision.reasonCode) ||
    !choice.allowedReasonCodes.includes(decision.reasonCode)
  ) {
    throw grantInvalid(
      'GRANT_REASON_NOT_ALLOWED',
      'Selected grant reason is not allowed for this choice.',
    );
  }
  const reason = canonicalReason(decision.reason, choice.reasonRequired);
  if (!SESSION_NONCE.test(decision.sessionNonce)) {
    throw grantInvalid(
      'GRANT_SESSION_NONCE_INVALID',
      'Grant approval session nonce is invalid.',
    );
  }
  return deepFreeze({
    schemaVersion: 1,
    kind: 'grant-approval-subject.v1',
    challengeDigest: challenge.challengeDigest,
    choiceId: choice.choiceId,
    approvalMethod: decision.approvalMethod,
    reasonCode: decision.reasonCode,
    reason,
    reasonDigest: sha256(canonicalJson(reason)),
    stateDigest: challenge.stateBinding.digest,
    expiresAt: challenge.expiresAt,
    sessionNonce: decision.sessionNonce,
  });
}

export function assertGrantChallenge(value: unknown): GrantChallenge {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'challengeId',
      'sourceModuleId',
      'failureCode',
      'facts',
      'factsDigest',
      'stateBinding',
      'choices',
      'issuedAt',
      'expiresAt',
      'challengeDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'grant-challenge.v1' ||
    typeof value.challengeId !== 'string' ||
    !UUID_V4.test(value.challengeId) ||
    typeof value.sourceModuleId !== 'string' ||
    !STABLE_ID.test(value.sourceModuleId) ||
    typeof value.failureCode !== 'string' ||
    !STABLE_ID.test(value.failureCode) ||
    typeof value.factsDigest !== 'string' ||
    !SHA256_DIGEST.test(value.factsDigest) ||
    !isRecord(value.stateBinding) ||
    !hasExactKeys(value.stateBinding, ['kind', 'digest']) ||
    typeof value.stateBinding.kind !== 'string' ||
    !STABLE_ID.test(value.stateBinding.kind) ||
    typeof value.stateBinding.digest !== 'string' ||
    !SHA256_DIGEST.test(value.stateBinding.digest) ||
    !Array.isArray(value.choices) ||
    value.choices.length < 1 ||
    typeof value.issuedAt !== 'string' ||
    typeof value.expiresAt !== 'string' ||
    typeof value.challengeDigest !== 'string' ||
    !SHA256_DIGEST.test(value.challengeDigest)
  ) {
    throw grantInvalid(
      'GRANT_CHALLENGE_INVALID',
      'Grant challenge is malformed.',
    );
  }
  const issuedAt = exactTimestamp(value.issuedAt);
  const expiresAt = exactTimestamp(value.expiresAt);
  if (
    expiresAt.getTime() <= issuedAt.getTime() ||
    expiresAt.getTime() - issuedAt.getTime() > MAX_CHALLENGE_TTL_MS
  ) {
    throw grantInvalid(
      'GRANT_CHALLENGE_INVALID',
      'Grant challenge is malformed.',
    );
  }
  const facts = freezeCanonical(value.facts);
  if (sha256(canonicalJson(facts)) !== value.factsDigest) {
    throw grantInvalid(
      'GRANT_CHALLENGE_INVALID',
      'Grant challenge facts do not match their digest.',
    );
  }
  const choices = value.choices.map(assertGrantChoice);
  if (
    new Set(choices.map(({ choiceId }) => choiceId)).size !== choices.length ||
    !choices.some(({ resolutionKind }) => resolutionKind === 'non-retry')
  ) {
    throw grantInvalid(
      'GRANT_CHALLENGE_INVALID',
      'Grant challenge choices are invalid.',
    );
  }
  const payload = {
    schemaVersion: 1 as const,
    kind: 'grant-challenge.v1' as const,
    challengeId: value.challengeId,
    sourceModuleId: value.sourceModuleId,
    failureCode: value.failureCode,
    facts,
    factsDigest: value.factsDigest as `sha256:${string}`,
    stateBinding: freezeCanonical(value.stateBinding) as StateBinding,
    choices,
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  };
  if (sha256(canonicalJson(payload)) !== value.challengeDigest) {
    throw grantInvalid(
      'GRANT_CHALLENGE_INVALID',
      'Grant challenge does not match its digest.',
    );
  }
  return deepFreeze({
    ...payload,
    challengeDigest: value.challengeDigest as `sha256:${string}`,
  });
}

export function approvalSubjectDigest(
  subject: ApprovalSubject,
): `sha256:${string}` {
  return sha256(canonicalJson(assertApprovalSubject(subject)));
}

export function assertApprovalSubject(value: unknown): ApprovalSubject {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'challengeDigest',
      'choiceId',
      'approvalMethod',
      'reasonCode',
      'reason',
      'reasonDigest',
      'stateDigest',
      'expiresAt',
      'sessionNonce',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'grant-approval-subject.v1' ||
    typeof value.challengeDigest !== 'string' ||
    !SHA256_DIGEST.test(value.challengeDigest) ||
    typeof value.choiceId !== 'string' ||
    !SHA256_DIGEST.test(value.choiceId) ||
    !GRANT_APPROVAL_METHODS.includes(
      value.approvalMethod as GrantApprovalMethod,
    ) ||
    typeof value.reasonCode !== 'string' ||
    !STABLE_ID.test(value.reasonCode) ||
    typeof value.reason !== 'string' ||
    value.reason.trim() !== value.reason ||
    value.reason.length > MAX_REASON_LENGTH ||
    /[\0\r]/.test(value.reason) ||
    typeof value.reasonDigest !== 'string' ||
    !SHA256_DIGEST.test(value.reasonDigest) ||
    sha256(canonicalJson(value.reason)) !== value.reasonDigest ||
    typeof value.stateDigest !== 'string' ||
    !SHA256_DIGEST.test(value.stateDigest) ||
    typeof value.expiresAt !== 'string' ||
    typeof value.sessionNonce !== 'string' ||
    !SESSION_NONCE.test(value.sessionNonce)
  ) {
    throw grantInvalid(
      'GRANT_APPROVAL_SUBJECT_INVALID',
      'Grant approval subject is malformed.',
    );
  }
  exactTimestamp(value.expiresAt);
  return deepFreeze(freezeCanonical(value) as unknown as ApprovalSubject);
}

function createChoice(
  candidate: TransitionCandidate,
  registry: TransitionRegistry,
): GrantChoice {
  assertExactKeys(candidate, [
    'transitionId',
    'parameters',
    'allowedReasonCodes',
    'reasonRequired',
    'proposedReason',
  ]);
  if (
    !STABLE_ID.test(candidate.transitionId) ||
    !Array.isArray(candidate.allowedReasonCodes) ||
    candidate.allowedReasonCodes.length < 1 ||
    !candidate.allowedReasonCodes.every((value) => STABLE_ID.test(value)) ||
    new Set(candidate.allowedReasonCodes).size !==
      candidate.allowedReasonCodes.length ||
    typeof candidate.reasonRequired !== 'boolean'
  ) {
    throw grantInvalid(
      'GRANT_CANDIDATE_INVALID',
      'Grant transition candidate is malformed.',
    );
  }
  const normalized = registry.normalizeParameters(
    candidate.transitionId,
    candidate.parameters,
  );
  const allowedReasonCodes = Object.freeze([...candidate.allowedReasonCodes]);
  const proposedReason = canonicalReason(candidate.proposedReason, true);
  const choicePayload = {
    transitionId: candidate.transitionId,
    parameters: normalized.parameters,
    parameterDigest: sha256(canonicalJson(normalized.parameters)),
    parameterSchemaDigest: normalized.definition.parameterSchemaDigest,
    consequenceDigest: normalized.definition.consequenceDigest,
    resolutionKind: normalized.definition.resolutionKind,
    allowedApprovalMethods: Object.freeze([
      ...normalized.definition.allowedApprovalMethods,
    ]),
    allowedReasonCodes,
    reasonRequired: candidate.reasonRequired,
    proposedReason,
  };
  return deepFreeze({
    choiceId: sha256(canonicalJson(choicePayload)),
    ...choicePayload,
  });
}

function assertGrantChoice(value: unknown): GrantChoice {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'choiceId',
      'transitionId',
      'parameters',
      'parameterDigest',
      'parameterSchemaDigest',
      'consequenceDigest',
      'resolutionKind',
      'allowedApprovalMethods',
      'allowedReasonCodes',
      'reasonRequired',
      'proposedReason',
    ]) ||
    typeof value.choiceId !== 'string' ||
    !SHA256_DIGEST.test(value.choiceId) ||
    typeof value.transitionId !== 'string' ||
    !STABLE_ID.test(value.transitionId) ||
    typeof value.parameterDigest !== 'string' ||
    !SHA256_DIGEST.test(value.parameterDigest) ||
    typeof value.parameterSchemaDigest !== 'string' ||
    !SHA256_DIGEST.test(value.parameterSchemaDigest) ||
    typeof value.consequenceDigest !== 'string' ||
    !SHA256_DIGEST.test(value.consequenceDigest) ||
    !['retry', 'non-retry'].includes(String(value.resolutionKind)) ||
    !hasCanonicalApprovalMethods(value.allowedApprovalMethods) ||
    !Array.isArray(value.allowedReasonCodes) ||
    value.allowedReasonCodes.length < 1 ||
    !value.allowedReasonCodes.every(
      (reasonCode) =>
        typeof reasonCode === 'string' && STABLE_ID.test(reasonCode),
    ) ||
    new Set(value.allowedReasonCodes).size !==
      value.allowedReasonCodes.length ||
    typeof value.reasonRequired !== 'boolean' ||
    typeof value.proposedReason !== 'string'
  ) {
    throw grantInvalid('GRANT_CHOICE_INVALID', 'Grant choice is malformed.');
  }
  const parameters = freezeCanonical(value.parameters);
  if (sha256(canonicalJson(parameters)) !== value.parameterDigest) {
    throw grantInvalid(
      'GRANT_CHOICE_INVALID',
      'Grant choice parameters do not match their digest.',
    );
  }
  const choicePayload = {
    transitionId: value.transitionId,
    parameters,
    parameterDigest: value.parameterDigest as `sha256:${string}`,
    parameterSchemaDigest: value.parameterSchemaDigest as `sha256:${string}`,
    consequenceDigest: value.consequenceDigest as `sha256:${string}`,
    resolutionKind: value.resolutionKind as 'retry' | 'non-retry',
    allowedApprovalMethods: Object.freeze([
      ...value.allowedApprovalMethods,
    ]) as readonly GrantApprovalMethod[],
    allowedReasonCodes: Object.freeze([
      ...value.allowedReasonCodes,
    ]) as readonly string[],
    reasonRequired: value.reasonRequired,
    proposedReason: canonicalReason(value.proposedReason, true),
  };
  if (sha256(canonicalJson(choicePayload)) !== value.choiceId) {
    throw grantInvalid(
      'GRANT_CHOICE_INVALID',
      'Grant choice does not match its digest.',
    );
  }
  return deepFreeze({
    choiceId: value.choiceId as `sha256:${string}`,
    ...choicePayload,
  });
}

function hasCanonicalApprovalMethods(
  value: unknown,
): value is readonly GrantApprovalMethod[] {
  return (
    Array.isArray(value) &&
    (value.length === 1 || value.length === 2) &&
    value.every((method) => method === 'human-presence' || method === 'ssh') &&
    new Set(value).size === value.length &&
    (value.length === 1 ||
      (value[0] === 'human-presence' && value[1] === 'ssh'))
  );
}

function canonicalReason(value: string, required: boolean): string {
  if (typeof value !== 'string') {
    throw grantInvalid('GRANT_REASON_INVALID', 'Grant reason is invalid.');
  }
  const normalized = value.trim();
  if (
    (required && normalized.length < 1) ||
    normalized.length > MAX_REASON_LENGTH ||
    /[\0\r]/.test(normalized)
  ) {
    throw grantInvalid('GRANT_REASON_INVALID', 'Grant reason is invalid.');
  }
  return normalized;
}

function assertExactKeys(value: unknown, keys: readonly string[]): void {
  if (!isRecord(value) || !hasExactKeys(value, keys)) {
    throw grantInvalid('GRANT_REQUEST_INVALID', 'Grant request is malformed.');
  }
}

function exactDate(value: Date): Date {
  const copy = copyGrantDate(value);
  if (copy === null) {
    throw grantInvalid('GRANT_TIME_INVALID', 'Grant time is invalid.');
  }
  return copy;
}

function exactTimestamp(value: string): Date {
  const parsed = parseGrantTimestamp(value);
  if (parsed === null) {
    throw grantInvalid('GRANT_TIME_INVALID', 'Grant time is invalid.');
  }
  return parsed;
}

function grantInvalid(code: string, message: string) {
  return workflowError(code, message, ExitCode.guard);
}
