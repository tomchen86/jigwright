import { authorityApplicationReceipts } from './authority-application-receipt-production.ts';
import type { ArchiveEligibilityReplayServices } from '../modules/assurance/commit-replay/ci-archive.ts';
import { createTaskExecutionGenerationReader } from '../runtime/repository-validation/commit-replay/task-execution-evidence.ts';
/** Binds immutable commit replay to the selected providers and repository services. */
import { createCiPlanningReplay } from '../runtime/repository-validation/commit-replay/ci-planning.ts';
import { createCiArchiveReplay } from '../runtime/repository-validation/commit-replay/ci-archive.ts';
import { createCiAuthorityReplay } from '../runtime/repository-validation/commit-replay/ci-authority.ts';
import { createCiHistoricalReplay } from '../runtime/repository-validation/commit-replay/ci-historical-contract.ts';
import { createCiSequenceReplay } from '../runtime/repository-validation/commit-replay/ci-sequence.ts';
import { openSpecPlanningPathPolicy } from '../adapters/planning/openspec/documents/planning-path-policy.ts';
import { readSystemSpecDeltaInputs } from '../adapters/planning/openspec/documents/system-spec-deltas.ts';
import { validateHandoffForChange as validateHandoff } from '../adapters/consumer/repository/handoff/handoff.ts';
import { productionChangeRoutingInspector } from './change-routing-observation-production.ts';
import {
  loadChangeContract,
  loadCommittedChangeContract,
} from './consumer-contract-production.ts';
import { productionPlanningAssurance } from './planning-assurance-production.ts';
import { productionConsumedPlanReviewReplayPort } from './grant-verifier-composition.ts';
import { parsePlanReviewArtifact } from './plan-review-artifact-production.ts';
import { validateForAuthority } from './investigation-production.ts';
import {
  createArchiveApplicabilityProjection,
  archiveReconciliationTimestamp,
  refreshArchiveManagedHandoff,
} from '../application/archive/archive-transformation.ts';
import {
  loadCommittedPlanningDocumentProjection,
  resolveHistoricalOpenSpecPlanningTransitionBinding,
  resolveHistoricalOpenSpecProviderBinding,
} from './planning-provider-production.ts';
import { createRepositorySpecificationPolicy } from '../modules/lifecycle/repository-specification-policy.ts';
import { renderHandoffFromTrackedFacts } from './handoff-production.ts';
import { reconcileArchivedWorkItems } from './work-registry-production.ts';
import { createOpenSpecPlanningArchiveProjectionPort } from './planning-archive-projection-production.ts';
import {
  verifySshDataSignature,
  verifyTrustedCommitSignature,
} from '../adapters/signing/ssh/ci-signature.ts';

export const ciPlanningReplay = createCiPlanningReplay({
  planningPaths: openSpecPlanningPathPolicy,
  validateHandoffForChange: validateHandoff.bind(
    undefined,
    productionChangeRoutingInspector,
    loadChangeContract,
  ),
  productionPlanningAssurance,
  productionConsumedPlanReviewReplayPort,
  parsePlanReviewArtifact,
  validateForAuthority,
  createArchiveApplicabilityProjection,
  loadCommittedPlanningDocumentProjection,
  resolveHistoricalOpenSpecPlanningTransitionBinding,
  resolveHistoricalOpenSpecProviderBinding,
});
export const ciArchiveReplay = createCiArchiveReplay({
  collectHistoricalCollaborationGrantUses:
    ciPlanningReplay.collectHistoricalCollaborationGrantUses,
  resolveHistoricalPlanningProviderForCi:
    ciPlanningReplay.resolveHistoricalPlanningProviderForCi,
  readSystemSpecDeltaInputs,
  createRepositorySpecificationPolicy,
  loadCommittedChangeContract,
  archiveReconciliationTimestamp,
  refreshArchiveManagedHandoff: refreshArchiveManagedHandoff.bind(
    undefined,
    renderHandoffFromTrackedFacts,
  ),
  reconcileArchivedWorkItems,
  createOpenSpecPlanningArchiveProjectionPort,
});
export const ciAuthorityReplay = createCiAuthorityReplay({
  authorityApplicationReceipts,
  verifySshDataSignature,
  verifyTrustedCommitSignature,
});
export const ciHistoricalReplay = createCiHistoricalReplay({
  validateCiPlanningCommit: ciPlanningReplay.validateCiPlanningCommit,
});
export const ciSequenceReplay = createCiSequenceReplay({
  validateCiPlanningCommit: ciPlanningReplay.validateCiPlanningCommit,
  validateCiArchiveCommit: ciArchiveReplay.validateCiArchiveCommit,
  validateCiAuthorityCommit: ciAuthorityReplay.validateCiAuthorityCommit,
  loadHistoricalTaskAuthority: ciHistoricalReplay.loadHistoricalTaskAuthority,
});

export const {
  resolveHistoricalPlanningProviderForCi,
  collectHistoricalCollaborationGrantUses,
  validateCiPlanningCommit,
  collectCurrentCollaborationGrantUses,
} = ciPlanningReplay;
export const { validateCiArchiveCommit } = ciArchiveReplay;
export const { validateCiAuthorityCommit } = ciAuthorityReplay;
export const { loadHistoricalTaskAuthority } = ciHistoricalReplay;
export const { replayCommitSequence } = ciSequenceReplay;

export const resolveTaskExecutionGenerationEvidence =
  createTaskExecutionGenerationReader({
    validateCiPlanningCommit,
    replayCommitSequence,
  });

export const archiveEligibilityReplayServices: ArchiveEligibilityReplayServices =
  {
    planningReplay: ciPlanningReplay,
    taskExecutionGeneration: resolveTaskExecutionGenerationEvidence,
  };
