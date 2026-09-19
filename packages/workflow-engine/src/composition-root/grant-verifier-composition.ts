/**
 * Builds authoritative and consumed-replay verifiers from trusted package
 * composition.
 *
 * Invariants:
 * - Authoritative verification rejects a composition changed since verifier
 *   creation.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
} from '@jigwright/core/collaboration-grant-envelope-codec';
import { GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1 } from '@jigwright/core/grant-envelope-contracts';
import {
  ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1,
  ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
  ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1,
} from '@jigwright/core/role-context-sharing-grant-codec';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { verifySshSignatureWithPublicKey } from '../adapters/signing/ssh/maintainer-signer.ts';
import {
  sealConsumedCollaborationGrantReplayVerifier,
  sealAuthoritativeCollaborationGrantVerifier,
  type AuthoritativeCollaborationGrantVerifier,
  type ConsumedCollaborationGrantReplayVerifier,
} from '../modules/authority/grant-verifier-port.ts';
import {
  sealConsumedRoleContextSharingGrantReplayVerifier,
  sealAuthoritativeRoleContextSharingGrantVerifier,
  type AuthoritativeRoleContextSharingGrantVerifier,
  type ConsumedRoleContextSharingGrantReplayVerifier,
} from '../modules/authority/role-context-sharing-grant-verifier-port.ts';
import {
  COLLABORATION_GRANT_POLICY_DIGEST,
  DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
  TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST,
} from '../modules/authority/collaboration-grant-codec.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from '../modules/authority/maintainer-policy.ts';
import { ROLE_CONTEXT_SHARING_POLICY_DIGEST } from '../modules/authority/role-context-sharing-grant.ts';
import { verifyExactConsumedCollaborationGrantCrashReplay } from '../runtime/storage-journal/collaboration-grant-consumption.ts';
import { verifyConsumedRoleContextSharingReplay } from '../runtime/grants/grant-services.ts';
import { readVerifiedRoleContextSharingTerminalReceipt } from './role-context-sharing-terminal-receipt-production.ts';
import {
  loadProtectedCapabilitiesFromWorktree,
  type CollaborationGrantVerifierCompositionV1,
} from '../runtime/repository-validation/protected-capabilities.ts';
import type {
  ConsumedRoleReplayPort,
  ConsumedRoleResultReplayPort,
} from '../modules/provider-orchestration/role-admission-contracts.ts';
import { resolveBlobOid } from '../runtime/repository-transaction/git-object-ids.ts';
import { readFileAtRevision } from '../runtime/repository-transaction/git-command.ts';

const COLLABORATION_EFFECT = 'role-independence-degradation-only' as const;
const REQUIRED_PACKAGE_EXPORTS = Object.freeze({
  './collaboration-grant-envelope-reader':
    './src/collaboration-grant-envelope-reader.ts',
  './grant-envelope-verifier': './src/grant-envelope-verifier.ts',
  './grant-lifecycle': './src/grant-lifecycle.ts',
} as const);
const REQUIRED_COMPOSITION_SOURCES = Object.freeze([
  'packages/core/src/collaboration-grant-envelope-codec.ts',
  'packages/core/src/grant-envelope-contracts.ts',
  'packages/core/src/grant-lifecycle-contracts.ts',
  'packages/core/src/role-context-sharing-grant-codec.ts',
  'packages/core/src/signed-attestation-envelope-codec.ts',
  'packages/grants/package.json',
  'packages/grants/src/collaboration-grant-envelope-reader.ts',
  'packages/grants/src/grant-envelope-verifier.ts',
  'packages/grants/src/grant-lifecycle.ts',
  'packages/grants/src/role-context-sharing-degradation.ts',
  'packages/grants/src/signed-attestation-envelope-reader.ts',
  'packages/workflow-engine/src/application/control-plane/collaboration-grant-revocation.ts',
  'packages/workflow-engine/src/composition-root/collaboration-grant-issuance-production.ts',
  'packages/workflow-engine/src/composition-root/collaboration-grant-production.ts',
  'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-codec.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-records.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-use.ts',
  'packages/workflow-engine/src/modules/authority/grant-errors.ts',
  'packages/workflow-engine/src/modules/authority/grant-revocation-contract.ts',
  'packages/workflow-engine/src/modules/investigation/domain/human-resolution-grant-contract.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-consumed-replay.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant-lifecycle-port.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant.ts',
  'packages/workflow-engine/src/runtime/grants/collaboration-grant-issuance.ts',
  'packages/workflow-engine/src/runtime/grants/grant-services.ts',
  'packages/workflow-engine/src/runtime/grants/optional-grants-package.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-consumption.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-private-files.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-records.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-reservation.ts',
  'packages/workflow-engine/src/runtime/storage-journal/collaboration-grant-revocation-store.ts',
] as const);
const ROLE_CONTEXT_SHARING_PACKAGE_EXPORT =
  './role-context-sharing-degradation' as const;
const ROLE_CONTEXT_SHARING_PACKAGE_EXPORT_TARGET =
  './src/role-context-sharing-degradation.ts' as const;
const REQUIRED_ROLE_CONTEXT_SHARING_SOURCES = Object.freeze([
  'packages/agent-runtime/package.json',
  'packages/agent-runtime/src/built-in-provider-definition.ts',
  'packages/agent-runtime/src/index.ts',
  'packages/agent-runtime/src/provider-definition-snapshot.ts',
  'packages/core/package.json',
  'packages/core/src/built-in-provider-definition.ts',
  'packages/core/src/canonical-json.ts',
  'packages/core/src/collaboration-grant-envelope-codec.ts',
  'packages/core/src/grant-envelope-contracts.ts',
  'packages/core/src/grant-lifecycle-contracts.ts',
  'packages/core/src/role-context-sharing-grant-codec.ts',
  'packages/core/src/signed-attestation-envelope-codec.ts',
  'packages/grants/package.json',
  'packages/grants/src/collaboration-grant-envelope-reader.ts',
  'packages/grants/src/grant-envelope-verifier.ts',
  'packages/grants/src/grant-lifecycle.ts',
  'packages/grants/src/role-context-sharing-degradation.ts',
  'packages/grants/src/signed-attestation-envelope-reader.ts',
  'packages/workflow-engine/src/adapters/planning/openspec/documents/managed-change-contract.ts',
  'packages/workflow-engine/src/adapters/signing/ssh/maintainer-signer.ts',
  'packages/workflow-engine/src/application/propose/plan-review-role-topology.ts',
  'packages/workflow-engine/src/application/propose/role-context-sharing-plan-review.ts',
  'packages/workflow-engine/src/composition-root/collaboration-grant-issuance-production.ts',
  'packages/workflow-engine/src/composition-root/grant-verifier-composition.ts',
  'packages/workflow-engine/src/composition-root/role-admission-production.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-grant-approval-production.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-grant-lifecycle-production.ts',
  'packages/workflow-engine/src/composition-root/role-context-sharing-terminal-receipt-production.ts',
  'packages/workflow-engine/src/composition-root/role-topology-resolution-production.ts',
  'packages/workflow-engine/src/composition-root/validated-contract-context.ts',
  'packages/workflow-engine/src/application/assurance/base-authority-attestation.ts',
  'packages/workflow-engine/src/modules/assurance/commit-replay/ci-planning.ts',
  'packages/workflow-engine/src/runtime/repository-validation/commit-replay/ci-planning.ts',
  'packages/workflow-engine/src/runtime/repository-validation/commit-replay/services.ts',
  'packages/workflow-engine/src/composition-root/ci-replay-production.ts',
  'packages/workflow-engine/src/application/assurance/pull-request-verification.ts',
  'packages/workflow-engine/src/entrypoints/cli/role-context-sharing-grant-cli.ts',
  'packages/workflow-engine/src/modules/assurance/planning-assurance-validator.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-codec.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-records.ts',
  'packages/workflow-engine/src/modules/authority/collaboration-grant-use.ts',
  'packages/workflow-engine/src/modules/authority/grant-errors.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-consumed-replay.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant-lifecycle-port.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant-verifier-port.ts',
  'packages/workflow-engine/src/modules/authority/role-context-sharing-grant.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/agent-role-plan.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/role-admission-contracts.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/role-scheduler.ts',
  'packages/workflow-engine/src/modules/provider-orchestration/role-topology-resolution.ts',
  'packages/workflow-engine/src/runtime/grants/collaboration-grant-issuance.ts',
  'packages/workflow-engine/src/runtime/grants/grant-services.ts',
  'packages/workflow-engine/src/runtime/grants/optional-grants-package.ts',
  'packages/workflow-engine/src/runtime/repository-transaction/agent-role-plan-store.ts',
  'packages/workflow-engine/src/runtime/storage-journal/role-context-sharing-store.ts',
] as const);

export {
  assertAuthoritativeCollaborationGrantVerifier,
  type AuthoritativeCollaborationGrantVerifier,
} from '../modules/authority/grant-verifier-port.ts';
export {
  assertAuthoritativeRoleContextSharingGrantVerifier,
  type AuthoritativeRoleContextSharingGrantVerifier,
} from '../modules/authority/role-context-sharing-grant-verifier-port.ts';

export type CollaborationGrantVerifierPolicyDigests = Readonly<{
  collaborationPolicyDigest: string;
  taskDiffReviewPolicyDigest: string;
}>;

export function createCurrentAuthoritativeCollaborationGrantVerifier(
  policy: Pick<MaintainerPolicy, 'trustedSigners'>,
): AuthoritativeCollaborationGrantVerifier {
  return createAuthoritativeCollaborationGrantVerifier(policy, {
    collaborationPolicyDigest: COLLABORATION_GRANT_POLICY_DIGEST,
    taskDiffReviewPolicyDigest: TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST,
  });
}

/**
 * Seal one underlying signature verifier behind the repository-owned
 * protected composition. Every verify call rechecks candidate currentness;
 * there is no fallback to the unsealed verifier after drift.
 */
