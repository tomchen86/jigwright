import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  bindingFromPayload,
  canonicalCollaborationGrantEnvelope,
  directHumanReviewAttestationDigest,
  parseCollaborationGrantEnvelope,
  type CollaborationGrantExpectedBinding,
} from '../authority/collaboration-grant.ts';
import type {
  ChangeContract,
  CurrentInvestigationManifest,
  PlanningAssuranceBinding,
  PlanningAssuranceSummary,
} from '../../adapters/consumer/repository/work-registry/contracts.ts';
import {
  isPlanningAssuranceBinding,
  repositoryCurrentSchemaName,
} from '../../adapters/consumer/repository/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertStoredEvidenceNode,
  type EvidenceNode,
} from '../../adapters/planning/investigation/evidence-node.ts';
import type {
  InvestigationManifestV3,
  InvestigationPlanReviewCoverageRequirementV3,
  InvestigationRequirementV3,
  InvestigationV3RoleResult,
} from '../investigation/manifest/investigation-manifest.ts';
import { validateInvestigationManifestLedgerProjection } from '../projection/investigation-design-projection.ts';
import {
  runGit,
  runGitBuffer,
} from '../../runtime/repository-transaction/git.ts';
import { agentRolePlanV2Path } from '../source/planning-role-policy-paths.ts';
import { readCurrentPlanningRoleOverridePolicy } from '../source/planning-role-provider-policy-reader.ts';
import { parseMaintainerPolicy } from '../authority/maintainer-policy.ts';
import {
  assertAuthorizedPlanReviewChallengeClosure,
  assertCurrentPlanReviewProviderResultNode,
  createPlanReviewSubject,
  PLAN_REVIEW_OUTPUT_SCHEMA,
  readPlanReviewTargetSnapshotNode,
  readPlanReviewNode,
  type PlanReviewTargetSnapshot,
  type PlanReviewSubject,
} from './plan-review.ts';
import { assertInvestigationPlanReviewCoverageRequirementSatisfied } from './plan-review-coverage.ts';
import {
  validatePlanReview,
  type PlanReviewPlanningEvidence,
  type PlanReviewRepositoryEvidence,
} from './plan-review-validation.ts';
import {
  createPlanTarget,
  type PlanTarget,
  type PlanTargetComponentInput,
} from './plan-target.ts';
import {
  createPlanningGeneration,
  type PlanningGeneration,
  type PlanningPolicyDigests,
} from '../lifecycle/planning-generation.ts';
import {
  assertAdmittedRoleResultRecord,
  admitConsumedRoleContextSharingResultReplay,
  admitConsumedRoleResultReplay,
  admitRoleResult,
  type AdmitConsumedRoleContextSharingResultReplayInput,
  type AdmitConsumedRoleResultReplayInput,
  type AdmittedRoleResult,
} from '../provider-orchestration/role-scheduler.ts';

const LEDGER_START = '<!-- workflow:investigation-ledger:start v1 -->';
const LEDGER_END = '<!-- workflow:investigation-ledger:end v1 -->';

export const INVESTIGATION_FIRST_PLANNING_POLICIES: PlanningPolicyDigests =
  Object.freeze({
    planningPolicyDigest: policyDigest('investigation-first-planning.v1'),
    canonicalizerPolicyDigest: policyDigest('plan-target.v1'),
    rendererPolicyDigest: policyDigest(
      'investigation-manifest-ledger-renderer.v3',
    ),
    reviewPolicyDigest: PLAN_REVIEW_OUTPUT_SCHEMA.digest,
  });

export type InvestigationFirstPlanningSubject = {
  manifest: InvestigationManifestV3;
  applicability: InvestigationManifestV3['applicability'];
  applicabilityNode: { nodeId: string; resultDigest: string };
  investigationRequirements: InvestigationRequirementV3[];
  target: PlanTarget;
  generation: PlanningGeneration;
  subject: PlanReviewSubject;
  policies: PlanningPolicyDigests;
};

export type InvestigationFirstPlanningAssuranceSummary =
  PlanningAssuranceSummary;

export type InvestigationFirstPlanningReadiness =
  InvestigationFirstPlanningSubject & {
    roleResult: AdmittedRoleResult;
    summary: InvestigationFirstPlanningAssuranceSummary;
  };

export type ConsumedRoleResultReplayInput = Readonly<{
  repositoryRoot: string;
  expectedBinding: CollaborationGrantExpectedBinding;
  grantUse: NonNullable<AdmittedRoleResult['grantUse']>;
  assignment: AdmittedRoleResult['assignment'];
  content: AdmittedRoleResult['content'];
  directHumanReviewAttestation: AdmittedRoleResult['directHumanReviewAttestation'];
}>;

/**
 * Authenticate one exact already-consumed role use without granting any
 * live reserve/consume or generic signature-verification authority. The proof
 * is opaque in practice: only the terminal store can mint a value accepted by
 * `admitConsumedRoleResultReplay`.
 */
export type ConsumedRoleResultReplayPort = Readonly<{
  verify(
    input: ConsumedRoleResultReplayInput,
  ): AdmitConsumedRoleResultReplayInput['replay'];
}>;

export type ConsumedPlanReviewReplayInput = ConsumedRoleResultReplayInput;
export type ConsumedRoleContextSharingReplayInput = Readonly<{
  repositoryRoot: string;
  evidence: NonNullable<AdmittedRoleResult['roleContextSharingUse']>;
  assignment: AdmittedRoleResult['assignment'];
  author: AdmittedRoleResult['author'];
  participant: AdmittedRoleResult['participant'];
  content: AdmittedRoleResult['content'];
  providerInvocation: NonNullable<AdmittedRoleResult['providerInvocation']>;
}>;
export type ConsumedPlanReviewReplayPort = ConsumedRoleResultReplayPort &
  Readonly<{
    verifyRoleContextSharing(
      input: ConsumedRoleContextSharingReplayInput,
    ): AdmitConsumedRoleContextSharingResultReplayInput['replay'];
  }>;

