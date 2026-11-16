/**
 * Owns investigation human-resolution Grant evidence and session-bound revocation.
 *
 * Invariants:
 * - Signed bytes, decision validation and historical audit bindings remain exact.
 * - Revocation binds the original envelope bytes to the canonical investigation session.
 */
import type { InvestigationRuntimePaths } from '@jigwright/core/runtime-path-kernel';
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import {
  assertChangeId,
  assertInvestigationId,
} from '../../../foundation/repository-path/repository-path.ts';
import type { MaintainerPolicy } from '../../authority/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../../authority/maintainer-signer-port.ts';
import {
  GRANT_ID,
  assertMaintainerGrantId,
} from '../../authority/maintainer-grant-contracts.ts';
import { deriveAuthorityAuditRepositoryId } from '../../authority/authority-audit-contract.ts';
import {
  digestHumanRevocationSubject,
  type HumanRevocationAuthorization,
  type HumanRevocationOptions,
  type HumanRevocationBinding,
} from '../../authority/human-revocation-contract.ts';
import {
  assertHumanResolutionConsequences,
  assertHumanResolutionDecision,
  humanResolutionDecisionSchemaDigest,
  type HumanResolutionConsequences,
  type HumanResolutionDecision,
  type HumanResolutionExpectedState,
  type HumanResolutionTarget,
  type InvestigationResolutionState,
} from './human-resolution-contract.ts';
import type { InvestigationSession } from './investigation-session-types.ts';
import { isRecord } from './investigation-store-values.ts';
import { humanResolutionGrantUnsafe } from './human-resolution-values.ts';

export const HUMAN_RESOLUTION_SIGNATURE_NAMESPACE =
  'workflow.human-resolution-grant.v1' as const;

export type HumanResolutionGrantPayload = {
  version: 1;
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  trustBaseCommit: string;
  policyBlob: string;
  target: HumanResolutionTarget;
  expected: HumanResolutionExpectedState;
  decision: HumanResolutionDecision;
  consequences: HumanResolutionConsequences;
  rationale: string;
  issuedAt: string;
  expiresAt: string;
  maxUses: 1;
  signer: string;
};

export type HumanResolutionGrantEnvelope = {
  payload: HumanResolutionGrantPayload;
  signature: string;
};

export type HumanResolutionGrantValidationOptions = {
  now: Date;
  expectedTrustBase: string;
  expectedPolicyBlob: string;
  state: InvestigationResolutionState;
  allowExpired?: boolean;
};

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const DIGEST = /^[0-9a-f]{64}$/;

const HUMAN_RESOLUTION_PAYLOAD_KEYS = [
  'version',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'trustBaseCommit',
  'policyBlob',
  'target',
  'expected',
  'decision',
  'consequences',
  'rationale',
  'issuedAt',
  'expiresAt',
  'maxUses',
  'signer',
];

export function canonicalHumanResolutionGrantPayload(
  payload: HumanResolutionGrantPayload,
): string {
  return `${canonicalJson({
    version: payload.version,
    grantId: payload.grantId,
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    trustBaseCommit: payload.trustBaseCommit,
    policyBlob: payload.policyBlob,
    target: payload.target,
    expected: payload.expected,
    decision: payload.decision,
    consequences: payload.consequences,
    rationale: payload.rationale,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
    maxUses: payload.maxUses,
    signer: payload.signer,
  })}\n`;
}

export function canonicalHumanResolutionGrantEnvelope(
  envelope: HumanResolutionGrantEnvelope,
): string {
  const canonicalPayload = JSON.parse(
    canonicalHumanResolutionGrantPayload(envelope.payload),
  ) as HumanResolutionGrantPayload;
  return `${canonicalJson({
    payload: canonicalPayload,
    signature: envelope.signature,
  })}\n`;
}