export function createAuthoritativeCollaborationGrantVerifier(
  policy: Pick<MaintainerPolicy, 'trustedSigners'>,
  expectedPolicyDigests: CollaborationGrantVerifierPolicyDigests,
): AuthoritativeCollaborationGrantVerifier {
  const trustedSigners = snapshotTrustedSigners(policy);
  const policyDigests = snapshotPolicyDigests(expectedPolicyDigests);
  const repositoryRoot = locateEngineRepositoryRoot();
  const composition = loadAndAssertComposition(repositoryRoot, policyDigests);
  const assertCurrent = (): void => {
    const current = loadAndAssertComposition(repositoryRoot, policyDigests);
    if (current.compositionDigest !== composition.compositionDigest) {
      throw compositionUnavailable();
    }
  };
  return sealAuthoritativeCollaborationGrantVerifier(
    Object.freeze({
      assertCurrent,
      verify(
        payload: string,
        signature: string,
        identity: string,
        namespace: string,
      ): void {
        assertCurrent();
        const signer = trustedSigners.find(
          (candidate) => candidate.identity === identity,
        );
        if (signer === undefined) {
          throw compositionUnavailable();
        }
        verifySshSignatureWithPublicKey(
          payload,
          signature,
          identity,
          signer.publicKey,
          namespace,
        );
      },
    }),
    composition.compositionDigest,
  );
}

