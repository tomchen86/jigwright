/**
 * Builds external-effect audit events from the signed Grant and appends
 * them with deterministic identities.
 *
 * Invariants:
 * - An audit event's scope and correlation fields are drawn from the signed
 *   grant envelope's payload rather than caller-supplied arguments.
 * - auditInput defaults an event's result to 'failed' unless a result
 *   override is supplied.
 */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import type {
  ExternalEffectGrantAuditBindings,
  ExternalEffectGrantAuditTypes,
} from './external-effect-grant.ts';

type ExternalEffectGrantEnvelope =
  ExternalEffectGrantAuditTypes['ExternalEffectGrantEnvelope'];

type Sha256Digest = ExternalEffectGrantAuditTypes['Sha256Digest'];

type ExternalEffectAuditEventType =
  ExternalEffectGrantAuditTypes['ExternalEffectAuditEventType'];

type ExternalEffectAuditEvent =
  ExternalEffectGrantAuditTypes['ExternalEffectAuditEvent'];

type ExternalEffectTransitionOptions =
  ExternalEffectGrantAuditTypes['ExternalEffectTransitionOptions'];

export function createExternalEffectGrantAudit({
  sha256,
  appendExternalEffectAuthorityAudit,
}: ExternalEffectGrantAuditBindings) {
  function auditInput(
    envelope: ExternalEffectGrantEnvelope,
    grantDigest: Sha256Digest,
    eventType: ExternalEffectAuditEventType,
    now: Date,
    overrides: Partial<
      Pick<
        ExternalEffectAuditEvent,
        | 'transactionId'
        | 'poststateDigest'
        | 'evidenceDigest'
        | 'resolver'
        | 'result'
        | 'reason'
      >
    >,
  ): Omit<ExternalEffectAuditEvent, 'eventId'> {
    return {
      schemaVersion: 1,
      eventType,
      occurredAt: now.toISOString(),
      repositoryId: envelope.payload.repositoryId,
      externalAuditRoot: envelope.payload.externalAuditRoot,
      changeId: envelope.payload.changeId,
      taskId: envelope.payload.taskId,
      mandateId: envelope.payload.mandateId,
      mandateDigest: envelope.payload.mandateDigest,
      effectKind: envelope.payload.effectKind,
      targetDigest: sha256(canonicalJson(envelope.payload.target)),
      effectIdempotencyDigest: sha256(envelope.payload.idempotencyKey),
      grantId: envelope.payload.grantId,
      grantDigest,
      transactionId: overrides.transactionId ?? null,
      artifactDigest: envelope.payload.artifactDigest,
      prestateDigest: envelope.payload.prestateDigest,
      poststateDigest: overrides.poststateDigest ?? null,
      evidenceDigest: overrides.evidenceDigest ?? null,
      resolver: overrides.resolver ?? null,
      result: overrides.result ?? 'failed',
      reason: overrides.reason ?? null,
    };
  }

  function emitAudit(
    repositoryRoot: string,
    options: Pick<
      ExternalEffectTransitionOptions,
      'onAuditRecord' | 'testAuditServiceHooks'
    >,
    input: Omit<ExternalEffectAuditEvent, 'eventId'>,
  ): void {
    const event = Object.freeze({
      ...input,
      eventId: sha256(
        canonicalJson({
          grantDigest: input.grantDigest,
          transactionId: input.transactionId,
          eventType: input.eventType,
          result: input.result,
          poststateDigest: input.poststateDigest,
          evidenceDigest: input.evidenceDigest,
          resolver: input.resolver,
        }),
      ),
    });
    appendExternalEffectAuthorityAudit(repositoryRoot, event, {
      serviceHooks: options.testAuditServiceHooks,
      onRecord: options.onAuditRecord,
    });
  }

  return { auditInput, emitAudit };
}
