/** Observe exact implementation hunks and an isolated production-path Git tree. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  runGit,
  runGitWithEnvironment,
} from '../repository-transaction/git.ts';
import { scanInvestigationTreeFacts } from './investigation-replay.ts';
import { type ScanInvestigationTerm } from '../../modules/investigation/domain/investigation-scan-facts.ts';
import { deriveInvestigationGroupFacts } from '../../modules/investigation/domain/investigation-groups.ts';
import { createMutationClassPolicy } from '../../modules/source/mutation-class-policy.ts';
import type { ImplementationTermScanObservation } from '../../modules/assurance/implementation-term-floor.ts';
import type { ImplementationDeltaTerm } from '../../modules/assurance/implementation-term-dispositions.ts';
export function readImplementationHunk(
  repositoryRoot: string,
  baselineCommit: string,
  candidatePath: string,
): string {
  return runGit(repositoryRoot, [
    'diff',
    '--no-color',
    '--no-renames',
    '--unified=3',
    baselineCommit,
    '--',
    candidatePath,
  ]);
}
export function materializeImplementationTree(input: {
  repositoryRoot: string;
  baselineCommit: string;
  productionPaths: readonly string[];
}): string {
  const temporary = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-implementation-tree-'),
  );
  const indexPath = path.join(temporary, 'index');
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: indexPath,
    GIT_WORK_TREE: input.repositoryRoot,
  };
  try {
    runGitWithEnvironment(
      input.repositoryRoot,
      ['read-tree', input.baselineCommit],
      environment,
    );
    if (input.productionPaths.length > 0) {
      runGitWithEnvironment(
        input.repositoryRoot,
        ['add', '--all', '--', ...input.productionPaths],
        environment,
      );
    }
    return runGitWithEnvironment(
      input.repositoryRoot,
      ['write-tree'],
      environment,
    ).trim();
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export function scanImplementationTree(input: {
  repositoryRoot: string;
  treeOid: string;
  terms: readonly ImplementationDeltaTerm[];
}): ImplementationTermScanObservation {
  const scanTerms: ScanInvestigationTerm[] = input.terms.map((term) => ({
    termId: term.termId,
    kind: term.kind,
    value: term.value,
    matching: term.matching,
    provenance: [
      {
        source: 'engine',
        reference: 'implementation-finalization-hunk-floor.v1',
        rationale: null,
        expectedRelationship: null,
      },
    ],
  }));
  const scan = scanInvestigationTreeFacts({
    repositoryRoot: input.repositoryRoot,
    treeOid: input.treeOid,
    terms: scanTerms,
  });
  if (scan.outcome !== 'ready')
    return { outcome: 'requires-narrowing', violations: scan.violations };
  const grouped = deriveInvestigationGroupFacts({
    scanFacts: scan.facts,
    mutationPolicy: createMutationClassPolicy({ rules: [] }),
    declaredRoots: [{ rootId: 'repository', path: '' }],
    reviewedRelationships: [],
  });
  return { outcome: 'ready', facts: scan.facts, groups: grouped.groups };
}
