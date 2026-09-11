import type { ImmutableCandidateBundleV2 } from './maintainer-candidate-contracts.ts';
/**
 * Encodes exact Maintainer Grant payloads, envelopes, evidence waivers and
 * check attestations.
 *
 * Invariants:
 * - parseMaintainerGrantV2Envelope rejects any envelope whose re-serialized
 *   canonical form is not byte-identical to the raw input.
 * - validateMaintainerGrantV2Payload caps a grant's lifetime at
 *   MAX_V2_TTL_MINUTES (seven days) between issuedAt and expiresAt.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  isRecord,
  isStringArray,
} from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { assertMaintainerGrantId } from './maintainer-grant-contracts.ts';
import {
  canonicalImmutableCandidateBundle,
  parseImmutableCandidateBundle,
} from './maintainer-candidate-contracts.ts';

import {
  canonicalPatchManifest,
  parsePatchManifest,
} from './maintainer-manifest-contracts.ts';
import type {
  CapabilityProfile,
  PatchManifest,
} from './maintainer-manifest-contracts.ts';
import { type TaskMandateBinding } from './task-mandate-contract.ts';
import type { CheckEvidence } from '../assurance/check-evidence.ts';
import { assertChangeId } from '../../foundation/repository-path/repository-path.ts';

export const MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE =
  'workflow.maintainer-grant.v2' as const;

export type MaintainerEvidenceOverlayEntry = {
  path: string;
  role: 'evidence';
};

export type MaintainerEvidenceWaiver = {
  checkId: string;
  /** Waives max-age admission only; exact binding, outcome, environment, and
   * dependency invalidation remain mandatory. */
  reason: string;
};

export type MaintainerPreapprovalCheck = {
  evidence: CheckEvidence;
  commandDigest: string;
  startedAt: string;
  completedAt: string;
};

type MaintainerChecksAttestationCommon = {
  trustBaseCommit: string;
  policyDigest: string;
  patchDigest: string;
  candidateStateDigest: string;
  environmentDigest: string;
  checks: MaintainerPreapprovalCheck[];
};

export type MaintainerChecksAttestationV2 =
  MaintainerChecksAttestationCommon & {
    schemaVersion: 2;
    harnessEngineDigest: string;
  };

export type MaintainerChecksAttestation = MaintainerChecksAttestationV2;

export type MaintainerGrantV2Payload = {
  version: 2;
  grantId: string;
  repositoryId: string;
  repositoryOrigin: string;
  baseCommit: string;
  policyBlob: string;
  policyDigest: string;
  changeId: string;
  taskId: string;
  mandateBinding: TaskMandateBinding;
  profile: string;
  profileVersion: number;
  classification: 'ordinary' | 'root-one-shot';
  manifest: PatchManifest;
  manifestDigest: string;
  patchDigest: string;
  allowedPaths: string[];
  evidenceOverlay: MaintainerEvidenceOverlayEntry[];
  requiredChecks: string[];
  evidenceWaivers: MaintainerEvidenceWaiver[];
  checkDependencies: CapabilityProfile['checkDependencies'];
  checksAttestation: MaintainerChecksAttestationV2 | null;
  checksAttestationDigest: string | null;
  candidateBundle: ImmutableCandidateBundleV2 | null;
  candidateBundleDigest: string | null;
  effectsManifestDigest: string | null;
  issuedAt: string;
  expiresAt: string;
  maxUses: 1;
  reason: string;
  signer: string;
};

export type MaintainerGrantV2Envelope = {
  payload: MaintainerGrantV2Payload;
  signatureNamespace: typeof MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE;
  signature: string;
};

export const MAX_V2_TTL_MINUTES = 7 * 24 * 60;

const DIGEST = /^[0-9a-f]{64}$/;

