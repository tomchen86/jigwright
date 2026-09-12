import type { CollaborationGrantCodec } from './collaboration-grant-codec.ts';
/**
 * Validates exact collaboration assignments, structured content, and consumed-use projections.
 *
 * Invariants:
 * - Degraded role authority retains participant, independence, attestation, and content bindings.
 * - Consumed-use validation does not turn referenced content into governing authority.
 */
import {
  COLLABORATION_GRANT_AUTHORIZED_EFFECT,
  type CollaborationGrantEnvelope,
  COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
  COLLABORATION_GRANT_REPLAY_SCOPE,
  COLLABORATION_GRANT_RESIDUALS,
  type DirectHumanReviewAttestation,
  type CollaborationLifecyclePhase,
} from './collaboration-grant-codec.ts';
import type {
  CollaborationGrantUseValidationOptions,
  CollaborationGrantUseProjection,
  CollaborationGrantUseValidationEntry,
  CollaborationGrantedAssignmentRecord,
  CollaborationParticipantRecord,
  CollaborationStructuredContent,
  CollaborationContentAdmission,
  CollaborationConsumptionRequest,
} from './collaboration-grant-records.ts';
import {
  isRecord,
  invalidUse,
  exactDate,
  exactDigest,
  hasExactKeys,
  DIGEST,
  isExactTimestamp,
  ambiguousGrant,
  deepFreeze,
} from './collaboration-grant-values.ts';
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

function assertTaskDiffChallengeClosureAuthorityOverride(
  value: unknown,
  role: unknown,
  targetDigest: unknown,
): NonNullable<
  CollaborationGrantedAssignmentRecord['degradedAuthorityOverride']
> {
  if (
    role !== 'task-diff-reviewer' ||
    !isRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'targetDigest',
      'subjectDigest',
      'reviewRecordDigest',
      'responseDigest',
    ]) ||
    value.kind !== 'task-diff-challenge-closure' ||
    typeof targetDigest !== 'string' ||
    value.targetDigest !== targetDigest ||
    typeof value.subjectDigest !== 'string' ||
    !DIGEST.test(value.subjectDigest) ||
    typeof value.reviewRecordDigest !== 'string' ||
    !DIGEST.test(value.reviewRecordDigest) ||
    typeof value.responseDigest !== 'string' ||
    !DIGEST.test(value.responseDigest) ||
    value.targetDigest !==
      crypto
        .createHash('sha256')
        .update(
          canonicalJson({
            schema: 'workflow.task-diff-external-continuation-target.v1',
            subjectDigest: value.subjectDigest,
            reviewRecordDigest: value.reviewRecordDigest,
            responseDigest: value.responseDigest,
          }),
        )
        .digest('hex')
  ) {
    throw invalidUse();
  }
  return deepFreeze({
    kind: 'task-diff-challenge-closure',
    targetDigest: value.targetDigest,
    subjectDigest: value.subjectDigest,
    reviewRecordDigest: value.reviewRecordDigest,
    responseDigest: value.responseDigest,
  });
}

function assertRecordedParticipant(
  value: unknown,
): CollaborationParticipantRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'providerId',
      'sessionId',
      'principalId',
      'identityAssurance',
      'engineSpawned',
    ]) ||
    ![null, 'codex', 'claude'].includes(value.providerId as null | string) ||
    (value.sessionId !== null &&
      (typeof value.sessionId !== 'string' || value.sessionId.length === 0)) ||
    (value.principalId !== null &&
      (typeof value.principalId !== 'string' ||
        value.principalId.length === 0)) ||
    ![
      'self-declared',
      'runtime-hint',
      'adapter-assigned',
      'maintainer-signed',
    ].includes(String(value.identityAssurance)) ||
    typeof value.engineSpawned !== 'boolean'
  ) {
    throw invalidUse();
  }
  return deepFreeze({
    providerId: value.providerId as 'codex' | 'claude' | null,
    sessionId: value.sessionId as string | null,
    principalId: value.principalId as string | null,
    identityAssurance: value.identityAssurance as
      | 'self-declared'
      | 'runtime-hint'
      | 'adapter-assigned'
      | 'maintainer-signed',
    engineSpawned: value.engineSpawned,
  });
}

function assertCallableProviderIds(
  value: unknown,
): readonly ('codex' | 'claude')[] {
  if (
    !Array.isArray(value) ||
    value.some((providerId) => !['codex', 'claude'].includes(providerId)) ||
    value.length !== new Set(value).size ||
    JSON.stringify(value) !== JSON.stringify([...value].sort())
  ) {
    throw invalidUse();
  }
  return Object.freeze([...value] as ('codex' | 'claude')[]);
}