/**
 * Construct the cryptographic half of exact consumed-record crash replay.
 * This capability intentionally does not consult current protected
 * composition: drift disables new reserve/consume authority, but cannot turn
 * an already-consumed transition into an unrecoverable half-transaction.
 * The returned value exposes no generic verifier method and is accepted only
 * by the consumed terminal proof minter.
 */
export function createConsumedCollaborationGrantReplayVerifier(
  policy: Pick<MaintainerPolicy, 'trustedSigners'>,
): ConsumedCollaborationGrantReplayVerifier {
  let trustedSigners: ReturnType<typeof snapshotTrustedSigners>;
  try {
    trustedSigners = snapshotTrustedSigners(policy);
  } catch {
    throw consumedReplayUnavailable();
  }
  return sealConsumedCollaborationGrantReplayVerifier(
    Object.freeze({
      verify(
        payload: string,
        signature: string,
        identity: string,
        namespace: string,
      ): void {
        if (
          namespace !== COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE &&
          namespace !== DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE
        ) {
          throw consumedReplayUnavailable();
        }
        const signer = trustedSigners.find(
          (candidate) => candidate.identity === identity,
        );
        if (signer === undefined) {
          throw consumedReplayUnavailable();
        }
        verifySshSignatureWithPublicKey(
          payload,
          signature,
          identity,
          signer.publicKey,
          namespace,
        );
      },
    }),
    crypto
      .createHash('sha256')
      .update(canonicalJson(trustedSigners))
      .digest('hex'),
  );
}