const COMMIT_OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const PAYLOAD_KEYS = [
  'version',
  'grantId',
  'repositoryId',
  'repositoryOrigin',
  'baseCommit',
  'policyBlob',
  'policyDigest',
  'changeId',
  'taskId',
  'mandateBinding',
  'profile',
  'profileVersion',
  'classification',
  'manifest',
  'manifestDigest',
  'patchDigest',
  'allowedPaths',
  'evidenceOverlay',
  'requiredChecks',
  'evidenceWaivers',
  'checkDependencies',
  'checksAttestation',
  'checksAttestationDigest',
  'candidateBundle',
  'candidateBundleDigest',
  'effectsManifestDigest',
  'issuedAt',
  'expiresAt',
  'maxUses',
  'reason',
  'signer',
];

const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function parseMaintainerEvidenceWaivers(
  value: unknown,
): MaintainerEvidenceWaiver[] {
  if (!Array.isArray(value)) throw invalidEvidenceWaiver();
  const waivers = value.map((entry): MaintainerEvidenceWaiver => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, ['checkId', 'reason']) ||
      typeof entry.checkId !== 'string' ||
      !CHECK_ID.test(entry.checkId) ||
      typeof entry.reason !== 'string' ||
      !validReason(entry.reason)
    ) {
      throw invalidEvidenceWaiver();
    }
    return { checkId: entry.checkId, reason: entry.reason };
  });
  if (!isSortedUnique(waivers.map(({ checkId }) => checkId))) {
    throw invalidEvidenceWaiver();
  }
  return waivers;
}

export function validateMaintainerEvidenceWaivers(
  value: unknown,
  requiredChecks: string[],
  checkDependencies: CapabilityProfile['checkDependencies'],
): MaintainerEvidenceWaiver[] {
  const waivers = parseMaintainerEvidenceWaivers(value);
  const required = new Set(requiredChecks);
  if (waivers.some(({ checkId }) => !required.has(checkId))) {
    throw invalidEvidenceWaiver();
  }
  if (
    waivers.some(({ checkId }) =>
      checkDependencies[checkId]?.includes('external-state'),
    )
  ) {
    throw invalidEvidenceWaiver(
      'Named evidence waivers cannot target external-state checks without a current snapshot comparison.',
    );
  }
  return waivers;
}

export function canonicalMaintainerGrantV2Payload(
  payload: MaintainerGrantV2Payload,
): string {
  return `${canonicalJson(payload)}\n`;
}

export function canonicalMaintainerGrantV2Envelope(
  envelope: MaintainerGrantV2Envelope,
): string {
  const payload = JSON.parse(
    canonicalMaintainerGrantV2Payload(envelope.payload),
  ) as MaintainerGrantV2Payload;
  const signatureNamespace = maintainerGrantV2SignatureNamespace(envelope);
  const canonicalEnvelope = {
    payload,
    signatureNamespace,
    signature: envelope.signature,
  };
  return `${canonicalJson(canonicalEnvelope)}\n`;
}

export function canonicalMaintainerChecksAttestation(
  attestation: MaintainerChecksAttestation,
): string {
  return `${canonicalJson(attestation)}\n`;
}

export function maintainerChecksEnvironmentDigest(
  databaseIdentity: string | null,
): string {
  return digest(
    canonicalJson({
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      databaseIdentity,
    }),
  );
}

export function parseMaintainerGrantV2Envelope(
  raw: string,
): MaintainerGrantV2Envelope {
  try {
    if (typeof raw !== 'string' || raw.length > 1_048_576) {
      throw new Error('invalid envelope size');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['payload', 'signatureNamespace', 'signature']) ||
      !isRecord(value.payload) ||
      !hasExactKeys(value.payload, PAYLOAD_KEYS) ||
      value.signatureNamespace !== MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE ||
      typeof value.signature !== 'string'
    ) {
      throw new Error('invalid envelope shape');
    }
    const payload = parseMaintainerGrantV2Payload(value.payload);
    const envelope: MaintainerGrantV2Envelope = {
      payload,
      signatureNamespace: MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
      signature: value.signature,
    };
    assertArmoredSignature(envelope.signature);
    if (canonicalMaintainerGrantV2Envelope(envelope) !== raw) {
      throw new Error('noncanonical envelope');
    }
    return envelope;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'MAINTAINER_SIGNATURE_INVALID' ||
        error.code === 'MAINTAINER_EVIDENCE_WAIVER_INVALID')
    ) {
      throw error;
    }
    throw invalidGrant('Maintainer grant v2 envelope is invalid.');
  }
}

