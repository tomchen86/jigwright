/**
 * Constructs and validates PlanReview dispositions and challenge-closure
 * authorization.
 *
 * Invariants:
 * - A PlanReview disposition set must not be empty.
 */
import {
  isRecord,
  hasExactKeys,
  isDigest,
  sha256,
  deepFreeze,
} from './plan-review-values.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type { MaintainerPolicy } from '../authority/maintainer-policy.ts';
import { assertAuthorizedReviewChallengeClosure } from './review-challenge.ts';
import type { Challenge, ChallengeClosure } from './review-challenge.ts';
import type {
  PlanReviewDispositionProtocolBindings,
  PlanReviewDispositionInput,
  AuthorizedPlanReviewDispositionInput,
  PlanReviewChallengeClosureAuthority,
  PlanReviewDispositionRecord,
  LegacyPlanReviewDispositionRecord,
  AuthorizedPlanReviewDispositionRecord,
  PlanReviewDispositionEntry,
  PlanReviewDispositionDecision,
  AuthorizedPlanReviewDispositionEntry,
  AuthorizedPlanReviewDispositionDecision,
  PlanReviewReport,
} from './plan-review.ts';

type EvidenceNode = ReturnType<
  PlanReviewDispositionProtocolBindings['createEvidenceNode']
>;

