/**
 * Signs and stores an eligible role context sharing Grant for the current
 * planning review requirement.
 *
 * Invariants:
 * - The selected Grant identity must already be listed in the durable
 *   requirement.
 */
import { canonicalRoleContextSharingGrantPayloadV1 } from '../runtime/grants/optional-grants-package.ts';
import {
  ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
  ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  type RoleContextSharingGrantEnvelopeV1,
} from '@jigwright/core/role-context-sharing-grant-codec';

import {
  createRoleContextSharingRequirementEligibilityPort,
  deriveRoleContextSharingPlanReviewExpectedBinding,
  type RoleContextSharingPlanReviewRequirementV3,
} from '../application/propose/role-context-sharing-plan-review.ts';
import { readCurrentRoleContextSharingPlanReviewRequirement } from './propose-production.ts';
import {
  assertInteractiveSignerContext,
  createInteractiveSshSigner,
  type InteractiveSignerContext,
  type MaintainerSignerProvider,
} from '../adapters/signing/ssh/maintainer-signer.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { verifyRoleContextSharingGrantCapability } from '../runtime/grants/grant-services.ts';
import type { AuthoritativeRoleContextSharingGrantVerifier } from '../modules/authority/role-context-sharing-grant-verifier-port.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from '../modules/authority/maintainer-policy.ts';
import {
  discoverRepository,
  runGit,
} from '../runtime/repository-transaction/git.ts';
import { storeAvailableRoleContextSharingGrant } from '../runtime/storage-journal/role-context-sharing-store.ts';
import { createCurrentAuthoritativeRoleContextSharingGrantVerifier } from './grant-verifier-composition.ts';
import { resolveBlobOid } from '../runtime/repository-transaction/git-object-ids.ts';

export type RoleContextSharingGrantCandidate = Readonly<{
  requirementNodeId: string;
  grantId: string;
  reason: string;
  ttlMinutes: number;
}>;

export type ApproveRoleContextSharingGrantOptions = Readonly<{
  now?: Date;
  signer?: MaintainerSignerProvider;
  verifier?: AuthoritativeRoleContextSharingGrantVerifier;
  interactiveContext?: InteractiveSignerContext;
}>;

export function approveAndStoreRoleContextSharingGrant(
  cwd: string,
  candidate: RoleContextSharingGrantCandidate,
  options: ApproveRoleContextSharingGrantOptions = {},
) {
  const repository = discoverRepository(cwd);
  const current = readCurrentRoleContextSharingPlanReviewRequirement(
    repository.repositoryRoot,
    candidate.requirementNodeId,
  );
  const requirement = current.requirement;
  if (!requirement.grantReferences.includes(candidate.grantId)) {
    throw workflowError(
      'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE',
      'The selected R-007 grant UUID is not prelisted by the durable requirement.',
      ExitCode.guard,
    );
  }
  const policy = parseMaintainerPolicy(
    JSON.parse(
      runGit(repository.repositoryRoot, [
        'show',
        `${requirement.baseline.head}:workflow/maintainer-policy.json`,
      ]),
    ),
  );
  const policyBlob = resolveBlobOid(
    repository.repositoryRoot,
    requirement.baseline.head,
    'workflow/maintainer-policy.json',
  );
  return approveAndStoreRoleContextSharingGrantForCurrentRequirement({
    repositoryRoot: repository.repositoryRoot,
    gitCommonDirectory: repository.gitCommonDirectory,
    requirement,
    candidate,
    policy,
    policyBlob,
    options,
  });
}

export function approveAndStoreRoleContextSharingGrantForCurrentRequirement(input: {
  repositoryRoot: string;
  gitCommonDirectory: string;
  requirement: RoleContextSharingPlanReviewRequirementV3;
  candidate: RoleContextSharingGrantCandidate;
  policy: MaintainerPolicy;
  policyBlob: string;
  options?: ApproveRoleContextSharingGrantOptions;
}) {
  const { requirement, candidate, policy } = input;
  const options = input.options ?? {};
  if (!requirement.grantReferences.includes(candidate.grantId)) {
    throw workflowError(
      'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE',
      'The selected R-007 grant UUID is not prelisted by the durable requirement.',
      ExitCode.guard,
    );
  }
  if (candidate.ttlMinutes > Math.min(policy.maxTtlMinutes, 30)) {
    throw workflowError(
      'ROLE_CONTEXT_SHARING_GRANT_INVALID',
      'R-007 grant TTL exceeds the exact maintainer-policy limit.',
      ExitCode.guard,
    );
  }
  assertInteractiveSignerContext(
    options.interactiveContext ?? {
      stdinIsTty: process.stdin.isTTY === true,
      stdoutIsTty: process.stdout.isTTY === true,
      stderrIsTty: process.stderr.isTTY === true,
    },
  );
  const signer =
    options.signer ?? createInteractiveSshSigner(input.repositoryRoot, policy);
  signer.assertHumanPresent();
  const signerIdentity = signer.identity();
  if (
    !policy.trustedSigners.some(({ identity }) => identity === signerIdentity)
  ) {
    throw workflowError(
      'ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_INVALID',
      'R-007 grant signer is not trusted by the pinned maintainer policy.',
      ExitCode.guard,
    );
  }
  const now = options.now ?? new Date();
  const expected = deriveRoleContextSharingPlanReviewExpectedBinding({
    requirement,
    repositoryId: policy.repository.id,
    repositoryOrigin: policy.repository.origin,
    policyBlob: input.policyBlob,
    reason: candidate.reason,
  });
  const payload = {
    version: 1 as const,
    signatureNamespace: ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
    grantId: candidate.grantId,
    ...expected,
    authorizedEffect: ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
    issuedAt: now.toISOString(),
    expiresAt: new Date(
      now.getTime() + candidate.ttlMinutes * 60_000,
    ).toISOString(),
    maxUses: 1 as const,
    signer: signerIdentity,
  };
  const signingBytes = canonicalRoleContextSharingGrantPayloadV1(payload);
  const signature = signer.sign(
    signingBytes,
    ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  );
  signer.verify(
    signingBytes,
    signature,
    signerIdentity,
    ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
  );
  const envelope: RoleContextSharingGrantEnvelopeV1 = { payload, signature };
  const verifier =
    options.verifier ??
    createCurrentAuthoritativeRoleContextSharingGrantVerifier(policy);
  verifyRoleContextSharingGrantCapability(envelope, policy, {
    now,
    expected,
    verifier,
    eligibility: createRoleContextSharingRequirementEligibilityPort({
      requirement,
      grantId: candidate.grantId,
      expected,
    }),
  });
  const record = storeAvailableRoleContextSharingGrant(
    input.gitCommonDirectory,
    envelope,
  );
  return Object.freeze({ envelope, record });
}
