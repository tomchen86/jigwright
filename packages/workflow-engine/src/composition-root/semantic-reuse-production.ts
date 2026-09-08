/** Supplies one current repository snapshot when reuse is requested outside a pinned investigation. */
import {
  applyLedgerToFullBlobManifest as applyManifestReuse,
  type FullBlobReuseEntry,
} from '../modules/why-knowledge/semantic-manifest-reuse.ts';
import type { SystemDescriptionSnapshot } from '../modules/source/spec-ownership.ts';
import { readSystemDescriptionSnapshot } from '../runtime/repository-transaction/system-description-snapshot.ts';

export function applyLedgerToFullBlobManifest<
  TEntry extends FullBlobReuseEntry,
>(
  repositoryRoot: string,
  manifest: readonly TEntry[],
  options: {
    currentPolicyDigest?: string;
    snapshot?: SystemDescriptionSnapshot;
  } = {},
) {
  return applyManifestReuse(repositoryRoot, manifest, {
    currentPolicyDigest: options.currentPolicyDigest,
    get snapshot() {
      return options.snapshot ?? readSystemDescriptionSnapshot(repositoryRoot);
    },
  });
}
