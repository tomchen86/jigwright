/** Exact V2 candidate admission rules and canonical operation contracts. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  ImmutableCandidateBundleV2,
  CandidateSupportingArtifactSet,
  CandidateDependencySnapshot,
  CandidateChecksAttestationV3,
} from './maintainer-candidate-contracts.ts';
import type {
  CapabilityProfile,
  PatchManifest,
} from './maintainer-manifest-contracts.ts';
import type { MaintainerPolicy } from './maintainer-policy.ts';
import type { MaintainerSignerProvider } from './maintainer-signer-port.ts';
import type { HumanResolutionSignerFactory } from './maintainer-grant-contracts.ts';
import type { TaskMandateBinding } from './task-mandate-contract.ts';
import type { TaskMandateOperations } from './task-mandate.ts';
import type { GitState } from '../repository-consumer/repository-git-state.ts';
import type { RefGenerationLedger } from './maintainer-candidate-ref-ledger.ts';
import {
  invalidGrant,
  type MaintainerEvidenceOverlayEntry,
  type MaintainerEvidenceWaiver,
  type MaintainerChecksAttestationV2,
  type MaintainerChecksAttestation,
  type MaintainerGrantV2Envelope,
} from './maintainer-grant-v2-codec.ts';
import type { CandidateDependencyObservations } from './maintainer-candidate-dependencies.ts';

export type MaintainerGrantV2PreflightRequest = {
  profileId: string;
};

export type MaintainerGrantV2PreflightResult = {
  classification: 'ordinary' | 'root-one-shot' | 'control-plane';
  grantable: boolean;
  trustBaseCommit: string;
  policyDigest: string;
  manifest: PatchManifest;
  manifestDigest: string;
  patchDigest: string;
  evidenceOverlay: MaintainerEvidenceOverlayEntry[];
  requiredChecks: string[];
  checkDependencies: CapabilityProfile['checkDependencies'];
};

export type MaintainerGrantV2IssueRequest = {
  changeId: string;
  reason: string;
  manifest: PatchManifest;
  ttlMinutes?: number;
  checksAttestation?: MaintainerChecksAttestationV2;
  candidateBundle?: ImmutableCandidateBundleV2;
  evidenceWaivers?: MaintainerEvidenceWaiver[];
};

export type MaintainerGrantV2IssueOptions = {
  now?: Date;
  grantId?: string;
  signer?: MaintainerSignerProvider;
  environment?: NodeJS.ProcessEnv;
  externalStateDigests?: Readonly<Record<string, string>>;
  /** Production approve-and-apply uses this to durably audit the signed grant
   * before any tag or available token makes it executable. */
  beforeGrantPublication?: (envelope: MaintainerGrantV2Envelope) => void;
};

export type MaintainerGrantV2ValidationOptions = {
  now: Date;
  expectedBase: string;
  expectedPolicyBlob: string;
  signer?: MaintainerSignerProvider;
  assertLifecycleOwned?: () => void;
};

export type MaintainerGrantV2IssueResult = {
  grantId: string;
  tagRef: string;
  publishCommand: string;
  availableTokenPath: string;
  envelope: MaintainerGrantV2Envelope;
};

export type MaintainerTaskMandateOperations = Pick<
  TaskMandateOperations,
  | 'inspectActiveTaskMandateBinding'
  | 'assertActiveTaskMandateBindingUnderLifecycleLock'
>;
export function assertApplyCandidateRequest(
  request: MaintainerGrantV2IssueRequest,
): asserts request is MaintainerGrantV2IssueRequest & {
  checksAttestation: MaintainerChecksAttestationV2;
  candidateBundle: ImmutableCandidateBundleV2;
} {
  if (
    request.candidateBundle === undefined ||
    request.candidateBundle === null ||
    request.checksAttestation === undefined ||
    request.checksAttestation === null
  ) {
    throw workflowError(
      'APPLY_CANDIDATE_REQUIRED',
      'Apply Grant v2 requires an immutable candidate and its exact checks attestation.',
      ExitCode.guard,
    );
  }
  if (request.checksAttestation.schemaVersion !== 2) {
    throw workflowError(
      'APPLY_ATTESTATION_INVALID',
      'Apply Grant checks must use the current attestation schema.',
      ExitCode.guard,
    );
  }
}