export type CurrentPlanReviewRoleResultReplayContext = Readonly<{
  repositoryRoot: string;
  changeId: string;
  baselineCommit: string;
  baselineTree: string;
  subjectDigest: string;
  planningGenerationId: string;
}>;

/**
 * Re-authenticate one persisted PlanReview role result against the terminal
 * Grant record before recovery or status code consumes its role facts. The
 * content-pure role reader remains the first boundary; grant-backed forms then
 * require the same opaque consumed-use replay used by planning readiness.
 */
export function replayCurrentPlanReviewRoleResult(
  storedValue: unknown,
  context: CurrentPlanReviewRoleResultReplayContext,
  consumedPlanReviewReplay?: ConsumedPlanReviewReplayPort,
): AdmittedRoleResult {
  let stored: AdmittedRoleResult;
  try {
    stored = assertAdmittedRoleResultRecord(storedValue);
  } catch {
    throw planningNotReady('Stored PlanReview role result is malformed.');
  }
  if (stored.form === 'granted-role-context-sharing') {
    const evidence = stored.roleContextSharingUse;
    const expected = evidence?.expectedBinding;
    if (
      consumedPlanReviewReplay === undefined ||
      evidence === null ||
      expected === undefined ||
      stored.providerInvocation === null ||
      expected.changeId !== context.changeId ||
      expected.baselineCommit !== context.baselineCommit ||
      expected.baselineTree !== context.baselineTree ||
      expected.subjectDigest !== context.subjectDigest ||
      expected.targetDigest !== context.subjectDigest ||
      expected.planningGeneration !== context.planningGenerationId ||
      expected.lifecyclePhase !== 'plan-review'
    ) {
      throw planningNotReady(
        'Role-context-sharing PlanReview is bound to another transition or has no terminal replay authority.',
      );
    }
    const replay = consumedPlanReviewReplay.verifyRoleContextSharing({
      repositoryRoot: context.repositoryRoot,
      evidence,
      assignment: stored.assignment,
      author: stored.author,
      participant: stored.participant,
      content: stored.content,
      providerInvocation: stored.providerInvocation,
    });
    if (
      replay.grantId !== evidence.grantId ||
      replay.terminalRecordDigest !== evidence.terminalRecordDigest ||
      replay.useProjectionDigest !== evidence.useProjectionDigest
    ) {
      throw planningNotReady(
        'Consumed role-context-sharing replay proof does not match the exact stored use.',
      );
    }
    const replayed = admitConsumedRoleContextSharingResultReplay({
      assignment: stored.assignment,
      author: stored.author,
      participant: stored.participant,
      content: stored.content,
      providerInvocation: stored.providerInvocation,
      replay,
    });
    if (canonicalJson(replayed) !== canonicalJson(stored)) {
      throw planningNotReady(
        'Stored PlanReview role result does not replay exactly.',
      );
    }
    return replayed;
  }
  let replayed: AdmittedRoleResult;
  if (stored.form === 'ordinary-provider') {
    if (
      stored.author.providerId === null ||
      stored.author.providerId === stored.assignment.providerId
    ) {
      throw planningNotReady(
        'Ordinary PlanReview must record a provider distinct from the plan author.',
      );
    }
    replayed = admitRoleResult({
      assignment: stored.assignment,
      author: stored.author,
      participant: stored.participant,
      content: stored.content,
      providerInvocation: stored.providerInvocation,
      grantUse: null,
      grantValidation: null,
    });
  } else {
    if (consumedPlanReviewReplay === undefined || !stored.grantUse) {
      throw planningNotReady(
        'Granted PlanReview role result has no terminal replay authority.',
      );
    }
    const envelope = parseCollaborationGrantEnvelope(
      canonicalCollaborationGrantEnvelope(stored.grantUse.envelope),
    );
    if (
      envelope.payload.changeId !== context.changeId ||
      envelope.payload.baselineCommit !== context.baselineCommit ||
      envelope.payload.baselineTree !== context.baselineTree ||
      envelope.payload.targetDigest !== context.subjectDigest ||
      envelope.payload.lifecyclePhase !== 'plan-review'
    ) {
      throw planningNotReady(
        'Granted PlanReview role result is bound to another transition.',
      );
    }
    const expectedBinding = bindingFromPayload(envelope.payload);
    const replay = consumedPlanReviewReplay.verify({
      repositoryRoot: context.repositoryRoot,
      expectedBinding,
      grantUse: stored.grantUse,
      assignment: stored.assignment,
      content: stored.content,
      directHumanReviewAttestation: stored.directHumanReviewAttestation,
    });
    if (
      replay.grantId !== stored.grantUse.grantId ||
      replay.transitionDigest !== stored.grantUse.transitionDigest ||
      replay.useDigest !== sha256(canonicalJson(stored.grantUse))
    ) {
      throw planningNotReady(
        'Consumed PlanReview replay proof does not match the exact stored grant use.',
      );
    }
    replayed = admitConsumedRoleResultReplay({
      assignment: stored.assignment,
      author: stored.author,
      participant: stored.participant,
      content: stored.content,
      providerInvocation: stored.providerInvocation,
      replay,
    });
  }
  if (canonicalJson(replayed) !== canonicalJson(stored)) {
    throw planningNotReady(
      'Stored PlanReview role result does not replay exactly.',
    );
  }
  return replayed;
}

/**
 * Derive the immutable exact-plan review subject from current tracked planning
 * artifacts. The PlanReview artifact itself is deliberately excluded, avoiding
 * a self-referential target; it is validated separately against this subject.
 */
