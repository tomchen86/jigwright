import { createGovernanceFindingServices } from '../modules/governance-intake/governance-intake.ts';
import { createGovernanceIntakeCountsReader } from '../modules/governance-intake/intake-summary.ts';
import {
  readFindingRef,
  publishFindingRefRecord,
} from '../runtime/storage-journal/governance-finding-ref.ts';

export const {
  recordGovernanceFinding,
  listGovernanceFindings,
  dismissGovernanceFinding,
  convertGovernanceFinding,
  linkGovernanceFinding,
} = createGovernanceFindingServices({
  readFindingRef,
  publishFindingRefRecord,
});

export const inspectGovernanceIntakeCounts = createGovernanceIntakeCountsReader(
  listGovernanceFindings,
);
