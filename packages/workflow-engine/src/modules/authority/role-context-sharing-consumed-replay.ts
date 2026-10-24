import type { VerifiedConsumedRoleContextSharingReplay } from './role-context-sharing-grant-lifecycle-port.ts';
export type { VerifiedConsumedRoleContextSharingReplay } from './role-context-sharing-grant-lifecycle-port.ts';
/**
 * Verifies consumed role-context-sharing records and replays their stored
 * evidence for matching admission inputs.
 *
 * Invariants:
 * - Replay verification requires a consumed record with exactly two
 *   receipts and matching envelope, binding and admission evidence.
 * - consumedRoleContextSharingUseForReplay re-emits stored evidence only
 *   when the proof's admissionDigest equals both the WeakMap-held digest
 *   and the recomputed digest of the supplied inputs.
 */
import crypto from 'node:crypto';

import {
  ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
  type RoleContextSharingGrantExpectedBindingV1,
} from '@jigwright/core/role-context-sharing-grant-codec';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  ConsumedRoleContextSharingUseEvidenceV1,
  RoleContextSharingLifecycleRecordV1,
} from './role-context-sharing-grant-lifecycle-port.ts';
import {
  assertConsumedRoleContextSharingGrantReplayVerifier,
  verifyConsumedRoleContextSharingGrantReplaySignature,
  type ConsumedRoleContextSharingGrantReplayVerifier,
} from './role-context-sharing-grant-verifier-port.ts';
import {
  ROLE_CONTEXT_SHARING_MAX_TTL_MINUTES,
  isKnownRoleContextSharingPolicyDigest,
} from './role-context-sharing-grant.ts';
import type { MaintainerPolicy } from './maintainer-policy.ts';

const DIGEST = /^[0-9a-f]{64}$/u;
const verifiedConsumedRoleContextSharingReplays = new WeakMap<
  object,
  Readonly<{
    evidence: ConsumedRoleContextSharingUseEvidenceV1;
    admissionDigest: string;
  }>
>();

export type RoleContextSharingResultAdmissionBindingV1 = Readonly<{
  assignment: unknown;
  author: unknown;
  participant: unknown;
  content: unknown;
  providerInvocation: unknown;
}>;

export type VerifyConsumedRoleContextSharingReplayInput = Readonly<{
  record: RoleContextSharingLifecycleRecordV1;
  evidence: ConsumedRoleContextSharingUseEvidenceV1;
  expected: RoleContextSharingGrantExpectedBindingV1;
  policy: MaintainerPolicy;
  verifier: ConsumedRoleContextSharingGrantReplayVerifier;
  assignment: unknown;
  author: unknown;
  participant: unknown;
  content: unknown;
  providerInvocation: Readonly<{
    invocationId: string;
    requestDigest: string;
  }>;
}>;

/**
 * Bind every semantic input admitted after the one-use transition. Keeping this
 * digest in the durable use projection prevents a caller from re-minting a new
 * opaque replay proof for different result bytes.
 */
export function computeRoleContextSharingResultAdmissionDigestV1(
  input: RoleContextSharingResultAdmissionBindingV1,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      kind: 'role-context-sharing-result-admission-binding.v1',
      assignment: input.assignment,
      author: input.author,
      participant: input.participant,
      content: input.content,
      providerInvocation: input.providerInvocation,
    }),
  );
}

export function consumedRoleContextSharingUseForReplay(
  proof: VerifiedConsumedRoleContextSharingReplay,
  input: Readonly<{
    assignment: unknown;
    author: unknown;
    participant: unknown;
    content: unknown;
    providerInvocation: unknown;
  }>,
): ConsumedRoleContextSharingUseEvidenceV1 {
  try {
    const replay = verifiedConsumedRoleContextSharingReplays.get(proof);
    if (
      replay === undefined ||
      proof.admissionDigest !== replay.admissionDigest ||
      replay.admissionDigest !==
        computeRoleContextSharingResultAdmissionDigestV1(input)
    ) {
      throw replayInvalid();
    }
    return structuredClone(replay.evidence);
  } catch (error) {
    if (isReplayInvalid(error)) throw error;
    throw replayInvalid();
  }
}

function exactTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
    ? timestamp
    : undefined;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function replayInvalid() {
  return workflowError(
    'ROLE_CONTEXT_SHARING_GRANT_REPLAY_INVALID',
    'The consumed role-context-sharing Grant replay is invalid.',
    ExitCode.guard,
  );
}

function isReplayInvalid(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ROLE_CONTEXT_SHARING_GRANT_REPLAY_INVALID'
  );
}

export type RoleContextSharingReplayOperations = Pick<
  typeof import('@jigwright/grants/role-context-sharing-degradation'),
  | 'bindingFromRoleContextSharingGrantPayloadV1'
  | 'canonicalRoleContextSharingGrantEnvelopeV1'
  | 'verifyRoleContextSharingGrantCapabilityV1'
>;

