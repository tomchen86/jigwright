/** Binds the V2 workflows to actual observations, signer and durable publication. */
import crypto from 'node:crypto';
import { createMaintainerGrantV2Operations } from '../application/control-plane/maintainer-grant-v2.ts';
import { authorityTagPublishCommand } from '../adapters/remote/github/authority-relay-command.ts';
import { assertDisposableDatabaseForRepository } from '../adapters/consumer/repository/work-registry/database-policy.ts';
import { classifyProtectedCapabilityPaths } from '../adapters/consumer/repository/work-registry/protected-capabilities.ts';
import { createInteractiveSshSigner } from '../adapters/signing/ssh/maintainer-signer.ts';
import {
  discoverRepository,
  isPostApprovalAdmissionFailure,
} from '../runtime/repository-transaction/git.ts';
import {
  loadV2TrustContext,
  assertUnusedGrant,
  readRequiredRefGenerationLedger,
  readTargetRef,
  readPolicyContent,
  createMaintainerChecksEnvironmentDigest,
} from '../runtime/repository-observation/maintainer-grant-v2.ts';
import {
  readStoredImmutableCandidateBundle,
  assertStoredCandidateSupportingArtifacts,
} from '../runtime/storage-journal/maintainer-candidate-reader.ts';
import {
  createSignedMaintainerGrantPublisher,
  exactPublishedAuditTagObject,
  deleteExpectedAuditTag,
} from '../runtime/repository-transaction/maintainer-grant-v2-publication.ts';
import { createMaintainerAuditTag } from '../runtime/repository-transaction/maintainer-audit-tag.ts';
import { withRepositoryLifecycleOperation } from '../runtime/session-workspace/session-store.ts';
import {
  maintainerGrantStorePaths,
  storeCanonicalAvailableMaintainerGrantUnderLifecycleLock,
  terminallyFailSignedMaintainerGrantV2UnderLifecycleLock,
} from '../runtime/storage-journal/maintainer-store.ts';
import { enterActivePostApprovalTerminalCleanup } from '../runtime/repository-transaction/git.ts';
import type { CandidateDependencyObservations } from '../modules/authority/maintainer-candidate-dependencies.ts';
import type { MaintainerGrantExecutionServices } from '../application/control-plane/maintainer-grant-v2.ts';

export function createMaintainerGrantV2Production(
  candidateDependencies: CandidateDependencyObservations,
): MaintainerGrantExecutionServices {
  const grantOperations = createMaintainerGrantV2Operations({
    loadV2TrustContext,
    assertUnusedGrant,
    discoverRepository,
    currentChecksEnvironmentDigest: createMaintainerChecksEnvironmentDigest(
      (repositoryRoot, environment) =>
        assertDisposableDatabaseForRepository(repositoryRoot, environment)
          .identity,
    ),
    currentCandidateDependencySnapshot:
      candidateDependencies.currentCandidateDependencySnapshot,
    readStoredImmutableCandidateBundle,
    assertStoredCandidateSupportingArtifacts,
    readRequiredRefGenerationLedger,
    readTargetRef,
    readPolicyContent,
    protectedCapabilityPaths: (repositoryRoot, baseCommit, paths) =>
      classifyProtectedCapabilityPaths(repositoryRoot, baseCommit, paths)
        .protectedPaths,
    createInteractiveSshSigner,
    isPostApprovalAdmissionFailure,
    publishSignedMaintainerGrant: createSignedMaintainerGrantPublisher({
      withRepositoryLifecycleOperation,
      maintainerGrantStorePaths,
      createMaintainerAuditTag,
      storeCanonicalAvailableMaintainerGrantUnderLifecycleLock,
      terminallyFailSignedMaintainerGrantV2UnderLifecycleLock,
      isPostApprovalAdmissionFailure,
      enterActivePostApprovalTerminalCleanup,
      exactPublishedAuditTagObject,
      deleteExpectedAuditTag,
    }),
    authorityTagPublishCommand,
    currentTime: () => new Date(),
    randomGrantId: () => crypto.randomUUID(),
    currentEnvironment: () => process.env,
  });
  return {
    ...grantOperations,
    ...candidateDependencies,
    readStoredImmutableCandidateBundle,
    assertStoredCandidateSupportingArtifacts,
    storeCandidateSupportingArtifacts,
    storeCandidateHumanReadableSummary,
    storeImmutableCandidateBundle,
    ensureDurableRefGenerationLedger,
    readDurableRefGenerationLedger,
    recordDurableRefGenerationTransitionUnderLifecycleLock,
  };
}

import {
  storeCandidateSupportingArtifacts,
  storeCandidateHumanReadableSummary,
  storeImmutableCandidateBundle,
} from '../runtime/storage-journal/maintainer-candidate-writer.ts';
import {
  ensureDurableRefGenerationLedger,
  readDurableRefGenerationLedger,
  recordDurableRefGenerationTransitionUnderLifecycleLock,
} from '../runtime/storage-journal/maintainer-candidate-ref-ledger.ts';