export function parseHumanResolutionGrantEnvelope(
  raw: string,
): HumanResolutionGrantEnvelope {
  try {
    if (typeof raw !== 'string' || raw.length > 65_536) {
      throw new Error('invalid envelope size');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      !hasExactKeys(value as Record<string, unknown>, ['payload', 'signature'])
    ) {
      throw new Error('invalid envelope');
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.payload !== 'object' ||
      candidate.payload === null ||
      Array.isArray(candidate.payload) ||
      !hasExactKeys(
        candidate.payload as Record<string, unknown>,
        HUMAN_RESOLUTION_PAYLOAD_KEYS,
      ) ||
      typeof candidate.signature !== 'string'
    ) {
      throw new Error('invalid envelope fields');
    }
    const envelope = {
      payload: candidate.payload as HumanResolutionGrantPayload,
      signature: candidate.signature,
    };
    assertArmoredSshSignature(envelope.signature);
    assertMaintainerGrantId(envelope.payload.grantId);
    if (canonicalHumanResolutionGrantEnvelope(envelope) !== raw) {
      throw new Error('non-canonical envelope');
    }
    return envelope;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'MAINTAINER_SIGNATURE_INVALID'
    ) {
      throw error;
    }
    throw humanResolutionGrantInvalid(
      'Human resolution grant envelope is invalid.',
    );
  }
}

export function validateHumanResolutionGrantPayload(
  payload: HumanResolutionGrantPayload,
  policy: MaintainerPolicy,
  options: HumanResolutionGrantValidationOptions,
): void {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !hasExactKeys(
      payload as unknown as Record<string, unknown>,
      HUMAN_RESOLUTION_PAYLOAD_KEYS,
    ) ||
    payload.version !== 1 ||
    !GRANT_ID.test(payload.grantId) ||
    payload.repositoryId !== policy.repository.id ||
    payload.repositoryOrigin !== policy.repository.origin ||
    !COMMIT_OID.test(payload.trustBaseCommit) ||
    payload.trustBaseCommit !== options.expectedTrustBase ||
    !COMMIT_OID.test(payload.policyBlob) ||
    payload.policyBlob !== options.expectedPolicyBlob ||
    payload.maxUses !== 1 ||
    !validReason(payload.rationale) ||
    !policy.trustedSigners.some(({ identity }) => identity === payload.signer)
  ) {
    throw humanResolutionGrantInvalid(
      'Human resolution grant does not match its trusted binding.',
    );
  }
  let decision: HumanResolutionDecision;
  let consequences: HumanResolutionConsequences;
  try {
    decision = assertHumanResolutionDecision(payload.decision);
    consequences = assertHumanResolutionConsequences(payload.consequences);
  } catch {
    throw humanResolutionGrantInvalid(
      'Human resolution grant carries an invalid decision.',
    );
  }
  if (
    payload.target.workflowKind !== 'investigation' ||
    payload.target.changeId !== options.state.envelope.changeId ||
    payload.target.workflowId !== options.state.envelope.investigationId ||
    payload.expected.stateDigest !== options.state.currentStateDigest ||
    payload.expected.currentRefDigest !== options.state.currentRefDigest
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_STALE',
      'Human resolution grant is not bound to the exact current state.',
      ExitCode.staleState,
    );
  }
  const blockerBinding = humanResolutionBlockerBinding(options.state);
  if (
    payload.expected.reasonCode !== blockerBinding.reasonCode ||
    payload.expected.blockedTransition !== blockerBinding.blockedTransition
  ) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_BLOCKER_MISMATCH',
      'Human resolution grant names another blocker or transition.',
      ExitCode.staleState,
    );
  }
  assertResolutionDecisionAvailable(options.state, decision);
  assertResolutionConsequences(decision, consequences);
  const issuedAt = exactTimestamp(payload.issuedAt);
  const expiresAt = exactTimestamp(payload.expiresAt);
  const now = options.now.getTime();
  if (
    issuedAt === undefined ||
    expiresAt === undefined ||
    issuedAt > expiresAt ||
    expiresAt - issuedAt > policy.maxTtlMinutes * 60_000 ||
    issuedAt > now + 30_000
  ) {
    throw humanResolutionGrantInvalid(
      'Human resolution grant has invalid time bounds.',
    );
  }
  if (!options.allowExpired && expiresAt < now) {
    throw workflowError(
      'HUMAN_RESOLUTION_GRANT_EXPIRED',
      'Human resolution grant has expired.',
      ExitCode.staleState,
    );
  }
}

