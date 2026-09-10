/**
 * Defines PlanReview submission grammar, normalization, and evidence
 * parsing.
 *
 * Invariants:
 * - Provider submissions must carry exactly the provider-facing submission
 *   fields.
 */
import {
  sha256,
  deepFreeze,
  isRecord,
  hasExactKeys,
  isDigest,
} from './plan-review-values.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { normalizeInvestigationTerm } from '../investigation/domain/investigation-terms.ts';
import type { InvestigationTermKind } from '../investigation/domain/investigation-terms.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { WorkflowError } from '../../foundation/errors/errors.ts';
import type {
  PlanReviewSubmissionProtocolBindings,
  PlanReviewSubmission,
  NormalizedSubmission,
  PlanReviewVerdict,
  NormalizedFinding,
  PlanReviewFinding,
  NormalizedSuggestion,
  PlanReviewSubject,
  PlanReviewScopeAssessment,
  PlanReviewProposedTerm,
  PlanReviewEvidence,
  PlanReviewSeverity,
} from './plan-review.ts';

export function createPlanReviewSubmissionProtocol(
  bindings: PlanReviewSubmissionProtocolBindings,
) {
  const { normalizeExactRepositoryPath } = bindings;

  const PLAN_REVIEW_TYPE = 'plan-review';

  const PLAN_REVIEW_SCHEMA = 'plan-review.v2';

  const PLAN_REVIEW_EVALUATOR = 'plan-review.v2';

  const PLAN_REVIEW_OUTPUT_SCHEMA_ID = 'plan-review-output.v3';

  const PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID = 'plan-review-node-output.v2';

  const PROVIDER_RESULT_TYPE = 'plan-review-provider-result';

  const PROVIDER_RESULT_SCHEMA = 'plan-review-provider-result.v3';

  const PROVIDER_RESULT_EVALUATOR = 'plan-review-provider-result.v3';

  const PROVIDER_RESULT_OUTPUT_SCHEMA = 'plan-review-provider-result-output.v3';

  const DISPOSITION_TYPE = 'plan-review-disposition';

  const DISPOSITION_SCHEMA = 'plan-review-disposition.v1';

  const DISPOSITION_EVALUATOR = 'plan-review-disposition.v1';

  const DISPOSITION_OUTPUT_SCHEMA = 'plan-review-disposition-output.v1';

  const AUTHORIZED_DISPOSITION_SCHEMA = 'plan-review-disposition.v2';

  const AUTHORIZED_DISPOSITION_EVALUATOR = 'plan-review-disposition.v2';

  const AUTHORIZED_DISPOSITION_OUTPUT_SCHEMA =
    'plan-review-disposition-output.v2';

  const PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE =
    'jigwright.plan-review-challenge-closure.v1';

  const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

  const PLAN_REVIEW_MAX_PROPOSED_TERMS = 256;

  const PLAN_REVIEW_LIMITS = Object.freeze({
    maxFindings: 128,
    maxSuggestions: 128,
    maxProposedTerms: PLAN_REVIEW_MAX_PROPOSED_TERMS,
    maxEvidencePerEntry: 64,
    maxInvestigationDependencies: 4096,
    maxSummaryBytes: 16 * 1024,
    maxObservationBytes: 16 * 1024,
    maxResidualRiskBytes: 16 * 1024,
    maxUncertaintyBytes: 16 * 1024,
    maxDispositionRationaleBytes: 16 * 1024,
    maxAuthorBytes: 1024,
    maxRepositoryPathBytes: 4096,
  });

  /**
   * The fixed scope-and-depth challenge surface a single exact-plan review must
   * cover. A submission attests the complete set; a missing area is incomplete
   * coverage and fails closed. It doubles as the allowed challenge category set.
   */
  const PLAN_REVIEW_COVERAGE = Object.freeze([
    'missing-scope',
    'missing-consumers',
    'weak-why',
    'unsupported-invariants',
    'contradictory-artifacts',
    'task-strategy-risks',
    'additional-search-terms',
  ] as const);

  const COVERAGE_SET: ReadonlySet<string> = new Set<string>(
    PLAN_REVIEW_COVERAGE,
  );

  const FOLLOWUP_CATEGORIES: ReadonlySet<string> = new Set(['follow-up']);

  const VERDICTS: ReadonlySet<string> = new Set([
    'advisory-approve',
    'advisory-reject',
  ]);

  const SEVERITIES: ReadonlySet<string> = new Set([
    'critical',
    'high',
    'medium',
    'low',
    'informational',
  ]);

  const TERM_KINDS: ReadonlySet<string> = new Set([
    'literal-content',
    'literal-path',
    'symbol',
    'config-key',
  ]);

  const EVIDENCE_KINDS = [
    'planning-location',
    'repository-location',
    'investigation-node',
    'survey-record',
    'investigation-role-result',
  ] as const;

  const DISPOSITION_DECISIONS: ReadonlySet<string> = new Set([
    'mitigated',
    'rejected',
    'accepted',
  ]);

  const AUTHORIZED_DISPOSITION_DECISIONS: ReadonlySet<string> = new Set([
    'accepted',
    'rebutted',
    'superseded',
    'withdrawn',
    'waived',
  ]);

  const INDEPENDENCE_DIMENSIONS: ReadonlySet<string> = new Set([
    'provider-independent',
    'principal-independent',
    'session-independent',
    'none',
  ]);

  const SUBMISSION_KEYS = [
    'schemaVersion',
    'verdict',
    'coverage',
    'scopeAssessment',
    'findings',
    'proposedTerms',
    'suggestions',
    'residualRisk',
    'uncertainty',
  ] as const;

  /**
   * What a provider actually authors. Everything else in a submission is derived
   * by the engine: the schema version and the complete coverage list are engine
   * constants, `scopeAssessment.kind` is a function of the finding categories,
   * and each finding's `kind`/`currentChangeImpact` follow from the array it was
   * submitted in. Asking a provider to restate a value the engine already knows
   * only creates a place for the two to disagree, and a disagreement over a
   * derived field used to discard an otherwise usable review.
   */
  const PROVIDER_SUBMISSION_KEYS = [
    'verdict',
    'scopeEvidence',
    'findings',
    'proposedTerms',
    'suggestions',
    'residualRisk',
    'uncertainty',
  ] as const;

  const OUTPUT_KEYS = [
    'schemaVersion',
    'planningGenerationId',
    'planTargetDigest',
    'subjectDigest',
    'assignment',
    'verdict',
    'coverage',
    'scopeAssessment',
    'findings',
    'suggestions',
    'proposedTerms',
    'residualRisk',
    'uncertainty',
    'requiredIndependence',
    'achievedIndependence',
  ] as const;

  const SUBJECT_KEYS = [
    'schemaVersion',
    'subjectDigest',
    'planningGenerationId',
    'planTargetDigest',
    'manifestDigest',
    'investigationTargetDigest',
    'reviewPolicyDigest',
    'requiredIndependence',
    'investigationBaseline',
    'investigationDependencies',
    'investigationRequirements',
  ] as const;

  const PROVIDER_RESULT_OUTPUT_KEYS = [
    'schemaVersion',
    'subjectDigest',
    'assignment',
    'request',
    'result',
  ] as const;

  const ROLE_ASSIGNMENT_KEYS = [
    'role',
    'providerId',
    'sessionId',
    'targetDigest',
    'requiredIndependence',
    'achievedIndependence',
  ] as const;

  const PLAN_REVIEW_SCHEMA_GRAMMAR = {
    schema: 'plan-review-output-grammar.v2',
    id: PLAN_REVIEW_OUTPUT_SCHEMA_ID,
    version: 2,
    submissionKeys: [...PROVIDER_SUBMISSION_KEYS],
    canonicalSubmissionKeys: [...SUBMISSION_KEYS],
    storedOutputKeys: [...OUTPUT_KEYS],
    subjectKeys: [...SUBJECT_KEYS],
    roleAssignmentKeys: [...ROLE_ASSIGNMENT_KEYS],
    providerResult: {
      type: PROVIDER_RESULT_TYPE,
      nodeSchema: PROVIDER_RESULT_SCHEMA,
      evaluator: PROVIDER_RESULT_EVALUATOR,
      outputSchema: PROVIDER_RESULT_OUTPUT_SCHEMA,
      outputKeys: [...PROVIDER_RESULT_OUTPUT_KEYS],
      exactInputRoles: [
        'assignment',
        'output',
        'request',
        'runtimeObservation',
        'subject',
        'targetSnapshot',
      ],
      semanticParentRoles: ['targetSnapshot'],
      provenanceParentRoles: ['targetSnapshot'],
    },
    reviewNode: {
      type: PLAN_REVIEW_TYPE,
      nodeSchema: PLAN_REVIEW_SCHEMA,
      evaluator: PLAN_REVIEW_EVALUATOR,
      outputSchema: PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID,
      exactInputRoles: ['assignment', 'subject', 'submission'],
      semanticParentRoles: ['providerResult'],
      provenanceParentRoles: ['providerResult'],
    },
    coverage: [...PLAN_REVIEW_COVERAGE],
    verdicts: [...VERDICTS],
    challenge: {
      submissionKeys: ['severity', 'category', 'summary', 'evidence'],
      storedKeys: [
        'findingId',
        'kind',
        'severity',
        'category',
        'currentChangeImpact',
        'summary',
        'evidence',
      ],
      categories: [...PLAN_REVIEW_COVERAGE],
      impact: 'required',
    },
    suggestion: {
      submissionKeys: ['severity', 'summary', 'evidence'],
      storedKeys: [
        'suggestionId',
        'kind',
        'severity',
        'category',
        'currentChangeImpact',
        'summary',
        'evidence',
      ],
      categories: [...FOLLOWUP_CATEGORIES],
      impact: 'independent-follow-up',
    },
    scopeAssessment: {
      challengesKeys: ['kind'],
      noChallengeKeys: ['kind', 'evidence'],
      requiredScopeChallengeCategories: ['missing-consumers', 'missing-scope'],
      derivedFromFindingCategories: true,
      providerKey: 'scopeEvidence',
    },
    evidence: {
      kinds: [...EVIDENCE_KINDS],
      repositoryLocationKeys: ['kind', 'line', 'observation', 'path'],
      graphKeys: ['kind', 'nodeId', 'resultDigest'],
    },
    proposedTermKeys: ['kind', 'value'],
    termKinds: [...TERM_KINDS],
    disposition: {
      entryKeys: ['author', 'challengeId', 'decision', 'rationale'],
      decisions: [...DISPOSITION_DECISIONS],
      outputKeys: ['schemaVersion', 'dispositions'],
      exactInputRoles: ['dispositions'],
      semanticParentRoles: ['review'],
      provenanceParentRoles: ['review'],
    },
    independenceDimensions: [...INDEPENDENCE_DIMENSIONS],
    severities: [...SEVERITIES],
    limits: PLAN_REVIEW_LIMITS,
  } as const;

  const PLAN_REVIEW_GRAMMAR_DIGEST = sha256(
    canonicalJson(PLAN_REVIEW_SCHEMA_GRAMMAR),
  );

  /**
   * The provider-facing JSON Schema. It asks only for what a reviewer actually
   * authors; the engine fills in the schema version, the complete coverage list,
   * the scope-assessment kind, and every constant discriminator before the
   * canonical validator runs, so a provider has no derived field to contradict.
   * Its comment binds the stricter code-owned semantic grammar (finding/category
   * pairings, sorted uniqueness, and evidence rules) that JSON Schema alone
   * cannot express.
   *
   * The shape is additionally constrained by what a structured-output endpoint
   * accepts: `oneOf` is rejected outright, a `const` must carry a sibling `type`,
   * and `uniqueItems` is not permitted. Both unions here are discriminated by an
   * exclusive `kind`, so `anyOf` is equivalent, and coverage uniqueness is
   * enforced by `assertCoverage` rather than by the wire schema.
   *
   * Provider CLIs infer their supported dialect. The canonical schema therefore
   * omits an external `$schema` URI so request identity, runtime bytes, provider
   * input, and native validation remain exact while avoiding a pre-launch resolver
   * failure.
   */
  const PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA = Object.freeze({
    $comment: `workflow-semantic-grammar-sha256:${PLAN_REVIEW_GRAMMAR_DIGEST}`,
    type: 'object',
    additionalProperties: false,
    required: [...PROVIDER_SUBMISSION_KEYS],
    properties: {
      verdict: { enum: [...VERDICTS] },
      scopeEvidence: {
        type: 'array',
        minItems: 1,
        items: { $ref: '#/$defs/evidence' },
      },
      findings: {
        type: 'array',
        maxItems: PLAN_REVIEW_LIMITS.maxFindings,
        items: { $ref: '#/$defs/finding' },
      },
      proposedTerms: {
        type: 'array',
        maxItems: PLAN_REVIEW_LIMITS.maxProposedTerms,
        items: { $ref: '#/$defs/term' },
      },
      suggestions: {
        type: 'array',
        maxItems: PLAN_REVIEW_LIMITS.maxSuggestions,
        items: { $ref: '#/$defs/suggestion' },
      },
      residualRisk: { type: 'string', minLength: 1 },
      uncertainty: { type: 'string', minLength: 1 },
    },
    $defs: {
      evidence: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'path', 'line', 'observation'],
            properties: {
              kind: {
                enum: ['planning-location', 'repository-location'],
              },
              path: { type: 'string', minLength: 1 },
              line: { type: 'integer', minimum: 1 },
              observation: { type: 'string', minLength: 1 },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'nodeId', 'resultDigest'],
            properties: {
              kind: { enum: ['investigation-node', 'survey-record'] },
              nodeId: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              resultDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'role', 'requestDigest', 'resultDigest'],
            properties: {
              kind: { enum: ['investigation-role-result'] },
              role: { enum: ['reviewer-pre-anchor', 'investigation-reviewer'] },
              requestDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              resultDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            },
          },
        ],
      },
      finding: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'category', 'summary', 'evidence'],
        properties: {
          severity: { enum: [...SEVERITIES] },
          category: { enum: [...PLAN_REVIEW_COVERAGE] },
          summary: { type: 'string', minLength: 1 },
          evidence: {
            type: 'array',
            minItems: 1,
            items: { $ref: '#/$defs/evidence' },
          },
        },
      },
      suggestion: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'summary', 'evidence'],
        properties: {
          severity: { enum: [...SEVERITIES] },
          summary: { type: 'string', minLength: 1 },
          evidence: { type: 'array', items: { $ref: '#/$defs/evidence' } },
        },
      },
      term: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'value'],
        properties: {
          kind: { enum: [...TERM_KINDS] },
          value: { type: 'string', minLength: 1 },
        },
      },
    },
  });

  const PLAN_REVIEW_OUTPUT_DIGEST = sha256(
    canonicalJson(PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA),
  );

  /**
   * The code-owned schema identity for a plan-review provider submission. The
   * digest binds the fixed coverage set, verdict values, evidence kinds, and term
   * kinds so the accepted output grammar is reviewed and replayed rather than
   * driven by an external policy file.
   */
  const PLAN_REVIEW_OUTPUT_SCHEMA = Object.freeze({
    id: PLAN_REVIEW_OUTPUT_SCHEMA_ID,
    version: 3,
    digest: PLAN_REVIEW_OUTPUT_DIGEST,
  });

  /**
   * The bound validator for a plan-review submission. It accepts only a strictly
   * shaped submission — exact keys, complete coverage, evidence-bound findings,
   * and enumerated terms — and returns a literal boolean so a generic semantic
   * action (an unknown proposal key) is rejected rather than admitted.
   */
  const PLAN_REVIEW_OUTPUT_VALIDATOR = Object.freeze({
    id: PLAN_REVIEW_OUTPUT_SCHEMA_ID,
    version: 3,
    digest: PLAN_REVIEW_OUTPUT_DIGEST,
    validate(value: unknown): boolean {
      try {
        assertPlanReviewProviderSubmission(value);
        return true;
      } catch {
        return false;
      }
    },
    explain(value: unknown) {
      try {
        assertPlanReviewProviderSubmission(value);
        return [];
      } catch (error) {
        return [
          {
            path: '/',
            code: 'PLAN_REVIEW_INVALID',
            message:
              error instanceof Error
                ? error.message
                : 'Plan review submission failed its bound semantic validator.',
          },
        ];
      }
    },
  });

  function planReviewSubmissionDigest(
    submission: PlanReviewSubmission,
  ): string {
    return sha256(
      canonicalJson({
        schema: 'plan-review-submission.v2',
        submission,
      }),
    );
  }

  /**
   * Canonicalize what a provider actually wrote, filling in every engine-derived
   * field. Exposed so the derivation is observable rather than only reachable
   * through a stored provider result.
   */
  function canonicalizePlanReviewProviderSubmission(
    value: unknown,
  ): PlanReviewSubmission {
    return deepFreeze(
      canonicalSubmission(assertPlanReviewProviderSubmission(value)),
    ) as PlanReviewSubmission;
  }

  function canonicalizePlanReviewSubmission(
    value: unknown,
  ): PlanReviewSubmission {
    return deepFreeze(
      canonicalSubmission(assertPlanReviewSubmission(value)),
    ) as PlanReviewSubmission;
  }

  function assertPlanReviewSubmission(value: unknown): NormalizedSubmission {
    if (!isRecord(value) || !hasExactKeys(value, SUBMISSION_KEYS)) {
      throw planReviewInvalid('Plan review submission shape is malformed.');
    }
    if (value.schemaVersion !== 2) {
      throw planReviewInvalid(
        'Plan review submission schema version must be 2.',
      );
    }
    if (typeof value.verdict !== 'string' || !VERDICTS.has(value.verdict)) {
      throw planReviewInvalid('Plan review verdict is unexpected.');
    }
    const coverage = assertCoverage(value.coverage);
    const findings = assertBoundedArray(
      value.findings,
      PLAN_REVIEW_LIMITS.maxFindings,
      'Plan review contains too many findings.',
    )
      .map((entry) => assertSubmissionChallenge(entry))
      .sort((left, right) =>
        left.findingId < right.findingId
          ? -1
          : left.findingId > right.findingId
            ? 1
            : 0,
      );
    assertUniqueChallengeIds(findings.map((finding) => finding.findingId));
    const suggestions = assertBoundedArray(
      value.suggestions,
      PLAN_REVIEW_LIMITS.maxSuggestions,
      'Plan review contains too many suggestions.',
    )
      .map((entry) => assertSubmissionSuggestion(entry))
      .sort((left, right) =>
        left.suggestionId < right.suggestionId
          ? -1
          : left.suggestionId > right.suggestionId
            ? 1
            : 0,
      );
    const proposedTerms = assertProposedTerms(value.proposedTerms);
    const scopeAssessment = assertScopeAssessment(
      value.scopeAssessment,
      findings,
    );
    const residualRisk = assertBoundedRequiredText(
      value.residualRisk,
      PLAN_REVIEW_LIMITS.maxResidualRiskBytes,
      'Plan review residual risk is malformed.',
    );
    const uncertainty = assertBoundedRequiredText(
      value.uncertainty,
      PLAN_REVIEW_LIMITS.maxUncertaintyBytes,
      'Plan review uncertainty is malformed.',
    );
    return {
      verdict: value.verdict as PlanReviewVerdict,
      coverage,
      scopeAssessment,
      findings,
      suggestions,
      proposedTerms,
      residualRisk,
      uncertainty,
    };
  }

  /**
   * Complete a provider submission into the canonical form the rest of the engine
   * stores and replays. Every field filled in here is one the engine already
   * knows, so a provider cannot disagree with it: the scope-assessment kind is
   * read off the finding categories, and each entry's discriminators follow from
   * the array it arrived in. The completed value is then validated exactly as a
   * caller-supplied submission, so no rule is relaxed by this path.
   */
  function completeProviderSubmission(value: unknown): unknown {
    if (!isRecord(value) || !hasExactKeys(value, PROVIDER_SUBMISSION_KEYS)) {
      throw planReviewInvalid(
        `Plan review provider submission must carry exactly: ${[...PROVIDER_SUBMISSION_KEYS].join(', ')}.`,
      );
    }
    const findings = isDenseArray(value.findings) ? value.findings : undefined;
    const suggestions = isDenseArray(value.suggestions)
      ? value.suggestions
      : undefined;
    if (findings === undefined || suggestions === undefined) {
      throw planReviewInvalid(
        'Plan review provider findings and suggestions must be arrays.',
      );
    }
    // Scope evidence is authored on every submission, so the rule holds on its
    // own field: it never depends on what the findings say. When a scope
    // challenge is present, that challenge carries the evidence forward and the
    // assessment records only the kind.
    const scopeEvidence = assertEvidenceArray(value.scopeEvidence);
    const scopeChallenged = findings.some(
      (entry) =>
        isRecord(entry) &&
        (entry.category === 'missing-scope' ||
          entry.category === 'missing-consumers'),
    );
    return {
      schemaVersion: 2,
      verdict: value.verdict,
      coverage: [...PLAN_REVIEW_COVERAGE],
      scopeAssessment: scopeChallenged
        ? { kind: 'challenges' }
        : { kind: 'no-challenge', evidence: scopeEvidence },
      findings: findings.map((entry) =>
        isRecord(entry)
          ? { ...entry, kind: 'challenge', currentChangeImpact: 'required' }
          : entry,
      ),
      proposedTerms: value.proposedTerms,
      suggestions: suggestions.map((entry) =>
        isRecord(entry)
          ? {
              ...entry,
              kind: 'suggestion',
              category: 'follow-up',
              currentChangeImpact: 'independent-follow-up',
            }
          : entry,
      ),
      residualRisk: value.residualRisk,
      uncertainty: value.uncertainty,
    };
  }

  /** Validate a raw provider submission in its authored wire form. */
  function assertPlanReviewProviderSubmission(
    value: unknown,
  ): NormalizedSubmission {
    return assertPlanReviewSubmission(completeProviderSubmission(value));
  }

  /**
   * Reduce a canonical submission to the authored wire form. The inverse of
   * `completeProviderSubmission`, used where a caller must emit exactly what a
   * provider would have written.
   */
  function planReviewProviderSubmission(
    submission: PlanReviewSubmission,
  ): Record<string, unknown> {
    const scopeEvidence =
      submission.scopeAssessment.kind === 'no-challenge'
        ? submission.scopeAssessment.evidence
        : submission.findings.flatMap(({ category, evidence }) =>
            category === 'missing-scope' || category === 'missing-consumers'
              ? evidence
              : [],
          );
    return {
      verdict: submission.verdict,
      scopeEvidence: scopeEvidence.map((entry) => ({ ...entry })),
      findings: submission.findings.map(
        ({ severity, category, summary, evidence }) => ({
          severity,
          category,
          summary,
          evidence: evidence.map((entry) => ({ ...entry })),
        }),
      ),
      proposedTerms: submission.proposedTerms.map((term) => ({ ...term })),
      suggestions: submission.suggestions.map(
        ({ severity, summary, evidence }) => ({
          severity,
          summary,
          evidence: evidence.map((entry) => ({ ...entry })),
        }),
      ),
      residualRisk: submission.residualRisk,
      uncertainty: submission.uncertainty,
    };
  }

  function canonicalSubmission(
    submission: NormalizedSubmission,
  ): PlanReviewSubmission {
    return {
      schemaVersion: 2,
      verdict: submission.verdict,
      coverage: [...submission.coverage],
      scopeAssessment:
        submission.scopeAssessment.kind === 'challenges'
          ? { kind: 'challenges' }
          : {
              kind: 'no-challenge',
              evidence: submission.scopeAssessment.evidence.map((entry) => ({
                ...entry,
              })),
            },
      findings: submission.findings.map(stripChallengeIdentity),
      proposedTerms: submission.proposedTerms.map((term) => ({ ...term })),
      suggestions: submission.suggestions.map(stripSuggestionIdentity),
      residualRisk: submission.residualRisk,
      uncertainty: submission.uncertainty,
    };
  }

  function stripChallengeIdentity(
    finding: NormalizedFinding,
  ): PlanReviewFinding {
    return {
      kind: 'challenge',
      severity: finding.severity,
      category: finding.category,
      currentChangeImpact: 'required',
      summary: finding.summary,
      evidence: finding.evidence.map((entry) => ({ ...entry })),
    };
  }

  function stripSuggestionIdentity(
    suggestion: NormalizedSuggestion,
  ): PlanReviewFinding {
    return {
      kind: 'suggestion',
      severity: suggestion.severity,
      category: suggestion.category,
      currentChangeImpact: 'independent-follow-up',
      summary: suggestion.summary,
      evidence: suggestion.evidence.map((entry) => ({ ...entry })),
    };
  }

  function assertSubmissionEvidenceBindings(
    submission: NormalizedSubmission,
    subject: PlanReviewSubject,
  ): void {
    const allowedGraphEvidence = new Set(
      subject.investigationDependencies.map(
        ({ nodeId, resultDigest }) => `${nodeId}\u0000${resultDigest}`,
      ),
    );
    const allowedRoleEvidence = new Set(
      subject.investigationDependencies.map(
        ({ role, nodeId, resultDigest }) =>
          `${role}\u0000${nodeId}\u0000${resultDigest}`,
      ),
    );
    const evidence = [
      ...submission.findings.flatMap((finding) => finding.evidence),
      ...submission.suggestions.flatMap((suggestion) => suggestion.evidence),
      ...(submission.scopeAssessment.kind === 'no-challenge'
        ? submission.scopeAssessment.evidence
        : []),
    ];
    for (const citation of evidence) {
      if (
        (citation.kind === 'investigation-node' ||
          citation.kind === 'survey-record') &&
        !allowedGraphEvidence.has(
          `${citation.nodeId}\u0000${citation.resultDigest}`,
        )
      ) {
        throw planReviewInvalid(
          'Plan review graph evidence is not bound to the investigation subject.',
        );
      }
      if (
        citation.kind === 'investigation-role-result' &&
        !allowedRoleEvidence.has(
          `${citation.role}\u0000${citation.requestDigest}\u0000${citation.resultDigest}`,
        )
      ) {
        throw planReviewInvalid(
          'Plan review role-result evidence is not bound to the investigation subject.',
        );
      }
    }
  }

  function assertSubmissionChallenge(value: unknown): NormalizedFinding {
    const record = assertExactKeys(value, [
      'kind',
      'severity',
      'category',
      'currentChangeImpact',
      'summary',
      'evidence',
    ]);
    return normalizeChallenge(record);
  }

  function assertStoredChallenge(value: unknown): NormalizedFinding {
    const record = assertExactKeys(value, [
      'findingId',
      'kind',
      'severity',
      'category',
      'currentChangeImpact',
      'summary',
      'evidence',
    ]);
    const normalized = normalizeChallenge(record);
    if (record.findingId !== normalized.findingId) {
      throw planReviewInvalid('Plan review challenge identity does not match.');
    }
    if (
      canonicalJson(record) !==
      canonicalJson({
        findingId: normalized.findingId,
        ...stripChallengeIdentity(normalized),
      })
    ) {
      throw planReviewInvalid('Plan review challenge is not canonical.');
    }
    return normalized;
  }

  function normalizeChallenge(
    record: Record<string, unknown>,
  ): NormalizedFinding {
    if (record.kind !== 'challenge') {
      throw planReviewInvalid('A required finding must be a challenge.');
    }
    if (record.currentChangeImpact !== 'required') {
      throw planReviewInvalid('A challenge must be current-change required.');
    }
    const category = record.category;
    if (typeof category !== 'string' || !COVERAGE_SET.has(category)) {
      throw planReviewInvalid('Plan review challenge category is unexpected.');
    }
    const summary = assertSummary(record.summary);
    const severity = assertSeverity(record.severity);
    const evidence = assertEvidenceArray(record.evidence);
    return {
      findingId: findingDigest(
        'challenge',
        severity,
        category,
        'required',
        summary,
        evidence,
      ),
      kind: 'challenge',
      severity,
      category,
      currentChangeImpact: 'required',
      summary,
      evidence,
    };
  }

  function assertSubmissionSuggestion(value: unknown): NormalizedSuggestion {
    const record = assertExactKeys(value, [
      'kind',
      'severity',
      'category',
      'currentChangeImpact',
      'summary',
      'evidence',
    ]);
    return normalizeSuggestion(record);
  }

  function assertStoredSuggestion(value: unknown): NormalizedSuggestion {
    const record = assertExactKeys(value, [
      'suggestionId',
      'kind',
      'severity',
      'category',
      'currentChangeImpact',
      'summary',
      'evidence',
    ]);
    const normalized = normalizeSuggestion(record);
    if (record.suggestionId !== normalized.suggestionId) {
      throw planReviewInvalid(
        'Plan review suggestion identity does not match.',
      );
    }
    if (
      canonicalJson(record) !==
      canonicalJson({
        suggestionId: normalized.suggestionId,
        ...stripSuggestionIdentity(normalized),
      })
    ) {
      throw planReviewInvalid('Plan review suggestion is not canonical.');
    }
    return normalized;
  }

  function normalizeSuggestion(
    record: Record<string, unknown>,
  ): NormalizedSuggestion {
    if (record.kind !== 'suggestion') {
      throw planReviewInvalid('An independent finding must be a suggestion.');
    }
    if (record.currentChangeImpact !== 'independent-follow-up') {
      throw planReviewInvalid('A suggestion must be an independent follow-up.');
    }
    const category = record.category;
    if (typeof category !== 'string' || !FOLLOWUP_CATEGORIES.has(category)) {
      throw planReviewInvalid('Plan review suggestion category is unexpected.');
    }
    const summary = assertSummary(record.summary);
    const severity = assertSeverity(record.severity);
    const evidence = assertEvidenceArray(record.evidence);
    return {
      suggestionId: findingDigest(
        'suggestion',
        severity,
        category,
        'independent-follow-up',
        summary,
        evidence,
      ),
      kind: 'suggestion',
      severity,
      category,
      currentChangeImpact: 'independent-follow-up',
      summary,
      evidence,
    };
  }

  function assertScopeAssessment(
    value: unknown,
    findings: NormalizedFinding[],
  ): PlanReviewScopeAssessment {
    if (!isRecord(value)) {
      throw planReviewInvalid('Plan review scope assessment is malformed.');
    }
    if (value.kind === 'challenges') {
      assertExactKeys(value, ['kind']);
      if (
        !findings.some(
          ({ category }) =>
            category === 'missing-scope' || category === 'missing-consumers',
        )
      ) {
        throw planReviewInvalid(
          'A challenges scope assessment requires an explicit scope challenge.',
        );
      }
      return { kind: 'challenges' };
    }
    if (value.kind === 'no-challenge') {
      assertExactKeys(value, ['kind', 'evidence']);
      const evidence = assertEvidenceArray(value.evidence);
      if (
        findings.some(
          ({ category }) =>
            category === 'missing-scope' || category === 'missing-consumers',
        )
      ) {
        throw planReviewInvalid(
          'A no-challenge scope assessment cannot carry a scope challenge.',
        );
      }
      return { kind: 'no-challenge', evidence };
    }
    throw planReviewInvalid('Plan review scope assessment kind is unexpected.');
  }

  function assertCoverage(value: unknown): string[] {
    if (!isDenseArray(value) || value.length !== PLAN_REVIEW_COVERAGE.length) {
      throw planReviewInvalid('Plan review coverage is incomplete.');
    }
    const seen = new Set<string>();
    for (const area of value) {
      if (
        typeof area !== 'string' ||
        !COVERAGE_SET.has(area) ||
        seen.has(area)
      ) {
        throw planReviewInvalid('Plan review coverage is malformed.');
      }
      seen.add(area);
    }
    for (const area of PLAN_REVIEW_COVERAGE) {
      if (!seen.has(area)) {
        throw planReviewInvalid('Plan review coverage is incomplete.');
      }
    }
    return [...PLAN_REVIEW_COVERAGE];
  }

  function assertProposedTerms(value: unknown): PlanReviewProposedTerm[] {
    const terms = assertBoundedArray(
      value,
      PLAN_REVIEW_LIMITS.maxProposedTerms,
      'Plan review contains too many proposed terms.',
    ).map((entry) => {
      const record = assertExactKeys(entry, ['kind', 'value']);
      const kind = record.kind;
      const termValue = record.value;
      if (typeof kind !== 'string' || !TERM_KINDS.has(kind)) {
        throw planReviewInvalid('Proposed term kind is unexpected.');
      }
      if (typeof termValue !== 'string') {
        throw planReviewInvalid('Proposed term value is malformed.');
      }
      let normalized;
      try {
        normalized = normalizeInvestigationTerm({
          kind: kind as InvestigationTermKind,
          value: termValue,
        });
      } catch {
        throw planReviewInvalid('Proposed term value is malformed.');
      }
      return {
        kind: normalized.kind,
        value: normalized.value,
        termId: normalized.termId,
      };
    });
    const unique = new Map<
      string,
      PlanReviewProposedTerm & { termId: string }
    >();
    for (const term of terms) {
      unique.set(term.termId, term);
    }
    return [...unique.values()]
      .sort((left, right) =>
        left.termId < right.termId ? -1 : left.termId > right.termId ? 1 : 0,
      )
      .map(({ kind, value: termValue }) => ({ kind, value: termValue }));
  }

  function assertEvidenceArray(value: unknown): PlanReviewEvidence[] {
    const array = assertBoundedArray(
      value,
      PLAN_REVIEW_LIMITS.maxEvidencePerEntry,
      'Plan review contains too many evidence citations.',
    );
    if (array.length === 0) {
      throw planReviewInvalid('At least one evidence citation is required.');
    }
    const unique = new Map<string, PlanReviewEvidence>();
    for (const entry of array.map((candidate) => assertEvidence(candidate))) {
      unique.set(canonicalJson(entry), entry);
    }
    return [...unique.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([, evidence]) => evidence);
  }

  function assertEvidence(value: unknown): PlanReviewEvidence {
    if (!isRecord(value)) {
      throw planReviewInvalid('Plan review evidence is malformed.');
    }
    const kind = value.kind;
    if (kind === 'planning-location' || kind === 'repository-location') {
      assertExactKeys(value, ['kind', 'path', 'line', 'observation']);
      const path = value.path;
      const line = value.line;
      const observation = value.observation;
      if (
        typeof path !== 'string' ||
        Buffer.byteLength(path, 'utf8') >
          PLAN_REVIEW_LIMITS.maxRepositoryPathBytes ||
        !Number.isInteger(line) ||
        (line as number) < 1 ||
        (line as number) > Number.MAX_SAFE_INTEGER ||
        !isBoundedNonBlankText(
          observation,
          PLAN_REVIEW_LIMITS.maxObservationBytes,
        )
      ) {
        throw planReviewInvalid('Repository-location evidence is malformed.');
      }
      let normalizedPath: string;
      try {
        normalizedPath = normalizeExactRepositoryPath(path);
      } catch {
        throw planReviewInvalid('Repository-location evidence is malformed.');
      }
      return {
        kind,
        path: normalizedPath,
        line: line as number,
        observation: observation as string,
      };
    }
    if (kind === 'investigation-node' || kind === 'survey-record') {
      assertExactKeys(value, ['kind', 'nodeId', 'resultDigest']);
      const nodeId = value.nodeId;
      const resultDigest = value.resultDigest;
      if (!isDigest(nodeId) || !isDigest(resultDigest)) {
        throw planReviewInvalid('Graph evidence digests are malformed.');
      }
      return kind === 'investigation-node'
        ? { kind: 'investigation-node', nodeId, resultDigest }
        : { kind: 'survey-record', nodeId, resultDigest };
    }
    if (kind === 'investigation-role-result') {
      assertExactKeys(value, ['kind', 'role', 'requestDigest', 'resultDigest']);
      const role = value.role;
      const requestDigest = value.requestDigest;
      const resultDigest = value.resultDigest;
      if (
        (role !== 'reviewer-pre-anchor' && role !== 'investigation-reviewer') ||
        !isDigest(requestDigest) ||
        !isDigest(resultDigest)
      ) {
        throw planReviewInvalid(
          'Investigation role-result evidence is malformed.',
        );
      }
      return {
        kind: 'investigation-role-result',
        role,
        requestDigest,
        resultDigest,
      };
    }
    throw planReviewInvalid('Plan review evidence kind is unexpected.');
  }

  function assertSummary(value: unknown): string {
    return assertBoundedRequiredText(
      value,
      PLAN_REVIEW_LIMITS.maxSummaryBytes,
      'Plan review summary is required.',
    );
  }

  function assertSeverity(value: unknown): PlanReviewSeverity {
    if (typeof value !== 'string' || !SEVERITIES.has(value)) {
      throw planReviewInvalid('Plan review finding severity is unexpected.');
    }
    return value as PlanReviewSeverity;
  }

  function assertBoundedRequiredText(
    value: unknown,
    maximumBytes: number,
    message: string,
  ): string {
    if (!isBoundedNonBlankText(value, maximumBytes)) {
      throw planReviewInvalid(message);
    }
    return value as string;
  }

  function assertUniqueChallengeIds(ids: string[]): void {
    if (new Set(ids).size !== ids.length) {
      throw planReviewInvalid('Plan review contains duplicate challenges.');
    }
  }

  function findingDigest(
    kind: 'challenge' | 'suggestion',
    severity: PlanReviewSeverity,
    category: string,
    currentChangeImpact: string,
    summary: string,
    evidence: PlanReviewEvidence[],
  ): string {
    return sha256(
      canonicalJson({
        schema: 'plan-review-finding.v2',
        kind,
        severity,
        category,
        currentChangeImpact,
        summary,
        evidence,
      }),
    );
  }

  function assertBoundedArray(
    value: unknown,
    maximum: number,
    message: string,
  ): unknown[] {
    const array = assertArray(value);
    if (array.length > maximum) {
      throw planReviewInvalid(message);
    }
    return array;
  }

  function assertArray(value: unknown): unknown[] {
    if (!isDenseArray(value)) {
      throw planReviewInvalid('Expected a plan review array value.');
    }
    return value;
  }

  function assertCanonicalIdentityOrder(
    ids: string[],
    message: string,
    allowEqual = false,
  ): void {
    for (let index = 1; index < ids.length; index += 1) {
      if (
        ids[index - 1]! > ids[index]! ||
        (!allowEqual && ids[index - 1] === ids[index])
      ) {
        throw planReviewInvalid(message);
      }
    }
  }

  function isBoundedNonBlankText(
    value: unknown,
    maximumBytes: number,
  ): value is string {
    return (
      typeof value === 'string' &&
      value.trim().length > 0 &&
      Buffer.byteLength(value, 'utf8') <= maximumBytes
    );
  }

  function assertExactKeys(
    value: unknown,
    keys: readonly string[],
  ): Record<string, unknown> {
    if (!isRecord(value) || !hasExactKeys(value, keys)) {
      throw planReviewInvalid('Plan review value has unexpected keys.');
    }
    return value;
  }

  function isDenseArray(value: unknown): value is unknown[] {
    if (!Array.isArray(value)) {
      return false;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || !keys.includes('length')) {
      return false;
    }
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
        return false;
      }
    }
    return true;
  }

  function planReviewInvalid(message: string): WorkflowError {
    return workflowError('PLAN_REVIEW_INVALID', message, ExitCode.usage);
  }

  return {
    PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
    PLAN_REVIEW_MAX_PROPOSED_TERMS,
    PLAN_REVIEW_COVERAGE,
    PLAN_REVIEW_PROVIDER_OUTPUT_SCHEMA,
    PLAN_REVIEW_OUTPUT_SCHEMA,
    PLAN_REVIEW_OUTPUT_VALIDATOR,
    planReviewSubmissionDigest,
    canonicalizePlanReviewProviderSubmission,
    canonicalizePlanReviewSubmission,
    planReviewProviderSubmission,
    planReviewInvalid,
    assertExactKeys,
    SUBJECT_KEYS,
    assertPlanReviewProviderSubmission,
    assertSubmissionEvidenceBindings,
    PROVIDER_RESULT_TYPE,
    PROVIDER_RESULT_SCHEMA,
    PROVIDER_RESULT_EVALUATOR,
    PROVIDER_RESULT_OUTPUT_SCHEMA,
    PROVIDER_RESULT_OUTPUT_KEYS,
    canonicalSubmission,
    PLAN_REVIEW_EVALUATOR,
    assertPlanReviewSubmission,
    PLAN_REVIEW_TYPE,
    PLAN_REVIEW_SCHEMA,
    PLAN_REVIEW_NODE_OUTPUT_SCHEMA_ID,
    OUTPUT_KEYS,
    VERDICTS,
    assertCoverage,
    assertBoundedArray,
    PLAN_REVIEW_LIMITS,
    assertStoredChallenge,
    assertUniqueChallengeIds,
    assertCanonicalIdentityOrder,
    assertStoredSuggestion,
    assertProposedTerms,
    assertBoundedRequiredText,
    assertScopeAssessment,
    stripChallengeIdentity,
    stripSuggestionIdentity,
    DISPOSITION_TYPE,
    DISPOSITION_SCHEMA,
    DISPOSITION_EVALUATOR,
    DISPOSITION_OUTPUT_SCHEMA,
    GIT_OBJECT_ID_PATTERN,
    isBoundedNonBlankText,
    AUTHORIZED_DISPOSITION_SCHEMA,
    AUTHORIZED_DISPOSITION_EVALUATOR,
    AUTHORIZED_DISPOSITION_OUTPUT_SCHEMA,
    DISPOSITION_DECISIONS,
    AUTHORIZED_DISPOSITION_DECISIONS,
  };
}