/**
 * Production adapter for read-only consumed-role crash replay. It deliberately
 * reconstructs trust from the grant's historical baseline policy and never
 * loads or asserts the current protected verifier composition.
 */
export const productionConsumedRoleResultReplayPort: ConsumedRoleResultReplayPort =
  Object.freeze({
    verify(input) {
      if (
        canonicalJson(input.directHumanReviewAttestation) !==
        canonicalJson(input.grantUse.directHumanReviewAttestation)
      ) {
        throw consumedReplayUnavailable();
      }
      let policy: MaintainerPolicy;
      try {
        policy = parseMaintainerPolicy(
          JSON.parse(
            readFileAtRevision(
              input.repositoryRoot,
              input.expectedBinding.baselineCommit,
              'workflow/maintainer-policy.json',
            ),
          ),
        );
      } catch {
        throw consumedReplayUnavailable();
      }
      const replay = verifyExactConsumedCollaborationGrantCrashReplay(
        input.repositoryRoot,
        input.grantUse.grantId,
        {
          transitionDigest: input.grantUse.transitionDigest,
          assignment: input.assignment,
          contentAdmission: {
            kind: input.content.kind,
            nodeId: input.content.nodeId,
            resultDigest: input.content.resultDigest,
            current: true,
          },
          directHumanReviewAttestation:
            input.grantUse.directHumanReviewAttestation,
        },
        {
          expectedBinding: input.expectedBinding,
          verifier: createConsumedCollaborationGrantReplayVerifier(policy),
        },
      );
      const exactUseDigest = crypto
        .createHash('sha256')
        .update(canonicalJson(input.grantUse))
        .digest('hex');
      if (
        replay.grantId !== input.grantUse.grantId ||
        replay.transitionDigest !== input.grantUse.transitionDigest ||
        replay.useDigest !== exactUseDigest
      ) {
        throw consumedReplayUnavailable();
      }
      return replay;
    },
  });

export const productionConsumedPlanReviewReplayPort: ConsumedRoleReplayPort =
  Object.freeze({
    verify(input) {
      return productionConsumedRoleResultReplayPort.verify(input);
    },
    verifyRoleContextSharing(input) {
      let policy: MaintainerPolicy;
      let policyBlob: string;
      try {
        policy = parseMaintainerPolicy(
          JSON.parse(
            readFileAtRevision(
              input.repositoryRoot,
              input.evidence.expectedBinding.baselineCommit,
              'workflow/maintainer-policy.json',
            ),
          ),
        );
        policyBlob = resolveBlobOid(
          input.repositoryRoot,
          input.evidence.expectedBinding.baselineCommit,
          'workflow/maintainer-policy.json',
        );
      } catch {
        throw roleContextSharingConsumedReplayUnavailable();
      }
      if (policyBlob !== input.evidence.expectedBinding.policyBlob) {
        throw roleContextSharingConsumedReplayUnavailable();
      }
      const receipt = readVerifiedRoleContextSharingTerminalReceipt(
        input.repositoryRoot,
        input.evidence,
      );
      const replay = verifyConsumedRoleContextSharingReplay({
        record: receipt.envelope.payload.terminalRecord,
        evidence: input.evidence,
        expected: input.evidence.expectedBinding,
        policy,
        verifier: createConsumedRoleContextSharingGrantReplayVerifier(policy),
        assignment: input.assignment,
        author: input.author,
        participant: input.participant,
        content: input.content,
        providerInvocation: input.providerInvocation,
      });
      const assignmentDigest = crypto
        .createHash('sha256')
        .update(canonicalJson(input.assignment))
        .digest('hex');
      if (
        input.evidence.use.assignmentDigest !== assignmentDigest ||
        input.evidence.use.invocationId !==
          input.providerInvocation.invocationId ||
        input.evidence.use.requestDigest !==
          input.providerInvocation.requestDigest
      ) {
        throw roleContextSharingConsumedReplayUnavailable();
      }
      return replay;
    },
  });