export function maintainerGrantV2SignatureNamespace(
  envelope: MaintainerGrantV2Envelope,
): typeof MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE {
  if (envelope.signatureNamespace === MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE) {
    return envelope.signatureNamespace;
  }
  throw invalidGrant('Maintainer grant v2 signature namespace is invalid.');
}

function parseMaintainerGrantV2Payload(
  raw: Record<string, unknown>,
): MaintainerGrantV2Payload {
  const manifest = parsePatchManifest(raw.manifest);
  const evidence = raw.evidenceOverlay;
  const evidenceWaivers = parseMaintainerEvidenceWaivers(raw.evidenceWaivers);
  if (
    raw.version !== 2 ||
    typeof raw.grantId !== 'string' ||
    typeof raw.repositoryId !== 'string' ||
    typeof raw.repositoryOrigin !== 'string' ||
    typeof raw.baseCommit !== 'string' ||
    typeof raw.policyBlob !== 'string' ||
    typeof raw.policyDigest !== 'string' ||
    typeof raw.changeId !== 'string' ||
    typeof raw.taskId !== 'string' ||
    !isRecord(raw.mandateBinding) ||
    typeof raw.profile !== 'string' ||
    typeof raw.profileVersion !== 'number' ||
    (raw.classification !== 'ordinary' &&
      raw.classification !== 'root-one-shot') ||
    typeof raw.manifestDigest !== 'string' ||
    typeof raw.patchDigest !== 'string' ||
    !isStringArray(raw.allowedPaths) ||
    !Array.isArray(evidence) ||
    !isStringArray(raw.requiredChecks) ||
    !isRecord(raw.checkDependencies) ||
    (raw.checksAttestation !== null && !isRecord(raw.checksAttestation)) ||
    (raw.checksAttestationDigest !== null &&
      typeof raw.checksAttestationDigest !== 'string') ||
    (raw.candidateBundle !== null && !isRecord(raw.candidateBundle)) ||
    (raw.candidateBundleDigest !== null &&
      typeof raw.candidateBundleDigest !== 'string') ||
    (raw.effectsManifestDigest !== null &&
      typeof raw.effectsManifestDigest !== 'string') ||
    typeof raw.issuedAt !== 'string' ||
    typeof raw.expiresAt !== 'string' ||
    raw.maxUses !== 1 ||
    typeof raw.reason !== 'string' ||
    typeof raw.signer !== 'string'
  ) {
    throw new Error('invalid payload fields');
  }
  const payload: MaintainerGrantV2Payload = {
    version: 2,
    grantId: raw.grantId,
    repositoryId: raw.repositoryId,
    repositoryOrigin: raw.repositoryOrigin,
    baseCommit: raw.baseCommit,
    policyBlob: raw.policyBlob,
    policyDigest: raw.policyDigest,
    changeId: raw.changeId,
    taskId: raw.taskId,
    mandateBinding: structuredClone(raw.mandateBinding) as TaskMandateBinding,
    profile: raw.profile,
    profileVersion: raw.profileVersion,
    classification: raw.classification,
    manifest,
    manifestDigest: raw.manifestDigest,
    patchDigest: raw.patchDigest,
    allowedPaths: [...raw.allowedPaths],
    evidenceOverlay: evidence.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ['path', 'role']) ||
        typeof entry.path !== 'string' ||
        entry.role !== 'evidence'
      ) {
        throw new Error('invalid evidence overlay');
      }
      return { path: entry.path, role: 'evidence' as const };
    }),
    requiredChecks: [...raw.requiredChecks],
    evidenceWaivers,
    checkDependencies: Object.fromEntries(
      Object.entries(raw.checkDependencies).map(([checkId, dependencies]) => {
        if (!isStringArray(dependencies)) {
          throw new Error('invalid check dependencies');
        }
        return [checkId, [...dependencies]];
      }),
    ) as CapabilityProfile['checkDependencies'],
    checksAttestation:
      raw.checksAttestation === null
        ? null
        : parseMaintainerChecksAttestation(raw.checksAttestation),
    checksAttestationDigest: raw.checksAttestationDigest,
    candidateBundle:
      raw.candidateBundle === null
        ? null
        : parseImmutableCandidateBundle(
            canonicalImmutableCandidateBundle(
              raw.candidateBundle as ImmutableCandidateBundleV2,
            ),
          ),
    candidateBundleDigest: raw.candidateBundleDigest,
    effectsManifestDigest: raw.effectsManifestDigest,
    issuedAt: raw.issuedAt,
    expiresAt: raw.expiresAt,
    maxUses: 1,
    reason: raw.reason,
    signer: raw.signer,
  };
  validateMaintainerGrantV2Payload(payload);
  return payload;
}

