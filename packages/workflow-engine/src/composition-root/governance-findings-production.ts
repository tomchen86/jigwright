/** Connects primitive Finding services to their shared ref reader and publisher. */
import { createGovernanceFindingServices } from '../application/governance-intake/governance-findings.ts';
import {
  publishFindingRefRecord,
  readFindingRef,
} from '../runtime/storage-journal/governance-finding-ref.ts';

import { readGovernanceSource } from './governance-sources-production.ts';

export const {
  recordGovernanceFinding,
  listGovernanceFindings,
  dismissGovernanceFinding,
  convertGovernanceFinding,
  linkGovernanceFinding,
} = createGovernanceFindingServices({
  readGovernanceSource,
  findingRef: { readFindingRef, publishFindingRefRecord },
});