export function createPlanReviewDispositionProtocol(
  bindings: PlanReviewDispositionProtocolBindings,
) {
  const {
    planReviewInvalid,
    readPlanReviewNode,
    assertBoundedArray,
    PLAN_REVIEW_LIMITS,
    createEvidenceNode,
    DISPOSITION_TYPE,
    DISPOSITION_SCHEMA,
    DISPOSITION_EVALUATOR,
    DISPOSITION_OUTPUT_SCHEMA,
    GIT_OBJECT_ID_PATTERN,
    isBoundedNonBlankText,
    PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
    AUTHORIZED_DISPOSITION_SCHEMA,
    AUTHORIZED_DISPOSITION_EVALUATOR,
    AUTHORIZED_DISPOSITION_OUTPUT_SCHEMA,
    assertStoredEvidenceNode,
    assertExactDigestRoles,
    assertExactKeys,
    verifySshSignatureWithPublicKey,
    DISPOSITION_DECISIONS,
    AUTHORIZED_DISPOSITION_DECISIONS,
  } = bindings;

  /**
   * Bind a disposition for every named challenge into an immutable node that
   * descends from the exact review. Each disposition must name a real challenge in
   * the review with an allowed decision and rationale; an unknown or duplicated
   * challenge fails closed.
   */
  function createPlanReviewDispositionNode(
    input: PlanReviewDispositionInput,
  ): EvidenceNode {
    if (
      !isRecord(input) ||
      !hasExactKeys(input, ['reviewNode', 'policyDigest', 'dispositions'])
    ) {
      throw planReviewInvalid('Plan review disposition input is malformed.');
    }
    const review = readPlanReviewNode(input.reviewNode);
    if (!isDigest(input.policyDigest)) {
      throw planReviewInvalid(
        'Plan review disposition policy digest is invalid.',
      );
    }
    const challengeIds = new Set(
      review.findings.map((finding) => finding.findingId),
    );
    const dispositions = assertBoundedArray(
      input.dispositions,
      PLAN_REVIEW_LIMITS.maxFindings,
      'Plan review contains too many dispositions.',
    ).map((entry) => assertDisposition(entry));
    if (dispositions.length === 0) {
      throw planReviewInvalid('Plan review disposition set must not be empty.');
    }
    const seen = new Set<string>();
    for (const disposition of dispositions) {
      if (!challengeIds.has(disposition.challengeId)) {
        throw planReviewInvalid('Disposition names an unknown challenge.');
      }
      if (seen.has(disposition.challengeId)) {
        throw planReviewInvalid('Disposition duplicates a challenge.');
      }
      seen.add(disposition.challengeId);
    }
    const sorted = [...dispositions].sort((left, right) =>
      left.challengeId < right.challengeId ? -1 : 1,
    );

    return createEvidenceNode({
      type: DISPOSITION_TYPE,
      nodeSchema: DISPOSITION_SCHEMA,
      evaluator: DISPOSITION_EVALUATOR,
      policyDigest: input.policyDigest,
      exactInputDigests: {
        dispositions: planReviewDispositionDigest(sorted),
      },
      semanticParentResultDigests: { review: input.reviewNode.resultDigest },
      provenanceParentNodeIds: { review: input.reviewNode.nodeId },
      outputSchema: DISPOSITION_OUTPUT_SCHEMA,
      output: { schemaVersion: 1, dispositions: sorted },
      runtimeMetadata: {},
    });
  }

  function createAuthorizedPlanReviewDispositionNode(
    input: AuthorizedPlanReviewDispositionInput,
  ): EvidenceNode {
    const review = readPlanReviewNode(input.reviewNode);
    if (!isDigest(input.policyDigest) || !isRecord(input.binding)) {
      throw planReviewInvalid(
        'Authorized plan review disposition input is malformed.',
      );
    }
    const dispositions = assertBoundedArray(
      input.dispositions,
      PLAN_REVIEW_LIMITS.maxFindings,
      'Plan review contains too many dispositions.',
    ).map(assertAuthorizedDisposition);
    assertDispositionChallengeSet(review, dispositions);
    const sorted = [...dispositions].sort((left, right) =>
      left.challengeId.localeCompare(right.challengeId),
    );
    if (
      !['reviewer', 'domain-owner'].includes(input.role) ||
      !Number.isFinite(input.issuedAt.getTime()) ||
      input.binding.subjectDigest !== review.subjectDigest ||
      input.binding.planningGenerationId !== review.planningGenerationId ||
      !GIT_OBJECT_ID_PATTERN.test(input.binding.baselineCommit) ||
      !GIT_OBJECT_ID_PATTERN.test(input.binding.baselineTree) ||
      !isDigest(input.binding.subjectDigest) ||
      !isDigest(input.binding.planningGenerationId) ||
      !isBoundedNonBlankText(
        input.binding.repositoryId,
        PLAN_REVIEW_LIMITS.maxAuthorBytes,
      ) ||
      !isBoundedNonBlankText(
        input.binding.changeId,
        PLAN_REVIEW_LIMITS.maxAuthorBytes,
      ) ||
      !isBoundedNonBlankText(
        input.binding.investigationId,
        PLAN_REVIEW_LIMITS.maxAuthorBytes,
      ) ||
      !isBoundedNonBlankText(
        input.binding.authorId,
        PLAN_REVIEW_LIMITS.maxAuthorBytes,
      )
    ) {
      throw planReviewInvalid(
        'Authorized plan review disposition binding is malformed.',
      );
    }
    input.signer.assertHumanPresent();
    const signer = input.signer.identity();
    if (
      !isBoundedNonBlankText(signer, PLAN_REVIEW_LIMITS.maxAuthorBytes) ||
      sorted.some(({ author }) => author !== signer) ||
      signer === input.binding.authorId
    ) {
      throw planReviewInvalid(
        'Challenge closure must be signed by an authenticated reviewer distinct from the plan author.',
      );
    }
    const authorityPayload = {
      schemaVersion: 1 as const,
      kind: 'plan-review-challenge-closure-authority' as const,
      namespace: PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
      repositoryId: input.binding.repositoryId,
      changeId: input.binding.changeId,
      investigationId: input.binding.investigationId,
      baselineCommit: input.binding.baselineCommit,
      baselineTree: input.binding.baselineTree,
      subjectDigest: input.binding.subjectDigest,
      planningGenerationId: input.binding.planningGenerationId,
      reviewNodeId: input.reviewNode.nodeId,
      reviewResultDigest: input.reviewNode.resultDigest,
      dispositionsDigest: authorizedDispositionDigest(sorted),
      authorId: input.binding.authorId,
      role: input.role,
      signer,
      issuedAt: input.issuedAt.toISOString(),
    } as const;
    const payload = `${canonicalJson(authorityPayload)}\n`;
    const signature = input.signer.sign(
      payload,
      PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
    );
    input.signer.verify(
      payload,
      signature,
      signer,
      PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
    );
    const authority: PlanReviewChallengeClosureAuthority = Object.freeze({
      ...authorityPayload,
      signature,
    });
    return createEvidenceNode({
      type: DISPOSITION_TYPE,
      nodeSchema: AUTHORIZED_DISPOSITION_SCHEMA,
      evaluator: AUTHORIZED_DISPOSITION_EVALUATOR,
      policyDigest: input.policyDigest,
      exactInputDigests: {
        authority: sha256(payload),
        dispositions: authority.dispositionsDigest,
        signature: sha256(signature),
      },
      semanticParentResultDigests: { review: input.reviewNode.resultDigest },
      provenanceParentNodeIds: { review: input.reviewNode.nodeId },
      outputSchema: AUTHORIZED_DISPOSITION_OUTPUT_SCHEMA,
      output: { schemaVersion: 2, dispositions: sorted, authority },
      runtimeMetadata: {},
    });
  }

  /**
   * Read a stored disposition node back into its typed record, revalidating the
   * bound review provenance, allowed decisions, and canonical ordering.
   */
  function readPlanReviewDispositionNode(
    node: EvidenceNode,
  ): PlanReviewDispositionRecord {
    const validated = assertStoredEvidenceNode(node, () =>
      planReviewInvalid('Plan review disposition envelope is malformed.'),
    );
    if (validated.nodeSchema === AUTHORIZED_DISPOSITION_SCHEMA) {
      return readAuthorizedPlanReviewDispositionNode(validated);
    }
    if (
      validated.type !== DISPOSITION_TYPE ||
      validated.nodeSchema !== DISPOSITION_SCHEMA ||
      validated.evaluator !== DISPOSITION_EVALUATOR ||
      validated.outputSchema !== DISPOSITION_OUTPUT_SCHEMA
    ) {
      throw planReviewInvalid(
        'Plan review disposition identity is unexpected.',
      );
    }
    assertExactDigestRoles(
      validated.exactInputDigests,
      ['dispositions'],
      'Plan review disposition exact-input roles are unexpected.',
    );
    assertExactDigestRoles(
      validated.semanticParentResultDigests,
      ['review'],
      'Plan review disposition semantic-parent roles are unexpected.',
    );
    assertExactDigestRoles(
      validated.provenanceParentNodeIds,
      ['review'],
      'Plan review disposition provenance-parent roles are unexpected.',
    );
    if (Object.keys(validated.runtimeMetadata).length !== 0) {
      throw planReviewInvalid(
        'Plan review disposition runtime metadata must be empty.',
      );
    }
    const reviewNodeId = validated.provenanceParentNodeIds.review;
    const reviewResultDigest = validated.semanticParentResultDigests.review;
    if (!isDigest(reviewNodeId) || !isDigest(reviewResultDigest)) {
      throw planReviewInvalid('Disposition is not bound to a review.');
    }
    const output = assertExactKeys(validated.output, [
      'schemaVersion',
      'dispositions',
    ]);
    if (output.schemaVersion !== 1) {
      throw planReviewInvalid('Disposition output schema version must be 1.');
    }
    const dispositions = assertBoundedArray(
      output.dispositions,
      PLAN_REVIEW_LIMITS.maxFindings,
      'Plan review contains too many dispositions.',
    ).map((entry) => assertDisposition(entry));
    if (dispositions.length === 0) {
      throw planReviewInvalid('Plan review disposition set must not be empty.');
    }
    const seen = new Set<string>();
    let previous: string | null = null;
    for (const disposition of dispositions) {
      if (seen.has(disposition.challengeId)) {
        throw planReviewInvalid('Disposition duplicates a challenge.');
      }
      if (previous !== null && disposition.challengeId <= previous) {
        throw planReviewInvalid('Dispositions are not canonically sorted.');
      }
      seen.add(disposition.challengeId);
      previous = disposition.challengeId;
    }
    if (
      validated.exactInputDigests.dispositions !==
      planReviewDispositionDigest(dispositions)
    ) {
      throw planReviewInvalid(
        'Plan review disposition input digest does not match.',
      );
    }
    const record: LegacyPlanReviewDispositionRecord = {
      schemaVersion: 1,
      reviewNodeId,
      reviewResultDigest,
      policyDigest: validated.policyDigest,
      dispositions,
    };
    return deepFreeze(record);
  }

  function readAuthorizedPlanReviewDispositionNode(
    validated: EvidenceNode,
  ): AuthorizedPlanReviewDispositionRecord {
    if (
      validated.type !== DISPOSITION_TYPE ||
      validated.nodeSchema !== AUTHORIZED_DISPOSITION_SCHEMA ||
      validated.evaluator !== AUTHORIZED_DISPOSITION_EVALUATOR ||
      validated.outputSchema !== AUTHORIZED_DISPOSITION_OUTPUT_SCHEMA
    ) {
      throw planReviewInvalid(
        'Authorized plan review disposition identity is unexpected.',
      );
    }
    assertExactDigestRoles(
      validated.exactInputDigests,
      ['authority', 'dispositions', 'signature'],
      'Authorized plan review disposition exact-input roles are unexpected.',
    );
    assertExactDigestRoles(
      validated.semanticParentResultDigests,
      ['review'],
      'Authorized plan review disposition semantic-parent roles are unexpected.',
    );
    assertExactDigestRoles(
      validated.provenanceParentNodeIds,
      ['review'],
      'Authorized plan review disposition provenance-parent roles are unexpected.',
    );
    if (Object.keys(validated.runtimeMetadata).length !== 0) {
      throw planReviewInvalid(
        'Authorized plan review disposition runtime metadata must be empty.',
      );
    }
    const output = assertExactKeys(validated.output, [
      'schemaVersion',
      'dispositions',
      'authority',
    ]);
    if (output.schemaVersion !== 2) {
      throw planReviewInvalid(
        'Authorized disposition output schema version must be 2.',
      );
    }
    const dispositions = assertBoundedArray(
      output.dispositions,
      PLAN_REVIEW_LIMITS.maxFindings,
      'Plan review contains too many dispositions.',
    ).map(assertAuthorizedDisposition);
    if (
      dispositions.length === 0 ||
      dispositions.some(
        (entry, index) =>
          index > 0 &&
          entry.challengeId <= dispositions[index - 1]!.challengeId,
      )
    ) {
      throw planReviewInvalid(
        'Authorized dispositions are empty, duplicated, or unsorted.',
      );
    }
    const authority = assertPlanReviewChallengeClosureAuthority(
      output.authority,
    );
    const payload = canonicalPlanReviewChallengeClosurePayload(authority);
    if (
      authority.reviewNodeId !== validated.provenanceParentNodeIds.review ||
      authority.reviewResultDigest !==
        validated.semanticParentResultDigests.review ||
      authority.dispositionsDigest !==
        authorizedDispositionDigest(dispositions) ||
      validated.exactInputDigests.authority !== sha256(payload) ||
      validated.exactInputDigests.dispositions !==
        authority.dispositionsDigest ||
      validated.exactInputDigests.signature !== sha256(authority.signature) ||
      dispositions.some(({ author }) => author !== authority.signer)
    ) {
      throw planReviewInvalid(
        'Authorized disposition authority is not bound to its exact review and decisions.',
      );
    }
    return deepFreeze({
      schemaVersion: 2,
      reviewNodeId: authority.reviewNodeId,
      reviewResultDigest: authority.reviewResultDigest,
      policyDigest: validated.policyDigest,
      dispositions,
      authority,
    });
  }

  function assertAuthorizedPlanReviewChallengeClosure(input: {
    dispositionNode: EvidenceNode;
    reviewNode: EvidenceNode;
    expected: {
      repositoryId: string;
      changeId: string;
      investigationId: string;
      baselineCommit: string;
      baselineTree: string;
      subjectDigest: string;
      planningGenerationId: string;
      authorId: string;
    };
    policy: MaintainerPolicy;
  }): AuthorizedPlanReviewDispositionRecord {
    const record = readPlanReviewDispositionNode(input.dispositionNode);
    const review = readPlanReviewNode(input.reviewNode);
    if (record.schemaVersion !== 2) {
      throw planReviewInvalid(
        'Global review challenges require an authenticated v2 disposition.',
      );
    }
    const authority = record.authority;
    const expected = input.expected;
    if (
      authority.repositoryId !== expected.repositoryId ||
      authority.changeId !== expected.changeId ||
      authority.investigationId !== expected.investigationId ||
      authority.baselineCommit !== expected.baselineCommit ||
      authority.baselineTree !== expected.baselineTree ||
      authority.subjectDigest !== expected.subjectDigest ||
      authority.planningGenerationId !== expected.planningGenerationId ||
      authority.authorId !== expected.authorId ||
      authority.reviewNodeId !== input.reviewNode.nodeId ||
      authority.reviewResultDigest !== input.reviewNode.resultDigest ||
      authority.subjectDigest !== review.subjectDigest ||
      authority.planningGenerationId !== review.planningGenerationId ||
      authority.repositoryId !== input.policy.repository.id ||
      authority.signer === authority.authorId
    ) {
      throw planReviewInvalid(
        'Authenticated challenge closure does not match the current planning authority.',
      );
    }
    const signer = input.policy.trustedSigners.find(
      ({ identity }) => identity === authority.signer,
    );
    if (signer === undefined) {
      throw planReviewInvalid(
        'Challenge closure signer is not trusted by the baseline policy.',
      );
    }
    verifySshSignatureWithPublicKey(
      canonicalPlanReviewChallengeClosurePayload(authority),
      authority.signature,
      authority.signer,
      signer.publicKey,
      PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE,
    );
    const challenges: Challenge[] = review.findings.map((finding) => ({
      challengeId: finding.findingId,
      raisedBy: review.assignment.providerId,
      severity:
        finding.severity === 'critical' ? 'forbidden-floor' : 'ordinary',
      targetId: finding.findingId,
    }));
    const closures: ChallengeClosure[] = record.dispositions.map((entry) => ({
      challengeId: entry.challengeId,
      disposition: entry.decision,
      closedBy: authority.signer,
      ...(entry.supersededBy === null
        ? {}
        : { supersededBy: entry.supersededBy }),
    }));
    assertAuthorizedReviewChallengeClosure({
      expectedSubjectDigest: expected.subjectDigest,
      authoritySubjectDigest: authority.subjectDigest,
      authenticatedCloserId: authority.signer,
      challenges,
      closures,
      context: {
        authorId: authority.authorId,
        reviewerIds: [authority.signer],
        domainOwnerIds:
          authority.role === 'domain-owner' ? [authority.signer] : [],
      },
    });
    return record;
  }

  function planReviewDispositionDigest(
    dispositions: PlanReviewDispositionEntry[],
  ): string {
    return sha256(
      canonicalJson({
        schema: 'plan-review-disposition-input.v1',
        dispositions,
      }),
    );
  }

  function assertDisposition(value: unknown): PlanReviewDispositionEntry {
    const record = assertExactKeys(value, [
      'challengeId',
      'decision',
      'rationale',
      'author',
    ]);
    const challengeId = record.challengeId;
    const decision = record.decision;
    const rationale = record.rationale;
    const author = record.author;
    if (!isDigest(challengeId)) {
      throw planReviewInvalid('Disposition challenge identity is malformed.');
    }
    if (typeof decision !== 'string' || !DISPOSITION_DECISIONS.has(decision)) {
      throw planReviewInvalid('Disposition decision is unexpected.');
    }
    if (
      !isBoundedNonBlankText(
        rationale,
        PLAN_REVIEW_LIMITS.maxDispositionRationaleBytes,
      )
    ) {
      throw planReviewInvalid('Disposition rationale is required.');
    }
    if (!isBoundedNonBlankText(author, PLAN_REVIEW_LIMITS.maxAuthorBytes)) {
      throw planReviewInvalid('Disposition author is required.');
    }
    return {
      challengeId,
      decision: decision as PlanReviewDispositionDecision,
      rationale: rationale as string,
      author: author as string,
    };
  }

  function assertAuthorizedDisposition(
    value: unknown,
  ): AuthorizedPlanReviewDispositionEntry {
    const record = assertExactKeys(value, [
      'challengeId',
      'decision',
      'rationale',
      'author',
      'supersededBy',
    ]);
    if (
      !isDigest(record.challengeId) ||
      typeof record.decision !== 'string' ||
      !AUTHORIZED_DISPOSITION_DECISIONS.has(record.decision) ||
      !isBoundedNonBlankText(
        record.rationale,
        PLAN_REVIEW_LIMITS.maxDispositionRationaleBytes,
      ) ||
      !isBoundedNonBlankText(
        record.author,
        PLAN_REVIEW_LIMITS.maxAuthorBytes,
      ) ||
      (record.supersededBy !== null && !isDigest(record.supersededBy)) ||
      (record.decision === 'superseded') !==
        (typeof record.supersededBy === 'string')
    ) {
      throw planReviewInvalid(
        'Authenticated plan review disposition is malformed.',
      );
    }
    return {
      challengeId: record.challengeId as string,
      decision: record.decision as AuthorizedPlanReviewDispositionDecision,
      rationale: record.rationale as string,
      author: record.author as string,
      supersededBy: record.supersededBy as string | null,
    };
  }

  function assertDispositionChallengeSet(
    review: PlanReviewReport,
    dispositions: readonly { challengeId: string }[],
  ): void {
    if (dispositions.length === 0) {
      throw planReviewInvalid('Plan review disposition set must not be empty.');
    }
    const challengeIds = new Set(
      review.findings.map((finding) => finding.findingId),
    );
    const seen = new Set<string>();
    for (const disposition of dispositions) {
      if (!challengeIds.has(disposition.challengeId)) {
        throw planReviewInvalid('Disposition names an unknown challenge.');
      }
      if (seen.has(disposition.challengeId)) {
        throw planReviewInvalid('Disposition duplicates a challenge.');
      }
      seen.add(disposition.challengeId);
    }
  }

  function assertPlanReviewChallengeClosureAuthority(
    value: unknown,
  ): PlanReviewChallengeClosureAuthority {
    const record = assertExactKeys(value, [
      'schemaVersion',
      'kind',
      'namespace',
      'repositoryId',
      'changeId',
      'investigationId',
      'baselineCommit',
      'baselineTree',
      'subjectDigest',
      'planningGenerationId',
      'reviewNodeId',
      'reviewResultDigest',
      'dispositionsDigest',
      'authorId',
      'role',
      'signer',
      'issuedAt',
      'signature',
    ]);
    if (
      record.schemaVersion !== 1 ||
      record.kind !== 'plan-review-challenge-closure-authority' ||
      record.namespace !== PLAN_REVIEW_CHALLENGE_CLOSURE_NAMESPACE ||
      !isBoundedNonBlankText(
        record.repositoryId,
        PLAN_REVIEW_LIMITS.maxAuthorBytes,
      ) ||
      !isBoundedNonBlankText(
        record.changeId,
        PLAN_REVIEW_LIMITS.maxAuthorBytes,
      ) ||
      !isBoundedNonBlankText(
        record.investigationId,
        PLAN_REVIEW_LIMITS.maxAuthorBytes,
      ) ||
      typeof record.baselineCommit !== 'string' ||
      !GIT_OBJECT_ID_PATTERN.test(record.baselineCommit) ||
      typeof record.baselineTree !== 'string' ||
      !GIT_OBJECT_ID_PATTERN.test(record.baselineTree) ||
      !isDigest(record.subjectDigest) ||
      !isDigest(record.planningGenerationId) ||
      !isDigest(record.reviewNodeId) ||
      !isDigest(record.reviewResultDigest) ||
      !isDigest(record.dispositionsDigest) ||
      !isBoundedNonBlankText(
        record.authorId,
        PLAN_REVIEW_LIMITS.maxAuthorBytes,
      ) ||
      (record.role !== 'reviewer' && record.role !== 'domain-owner') ||
      !isBoundedNonBlankText(
        record.signer,
        PLAN_REVIEW_LIMITS.maxAuthorBytes,
      ) ||
      typeof record.issuedAt !== 'string' ||
      !Number.isFinite(Date.parse(record.issuedAt)) ||
      new Date(record.issuedAt).toISOString() !== record.issuedAt ||
      !isBoundedNonBlankText(record.signature, 64 * 1024)
    ) {
      throw planReviewInvalid(
        'Plan review challenge closure authority is malformed.',
      );
    }
    return record as PlanReviewChallengeClosureAuthority;
  }

  function authorizedDispositionDigest(
    dispositions: readonly AuthorizedPlanReviewDispositionEntry[],
  ): string {
    return sha256(
      canonicalJson({
        schema: 'plan-review-disposition-input.v2',
        dispositions,
      }),
    );
  }

  function canonicalPlanReviewChallengeClosurePayload(
    authority: PlanReviewChallengeClosureAuthority,
  ): string {
    const { signature: _signature, ...payload } = authority;
    return `${canonicalJson(payload)}\n`;
  }

  return {
    createPlanReviewDispositionNode,
    createAuthorizedPlanReviewDispositionNode,
    readPlanReviewDispositionNode,
    assertAuthorizedPlanReviewChallengeClosure,
  };
}
