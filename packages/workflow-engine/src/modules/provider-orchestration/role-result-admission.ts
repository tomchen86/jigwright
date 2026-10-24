/**
 * Admits role results and replays their ordinary or granted participant
 * authority.
 *
 * Invariants:
 * - Submitted content must match the assigned reviewer or implementer role.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  computeRoleContextSharingResultAdmissionDigestV1,
  consumedRoleContextSharingUseForReplay,
} from '../authority/role-context-sharing-consumed-replay.ts';
import type { DirectHumanReviewAttestation } from '../authority/collaboration-grant-codec.ts';
import { isProviderId } from './provider-registry.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import type { RoleResultAdmissionBindings } from './role-scheduler.ts';
import type {
  AdmittedRoleResult,
  AdmitRoleResultInput,
  AdmitConsumedRoleResultReplayInput,
  AdmitRoleContextSharingResultInput,
  RoleContextSharingResultAdmissionBindingInput,
  NormalizedRoleContextSharingResultAdmissionBinding,
  AdmitConsumedRoleContextSharingResultReplayInput,
  RoleProviderInvocationEvidence,
  RoleContentAdmission,
} from './role-admission-contracts.ts';
import type { CollaborationGrantUseProjection } from '../authority/collaboration-grant-records.ts';

import type {
  GrantedRoleAssignment,
  GrantedSameProviderRoleAssignment,
  RoleAssignment,
  ProviderRoleAssignment,
  RoleParticipant,
  RecordedRoleParticipant,
} from './role-assignment.ts';
import type { IndependenceDimension } from './role-independence.ts';

export function createRoleResultAdmission(
  bindings: RoleResultAdmissionBindings,
) {
  const {
    bindingFromRoleContextSharingGrantPayloadV1,
    canonicalRoleContextSharingGrantEnvelopeV1,
    directHumanReviewAttestationDigest,
    hasExactKeys,
    deepFreeze,
    consumedCollaborationGrantUseForReplay,
    validateCollaborationGrantUseProjection,
  } = bindings;

  const ADMITTED_ROLE_RESULT_COMMON_KEYS = [
    'schemaVersion',
    'form',
    'role',
    'targetDigest',
    'assignment',
    'author',
    'participant',
    'orchestration',
    'requiredIndependence',
    'achievedIndependence',
    'content',
    'providerInvocation',
    'grantUse',
    'directHumanReviewAttestation',
    'resultDigest',
  ] as const;

  /**
   * Re-admit the exact immutable role-result record before any consumer uses its
   * author, participant, or orchestration facts. Grant-backed v1 results still
   * require their normal external consumed-use replay at the authority boundary;
   * this content-pure reader prevents an embedded record from changing facts
   * while retaining the digest minted by that replay.
   */
  function assertAdmittedRoleResultRecord(value: unknown): AdmittedRoleResult {
    if (!value || typeof value !== 'object') {
      throw roleResultInvalid();
    }
    const schemaVersion = Reflect.get(value, 'schemaVersion');
    const expectedKeys =
      schemaVersion === 2
        ? [...ADMITTED_ROLE_RESULT_COMMON_KEYS, 'roleContextSharingUse']
        : ADMITTED_ROLE_RESULT_COMMON_KEYS;
    if (
      (schemaVersion !== 1 && schemaVersion !== 2) ||
      !hasExactKeys(value, expectedKeys)
    ) {
      throw roleResultInvalid();
    }
    const record = structuredClone(value) as unknown as AdmittedRoleResult;
    const { resultDigest, ...semantic } = record;
    const expectedDigest = crypto
      .createHash('sha256')
      .update(
        canonicalJson({
          schema: `admitted-role-result.v${schemaVersion}`,
          ...semantic,
        }),
      )
      .digest('hex');
    if (
      !/^[0-9a-f]{64}$/.test(resultDigest) ||
      resultDigest !== expectedDigest ||
      !/^[0-9a-f]{64}$/.test(record.targetDigest) ||
      (record.requiredIndependence !== 'provider-independent' &&
        record.requiredIndependence !== 'session-independent') ||
      !record.assignment ||
      typeof record.assignment !== 'object' ||
      record.assignment.role !== record.role ||
      record.assignment.targetDigest !== record.targetDigest ||
      canonicalJson(normalizeRecordedParticipant(record.author)) !==
        canonicalJson(record.author) ||
      canonicalJson(normalizeRecordedParticipant(record.participant)) !==
        canonicalJson(record.participant) ||
      canonicalJson(assertRoleContentAdmission(record.content)) !==
        canonicalJson(record.content)
    ) {
      throw roleResultInvalid();
    }
    if (schemaVersion === 2) {
      if (record.form !== 'granted-role-context-sharing') {
        throw roleResultInvalid();
      }
      const replayed = admitRoleContextSharingResult({
        assignment: record.assignment,
        author: record.author,
        participant: record.participant,
        content: record.content,
        providerInvocation: record.providerInvocation,
        consumedUse: record.roleContextSharingUse,
      });
      if (canonicalJson(replayed) !== canonicalJson(record)) {
        throw roleResultInvalid();
      }
      return replayed;
    }
    if (record.form === 'ordinary-provider') {
      const replayed = admitRoleResult({
        assignment: record.assignment,
        author: record.author,
        participant: record.participant,
        content: record.content,
        providerInvocation: record.providerInvocation,
        grantUse: null,
        grantValidation: null,
      });
      if (canonicalJson(replayed) !== canonicalJson(record)) {
        throw roleResultInvalid();
      }
      return replayed;
    }
    if (
      !record.grantUse ||
      typeof record.grantUse !== 'object' ||
      (record.form === 'granted-same-provider'
        ? record.orchestration !== 'engine-spawned-provider' ||
          record.achievedIndependence !== 'session-independent' ||
          record.providerInvocation === null ||
          record.directHumanReviewAttestation !== null
        : record.form === 'granted-caller-supplied'
          ? record.orchestration !== 'caller-supplied' ||
            record.achievedIndependence !== 'none' ||
            record.providerInvocation !== null ||
            record.directHumanReviewAttestation !== null
          : record.form === 'direct-human-attestation'
            ? record.orchestration !== 'direct-human-review' ||
              record.achievedIndependence !== 'none' ||
              record.providerInvocation !== null ||
              !record.directHumanReviewAttestation
            : true)
    ) {
      throw roleResultInvalid();
    }
    return deepFreeze(record);
  }

  const ORDINARY_ASSIGNMENT_KEYS = [
    'role',
    'providerId',
    'sessionId',
    'targetDigest',
    'requiredIndependence',
    'achievedIndependence',
  ] as const;

  const ROLE_CONTENT_KEYS = [
    'kind',
    'nodeId',
    'resultDigest',
    'outputSchema',
    'evaluator',
    'policyDigest',
    'contentDigest',
    'current',
  ] as const;

  const OUTPUT_SCHEMA_KEYS = ['id', 'version', 'digest'] as const;

  const PROVIDER_INVOCATION_KEYS = [
    'invocationId',
    'requestDigest',
    'outputDigest',
    'providerId',
    'sessionId',
    'targetDigest',
    'engineSpawned',
  ] as const;

  const RECORDED_PARTICIPANT_KEYS = [
    'providerId',
    'sessionId',
    'principalId',
    'identityAssurance',
    'engineSpawned',
  ] as const;

  /**
   * Admit one exact role result without conflating provider execution with
   * caller-supplied or direct-human content. The result form is derived from the
   * assignment and observed orchestration; callers cannot select a stronger
   * label. Grant-backed forms replay the same signed-use validator used by live
   * grant consumption and CI.
   */
  function admitRoleResult(input: AdmitRoleResultInput): AdmittedRoleResult {
    return admitRoleResultCore(input, null);
  }

  /**
   * Finish the exact role admission whose Collaboration Grant already reached a
   * cryptographically authenticated terminal `consumed` state. This is not a
   * second validation mode for ordinary governing callers: only the opaque
   * consumed crash-replay proof can enter this path.
   */
  function admitConsumedRoleResultReplay(
    input: AdmitConsumedRoleResultReplayInput,
  ): AdmittedRoleResult {
    const grantUse = consumedCollaborationGrantUseForReplay(input.replay);
    return admitRoleResultCore(
      {
        assignment: input.assignment,
        author: input.author,
        participant: input.participant,
        content: input.content,
        providerInvocation: input.providerInvocation,
        grantUse,
        grantValidation: null,
      },
      grantUse,
    );
  }

  function admitRoleContextSharingResult(
    input: AdmitRoleContextSharingResultInput,
  ): AdmittedRoleResult {
    const binding = normalizeRoleContextSharingResultAdmissionBinding(input);
    const { assignment, author, participant, content, providerInvocation } =
      binding;
    const evidence = input.consumedUse;
    const use = evidence?.use;
    const envelope = evidence?.envelope;
    if (
      evidence?.kind !== 'role-context-sharing-consumed-use.v1' ||
      evidence.grantId !== assignment.roleContextSharingGrantId ||
      evidence.reservationReceiptDigest !==
        assignment.reservationReceiptDigest ||
      !/^[0-9a-f]{64}$/.test(evidence.terminalReceiptDigest) ||
      !/^[0-9a-f]{64}$/.test(evidence.terminalRecordDigest) ||
      !/^[0-9a-f]{64}$/.test(evidence.useProjectionDigest) ||
      evidence.useProjectionDigest !==
        crypto.createHash('sha256').update(canonicalJson(use)).digest('hex') ||
      canonicalJson(evidence.expectedBinding) !==
        canonicalJson(
          bindingFromRoleContextSharingGrantPayloadV1(envelope.payload),
        ) ||
      envelope.payload.grantId !== assignment.roleContextSharingGrantId ||
      canonicalJson(envelope.payload.rolePairs) !==
        canonicalJson(assignment.exactRolePairs) ||
      use.providerId !== assignment.providerId ||
      use.sessionId !== assignment.sessionId ||
      use.sharedEngineSessionId !== assignment.sharedEngineSessionId ||
      use.contextGeneration !== assignment.contextGeneration ||
      use.sessionGeneration !== assignment.sessionGeneration ||
      use.providerDefinitionDigest !== assignment.providerDefinitionDigest ||
      use.assignmentDigest !==
        crypto
          .createHash('sha256')
          .update(canonicalJson(assignment))
          .digest('hex') ||
      use.admissionDigest !==
        computeRoleContextSharingResultAdmissionDigestV1(binding)
    ) {
      throw roleResultInvalid();
    }
    canonicalRoleContextSharingGrantEnvelopeV1(envelope);
    const semantic = {
      schemaVersion: 2 as const,
      form: 'granted-role-context-sharing' as const,
      role: assignment.role,
      targetDigest: assignment.targetDigest,
      assignment: structuredClone(assignment),
      author,
      participant,
      orchestration: 'engine-spawned-provider' as const,
      requiredIndependence: 'provider-independent' as const,
      achievedIndependence: assignment.achievedIndependence,
      content,
      providerInvocation,
      grantUse: null,
      roleContextSharingUse: structuredClone(evidence),
      directHumanReviewAttestation: null,
    };
    return deepFreeze({
      ...semantic,
      resultDigest: crypto
        .createHash('sha256')
        .update(
          canonicalJson({ schema: 'admitted-role-result.v2', ...semantic }),
        )
        .digest('hex'),
    });
  }

  /**
   * Validate and freeze the complete result binding before a live one-use
   * transition is allowed to become terminal. Replay admission calls this same
   * normalizer after recovering the exact durable binding.
   */
  function normalizeRoleContextSharingResultAdmissionBinding(
    input: RoleContextSharingResultAdmissionBindingInput,
  ): NormalizedRoleContextSharingResultAdmissionBinding {
    const assignment = input.assignment;
    const content = assertRoleContentAdmission(input.content);
    const author = normalizeRecordedParticipant(input.author);
    const participant = normalizeRecordedParticipant(input.participant);
    if (
      assignment.authorityKind !== 'role-context-sharing-grant.v1' ||
      assignment.authorizedEffect !== 'role-context-sharing-degradation' ||
      content.kind !== 'plan-review' ||
      participant.providerId !== assignment.providerId ||
      participant.sessionId !== assignment.sessionId ||
      participant.engineSpawned !== true
    ) {
      throw roleResultInvalid();
    }
    const providerInvocation = assertProviderInvocation(
      input.providerInvocation,
      assignment,
    );
    return deepFreeze({
      assignment: structuredClone(assignment),
      author,
      participant,
      content,
      providerInvocation,
    });
  }

  /**
   * Replay one terminal R-007 admission only from the opaque proof minted after
   * historical signature and exact journal validation.
   */
  function admitConsumedRoleContextSharingResultReplay(
    input: AdmitConsumedRoleContextSharingResultReplayInput,
  ): AdmittedRoleResult {
    return admitRoleContextSharingResult({
      assignment: input.assignment,
      author: input.author,
      participant: input.participant,
      content: input.content,
      providerInvocation: input.providerInvocation,
      consumedUse: consumedRoleContextSharingUseForReplay(input.replay, {
        assignment: input.assignment,
        author: input.author,
        participant: input.participant,
        content: input.content,
        providerInvocation: input.providerInvocation,
      }),
    });
  }

  function admitRoleResultCore(
    input: AdmitRoleResultInput,
    consumedReplayUse: CollaborationGrantUseProjection | null,
  ): AdmittedRoleResult {
    if (!input || typeof input !== 'object') {
      throw roleResultInvalid();
    }
    const assignment = input.assignment;
    const content = assertRoleContentAdmission(input.content);
    const author = normalizeRecordedParticipant(input.author);
    const participant = normalizeRecordedParticipant(input.participant);
    if (
      (assignment.role !== 'plan-reviewer' &&
        assignment.role !== 'task-diff-reviewer' &&
        assignment.role !== 'task-implementer') ||
      !/^[0-9a-f]{64}$/.test(assignment.targetDigest)
    ) {
      throw roleResultInvalid();
    }
    const contentMatchesRole =
      assignment.role === 'plan-reviewer'
        ? content.kind === 'blind-survey' || content.kind === 'plan-review'
        : assignment.role === 'task-diff-reviewer'
          ? content.kind === 'task-diff-review'
          : content.kind === 'task-implementation';
    if (!contentMatchesRole) {
      throw roleResultInvalid();
    }

    let form: AdmittedRoleResult['form'];
    let providerInvocation: RoleProviderInvocationEvidence | null = null;
    let grantUse: CollaborationGrantUseProjection | null = null;
    let directHumanReviewAttestation: DirectHumanReviewAttestation | null =
      null;
    let orchestration: AdmittedRoleResult['orchestration'];
    let achievedIndependence: IndependenceDimension;

    if (isOrdinaryRoleAssignment(assignment)) {
      if (
        input.grantUse !== null ||
        input.grantValidation !== null ||
        consumedReplayUse !== null
      ) {
        throw roleResultInvalid();
      }
      if (
        participant.providerId !== assignment.providerId ||
        participant.sessionId !== assignment.sessionId ||
        participant.engineSpawned !== true
      ) {
        throw roleResultInvalid();
      }
      providerInvocation = assertProviderInvocation(
        input.providerInvocation,
        assignment,
      );
      form = 'ordinary-provider';
      orchestration = 'engine-spawned-provider';
      achievedIndependence = assignment.achievedIndependence;
    } else {
      if (
        canonicalJson(author) !== canonicalJson(assignment.author) ||
        canonicalJson(participant) !== canonicalJson(assignment.participant) ||
        input.grantUse === null ||
        (consumedReplayUse === null) === (input.grantValidation === null)
      ) {
        throw roleResultInvalid();
      }
      if (consumedReplayUse === null) {
        grantUse = validateCollaborationGrantUseProjection(input.grantUse, {
          ...input.grantValidation!,
          expectedAssignment: assignment,
          contentAdmission: {
            kind: content.kind,
            nodeId: content.nodeId,
            resultDigest: content.resultDigest,
            current: true,
          },
        });
      } else {
        if (
          canonicalJson(input.grantUse) !== canonicalJson(consumedReplayUse) ||
          canonicalJson(consumedReplayUse.assignment) !==
            canonicalJson(assignment) ||
          canonicalJson(consumedReplayUse.structuredContent) !==
            canonicalJson({
              kind: content.kind,
              nodeId: content.nodeId,
              resultDigest: content.resultDigest,
            })
        ) {
          throw roleResultInvalid();
        }
        grantUse = consumedReplayUse;
      }
      orchestration = assignment.orchestration;
      achievedIndependence = assignment.achievedIndependence;

      if (isGrantedSameProviderRoleAssignment(assignment)) {
        providerInvocation = assertProviderInvocation(
          input.providerInvocation,
          assignment,
        );
        form = 'granted-same-provider';
      } else {
        if (input.providerInvocation !== null) {
          throw roleResultInvalid();
        }
        if (assignment.degradedForm === 'caller-supplied') {
          form = 'granted-caller-supplied';
        } else if (assignment.degradedForm === 'direct-human-review') {
          if (
            assignment.orchestration !== 'direct-human-review' ||
            !grantUse.directHumanReviewAttestation ||
            assignment.directHumanReviewAttestationDigest !==
              directHumanReviewAttestationDigest(
                grantUse.directHumanReviewAttestation,
              )
          ) {
            throw roleResultInvalid();
          }
          form = 'direct-human-attestation';
          directHumanReviewAttestation = grantUse.directHumanReviewAttestation;
        } else {
          throw roleResultInvalid();
        }
      }
    }

    const semantic = {
      schemaVersion: 1 as const,
      form,
      role: assignment.role,
      targetDigest: assignment.targetDigest,
      assignment: structuredClone(assignment),
      author,
      participant,
      orchestration,
      requiredIndependence: assignment.requiredIndependence as
        'provider-independent' | 'session-independent',
      achievedIndependence,
      content,
      providerInvocation,
      grantUse,
      directHumanReviewAttestation,
    };
    return deepFreeze({
      ...semantic,
      resultDigest: crypto
        .createHash('sha256')
        .update(
          canonicalJson({ schema: 'admitted-role-result.v1', ...semantic }),
        )
        .digest('hex'),
    });
  }

  function isGrantedSameProviderRoleAssignment(
    value: GrantedRoleAssignment,
  ): value is GrantedSameProviderRoleAssignment {
    return (
      value.degradedForm === 'same-provider-fresh-session' &&
      value.orchestration === 'engine-spawned-provider' &&
      value.providerId !== null &&
      value.sessionId !== null &&
      value.achievedIndependence === 'session-independent' &&
      value.sessionIndependent === true &&
      value.engineSpawned === true &&
      value.directHumanReviewAttestationDigest === null &&
      value.degradedAuthorityOverride === undefined
    );
  }

  function isOrdinaryRoleAssignment(
    value: RoleAssignment | GrantedRoleAssignment,
  ): value is RoleAssignment {
    return (
      !('grantId' in value) &&
      hasExactKeys(value, ORDINARY_ASSIGNMENT_KEYS) &&
      (value.role === 'plan-reviewer' ||
        value.role === 'task-diff-reviewer' ||
        value.role === 'task-implementer') &&
      isProviderId(value.providerId) &&
      typeof value.sessionId === 'string' &&
      value.sessionId.length > 0 &&
      /^[0-9a-f]{64}$/.test(value.targetDigest) &&
      (value.requiredIndependence === 'provider-independent'
        ? value.achievedIndependence === 'provider-independent'
        : value.requiredIndependence === 'session-independent' &&
          (value.achievedIndependence === 'session-independent' ||
            value.achievedIndependence === 'provider-independent'))
    );
  }

  function assertRoleContentAdmission(
    value: RoleContentAdmission,
  ): RoleContentAdmission {
    if (
      !value ||
      typeof value !== 'object' ||
      !hasExactKeys(value, ROLE_CONTENT_KEYS) ||
      ![
        'blind-survey',
        'plan-review',
        'task-diff-review',
        'task-implementation',
      ].includes(value.kind) ||
      !/^[0-9a-f]{64}$/.test(value.nodeId) ||
      !/^[0-9a-f]{64}$/.test(value.resultDigest) ||
      !value.outputSchema ||
      typeof value.outputSchema !== 'object' ||
      !hasExactKeys(value.outputSchema, OUTPUT_SCHEMA_KEYS) ||
      typeof value.outputSchema.id !== 'string' ||
      value.outputSchema.id.length === 0 ||
      !Number.isInteger(value.outputSchema.version) ||
      value.outputSchema.version < 1 ||
      !/^[0-9a-f]{64}$/.test(value.outputSchema.digest) ||
      typeof value.evaluator !== 'string' ||
      value.evaluator.length === 0 ||
      !/^[0-9a-f]{64}$/.test(value.policyDigest) ||
      value.contentDigest !== value.resultDigest ||
      value.current !== true
    ) {
      throw roleResultInvalid();
    }
    return deepFreeze(structuredClone(value));
  }

  function assertProviderInvocation(
    value: RoleProviderInvocationEvidence | null,
    assignment: ProviderRoleAssignment,
  ): RoleProviderInvocationEvidence {
    if (
      !value ||
      typeof value !== 'object' ||
      !hasExactKeys(value, PROVIDER_INVOCATION_KEYS) ||
      typeof value.invocationId !== 'string' ||
      value.invocationId.length === 0 ||
      !/^[0-9a-f]{64}$/.test(value.requestDigest) ||
      !/^[0-9a-f]{64}$/.test(value.outputDigest) ||
      value.providerId !== assignment.providerId ||
      value.sessionId !== assignment.sessionId ||
      value.targetDigest !== assignment.targetDigest ||
      value.engineSpawned !== true
    ) {
      throw roleResultInvalid();
    }
    return deepFreeze(structuredClone(value));
  }

  function normalizeRecordedParticipant(
    value: RoleParticipant | RecordedRoleParticipant,
  ): RecordedRoleParticipant {
    if (!value || typeof value !== 'object') {
      throw roleResultInvalid();
    }
    if (!hasExactKeys(value, RECORDED_PARTICIPANT_KEYS)) {
      throw roleResultInvalid();
    }
    const providerId = value.providerId ?? null;
    const sessionId = value.sessionId ?? null;
    const principalId = value.principalId ?? null;
    if (
      (providerId !== null && !isProviderId(providerId)) ||
      (sessionId !== null &&
        (typeof sessionId !== 'string' || sessionId.length === 0)) ||
      (principalId !== null &&
        (typeof principalId !== 'string' || principalId.length === 0)) ||
      ![
        'self-declared',
        'runtime-hint',
        'adapter-assigned',
        'maintainer-signed',
      ].includes(value.identityAssurance) ||
      typeof value.engineSpawned !== 'boolean'
    ) {
      throw roleResultInvalid();
    }
    return deepFreeze({
      providerId,
      sessionId,
      principalId,
      identityAssurance: value.identityAssurance,
      engineSpawned: value.engineSpawned,
    });
  }

  function roleResultInvalid() {
    return workflowError(
      'ROLE_RESULT_INVALID',
      'Role result does not match its exact assignment, orchestration, content, and grant facts.',
      ExitCode.guard,
    );
  }

  return {
    assertAdmittedRoleResultRecord,
    admitRoleResult,
    admitConsumedRoleResultReplay,
    admitRoleContextSharingResult,
    normalizeRoleContextSharingResultAdmissionBinding,
    admitConsumedRoleContextSharingResultReplay,
    isGrantedSameProviderRoleAssignment,
  };
}

export type RoleResultAdmission = ReturnType<typeof createRoleResultAdmission>;