export function createConsumedRoleContextSharingGrantReplayVerifier(
  policy: Pick<MaintainerPolicy, 'trustedSigners'>,
): ConsumedRoleContextSharingGrantReplayVerifier {
  let trustedSigners: ReturnType<typeof snapshotTrustedSigners>;
  try {
    trustedSigners = snapshotTrustedSigners(policy);
  } catch {
    throw roleContextSharingConsumedReplayUnavailable();
  }
  return sealConsumedRoleContextSharingGrantReplayVerifier(
    Object.freeze({
      verify(
        payload: string,
        signature: string,
        identity: string,
        namespace: string,
      ): void {
        if (namespace !== ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1) {
          throw roleContextSharingConsumedReplayUnavailable();
        }
        const signer = trustedSigners.find(
          (candidate) => candidate.identity === identity,
        );
        if (signer === undefined) {
          throw roleContextSharingConsumedReplayUnavailable();
        }
        verifySshSignatureWithPublicKey(
          payload,
          signature,
          identity,
          signer.publicKey,
          namespace,
        );
      },
    }),
    crypto
      .createHash('sha256')
      .update(canonicalJson(trustedSigners))
      .digest('hex'),
  );
}

export function createCurrentAuthoritativeRoleContextSharingGrantVerifier(
  policy: Pick<MaintainerPolicy, 'trustedSigners'>,
): AuthoritativeRoleContextSharingGrantVerifier {
  return createAuthoritativeRoleContextSharingGrantVerifier(
    policy,
    ROLE_CONTEXT_SHARING_POLICY_DIGEST,
  );
}

export function createAuthoritativeRoleContextSharingGrantVerifier(
  policy: Pick<MaintainerPolicy, 'trustedSigners'>,
  expectedPolicyDigest: string,
): AuthoritativeRoleContextSharingGrantVerifier {
  let trustedSigners: ReturnType<typeof snapshotTrustedSigners>;
  let policyDigest: string;
  let repositoryRoot: string;
  let composition: CollaborationGrantVerifierCompositionV1;
  try {
    trustedSigners = snapshotTrustedSigners(policy);
    if (!/^[0-9a-f]{64}$/.test(expectedPolicyDigest)) {
      throw roleContextSharingCompositionUnavailable();
    }
    policyDigest = expectedPolicyDigest;
    repositoryRoot = locateEngineRepositoryRoot();
    composition = loadAndAssertRoleContextSharingComposition(
      repositoryRoot,
      policyDigest,
    );
  } catch {
    throw roleContextSharingCompositionUnavailable();
  }
  const assertCurrent = (): void => {
    const current = loadAndAssertRoleContextSharingComposition(
      repositoryRoot,
      policyDigest,
    );
    if (current.compositionDigest !== composition.compositionDigest) {
      throw roleContextSharingCompositionUnavailable();
    }
  };
  return sealAuthoritativeRoleContextSharingGrantVerifier(
    Object.freeze({
      assertCurrent,
      verify(
        payload: string,
        signature: string,
        identity: string,
        namespace: string,
      ): void {
        assertCurrent();
        if (namespace !== ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1) {
          throw roleContextSharingCompositionUnavailable();
        }
        const signer = trustedSigners.find(
          (candidate) => candidate.identity === identity,
        );
        if (signer === undefined) {
          throw roleContextSharingCompositionUnavailable();
        }
        verifySshSignatureWithPublicKey(
          payload,
          signature,
          identity,
          signer.publicKey,
          namespace,
        );
      },
    }),
    composition.compositionDigest,
  );
}

function snapshotTrustedSigners(
  policy: Pick<MaintainerPolicy, 'trustedSigners'>,
): Readonly<MaintainerPolicy['trustedSigners']> {
  if (
    !Array.isArray(policy?.trustedSigners) ||
    policy.trustedSigners.length === 0
  ) {
    throw compositionUnavailable();
  }
  const identities = new Set<string>();
  const publicKeys = new Set<string>();
  const fingerprints = new Set<string>();
  const snapshot = policy.trustedSigners.map((candidate) => {
    const identity = candidate?.identity;
    const publicKey = candidate?.publicKey;
    const fingerprint = candidate?.fingerprint;
    if (
      typeof identity !== 'string' ||
      identity.length === 0 ||
      typeof publicKey !== 'string' ||
      publicKey.length === 0 ||
      typeof fingerprint !== 'string' ||
      fingerprint.length === 0 ||
      identities.has(identity) ||
      publicKeys.has(publicKey) ||
      fingerprints.has(fingerprint)
    ) {
      throw compositionUnavailable();
    }
    identities.add(identity);
    publicKeys.add(publicKey);
    fingerprints.add(fingerprint);
    return Object.freeze({ identity, publicKey, fingerprint });
  });
  return Object.freeze(snapshot);
}

