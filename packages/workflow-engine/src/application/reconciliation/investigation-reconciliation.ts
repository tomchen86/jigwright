/** Selects the reconciliation requirement from current v3 investigation authority. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { assertInvestigationRequirementV3 } from '../../modules/investigation/manifest/investigation-manifest.ts';
import { type InvestigationManifestV3 } from '../../modules/investigation/manifest/investigation-manifest-types.ts';
import {
  CURRENT_REQUIREMENT_ID,
  readCurrentRequirementPayload,
  sha256,
  reconciliationInvalid,
  deepFreeze,
  type CurrentImplementationReconciliationRequirement,
} from '../../modules/why-knowledge/implementation-reconciliation.ts';
export function readCurrentImplementationReconciliationRequirement(investigation: {
  manifest: InvestigationManifestV3;
  validation: { manifestDigest: string };
}): CurrentImplementationReconciliationRequirement | null {
  if (
    investigation.manifest.manifestDigest !==
    investigation.validation.manifestDigest
  ) {
    throw reconciliationInvalid(
      'The current investigation Manifest digest is inconsistent.',
    );
  }
  const applicability = investigation.manifest.applicability;
  if (applicability.kind === 'exemption') return null;
  const candidates =
    applicability.semanticDelta.investigationRequirements.filter(
      (requirement) =>
        requirement.kind === 'implementation-reconciliation-requirement',
    );
  if (candidates.length !== 1) {
    throw reconciliationInvalid(
      'An ordinary current investigation must contain exactly one implementation reconciliation requirement.',
    );
  }
  let normalized: ReturnType<typeof assertInvestigationRequirementV3>;
  try {
    normalized = assertInvestigationRequirementV3(candidates[0]);
  } catch {
    throw reconciliationInvalid(
      'The current implementation reconciliation requirement is malformed.',
    );
  }
  if (
    normalized.kind !== 'implementation-reconciliation-requirement' ||
    normalized.requirementId !== CURRENT_REQUIREMENT_ID ||
    canonicalJson(normalized) !== canonicalJson(candidates[0])
  ) {
    throw reconciliationInvalid(
      'The current implementation reconciliation requirement identity is invalid.',
    );
  }
  const requirement = readCurrentRequirementPayload(normalized.reconciliation);
  const replayBaseline = applicability.replayContract.baseline;
  if (
    requirement.changeId !== investigation.manifest.changeId ||
    canonicalJson(requirement.baseline) !==
      canonicalJson({
        head: replayBaseline.commitOid,
        tree: replayBaseline.treeOid,
      })
  ) {
    throw reconciliationInvalid(
      'The implementation reconciliation requirement does not bind the current Manifest identity and baseline.',
    );
  }
  return deepFreeze({
    requirementId: CURRENT_REQUIREMENT_ID,
    requirementDigest: sha256(
      canonicalJson({
        schema: 'implementation-reconciliation-requirement-binding.v3',
        requirement: normalized,
      }),
    ),
    investigationManifestDigest: investigation.validation.manifestDigest,
    requirement,
  });
}
