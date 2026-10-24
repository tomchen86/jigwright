import type { InvestigationEvidenceReplayer } from '../../modules/investigation/manifest/investigation-materializer.ts';
import {
  type ProposeExemptionSession,
  investigationV3SessionSnapshotDigest,
  investigationV3BuildFailure,
  reportProposeAssuranceAssessment,
} from '../../modules/proposal/propose-investigation-projections.ts';
import type {
  InvestigationV3Blocker,
  InvestigationManifestV3,
  InvestigationV3RoleResult,
  InvestigationAssuranceFacts,
} from '../../modules/investigation/manifest/investigation-manifest-types.ts';
import {
  buildInvestigationManifestDraft,
  sealInvestigationManifestDraft,
  validateForAuthority,
  createInvestigationV3Blocker,
} from '../../modules/investigation/manifest/investigation-manifest.ts';
import type { RoleContextSharingGrantOperations } from '../../modules/authority/role-context-sharing-grant.ts';
import type {
  RebuiltInvestigation,
  ProposeAssuranceAssessment,
} from '../../modules/proposal/propose-types.ts';
import {
  type BuildInvestigationManifestV3Result,
  buildInvestigationManifestV3,
} from '../../modules/investigation/manifest/investigation-manifest-builder.ts';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import type { AdmittedRoleResult } from '../../modules/provider-orchestration/role-admission-contracts.ts';
import { buildImplementationReconciliationRequirement } from '../../modules/why-knowledge/implementation-reconciliation.ts';
import { sha256 } from '../../modules/proposal/propose-values.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

type InvestigationManifestContext = Readonly<{
  git: Readonly<{ repositoryRoot: string }>;
  config: Readonly<{ repositoryName: string }>;
}>;

export function buildProposeExemptionInvestigationManifestV3(
  materializeInvestigationEvidenceView: InvestigationEvidenceReplayer,
  context: InvestigationManifestContext,
  session: ProposeExemptionSession,
  onBlocked?: (blocker: InvestigationV3Blocker) => never,
): InvestigationManifestV3 {
  const authoring = {
    sessionRevision: session.revision,
    sessionSnapshotDigest: investigationV3SessionSnapshotDigest(session),
  };
  const built = buildInvestigationManifestDraft(
    materializeInvestigationEvidenceView,
    {
      repositoryRoot: context.git.repositoryRoot,
      state: {
        schemaVersion: 1,
        applicabilityKind: 'exemption',
        repositoryId: context.config.repositoryName,
        changeId: session.changeId,
        investigationId: session.investigationId,
        normalizedIntent: session.intent,
        authoring,
        exemption: {
          category: session.applicability.category,
          baseline: {
            commitOid: session.baseline.head,
            treeOid: session.baseline.tree,
          },
          declaredPaths: session.applicability.declaredPaths,
          declaredChangeClasses: session.applicability.declaredChangeClasses,
          rationale: session.applicability.rationale,
          semanticAuthor: session.applicability.semanticAuthor,
          nonTrivialBehaviorReliance:
            session.applicability.nonTrivialBehaviorReliance,
          researchBudgetMinutes: session.applicability.researchBudgetMinutes,
        },
      },
    },
  );
  if (built.outcome !== 'built') {
    onBlocked?.(built.blocker);
    throw investigationV3BuildFailure(built.blocker);
  }
  const sealed = sealInvestigationManifestDraft({
    draft: built.draft,
    approval: {
      semanticAuthor: session.applicability.semanticAuthor,
      approvalProvenanceDigest: session.applicability.applicabilityDigest,
    },
  });
  if (sealed.outcome !== 'sealed') {
    onBlocked?.(sealed.blocker);
    throw investigationV3BuildFailure(sealed.blocker);
  }
  const verified = validateForAuthority(materializeInvestigationEvidenceView, {
    repositoryRoot: context.git.repositoryRoot,
    manifest: sealed.manifest,
    expected: {
      repositoryId: context.config.repositoryName,
      changeId: session.changeId,
      investigationId: session.investigationId,
      ...authoring,
    },
  });
  if (verified.outcome !== 'verified') {
    onBlocked?.(verified.blocker);
    throw investigationV3BuildFailure(verified.blocker);
  }
  return verified.manifest;
}

