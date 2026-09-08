/**
 * Identifies the exact implementation, documents and deltas awaiting disposition.
 *
 * Invariants:
 * - Session worktree, branch and baseline agree before any document snapshot is read.
 * - Both sides of affected documents and all applicable deltas bind the candidate digest.
 *
 * Depends on: Session and repository read ports, document obligations and spec catalog.
 * Failure modes: Stale identity or missing delta bindings invalidate document decisions.
 */
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { grantSha256 } from '../../modules/authority/grant-primitives.ts';
import {
  collectSystemDocumentObligations,
  type SystemDocumentObligation,
} from '../../modules/source/document-disposition.ts';
import { sourceDigest } from '../../modules/source/import-dependencies.ts';
import { systemSpecCatalog } from '../../modules/source/system-spec-catalog.ts';
import type { SystemDescriptionSnapshot } from '../../modules/source/spec-ownership.ts';

export type SystemDocumentCandidatePorts = Readonly<{
  loadActiveSessionContext(
    cwd: string,
    sessionId: string,
  ): {
    git: {
      repositoryRoot: string;
      head: string;
      branch: string | null;
      statusEntries: string[];
    };
    session: {
      repositoryRoot: string;
      baseline: { head: string };
      branch: string;
      changeId: string;
      taskId: string;
    };
    runtime: { root: string };
    config: { changeRoot: string };
  };
  readSystemDescriptionSnapshot(
    repositoryRoot: string,
    commit?: string,
  ): SystemDescriptionSnapshot;
  listChangedPaths(repositoryRoot: string, baselineCommit: string): string[];
  fingerprintRepositoryProjection(
    repositoryRoot: string,
    baselineCommit: string,
    statusEntries: string[],
  ): string;
  deltaChangesContract(
    documentPath: string,
    before: string,
    deltas: readonly string[],
  ): boolean;
}>;

export type SystemDocumentCandidate = ReturnType<
  typeof observeSystemDocumentCandidate
>;

export function observeSystemDocumentCandidate(
  cwd: string,
  sessionId: string,
  {
    loadActiveSessionContext,
    readSystemDescriptionSnapshot,
    listChangedPaths,
    fingerprintRepositoryProjection,
    deltaChangesContract: changesContract,
  }: SystemDocumentCandidatePorts,
) {
  const { git, session, runtime, config } = loadActiveSessionContext(
    cwd,
    sessionId,
  );
  if (
    path.resolve(session.repositoryRoot) !== path.resolve(git.repositoryRoot) ||
    session.baseline.head !== git.head ||
    session.branch !== git.branch
  )
    throw workflowError(
      'SYSTEM_DOCUMENT_REVIEW_STALE',
      'Read document obligations in the active task worktree at its baseline commit.',
      ExitCode.staleState,
    );
  const before = readSystemDescriptionSnapshot(
    git.repositoryRoot,
    session.baseline.head,
  );
  const after = readSystemDescriptionSnapshot(git.repositoryRoot);
  const documents = collectSystemDocumentObligations(
    before,
    after,
    listChangedPaths(git.repositoryRoot, session.baseline.head),
  );
  const discoveryIssues: string[] = [];
  const specs = documents.some(({ kind }) => kind === 'spec')
    ? [before, after].flatMap((snapshot) => {
        try {
          return systemSpecCatalog(snapshot);
        } catch (error) {
          if (!(error instanceof WorkflowError)) throw error;
          discoveryIssues.push(error.message);
          return [];
        }
      })
    : [];
  const deltaRoot = path.posix.join(
    config.changeRoot,
    session.changeId,
    'specs',
  );
  const boundDocuments: SystemDocumentObligation[] = documents.map(
    (document) => {
      if (document.kind !== 'spec') return document;
      const aliases = [
        ...new Set(
          specs
            .filter(({ path }) => path === document.path)
            .flatMap(({ aliases }) => aliases),
        ),
      ];
      const deltas = aliases
        .flatMap((alias) => {
          const deltaPath = path.posix.join(deltaRoot, alias, 'spec.md');
          const delta = after.readText(deltaPath);
          if (delta === undefined) return [];
          return [{ path: deltaPath, digest: sourceDigest(delta) }];
        })
        .sort((a, b) => a.path.localeCompare(b.path));
      let deltaChangesContract = false;
      if (deltas.length) {
        try {
          deltaChangesContract = changesContract(
            document.path,
            before.readText(document.path) ?? '',
            deltas.map(({ path }) => after.readText(path)!),
          );
        } catch (error) {
          if (!(error instanceof WorkflowError)) throw error;
        }
      }
      return { ...document, deltas, deltaChangesContract };
    },
  );
  const binding = {
    sessionId,
    changeId: session.changeId,
    taskId: session.taskId,
    worktree: git.repositoryRoot,
    branch: git.branch,
    baselineCommit: session.baseline.head,
    fingerprint: fingerprintRepositoryProjection(
      git.repositoryRoot,
      session.baseline.head,
      git.statusEntries,
    ),
    documents: boundDocuments,
    discoveryIssues,
  };
  return {
    ...binding,
    candidateDigest: grantSha256(canonicalJson(binding)),
    runtimeRoot: runtime.root,
  };
}
