/** Publishes deterministic external-effect events through the durable authority ledger. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';

import { sha256 } from '../../modules/authority/external-effect-grant.ts';

import { appendExternalEffectAuthorityAudit } from './external-effect-audit.ts';
import { type ExternalEffectAuditServices } from '../../modules/authority/external-effect-grant-services.ts';
export const emitAudit: ExternalEffectAuditServices['emitAudit'] =
  function emitAudit(repositoryRoot, options, input) {
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
  };
