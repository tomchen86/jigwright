import {
  readLedgerEntry,
  readLedgerIndex,
} from '../runtime/storage-journal/semantic-ledger-store.ts';
/**
 * Supplies repository snapshot access to semantic manifest reuse.
 *
 * Invariants:
 * - A supplied pinned snapshot takes precedence over reading the current
 *   repository snapshot.
 */
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
  return applyManifestReuse(
    { readLedgerEntry, readLedgerIndex },
    repositoryRoot,
    manifest,
    {
      currentPolicyDigest: options.currentPolicyDigest,
      get snapshot() {
        return (
          options.snapshot ?? readSystemDescriptionSnapshot(repositoryRoot)
        );
      },
    },
  );
}