export function deriveInvestigationFirstPlanningSubject(
  repositoryRoot: string,
  contract: ChangeContract,
): InvestigationFirstPlanningSubject {
  assertCurrentSubjectContract(repositoryRoot, contract);
  const currentInvestigation = contract.investigation!;
  const manifest = currentInvestigation.manifest;
  const applicability = manifest.applicability;
  const manifestDigest = currentInvestigation.validation.manifestDigest;
  const investigationTargetDigest =
    currentInvestigation.validation.investigationTargetDigest;
  if (
    manifest.manifestDigest !== manifestDigest ||
    manifest.investigationApproval.investigationTargetDigest !==
      investigationTargetDigest
  ) {
    throw planningNotReady(
      'Current Investigation Manifest validation identities are inconsistent.',
    );
  }
  const baseline = investigationBaselineFromManifest(manifest);
  const dependencies =
    investigationDependenciesFromManifest(currentInvestigation);
  const investigationRequirements =
    applicability.kind === 'ordinary'
      ? structuredClone(applicability.semanticDelta.investigationRequirements)
      : [];
  const policies = planningPoliciesFor(applicability);
  const target = createPlanningTarget(
    repositoryRoot,
    contract,
    manifest,
    policies,
  );
  const generation = createPlanningGeneration({
    schemaVersion: 1,
    target,
    manifestDigest,
    investigationTargetDigest,
    investigationBaseline: baseline,
    investigationDependencies: dependencies,
    investigationRequirements,
    policies,
  });
  const subject = createPlanReviewSubject({
    generation,
    reviewPolicyDigest: policies.reviewPolicyDigest,
    requiredIndependence: 'provider-independent',
  });
  return {
    manifest,
    applicability,
    applicabilityNode: {
      nodeId: manifestDigest,
      resultDigest: investigationTargetDigest,
    },
    investigationRequirements,
    target,
    generation,
    subject,
    policies,
  };
}

/**
 * Recompute v2 semantic readiness from the live artifacts. Advisory approval is
 * reported but never grants readiness: exact generation currentness, challenge
 * disposition, and a replayed ordinary or maintainer-granted role admission are
 * the governing gates.
 */
export function validateInvestigationFirstPlanningReadiness(
  repositoryRoot: string,
  contract: ChangeContract,
  consumedPlanReviewReplay: ConsumedPlanReviewReplayPort,
): InvestigationFirstPlanningReadiness {
  assertCurrentContract(repositoryRoot, contract);
  const context = deriveInvestigationFirstPlanningSubject(
    repositoryRoot,
    contract,
  );
  const planReview = contract.planReview!;
  const reviewNode = requireNode(
    planReview.nodes,
    planReview.currentRefs.planReview,
    'plan review',
  );
  const review = readPlanReviewNode(reviewNode);
  const providerResultNode = requireNode(
    planReview.nodes,
    review.providerResultNodeId,
    'plan review provider result',
  );
  if (providerResultNode.resultDigest !== review.providerResultResultDigest) {
    throw planningNotReady(
      'PlanReview does not select the exact provider result it reviewed.',
    );
  }
  const roleResult = requireCurrentPlanReviewRoleResult(
    repositoryRoot,
    contract,
    providerResultNode,
    context.subject,
    consumedPlanReviewReplay,
  );
  try {
    assertCurrentPlanReviewProviderResultNode(
      providerResultNode,
      roleResult.providerInvocation,
      roleResult.content,
      reviewNode.exactInputDigests.submission,
    );
  } catch {
    throw planningNotReady(
      'PlanReview provider evidence is not current and invocation-bound.',
    );
  }
  const snapshotNode = requireNode(
    planReview.nodes,
    providerResultNode.provenanceParentNodeIds.targetSnapshot,
    'plan review target snapshot',
  );
  const planningSnapshot = readPlanReviewTargetSnapshotNode(snapshotNode);
  if (
    providerResultNode.exactInputDigests.targetSnapshot !==
      snapshotNode.nodeId ||
    providerResultNode.semanticParentResultDigests.targetSnapshot !==
      snapshotNode.resultDigest ||
    snapshotNode.policyDigest !== review.policyDigest ||
    planningSnapshot.changeId !== contract.changeId ||
    planningSnapshot.subjectDigest !== context.subject.subjectDigest ||
    planningSnapshot.planningGenerationId !==
      context.generation.planningGenerationId ||
    planningSnapshot.planTargetDigest !== context.target.targetDigest
  ) {
    throw planningNotReady(
      'PlanReview target snapshot does not match the current planning subject.',
    );
  }
  const dispositionNodeId = planReview.currentRefs.planReviewDisposition;
  const dispositionNode = dispositionNodeId
    ? requireNode(
        planReview.nodes,
        dispositionNodeId,
        'plan review disposition',
      )
    : null;
  const coverageRequirements = context.investigationRequirements.filter(
    (
      requirement,
    ): requirement is InvestigationPlanReviewCoverageRequirementV3 =>
      requirement.kind === 'plan-review-coverage-requirement',
  );
  if (coverageRequirements.length > 1) {
    throw planningNotReady(
      'Investigation contains more than one engine-owned PlanReview coverage requirement.',
    );
  }
  const coverageRequirement = coverageRequirements[0] ?? null;
  if (coverageRequirement !== null && review.findings.length > 0) {
    if (dispositionNode === null) {
      throw planningNotReady(
        'Global review challenges require an authenticated closure.',
      );
    }
    const authorId =
      roleResult.author.principalId ?? roleResult.author.providerId;
    if (authorId === null) {
      throw planningNotReady(
        'The reviewed plan has no authenticated author identity.',
      );
    }
    const policy = loadMaintainerPolicyAtCommit(
      repositoryRoot,
      context.generation.investigationBaseline.head,
    );
    assertAuthorizedPlanReviewChallengeClosure({
      dispositionNode,
      reviewNode,
      expected: {
        repositoryId: policy.repository.id,
        changeId: contract.changeId,
        investigationId: coverageRequirement.coverage.investigationId,
        baselineCommit: context.generation.investigationBaseline.head,
        baselineTree: context.generation.investigationBaseline.tree,
        subjectDigest: context.subject.subjectDigest,
        planningGenerationId: context.generation.planningGenerationId,
        authorId,
      },
      policy,
    });
  }
  const validation = validatePlanReview({
    reviewNode,
    providerResultNode,
    dispositionNode,
    subject: context.subject,
    generation: context.generation,
    target: context.target,
    expectedReviewPolicyDigest: context.policies.reviewPolicyDigest,
    requiredIndependence: 'provider-independent',
    independenceAuthorization: {
      kind: 'admitted-role-result',
      roleResult,
    },
    repositoryEvidence: resolvePlanReviewRepositoryEvidence(
      repositoryRoot,
      context.generation.investigationBaseline.tree,
      reviewNode,
      planningSnapshot,
    ),
    planningTarget: planningSnapshot,
    planningEvidence: resolvePlanReviewPlanningEvidence(
      repositoryRoot,
      planningSnapshot,
      reviewNode,
    ),
  });
  if (!validation.eligible) {
    throw workflowError(
      'OPENSPEC_CHANGE_NOT_READY',
      'Investigation-first PlanReview is stale, undispositioned, or unauthorized.',
      ExitCode.verification,
      {
        details: {
          staleReasons: validation.staleReasons,
          undispositionedChallengeIds: validation.undispositionedChallengeIds,
        },
      },
    );
  }
  if (coverageRequirement !== null) {
    if (context.applicability.kind !== 'ordinary') {
      throw planningNotReady(
        'PlanReview coverage requirement belongs only to an ordinary Investigation Manifest.',
      );
    }
    assertInvestigationPlanReviewCoverageRequirementSatisfied({
      repositoryRoot,
      requirement: coverageRequirement,
      review,
      expectedInvestigationId: context.manifest.investigationId,
      expectedChangeId: contract.changeId,
      expectedBaseline: context.generation.investigationBaseline,
    });
  }
  const summary: InvestigationFirstPlanningAssuranceSummary = {
    applicabilityKind:
      context.applicability.kind === 'ordinary'
        ? 'sealed-investigation'
        : 'investigation-exemption',
    applicabilityDigest:
      context.applicability.kind === 'ordinary'
        ? context.generation.investigationTargetDigest
        : context.applicability.applicabilityDigest,
    applicabilityNodeId: context.applicabilityNode.nodeId,
    investigationBaseline: { ...context.generation.investigationBaseline },
    planningGenerationId: context.generation.planningGenerationId,
    planTargetDigest: context.target.targetDigest,
    reviewNodeId: review.nodeId,
    reviewResultDigest: review.resultDigest,
    reviewDispositionNodeId: dispositionNode?.nodeId ?? null,
    reviewRoleResultDigest: roleResult.resultDigest,
    reviewRoleResultForm: roleResult.form,
    reviewOrchestration: roleResult.orchestration,
    requiredIndependence: 'provider-independent',
    achievedIndependence: roleResult.achievedIndependence,
    degradationAuthorized: validation.degradationAuthorized,
    advisoryVerdict: validation.advisoryVerdict,
  };
  return { ...context, roleResult, summary };
}