export function validateMaintainerGrantV2Payload(
  payload: MaintainerGrantV2Payload,
): void {
  assertMaintainerGrantId(payload.grantId);
  try {
    assertChangeId(payload.changeId);
  } catch {
    throw invalidGrant('Maintainer grant v2 change binding is invalid.');
  }
  const issuedAt = exactTimestamp(payload.issuedAt);
  const expiresAt = exactTimestamp(payload.expiresAt);
  const expectedPaths = payload.manifest.files.map(
    ({ path: filePath }) => filePath,
  );
  const expectedOverlay = evidenceOverlay(payload.manifest);
  validateMaintainerEvidenceWaivers(
    payload.evidenceWaivers,
    payload.requiredChecks,
    payload.checkDependencies,
  );
  if (
    payload.checksAttestation === null ||
    payload.checksAttestationDigest === null ||
    payload.candidateBundle === null ||
    payload.candidateBundleDigest === null ||
    payload.effectsManifestDigest === null
  ) {
    throw invalidGrant(
      'Maintainer grant v2 requires an immutable candidate and its exact checks attestation.',
    );
  }
  if (
    payload.version !== 2 ||
    !payload.repositoryId.startsWith('github:') ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      payload.repositoryOrigin,
    ) ||
    !COMMIT_OID.test(payload.baseCommit) ||
    !COMMIT_OID.test(payload.policyBlob) ||
    !DIGEST.test(payload.policyDigest) ||
    payload.profile !== payload.manifest.profile ||
    payload.profileVersion !== payload.manifest.profileVersion ||
    (payload.classification !== 'ordinary' &&
      payload.classification !== 'root-one-shot') ||
    payload.policyDigest !== payload.manifest.policyDigest ||
    payload.manifestDigest !==
      digest(canonicalPatchManifest(payload.manifest)) ||
    payload.patchDigest !== payload.manifest.patchDigest ||
    !equalStringArrays(payload.allowedPaths, expectedPaths) ||
    canonicalJson(payload.evidenceOverlay) !== canonicalJson(expectedOverlay) ||
    payload.requiredChecks.length === 0 ||
    !isSortedUnique(payload.requiredChecks) ||
    canonicalJson(Object.keys(payload.checkDependencies).sort()) !==
      canonicalJson(payload.requiredChecks) ||
    payload.checksAttestationDigest !==
      digest(canonicalMaintainerChecksAttestation(payload.checksAttestation)) ||
    payload.checksAttestation.trustBaseCommit !== payload.baseCommit ||
    payload.checksAttestation.policyDigest !== payload.policyDigest ||
    payload.checksAttestation.patchDigest !== payload.patchDigest ||
    !equalStringArrays(
      payload.checksAttestation.checks.map(({ evidence }) => evidence.checkId),
      payload.requiredChecks,
    ) ||
    payload.candidateBundleDigest !==
      payload.candidateBundle.candidateBundleDigest ||
    payload.effectsManifestDigest !==
      payload.candidateBundle.effectsManifestDigest ||
    payload.taskId !== payload.mandateBinding.mandateTaskId ||
    payload.changeId !== payload.mandateBinding.changeId ||
    canonicalJson(payload.mandateBinding) !==
      canonicalJson(payload.candidateBundle.mandateBinding) ||
    payload.candidateBundle.repositoryId !== payload.repositoryId ||
    payload.candidateBundle.expectedOldCommit !== payload.baseCommit ||
    payload.candidateBundle.manifestDigest !== payload.manifestDigest ||
    payload.candidateBundle.manifest.patchDigest !== payload.patchDigest ||
    payload.candidateBundle.classification !== payload.classification ||
    canonicalPatchManifest(payload.candidateBundle.manifest) !==
      canonicalPatchManifest(payload.manifest) ||
    !equalStringArrays(
      payload.candidateBundle.checksAttestation.checks.map(
        ({ checkId }) => checkId,
      ),
      payload.requiredChecks,
    ) ||
    !candidateChecksAreExact(
      payload.candidateBundle,
      payload.checksAttestation,
    ) ||
    issuedAt === undefined ||
    expiresAt === undefined ||
    issuedAt > expiresAt ||
    expiresAt - issuedAt > MAX_V2_TTL_MINUTES * 60_000 ||
    payload.maxUses !== 1 ||
    !validReason(payload.reason) ||
    payload.signer.length === 0 ||
    payload.signer.length > 128
  ) {
    throw invalidGrant(
      'Maintainer grant v2 does not match its exact-patch binding.',
    );
  }
}

