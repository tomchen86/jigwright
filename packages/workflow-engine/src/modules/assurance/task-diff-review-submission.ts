/**
 * Defines task diff provider submissions, canonical findings, and evidence
 * validation.
 *
 * Invariants:
 * - Documentation assessment must be present exactly when the subject
 *   requires it.
 */
import { createTaskDiffReviewContinuationSubmissionProtocol } from './task-diff-review-continuation-submission.ts';
import { TASK_DIFF_REVIEW_COVERAGE } from './task-diff-review.ts';
import type {
  TaskDiffReviewSubject,
  TaskDiffReviewScope,
  TaskDiffReviewPathRole,
} from './task-diff-review.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type {
  TaskDiffReviewSubmissionProtocolBindings,
  TaskDiffReviewSubmission,
  TaskDiffReviewAssignment,
  StoredTaskDiffReviewChallenge,
  StoredTaskDiffReviewSuggestion,
  TaskDiffReviewRiskPathDisposition,
  TaskDiffReviewFinding,
  TaskDiffReviewSuggestion,
  TaskDiffReviewSeverity,
  TaskDiffReviewEvidence,
  TaskDiffDocumentationAssessment,
  TaskDiffReviewVerdict,
} from './task-diff-review-artifact.ts';

export function createTaskDiffReviewSubmissionProtocol(
  bindings: TaskDiffReviewSubmissionProtocolBindings,
) {
  const {
    MAX_TEXT_BYTES,
    MAX_FINDINGS,
    MAX_EVIDENCE,
    sha256,
    isRecord,
    hasExactKeys,
    recordInvalid,
    deepFreeze,
    boundedText,
    parseDigest,
    exactPath,
    OBJECT_ID,
    identity,
  } = bindings;

  const VERDICTS = new Set(['advisory-approve', 'advisory-reject']);

  const SEVERITIES = new Set([
    'critical',
    'high',
    'medium',
    'low',
    'informational',
  ]);

  const CATEGORIES = new Set<string>(TASK_DIFF_REVIEW_COVERAGE);

  const DISPOSITIONS = new Set(['accepted', 'rebutted', 'withdrawn']);

  const RISK_PATH_ROLES = Object.freeze([
    'control-plane',
    'grant',
    'lifecycle',
    'policy',
    'verification-infrastructure',
    'contract-surface',
    'unregistered',
  ] as const);

  const RISK_PATH_OUTCOMES = Object.freeze([
    'no-challenge',
    'challenge-raised',
  ] as const);

  const RISK_PATH_ROLE_SET = new Set<string>(RISK_PATH_ROLES);

  const RISK_PATH_OUTCOME_SET = new Set<string>(RISK_PATH_OUTCOMES);

  const TASK_DIFF_REVIEW_OUTPUT_SCHEMA_ID =
    'workflow.task-diff-review-output.v1';

  const TASK_DIFF_REVIEW_LIMITS = Object.freeze({
    maxTextBytes: MAX_TEXT_BYTES,
    maxFindings: MAX_FINDINGS,
    maxEvidence: MAX_EVIDENCE,
  });

  /**
   * What a reviewer actually authors. The schema version, the complete coverage
   * list, the scope-assessment kind, and each entry's discriminators are all
   * values the engine already holds, so asking for them again only creates a
   * place for the two to disagree.
   */
  const PROVIDER_SUBMISSION_KEYS = [
    'verdict',
    'scopeEvidence',
    'findings',
    'suggestions',
    'riskPathDispositions',
    'residualRisk',
    'uncertainty',
  ] as const;

  /**
   * Code-owned provider-facing grammar for one exact-diff review submission.
   * The JSON schema gives provider CLIs the structural contract; the bound
   * validator below additionally enforces canonical coverage, exact evidence
   * forms, duplicate rejection, byte ceilings, and challenge/scope agreement.
   */
  const TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA = Object.freeze({
    type: 'object',
    additionalProperties: false,
    required: [...PROVIDER_SUBMISSION_KEYS],
    properties: {
      verdict: { enum: [...VERDICTS] },
      scopeEvidence: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_EVIDENCE,
        items: { $ref: '#/$defs/evidence' },
      },
      findings: {
        type: 'array',
        maxItems: MAX_FINDINGS,
        items: { $ref: '#/$defs/challenge' },
      },
      suggestions: {
        type: 'array',
        maxItems: MAX_FINDINGS,
        items: { $ref: '#/$defs/suggestion' },
      },
      riskPathDispositions: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'role', 'outcome'],
          properties: {
            path: { type: 'string', minLength: 1 },
            role: { enum: [...RISK_PATH_ROLES] },
            outcome: { enum: [...RISK_PATH_OUTCOMES] },
          },
        },
      },
      residualRisk: { type: 'string', minLength: 1 },
      uncertainty: { type: 'string', minLength: 1 },
      documentationAssessment: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['decision', 'paths', 'notes'],
            properties: {
              decision: { type: 'string', const: 'updated' },
              paths: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', minLength: 1 },
              },
              notes: { type: 'string', minLength: 1 },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['decision', 'notes'],
            properties: {
              decision: { type: 'string', const: 'no-impact' },
              notes: { type: 'string', minLength: 1 },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['decision', 'sources', 'generated', 'evidence', 'notes'],
            properties: {
              decision: { type: 'string', const: 'generated-verified' },
              sources: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', minLength: 1 },
              },
              generated: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', minLength: 1 },
              },
              evidence: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', minLength: 1 },
              },
              notes: { type: 'string', minLength: 1 },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['decision', 'requiredPaths', 'notes'],
            properties: {
              decision: { type: 'string', const: 'needs-changes' },
              requiredPaths: {
                type: 'array',
                minItems: 1,
                items: { type: 'string', minLength: 1 },
              },
              notes: { type: 'string', minLength: 1 },
            },
          },
        ],
      },
    },
    $defs: {
      evidence: {
        anyOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'path', 'line', 'blobObjectId', 'observation'],
            properties: {
              kind: { type: 'string', const: 'repository-location' },
              path: { type: 'string', minLength: 1 },
              line: { type: 'integer', minimum: 1 },
              blobObjectId: {
                type: 'string',
                pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$',
              },
              observation: { type: 'string', minLength: 1 },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'reportId', 'checkId', 'observation'],
            properties: {
              kind: { type: 'string', const: 'check-report' },
              reportId: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              checkId: { type: 'string', minLength: 1 },
              observation: { type: 'string', minLength: 1 },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'nodeId', 'resultDigest', 'observation'],
            properties: {
              kind: { type: 'string', const: 'planning-node' },
              nodeId: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              resultDigest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              observation: { type: 'string', minLength: 1 },
            },
          },
        ],
      },
      challenge: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind',
          'severity',
          'category',
          'currentChangeImpact',
          'summary',
          'evidence',
        ],
        properties: {
          kind: { type: 'string', const: 'challenge' },
          severity: { enum: [...SEVERITIES] },
          category: { enum: [...TASK_DIFF_REVIEW_COVERAGE] },
          currentChangeImpact: { type: 'string', const: 'required' },
          summary: { type: 'string', minLength: 1 },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_EVIDENCE,
            items: { $ref: '#/$defs/evidence' },
          },
        },
      },
      suggestion: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind',
          'severity',
          'category',
          'currentChangeImpact',
          'summary',
          'evidence',
        ],
        properties: {
          kind: { type: 'string', const: 'suggestion' },
          severity: { enum: [...SEVERITIES] },
          category: { enum: [...TASK_DIFF_REVIEW_COVERAGE] },
          currentChangeImpact: {
            type: 'string',
            const: 'independent-follow-up',
          },
          summary: { type: 'string', minLength: 1 },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: MAX_EVIDENCE,
            items: { $ref: '#/$defs/evidence' },
          },
        },
      },
    },
  });

  const TASK_DIFF_REVIEW_OUTPUT_SCHEMA_DIGEST = sha256(
    canonicalJson(TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA),
  );

  const TASK_DIFF_REVIEW_OUTPUT_SCHEMA = Object.freeze({
    id: TASK_DIFF_REVIEW_OUTPUT_SCHEMA_ID,
    version: 1,
    digest: TASK_DIFF_REVIEW_OUTPUT_SCHEMA_DIGEST,
  });

  const TASK_DIFF_REVIEW_OUTPUT_VALIDATOR = Object.freeze({
    id: TASK_DIFF_REVIEW_OUTPUT_SCHEMA_ID,
    version: 1,
    digest: TASK_DIFF_REVIEW_OUTPUT_SCHEMA_DIGEST,
    validate(value: unknown): boolean {
      try {
        parseTaskDiffReviewProviderSubmission(value);
        return true;
      } catch {
        return false;
      }
    },
    explain(value: unknown) {
      try {
        parseTaskDiffReviewProviderSubmission(value);
        return [];
      } catch (error) {
        return [
          {
            path: '/',
            code: 'TASK_DIFF_REVIEW_INVALID',
            message:
              error instanceof Error
                ? error.message
                : 'Task diff review submission failed its bound semantic validator.',
          },
        ];
      }
    },
  });

  const {
    TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
    parseTaskDiffReviewContinuationSubmission,
    assertTaskDiffReviewContinuationSubmissionCurrent,
    CONTINUATION_DECISIONS,
  } = createTaskDiffReviewContinuationSubmissionProtocol(bindings);

  function normalizeSubmission(
    value: TaskDiffReviewSubmission,
    assignment: TaskDiffReviewAssignment,
    subject: TaskDiffReviewSubject,
    reviewScope: TaskDiffReviewScope,
  ) {
    const submission = parseTaskDiffReviewSubmission(value);
    const challenges = normalizeSubmittedFindings(
      submission.findings,
      assignment.reviewerPrincipalId,
    );
    const suggestions = normalizeSubmittedSuggestions(submission.suggestions);
    const riskPathDispositions = assertRiskPathDispositionsCurrent(
      subject,
      reviewScope,
      submission.riskPathDispositions,
    );
    assertRiskPathChallengeConsistency(riskPathDispositions, challenges);
    return {
      verdict: submission.verdict,
      scopeAssessment: submission.scopeAssessment,
      challenges,
      suggestions,
      riskPathDispositions,
      residualRisk: submission.residualRisk,
      uncertainty: submission.uncertainty,
      ...(submission.documentationAssessment === undefined
        ? {}
        : {
            documentationAssessment: assertDocumentationAssessmentCurrent(
              subject,
              submission.documentationAssessment,
              submission.verdict,
              challenges.length,
            ),
          }),
    };
  }

  /** Strictly parse and canonically normalize provider semantic output. */
  /** Complete an authored submission into the canonical form. */
  function completeTaskDiffReviewProviderSubmission(value: unknown): unknown {
    if (
      !isRecord(value) ||
      (!hasExactKeys(value, PROVIDER_SUBMISSION_KEYS) &&
        !hasExactKeys(value, [
          ...PROVIDER_SUBMISSION_KEYS,
          'documentationAssessment',
        ]))
    ) {
      throw recordInvalid();
    }
    const findings = Array.isArray(value.findings) ? value.findings : undefined;
    const suggestions = Array.isArray(value.suggestions)
      ? value.suggestions
      : undefined;
    if (findings === undefined || suggestions === undefined) {
      throw recordInvalid();
    }
    const { scopeEvidence, ...rest } = value;
    return {
      ...rest,
      schemaVersion: 1,
      coverage: [...TASK_DIFF_REVIEW_COVERAGE],
      scopeAssessment:
        findings.length > 0
          ? { kind: 'challenges' }
          : { kind: 'no-challenge', evidence: scopeEvidence },
      findings: findings.map((entry) =>
        isRecord(entry)
          ? { ...entry, kind: 'challenge', currentChangeImpact: 'required' }
          : entry,
      ),
      suggestions: suggestions.map((entry) =>
        isRecord(entry)
          ? {
              ...entry,
              kind: 'suggestion',
              currentChangeImpact: 'independent-follow-up',
            }
          : entry,
      ),
    };
  }

  /** Reduce a canonical submission to the authored wire form. */
  function taskDiffReviewProviderSubmission(
    submission: TaskDiffReviewSubmission,
  ): Record<string, unknown> {
    const {
      schemaVersion: _schemaVersion,
      coverage: _coverage,
      scopeAssessment,
      findings,
      suggestions,
      ...rest
    } = submission;
    return {
      ...rest,
      scopeEvidence:
        scopeAssessment.kind === 'no-challenge'
          ? scopeAssessment.evidence.map((entry) => ({ ...entry }))
          : findings.flatMap(({ evidence }) =>
              evidence.map((entry) => ({ ...entry })),
            ),
      findings: findings.map(
        ({ kind: _kind, currentChangeImpact: _impact, ...finding }) => ({
          ...finding,
        }),
      ),
      suggestions: suggestions.map(
        ({ kind: _kind, currentChangeImpact: _impact, ...suggestion }) => ({
          ...suggestion,
        }),
      ),
    };
  }

  function parseTaskDiffReviewProviderSubmission(
    value: unknown,
  ): TaskDiffReviewSubmission {
    return parseTaskDiffReviewSubmission(
      completeTaskDiffReviewProviderSubmission(value),
    );
  }

  function parseTaskDiffReviewSubmission(
    value: unknown,
  ): TaskDiffReviewSubmission {
    const legacyKeys = [
      'schemaVersion',
      'verdict',
      'coverage',
      'scopeAssessment',
      'findings',
      'suggestions',
      'riskPathDispositions',
      'residualRisk',
      'uncertainty',
    ];
    if (
      !isRecord(value) ||
      (!hasExactKeys(value, legacyKeys) &&
        !hasExactKeys(value, [...legacyKeys, 'documentationAssessment'])) ||
      value.schemaVersion !== 1
    ) {
      throw recordInvalid();
    }
    const verdict = parseVerdict(value.verdict);
    const coverage = parseCoverage(value.coverage);
    if (
      !Array.isArray(value.findings) ||
      value.findings.length > MAX_FINDINGS
    ) {
      throw recordInvalid();
    }
    if (
      !Array.isArray(value.suggestions) ||
      value.suggestions.length > MAX_FINDINGS
    ) {
      throw recordInvalid();
    }
    const findings = value.findings.map((entry) =>
      parseFinding(entry, 'challenge'),
    );
    const suggestions = value.suggestions.map((entry) =>
      parseFinding(entry, 'suggestion'),
    );
    canonicalValues(findings);
    canonicalValues(suggestions);
    return deepFreeze({
      schemaVersion: 1,
      verdict,
      coverage,
      scopeAssessment: parseScopeAssessment(
        value.scopeAssessment,
        findings.length,
      ),
      findings,
      suggestions,
      riskPathDispositions: parseRiskPathDispositions(
        value.riskPathDispositions,
      ),
      residualRisk: boundedText(value.residualRisk),
      uncertainty: boundedText(value.uncertainty),
      ...(Object.hasOwn(value, 'documentationAssessment')
        ? {
            documentationAssessment: parseDocumentationAssessment(
              value.documentationAssessment,
            ),
          }
        : {}),
    });
  }

  function normalizeSubmittedFindings(
    value: unknown,
    reviewerPrincipalId: string,
  ): readonly StoredTaskDiffReviewChallenge[] {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
      throw recordInvalid();
    }
    const challenges = value.map((entry) => {
      const finding = parseFinding(entry, 'challenge');
      const body = { ...finding, raisedBy: reviewerPrincipalId };
      return Object.freeze({
        ...body,
        challengeId: sha256(canonicalJson(body)),
      });
    });
    return canonicalObjects(challenges, 'challengeId');
  }

  function normalizeSubmittedSuggestions(
    value: unknown,
  ): readonly StoredTaskDiffReviewSuggestion[] {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
      throw recordInvalid();
    }
    const suggestions = value.map((entry) => {
      const suggestion = parseFinding(entry, 'suggestion');
      return Object.freeze({
        ...suggestion,
        suggestionId: sha256(canonicalJson(suggestion)),
      });
    });
    return canonicalObjects(suggestions, 'suggestionId');
  }

  function parseStoredChallenges(
    value: unknown,
    assignment: TaskDiffReviewAssignment,
  ): readonly StoredTaskDiffReviewChallenge[] {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
      throw recordInvalid();
    }
    const challenges = value.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, [
          'kind',
          'severity',
          'category',
          'currentChangeImpact',
          'summary',
          'evidence',
          'raisedBy',
          'challengeId',
        ]) ||
        entry.raisedBy !== assignment.reviewerPrincipalId
      ) {
        throw recordInvalid();
      }
      const finding = parseFinding(findingProjection(entry), 'challenge');
      const body = { ...finding, raisedBy: assignment.reviewerPrincipalId };
      const challengeId = parseDigest(entry.challengeId);
      if (challengeId !== sha256(canonicalJson(body))) throw recordInvalid();
      return Object.freeze({ ...body, challengeId });
    });
    return canonicalObjects(challenges, 'challengeId');
  }

  function parseStoredSuggestions(
    value: unknown,
  ): readonly StoredTaskDiffReviewSuggestion[] {
    if (!Array.isArray(value) || value.length > MAX_FINDINGS) {
      throw recordInvalid();
    }
    const suggestions = value.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, [
          'kind',
          'severity',
          'category',
          'currentChangeImpact',
          'summary',
          'evidence',
          'suggestionId',
        ])
      ) {
        throw recordInvalid();
      }
      const suggestion = parseFinding(findingProjection(entry), 'suggestion');
      const suggestionId = parseDigest(entry.suggestionId);
      if (suggestionId !== sha256(canonicalJson(suggestion))) {
        throw recordInvalid();
      }
      return Object.freeze({ ...suggestion, suggestionId });
    });
    return canonicalObjects(suggestions, 'suggestionId');
  }

  function parseRiskPathDispositions(
    value: unknown,
  ): readonly TaskDiffReviewRiskPathDisposition[] {
    if (!Array.isArray(value)) throw recordInvalid();
    const dispositions = value.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, ['path', 'role', 'outcome']) ||
        !RISK_PATH_ROLE_SET.has(String(entry.role)) ||
        !RISK_PATH_OUTCOME_SET.has(String(entry.outcome))
      ) {
        throw recordInvalid();
      }
      return Object.freeze({
        path: exactPath(entry.path),
        role: entry.role as Exclude<TaskDiffReviewPathRole, 'ordinary'>,
        outcome: entry.outcome as TaskDiffReviewRiskPathDisposition['outcome'],
      });
    });
    return canonicalObjects(dispositions, 'path');
  }

  function assertRiskPathDispositionsCurrent(
    subject: TaskDiffReviewSubject,
    reviewScope: TaskDiffReviewScope,
    value: unknown,
  ): readonly TaskDiffReviewRiskPathDisposition[] {
    const dispositions = parseRiskPathDispositions(value);
    const reviewedPaths = new Set(reviewScope.reviewedPaths);
    const expected = subject.reviewRequirement.riskPaths.filter(
      ({ path }) => reviewScope.mode === 'full' || reviewedPaths.has(path),
    );
    if (
      expected.length !== dispositions.length ||
      expected.some(
        ({ path, role }, index) =>
          dispositions[index]?.path !== path ||
          dispositions[index]?.role !== role,
      )
    ) {
      throw recordInvalid();
    }
    return dispositions;
  }

  function assertRiskPathChallengeConsistency(
    dispositions: readonly TaskDiffReviewRiskPathDisposition[],
    challenges: readonly StoredTaskDiffReviewChallenge[],
  ): void {
    const challengedPaths = new Set(
      challenges.flatMap(({ evidence }) =>
        evidence.flatMap((entry) =>
          entry.kind === 'repository-location' ? [entry.path] : [],
        ),
      ),
    );
    if (
      dispositions.some(
        ({ path, outcome }) =>
          (outcome === 'challenge-raised') !== challengedPaths.has(path),
      )
    ) {
      throw recordInvalid();
    }
  }

  function parseFinding(
    value: unknown,
    expectedKind: 'challenge',
  ): TaskDiffReviewFinding;

  function parseFinding(
    value: unknown,
    expectedKind: 'suggestion',
  ): TaskDiffReviewSuggestion;

  function parseFinding(
    value: unknown,
    expectedKind: 'challenge' | 'suggestion',
  ): TaskDiffReviewFinding | TaskDiffReviewSuggestion {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'kind',
        'severity',
        'category',
        'currentChangeImpact',
        'summary',
        'evidence',
      ]) ||
      value.kind !== expectedKind ||
      !SEVERITIES.has(String(value.severity)) ||
      !CATEGORIES.has(String(value.category)) ||
      (expectedKind === 'challenge'
        ? value.currentChangeImpact !== 'required'
        : value.currentChangeImpact !== 'independent-follow-up')
    ) {
      throw recordInvalid();
    }
    const common = {
      severity: value.severity as TaskDiffReviewSeverity,
      category: value.category as (typeof TASK_DIFF_REVIEW_COVERAGE)[number],
      summary: boundedText(value.summary),
      evidence: normalizeEvidence(value.evidence, true),
    };
    return expectedKind === 'challenge'
      ? Object.freeze({
          ...common,
          kind: 'challenge' as const,
          currentChangeImpact: 'required' as const,
        })
      : Object.freeze({
          ...common,
          kind: 'suggestion' as const,
          currentChangeImpact: 'independent-follow-up' as const,
        });
  }

  function findingProjection(value: Record<string, unknown>) {
    return {
      kind: value.kind,
      severity: value.severity,
      category: value.category,
      currentChangeImpact: value.currentChangeImpact,
      summary: value.summary,
      evidence: value.evidence,
    };
  }

  function parseScopeAssessment(value: unknown, challengeCount: number) {
    if (!isRecord(value) || value.kind === 'challenges') {
      if (
        !isRecord(value) ||
        !hasExactKeys(value, ['kind']) ||
        value.kind !== 'challenges' ||
        challengeCount === 0
      ) {
        throw recordInvalid();
      }
      return Object.freeze({ kind: 'challenges' as const });
    }
    if (
      !hasExactKeys(value, ['kind', 'evidence']) ||
      value.kind !== 'no-challenge' ||
      challengeCount !== 0
    ) {
      throw recordInvalid();
    }
    return Object.freeze({
      kind: 'no-challenge' as const,
      evidence: normalizeEvidence(value.evidence, true),
    });
  }

  function normalizeEvidence(
    value: unknown,
    requireNonEmpty: boolean,
  ): readonly TaskDiffReviewEvidence[] {
    if (
      !Array.isArray(value) ||
      value.length > MAX_EVIDENCE ||
      (requireNonEmpty && value.length === 0)
    ) {
      throw recordInvalid();
    }
    const evidence = value.map((entry): TaskDiffReviewEvidence => {
      if (!isRecord(entry) || typeof entry.kind !== 'string') {
        throw recordInvalid();
      }
      if (entry.kind === 'repository-location') {
        if (
          !hasExactKeys(entry, [
            'kind',
            'path',
            'line',
            'blobObjectId',
            'observation',
          ]) ||
          !Number.isSafeInteger(entry.line) ||
          Number(entry.line) < 1 ||
          Number(entry.line) > 10_000_000 ||
          typeof entry.blobObjectId !== 'string' ||
          !OBJECT_ID.test(entry.blobObjectId)
        ) {
          throw recordInvalid();
        }
        return Object.freeze({
          kind: 'repository-location',
          path: exactPath(entry.path),
          line: Number(entry.line),
          blobObjectId: entry.blobObjectId,
          observation: boundedText(entry.observation),
        });
      }
      if (entry.kind === 'check-report') {
        if (
          !hasExactKeys(entry, ['kind', 'reportId', 'checkId', 'observation'])
        ) {
          throw recordInvalid();
        }
        return Object.freeze({
          kind: 'check-report',
          reportId: parseDigest(entry.reportId),
          checkId: identity(entry.checkId),
          observation: boundedText(entry.observation),
        });
      }
      if (entry.kind === 'planning-node') {
        if (
          !hasExactKeys(entry, [
            'kind',
            'nodeId',
            'resultDigest',
            'observation',
          ])
        ) {
          throw recordInvalid();
        }
        return Object.freeze({
          kind: 'planning-node',
          nodeId: parseDigest(entry.nodeId),
          resultDigest: parseDigest(entry.resultDigest),
          observation: boundedText(entry.observation),
        });
      }
      throw recordInvalid();
    });
    const canonical = evidence.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
    if (
      canonical.some(
        (entry, index) =>
          index > 0 &&
          canonicalJson(entry) === canonicalJson(canonical[index - 1]),
      )
    ) {
      throw recordInvalid();
    }
    return Object.freeze(canonical);
  }

  function parseCoverage(value: unknown): typeof TASK_DIFF_REVIEW_COVERAGE {
    if (
      !Array.isArray(value) ||
      value.some((entry) => typeof entry !== 'string') ||
      new Set(value).size !== TASK_DIFF_REVIEW_COVERAGE.length ||
      [...value].sort().join('\0') !==
        [...TASK_DIFF_REVIEW_COVERAGE].sort().join('\0')
    ) {
      throw recordInvalid();
    }
    return TASK_DIFF_REVIEW_COVERAGE;
  }

  function parseDocumentationAssessment(
    value: unknown,
  ): TaskDiffDocumentationAssessment {
    if (!isRecord(value) || typeof value.decision !== 'string') {
      throw recordInvalid();
    }
    if (
      value.decision === 'updated' &&
      hasExactKeys(value, ['decision', 'paths', 'notes'])
    ) {
      return Object.freeze({
        decision: 'updated' as const,
        paths: documentationPaths(value.paths),
        notes: boundedText(value.notes),
      });
    }
    if (
      value.decision === 'no-impact' &&
      hasExactKeys(value, ['decision', 'notes'])
    ) {
      return Object.freeze({
        decision: 'no-impact' as const,
        notes: boundedText(value.notes),
      });
    }
    if (
      value.decision === 'generated-verified' &&
      hasExactKeys(value, [
        'decision',
        'sources',
        'generated',
        'evidence',
        'notes',
      ])
    ) {
      return Object.freeze({
        decision: 'generated-verified' as const,
        sources: exactPaths(value.sources, false),
        generated: documentationPaths(value.generated),
        evidence: boundedIdentities(value.evidence),
        notes: boundedText(value.notes),
      });
    }
    if (
      value.decision === 'needs-changes' &&
      hasExactKeys(value, ['decision', 'requiredPaths', 'notes'])
    ) {
      return Object.freeze({
        decision: 'needs-changes' as const,
        requiredPaths: documentationPaths(value.requiredPaths),
        notes: boundedText(value.notes),
      });
    }
    throw recordInvalid();
  }

  function assertDocumentationAssessmentCurrent(
    subject: TaskDiffReviewSubject,
    assessment: TaskDiffDocumentationAssessment | undefined,
    verdict: TaskDiffReviewVerdict,
    challengeCount: number,
  ): TaskDiffDocumentationAssessment | undefined {
    const requirement = subject.documentationRequirement;
    if (requirement?.required !== true) {
      if (assessment !== undefined) throw recordInvalid();
      return undefined;
    }
    if (assessment === undefined) throw recordInvalid();
    const changed = new Set(requirement.changedPaths);
    const changedDocumentation =
      requirement.changedPaths.filter(isDocumentationPath);
    if (assessment.decision === 'updated') {
      if (assessment.paths.some((candidate) => !changed.has(candidate))) {
        throw recordInvalid();
      }
    } else if (assessment.decision === 'no-impact') {
      if (changedDocumentation.length > 0) throw recordInvalid();
    } else if (assessment.decision === 'generated-verified') {
      if (
        [...assessment.sources, ...assessment.generated].some(
          (candidate) => !changed.has(candidate),
        )
      ) {
        throw recordInvalid();
      }
    } else if (verdict !== 'advisory-reject' || challengeCount === 0) {
      throw recordInvalid();
    }
    return assessment;
  }

  function documentationPaths(value: unknown): readonly string[] {
    const paths = exactPaths(value, true);
    if (paths.some((candidate) => !isDocumentationPath(candidate))) {
      throw recordInvalid();
    }
    return paths;
  }

  function exactPaths(
    value: unknown,
    requireNonEmpty: boolean,
  ): readonly string[] {
    if (
      !Array.isArray(value) ||
      value.length > MAX_FINDINGS ||
      (requireNonEmpty && value.length === 0)
    ) {
      throw recordInvalid();
    }
    const paths = value.map(exactPath).sort();
    if (
      paths.some(
        (candidate, index) => index > 0 && candidate === paths[index - 1],
      )
    ) {
      throw recordInvalid();
    }
    return Object.freeze(paths);
  }

  function boundedIdentities(value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
      throw recordInvalid();
    }
    const identities = value.map(identity).sort();
    if (
      identities.some(
        (candidate, index) => index > 0 && candidate === identities[index - 1],
      )
    ) {
      throw recordInvalid();
    }
    return Object.freeze(identities);
  }

  function isDocumentationPath(candidate: string): boolean {
    return (
      candidate.startsWith('docs/') || /(?:^|\/)README\.md$/.test(candidate)
    );
  }

  function parseVerdict(value: unknown): TaskDiffReviewVerdict {
    if (!VERDICTS.has(String(value))) throw recordInvalid();
    return value as TaskDiffReviewVerdict;
  }

  function canonicalObjects<T extends Record<K, string>, K extends keyof T>(
    value: T[],
    key: K,
  ): readonly T[] {
    value.sort((left, right) => left[key].localeCompare(right[key]));
    if (
      value.some(
        (entry, index) => index > 0 && entry[key] === value[index - 1]![key],
      )
    ) {
      throw recordInvalid();
    }
    return Object.freeze(value);
  }

  function canonicalValues<T>(value: T[]): void {
    value.sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)),
    );
    if (
      value.some(
        (entry, index) =>
          index > 0 && canonicalJson(entry) === canonicalJson(value[index - 1]),
      )
    ) {
      throw recordInvalid();
    }
  }

  return {
    TASK_DIFF_REVIEW_LIMITS,
    TASK_DIFF_REVIEW_PROVIDER_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_OUTPUT_VALIDATOR,
    TASK_DIFF_REVIEW_CONTINUATION_PROVIDER_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
    TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_VALIDATOR,
    completeTaskDiffReviewProviderSubmission,
    taskDiffReviewProviderSubmission,
    parseTaskDiffReviewProviderSubmission,
    parseTaskDiffReviewSubmission,
    parseTaskDiffReviewContinuationSubmission,
    assertTaskDiffReviewContinuationSubmissionCurrent,
    RISK_PATH_OUTCOMES,
    normalizeSubmission,
    parseVerdict,
    parseCoverage,
    parseStoredChallenges,
    parseStoredSuggestions,
    assertRiskPathDispositionsCurrent,
    assertRiskPathChallengeConsistency,
    parseScopeAssessment,
    assertDocumentationAssessmentCurrent,
    parseDocumentationAssessment,
    CONTINUATION_DECISIONS,
    DISPOSITIONS,
    normalizeEvidence,
  };
}