export function createTaskPlanningAssuranceBinding(
  contract: ChangeContract,
  summary: InvestigationFirstPlanningAssuranceSummary | null,
): PlanningAssuranceBinding | null {
  if (summary === null) return null;
  const matches = (contract.planReview?.roleResults ?? []).filter(
    (candidate) =>
      isPlainRecord(candidate) &&
      candidate.resultDigest === summary.reviewRoleResultDigest,
  );
  if (matches.length !== 1) {
    throw planningNotReady(
      'Task lifecycle cannot resolve the exact admitted PlanReview role result.',
    );
  }
  const roleResult = matches[0] as unknown as AdmittedRoleResult;
  const binding: PlanningAssuranceBinding = {
    ...summary,
    reviewGrantId: roleResult.grantUse?.grantId ?? null,
    reviewGrantEnvelopeDigest:
      roleResult.grantUse?.signedEnvelopeDigest ?? null,
    reviewGrantUseDigest: roleResult.grantUse
      ? sha256(canonicalJson(roleResult.grantUse))
      : null,
    reviewGrantTransitionDigest: roleResult.grantUse?.transitionDigest ?? null,
    directHumanReviewAttestationDigest: roleResult.directHumanReviewAttestation
      ? directHumanReviewAttestationDigest(
          roleResult.directHumanReviewAttestation,
        )
      : null,
  };
  if (!isPlanningAssuranceBinding(binding)) {
    throw planningNotReady(
      'Task lifecycle planning assurance references are inconsistent.',
    );
  }
  return binding;
}

/**
 * One deterministic, content-pure planning-assurance interface over a canonical
 * subject, policy, and immutable evidence artifacts. The evaluator receives a
 * deep-frozen canonical snapshot in which object insertion order is normalized
 * and every artifact's runtime-only metadata is erased to `{}`, so live and CI
 * loaders that construct the same content observe byte/digest-identical results.
 * The evaluator's result is detached, canonicalized, and frozen before it is
 * digested or returned. Both identities are bound to the validator version and
 * observe no timestamps, process state, provider calls, filesystem, or Git.
 */
export type PlanningAssuranceInput = {
  subject: unknown;
  policy: unknown;
  artifacts: Record<string, EvidenceNode>;
};

export type PlanningAssuranceValidator = {
  version: string;
  evaluate(input: PlanningAssuranceInput): unknown;
};

export type PlanningAssuranceResult = {
  result: unknown;
  inputDigest: string;
  resultDigest: string;
  validatorVersion: string;
};