export function candidateChecksAreExact(
  candidate: ImmutableCandidateBundleV2,
  attestation: MaintainerChecksAttestationV2,
): boolean {
  const candidateChecks = candidate.checksAttestation.checks;
  return (
    candidateChecks.length === attestation.checks.length &&
    candidateChecks.every((candidateCheck, index) => {
      const grantCheck = attestation.checks[index];
      return (
        grantCheck !== undefined &&
        candidateCheck.checkId === grantCheck.evidence.checkId &&
        // Both bindings are checked here against what ran; that they agree is
        // an invariant the check journal enforces separately, comparing the
        // command that ran against the trust base's own definition digest.
        candidateCheck.definitionDigest === grantCheck.commandDigest &&
        candidateCheck.commandDigest === grantCheck.commandDigest &&
        candidateCheck.runnerDigest === grantCheck.evidence.runnerDigest &&
        candidateCheck.environmentDigest === attestation.environmentDigest &&
        candidateCheck.resultDigest ===
          digest(canonicalJson(grantCheck.evidence)) &&
        candidateCheck.outcome === 'passed' &&
        candidateCheck.startedAt === grantCheck.startedAt &&
        candidateCheck.completedAt === grantCheck.completedAt
      );
    }) &&
    candidate.checksAttestation.dependencySnapshot.harnessEngineDigest ===
      attestation.harnessEngineDigest
  );
}

