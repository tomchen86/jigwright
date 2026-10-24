/** Compose retention observations, durable storage and human authority for real consumers. */
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
import { taskMandateOperations } from './task-mandate-production.ts';
import {
  runEvidenceRetentionMaintenance as maintainEvidence,
  inspectEvidenceRetention as inspectEvidence,
  pinWorkflowEvidence as pinEvidence,
} from '../application/control-plane/evidence-retention.ts';
import {
  inspectProviderRetentionMetrics as inspectProviderMetrics,
  pruneProviderRuntime as pruneProvider,
  assertProviderRuntimeEvidencePinnableUnderLifecycleLock,
} from '../runtime/provider-execution/provider-retention.ts';
import { observeRetentionWorkflowBindings } from '../runtime/provider-execution/provider-retention-observation.ts';
import { runDurableContextRetentionMaintenance } from '../runtime/provider-execution/retention-control.ts';
import { inspectDurableEpochContextStore } from '../runtime/storage-journal/execution-governance-epoch-store.ts';
import {
  inspectDurableRetentionCatalog,
  pinDurableEvidence,
} from '../runtime/storage-journal/execution-governance-evidence-store.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { parseMaintainerPolicy } from '../modules/authority/maintainer-policy.ts';
import { createInteractiveSshSigner } from '../adapters/signing/ssh/maintainer-signer.ts';
import { readFileAtRevision } from '../runtime/repository-transaction/git-command.ts';

export const inspectProviderRetentionMetrics = inspectProviderMetrics.bind(
  undefined,
  loadInvestigationRuntimeContext,
);
export const pruneProviderRuntime = pruneProvider.bind(
  undefined,
  loadInvestigationRuntimeContext,
);
const observations = {
  runtime: (cwd: string) => loadInvestigationRuntimeContext(cwd).runtime,
  workflowBindings: (cwd: string) =>
    observeRetentionWorkflowBindings(
      loadInvestigationRuntimeContext(cwd).runtime,
    ),
  now: () => new Date(),
};
export const runEvidenceRetentionMaintenance = maintainEvidence.bind(
  undefined,
  {
    ...observations,
    pruneProviderRuntime,
    maintainDurableContexts: runDurableContextRetentionMaintenance,
  },
);
export const inspectEvidenceRetention = inspectEvidence.bind(undefined, {
  ...observations,
  context: inspectDurableEpochContextStore,
  catalog: inspectDurableRetentionCatalog,
  inspectProviderRetentionMetrics,
});
export const pinWorkflowEvidence = pinEvidence.bind(undefined, {
  ...observations,
  catalog: inspectDurableRetentionCatalog,
  policy(cwd: string) {
    const repository = discoverRepository(cwd);
    const policy = parseMaintainerPolicy(
      JSON.parse(
        readFileAtRevision(
          repository.repositoryRoot,
          repository.head,
          'workflow/maintainer-policy.json',
        ),
      ),
    );
    return { repositoryRoot: repository.repositoryRoot, policy };
  },
  createSigner: createInteractiveSshSigner,
  withActiveTaskMandateBinding:
    taskMandateOperations.withActiveTaskMandateBinding,
  assertPinnable: assertProviderRuntimeEvidencePinnableUnderLifecycleLock,
  pinEvidence: pinDurableEvidence,
});
