import { createHarnessBootstrapDependencies } from './harness-bootstrap-production.ts';
/** Assemble the verified engine inside its selected child process. */
import { pathToFileURL } from 'node:url';
import { createWorkflowCli } from '../src/entrypoints/cli/workflow-cli.ts';
import { createAuthorityCommands } from '../src/entrypoints/cli/authority-management-cli.ts';
import {
  isHumanGrantCliInvocation,
  runHumanGrantCli,
} from '../src/entrypoints/cli/human-grant-cli.ts';
import {
  maintainerAuthorityOperations,
  controlPlanePromotionBootstrapObservations,
} from './maintainer-authority-production.ts';

export const {
  runCli,
  runCliAsync,
  dispatchAsync,
  createAsyncCliDispatcherForTesting,
} = createWorkflowCli({
  ...createAuthorityCommands(
    maintainerAuthorityOperations,
    controlPlanePromotionBootstrapObservations,
  ),
  createHarnessBootstrapDependencies,
});
export {
  createProtectedTaskApplyDescendantSettlementFailGrantResult,
  createProtectedTaskApplyFailGrantResult,
  createProtectedTaskApplyRecoveryFailGrantResult,
  createChangeRoutingFailGrantResult,
  createRoleAssignmentFailGrantResult,
  createProposeProtectedBaseFailGrantResult,
  createWorkRegistryFailGrantResult,
  createArchivePullRequestCliDispatcherForTesting,
  dispatchPreparedTaskStrategyProvider,
} from '../src/entrypoints/cli/workflow-cli.ts';

const entryPath = process.argv[1];

if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const argv = process.argv.slice(2);
  if (isHumanGrantCliInvocation(argv)) {
    void runHumanGrantCli(argv).then((exitCode) => {
      process.exitCode = exitCode;
    });
  } else {
    void runCliAsync(argv).then((exitCode) => {
      process.exitCode = exitCode;
    });
  }
}