function assertStructuredContent(
  value: unknown,
  phase: CollaborationLifecyclePhase,
): CollaborationStructuredContent {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'nodeId', 'resultDigest']) ||
    value.kind !== phase ||
    typeof value.nodeId !== 'string' ||
    !DIGEST.test(value.nodeId) ||
    typeof value.resultDigest !== 'string' ||
    !DIGEST.test(value.resultDigest)
  ) {
    throw invalidUse();
  }
  return deepFreeze({
    kind: value.kind,
    nodeId: value.nodeId,
    resultDigest: value.resultDigest,
  } as CollaborationStructuredContent);
}

export function assertContentAdmission(
  value: unknown,
  phase: CollaborationLifecyclePhase,
): CollaborationContentAdmission {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['kind', 'nodeId', 'resultDigest', 'current']) ||
    value.current !== true
  ) {
    throw invalidUse();
  }
  const structured = assertStructuredContent(
    {
      kind: value.kind,
      nodeId: value.nodeId,
      resultDigest: value.resultDigest,
    },
    phase,
  );
  return deepFreeze({ ...structured, current: true });
}

export function createCollaborationGrantUseValidator(
  codec: Pick<
    CollaborationGrantCodec,
    | 'parseCollaborationGrantEnvelope'
    | 'validateCollaborationGrantEnvelope'
    | 'validateDirectHumanReviewAttestation'
    | 'collaborationGrantEnvelopeDigest'
    | 'canonicalCollaborationGrantEnvelope'
    | 'parseDirectHumanReviewAttestation'
    | 'canonicalDirectHumanReviewAttestation'
    | 'directHumanReviewAttestationDigest'
  >,
) {
  const {
    parseCollaborationGrantEnvelope,
    validateCollaborationGrantEnvelope,
    validateDirectHumanReviewAttestation,
    collaborationGrantEnvelopeDigest,
    canonicalCollaborationGrantEnvelope,
    parseDirectHumanReviewAttestation,
    canonicalDirectHumanReviewAttestation,
    directHumanReviewAttestationDigest,
  } = codec;
  /**
   * Recompute the portable, trust-relevant meaning of a consumed collaboration
   * grant without reading Git-common-dir bearer state. Local and CI callers must
   * supply independently derived assignment and current content admission facts;
   * references stored in the use projection never validate themselves.
   */
  function validateCollaborationGrantUseProjection(
    value: unknown,
    options: CollaborationGrantUseValidationOptions,
  ): CollaborationGrantUseProjection {
    if (!isRecord(value)) {
      throw invalidUse();
    }
    let envelope: CollaborationGrantEnvelope;
    let use: CollaborationGrantUseProjection;
    try {
      envelope = parseCollaborationGrantEnvelope(
        `${JSON.stringify(value.envelope)}\n`,
      );
      use = assertStoredUse(value, envelope);
      validateCollaborationGrantEnvelope(envelope, options.policy, {
        now: exactDate(options.now),
        expected: options.expectedBinding,
        verifier: options.verifier,
        allowExpired: true,
      });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        String(error.code).startsWith('COLLABORATION_SIGNATURE')
      ) {
        throw error;
      }
      throw invalidUse();
    }
    const transitionDigest = exactDigest(
      options.transitionDigest,
      'transition digest',
    );
    const expectedAssignment = assertGrantedAssignment(
      options.expectedAssignment,
      envelope,
    );
    const contentAdmission = assertContentAdmission(
      options.contentAdmission,
      envelope.payload.lifecyclePhase,
    );
    if (
      use.transitionDigest !== transitionDigest ||
      JSON.stringify(use.assignment) !== JSON.stringify(expectedAssignment) ||
      JSON.stringify(use.structuredContent) !==
        JSON.stringify({
          kind: contentAdmission.kind,
          nodeId: contentAdmission.nodeId,
          resultDigest: contentAdmission.resultDigest,
        })
    ) {
      throw invalidUse();
    }
    if (envelope.payload.degradedForm === 'direct-human-review') {
      if (!use.directHumanReviewAttestation) {
        throw invalidUse();
      }
      try {
        validateDirectHumanReviewAttestation(use.directHumanReviewAttestation, {
          now: exactDate(options.now),
          grantEnvelope: envelope,
          policy: options.policy,
          verifier: options.verifier,
          transitionDigest,
          reviewNodeId: contentAdmission.nodeId,
          reviewResultDigest: contentAdmission.resultDigest,
        });
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          String(error.code).startsWith('COLLABORATION_SIGNATURE')
        ) {
          throw error;
        }
        throw invalidUse();
      }
    }
    return use;
  }

  /**
   * Validate the complete tracked closure, not merely one projection. A locally
   * consumed grant is still cooperative common-dir state; history-wide one-use
   * follows only when the governing transition passes every projected use
   * through this aggregate validator.
   */
  function validateCollaborationGrantUseSet(
    entries: readonly CollaborationGrantUseValidationEntry[],
  ): readonly CollaborationGrantUseProjection[] {
    if (!Array.isArray(entries)) {
      throw invalidUse();
    }
    const uses = entries.map(({ value, options }) =>
      validateCollaborationGrantUseProjection(value, options),
    );
    const grantIds = new Set<string>();
    const envelopeDigests = new Set<string>();
    for (const use of uses) {
      if (
        grantIds.has(use.grantId) ||
        envelopeDigests.has(use.signedEnvelopeDigest)
      ) {
        throw invalidUse();
      }
      grantIds.add(use.grantId);
      envelopeDigests.add(use.signedEnvelopeDigest);
    }
    return Object.freeze(uses);
  }

  function assertStoredUse(
    value: unknown,
    envelope: CollaborationGrantEnvelope,
  ): CollaborationGrantUseProjection {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'grantId',
        'signedEnvelopeDigest',
        'transitionDigest',
        'reservedAt',
        'lifecyclePhase',
        'targetDigest',
        'degradedForm',
        'authorizedEffect',
        'assignment',
        'structuredContent',
        'contentAuthority',
        'directHumanReviewAttestation',
        'retainedObligations',
        'replayScope',
        'residuals',
        'envelope',
      ]) ||
      value.schemaVersion !== 1 ||
      value.grantId !== envelope.payload.grantId ||
      value.signedEnvelopeDigest !==
        collaborationGrantEnvelopeDigest(envelope) ||
      typeof value.transitionDigest !== 'string' ||
      !DIGEST.test(value.transitionDigest) ||
      typeof value.reservedAt !== 'string' ||
      !isExactTimestamp(value.reservedAt) ||
      Date.parse(value.reservedAt) < Date.parse(envelope.payload.issuedAt) ||
      Date.parse(value.reservedAt) > Date.parse(envelope.payload.expiresAt) ||
      value.lifecyclePhase !== envelope.payload.lifecyclePhase ||
      value.targetDigest !== envelope.payload.targetDigest ||
      value.degradedForm !== envelope.payload.degradedForm ||
      value.authorizedEffect !== COLLABORATION_GRANT_AUTHORIZED_EFFECT ||
      value.contentAuthority !==
        'reference-only-requires-governing-validator' ||
      !Array.isArray(value.retainedObligations) ||
      JSON.stringify(value.retainedObligations) !==
        JSON.stringify(COLLABORATION_GRANT_RETAINED_OBLIGATIONS) ||
      value.replayScope !== COLLABORATION_GRANT_REPLAY_SCOPE ||
      !Array.isArray(value.residuals) ||
      JSON.stringify(value.residuals) !==
        JSON.stringify(COLLABORATION_GRANT_RESIDUALS) ||
      canonicalCollaborationGrantEnvelope(
        parseCollaborationGrantEnvelope(`${JSON.stringify(value.envelope)}\n`),
      ) !== canonicalCollaborationGrantEnvelope(envelope)
    ) {
      throw ambiguousGrant(envelope.payload.grantId);
    }
    const assignment = assertGrantedAssignment(value.assignment, envelope);
    const structuredContent = assertStructuredContent(
      value.structuredContent,
      envelope.payload.lifecyclePhase,
    );
    const directHumanReviewAttestation = assertDirectHumanAttestationReference(
      value.directHumanReviewAttestation,
      assignment,
      envelope,
      value.transitionDigest,
      structuredContent,
    );
    return deepFreeze({
      schemaVersion: 1,
      grantId: envelope.payload.grantId,
      signedEnvelopeDigest: collaborationGrantEnvelopeDigest(envelope),
      transitionDigest: value.transitionDigest,
      reservedAt: value.reservedAt,
      lifecyclePhase: envelope.payload.lifecyclePhase,
      targetDigest: envelope.payload.targetDigest,
      degradedForm: envelope.payload.degradedForm,
      authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
      assignment,
      structuredContent,
      contentAuthority: 'reference-only-requires-governing-validator',
      directHumanReviewAttestation,
      retainedObligations: COLLABORATION_GRANT_RETAINED_OBLIGATIONS,
      replayScope: COLLABORATION_GRANT_REPLAY_SCOPE,
      residuals: COLLABORATION_GRANT_RESIDUALS,
      envelope,
    });
  }

  function assertGrantedAssignment(
    value: unknown,
    envelope: CollaborationGrantEnvelope,
  ): CollaborationGrantedAssignmentRecord {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'role',
        'providerId',
        'sessionId',
        'targetDigest',
        'requiredIndependence',
        'achievedIndependence',
        'providerIndependent',
        'sessionIndependent',
        'engineSpawned',
        'orchestration',
        'grantId',
        'degradedForm',
        'authorizedEffect',
        'author',
        'participant',
        'callableProviderIds',
        ...('degradedAuthorityOverride' in value
          ? ['degradedAuthorityOverride']
          : []),
        'directHumanReviewAttestationDigest',
      ]) ||
      value.role !== envelope.payload.rolePair.conflictingRole ||
      value.targetDigest !== envelope.payload.targetDigest ||
      value.requiredIndependence !== 'provider-independent' ||
      value.providerIndependent !== false ||
      value.grantId !== envelope.payload.grantId ||
      value.degradedForm !== envelope.payload.degradedForm ||
      value.authorizedEffect !== COLLABORATION_GRANT_AUTHORIZED_EFFECT
    ) {
      throw invalidUse();
    }
    const common = {
      role: envelope.payload.rolePair.conflictingRole,
      targetDigest: value.targetDigest,
      requiredIndependence: 'provider-independent' as const,
      providerIndependent: false as const,
      grantId: value.grantId,
      degradedForm: envelope.payload.degradedForm,
      authorizedEffect: COLLABORATION_GRANT_AUTHORIZED_EFFECT,
      author: assertRecordedParticipant(value.author),
      participant: assertRecordedParticipant(value.participant),
      callableProviderIds: assertCallableProviderIds(value.callableProviderIds),
      ...('degradedAuthorityOverride' in value
        ? {
            degradedAuthorityOverride:
              assertTaskDiffChallengeClosureAuthorityOverride(
                value.degradedAuthorityOverride,
                value.role,
                value.targetDigest,
              ),
          }
        : {}),
    };
    if (
      envelope.payload.degradedForm === 'same-provider-fresh-session' &&
      envelope.payload.availableActor.kind === 'provider' &&
      value.providerId === envelope.payload.availableActor.providerId &&
      typeof value.sessionId === 'string' &&
      value.sessionId.length > 0 &&
      value.achievedIndependence === 'session-independent' &&
      value.sessionIndependent === true &&
      value.engineSpawned === true &&
      value.orchestration === 'engine-spawned-provider'
    ) {
      if (
        common.author.providerId !==
          envelope.payload.availableActor.providerId ||
        common.participant.providerId !==
          envelope.payload.availableActor.providerId ||
        common.participant.sessionId !== value.sessionId ||
        common.participant.engineSpawned !== true ||
        common.participant.identityAssurance !==
          envelope.payload.availableActor.assurance ||
        typeof common.author.sessionId !== 'string' ||
        common.author.sessionId === common.participant.sessionId ||
        JSON.stringify(common.callableProviderIds) !==
          JSON.stringify([envelope.payload.availableActor.providerId]) ||
        common.degradedAuthorityOverride !== undefined ||
        value.directHumanReviewAttestationDigest !== null
      ) {
        throw invalidUse();
      }
      return deepFreeze({
        ...common,
        providerId: envelope.payload.availableActor.providerId,
        sessionId: value.sessionId,
        achievedIndependence: 'session-independent',
        sessionIndependent: true,
        engineSpawned: true,
        orchestration: 'engine-spawned-provider',
        directHumanReviewAttestationDigest: null,
      });
    }
    const expectedOrchestration =
      envelope.payload.degradedForm === 'caller-supplied'
        ? 'caller-supplied'
        : 'direct-human-review';
    if (
      envelope.payload.degradedForm !== 'same-provider-fresh-session' &&
      value.providerId === null &&
      value.sessionId === null &&
      value.achievedIndependence === 'none' &&
      value.sessionIndependent === false &&
      value.engineSpawned === false &&
      value.orchestration === expectedOrchestration
    ) {
      const expectedPrincipal =
        envelope.payload.availableActor.kind === 'caller'
          ? envelope.payload.availableActor.callerId
          : envelope.payload.availableActor.kind === 'direct-human'
            ? envelope.payload.availableActor.identity
            : undefined;
      if (
        common.participant.providerId !== null ||
        common.participant.sessionId !== null ||
        common.participant.engineSpawned !== false ||
        common.participant.principalId !== expectedPrincipal ||
        common.callableProviderIds.length !== 0 ||
        (envelope.payload.degradedForm === 'caller-supplied'
          ? value.directHumanReviewAttestationDigest !== null ||
            common.participant.identityAssurance !==
              envelope.payload.availableActor.assurance ||
            (value.role !== 'task-implementer' &&
              (common.author.principalId === null ||
                common.participant.principalId === common.author.principalId))
          : typeof value.directHumanReviewAttestationDigest !== 'string' ||
            !DIGEST.test(value.directHumanReviewAttestationDigest) ||
            common.participant.identityAssurance !== 'maintainer-signed')
      ) {
        throw invalidUse();
      }
      return deepFreeze({
        ...common,
        providerId: null,
        sessionId: null,
        achievedIndependence: 'none',
        sessionIndependent: false,
        engineSpawned: false,
        orchestration: expectedOrchestration,
        directHumanReviewAttestationDigest:
          value.directHumanReviewAttestationDigest as string | null,
      });
    }
    throw invalidUse();
  }

  function assertDirectHumanAttestationReference(
    value: unknown,
    assignment: CollaborationGrantedAssignmentRecord,
    envelope: CollaborationGrantEnvelope,
    transitionDigest: unknown,
    structuredContent: CollaborationStructuredContent,
  ): DirectHumanReviewAttestation | null {
    if (envelope.payload.degradedForm !== 'direct-human-review') {
      if (
        value !== null ||
        assignment.directHumanReviewAttestationDigest !== null
      ) {
        throw invalidUse();
      }
      return null;
    }
    if (
      value === null ||
      assignment.directHumanReviewAttestationDigest === null
    ) {
      throw invalidUse();
    }
    const parsed = parseDirectHumanReviewAttestation(
      canonicalDirectHumanReviewAttestation(
        value as DirectHumanReviewAttestation,
      ),
    );
    if (
      parsed.payload.grantId !== envelope.payload.grantId ||
      parsed.payload.signedEnvelopeDigest !==
        collaborationGrantEnvelopeDigest(envelope) ||
      parsed.payload.transitionDigest !== transitionDigest ||
      parsed.payload.targetDigest !== envelope.payload.targetDigest ||
      parsed.payload.reviewNodeId !== structuredContent.nodeId ||
      parsed.payload.reviewResultDigest !== structuredContent.resultDigest ||
      directHumanReviewAttestationDigest(parsed) !==
        assignment.directHumanReviewAttestationDigest
    ) {
      throw invalidUse();
    }
    return parsed;
  }

  function consumptionMatches(
    use: CollaborationGrantUseProjection,
    request: CollaborationConsumptionRequest,
    transitionDigest: string,
  ): boolean {
    try {
      const assignment = assertGrantedAssignment(
        request.assignment,
        use.envelope,
      );
      const contentAdmission = assertContentAdmission(
        request.contentAdmission,
        use.lifecyclePhase,
      );
      const structuredContent: CollaborationStructuredContent = {
        kind: contentAdmission.kind,
        nodeId: contentAdmission.nodeId,
        resultDigest: contentAdmission.resultDigest,
      };
      const directHumanReviewAttestation =
        assertDirectHumanAttestationReference(
          request.directHumanReviewAttestation ?? null,
          assignment,
          use.envelope,
          transitionDigest,
          structuredContent,
        );
      return (
        use.transitionDigest === transitionDigest &&
        JSON.stringify(use.assignment) === JSON.stringify(assignment) &&
        JSON.stringify(use.structuredContent) ===
          JSON.stringify(structuredContent) &&
        JSON.stringify(use.directHumanReviewAttestation) ===
          JSON.stringify(directHumanReviewAttestation)
      );
    } catch {
      return false;
    }
  }
  return {
    validateCollaborationGrantUseProjection,
    validateCollaborationGrantUseSet,
    assertStoredUse,
    assertGrantedAssignment,
    assertDirectHumanAttestationReference,
    consumptionMatches,
  };
}
export type CollaborationGrantUseValidator = ReturnType<
  typeof createCollaborationGrantUseValidator
>;
