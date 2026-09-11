/** Supplies live pinned-commit and worktree observations to the exact-manifest rules. */
import { createMaintainerManifestOperations } from '../modules/authority/maintainer-manifest.ts';
import { maintainerManifestObservations } from '../runtime/repository-observation/maintainer-manifest.ts';
export const maintainerManifestOperations = createMaintainerManifestOperations(
  maintainerManifestObservations,
);
export const {
  loadCapabilityProfileFromTrustBase,
  buildMaintainerPatchManifest,
  verifyPatchManifestAgainstWorktree,
  validatePatchManifestAgainstProfile,
} = maintainerManifestOperations;