export function assertHumanResolutionAuditPayload(
  payload: HumanResolutionGrantPayload,
  policy: MaintainerPolicy,
  trustBasePolicy: MaintainerPolicy,
  expectedPolicyBlob: string,
): void {
  const target = payload.target as unknown as Record<string, unknown>;
  const expected = payload.expected as unknown as Record<string, unknown>;
  const pinnedSigner = policy.trustedSigners.find(
    ({ identity }) => identity === payload.signer,
  );
  const trustBaseSigner = trustBasePolicy.trustedSigners.find(
    ({ identity }) => identity === payload.signer,
  );
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload) ||
    !hasExactKeys(
      payload as unknown as Record<string, unknown>,
      HUMAN_RESOLUTION_PAYLOAD_KEYS,
    ) ||
    payload.version !== 1 ||
    !GRANT_ID.test(payload.grantId) ||
    payload.repositoryId !== policy.repository.id ||
    payload.repositoryOrigin !== policy.repository.origin ||
    trustBasePolicy.repository.id !== policy.repository.id ||
    trustBasePolicy.repository.origin !== policy.repository.origin ||
    trustBasePolicy.auditTagPrefix !== policy.auditTagPrefix ||
    !COMMIT_OID.test(payload.trustBaseCommit) ||
    !COMMIT_OID.test(payload.policyBlob) ||
    payload.policyBlob !== expectedPolicyBlob ||
    payload.maxUses !== 1 ||
    !validReason(payload.rationale) ||
    !pinnedSigner ||
    !trustBaseSigner ||
    pinnedSigner.publicKey !== trustBaseSigner.publicKey ||
    pinnedSigner.fingerprint !== trustBaseSigner.fingerprint ||
    typeof target !== 'object' ||
    target === null ||
    Array.isArray(target) ||
    !hasExactKeys(target, ['workflowKind', 'changeId', 'workflowId']) ||
    target.workflowKind !== 'investigation' ||
    typeof target.changeId !== 'string' ||
    typeof target.workflowId !== 'string' ||
    typeof expected !== 'object' ||
    expected === null ||
    Array.isArray(expected) ||
    !hasExactKeys(expected, [
      'reasonCode',
      'blockedTransition',
      'stateDigest',
      'currentRefDigest',
    ]) ||
    !validBoundedText(expected.reasonCode, 256) ||
    !validBoundedText(expected.blockedTransition, 256) ||
    typeof expected.stateDigest !== 'string' ||
    !DIGEST.test(expected.stateDigest) ||
    (expected.currentRefDigest !== null &&
      (typeof expected.currentRefDigest !== 'string' ||
        !DIGEST.test(expected.currentRefDigest)))
  ) {
    throw humanResolutionGrantInvalid(
      'Human resolution audit grant does not match its trusted binding.',
    );
  }

  try {
    assertChangeId(target.changeId);
    assertInvestigationId(target.workflowId);
    const consequences = assertHumanResolutionConsequences(
      payload.consequences,
    );
    const decision = assertHumanResolutionDecision(payload.decision);
    assertResolutionConsequences(decision, consequences);
  } catch {
    throw humanResolutionGrantInvalid(
      'Human resolution audit grant carries an invalid decision.',
    );
  }

  const issuedAt = exactTimestamp(payload.issuedAt);
  const expiresAt = exactTimestamp(payload.expiresAt);
  const maximumTtl =
    Math.min(policy.maxTtlMinutes, trustBasePolicy.maxTtlMinutes) * 60_000;
  if (
    issuedAt === undefined ||
    expiresAt === undefined ||
    issuedAt > expiresAt ||
    expiresAt - issuedAt > maximumTtl
  ) {
    throw humanResolutionGrantInvalid(
      'Human resolution audit grant has invalid time bounds.',
    );
  }
}

function exactTimestamp(value: string): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : undefined;
}

