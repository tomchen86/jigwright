/** Connect Source capture and reads to the built-in immutable ledger. */
import { createGovernanceSourceServices } from '../application/governance-intake/governance-sources.ts';
import {
  readGovernanceSource as readSource,
  listGovernanceSources as listSources,
  publishGovernanceSource as publishSource,
} from '../runtime/governance-intake/source-ledger.ts';
import { readGovernanceSourceAliases as readAliases } from '../runtime/governance-intake/source-aliases.ts';
export const {
  resolveGovernanceSourceAlias,
  readGovernanceSourceAliases,
  captureGovernanceSource,
  readGovernanceSource,
  listGovernanceSources,
} = createGovernanceSourceServices({
  readSource,
  listSources,
  publishSource,
  readAliases,
});
