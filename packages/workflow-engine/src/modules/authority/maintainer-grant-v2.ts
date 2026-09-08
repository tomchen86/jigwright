import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { authorityTagPublishCommand } from '../../adapters/remote/github/authority-relay-command.ts';
import type { CheckEvidence } from '../../adapters/consumer/repository/work-registry/check-runner.ts';
import { assertDisposableDatabaseForRepository } from '../../adapters/consumer/repository/work-registry/database-policy.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  enterActivePostApprovalTerminalCleanup,
  isPostApprovalAdmissionFailure,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  assertMaintainerGrantId,
  createMaintainerAuditTag,
} from './maintainer-grant.ts';
import {
  acceptApplyPrestate,
  assertCandidateV2ChecksFresh,
  assertStoredCandidateSupportingArtifacts,
  canonicalImmutableCandidateBundle,
  parseImmutableCandidateBundle,
  readDurableRefGenerationLedger,
  readStoredImmutableCandidateBundle,
  type ImmutableCandidateBundleV2,
} from './maintainer-candidate.ts';
import { currentCandidateDependencySnapshot } from '../../application/control-plane/maintainer-candidate-dependencies.ts';
import {
  buildMaintainerPatchManifest,
  canonicalPatchManifest,
  loadCapabilityProfileFromTrustBase,
  parsePatchManifest,
  validatePatchManifestAgainstProfile,
  type CapabilityProfile,
  type PatchManifest,
} from './maintainer-manifest.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import {
  maintainerGrantStorePaths,
  storeCanonicalAvailableMaintainerGrantUnderLifecycleLock,
  terminallyFailSignedMaintainerGrantV2UnderLifecycleLock,
} from '../../runtime/storage-journal/maintainer-store.ts';
import { assertChangeId } from '../../runtime/session-workspace/paths.ts';
import { classifyProtectedCapabilityPaths } from '../../adapters/consumer/repository/work-registry/protected-capabilities.ts';
import { withRepositoryLifecycleOperation } from '../../runtime/session-workspace/session-store.ts';
import {
  assertActiveTaskMandateBindingUnderLifecycleLock,
  inspectActiveTaskMandateBinding,
  type TaskMandateBinding,
} from './task-mandate.ts';
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
  maintainerChecksEnvironmentDigest,
  maintainerGrantV2SignatureNamespace,
  validReason,
  validateMaintainerEvidenceWaivers,
  validateMaintainerGrantV2Payload,
} from './maintainer-grant-v2-codec.ts';
import { MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE } from './maintainer-grant-v2-codec.ts';
export { MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE } from './maintainer-grant-v2-codec.ts';
import type {
  MaintainerEvidenceOverlayEntry,
  MaintainerEvidenceWaiver,
  MaintainerPreapprovalCheck,
  MaintainerChecksAttestationV2,
  MaintainerChecksAttestation,
  MaintainerGrantV2Payload,
  MaintainerGrantV2Envelope,
} from './maintainer-grant-v2-codec.ts';
export type {
  MaintainerEvidenceOverlayEntry,
  MaintainerEvidenceWaiver,
  MaintainerPreapprovalCheck,
  MaintainerChecksAttestationV2,
  MaintainerChecksAttestation,
  MaintainerGrantV2Payload,
  MaintainerGrantV2Envelope,
} from './maintainer-grant-v2-codec.ts';

export {
  parseMaintainerEvidenceWaivers,
  validateMaintainerEvidenceWaivers,
  canonicalMaintainerGrantV2Payload,
  canonicalMaintainerGrantV2Envelope,
  canonicalMaintainerChecksAttestation,
  maintainerChecksEnvironmentDigest,
  parseMaintainerGrantV2Envelope,
  maintainerGrantV2SignatureNamespace,
} from './maintainer-grant-v2-codec.ts';
export type { CheckEvidence };

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

