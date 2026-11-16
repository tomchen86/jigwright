/** Bind refusal policy to the engine's durable audit recorder. */
import { withAuthorityRefusalAudit as withRefusalRecorder } from '../modules/authority/authority-refusal-audit.ts';
import type { WithAuthorityRefusalAudit } from '../modules/authority/authority-audit-contract.ts';
import { recordAuthorityRefusal } from '../runtime/storage-journal/authority-refusal-audit.ts';

export const withAuthorityRefusalAudit: WithAuthorityRefusalAudit = (
  binding,
  options,
  operation,
) => withRefusalRecorder(recordAuthorityRefusal, binding, options, operation);