export function evaluatePlanningAssurance(
  input: PlanningAssuranceInput,
  validator: PlanningAssuranceValidator,
): PlanningAssuranceResult {
  // Read identity exactly once before evaluator code runs. A mutable validator
  // object or accessor must not split input, result, and reported identities.
  const validatorVersion = validator.version;
  if (typeof validatorVersion !== 'string' || validatorVersion.length === 0) {
    throw planningValidatorInvalid();
  }

  // Re-validate every consumed envelope with the recomputation contract, then
  // erase runtime-only metadata so it never influences semantics or the digest.
  const artifacts: Record<string, unknown> = {};
  for (const key of Object.keys(input.artifacts)) {
    const node = assertStoredEvidenceNode(
      input.artifacts[key],
      planningInvalid,
    );
    artifacts[key] = { ...node, runtimeMetadata: {} };
  }

  const evaluatorInput = deepFreeze(
    canonicalClone({
      subject: input.subject,
      policy: input.policy,
      artifacts,
    }),
  ) as PlanningAssuranceInput;

  const inputDigest = sha256(
    canonicalJson({
      validatorVersion,
      input: evaluatorInput,
    }),
  );

  const result = deepFreeze(canonicalClone(validator.evaluate(evaluatorInput)));
  const resultDigest = sha256(canonicalJson({ validatorVersion, result }));

  return {
    result,
    inputDigest,
    resultDigest,
    validatorVersion,
  };
}

function assertCurrentContract(
  repositoryRoot: string,
  contract: ChangeContract,
): asserts contract is ChangeContract & {
  investigation: NonNullable<ChangeContract['investigation']>;
  execution: NonNullable<ChangeContract['execution']>;
  planReview: NonNullable<ChangeContract['planReview']>;
} {
  const currentSchemaName = repositoryCurrentSchemaName(repositoryRoot);
  if (
    contract.schemaName !== currentSchemaName ||
    !contract.investigation ||
    !contract.execution ||
    !contract.planReview
  ) {
    throw planningNotReady('Investigation-first artifacts are incomplete.');
  }
}

function assertCurrentSubjectContract(
  repositoryRoot: string,
  contract: ChangeContract,
): asserts contract is ChangeContract & {
  investigation: NonNullable<ChangeContract['investigation']>;
  execution: NonNullable<ChangeContract['execution']>;
} {
  const currentSchemaName = repositoryCurrentSchemaName(repositoryRoot);
  if (
    contract.schemaName !== currentSchemaName ||
    !contract.investigation ||
    !contract.execution
  ) {
    throw planningNotReady(
      'Investigation-first draft artifacts are incomplete.',
    );
  }
}

function requireNode(
  nodes: EvidenceNode[],
  nodeId: string | undefined,
  label: string,
): EvidenceNode {
  if (typeof nodeId !== 'string') {
    throw planningNotReady(`Current ${label} evidence is not selected.`);
  }
  const matches = nodes.filter((node) => node.nodeId === nodeId);
  if (matches.length !== 1) {
    throw planningNotReady(`Current ${label} evidence is unavailable.`);
  }
  return assertStoredEvidenceNode(matches[0]!, planningInvalid);
}

function investigationBaselineFromManifest(manifest: InvestigationManifestV3): {
  head: string;
  tree: string;
} {
  const baseline =
    manifest.applicability.kind === 'ordinary'
      ? manifest.applicability.replayContract.baseline
      : manifest.applicability.baseline;
  return { head: baseline.commitOid, tree: baseline.treeOid };
}

function investigationDependenciesFromManifest(
  current: CurrentInvestigationManifest,
): Array<{ role: string; nodeId: string; resultDigest: string }> {
  const dependencies = [
    {
      role: 'investigation-manifest',
      nodeId: current.validation.manifestDigest,
      resultDigest: current.validation.investigationTargetDigest,
    },
  ];
  if (current.manifest.applicability.kind === 'ordinary') {
    for (const roleResult of current.manifest.applicability.semanticDelta
      .investigationRoleResults) {
      dependencies.push(planningInvestigationRoleResultDependency(roleResult));
    }
  }
  return dependencies;
}

export function planningInvestigationRoleResultDependency(
  roleResult: InvestigationV3RoleResult,
): { role: string; nodeId: string; resultDigest: string } {
  return {
    role: roleResult.role,
    nodeId: roleResult.requestDigest,
    resultDigest: sha256(
      canonicalJson({
        schema: 'investigation-role-result-dependency.v3',
        roleResult,
      }),
    ),
  };
}