export function preflightMaintainerGrantV2(
  cwd: string,
  request: MaintainerGrantV2PreflightRequest,
): MaintainerGrantV2PreflightResult {
  const context = loadV2TrustContext(cwd);
  const profile = loadCapabilityProfileFromTrustBase(
    context.repository.repositoryRoot,
    context.repository.head,
    request.profileId,
  );
  const manifest = buildMaintainerPatchManifest(
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

export function issueMaintainerGrantV2(
  cwd: string,
  request: MaintainerGrantV2IssueRequest,
  options: MaintainerGrantV2IssueOptions = {},
): MaintainerGrantV2IssueResult {
  assertApplyCandidateRequest(request);
  const changeId = assertChangeId(request.changeId);
  if (!validReason(request.reason)) {
    throw invalidGrant('Maintainer grant reason is invalid.');
  }
  const manifest = parsePatchManifest(canonicalPatchManifest(request.manifest));
  const context = loadV2TrustContext(cwd, manifest.trustBaseCommit);
  const profile = loadCapabilityProfileFromTrustBase(
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
  const observed = buildMaintainerPatchManifest(
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
    throw invalidGrant('Maintainer grant v2 TTL exceeds the seven-day bound.');
  }
  const now = exactDate(options.now ?? new Date());
  const grantId = assertMaintainerGrantId(
    options.grantId ?? crypto.randomUUID(),
  );
  const tagRef = `${context.policy.auditTagPrefix}${grantId}`;
  const paths = maintainerGrantStorePaths(
    context.repository.gitCommonDirectory,
  );
  const availableTokenPath = path.join(paths.available, `${grantId}.json`);
  if (
    fs.existsSync(availableTokenPath) ||
    fs.existsSync(path.join(paths.reserved, `${grantId}.json`)) ||
    fs.existsSync(path.join(paths.terminal, `${grantId}.json`)) ||
    runGit(
      context.repository.repositoryRoot,
      ['rev-parse', '--verify', tagRef],
      true,
    ).trim()
  ) {
    throw workflowError(
      'MAINTAINER_GRANT_EXISTS',
      `Maintainer grant ${grantId} already has local state or an audit tag.`,
      ExitCode.conflict,
    );
  }

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
      options.environment ?? process.env,
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
    cwd,
    changeId,
    candidateBundle.mandateBinding,
    {
      now,
      signer: options.signer,
    },
  );
  acceptApplyPrestate(
    readDurableRefGenerationLedger(
      context.repository.gitCommonDirectory,
      candidateBundle.targetRef,
      true,
    ),
    candidateBundle.expectedOldCommit,
    candidateBundle.expectedRefGeneration,
  );
  const observedRef = runGit(
    context.repository.repositoryRoot,
    ['rev-parse', '--verify', candidateBundle.targetRef],
    true,
  ).trim();
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

  withRepositoryLifecycleOperation(paths.runtime, (assertOwned) => {
    assertOwned();
    let tagObject: string | null = null;
    try {
      assertActiveApplyMandateBinding(cwd, changeId, mandateBinding, {
        now,
        signer,
        assertLifecycleOwned: assertOwned,
      });
      tagObject = createMaintainerAuditTag(
        context.repository.repositoryRoot,
        manifest.trustBaseCommit,
        tagRef,
        canonicalEnvelope,
        signerIdentity,
      );
      storeCanonicalAvailableMaintainerGrantUnderLifecycleLock(
        context.repository.gitCommonDirectory,
        grantId,
        canonicalEnvelope,
        assertOwned,
      );
    } catch (error) {
      if (isPostApprovalAdmissionFailure(error)) {
        enterActivePostApprovalTerminalCleanup();
        terminallyFailSignedMaintainerGrantV2UnderLifecycleLock(
          context.repository.gitCommonDirectory,
          envelope,
          error instanceof Error
            ? error.message
            : 'Post-approval grant publication failed.',
          now,
          assertOwned,
        );
        try {
          const cleanupTagObject =
            tagObject ??
            exactPublishedAuditTagObject(
              context.repository.repositoryRoot,
              tagRef,
              manifest.trustBaseCommit,
              canonicalEnvelope,
              signerIdentity,
            );
          if (cleanupTagObject !== null) {
            runGit(context.repository.repositoryRoot, [
              'update-ref',
              '-d',
              tagRef,
              cleanupTagObject,
            ]);
          }
        } catch {
          // Durable failed authority is denial-first. An unknown or
          // concurrently substituted tag is preserved, and cleanup cannot
          // replace the original admission failure.
        }
      } else if (tagObject) {
        runGit(context.repository.repositoryRoot, [
          'update-ref',
          '-d',
          tagRef,
          tagObject,
        ]);
      }
      throw error;
    }
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

function exactPublishedAuditTagObject(
  repositoryRoot: string,
  tagRef: string,
  baseCommit: string,
  canonicalEnvelope: string,
  signerIdentity: string,
): string | null {
  const tagObject = runGit(
    repositoryRoot,
    ['rev-parse', `${tagRef}^{tag}`],
    true,
  ).trim();
  if (!tagObject) return null;
  const raw = runGit(repositoryRoot, ['cat-file', 'tag', tagObject], true);
  const separator = raw.indexOf('\n\n');
  if (separator === -1) return null;
  const headers = raw.slice(0, separator).split('\n');
  const object = headers.find((line) => line.startsWith('object '))?.slice(7);
  const type = headers.find((line) => line.startsWith('type '))?.slice(5);
  const tag = headers.find((line) => line.startsWith('tag '))?.slice(4);
  const tagger = headers.find((line) => line.startsWith('tagger '));
  const expectedTaggerPrefix = `tagger ${signerIdentity} <workflow-maintainer@users.noreply.github.com> `;
  if (
    headers.length !== 4 ||
    object !== baseCommit ||
    type !== 'commit' ||
    tag !== tagRef.slice('refs/tags/'.length) ||
    !tagger?.startsWith(expectedTaggerPrefix) ||
    raw.slice(separator + 2) !== canonicalEnvelope
  ) {
    return null;
  }
  return tagObject;
}

function assertActiveApplyMandateBinding(
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
    ? assertActiveTaskMandateBindingUnderLifecycleLock(
        cwd,
        expected,
        options.assertLifecycleOwned,
        options,
      )
    : inspectActiveTaskMandateBinding(cwd, expected.mandateTaskId, options);
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

function currentChecksEnvironmentDigest(
  repositoryRoot: string,
  attestation: MaintainerChecksAttestation,
  environment: NodeJS.ProcessEnv,
): string {
  const destructive = attestation.checks.some(
    ({ evidence }) => evidence.destructiveDatabase,
  );
  return maintainerChecksEnvironmentDigest(
    destructive
      ? assertDisposableDatabaseForRepository(repositoryRoot, environment)
          .identity
      : null,
  );
}

export function validateMaintainerGrantV2AuthorityBinding(
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
  const policyContent = runGit(repositoryRoot, [
    'show',
    `${options.expectedBase}:workflow/maintainer-policy.json`,
  ]);
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
    repositoryRoot,
    envelope.payload.changeId,
    envelope.payload.mandateBinding,
    {
      now: options.now,
      signer,
      assertLifecycleOwned: options.assertLifecycleOwned,
    },
  );
  const profile = loadCapabilityProfileFromTrustBase(
    repositoryRoot,
    options.expectedBase,
    envelope.payload.profile,
  );
  const expectedClassification = classifyCandidate(
    repositoryRoot,
    profile,
    envelope.payload.manifest,
  );
  validatePatchManifestAgainstProfile(
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

function assertApplyCandidateRequest(
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

function loadV2TrustContext(cwd: string, expectedBase?: string) {
  const repository = discoverRepository(cwd);
  if (expectedBase && repository.head !== expectedBase) {
    throw workflowError(
      'MAINTAINER_PATCH_STALE_BASE',
      'The repository HEAD moved after maintainer grant preflight.',
      ExitCode.staleState,
    );
  }
  let policyContent: string;
  let policy: MaintainerPolicy;
  try {
    policyContent = runGit(repository.repositoryRoot, [
      'show',
      `${repository.head}:workflow/maintainer-policy.json`,
    ]);
    policy = parseMaintainerPolicy(JSON.parse(policyContent));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      throw error;
    }
    throw workflowError(
      'MAINTAINER_POLICY_INVALID',
      'The trust base does not contain a valid maintainer policy.',
      ExitCode.guard,
    );
  }
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (origin !== policy.repository.origin) {
    throw workflowError(
      'MAINTAINER_REPOSITORY_MISMATCH',
      'The repository origin does not match the trusted maintainer policy.',
      ExitCode.guard,
    );
  }
  const policyBlob = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${repository.head}:workflow/maintainer-policy.json`,
  ]).trim();
  return {
    repository,
    policy,
    policyBlob,
    policyDigest: digest(policyContent),
  };
}

function classifyCandidate(
  repositoryRoot: string,
  profile: CapabilityProfile,
  manifest: PatchManifest,
): 'ordinary' | 'root-one-shot' | 'control-plane' {
  const protectedPaths = classifyProtectedCapabilityPaths(
    repositoryRoot,
    manifest.trustBaseCommit,
    manifest.files.map(({ path: filePath }) => filePath),
  ).protectedPaths;
  return manifest.files.some(
    ({ role }) => role === 'policy' || role === 'verification-infrastructure',
  ) || protectedPaths.length > 0
    ? 'control-plane'
    : profile.authorityClass;
}

function cloneCheckDependencies(
  profile: CapabilityProfile,
): CapabilityProfile['checkDependencies'] {
  return Object.fromEntries(
    profile.requiredChecks.map((checkId) => [
      checkId,
      [...profile.checkDependencies[checkId]!],
    ]),
  );
}

function assertCandidateDependencies(
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

function exactDate(value: Date): Date {
  const copy = new Date(value);
  if (!Number.isFinite(copy.getTime())) {
    throw invalidGrant('Maintainer grant issue time is invalid.');
  }
  return copy;
}