export function cloneCheckDependencies(
  profile: CapabilityProfile,
): CapabilityProfile['checkDependencies'] {
  return Object.fromEntries(
    profile.requiredChecks.map((checkId) => [
      checkId,
      [...profile.checkDependencies[checkId]!],
    ]),
  );
}

export function assertCandidateDependencies(
  candidate: ImmutableCandidateBundleV2 | null,
  profile: CapabilityProfile,
): void {
  if (candidate === null) return;
  const observed = Object.fromEntries(
    candidate.checksAttestation.checks.map(({ checkId, dependsOn }) => [
      checkId,
      dependsOn,
    ]),
  );
  if (
    canonicalJson(observed) !==
      canonicalJson(cloneCheckDependencies(profile)) ||
    candidate.checksAttestation.checks.some((check) =>
      check.dependsOn.includes('external-state')
        ? check.reuseClass !== 'external-state' ||
          check.maxAgeMs !==
            profile.externalStateFreshness?.[check.checkId]?.maxAgeMs
        : check.externalSnapshotDigest !== null,
    )
  ) {
    throw invalidGrant(
      'Candidate check dependencies differ from the trust-base profile.',
    );
  }
}

export function exactDate(value: Date): Date {
  const copy = new Date(value);
  if (!Number.isFinite(copy.getTime())) {
    throw invalidGrant('Maintainer grant issue time is invalid.');
  }
  return copy;
}

export function candidateAuthorityClassification(
  profile: CapabilityProfile,
  manifest: PatchManifest,
  protectedPaths: readonly string[],
): 'ordinary' | 'root-one-shot' | 'control-plane' {
  return manifest.files.some(
    ({ role }) => role === 'policy' || role === 'verification-infrastructure',
  ) || protectedPaths.length > 0
    ? 'control-plane'
    : profile.authorityClass;
}

export type MaintainerGrantTrustContext = {
  repository: GitState;
  policy: MaintainerPolicy;
  policyBlob: string;
  policyDigest: string;
};

export type SignedMaintainerGrantPublication = {
  repository: GitState;
  baseCommit: string;
  grantId: string;
  tagRef: string;
  envelope: MaintainerGrantV2Envelope;
  canonicalEnvelope: string;
  signerIdentity: string;
  now: Date;
  recheckMandate: (assertOwned: () => void) => void;
};

export type MaintainerGrantV2Services = {
  loadV2TrustContext: (
    cwd: string,
    expectedBase?: string,
  ) => MaintainerGrantTrustContext;
  assertUnusedGrant: (
    repository: GitState,
    grantId: string,
    tagRef: string,
  ) => string;
  discoverRepository: (cwd: string) => GitState;
  currentChecksEnvironmentDigest: (
    repositoryRoot: string,
    attestation: MaintainerChecksAttestation,
    environment: NodeJS.ProcessEnv,
  ) => string;
  currentCandidateDependencySnapshot: CandidateDependencyObservations['currentCandidateDependencySnapshot'];
  readStoredImmutableCandidateBundle: CandidateArtifactObservations['readStoredImmutableCandidateBundle'];
  assertStoredCandidateSupportingArtifacts: CandidateArtifactObservations['assertStoredCandidateSupportingArtifacts'];
  readRequiredRefGenerationLedger: (
    gitCommonDirectory: string,
    ref: string,
  ) => RefGenerationLedger;
  readTargetRef: (repositoryRoot: string, targetRef: string) => string;
  readPolicyContent: (repositoryRoot: string, baseCommit: string) => string;
  protectedCapabilityPaths: (
    repositoryRoot: string,
    baseCommit: string,
    paths: string[],
  ) => readonly string[];
  createInteractiveSshSigner: HumanResolutionSignerFactory;
  isPostApprovalAdmissionFailure: (error: unknown) => boolean;
  publishSignedMaintainerGrant: (
    publication: SignedMaintainerGrantPublication,
  ) => void;
  authorityTagPublishCommand: (
    repositoryOrigin: string,
    tagRef: string,
  ) => string;
  currentTime: () => Date;
  randomGrantId: () => string;
  currentEnvironment: () => NodeJS.ProcessEnv;
};

import type { CandidateArtifactObservations } from './maintainer-candidate-contracts.ts';
