/**
 * Derives planning subjects and validates investigation-first planning
 * readiness.
 *
 * Invariants:
 * - A PlanReview must select the exact provider result it reviewed.
 */
import {
  requireCurrentPlanReviewRoleResult,
  resolvePlanReviewPlanningEvidence,
  resolvePlanReviewRepositoryEvidence,
} from './planning-assurance-evidence.ts';
import type { PlanningAssuranceDependencies } from './planning-assurance-observations.ts';
import {
  isPlainRecord,
  planningNotReady,
  sha256,
} from './planning-assurance-values.ts';
export {
  replayCurrentPlanReviewRoleResult,
  resolvePlanReviewPlanningEvidence,
  resolvePlanReviewRepositoryEvidence,
} from './planning-assurance-evidence.ts';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import type {
  ChangeContract,
  CurrentInvestigationManifest,
} from '../planning-provider/change-contract.ts';
import type {
  PlanningAssuranceBinding,
  PlanningAssuranceSummary,
} from './planning-assurance-binding.ts';
import { isPlanningAssuranceBinding } from './planning-assurance-binding.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertStoredEvidenceNode,
  type EvidenceNode,
} from '../../foundation/evidence-node/evidence-node.ts';
import type {
  InvestigationManifestV3,
  InvestigationV3RoleResult,
} from '../investigation/manifest/investigation-manifest-types.ts';
import type {
  InvestigationPlanReviewCoverageRequirementV3,
  InvestigationRequirementV3,
} from '../investigation/manifest/investigation-requirement-types.ts';
import { validateInvestigationManifestLedgerProjection } from '../investigation/domain/investigation-design-ledger.ts';
import { agentRolePlanV2Path } from '../source/planning-role-policy-paths.ts';
import {
  assertCurrentPlanningRoleOverridePolicy,
  type CurrentPlanningRoleOverridePolicy,
} from '../provider-orchestration/planning-role-provider-policy.ts';

import {
  assertAuthorizedPlanReviewChallengeClosure,
  assertCurrentPlanReviewProviderResultNode,
  createPlanReviewSubject,
  PLAN_REVIEW_OUTPUT_SCHEMA,
  readPlanReviewTargetSnapshotNode,
  readPlanReviewNode,
} from './plan-review.ts';
import type { PlanReviewSubject } from './plan-review-subject.ts';
import { assertInvestigationPlanReviewCoverageRequirementSatisfied } from './plan-review-coverage.ts';
import { validatePlanReview } from './plan-review-validation.ts';
import {
  createPlanTarget,
  type PlanTarget,
  type PlanTargetComponentInput,
} from './plan-target.ts';
import { createPlanningGeneration } from './planning-generation.ts';
import type {
  PlanningGeneration,
  PlanningPolicyDigests,
} from './planning-generation-record.ts';
import {
  type AdmittedRoleResult,
  type ConsumedRoleReplayPort,
} from '../provider-orchestration/role-admission-contracts.ts';

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

export type CurrentPlanReviewRoleResultReplayContext = Readonly<{
  repositoryRoot: string;
  changeId: string;
  baselineCommit: string;
  baselineTree: string;
  subjectDigest: string;
  planningGenerationId: string;
}>;

/**
 * Derive the immutable exact-plan review subject from current tracked planning
 * artifacts. The PlanReview artifact itself is deliberately excluded, avoiding
 * a self-referential target; it is validated separately against this subject.
 */