export function createConsumedRoleContextSharingReplayVerifier(
  operations: RoleContextSharingReplayOperations,
) {
  const {
    bindingFromRoleContextSharingGrantPayloadV1,
    canonicalRoleContextSharingGrantEnvelopeV1,
    verifyRoleContextSharingGrantCapabilityV1,
  } = operations;

  /**
   * Authenticate one exact terminal R-007 journal record without restoring any
   * live reserve/consume authority. The historical verifier is purpose-branded,
   * and the returned proof can only recover the evidence validated here.
   */
  function verifyConsumedRoleContextSharingReplay(
    input: VerifyConsumedRoleContextSharingReplayInput,
  ): VerifiedConsumedRoleContextSharingReplay {
    try {
      return verifyConsumedRoleContextSharingReplayCore(input);
    } catch (error) {
      if (isReplayInvalid(error)) throw error;
      throw replayInvalid();
    }
  }

  function verifyConsumedRoleContextSharingReplayCore(
    input: VerifyConsumedRoleContextSharingReplayInput,
  ): VerifiedConsumedRoleContextSharingReplay {
    assertConsumedRoleContextSharingGrantReplayVerifier(input.verifier);
    const { record, evidence, expected, policy } = input;
    const envelopeBinding = bindingFromRoleContextSharingGrantPayloadV1(
      evidence.envelope.payload,
    );
    if (
      record.state !== 'consumed' ||
      record.expectedBinding === null ||
      record.use === null ||
      record.reservation === null ||
      record.receiptDigests.length !== 2 ||
      record.receipts.length !== 2 ||
      evidence.kind !== 'role-context-sharing-consumed-use.v1' ||
      record.grantId !== evidence.grantId ||
      record.recordDigest !== evidence.terminalRecordDigest ||
      canonicalJson(record.envelope) !== canonicalJson(evidence.envelope) ||
      canonicalJson(record.expectedBinding) !== canonicalJson(expected) ||
      canonicalJson(evidence.expectedBinding) !== canonicalJson(expected) ||
      canonicalJson(envelopeBinding) !== canonicalJson(expected) ||
      canonicalJson(record.use) !== canonicalJson(evidence.use) ||
      record.reservation.reservationDigest !==
        evidence.reservationReceiptDigest ||
      record.receiptDigests[0] !== evidence.reservationReceiptDigest ||
      record.receiptDigests[1] !== evidence.terminalReceiptDigest ||
      !DIGEST.test(evidence.useProjectionDigest) ||
      sha256(canonicalJson(evidence.use)) !== evidence.useProjectionDigest ||
      evidence.use.assignmentDigest !==
        sha256(canonicalJson(input.assignment)) ||
      !DIGEST.test(evidence.use.admissionDigest) ||
      evidence.use.admissionDigest !==
        computeRoleContextSharingResultAdmissionDigestV1({
          assignment: input.assignment,
          author: input.author,
          participant: input.participant,
          content: input.content,
          providerInvocation: input.providerInvocation,
        }) ||
      evidence.use.invocationId !== input.providerInvocation.invocationId ||
      evidence.use.requestDigest !== input.providerInvocation.requestDigest ||
      sha256(canonicalJson(policy.trustedSigners)) !==
        input.verifier.trustedSignersDigest
    ) {
      throw replayInvalid();
    }

    try {
      verifyRoleContextSharingGrantCapabilityV1({
        readerContractVersion:
          ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
        raw: canonicalRoleContextSharingGrantEnvelopeV1(evidence.envelope),
        expected,
        verifier: Object.freeze({
          verify(
            payload: string,
            signature: string,
            identity: string,
            namespace: string,
          ): void {
            verifyConsumedRoleContextSharingGrantReplaySignature(
              input.verifier,
              payload,
              signature,
              identity,
              namespace,
            );
          },
        }),
        validatePayload(payload) {
          const issuedAt = exactTimestamp(payload.issuedAt);
          const expiresAt = exactTimestamp(payload.expiresAt);
          if (
            payload.repositoryId !== policy.repository.id ||
            payload.repositoryOrigin !== policy.repository.origin ||
            !isKnownRoleContextSharingPolicyDigest(
              payload.roleContextSharingPolicyDigest,
            ) ||
            payload.maxUses !== 1 ||
            policy.maxUses !== 1 ||
            !policy.trustedSigners.some(
              ({ identity }) => identity === payload.signer,
            ) ||
            issuedAt === undefined ||
            expiresAt === undefined ||
            issuedAt > expiresAt ||
            expiresAt - issuedAt >
              Math.min(
                policy.maxTtlMinutes,
                ROLE_CONTEXT_SHARING_MAX_TTL_MINUTES,
              ) *
                60_000
          ) {
            throw replayInvalid();
          }
        },
      });
    } catch (error) {
      if (isReplayInvalid(error)) throw error;
      throw replayInvalid();
    }

    const admissionDigest = evidence.use.admissionDigest;
    const proof = Object.freeze({
      schemaVersion: 1 as const,
      kind: 'verified-consumed-role-context-sharing-replay.v1' as const,
      grantId: evidence.grantId,
      terminalRecordDigest: evidence.terminalRecordDigest,
      useProjectionDigest: evidence.useProjectionDigest,
      admissionDigest,
    });
    verifiedConsumedRoleContextSharingReplays.set(
      proof,
      Object.freeze({ evidence: structuredClone(evidence), admissionDigest }),
    );
    return proof;
  }

  return verifyConsumedRoleContextSharingReplay;
}
