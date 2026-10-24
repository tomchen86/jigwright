/**
 * Connects routing continuation checks to the repository Grant store.
 *
 * Invariants:
 * - Grant reads use the discovered Git-common directory and configured
 *   runtime directory.
 */
import { loadWorkflowConfig } from '../runtime/workflow-configuration/workflow-configuration.ts';
import type { ChangeRoutingContinuationGrantPort } from '../modules/lifecycle/change-routing.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../runtime/lifecycle-ledgers/grant-store.ts';
import { runtimePaths } from '../runtime/session-workspace/session-store.ts';

export const productionChangeRoutingContinuationGrantPort: ChangeRoutingContinuationGrantPort =
  Object.freeze({
    readGrantRecord(repositoryRoot: string, challengeId: string): unknown {
      const git = discoverRepository(repositoryRoot);
      const config = loadWorkflowConfig(repositoryRoot);
      const runtime = runtimePaths(
        git.gitCommonDirectory,
        config.runtimeDirectory,
      );
      return createFileGrantRecordStore(
        grantStorePaths(runtime.root),
      ).readGrantRecord(challengeId);
    },
  });
