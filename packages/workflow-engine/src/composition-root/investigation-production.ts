/** Binds public investigation operations to the production replay observations. */
import { materializeInvestigationEvidenceView } from '../runtime/repository-observation/investigation-replay.ts';
import {
  buildInvestigationManifestDraft as buildDraft,
  validateDraftForSeal as validateDraft,
  validateForAuthority as validateAuthority,
} from '../modules/investigation/manifest/investigation-manifest.ts';
import { buildInvestigationManifestV3 as buildManifest } from '../modules/investigation/manifest/investigation-manifest-builder.ts';
export {
  scanInvestigationTreeFacts,
  materializeInvestigationEvidenceView,
} from '../runtime/repository-observation/investigation-replay.ts';
export const buildInvestigationManifestDraft = buildDraft.bind(
  undefined,
  materializeInvestigationEvidenceView,
);
export const validateDraftForSeal = validateDraft.bind(
  undefined,
  materializeInvestigationEvidenceView,
);
export const validateForAuthority = validateAuthority.bind(
  undefined,
  materializeInvestigationEvidenceView,
);
export const buildInvestigationManifestV3 = buildManifest.bind(
  undefined,
  materializeInvestigationEvidenceView,
);