function createPlanningTarget(
  repositoryRoot: string,
  contract: ChangeContract & {
    investigation: NonNullable<ChangeContract['investigation']>;
    execution: NonNullable<ChangeContract['execution']>;
  },
  manifest: InvestigationManifestV3,
  policies: PlanningPolicyDigests,
): PlanTarget {
  const changeRoot = relative(repositoryRoot, contract.changeDirectory);
  const read = (name: string) =>
    fs.readFileSync(path.join(contract.changeDirectory, name), 'utf8');
  const design = read('design.md');
  const designProjection = designComponentProjection(
    design,
    manifest,
    policies.rendererPolicyDigest,
  );
  const specPaths = contract.artifactPaths
    .map((filePath) => relative(repositoryRoot, filePath))
    .filter(
      (filePath) =>
        filePath.startsWith(`${changeRoot}/specs/`) &&
        filePath.endsWith('/spec.md'),
    )
    .sort();
  const components: PlanTargetComponentInput[] = [
    {
      kind: 'structured-json',
      role: 'schema-metadata',
      path: `${changeRoot}/.openspec.yaml`,
      schemaDigest: policyDigest(`openspec-metadata.${contract.schemaName}.v1`),
      value: { schema: contract.schemaName },
    },
    {
      kind: 'authored-markdown',
      role: 'proposal',
      path: `${changeRoot}/proposal.md`,
      content: read('proposal.md'),
    },
    {
      kind: 'mixed-markdown',
      role: 'design',
      path: `${changeRoot}/design.md`,
      ...designProjection,
    },
    {
      kind: 'tasks-markdown',
      role: 'tasks',
      path: `${changeRoot}/tasks.md`,
      content: read('tasks.md'),
    },
    {
      kind: 'structured-json',
      role: 'guard',
      path: `${changeRoot}/guard.json`,
      schemaDigest: digestFile(
        repositoryRoot,
        'workflow/schemas/guard.schema.json',
      ),
      value: contract.guard,
    },
    {
      kind: 'structured-json',
      role: 'execution',
      path: `${changeRoot}/execution.json`,
      schemaDigest: digestFile(
        repositoryRoot,
        'workflow/schemas/execution-artifact.schema.json',
      ),
      value: contract.execution,
    },
    {
      kind: 'structured-json',
      role: 'investigation',
      path: `${changeRoot}/investigation.json`,
      schemaDigest: digestFile(
        repositoryRoot,
        'workflow/schemas/investigation-manifest-v3.schema.json',
      ),
      value: manifest,
    },
  ];
  for (const specPath of specPaths) {
    const content = fs.readFileSync(
      path.join(repositoryRoot, specPath),
      'utf8',
    );
    components.push({
      kind: 'authored-markdown',
      role: 'delta-spec',
      path: specPath,
      content,
    });
    for (const clause of requirementClauses(content)) {
      components.push({
        kind: 'requirement-clause',
        role: 'requirement-clause',
        path: specPath,
        requirement: clause.requirement,
        scenario: clause.scenario,
        content: clause.content,
      });
    }
  }
  const rendererPolicy =
    manifest.applicability.kind === 'exemption'
      ? {
          path: 'workflow/investigation-exemption-no-ledger.v1',
          name: 'investigation-exemption-no-ledger',
        }
      : {
          path: 'workflow/investigation-manifest-ledger-renderer.v3',
          name: 'investigation-manifest-ledger-renderer-v3',
        };
  const overridePath = agentRolePlanV2Path(contract.changeId);
  const override = readCurrentPlanningRoleOverridePolicy(
    repositoryRoot,
    contract.changeId,
  );
  if (override !== null) {
    components.push(
      policyComponent(overridePath, 'agent-role-plan', override.planDigest, 2),
    );
  }
  components.push(
    policyComponent(
      'workflow/planning-policy.v1',
      'investigation-first-planning',
      INVESTIGATION_FIRST_PLANNING_POLICIES.planningPolicyDigest,
    ),
    policyComponent(
      'workflow/plan-target-canonicalizer.v1',
      'plan-target-canonicalizer',
      INVESTIGATION_FIRST_PLANNING_POLICIES.canonicalizerPolicyDigest,
    ),
    policyComponent(
      rendererPolicy.path,
      rendererPolicy.name,
      policies.rendererPolicyDigest,
    ),
    policyComponent(
      'workflow/plan-review-policy.v2',
      'plan-review-policy',
      INVESTIGATION_FIRST_PLANNING_POLICIES.reviewPolicyDigest,
      2,
    ),
  );
  return createPlanTarget({
    schemaVersion: 1,
    changeId: contract.changeId,
    schemaName: contract.schemaName,
    components,
  });
}

function designComponentProjection(
  design: string,
  manifest: InvestigationManifestV3,
  rendererPolicyDigest: string,
): Pick<
  Extract<PlanTargetComponentInput, { kind: 'mixed-markdown' }>,
  'authoredRegions' | 'managedProjection'
> {
  if (manifest.applicability.kind === 'exemption') {
    return {
      authoredRegions: [design],
      managedProjection: {
        renderer: 'investigation-exemption-no-ledger.v1',
        rendererDigest: rendererPolicyDigest,
        sourceNodes: [
          {
            nodeId: manifest.manifestDigest,
            resultDigest:
              manifest.investigationApproval.investigationTargetDigest,
          },
        ],
      },
    };
  }
  const whyOverlays = manifest.applicability.semanticDelta.whyOverlays;
  if (whyOverlays.length === 0) {
    throw planningNotReady(
      'Ordinary Investigation Manifest has no WHY overlays for the managed design ledger.',
    );
  }
  validateInvestigationManifestLedgerProjection(design, whyOverlays);
  const start = design.indexOf(LEDGER_START);
  const end = design.indexOf(LEDGER_END, start + LEDGER_START.length);
  if (start < 0 || end < 0) {
    throw planningNotReady('Managed design ledger markers are unavailable.');
  }
  return {
    authoredRegions: [
      design.slice(0, start),
      design.slice(end + LEDGER_END.length),
    ],
    managedProjection: {
      renderer: 'investigation-manifest-ledger-renderer.v3',
      rendererDigest: rendererPolicyDigest,
      sourceNodes: whyOverlays.map((overlay) => ({
        nodeId: sha256(
          canonicalJson({
            schema: 'investigation-why-overlay-identity.v3',
            overlayId: overlay.overlayId,
            pathIdentity: overlay.pathIdentity,
          }),
        ),
        resultDigest: sha256(
          canonicalJson({ schema: 'investigation-why-overlay.v3', overlay }),
        ),
      })),
    },
  };
}

function planningPoliciesFor(
  applicability: InvestigationManifestV3['applicability'],
): PlanningPolicyDigests {
  if (applicability.kind === 'ordinary') {
    return INVESTIGATION_FIRST_PLANNING_POLICIES;
  }
  return Object.freeze({
    ...INVESTIGATION_FIRST_PLANNING_POLICIES,
    rendererPolicyDigest: policyDigest('investigation-exemption-no-ledger.v1'),
  });
}