function assertArmoredSshSignature(signature: string): void {
  if (
    typeof signature !== 'string' ||
    signature.length > 16_384 ||
    signature.includes('\r') ||
    !/^-----BEGIN SSH SIGNATURE-----\n(?:[A-Za-z0-9+/=]+\n)+-----END SSH SIGNATURE-----\n$/.test(
      signature,
    )
  ) {
    throw workflowError(
      'MAINTAINER_SIGNATURE_INVALID',
      'The maintainer grant SSH signature is invalid.',
      ExitCode.verification,
    );
  }
}

function validReason(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 12 &&
    value.length <= 500 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

function validBoundedText(value: unknown, maxBytes: number): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    Buffer.byteLength(value, 'utf8') <= maxBytes &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 31 || (code >= 127 && code <= 159);
    })
  );
}

export function humanResolutionBlockerBinding(
  state: InvestigationResolutionState,
): Pick<HumanResolutionExpectedState, 'reasonCode' | 'blockedTransition'> {
  const blocker = state.blocker;
  if (blocker === null) {
    return {
      reasonCode: 'HUMAN_ROOT_DECISION_REQUESTED',
      blockedTransition: 'workflow-state',
    };
  }
  if (!('code' in blocker)) {
    return {
      reasonCode: blocker.reasonCode,
      blockedTransition: blocker.blockedTransition,
    };
  }
  return {
    reasonCode: blocker.code,
    blockedTransition: 'workflow-state',
  };
}

export function assertResolutionDecisionAvailable(
  state: InvestigationResolutionState,
  decision: HumanResolutionDecision,
): void {
  const advertised = state.availableResolutions.find(
    ({ kind }) => kind === decision.kind,
  );
  if (
    !advertised ||
    advertised.parameterSchemaDigest !==
      humanResolutionDecisionSchemaDigest(decision.kind)
  ) {
    throw humanResolutionGrantInvalid(
      'The selected decision is not executable from the bound state.',
    );
  }
}

export function assertResolutionConsequences(
  decision: HumanResolutionDecision,
  consequences: HumanResolutionConsequences,
): void {
  switch (decision.kind) {
    case 'resume-with-capability':
      if (
        consequences.continuity !== 'preserved' ||
        consequences.assurance !== 'unchanged' ||
        consequences.claimsWaived.length !== 0
      ) {
        throw humanResolutionGrantInvalid(
          'An additional bounded capability must preserve continuity without changing assurance.',
        );
      }
      return;
    case 'close-input':
      if (
        consequences.continuity !== 'preserved' ||
        consequences.assurance === 'unchanged' ||
        !consequences.claimsWaived.includes('reviewer-term-incorporation')
      ) {
        throw humanResolutionGrantInvalid(
          'Closing reviewer input must preserve continuity and explicitly downgrade reviewer-term incorporation assurance.',
        );
      }
      return;
    case 'abort':
      if (
        consequences.continuity === 'preserved' ||
        consequences.assurance !== 'degraded'
      ) {
        throw humanResolutionGrantInvalid(
          'Abort must declare non-preserved continuity and degraded assurance.',
        );
      }
      return;
    case 'supersede':
    case 'repair':
      if (
        consequences.continuity !== 'broken' ||
        consequences.assurance !== 'degraded'
      ) {
        throw humanResolutionGrantInvalid(
          'Supersede and repair must declare broken continuity and degraded assurance.',
        );
      }
      return;
    case 'quarantine':
      if (
        consequences.continuity !== 'not-applicable' ||
        consequences.assurance !== 'degraded'
      ) {
        throw humanResolutionGrantInvalid(
          'Quarantine must avoid a continuity claim and declare degraded assurance.',
        );
      }
      return;
    case 'waive-assurance':
      if (
        consequences.continuity !== 'preserved' ||
        consequences.assurance !== 'human-waived' ||
        !consequences.claimsWaived.includes(decision.claim)
      ) {
        throw humanResolutionGrantInvalid(
          'An assurance waiver must preserve continuity while naming and downgrading the waived claim.',
        );
      }
      return;
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i])
  );
}

export function humanResolutionGrantInvalid(message: string) {
  return workflowError(
    'HUMAN_RESOLUTION_GRANT_INVALID',
    message,
    ExitCode.guard,
  );
}

