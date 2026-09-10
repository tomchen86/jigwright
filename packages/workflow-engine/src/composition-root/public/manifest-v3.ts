/**
 * Exports investigation manifest drafting, sealing and validation APIs.
 *
 * Invariants:
 * - This facade re-exports its defining modules without local wrappers or
 *   duplicate implementations.
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
