/** Replays only exact reconciled ledger projections from immutable Git bytes. */
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { normalizeExactRepositoryPath } from '../../../foundation/repository-path/repository-path.ts';
import { ciError } from '../../../modules/assurance/commit-replay/ci-sequence.ts';
import type { InvestigationManifestV3 } from '../../../modules/investigation/manifest/investigation-manifest-types.ts';
import { isSemanticProjectionPath } from '../../../modules/projection/engine-projection-registry.ts';
import {
  IMPLEMENTATION_MUTATION_DISPOSITIONS,
  IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
} from '../../../modules/why-knowledge/implementation-reconciliation.ts';
import { assertLedgerEntry } from '../../../modules/why-knowledge/semantic-ledger.ts';
import { createReconciledLedgerEntry } from '../../managed-documents/transaction/semantic-ledger-projection.ts';
import {
  readBlobBytes,
  runGit,
} from '../../repository-transaction/git-command.ts';
import { isSystemDescriptionTextPath } from '../../repository-transaction/system-description-snapshot.ts';
import type { SystemDescriptionSnapshot } from '../../../modules/source/spec-ownership.ts';
import {
  assertLedgerIndex,
  ledgerIndexPath,
  ledgerObjectPath,
} from '../../storage-journal/semantic-ledger-store.ts';

/** The caller has already validated the governing planning commit. */
export function replayTaskSemanticLedger(
  repositoryRoot: string,
  parent: string,
  commit: string,
  changeId: string,
  changedPaths: readonly string[],
): string[] {
  const paths = changedPaths.filter(isSemanticProjectionPath).sort();
  if (paths.length === 0) return [];
  const invalid = () =>
    ciError(
      'CI_TASK_SEMANTIC_LEDGER_INVALID',
      'Task semantic bindings differ from the exact parent/source projection.',
      { commit },
    );
  const read = (revision: string, file: string) => {
    normalizeExactRepositoryPath(file);
    const listing = runGit(repositoryRoot, [
      'ls-tree',
      '-z',
      revision,
      '--',
      `:(literal)${file}`,
    ]);
    if (!listing) return null;
    const match = /^(100644|100755|120000) blob ([0-9a-f]+)\t([^\0]+)\0$/.exec(
      listing,
    );
    if (!match || match[3] !== file) throw invalid();
    return { mode: match[1], bytes: readBlobBytes(repositoryRoot, match[2]!) };
  };
  const json = (revision: string, file: string) => {
    const value = read(revision, file);
    if (value === null || value.mode !== '100644') throw invalid();
    return {
      bytes: value.bytes.toString('utf8'),
      value: JSON.parse(value.bytes.toString('utf8')),
    };
  };
  try {
    const manifest = json(
      parent,
      `openspec/changes/${changeId}/investigation.json`,
    ).value as InvestigationManifestV3;
    if (manifest.applicability.kind !== 'ordinary') throw invalid();
    const eligible = new Set(
      manifest.applicability.semanticDelta.whyOverlays.map(
        ({ pathIdentity }) => pathIdentity.utf8,
      ),
    );
    const indexPath = ledgerIndexPath();
    const prior = read(parent, indexPath);
    if (prior !== null && prior.mode !== '100644') throw invalid();
    const index = assertLedgerIndex(
      prior === null
        ? { schemaVersion: 1, kind: 'semantic-ledger-index', subjects: {} }
        : JSON.parse(prior.bytes.toString('utf8')),
    );
    if (
      prior !== null &&
      prior.bytes.toString('utf8') !== `${canonicalJson(index)}\n`
    )
      throw invalid();
    const subjects = { ...index.subjects };
    const seen = new Set<string>();
    // Match the producer's working-tree visibility, using only immutable blobs.
    const snapshot: SystemDescriptionSnapshot = {
      listPaths: () =>
        runGit(repositoryRoot, ['ls-tree', '-r', '--name-only', '-z', commit])
          .split('\0')
          .filter(Boolean),
      readText(file) {
        if (!isSystemDescriptionTextPath(file)) return undefined;
        const value = read(commit, file);
        if (
          value === null ||
          value.mode === '120000' ||
          value.bytes.length > 2 * 1024 * 1024 ||
          value.bytes.includes(0)
        )
          return undefined;
        const text = value.bytes.toString('utf8');
        return Buffer.from(text).equals(value.bytes) ? text : undefined;
      },
    };
    const objects = paths.filter((file) => file !== indexPath);
    if (objects.length === 0 || !paths.includes(indexPath)) throw invalid();
    for (const file of objects) {
      if (read(parent, file) !== null) throw invalid();
      const candidate = json(commit, file);
      const entry = assertLedgerEntry(candidate.value);
      const subject = entry.subject.subjectId;
      if (
        file !== ledgerObjectPath(entry.entryId) ||
        !eligible.has(entry.subject.path) ||
        seen.has(subject)
      )
        throw invalid();
      seen.add(subject);
      const source = read(commit, entry.subject.path)?.bytes ?? null;
      const supersedes = index.subjects[subject]?.currentEntryId ?? null;
      if (source === null && supersedes === null) throw invalid();
      const matches = IMPLEMENTATION_MUTATION_DISPOSITIONS.some(
        (disposition) => {
          if ((source === null) !== (disposition === 'subject-deleted'))
            return false;
          const expected = createReconciledLedgerEntry({
            changeId,
            baselineCommit: parent,
            subjectPath: entry.subject.path,
            source,
            disposition,
            supersedes,
            snapshot,
            policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
          });
          return candidate.bytes === `${canonicalJson(expected)}\n`;
        },
      );
      if (!matches) throw invalid();
      if (source === null) delete subjects[subject];
      else subjects[subject] = { currentEntryId: entry.entryId };
    }
    if (
      json(commit, indexPath).bytes !==
      `${canonicalJson({ ...index, subjects })}\n`
    )
      throw invalid();
    return paths;
  } catch {
    throw invalid();
  }
}