export function buildProposeInvestigationManifestV3(
  materializeInvestigationEvidenceView: InvestigationEvidenceReplayer,
  grants: Pick<
    RoleContextSharingGrantOperations,
    'canonicalRoleContextSharingGrantEnvelopeV1'
  >,
  context: InvestigationManifestContext,
  rebuilt: RebuiltInvestigation,
): BuildInvestigationManifestV3Result {
  const candidate = {
    repositoryId: context.config.repositoryName,
    changeId: rebuilt.session.changeId,
    investigationId: rebuilt.session.investigationId,
    sessionRevision: rebuilt.session.revision,
    sessionSnapshotDigest: investigationV3SessionSnapshotDigest(
      rebuilt.session,
    ),
  };
  try {
    if (
      rebuilt.v3Domain === null ||
      rebuilt.v3Domain.evidenceView === null ||
      rebuilt.planReviewCoverage === null ||
      rebuilt.assuranceAssessmentNode === null ||
      rebuilt.providerRoleResult === null ||
      rebuilt.whyAuthoring === null ||
      rebuilt.session.milestones.groupDispositions === null ||
      rebuilt.session.milestones.whyAnswers === null
    ) {
      throw workflowError(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'A sealed investigation lacks the raw/domain inputs required by the v3 Manifest.',
        ExitCode.guard,
      );
    }
    if (rebuilt.saturatedTermIds.length > 0) {
      // The old acknowledgement predates semantic author/rationale fields. A
      // Manifest may name the missing fact but must not invent it or let a local
      // continuation mechanism stand in for the central Grant contract.
      throw workflowError(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'The legacy scan-saturation acknowledgement has no v3 semantic author and rationale.',
        ExitCode.guard,
      );
    }
    const groupCheckpoint = rebuilt.session.milestones.groupDispositions;
    const whyCheckpoint = rebuilt.session.milestones.whyAnswers;
    if (
      groupCheckpoint.envelope.kind !== 'group-dispositions' ||
      whyCheckpoint.envelope.kind !== 'why-answers'
    ) {
      throw workflowError(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'Stored investigation checkpoints cannot be mapped to v3 semantic decisions.',
        ExitCode.guard,
      );
    }
    const dispositionDecisions = rebuilt.v3Domain.dispositionDecisions;
    const replayAuthoring = {
      baseline: {
        commitOid: rebuilt.session.baseline.head,
        treeOid: rebuilt.session.baseline.tree,
      },
      termContributions: rebuilt.v3Domain.termContributions,
      canonicalTerms: rebuilt.v3Domain.canonicalTerms,
      scanner: {
        allowSaturatedTerms: false,
        saturationDecision: null,
      },
      grouping: {
        mutationPolicy: rebuilt.v3Domain.mutationPolicy,
        declaredRoots: [{ rootId: 'repository', path: '' }],
        reviewedRelationships: rebuilt.v3Domain.reviewedRelationships,
      },
      semanticGroupDecisions: [],
      dispositionDecisions,
    };
    const whyAuthoring = rebuilt.whyAuthoring;
    const assessment = reportProposeAssuranceAssessment(
      rebuilt.assuranceAssessmentNode,
    );
    const assuranceFacts = investigationV3AssuranceFacts(assessment);
    const investigationRoleResults = [
      rebuilt.providerRoleResult,
      rebuilt.reviewerRoleResult,
    ]
      .filter((role): role is AdmittedRoleResult => role !== null)
      .map((role) => investigationV3RoleResult(grants, role));
    const semanticAuthorIds = [
      ...rebuilt.v3Domain.dispositionInputs.map(({ author }) => author.trim()),
      ...whyCheckpoint.envelope.payload.answers.map(({ semanticAuthor }) =>
        semanticAuthor.trim(),
      ),
    ].filter((value) => value.length > 0);
    const uniqueAuthors = [...new Set(semanticAuthorIds)].sort();
    if (uniqueAuthors.length === 0) {
      throw workflowError(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'Final investigation checkpoints identify no v3 author.',
        ExitCode.guard,
      );
    }
    const planReviewCoverage = rebuilt.planReviewCoverage;
    if (
      planReviewCoverage.schemaVersion !== 2 ||
      planReviewCoverage.activation !== 'global'
    ) {
      throw workflowError(
        'SEMANTIC_COMPLETENESS_FAILURE',
        'Investigation v3 requires the exact global PlanReview coverage requirement.',
        ExitCode.guard,
      );
    }
    const implementationReconciliation =
      buildImplementationReconciliationRequirement({
        changeId: rebuilt.session.changeId,
        baseline: rebuilt.session.baseline,
        intent: rebuilt.intent,
        whyOverlays: whyAuthoring.whyOverlays,
      });
    const requirementAuthor = {
      id: uniqueAuthors.join(', '),
      provenance: `final-checkpoints:${whyCheckpoint.envelopeDigest}`,
    };
    const investigationRequirements = [
      {
        kind: 'implementation-reconciliation-requirement' as const,
        requirementId: 'implementation-reconciliation',
        reconciliation: structuredClone(implementationReconciliation),
        semanticAuthor: requirementAuthor,
        provenanceDigest: sha256(
          canonicalJson({
            schema: 'investigation-v3-reconciliation-requirement.v1',
            reconciliation: implementationReconciliation,
          }),
        ),
      },
      {
        kind: 'plan-review-coverage-requirement' as const,
        requirementId: 'plan-review-coverage',
        coverage: structuredClone(planReviewCoverage),
        semanticAuthor: requirementAuthor,
        provenanceDigest: sha256(
          canonicalJson({
            schema: 'investigation-v3-plan-review-requirement.v1',
            coverage: planReviewCoverage,
          }),
        ),
      },
    ];
    const approvalProvenanceDigest = sha256(
      canonicalJson({
        schema: 'investigation-v3-approval-provenance.v1',
        groupCheckpoint: groupCheckpoint.envelopeDigest,
        whyCheckpoint: whyCheckpoint.envelopeDigest,
      }),
    );
    return buildInvestigationManifestV3(materializeInvestigationEvidenceView, {
      repositoryRoot: context.git.repositoryRoot,
      repositoryId: context.config.repositoryName,
      changeId: rebuilt.session.changeId,
      investigationId: rebuilt.session.investigationId,
      normalizedIntent: rebuilt.intent,
      authoring: {
        sessionRevision: rebuilt.session.revision,
        sessionSnapshotDigest: investigationV3SessionSnapshotDigest(
          rebuilt.session,
        ),
      },
      baseline: replayAuthoring.baseline,
      termContributions: rebuilt.v3Domain.termContributions,
      canonicalTerms: rebuilt.v3Domain.canonicalTerms,
      scanFacts: rebuilt.v3Domain.scanFacts,
      groupFacts: rebuilt.v3Domain.groupFacts,
      scanner: replayAuthoring.scanner,
      grouping: replayAuthoring.grouping,
      semanticGroupDecisions: [],
      dispositionDecisions,
      whyOverlays: whyAuthoring.whyOverlays,
      knowledgeReuseDecisions: whyAuthoring.knowledgeReuseDecisions,
      investigationRoleResults,
      floorOverflowDecision: rebuilt.floorOverflowDecision,
      exceptions: [],
      investigationRequirements,
      assuranceFacts,
      approval: {
        semanticAuthor: {
          id: uniqueAuthors.join(', '),
          provenance: `final-checkpoints:${approvalProvenanceDigest}`,
        },
        approvalProvenanceDigest,
      },
      expected: candidate,
    });
  } catch (error) {
    return {
      outcome: 'blocked',
      blocker: createInvestigationV3Blocker({
        attemptedTransition: 'build-draft',
        candidate,
        failureCode:
          error instanceof WorkflowError
            ? error.code
            : 'RECONSTRUCTION_MISMATCH',
        message:
          error instanceof Error
            ? error.message
            : 'Unknown v3 Manifest construction failure.',
      }),
    };
  }
}

