import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
/** Coordinates exact V2 preflight, human issuance and authority admission. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { assertChangeId } from '../../foundation/repository-path/repository-path.ts';
import { assertMaintainerGrantId } from '../../modules/authority/maintainer-grant-contracts.ts';
import { acceptApplyPrestate } from '../../modules/authority/maintainer-candidate-ref-ledger.ts';
import {
  assertCandidateV2ChecksFresh,
  canonicalImmutableCandidateBundle,
  parseImmutableCandidateBundle,
} from '../../modules/authority/maintainer-candidate-contracts.ts';
import {
  canonicalPatchManifest,
  parsePatchManifest,
  type CapabilityProfile,
  type PatchManifest,
} from '../../modules/authority/maintainer-manifest-contracts.ts';
import type { MaintainerManifestOperations } from '../../modules/authority/maintainer-manifest.ts';
import type { MaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate-contract.ts';
import {
  MAX_V2_TTL_MINUTES,
  assertArmoredSignature,
  candidateChecksAreExact,
  canonicalMaintainerChecksAttestation,
  canonicalMaintainerGrantV2Envelope,
  canonicalMaintainerGrantV2Payload,
  digest,
  equalStringArrays,
  evidenceOverlay,
  exactTimestamp,
  invalidGrant,
  maintainerGrantV2SignatureNamespace,
  validReason,
  validateMaintainerEvidenceWaivers,
  validateMaintainerGrantV2Payload,
  MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
  type MaintainerGrantV2Payload,
  type MaintainerGrantV2Envelope,
} from '../../modules/authority/maintainer-grant-v2-codec.ts';
import {
  assertApplyCandidateRequest,
  assertCandidateDependencies,
  cloneCheckDependencies,
  exactDate,
  candidateAuthorityClassification,
  type MaintainerGrantV2PreflightRequest,
  type MaintainerGrantV2PreflightResult,
  type MaintainerGrantV2IssueRequest,
  type MaintainerGrantV2IssueOptions,
  type MaintainerGrantV2ValidationOptions,
  type MaintainerGrantV2IssueResult,
  type MaintainerTaskMandateOperations,
  type MaintainerGrantV2Services,
} from '../../modules/authority/maintainer-grant-v2.ts';

export function createMaintainerGrantV2Operations({
  loadV2TrustContext,
  assertUnusedGrant,
  discoverRepository,
  currentChecksEnvironmentDigest,
  currentCandidateDependencySnapshot,
  readStoredImmutableCandidateBundle,
  assertStoredCandidateSupportingArtifacts,
  readRequiredRefGenerationLedger,
  readTargetRef,
  readPolicyContent,
  protectedCapabilityPaths,
  createInteractiveSshSigner,
  isPostApprovalAdmissionFailure,
  publishSignedMaintainerGrant,
  authorityTagPublishCommand,
  currentTime,
  randomGrantId,
  currentEnvironment,
}: MaintainerGrantV2Services) {
  function preflightMaintainerGrantV2(
    manifestOperations: MaintainerManifestOperations,
    cwd: string,
    request: MaintainerGrantV2PreflightRequest,
  ): MaintainerGrantV2PreflightResult {
    const context = loadV2TrustContext(cwd);
    const profile = manifestOperations.loadCapabilityProfileFromTrustBase(
      context.repository.repositoryRoot,
      context.repository.head,
      request.profileId,
    );
    const manifest = manifestOperations.buildMaintainerPatchManifest(
      context.repository.repositoryRoot,
      {
        profile,
        trustBaseCommit: context.repository.head,
        policyDigest: context.policyDigest,
      },
    );
    const classification = classifyCandidate(
      context.repository.repositoryRoot,
      profile,
      manifest,
    );
    return {
      classification,
      grantable: classification !== 'control-plane',
      trustBaseCommit: context.repository.head,
      policyDigest: context.policyDigest,
      manifest,
      manifestDigest: digest(canonicalPatchManifest(manifest)),
      patchDigest: manifest.patchDigest,
      evidenceOverlay: evidenceOverlay(manifest),
      requiredChecks: [...profile.requiredChecks],
      checkDependencies: cloneCheckDependencies(profile),
    };
  }

  function issueMaintainerGrantV2(
    manifestOperations: MaintainerManifestOperations,
    taskMandate: MaintainerTaskMandateOperations,
    cwd: string,
    request: MaintainerGrantV2IssueRequest,
    options: MaintainerGrantV2IssueOptions = {},
  ): MaintainerGrantV2IssueResult {
    assertApplyCandidateRequest(request);
    const changeId = assertChangeId(request.changeId);
    if (!validReason(request.reason)) {
      throw invalidGrant('Maintainer grant reason is invalid.');
    }
    const manifest = parsePatchManifest(
      canonicalPatchManifest(request.manifest),
    );
    const context = loadV2TrustContext(cwd, manifest.trustBaseCommit);
    const profile = manifestOperations.loadCapabilityProfileFromTrustBase(
      context.repository.repositoryRoot,
      manifest.trustBaseCommit,
      manifest.profile,
    );
    if (
      profile.version !== manifest.profileVersion ||
      manifest.policyDigest !== context.policyDigest
    ) {
      throw invalidGrant(
        'Maintainer grant manifest does not match its trust-base profile or policy.',
      );
    }
    const evidenceWaivers = validateMaintainerEvidenceWaivers(
      request.evidenceWaivers ?? [],
      profile.requiredChecks,
      profile.checkDependencies,
    );
    const observed = manifestOperations.buildMaintainerPatchManifest(
      context.repository.repositoryRoot,
      {
        profile,
        trustBaseCommit: manifest.trustBaseCommit,
        policyDigest: context.policyDigest,
      },
    );
    if (canonicalPatchManifest(observed) !== canonicalPatchManifest(manifest)) {
      throw workflowError(
        'MAINTAINER_PATCH_DRIFT',
        'The candidate no longer matches the preflighted exact patch.',
        ExitCode.staleState,
      );
    }
    const classification = classifyCandidate(
      context.repository.repositoryRoot,
      profile,
      manifest,
    );
    if (classification === 'control-plane') {
      throw workflowError(
        'MAINTAINER_CONTROL_PLANE_GRANT_REQUIRED',
        'Policy and verification-infrastructure changes require control-plane authority.',
        ExitCode.guard,
      );
    }

    const ttlMinutes = request.ttlMinutes ?? MAX_V2_TTL_MINUTES;
    if (
      !Number.isInteger(ttlMinutes) ||
      ttlMinutes < 1 ||
      ttlMinutes > MAX_V2_TTL_MINUTES
    ) {
      throw invalidGrant(
        'Maintainer grant v2 TTL exceeds the seven-day bound.',
      );
    }
    const now = exactDate(options.now ?? currentTime());
    const grantId = assertMaintainerGrantId(options.grantId ?? randomGrantId());
    const tagRef = `${context.policy.auditTagPrefix}${grantId}`;
    const availableTokenPath = assertUnusedGrant(
      context.repository,
      grantId,
      tagRef,
    );

    const candidateBundle = parseImmutableCandidateBundle(
      canonicalImmutableCandidateBundle(request.candidateBundle),
    );
    if (candidateBundle.classification !== classification) {
      throw invalidGrant(
        'Apply Grant v2 requires the exact matching immutable candidate classification.',
      );
    }
    assertCandidateDependencies(candidateBundle, profile);
    if (!candidateChecksAreExact(candidateBundle, request.checksAttestation)) {
      throw invalidGrant(
        'The grant checks attestation differs from the immutable candidate checks.',
      );
    }
    assertCandidateV2ChecksFresh(candidateBundle.checksAttestation, {
      now,
      candidateTree: candidateBundle.resultTree,
      patchDigest: manifest.patchDigest,
      trustBaseCommit: manifest.trustBaseCommit,
      requiredChecks: profile.requiredChecks,
      waivedFreshnessCheckIds: evidenceWaivers.map(({ checkId }) => checkId),
      environmentDigest: currentChecksEnvironmentDigest(
        discoverRepository(cwd).repositoryRoot,
        request.checksAttestation,
        options.environment ?? currentEnvironment(),
      ),
      currentDependencySnapshot: currentCandidateDependencySnapshot({
        cwd,
        repositoryId: context.policy.repository.id,
        candidateTree: candidateBundle.resultTree,
        baseCommit: manifest.trustBaseCommit,
        policyDigest: context.policyDigest,
        checks: candidateBundle.checksAttestation.checks,
        environment: options.environment,
        externalStateDigests: options.externalStateDigests,
      }),
    });
    const storedCandidate = readStoredImmutableCandidateBundle(
      context.repository.gitCommonDirectory,
      candidateBundle.candidateBundleDigest,
    );
    if (
      canonicalImmutableCandidateBundle(storedCandidate) !==
      canonicalImmutableCandidateBundle(candidateBundle)
    ) {
      throw workflowError(
        'APPLY_CANDIDATE_STORE_INVALID',
        'The grant candidate differs from its frozen durable artifact.',
        ExitCode.guard,
      );
    }
    assertStoredCandidateSupportingArtifacts(
      context.repository.gitCommonDirectory,
      changeId,
      candidateBundle,
    );
    const mandateBinding = assertActiveApplyMandateBinding(
      taskMandate,
      cwd,
      changeId,
      candidateBundle.mandateBinding,
      {
        now,
        signer: options.signer,
      },
    );
    acceptApplyPrestate(
      readRequiredRefGenerationLedger(
        context.repository.gitCommonDirectory,
        candidateBundle.targetRef,
      ),
      candidateBundle.expectedOldCommit,
      candidateBundle.expectedRefGeneration,
    );
    const observedRef = readTargetRef(
      context.repository.repositoryRoot,
      candidateBundle.targetRef,
    );
    if (observedRef !== candidateBundle.expectedOldCommit) {
      throw workflowError(
        'APPLY_REF_OID_MISMATCH',
        'The candidate target ref differs from its approved prestate.',
        ExitCode.staleState,
      );
    }
    const signer =
      options.signer ??
      createInteractiveSshSigner(
        context.repository.repositoryRoot,
        context.policy,
      );
    const signerIdentity = signer.identity();
    const payload: MaintainerGrantV2Payload = {
      version: 2,
      grantId,
      repositoryId: context.policy.repository.id,
      repositoryOrigin: context.policy.repository.origin,
      baseCommit: manifest.trustBaseCommit,
      policyBlob: context.policyBlob,
      policyDigest: context.policyDigest,
      changeId,
      taskId: mandateBinding.mandateTaskId,
      mandateBinding,
      profile: profile.id,
      profileVersion: profile.version,
      classification,
      manifest,
      manifestDigest: digest(canonicalPatchManifest(manifest)),
      patchDigest: manifest.patchDigest,
      allowedPaths: manifest.files.map(({ path: filePath }) => filePath),
      evidenceOverlay: evidenceOverlay(manifest),
      requiredChecks: [...profile.requiredChecks],
      evidenceWaivers,
      checkDependencies: cloneCheckDependencies(profile),
      checksAttestation: request.checksAttestation,
      checksAttestationDigest: digest(
        canonicalMaintainerChecksAttestation(request.checksAttestation),
      ),
      candidateBundle,
      candidateBundleDigest: candidateBundle.candidateBundleDigest,
      effectsManifestDigest: candidateBundle.effectsManifestDigest,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
      maxUses: 1,
      reason: request.reason,
      signer: signerIdentity,
    };
    validateMaintainerGrantV2Payload(payload);
    if (
      !context.policy.trustedSigners.some(
        ({ identity }) => identity === signerIdentity,
      )
    ) {
      throw invalidGrant('Maintainer grant signer is not trusted by the base.');
    }
    // Every deterministic admission check precedes the human-presence check and
    // signature, so an ungrantable or stale candidate never burns attention.
    signer.assertHumanPresent();
    const canonicalPayload = canonicalMaintainerGrantV2Payload(payload);
    const signature = signer.sign(
      canonicalPayload,
      MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
    );
    assertArmoredSignature(signature);
    signer.verify(
      canonicalPayload,
      signature,
      signerIdentity,
      MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
    );
    const envelope: MaintainerGrantV2Envelope = {
      payload,
      signatureNamespace: MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
      signature,
    };
    const canonicalEnvelope = canonicalMaintainerGrantV2Envelope(envelope);
    options.beforeGrantPublication?.(envelope);
    if (canonicalMaintainerGrantV2Envelope(envelope) !== canonicalEnvelope) {
      throw workflowError(
        'MAINTAINER_GRANT_PUBLICATION_MUTATED',
        'The signed grant changed before durable publication.',
        ExitCode.guard,
      );
    }

    publishSignedMaintainerGrant({
      repository: context.repository,
      baseCommit: manifest.trustBaseCommit,
      grantId,
      tagRef,
      envelope,
      canonicalEnvelope,
      signerIdentity,
      now,
      recheckMandate: (assertOwned) => {
        assertActiveApplyMandateBinding(
          taskMandate,
          cwd,
          changeId,
          mandateBinding,
          {
            now,
            signer,
            assertLifecycleOwned: assertOwned,
          },
        );
      },
    });

    return {
      grantId,
      tagRef,
      publishCommand: authorityTagPublishCommand(
        context.policy.repository.origin,
        tagRef,
      ),
      availableTokenPath,
      envelope,
    };
  }

  function validateMaintainerGrantV2AuthorityBinding(
    manifestOperations: MaintainerManifestOperations,
    taskMandate: MaintainerTaskMandateOperations,
    repositoryRoot: string,
    envelope: MaintainerGrantV2Envelope,
    policy: MaintainerPolicy,
    options: MaintainerGrantV2ValidationOptions,
  ) {
    validateMaintainerGrantV2Payload(envelope.payload);
    const candidate = envelope.payload.candidateBundle;
    if (candidate === null) {
      throw invalidGrant(
        'Maintainer grant v2 requires an immutable candidate at authority admission.',
      );
    }
    assertStoredCandidateSupportingArtifacts(
      discoverRepository(repositoryRoot).gitCommonDirectory,
      envelope.payload.changeId,
      candidate,
    );
    const signer =
      options.signer ?? createInteractiveSshSigner(repositoryRoot, policy);
    try {
      signer.verify(
        canonicalMaintainerGrantV2Payload(envelope.payload),
        envelope.signature,
        envelope.payload.signer,
        maintainerGrantV2SignatureNamespace(envelope),
      );
    } catch (error) {
      if (isPostApprovalAdmissionFailure(error)) throw error;
      throw workflowError(
        'AUTHORITY_SIGNATURE_INVALID',
        'The maintainer grant v2 signature is invalid.',
        ExitCode.verification,
      );
    }
    const now = exactDate(options.now).getTime();
    const expiresAt = exactTimestamp(envelope.payload.expiresAt);
    const policyContent = readPolicyContent(
      repositoryRoot,
      options.expectedBase,
    );
    if (
      envelope.payload.baseCommit !== options.expectedBase ||
      envelope.payload.policyBlob !== options.expectedPolicyBlob ||
      envelope.payload.policyDigest !== digest(policyContent) ||
      expiresAt === undefined ||
      expiresAt < now ||
      !policy.trustedSigners.some(
        ({ identity }) => identity === envelope.payload.signer,
      )
    ) {
      throw invalidGrant(
        'Maintainer grant v2 does not match its live trust-base admission.',
      );
    }
    assertActiveApplyMandateBinding(
      taskMandate,
      repositoryRoot,
      envelope.payload.changeId,
      envelope.payload.mandateBinding,
      {
        now: options.now,
        signer,
        assertLifecycleOwned: options.assertLifecycleOwned,
      },
    );
    const profile = manifestOperations.loadCapabilityProfileFromTrustBase(
      repositoryRoot,
      options.expectedBase,
      envelope.payload.profile,
    );
    const expectedClassification = classifyCandidate(
      repositoryRoot,
      profile,
      envelope.payload.manifest,
    );
    manifestOperations.validatePatchManifestAgainstProfile(
      repositoryRoot,
      envelope.payload.manifest,
      profile,
    );
    if (
      !equalStringArrays(
        envelope.payload.requiredChecks,
        profile.requiredChecks,
      ) ||
      canonicalJson(envelope.payload.checkDependencies) !==
        canonicalJson(cloneCheckDependencies(profile)) ||
      envelope.payload.classification !== expectedClassification
    ) {
      throw invalidGrant(
        'Maintainer grant v2 required checks differ from its trust-base profile.',
      );
    }
    assertCandidateDependencies(envelope.payload.candidateBundle, profile);
    return profile;
  }

  function assertActiveApplyMandateBinding(
    taskMandate: MaintainerTaskMandateOperations,
    cwd: string,
    changeId: string,
    expected: TaskMandateBinding,
    options: {
      now: Date;
      signer?: MaintainerSignerProvider;
      assertLifecycleOwned?: () => void;
    },
  ): TaskMandateBinding {
    const active = options.assertLifecycleOwned
      ? taskMandate.assertActiveTaskMandateBindingUnderLifecycleLock(
          cwd,
          expected,
          options.assertLifecycleOwned,
          options,
        )
      : taskMandate.inspectActiveTaskMandateBinding(
          cwd,
          expected.mandateTaskId,
          options,
        );
    if (
      active.changeId !== changeId ||
      canonicalJson(active) !== canonicalJson(expected)
    ) {
      throw workflowError(
        'APPLY_TASK_MANDATE_BINDING_MISMATCH',
        'Apply Grant v2 does not match the exact active Task Mandate binding.',
        ExitCode.staleState,
      );
    }
    return active;
  }

  function classifyCandidate(
    repositoryRoot: string,
    profile: CapabilityProfile,
    manifest: PatchManifest,
  ): 'ordinary' | 'root-one-shot' | 'control-plane' {
    const protectedPaths = protectedCapabilityPaths(
      repositoryRoot,
      manifest.trustBaseCommit,
      manifest.files.map(({ path: filePath }) => filePath),
    );
    return candidateAuthorityClassification(profile, manifest, protectedPaths);
  }
  return {
    preflightMaintainerGrantV2,
    issueMaintainerGrantV2,
    validateMaintainerGrantV2AuthorityBinding,
  };
}
export type MaintainerGrantV2Operations = ReturnType<
  typeof createMaintainerGrantV2Operations
>;

import type { CandidateDependencyObservations } from '../../modules/authority/maintainer-candidate-dependencies.ts';
export type MaintainerGrantExecutionServices = MaintainerGrantV2Operations &
  CandidateDependencyObservations &
  CandidateArtifactObservations &
  CandidateArtifactPublication &
  RefGenerationRecords &
  Pick<ChangeContractServices, 'loadStableValidatedChangeContract'>;

import type {
  CandidateArtifactObservations,
  CandidateArtifactPublication,
} from '../../modules/authority/maintainer-candidate-contracts.ts';
import type { RefGenerationRecords } from '../../modules/authority/maintainer-candidate-ref-ledger.ts';
