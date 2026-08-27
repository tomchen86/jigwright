import { loadWorkflowConfig } from '../adapters/consumer/repository/work-registry/contracts.ts';
import type { ChangeRoutingContinuationGrantPort } from '../modules/lifecycle/change-routing.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import {
  grantStorePaths,
  readGrantRecord,
} from '../runtime/storage-journal/grant-store.ts';
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
      return readGrantRecord(grantStorePaths(runtime.root), challengeId);
    },
  });
