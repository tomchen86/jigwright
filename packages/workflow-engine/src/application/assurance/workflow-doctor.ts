/** Combines repository observations into diagnostics without performing physical operations. */
import path from 'node:path';
import type { GitState } from '../../modules/repository-consumer/repository-git-state.ts';
import type { WorkflowConfig } from '../../modules/repository-consumer/workflow-config.ts';
import type { SystemDescriptionSnapshot } from '../../modules/source/spec-ownership.ts';
import { systemSpecPaths } from '../../modules/source/system-documents.ts';
import type { SystemDocumentInspection } from '../../modules/source/system-documents.ts';
import type { WorkflowSession } from '../../modules/lifecycle/workflow-session-contract.ts';
import type { OpenSpecDiagnosticReport } from '../../modules/planning-provider/openspec-diagnostics.ts';

export type WorkflowDoctorOperations<TProjectionReport> = Readonly<{
  discoverRepository(
    cwd: string,
  ): Pick<
    GitState,
    | 'repositoryRoot'
    | 'repositoryRealPath'
    | 'gitCommonDirectory'
    | 'branch'
    | 'head'
    | 'statusEntries'
  >;
  loadWorkflowConfig(
    repositoryRoot: string,
  ): Pick<
    WorkflowConfig,
    'changeRoot' | 'runtimeDirectory' | 'protectedBranches' | 'branchTemplate'
  >;
  diagnoseOpenSpec(repositoryRoot: string): OpenSpecDiagnosticReport;
  readSystemDescriptionSnapshot(
    repositoryRoot: string,
  ): SystemDescriptionSnapshot;
  inspectRepositorySystemDocuments(
    repositoryRoot: string,
    snapshot: SystemDescriptionSnapshot,
    proof: false,
  ): { report: Pick<SystemDocumentInspection, 'issues'> };
  existsPath(absolutePath: string): boolean;
  inspectProjectionStatus(repositoryRoot: string): TProjectionReport;
  listSessions(cwd: string): readonly Pick<WorkflowSession, 'state'>[];
}>;

export function createWorkflowDoctor<TProjectionReport>(
  operations: WorkflowDoctorOperations<TProjectionReport>,
) {
  const {
    discoverRepository,
    loadWorkflowConfig,
    diagnoseOpenSpec,
    readSystemDescriptionSnapshot,
    inspectRepositorySystemDocuments,
    existsPath,
    inspectProjectionStatus,
    listSessions,
  } = operations;
  return function diagnoseWorkflowRepository(cwd: string) {
    const git = discoverRepository(cwd);
    const config = loadWorkflowConfig(git.repositoryRoot);
    const openspec = diagnoseOpenSpec(git.repositoryRoot);
    const warnings: Array<{ code: string; message: string }> = [];
    const snapshot = readSystemDescriptionSnapshot(git.repositoryRoot);
    const colocatedSpecs = systemSpecPaths(snapshot.listPaths());
    let systemDocuments: {
      configured: boolean;
      healthy: boolean;
      specCount: number;
      diagnostics: readonly { code: string; message: string }[];
    } = {
      configured: colocatedSpecs.length > 0,
      healthy: true,
      specCount: colocatedSpecs.length,
      diagnostics: [],
    };
    if (colocatedSpecs.length > 0) {
      try {
        const { report } = inspectRepositorySystemDocuments(
          git.repositoryRoot,
          snapshot,
          false,
        );
        const diagnostics = report.issues.filter(
          (issue) => issue.code !== 'test-not-passed',
        );
        systemDocuments = {
          ...systemDocuments,
          healthy: diagnostics.length === 0,
          diagnostics,
        };
      } catch (error) {
        systemDocuments = {
          ...systemDocuments,
          healthy: false,
          diagnostics: [
            { code: 'SYSTEM_DOCUMENTS_INVALID', message: String(error) },
          ],
        };
      }
    }

    if (!git.branch) {
      warnings.push({ code: 'DETACHED_HEAD', message: 'HEAD is detached.' });
    } else if (config.protectedBranches.includes(git.branch)) {
      warnings.push({
        code: 'PROTECTED_BRANCH',
        message: `Current branch ${git.branch} is protected; task session activation will fail.`,
      });
    }
    if (git.statusEntries.length > 0) {
      warnings.push({
        code: 'DIRTY_WORKTREE',
        message: `Worktree has ${git.statusEntries.length} staged, unstaged, or untracked status entries; task session activation will fail.`,
      });
    }
    const baseSpecRoot = path.posix.join(
      path.posix.dirname(config.changeRoot),
      'specs',
    );
    if (
      colocatedSpecs.length === 0 &&
      !existsPath(path.join(git.repositoryRoot, baseSpecRoot))
    ) {
      warnings.push({
        code: 'NO_BASE_SPECS',
        message: `${baseSpecRoot} does not exist yet; create the current managed base specifications before planning changes.`,
      });
    }
    for (const diagnostic of openspec.diagnostics) {
      if (diagnostic.severity !== 'info') {
        warnings.push({
          code: diagnostic.code,
          message: diagnostic.message,
        });
      }
    }

    return {
      ok: openspec.healthy && systemDocuments.healthy,
      mode: 'diagnostic',
      repository: {
        root: git.repositoryRealPath,
        gitCommonDirectory: git.gitCommonDirectory,
        branch: git.branch,
        head: git.head,
        clean: git.statusEntries.length === 0,
      },
      configuration: {
        path: 'workflow/config.json',
        changeRoot: config.changeRoot,
        runtimeDirectory: config.runtimeDirectory,
        protectedBranches: config.protectedBranches,
        branchTemplate: config.branchTemplate,
      },
      openspec,
      systemDocuments,
      projections: inspectProjectionStatus(git.repositoryRoot),
      retainedSpectraUsed: false,
      activeSessionCount: listSessions(cwd).filter(
        (session) => session.state === 'active' || session.state === 'revising',
      ).length,
      warnings,
    };
  };
}