function snapshotPolicyDigests(
  value: CollaborationGrantVerifierPolicyDigests,
): CollaborationGrantVerifierPolicyDigests {
  if (
    !/^[0-9a-f]{64}$/.test(value?.collaborationPolicyDigest) ||
    !/^[0-9a-f]{64}$/.test(value?.taskDiffReviewPolicyDigest)
  ) {
    throw compositionUnavailable();
  }
  return Object.freeze({
    collaborationPolicyDigest: value.collaborationPolicyDigest,
    taskDiffReviewPolicyDigest: value.taskDiffReviewPolicyDigest,
  });
}

function loadAndAssertComposition(
  repositoryRoot: string,
  expectedPolicyDigests: CollaborationGrantVerifierPolicyDigests,
): CollaborationGrantVerifierCompositionV1 {
  let manifest: ReturnType<typeof loadProtectedCapabilitiesFromWorktree>;
  try {
    manifest = loadProtectedCapabilitiesFromWorktree(repositoryRoot);
  } catch {
    // The protected-manifest loader owns detailed repair diagnostics. This
    // authorization boundary intentionally exposes one stable refusal so
    // callers cannot distinguish or bypass individual composition drifts.
    throw compositionUnavailable();
  }
  const composition = manifest.grantVerifierComposition;
  if (composition === undefined) throw compositionUnavailable();
  if (
    composition.verifierContractVersion !==
      GRANT_ENVELOPE_VERIFIER_CONTRACT_VERSION_V1 ||
    composition.verifierImplementation !== 'ssh-maintainer-policy.v1' ||
    composition.readerContractVersion !==
      COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1 ||
    composition.signatureNamespaces.length !== 1 ||
    composition.signatureNamespaces[0] !==
      COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE ||
    composition.authorizedEffects.length !== 1 ||
    composition.authorizedEffects[0] !== COLLABORATION_EFFECT ||
    composition.collaborationPolicyDigest !==
      expectedPolicyDigests.collaborationPolicyDigest ||
    composition.taskDiffReviewPolicyDigest !==
      expectedPolicyDigests.taskDiffReviewPolicyDigest ||
    composition.repairAuthority !==
      'human-only-authority-plan-or-sealed-recovery' ||
    REQUIRED_COMPOSITION_SOURCES.some(
      (sourcePath) => !composition.sourcePaths.includes(sourcePath),
    )
  ) {
    throw compositionUnavailable();
  }
  const authorization = manifest.entries.find(
    ({ capability }) => capability === 'authorization.verify',
  );
  if (
    authorization === undefined ||
    REQUIRED_COMPOSITION_SOURCES.some(
      (sourcePath) =>
        ![...authorization.entrypoints, ...authorization.dependencies].includes(
          sourcePath,
        ),
    )
  ) {
    throw compositionUnavailable();
  }
  assertPackageExports(repositoryRoot);
  return composition;
}