export function deriveInvestigationFirstPlanningSubject(
  observations: PlanningAssuranceDependencies,
  repositoryRoot: string,
  contract: ChangeContract,
  planningRoleOverride: CurrentPlanningRoleOverridePolicy | null,
): InvestigationFirstPlanningSubject {
  assertCurrentSubjectContract(observations, repositoryRoot, contract);
  const override = assertCurrentPlanningRoleOverridePolicy(
    planningRoleOverride,
    contract.changeId,
  );
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
    observations,
    repositoryRoot,
    contract,
    manifest,
    policies,
    override,
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
    requiredIndependence: 'session-independent',
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
  observations: PlanningAssuranceDependencies,
  repositoryRoot: string,
  contract: ChangeContract,
  consumedPlanReviewReplay: ConsumedRoleReplayPort,
  planningRoleOverride: CurrentPlanningRoleOverridePolicy | null,
): InvestigationFirstPlanningReadiness {
  assertCurrentContract(observations, repositoryRoot, contract);
  const context = deriveInvestigationFirstPlanningSubject(
    observations,
    repositoryRoot,
    contract,
    planningRoleOverride,
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
    observations,
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
    const policy = observations.loadMaintainerPolicyAtCommit(
      repositoryRoot,
      context.generation.investigationBaseline.head,
    );
    assertAuthorizedPlanReviewChallengeClosure(
      observations.verifyChallengeClosureSignature,
      {
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
      },
    );
  }
  const validation = validatePlanReview({
    reviewNode,
    providerResultNode,
    dispositionNode,
    subject: context.subject,
    generation: context.generation,
    target: context.target,
    expectedReviewPolicyDigest: context.policies.reviewPolicyDigest,
    requiredIndependence: roleResult.requiredIndependence,
    independenceAuthorization: {
      kind: 'admitted-role-result',
      roleResult,
    },
    repositoryEvidence: resolvePlanReviewRepositoryEvidence(
      observations,
      repositoryRoot,
      context.generation.investigationBaseline.tree,
      reviewNode,
      planningSnapshot,
    ),
    planningTarget: planningSnapshot,
    planningEvidence: resolvePlanReviewPlanningEvidence(
      observations,
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
    assertInvestigationPlanReviewCoverageRequirementSatisfied(
      observations.readCoverageTarget,
      {
        repositoryRoot,
        requirement: coverageRequirement,
        review,
        expectedInvestigationId: context.manifest.investigationId,
        expectedChangeId: contract.changeId,
        expectedBaseline: context.generation.investigationBaseline,
      },
    );
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
    requiredIndependence: roleResult.requiredIndependence,
    achievedIndependence: roleResult.achievedIndependence,
    degradationAuthorized: validation.degradationAuthorized,
    advisoryVerdict: validation.advisoryVerdict,
  };
  return { ...context, roleResult, summary };
}

export function createTaskPlanningAssuranceBinding(
  grantCodec: PlanningAssuranceDependencies['grantCodec'],
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
      ? grantCodec.directHumanReviewAttestationDigest(
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
  observations: PlanningAssuranceDependencies,
  repositoryRoot: string,
  contract: ChangeContract,
): asserts contract is ChangeContract & {
  investigation: NonNullable<ChangeContract['investigation']>;
  execution: NonNullable<ChangeContract['execution']>;
  planReview: NonNullable<ChangeContract['planReview']>;
} {
  const currentSchemaName = observations.readCurrentSchema(repositoryRoot);
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
  observations: PlanningAssuranceDependencies,
  repositoryRoot: string,
  contract: ChangeContract,
): asserts contract is ChangeContract & {
  investigation: NonNullable<ChangeContract['investigation']>;
  execution: NonNullable<ChangeContract['execution']>;
} {
  const currentSchemaName = observations.readCurrentSchema(repositoryRoot);
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
  observations: PlanningAssuranceDependencies,
  repositoryRoot: string,
  contract: ChangeContract & {
    investigation: NonNullable<ChangeContract['investigation']>;
    execution: NonNullable<ChangeContract['execution']>;
  },
  manifest: InvestigationManifestV3,
  policies: PlanningPolicyDigests,
  override: CurrentPlanningRoleOverridePolicy | null,
): PlanTarget {
  const changeRoot = relative(repositoryRoot, contract.changeDirectory);
  const read = (name: string) =>
    observations.readPlanningArtifact(repositoryRoot, `${changeRoot}/${name}`);
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
      schemaDigest: observations.readPlanningSchemaDigest(
        repositoryRoot,
        'workflow/schemas/guard.schema.json',
      ),
      value: contract.guard,
    },
    {
      kind: 'structured-json',
      role: 'execution',
      path: `${changeRoot}/execution.json`,
      schemaDigest: observations.readPlanningSchemaDigest(
        repositoryRoot,
        'workflow/schemas/execution-artifact.schema.json',
      ),
      value: contract.execution,
    },
    {
      kind: 'structured-json',
      role: 'investigation',
      path: `${changeRoot}/investigation.json`,
      schemaDigest: observations.readPlanningSchemaDigest(
        repositoryRoot,
        'workflow/schemas/investigation-manifest-v3.schema.json',
      ),
      value: manifest,
    },
  ];
  for (const specPath of specPaths) {
    const content = observations.readPlanningArtifact(repositoryRoot, specPath);
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

function policyDigest(identity: string): string {
  return sha256(canonicalJson({ policy: identity }));
}

function relative(repositoryRoot: string, filePath: string): string {
  return path.relative(repositoryRoot, filePath).split(path.sep).join('/');
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

export type { ChangeContract, EvidenceNode };