export type HumanResolutionAuditTagReader = (
  repositoryRoot: string,
  policy: MaintainerPolicy,
  observedRef: string,
) => HumanResolutionGrantEnvelope | null;

export type HumanResolutionServices = Readonly<{
  loadMaintainerPolicyForResolution: (
    repositoryRoot: string,
    trustBaseCommit: string,
  ) => { policy: MaintainerPolicy; policyBlob: string };
  assertResolutionDecisionTarget: (
    paths: InvestigationRuntimePaths,
    state: InvestigationResolutionState,
    decision: HumanResolutionDecision,
  ) => void;
  verifyHumanResolutionGrantEnvelope: (
    repositoryRoot: string,
    envelope: HumanResolutionGrantEnvelope,
    policy: MaintainerPolicy,
    verifier?: MaintainerSignerProvider,
  ) => void;
  verifyHumanResolutionGrantForRevocation: (
    repositoryRoot: string,
    envelope: HumanResolutionGrantEnvelope,
    verifier?: MaintainerSignerProvider,
  ) => void;
}>;

export type HumanResolutionGrantStoreEntry = {
  grantId: string;
  state: 'available' | 'reserved' | 'revoked' | 'consumed';
  envelopeBytes: string;
  terminalReason: string | null;
  recordedAt: string | null;
  revocationAuthorization?: HumanRevocationAuthorization;
};

export type HumanResolutionRevocationStore = Readonly<{
  inspect: (grantId: string) => HumanResolutionGrantStoreEntry | null;
  hasPreparedJournal: (grantId: string) => boolean;
  binding: (envelopeBytes: string, grantId: string) => HumanRevocationBinding;
  authorizationPath: (grantId: string) => string;
  publish: (
    grantId: string,
    authorization: HumanRevocationAuthorization,
  ) => HumanResolutionGrantStoreEntry;
}>;

export type OpenHumanResolutionRevocationStore = (
  paths: InvestigationRuntimePaths,
) => HumanResolutionRevocationStore;

export type HumanResolutionGrantRevoker = (
  paths: InvestigationRuntimePaths,
  cwd: string,
  requestedGrantId: string,
  options: HumanRevocationOptions,
) => HumanResolutionGrantStoreEntry;

export function humanResolutionRevocationBinding(
  envelopeBytes: string,
  grantId: string,
  readSession: (
    investigationId: string,
  ) => Pick<InvestigationSession, 'changeId' | 'mandateBinding'>,
) {
  let envelope: unknown;
  try {
    envelope = JSON.parse(envelopeBytes);
  } catch {
    throw humanResolutionGrantUnsafe();
  }
  if (!isRecord(envelope) || !isRecord(envelope.payload)) {
    throw humanResolutionGrantUnsafe();
  }
  const payload = envelope.payload;
  if (
    payload.grantId !== grantId ||
    typeof payload.repositoryId !== 'string' ||
    typeof payload.repositoryOrigin !== 'string' ||
    !isRecord(payload.target) ||
    typeof payload.target.changeId !== 'string' ||
    typeof payload.target.workflowId !== 'string'
  ) {
    throw humanResolutionGrantUnsafe();
  }
  const session = readSession(payload.target.workflowId);
  if (
    session.changeId !== payload.target.changeId ||
    (session.mandateBinding !== undefined &&
      session.mandateBinding.changeId !== payload.target.changeId)
  ) {
    throw workflowError(
      'HUMAN_REVOCATION_BINDING_INVALID',
      'Human-resolution revocation session binding is unavailable or different.',
      ExitCode.guard,
    );
  }
  return {
    subjectKind: 'human-resolution-grant' as const,
    grantId,
    grantDigest: digestHumanRevocationSubject(envelopeBytes),
    repositoryId: payload.repositoryId,
    repositoryOrigin: payload.repositoryOrigin,
    changeId: payload.target.changeId,
    taskId: session.mandateBinding?.mandateTaskId ?? null,
    workflowId: payload.target.workflowId,
    audit: session.mandateBinding
      ? {
          externalAuditRoot: session.mandateBinding.externalAuditRoot,
          repositoryId: deriveAuthorityAuditRepositoryId(payload.repositoryId),
        }
      : null,
  };
}
