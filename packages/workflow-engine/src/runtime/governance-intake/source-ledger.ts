/** Strict filesystem admission and immutable publication of Source ledger records. */
import fs from 'node:fs';
import path from 'node:path';
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';
import { GOVERNANCE_SOURCE_LEDGER_ROOT } from '@jigwright/core/repository-consumer-port';
import {
  governanceSourceRelativePath,
  sourceReference,
  intakeInvalid,
  parseGovernanceSourceBytes,
} from '../../modules/governance-intake/governance-intake.ts';
import {
  publishCreateOnlyCanonical,
  readStableGovernanceBytes,
} from './canonical-record-storage.ts';
const SOURCE_FILE_MODE = 0o644;
export function readGovernanceSource(
  repositoryRoot: string,
  requestedSourceId: string,
): GovernanceSourceV1 {
  const sourceId = sourceReference(requestedSourceId);
  const relativePath = governanceSourceRelativePath(sourceId);
  const sourcePath = path.join(repositoryRoot, ...relativePath.split('/'));
  const bytes = readStableGovernanceBytes(sourcePath, SOURCE_FILE_MODE, () =>
    intakeInvalid('Governance Source must resolve to one plain record.'),
  );
  return parseGovernanceSourceBytes(bytes, sourceId);
}

export function listGovernanceSources(
  repositoryRoot: string,
): GovernanceSourceV1[] {
  const ledgerRoot = path.join(
    repositoryRoot,
    ...GOVERNANCE_SOURCE_LEDGER_ROOT.split('/'),
  );
  let rootStats: fs.Stats | undefined;
  try {
    rootStats = fs.lstatSync(ledgerRoot, { throwIfNoEntry: false });
  } catch {
    throw intakeInvalid(
      'Governance Source ledger root must be a plain directory.',
    );
  }
  if (rootStats === undefined) return [];
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw intakeInvalid(
      'Governance Source ledger root must be a plain directory.',
    );
  }
  const sources: GovernanceSourceV1[] = [];
  for (const prefix of fs.readdirSync(ledgerRoot, { withFileTypes: true })) {
    const prefixRoot = path.join(ledgerRoot, prefix.name);
    const prefixStats = fs.lstatSync(prefixRoot);
    if (
      prefix.isSymbolicLink() ||
      !prefix.isDirectory() ||
      prefixStats.isSymbolicLink() ||
      !prefixStats.isDirectory() ||
      !/^[0-9a-f]{2}$/.test(prefix.name)
    ) {
      throw intakeInvalid(
        'Governance Source ledger contains a noncanonical prefix entry.',
      );
    }
    for (const entry of fs.readdirSync(prefixRoot, { withFileTypes: true })) {
      const sourcePath = path.join(prefixRoot, entry.name);
      const sourceStats = fs.lstatSync(sourcePath);
      if (
        entry.isSymbolicLink() ||
        !entry.isFile() ||
        sourceStats.isSymbolicLink() ||
        !sourceStats.isFile() ||
        !/^[0-9a-f]{64}\.json$/.test(entry.name)
      ) {
        throw intakeInvalid(
          'Governance Source ledger contains a noncanonical record entry.',
        );
      }
      const digest = entry.name.slice(0, -'.json'.length);
      if (prefix.name !== digest.slice(0, 2)) {
        throw intakeInvalid('Governance Source path prefix is invalid.');
      }
      sources.push(readGovernanceSource(repositoryRoot, `SRC-${digest}`));
    }
  }
  return sources.sort((left, right) => left.id.localeCompare(right.id));
}
export function publishGovernanceSource(
  repositoryRoot: string,
  source: GovernanceSourceV1,
): boolean {
  return publishCreateOnlyCanonical(
    path.join(
      repositoryRoot,
      ...governanceSourceRelativePath(source.id).split('/'),
    ),
    source,
    SOURCE_FILE_MODE,
    'GOVERNANCE_SOURCE_COLLISION',
  );
}