function parseMaintainerChecksAttestation(
  raw: Record<string, unknown>,
): MaintainerChecksAttestationV2 {
  const attestationKeys = [
    'schemaVersion',
    'trustBaseCommit',
    'policyDigest',
    'patchDigest',
    'candidateStateDigest',
    'environmentDigest',
    'checks',
    'harnessEngineDigest',
  ];
  if (
    !hasExactKeys(raw, attestationKeys) ||
    raw.schemaVersion !== 2 ||
    typeof raw.trustBaseCommit !== 'string' ||
    !COMMIT_OID.test(raw.trustBaseCommit) ||
    typeof raw.policyDigest !== 'string' ||
    !DIGEST.test(raw.policyDigest) ||
    typeof raw.patchDigest !== 'string' ||
    !DIGEST.test(raw.patchDigest) ||
    typeof raw.candidateStateDigest !== 'string' ||
    !DIGEST.test(raw.candidateStateDigest) ||
    typeof raw.environmentDigest !== 'string' ||
    !DIGEST.test(raw.environmentDigest) ||
    typeof raw.harnessEngineDigest !== 'string' ||
    !DIGEST.test(raw.harnessEngineDigest) ||
    !Array.isArray(raw.checks) ||
    raw.checks.length === 0
  ) {
    throw new Error('invalid checks attestation');
  }
  const checks = raw.checks.map((entry): MaintainerPreapprovalCheck => {
    if (
      !isRecord(entry) ||
      !hasExactKeys(entry, [
        'evidence',
        'commandDigest',
        'startedAt',
        'completedAt',
      ]) ||
      !isRecord(entry.evidence) ||
      typeof entry.commandDigest !== 'string' ||
      !DIGEST.test(entry.commandDigest) ||
      typeof entry.startedAt !== 'string' ||
      typeof entry.completedAt !== 'string' ||
      exactTimestamp(entry.startedAt) === undefined ||
      exactTimestamp(entry.completedAt) === undefined ||
      exactTimestamp(entry.startedAt)! > exactTimestamp(entry.completedAt)!
    ) {
      throw new Error('invalid preapproval check');
    }
    const evidence = entry.evidence;
    const evidenceKeys = [
      'checkId',
      'outcome',
      'exitCode',
      'runner',
      'runnerDigest',
      'destructiveDatabase',
      ...(evidence.databaseIdentity ? ['databaseIdentity'] : []),
      ...(evidence.externalSnapshotDigest ? ['externalSnapshotDigest'] : []),
    ];
    if (
      !hasExactKeys(evidence, evidenceKeys) ||
      typeof evidence.checkId !== 'string' ||
      evidence.outcome !== 'passed' ||
      evidence.exitCode !== 0 ||
      typeof evidence.runner !== 'string' ||
      typeof evidence.runnerDigest !== 'string' ||
      !DIGEST.test(evidence.runnerDigest) ||
      (evidence.externalSnapshotDigest !== undefined &&
        (typeof evidence.externalSnapshotDigest !== 'string' ||
          !DIGEST.test(evidence.externalSnapshotDigest))) ||
      typeof evidence.destructiveDatabase !== 'boolean' ||
      (evidence.databaseIdentity !== undefined &&
        typeof evidence.databaseIdentity !== 'string')
    ) {
      throw new Error('invalid check evidence');
    }
    return {
      evidence: evidence as CheckEvidence,
      commandDigest: entry.commandDigest,
      startedAt: entry.startedAt,
      completedAt: entry.completedAt,
    };
  });
  const common = {
    trustBaseCommit: raw.trustBaseCommit,
    policyDigest: raw.policyDigest,
    patchDigest: raw.patchDigest,
    candidateStateDigest: raw.candidateStateDigest,
    environmentDigest: raw.environmentDigest,
    checks,
  };
  return {
    schemaVersion: 2,
    ...common,
    harnessEngineDigest: raw.harnessEngineDigest,
  };
}

export function evidenceOverlay(
  manifest: PatchManifest,
): MaintainerEvidenceOverlayEntry[] {
  return manifest.files
    .filter(({ role }) => role === 'evidence')
    .map(({ path: filePath }) => ({ path: filePath, role: 'evidence' }));
}

export function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function exactTimestamp(value: string): number | undefined {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value
    ? time
    : undefined;
}

export function validReason(value: string): boolean {
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

export function assertArmoredSignature(signature: string): void {
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

function isSortedUnique(values: string[]): boolean {
  const sorted = [...new Set(values)].sort();
  return (
    values.length === sorted.length &&
    values.every((value, index) => value === sorted[index])
  );
}

export function equalStringArrays(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

export function invalidGrant(message: string) {
  return workflowError('MAINTAINER_GRANT_INVALID', message, ExitCode.guard);
}

function invalidEvidenceWaiver(
  message = 'Named evidence waivers must be sorted, unique trust-base check IDs with explicit reasons.',
) {
  return workflowError(
    'MAINTAINER_EVIDENCE_WAIVER_INVALID',
    message,
    ExitCode.guard,
  );
}
