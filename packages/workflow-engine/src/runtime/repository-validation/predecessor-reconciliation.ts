import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import {
  assertPinnedPredecessorContract,
  assertPredecessorCommit,
  predecessorInvalid,
  selectImmediatePredecessor,
  type ReconciledTask,
} from '../../modules/lifecycle/predecessor-reconciliation.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import { readFileAtRevision } from '../repository-transaction/git-command.ts';
import {
  commitChangedPaths,
  commitFacts,
} from '../repository-transaction/git-transitions.ts';
import type { SessionCheckService } from './session-verification.ts';

/** Observes pinned predecessor evidence and executes its independent checks. */

export function reconcilePredecessor(
  sessionChecks: Pick<SessionCheckService, 'executeChecks'>,
  cwd: string,
  inspection: SessionInspection,
  environment: NodeJS.ProcessEnv,
): ReconciledTask[] {
  const predecessor = selectImmediatePredecessor(
    inspection.contract,
    inspection.session,
  );
  if (predecessor === null) return [];

  const policy = inspection.contract.guard.tasks[predecessor.id];
  const taskId = predecessor.id;
  const guardPath = `${inspection.contract.config.changeRoot}/${inspection.session.changeId}/guard.json`;
  const baselineGuard = baselineJson(inspection, guardPath);
  const baselineChecks = baselineJson(inspection, 'workflow/checks.json');
  assertPinnedPredecessorContract(
    inspection.contract,
    taskId,
    policy,
    baselineGuard,
    baselineChecks,
  );
  const facts = commitFacts(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
  );
  const changedPaths = commitChangedPaths(
    inspection.git.repositoryRoot,
    inspection.session.baseline.head,
  );
  assertPredecessorCommit(
    facts,
    changedPaths,
    inspection.session,
    predecessor,
    policy,
  );

  const verified = sessionChecks.executeChecks({
    cwd,
    initial: inspection,
    checkIds: policy.requiredChecks,
    environment,
  });
  return [
    {
      taskId: predecessor.id,
      commitHash: inspection.session.baseline.head,
      changedPaths,
      checks: verified.checks,
    },
  ];
}

function baselineJson(
  inspection: SessionInspection,
  relativePath: string,
): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(
      readFileAtRevision(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
        relativePath,
      ),
    );
    if (isRecord(value)) {
      return value;
    }
  } catch {
    // Converted to one fail-closed reconciliation error below.
  }
  throw predecessorInvalid();
}
