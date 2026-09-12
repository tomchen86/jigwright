import {
  workflowGrantServices,
  sessionLifecycle,
  archiveDependencies,
} from './session-lifecycle-production.ts';
import { createHumanGrantCli } from '../src/entrypoints/cli/human-grant-cli.ts';
export const { runHumanGrantCli, dispatchHumanGrantCli } = createHumanGrantCli(
  workflowGrantServices,
);
import { createHarnessBootstrapDependencies } from './harness-bootstrap-production.ts';
/** Assemble the verified engine inside its selected child process. */
import { pathToFileURL } from 'node:url';
import { createWorkflowCli } from '../src/entrypoints/cli/workflow-cli.ts';
import { createAuthorityCommands } from '../src/entrypoints/cli/authority-management-cli.ts';
import { isHumanGrantCliInvocation } from '../src/entrypoints/cli/human-grant-cli.ts';
import {
  maintainerAuthorityOperations,
  controlPlanePromotionBootstrapObservations,
} from './maintainer-authority-production.ts';

export const {
  createProtectedTaskApplyDescendantSettlementFailGrantResult,
  createProtectedTaskApplyFailGrantResult,
  createProtectedTaskApplyRecoveryFailGrantResult,
  createChangeRoutingFailGrantResult,
  createRoleAssignmentFailGrantResult,
  createProposeProtectedBaseFailGrantResult,
  createWorkRegistryFailGrantResult,
  createSystemDocumentFailGrantResult,
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
  workflowGrants: workflowGrantServices,
  sessionLifecycle,
  archiveDependencies,
});
export {
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
