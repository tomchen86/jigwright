import { materializeInvestigationEvidenceView } from '../../repository-observation/investigation-replay.ts';
/**
 * Reconciles publication candidates, journal records, and installed manifest authority.
 *
 * Invariants:
 * - Journal and candidate bytes bind the same snapshot, manifest, and current-ref identity.
 * - Candidate installation retains existing authority and anchored replacement checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type InvestigationManifestPublicationPaths,
  type PublicationJournal,
  type InvestigationManifestPublicationLifecycleIdentity,
  type InvestigationManifestPublicationSnapshot,
  authorityExpected,
  currentRefFor,
  type CurrentManifestRef,
  parseCurrentManifestRef,
  isSameTrackedInvestigationLifecycle,
  assertPublicationSnapshot,
} from '../../../modules/investigation/manifest/investigation-publication-contracts.ts';
import {
  resolveRelative,
  readJson,
  publicationRefDigest,
  assertPlainPublicationDirectoryChain,
  withAnchoredPublicationDirectory,
  samePublicationFileIdentity,
  readAnchoredPublicationPreimage,
  assertAnchoredPublicationDirectoryInsideRepository,
  fsyncDirectory,
  compensateAnchoredPublicationReplacement,
  samePublicationDirectoryChain,
  publicationRepositoryRoot,
} from './investigation-publication-files.ts';
import {
  publicationFailure,
  DIGEST,
  digest,
} from '../../../modules/investigation/manifest/investigation-publication-values.ts';
import { validateForAuthority } from '../../../modules/investigation/manifest/investigation-manifest.ts';
import { type InvestigationManifestV3 } from '../../../modules/investigation/manifest/investigation-manifest-types.ts';
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';

export function normalizePaths(
  repositoryRoot: string,
  privateRoot: string | undefined,
  paths: InvestigationManifestPublicationPaths,
): {
  repositoryRoot: string;
  privateRoot: string;
  manifest: string;
  currentRef: string;
  journal: string;
  repositoryAbsolute: (relativePath: string) => string;
} {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const privateStorageRoot = fs.realpathSync(
    path.resolve(privateRoot ?? repositoryRoot),
  );
  const manifest = resolveRelative(root, paths.manifestPath);
  const currentRef = resolveRelative(privateStorageRoot, paths.currentRefPath);
  const journal = resolveRelative(privateStorageRoot, paths.journalPath);
  assertPublicationRolePathsDistinct([manifest, currentRef, journal]);
  return {
    repositoryRoot: root,
    privateRoot: privateStorageRoot,
    manifest,
    currentRef,
    journal,
    repositoryAbsolute: (relativePath) => resolveRelative(root, relativePath),
  };
}

export function assertPublicationRolePathsDistinct(
  absolutePaths: readonly string[],
): void {
  if (new Set(absolutePaths).size !== absolutePaths.length) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication path roles must be distinct.',
    );
  }
  for (let left = 0; left < absolutePaths.length; left += 1) {
    for (let right = left + 1; right < absolutePaths.length; right += 1) {
      const leftPath = absolutePaths[left]!;
      const rightPath = absolutePaths[right]!;
      if (
        leftPath.startsWith(rightPath + path.sep) ||
        rightPath.startsWith(leftPath + path.sep)
      ) {
        throw publicationFailure(
          'MANIFEST_UNREPRESENTABLE',
          'Publication path roles must not contain one another.',
        );
      }
    }
  }
  for (const absolute of absolutePaths) {
    const observed = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      observed !== undefined &&
      (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1)
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication path role is not a plain single-link file.',
      );
    }
  }
}

export function assertPublicationJournalRolePaths(
  paths: ReturnType<typeof normalizePaths>,
  journal: PublicationJournal,
): string {
  const candidate = paths.repositoryAbsolute(journal.paths.candidatePath);
  assertPublicationRolePathsDistinct([
    paths.manifest,
    paths.currentRef,
    paths.journal,
    candidate,
  ]);
  return candidate;
}

export function candidateRelativePath(
  paths: InvestigationManifestPublicationPaths,
  transactionId: string,
): string {
  return `${paths.manifestPath}.${transactionId}.candidate`;
}

export function candidateResidue(
  repositoryRoot: string,
  paths: InvestigationManifestPublicationPaths,
): string[] {
  const manifest = resolveRelative(repositoryRoot, paths.manifestPath);
  const directory = path.dirname(manifest);
  const prefix = `${path.basename(manifest)}.`;
  const suffix = '.candidate';
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Manifest publication directory is unsafe.',
    );
  }
  return fs
    .readdirSync(directory)
    .filter((name) => {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
      return DIGEST.test(name.slice(prefix.length, -suffix.length));
    })
    .map((name) =>
      path.posix.join(path.posix.dirname(paths.manifestPath), name),
    )
    .sort();
}

export function validatedCandidateResidue(
  repositoryRoot: string,
  privateRoot: string,
  paths: InvestigationManifestPublicationPaths,
  lifecycle: InvestigationManifestPublicationLifecycleIdentity,
): { candidatePath: string; transactionId: string } | null {
  const candidates = candidateResidue(repositoryRoot, paths);
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Candidate-only publication residue is ambiguous.',
    );
  }
  const candidatePath = candidates[0]!;
  const candidate = readJson(resolveRelative(repositoryRoot, candidatePath));
  const expected: InvestigationManifestPublicationSnapshot = {
    ...lifecycle,
    currentRefDigest: publicationRefDigest(privateRoot, paths.currentRefPath),
  };
  const validated = validateForAuthority(materializeInvestigationEvidenceView, {
    repositoryRoot,
    manifest: candidate,
    expected: authorityExpected(expected),
  });
  if (validated.outcome !== 'verified') {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Candidate-only publication residue is not a valid Manifest for the current lifecycle.',
    );
  }
  const currentRef = currentRefFor(paths.manifestPath, validated.manifest);
  const transactionId = digest({
    schema: 'investigation-manifest-publication-transaction.v1',
    expected,
    currentRef,
  });
  if (candidatePath !== candidateRelativePath(paths, transactionId)) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Candidate-only publication residue does not match its lifecycle transaction.',
    );
  }
  return { candidatePath, transactionId };
}

export function installCandidate(
  candidatePath: string,
  manifestPath: string,
  journal: PublicationJournal,
  paths: ReturnType<typeof normalizePaths>,
): void {
  if (
    path.dirname(candidatePath) !== path.dirname(manifestPath) ||
    path.dirname(manifestPath) !== path.dirname(paths.manifest)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Manifest candidate and target must share one anchored directory.',
    );
  }
  const directory = path.dirname(manifestPath);
  const parentIdentity = assertPlainPublicationDirectoryChain(
    paths.repositoryRoot,
    directory,
    false,
  );
  const candidateIdentity = fs.lstatSync(candidatePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    candidateIdentity === undefined ||
    !candidateIdentity.isFile() ||
    candidateIdentity.isSymbolicLink() ||
    candidateIdentity.nlink !== 1n
  ) {
    throw publicationFailure(
      'REPLAY_INPUT_MISSING',
      'Manifest publication candidate is absent or unsafe.',
    );
  }
  assertManifestMatchesJournal(candidatePath, journal, paths.repositoryRoot);
  const candidateName = path.basename(candidatePath);
  const manifestName = path.basename(manifestPath);
  let installedIdentity: fs.BigIntStats | null = null;
  withAnchoredPublicationDirectory(
    paths.repositoryRoot,
    directory,
    parentIdentity,
    () => {
      const anchoredCandidate = fs.lstatSync(candidateName, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (
        anchoredCandidate === undefined ||
        !samePublicationFileIdentity(candidateIdentity, anchoredCandidate)
      ) {
        throw publicationFailure(
          'RECONSTRUCTION_MISMATCH',
          'Manifest publication candidate changed before installation.',
        );
      }
      const existing = fs.lstatSync(manifestName, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (
        existing !== undefined &&
        (!existing.isFile() ||
          existing.isSymbolicLink() ||
          existing.nlink !== 1n)
      ) {
        throw publicationFailure(
          'MANIFEST_UNREPRESENTABLE',
          'Manifest publication target is unsafe.',
        );
      }
      const previous =
        existing === undefined
          ? null
          : readAnchoredPublicationPreimage(manifestName, existing);
      let replacementInstalled = false;
      try {
        assertAnchoredPublicationDirectoryInsideRepository(
          paths.repositoryRoot,
        );
        fs.renameSync(candidateName, manifestName);
        replacementInstalled = true;
        const installed = fs.lstatSync(manifestName, {
          bigint: true,
          throwIfNoEntry: false,
        });
        const candidateAfter = fs.lstatSync(candidateName, {
          bigint: true,
          throwIfNoEntry: false,
        });
        if (
          installed === undefined ||
          !installed.isFile() ||
          installed.isSymbolicLink() ||
          installed.nlink !== 1n ||
          installed.dev !== candidateIdentity.dev ||
          installed.ino !== candidateIdentity.ino ||
          installed.mode !== candidateIdentity.mode ||
          installed.size !== candidateIdentity.size ||
          candidateAfter !== undefined
        ) {
          throw publicationFailure(
            'RECONSTRUCTION_MISMATCH',
            'Manifest candidate was not atomically installed.',
          );
        }
        fsyncDirectory('.');
        assertAnchoredPublicationDirectoryInsideRepository(
          paths.repositoryRoot,
        );
        installedIdentity = installed;
      } catch (error) {
        if (replacementInstalled) {
          compensateAnchoredPublicationReplacement(
            manifestName,
            candidateIdentity,
            previous,
          );
        }
        throw error;
      }
    },
  );
  const installed = fs.lstatSync(manifestPath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  const candidateAfter = fs.lstatSync(candidatePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  const parentAfter = assertPlainPublicationDirectoryChain(
    paths.repositoryRoot,
    directory,
    false,
  );
  if (
    installedIdentity === null ||
    installed === undefined ||
    !samePublicationFileIdentity(installedIdentity, installed) ||
    candidateAfter !== undefined ||
    !samePublicationDirectoryChain(parentIdentity, parentAfter)
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Manifest publication target changed after atomic installation.',
    );
  }
  assertManifestMatchesJournal(manifestPath, journal, paths.repositoryRoot);
}

export function assertManifestMatchesJournal(
  filePath: string,
  journal: PublicationJournal,
  repositoryRoot: string = publicationRepositoryRoot(filePath),
): InvestigationManifestV3 {
  const parsed = readJson(filePath);
  const validated = validateForAuthority(materializeInvestigationEvidenceView, {
    repositoryRoot,
    manifest: parsed,
    expected: authorityExpected(journal.expected),
  });
  if (
    validated.outcome !== 'verified' ||
    validated.manifestDigest !== journal.manifestDigest ||
    validated.investigationTargetDigest !== journal.investigationTargetDigest
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication Manifest does not match the journalled authority state.',
    );
  }
  return validated.manifest;
}

export function currentRefMatches(
  filePath: string,
  expected: CurrentManifestRef,
  privateRoot: string,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  return (
    canonicalJson(parseCurrentManifestRef(readJson(filePath, privateRoot))) ===
    canonicalJson(expected)
  );
}

/**
 * Private legacy-namespace Manifests remain immutable and therefore require a
 * fresh path for each changed digest. The one governed tracked Manifest path
 * is revision-stable instead: a pre-ref crash is made non-authoritative by the
 * exact private current-ref check at every active read boundary.
 */