function requirementClauses(content: string): Array<{
  requirement: string;
  scenario: string;
  content: string;
}> {
  const lines = content.split('\n');
  const clauses: Array<{
    requirement: string;
    scenario: string;
    content: string;
  }> = [];
  let requirement: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const requirementMatch = /^### Requirement: (.+)$/.exec(lines[index]!);
    if (requirementMatch) {
      requirement = requirementMatch[1]!;
      continue;
    }
    const scenarioMatch = /^#### Scenario: (.+)$/.exec(lines[index]!);
    if (!scenarioMatch || requirement === null) continue;
    let end = index + 1;
    while (end < lines.length && !/^#{1,4} /.test(lines[end]!)) end += 1;
    clauses.push({
      requirement,
      scenario: scenarioMatch[1]!,
      content: lines.slice(index, end).join('\n'),
    });
  }
  if (clauses.length === 0) {
    throw planningNotReady(
      'Delta specifications contain no canonical requirement scenarios.',
    );
  }
  return clauses;
}

function policyComponent(
  componentPath: string,
  name: string,
  digest: string,
  version = 1,
): PlanTargetComponentInput {
  return {
    kind: 'policy',
    role: 'policy',
    path: componentPath,
    name,
    version,
    digest,
  };
}

function requireCurrentPlanReviewRoleResult(
  repositoryRoot: string,
  contract: ChangeContract,
  providerResultNode: EvidenceNode,
  subject: PlanReviewSubject,
  consumedPlanReviewReplay: ConsumedPlanReviewReplayPort,
): AdmittedRoleResult {
  const candidates = contract.planReview?.roleResults ?? [];
  const matches = candidates.filter((candidate) => {
    if (!isPlainRecord(candidate) || !isPlainRecord(candidate.content)) {
      return false;
    }
    return (
      candidate.role === 'plan-reviewer' &&
      candidate.targetDigest === subject.subjectDigest &&
      candidate.content.nodeId === providerResultNode.nodeId &&
      candidate.content.resultDigest === providerResultNode.resultDigest
    );
  });
  if (matches.length !== 1) {
    throw planningNotReady(
      'Exactly one admitted role result must authorize the current PlanReview.',
    );
  }
  return replayCurrentPlanReviewRoleResult(
    matches[0],
    {
      repositoryRoot,
      changeId: contract.changeId,
      baselineCommit: subject.investigationBaseline.head,
      baselineTree: subject.investigationBaseline.tree,
      subjectDigest: subject.subjectDigest,
      planningGenerationId: subject.planningGenerationId,
    },
    consumedPlanReviewReplay,
  );
}

export function resolvePlanReviewRepositoryEvidence(
  repositoryRoot: string,
  tree: string,
  reviewNode: EvidenceNode,
  planningSnapshot?: PlanReviewTargetSnapshot,
): PlanReviewRepositoryEvidence {
  const review = readPlanReviewNode(reviewNode);
  const citations = [
    ...review.findings.flatMap((finding) => finding.evidence),
    ...review.suggestions.flatMap((suggestion) => suggestion.evidence),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ];
  const paths = [
    ...new Set(
      citations
        .filter(
          (
            citation,
          ): citation is Extract<
            (typeof citations)[number],
            { kind: 'repository-location' }
          > => citation.kind === 'repository-location',
        )
        .map((citation) => citation.path),
    ),
  ].sort(compareUtf8);
  const planningPaths = new Set(
    planningSnapshot?.artifacts.map(({ path }) => path) ?? [],
  );
  return {
    tree,
    locations: paths.map((repositoryPath) => {
      if (planningPaths.has(repositoryPath)) {
        throw planningNotReady(
          'PlanReview cites a planning snapshot path through the repository namespace.',
        );
      }
      const listing = runGit(repositoryRoot, [
        'ls-tree',
        '-z',
        tree,
        '--',
        `:(literal)${repositoryPath}`,
      ]);
      const match = /^100\d{3} blob ([0-9a-f]{40,64})\t/.exec(listing);
      if (!match) {
        throw planningNotReady(
          'PlanReview cites a path absent from its investigation baseline.',
        );
      }
      const content = runGit(repositoryRoot, [
        'show',
        `${tree}:${repositoryPath}`,
      ]);
      return {
        path: repositoryPath,
        blobOid: match[1]!,
        lineCount:
          content.length === 0
            ? 0
            : content.endsWith('\n')
              ? content.slice(0, -1).split('\n').length
              : content.split('\n').length,
      };
    }),
  };
}

export function resolvePlanReviewPlanningEvidence(
  repositoryRoot: string,
  snapshot: PlanReviewTargetSnapshot,
  reviewNode: EvidenceNode,
): PlanReviewPlanningEvidence {
  const review = readPlanReviewNode(reviewNode);
  const citedPaths = [
    ...review.findings.flatMap((finding) => finding.evidence),
    ...review.suggestions.flatMap((suggestion) => suggestion.evidence),
    ...(review.scopeAssessment.kind === 'no-challenge'
      ? review.scopeAssessment.evidence
      : []),
  ]
    .filter(
      (
        citation,
      ): citation is Extract<
        (typeof review.findings)[number]['evidence'][number],
        { kind: 'planning-location' }
      > => citation.kind === 'planning-location',
    )
    .map(({ path: planningPath }) => planningPath);
  const uniquePaths = [...new Set(citedPaths)].sort(compareUtf8);
  const artifacts = new Map(
    snapshot.artifacts.map((artifact) => [artifact.path, artifact]),
  );
  const resolved = new Map<
    string,
    PlanReviewPlanningEvidence['locations'][number]
  >();
  const snapshotCommit = resolvePlanReviewSnapshotCommit(
    repositoryRoot,
    snapshot,
  );
  for (const artifact of snapshot.artifacts) {
    const content =
      snapshotCommit === null
        ? readCurrentPlanningTarget(repositoryRoot, artifact.path)
        : readCommittedPlanningTarget(
            repositoryRoot,
            snapshotCommit,
            artifact.path,
          );
    const digest = crypto.createHash('sha256').update(content).digest('hex');
    const lineCount =
      content.length === 0
        ? 0
        : content.at(-1) === 0x0a
          ? content.toString('utf8').slice(0, -1).split('\n').length
          : content.toString('utf8').split('\n').length;
    if (
      digest !== artifact.sha256 ||
      content.byteLength !== artifact.byteLength ||
      lineCount !== artifact.lineCount
    ) {
      throw planningNotReady(
        'Current planning bytes differ from the reviewed target snapshot.',
      );
    }
    resolved.set(artifact.path, {
      path: artifact.path,
      sha256: digest,
      byteLength: content.byteLength,
      lineCount,
    });
  }
  const locations = uniquePaths.map((planningPath) => {
    const location = resolved.get(planningPath);
    if (!location || !artifacts.has(planningPath)) {
      throw planningNotReady(
        'PlanReview cites a path absent from its planning target snapshot.',
      );
    }
    return location;
  });
  return {
    snapshotDigest: snapshot.snapshotDigest,
    locations,
  };
}

