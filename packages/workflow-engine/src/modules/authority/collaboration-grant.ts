/**
 * Prepares and issues signed collaboration Grants and direct human review
 * attestations.
 *
 * Invariants:
 * - The requested baseline must be an ancestor of the current HEAD:
 *   issuance rejects when the merge-base of baseline and HEAD is not the
 *   baseline commit.
 * - Issuance refuses when the grantId already has any local available,
 *   reserved, or terminal state.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from './maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
} from '../../adapters/signing/ssh/maintainer-signer.ts';
import {
  collaborationGrantStorePaths,
  storeAvailableCollaborationGrant,
} from '../../runtime/storage-journal/collaboration-grant-store.ts';
import {
  canonicalCollaborationGrantPayload,
  canonicalCollaborationGrantEnvelope,
  collaborationGrantEnvelopeDigest,
  canonicalDirectHumanReviewPayload,
  assertCollaborationGrantId,
  parseCollaborationGrantEnvelope,
  validateCollaborationGrantPayload,
  bindingFromPayload,
  collaborationPolicyDigestForPhase,
  validateCollaborationGrantEnvelope,
  collaborationInvalid,
  collaborationBindingMismatch,
  exactDate,
  assertArmoredSignature,
  FULL_OID,
  DIGEST,
  deepFreeze,
  collaborationSignatureInvalid,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  COLLABORATION_GRANT_MAX_TTL_MINUTES,
  type CollaborationGrantPayload,
  type CollaborationGrantRequest,
  type CollaborationGrantIssueResult,
  type PreparedCollaborationGrantIssue,
  type DirectHumanReviewAttestationPayload,
  type DirectHumanReviewAttestation,
  type DirectHumanReviewAttestationRequest,
} from './collaboration-grant-codec.ts';

export {
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  COLLABORATION_GRANT_REPLAY_SCOPE,
  COLLABORATION_GRANT_RESIDUALS,
  COLLABORATION_GRANT_MAX_TTL_MINUTES,
  COLLABORATION_GRANT_POLICY,
  COLLABORATION_GRANT_POLICY_DIGEST,
  TASK_DIFF_REVIEW_COLLABORATION_POLICY,
  TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST,
  COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
  type CreateCollaborationGrantCodecBindings,
  type CollaborationLifecyclePhase,
  type CollaborationAuthorRole,
  type CollaborationConflictingRole,
  type CollaborationRolePair,
  type CollaborationAvailableActor,
  type CollaborationDegradedForm,
  type CollaborationGrantPayload,
  type CollaborationGrantEnvelope,
  type CollaborationGrantRequest,
  type CollaborationGrantExpectedBinding,
  type CollaborationGrantIssueResult,
  type PreparedCollaborationGrantIssue,
  type CollaborationGrantValidationOptions,
  type VerifiedCollaborationGrantCapability,
  type DirectHumanReviewAttestationPayload,
  type DirectHumanReviewAttestation,
  type DirectHumanReviewAttestationRequest,
  type DirectHumanReviewValidationOptions,
  type CollaborationGrantUseIdentity,
} from './collaboration-grant-codec.ts';

export {
  ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1,
  ROLE_CONTEXT_SHARING_POLICY,
  ROLE_CONTEXT_SHARING_POLICY_DIGEST,
  executeRoleContextSharingGrantTransitionV1,
  verifyRoleContextSharingGrantCapability,
  type RoleContextSharingEligibilityPortV1,
  type RoleContextSharingGrantTransitionRequest,
  type RoleContextSharingGrantValidationOptions,
} from './role-context-sharing-grant.ts';

export {
  canonicalCollaborationGrantPayload,
  collaborationGrantSignatureNamespace,
  canonicalCollaborationGrantEnvelope,
  collaborationGrantEnvelopeDigest,
  canonicalDirectHumanReviewPayload,
  canonicalDirectHumanReviewAttestation,
  directHumanReviewAttestationDigest,
  parseDirectHumanReviewAttestation,
  assertCollaborationGrantId,
  parseCollaborationGrantEnvelope,
  validateCollaborationGrantPayload,
  assertUniqueCollaborationGrantUses,
  bindingFromPayload,
  collaborationPolicyDigestForPhase,
  isKnownCollaborationPolicyDigestForPhase,
  validateDirectHumanReviewAttestation,
  validateCollaborationGrantEnvelope,
  verifyCollaborationGrantCapability,
} from './collaboration-grant-codec.ts';

export type CollaborationGrantIssueOptions = {
  now?: Date;
  grantId?: string;
  signer?: MaintainerSignerProvider;
};

export type DirectHumanReviewAttestationOptions = {
  now?: Date;
  signer?: MaintainerSignerProvider;
};

export function issueCollaborationGrant(
  cwd: string,
  request: CollaborationGrantRequest,
  options: CollaborationGrantIssueOptions = {},
): CollaborationGrantIssueResult {
  const repository = discoverRepository(cwd);
  const prepared = prepareCollaborationGrantIssue(cwd, request, options);
  const availableEnvelopePath = storeAvailableCollaborationGrant(
    repository.gitCommonDirectory,
    prepared.envelope,
  );
  return { ...prepared, availableEnvelopePath };
}

export function prepareCollaborationGrantIssue(
  cwd: string,
  request: CollaborationGrantRequest,
  options: CollaborationGrantIssueOptions = {},
): PreparedCollaborationGrantIssue {
  const repository = discoverRepository(cwd);
  const baselineCommit = exactRepositoryCommit(
    repository.repositoryRoot,
    request.baselineCommit,
  );
  const baselineTree = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${baselineCommit}^{tree}`,
  ]).trim();
  if (request.baselineTree !== baselineTree) {
    throw collaborationBindingMismatch(
      'Requested baseline tree does not match the exact baseline commit.',
    );
  }
  const mergeBase = runGit(repository.repositoryRoot, [
    'merge-base',
    baselineCommit,
    repository.head,
  ]).trim();
  if (mergeBase !== baselineCommit) {
    throw collaborationBindingMismatch(
      'Requested baseline is not an ancestor of the current repository head.',
    );
  }

  const policy = loadPolicyAtCommit(repository.repositoryRoot, baselineCommit);
  const origin = runGit(repository.repositoryRoot, [
    'remote',
    'get-url',
    'origin',
  ]).trim();
  if (origin !== policy.repository.origin) {
    throw collaborationBindingMismatch(
      'Repository origin does not match the trusted maintainer policy.',
    );
  }
  const policyBlob = runGit(repository.repositoryRoot, [
    'rev-parse',
    `${baselineCommit}:workflow/maintainer-policy.json`,
  ]).trim();
  const now = exactDate(options.now ?? new Date());
  const ttlMinutes = request.ttlMinutes ?? COLLABORATION_GRANT_MAX_TTL_MINUTES;
  const maxUses = request.maxUses ?? 1;
  if (
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < 1 ||
    ttlMinutes >
      Math.min(policy.maxTtlMinutes, COLLABORATION_GRANT_MAX_TTL_MINUTES) ||
    maxUses !== 1
  ) {
    throw collaborationInvalid(
      'Collaboration grant bounds exceed trusted policy.',
    );
  }
  const grantId = assertCollaborationGrantId(
    options.grantId ?? crypto.randomUUID(),
  );
  const store = collaborationGrantStorePaths(repository.gitCommonDirectory);
  if (
    [store.available, store.reserved, store.terminal].some((directory) =>
      fsExistsGrant(directory, grantId),
    )
  ) {
    throw workflowError(
      'COLLABORATION_GRANT_EXISTS',
      `Collaboration grant ${grantId} already has local state.`,
      ExitCode.conflict,
    );
  }

  const signer =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  signer.assertHumanPresent();
  const signerIdentity = signer.identity();
  const payload: CollaborationGrantPayload = {
    version: 2,
    signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    grantId,
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob,
    collaborationPolicyDigest: collaborationPolicyDigestForPhase(
      request.lifecyclePhase,
    ),
    changeId: request.changeId,
    taskId: request.taskId,
    baselineCommit,
    baselineTree,
    targetDigest: request.targetDigest,
    lifecyclePhase: request.lifecyclePhase,
    rolePair: request.rolePair,
    availableActor:
      request.degradedForm === 'direct-human-review'
        ? {
            kind: 'direct-human',
            identity: signerIdentity,
            assurance: 'maintainer-signed',
          }
        : request.availableActor,
    degradedForm: request.degradedForm,
    authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
    reason: request.reason,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString(),
    maxUses: 1,
    signer: signerIdentity,
  };
  validateCollaborationGrantPayload(payload, policy, {
    now,
    expectedPolicyBlob: policyBlob,
  });

  const canonicalPayload = canonicalCollaborationGrantPayload(payload);
  let signature: string;
  try {
    signature = signer.sign(
      canonicalPayload,
      COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    );
    assertArmoredSignature(signature);
    signer.verify(
      canonicalPayload,
      signature,
      signerIdentity,
      COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    );
  } catch (error) {
    throw collaborationSignatureInvalid(error);
  }
  const envelope = deepFreeze({ payload, signature });
  return { grantId, envelope };
}

export function createDirectHumanReviewAttestation(
  cwd: string,
  request: DirectHumanReviewAttestationRequest,
  options: DirectHumanReviewAttestationOptions = {},
): DirectHumanReviewAttestation {
  const repository = discoverRepository(cwd);
  const grant = parseCollaborationGrantEnvelope(
    canonicalCollaborationGrantEnvelope(request.grantEnvelope),
  );
  const payload = grant.payload;
  if (
    payload.degradedForm !== 'direct-human-review' ||
    (payload.lifecyclePhase !== 'plan-review' &&
      payload.lifecyclePhase !== 'task-diff-review') ||
    payload.availableActor.kind !== 'direct-human'
  ) {
    throw workflowError(
      'DIRECT_HUMAN_REVIEW_INVALID',
      'This collaboration grant does not authorize direct-human review.',
      ExitCode.guard,
    );
  }
  const baselineCommit = exactRepositoryCommit(
    repository.repositoryRoot,
    payload.baselineCommit,
  );
  const policy = loadPolicyAtCommit(repository.repositoryRoot, baselineCommit);
  const verifier =
    options.signer ??
    createInteractiveSshSigner(repository.repositoryRoot, policy);
  const now = exactDate(options.now ?? new Date());
  validateCollaborationGrantEnvelope(grant, policy, {
    now,
    expected: bindingFromPayload(payload),
    verifier,
  });
  verifier.assertHumanPresent();
  const identity = verifier.identity();
  if (
    identity !== payload.signer ||
    identity !== payload.availableActor.identity
  ) {
    throw workflowError(
      'DIRECT_HUMAN_REVIEW_INVALID',
      'Direct-human review signer does not match the exact collaboration grant.',
      ExitCode.guard,
    );
  }
  const attestationPayload: DirectHumanReviewAttestationPayload = {
    version: 1,
    grantId: payload.grantId,
    signedEnvelopeDigest: collaborationGrantEnvelopeDigest(grant),
    transitionDigest: exactDigestValue(
      request.transitionDigest,
      'transition digest',
    ),
    targetDigest: payload.targetDigest,
    reviewNodeId: exactDigestValue(request.reviewNodeId, 'review node ID'),
    reviewResultDigest: exactDigestValue(
      request.reviewResultDigest,
      'review result digest',
    ),
    signedAt: now.toISOString(),
    signer: identity,
  };
  const canonical = canonicalDirectHumanReviewPayload(attestationPayload);
  let signature: string;
  try {
    signature = verifier.sign(
      canonical,
      DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
    );
    assertArmoredSignature(signature);
    verifier.verify(
      canonical,
      signature,
      identity,
      DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
    );
  } catch (error) {
    throw collaborationSignatureInvalid(error);
  }
  return deepFreeze({
    payload: attestationPayload,
    signatureNamespace: DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
    signature,
  });
}

function loadPolicyAtCommit(
  repositoryRoot: string,
  commit: string,
): MaintainerPolicy {
  try {
    return parseMaintainerPolicy(
      JSON.parse(
        runGit(repositoryRoot, [
          'show',
          `${commit}:workflow/maintainer-policy.json`,
        ]),
      ),
    );
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw error;
    }
    throw collaborationInvalid(
      'The exact baseline does not contain a valid maintainer policy.',
    );
  }
}

function exactRepositoryCommit(
  repositoryRoot: string,
  requested: string,
): string {
  if (typeof requested !== 'string' || !FULL_OID.test(requested)) {
    throw collaborationInvalid(
      'Collaboration grant baseline must be a full commit object ID.',
    );
  }
  const resolved = runGit(repositoryRoot, [
    'rev-parse',
    `${requested}^{commit}`,
  ]).trim();
  if (resolved !== requested) {
    throw collaborationBindingMismatch(
      'Collaboration grant baseline is not the exact requested commit.',
    );
  }
  return resolved;
}

function exactDigestValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST.test(value)) {
    throw workflowError(
      'DIRECT_HUMAN_REVIEW_INVALID',
      `Direct-human review ${label} is invalid.`,
      ExitCode.guard,
    );
  }
  return value;
}

function fsExistsGrant(directory: string, grantId: string): boolean {
  return fs.existsSync(path.join(directory, `${grantId}.json`));
}
