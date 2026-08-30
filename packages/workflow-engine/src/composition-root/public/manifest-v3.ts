/**
 * Versioned public Manifest v3 surface. PlanReview and execution records remain
 * separate authority artifacts and are intentionally not re-exported here.
 */
export {
  INVESTIGATION_MANIFEST_V3_KIND,
  INVESTIGATION_MANIFEST_V3_SCHEMA_VERSION,
  buildInvestigationManifestDraft,
  sealInvestigationManifestDraft,
  validateDraftForSeal,
  validateForAuthority,
} from '../../modules/investigation/manifest/investigation-manifest.ts';

export type {
  InvestigationAuthoringState,
  InvestigationManifestDraftV3,
  InvestigationManifestV3,
  InvestigationV3Blocker,
} from '../../modules/investigation/manifest/investigation-manifest.ts';