export function assertManifestTargetPreservesCurrentAuthority(
  currentRefPath: string,
  next: CurrentManifestRef,
  privateRoot: string,
): void {
  if (!fs.existsSync(currentRefPath)) return;
  const current = parseCurrentManifestRef(
    readJson(currentRefPath, privateRoot),
  );
  if (
    current.manifestPath === next.manifestPath &&
    current.manifestDigest !== next.manifestDigest &&
    !isSameTrackedInvestigationLifecycle(current, next)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'A changed Manifest must use a fresh path before the authority ref is switched.',
    );
  }
}

export function assertInstalledState(
  paths: ReturnType<typeof normalizePaths>,
  journal: PublicationJournal,
): void {
  assertManifestMatchesJournal(paths.manifest, journal, paths.repositoryRoot);
  if (
    !currentRefMatches(paths.currentRef, journal.currentRef, paths.privateRoot)
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Committed publication current ref is missing or stale.',
    );
  }
}

export function readJournal(
  journalPath: string,
  expectedPaths: InvestigationManifestPublicationPaths,
  privateRoot = publicationRepositoryRoot(journalPath),
  repositoryRoot = publicationRepositoryRoot(journalPath),
): PublicationJournal {
  const value = readJson(journalPath, privateRoot);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication journal is malformed.',
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expectedKeys = [
    'schemaVersion',
    'kind',
    'state',
    'transactionId',
    'paths',
    'expected',
    'manifestDigest',
    'investigationTargetDigest',
    'manifest',
    'currentRef',
  ];
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key) => expectedKeys.includes(key)) ||
    record.schemaVersion !== 1 ||
    record.kind !== 'investigation-manifest-publication' ||
    (record.state !== 'prepared' && record.state !== 'committed') ||
    typeof record.transactionId !== 'string' ||
    !DIGEST.test(record.transactionId) ||
    typeof record.manifestDigest !== 'string' ||
    !DIGEST.test(record.manifestDigest) ||
    typeof record.investigationTargetDigest !== 'string' ||
    !DIGEST.test(record.investigationTargetDigest)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication journal identity is malformed.',
    );
  }
  const paths = record.paths as PublicationJournal['paths'];
  if (
    typeof paths !== 'object' ||
    paths === null ||
    canonicalJson({
      manifestPath: paths.manifestPath,
      currentRefPath: paths.currentRefPath,
      journalPath: paths.journalPath,
    }) !== canonicalJson(expectedPaths) ||
    typeof paths.candidatePath !== 'string'
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication journal paths do not match the requested transaction.',
    );
  }
  const journal = record as unknown as PublicationJournal;
  const currentRef = parseCurrentManifestRef(journal.currentRef);
  assertPublicationSnapshot(journal.expected);
  const validated = validateForAuthority(materializeInvestigationEvidenceView, {
    repositoryRoot,
    manifest: journal.manifest,
    expected: authorityExpected(journal.expected),
  });
  const expectedTransaction = digest({
    schema: 'investigation-manifest-publication-transaction.v1',
    expected: journal.expected,
    currentRef: journal.currentRef,
  });
  if (
    expectedTransaction !== journal.transactionId ||
    currentRef.manifestDigest !== journal.manifestDigest ||
    currentRef.investigationTargetDigest !==
      journal.investigationTargetDigest ||
    currentRef.repositoryId !== journal.expected.repositoryId ||
    currentRef.changeId !== journal.expected.changeId ||
    currentRef.investigationId !== journal.expected.investigationId ||
    currentRef.manifestPath !== journal.paths.manifestPath ||
    validated.outcome !== 'verified' ||
    validated.manifestDigest !== journal.manifestDigest ||
    validated.investigationTargetDigest !== journal.investigationTargetDigest
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication journal binding does not match recomputation.',
    );
  }
  if (
    journal.paths.candidatePath !==
    candidateRelativePath(journal.paths, journal.transactionId)
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication journal candidate path does not match its transaction.',
    );
  }
  return journal;
}