function resolvePlanReviewSnapshotCommit(
  repositoryRoot: string,
  snapshot: PlanReviewTargetSnapshot,
): string | null {
  const metadataPaths = snapshot.artifacts
    .map(({ path: artifactPath }) => artifactPath)
    .filter((artifactPath) => artifactPath.endsWith('/.openspec.yaml'));
  if (metadataPaths.length !== 1) {
    throw planningNotReady(
      'PlanReview target snapshot does not identify one planning root.',
    );
  }
  const changePrefix = path.posix.dirname(metadataPaths[0]!);
  if (
    snapshot.artifacts.some(
      ({ path: artifactPath }) =>
        artifactPath !== changePrefix &&
        !artifactPath.startsWith(`${changePrefix}/`),
    )
  ) {
    throw planningNotReady(
      'PlanReview target snapshot crosses planning roots.',
    );
  }
  const planReviewPath = `${changePrefix}/plan-review.json`;
  const listing = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    'HEAD',
    '--',
    `:(literal)${planReviewPath}`,
  ]);
  const match = /^(100644) blob [0-9a-f]{40,64}\t([^\0]+)\0$/.exec(listing);
  if (!match || match[2] !== planReviewPath) return null;

  const absolutePath = path.join(repositoryRoot, planReviewPath);
  const stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (!stats) {
    // The committed review has been withdrawn from the worktree — an
    // amendment returning the graph to review-pending. Absence is "no
    // committed review applies", exactly like current bytes that differ; only
    // a file that exists in an unsafe shape is refused.
    return null;
  }
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o644
  ) {
    throw planningNotReady(
      'PlanReview artifact is not a regular mode-0644 file.',
    );
  }
  const current = fs.readFileSync(absolutePath);
  const committed = runGitBuffer(repositoryRoot, [
    'show',
    `HEAD:${planReviewPath}`,
  ]);
  if (!current.equals(committed)) return null;

  const commit = runGit(repositoryRoot, [
    'log',
    '-1',
    '--format=%H',
    'HEAD',
    '--',
    `:(literal)${planReviewPath}`,
  ]).trim();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw planningNotReady(
      'Committed PlanReview target snapshot origin is not resolvable.',
    );
  }
  const origin = runGitBuffer(repositoryRoot, [
    'show',
    `${commit}:${planReviewPath}`,
  ]);
  if (!origin.equals(committed)) {
    throw planningNotReady(
      'Committed PlanReview target snapshot origin is ambiguous.',
    );
  }
  return commit;
}

function readCurrentPlanningTarget(
  repositoryRoot: string,
  artifactPath: string,
): Buffer {
  const absolutePath = path.join(repositoryRoot, artifactPath);
  const stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o644
  ) {
    throw planningNotReady(
      'PlanReview planning evidence is not a regular mode-0644 file.',
    );
  }
  return fs.readFileSync(absolutePath);
}

function readCommittedPlanningTarget(
  repositoryRoot: string,
  commit: string,
  artifactPath: string,
): Buffer {
  const listing = runGit(repositoryRoot, [
    'ls-tree',
    '-z',
    commit,
    '--',
    `:(literal)${artifactPath}`,
  ]);
  const match = /^(100644) blob [0-9a-f]{40,64}\t([^\0]+)\0$/.exec(listing);
  if (!match || match[2] !== artifactPath) {
    throw planningNotReady(
      'Committed PlanReview planning evidence is not an exact mode-100644 blob.',
    );
  }
  return runGitBuffer(repositoryRoot, ['show', `${commit}:${artifactPath}`]);
}

function loadMaintainerPolicyAtCommit(
  repositoryRoot: string,
  commit: string,
): ReturnType<typeof parseMaintainerPolicy> {
  let value: unknown;
  try {
    value = JSON.parse(
      runGit(repositoryRoot, [
        'show',
        `${commit}:workflow/maintainer-policy.json`,
      ]),
    );
  } catch (error) {
    throw planningNotReady(
      `The baseline maintainer policy cannot be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return parseMaintainerPolicy(value);
}

function digestFile(repositoryRoot: string, filePath: string): string {
  return sha256(fs.readFileSync(path.join(repositoryRoot, filePath), 'utf8'));
}

function policyDigest(identity: string): string {
  return sha256(canonicalJson({ policy: identity }));
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function relative(repositoryRoot: string, filePath: string): string {
  return path.relative(repositoryRoot, filePath).split(path.sep).join('/');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function planningNotReady(message: string) {
  return workflowError(
    'OPENSPEC_CHANGE_NOT_READY',
    message,
    ExitCode.verification,
  );
}

function canonicalClone<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function planningInvalid() {
  return workflowError(
    'PLANNING_ASSURANCE_ARTIFACT_INVALID',
    'Planning assurance artifact is not a valid evidence node.',
    ExitCode.usage,
  );
}

function planningValidatorInvalid() {
  return workflowError(
    'PLANNING_ASSURANCE_VALIDATOR_INVALID',
    'Planning assurance validator identity is malformed.',
    ExitCode.usage,
  );
}
