/** Constructs audit facts solely from the validated signed grant. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import {
  type Sha256Digest,
  type ExternalEffectAuditEventType,
  type ExternalEffectGrantEnvelope,
  type ExternalEffectAuditEvent,
  sha256,
} from './external-effect-grant.ts';

export function auditInput(
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