function loadAndAssertRoleContextSharingComposition(
  repositoryRoot: string,
  expectedPolicyDigest: string,
): CollaborationGrantVerifierCompositionV1 {
  let composition: CollaborationGrantVerifierCompositionV1;
  try {
    composition = loadAndAssertComposition(repositoryRoot, {
      collaborationPolicyDigest: COLLABORATION_GRANT_POLICY_DIGEST,
      taskDiffReviewPolicyDigest: TASK_DIFF_REVIEW_COLLABORATION_POLICY_DIGEST,
    });
  } catch {
    throw roleContextSharingCompositionUnavailable();
  }
  const binding = composition.roleContextSharingGrant;
  if (
    binding === undefined ||
    binding.packageExport !== ROLE_CONTEXT_SHARING_PACKAGE_EXPORT ||
    binding.packageExportTarget !==
      ROLE_CONTEXT_SHARING_PACKAGE_EXPORT_TARGET ||
    binding.readerContractVersion !==
      ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1 ||
    binding.signatureNamespace !==
      ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_NAMESPACE_V1 ||
    binding.authorizedEffect !== ROLE_CONTEXT_SHARING_DEGRADATION_EFFECT_V1 ||
    binding.policyDigest !== expectedPolicyDigest ||
    REQUIRED_ROLE_CONTEXT_SHARING_SOURCES.some(
      (sourcePath) => !binding.sourcePaths.includes(sourcePath),
    )
  ) {
    throw roleContextSharingCompositionUnavailable();
  }
  const authorization = loadProtectedCapabilitiesFromWorktree(
    repositoryRoot,
  ).entries.find(({ capability }) => capability === 'authorization.verify');
  if (
    authorization === undefined ||
    binding.authorizationClosureDigest !== authorization.closureDigest ||
    REQUIRED_ROLE_CONTEXT_SHARING_SOURCES.some(
      (sourcePath) =>
        ![...authorization.entrypoints, ...authorization.dependencies].includes(
          sourcePath,
        ),
    )
  ) {
    throw roleContextSharingCompositionUnavailable();
  }
  assertPackageExports(repositoryRoot, true);
  return composition;
}

function assertPackageExports(
  repositoryRoot: string,
  requireRoleContextSharing = false,
): void {
  let value: unknown;
  try {
    value = JSON.parse(
      fs.readFileSync(
        path.join(repositoryRoot, 'packages/grants/package.json'),
        'utf8',
      ),
    ) as unknown;
  } catch {
    throw compositionUnavailable();
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    (value as { name?: unknown }).name !== '@jigwright/grants'
  ) {
    throw compositionUnavailable();
  }
  const exportsValue = (value as { exports?: unknown }).exports;
  if (
    exportsValue === null ||
    typeof exportsValue !== 'object' ||
    Array.isArray(exportsValue) ||
    Object.entries(REQUIRED_PACKAGE_EXPORTS).some(
      ([subpath, target]) =>
        (exportsValue as Record<string, unknown>)[subpath] !== target,
    ) ||
    (requireRoleContextSharing &&
      (exportsValue as Record<string, unknown>)[
        ROLE_CONTEXT_SHARING_PACKAGE_EXPORT
      ] !== ROLE_CONTEXT_SHARING_PACKAGE_EXPORT_TARGET)
  ) {
    throw compositionUnavailable();
  }
}

function locateEngineRepositoryRoot(): string {
  let candidate = fs.realpathSync(import.meta.dirname);
  for (let depth = 0; depth < 12; depth += 1) {
    if (
      fs.existsSync(
        path.join(candidate, 'workflow/protected-capabilities.json'),
      ) &&
      fs.existsSync(path.join(candidate, 'packages/grants/package.json'))
    ) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw compositionUnavailable();
}

function compositionUnavailable() {
  return workflowError(
    'COLLABORATION_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
    'The authoritative Collaboration Grant verifier composition is missing or stale.',
    ExitCode.verification,
    {
      recovery:
        'A human maintainer must repair the protected manifest through authority-plan or sealed recovery; unsealed verifier fallback is disabled.',
    },
  );
}

function roleContextSharingCompositionUnavailable() {
  return workflowError(
    'ROLE_CONTEXT_SHARING_GRANT_VERIFIER_COMPOSITION_UNAVAILABLE',
    'The authoritative role-context-sharing Grant verifier composition is missing or stale.',
    ExitCode.verification,
    {
      recovery:
        'A human maintainer must authorize or repair the protected binding through authority-plan or sealed recovery; unsealed verifier fallback is disabled.',
    },
  );
}

function consumedReplayUnavailable() {
  return workflowError(
    'COLLABORATION_GRANT_CONSUMED_REPLAY_VERIFIER_UNAVAILABLE',
    'The terminal-only Collaboration Grant replay verifier is unavailable.',
    ExitCode.verification,
  );
}

function roleContextSharingConsumedReplayUnavailable() {
  return workflowError(
    'ROLE_CONTEXT_SHARING_GRANT_CONSUMED_REPLAY_UNAVAILABLE',
    'The terminal-only role-context-sharing Grant replay is unavailable.',
    ExitCode.verification,
  );
}