function investigationV3RoleResult(
  grants: Pick<
    RoleContextSharingGrantOperations,
    'canonicalRoleContextSharingGrantEnvelopeV1'
  >,
  role: AdmittedRoleResult,
): InvestigationV3RoleResult {
  if (role.role !== 'plan-reviewer') {
    throw workflowError(
      'SEMANTIC_COMPLETENESS_FAILURE',
      'Non-investigation role cannot enter the Investigation v3 Manifest.',
      ExitCode.guard,
    );
  }
  const provider = role.providerInvocation;
  const grantUse =
    role.grantUse === null
      ? null
      : {
          kind: 'collaboration-grant-use-identity.v1' as const,
          grantId: role.grantUse.grantId,
          signedEnvelopeDigest: role.grantUse.signedEnvelopeDigest,
          transitionDigest: role.grantUse.transitionDigest,
        };
  const roleContextSharing = role.roleContextSharingUse ?? null;
  const roleContextSharingUse =
    roleContextSharing === null
      ? null
      : {
          kind: 'role-context-sharing-use-identity.v1' as const,
          grantId: roleContextSharing.grantId,
          signedEnvelopeDigest: sha256(
            grants.canonicalRoleContextSharingGrantEnvelopeV1(
              roleContextSharing.envelope,
            ),
          ),
          transitionDigest: roleContextSharing.expectedBinding.targetDigest,
          useProjectionDigest: roleContextSharing.useProjectionDigest,
          admissionDigest: roleContextSharing.use.admissionDigest,
        };
  const sanitizedProvenance = {
    schema: 'investigation-v3-role-provenance.v1',
    form: role.form,
    role: role.role,
    targetDigest: role.targetDigest,
    participant: role.participant,
    requiredIndependence: role.requiredIndependence,
    achievedIndependence: role.achievedIndependence,
    orchestration: role.orchestration,
    content: {
      kind: role.content.kind,
      outputSchema: role.content.outputSchema,
      evaluator: role.content.evaluator,
      policyDigest: role.content.policyDigest,
      contentDigest: role.content.contentDigest,
      current: role.content.current,
    },
    providerInvocation:
      provider === null
        ? null
        : {
            invocationId: provider.invocationId,
            requestDigest: provider.requestDigest,
            outputDigest: provider.outputDigest,
            providerId: provider.providerId,
            sessionId: provider.sessionId,
            targetDigest: provider.targetDigest,
            engineSpawned: provider.engineSpawned,
          },
  };
  return {
    role:
      role.content.kind === 'blind-survey'
        ? 'reviewer-pre-anchor'
        : 'investigation-reviewer',
    targetDigest: investigationV3BareDigest(role.targetDigest),
    providerId: role.participant.providerId,
    sessionId: role.participant.sessionId,
    principalId: role.participant.principalId,
    requiredIndependence: role.requiredIndependence,
    achievedIndependence: role.achievedIndependence,
    requestDigest:
      provider === null
        ? sha256(canonicalJson({ ...sanitizedProvenance, phase: 'request' }))
        : investigationV3BareDigest(provider.requestDigest),
    outputDigest:
      provider === null
        ? investigationV3BareDigest(role.content.contentDigest)
        : investigationV3BareDigest(provider.outputDigest),
    contentDigest: investigationV3BareDigest(role.content.contentDigest),
    policyDigest: investigationV3BareDigest(role.content.policyDigest),
    provenanceDigest: sha256(canonicalJson(sanitizedProvenance)),
    grantUse,
    roleContextSharingUse,
  };
}

function investigationV3AssuranceFacts(
  assessment: ProposeAssuranceAssessment,
): InvestigationAssuranceFacts {
  const {
    nodeId: _nodeId,
    resultDigest: _resultDigest,
    policyDigest,
    ...domainAssessment
  } = assessment;
  const assessmentDigest = sha256(
    canonicalJson({
      schema: 'investigation-v3-assurance-facts.v1',
      assessment: domainAssessment,
    }),
  );
  return {
    assessmentDigest,
    coverageTier: assessment.coverageTier,
    escalated: assessment.escalated,
    reasons: [...assessment.reasons],
    provenanceDigest: sha256(
      canonicalJson({
        schema: 'investigation-v3-assurance-provenance.v1',
        assessmentDigest,
        policyDigest: investigationV3BareDigest(policyDigest),
      }),
    ),
  };
}

function investigationV3BareDigest(value: string): string {
  if (/^[0-9a-f]{64}$/.test(value)) return value;
  if (/^sha256:[0-9a-f]{64}$/.test(value)) return value.slice(7);
  throw workflowError(
    'RECONSTRUCTION_MISMATCH',
    'An Investigation v3 provenance digest is malformed.',
    ExitCode.verification,
  );
}
