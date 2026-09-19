import type { SessionInspection } from '../modules/lifecycle/session-inspection.ts';
import { productionChangeContract } from './change-routing-observation-production.ts';
/** Binds reconciliation to repository observation, session locking and immutable storage. */
import { createImplementationReconciliationService } from '../application/reconciliation/implementation-reconciliation.ts';
import { readCurrentImplementationReconciliationRequirement } from '../application/reconciliation/investigation-reconciliation.ts';
import { listSessions } from '../application/execute-task/session.ts';
import {
  inspectSession,
  persistSession,
  writeSessionReport,
} from '../application/finalize/verification.ts';
import { deriveImplementationTarget } from '../runtime/repository-observation/implementation-target.ts';
import { deriveImplementationTermDelta } from './implementation-term-floor-production.ts';
import { readImmutableReport } from '../runtime/storage-journal/report-store.ts';
import { runtimePaths } from '../runtime/session-workspace/session-store.ts';
import {
  assertReconciledLedgerProjection,
  projectReconciledInvestigationManifestWhyToLedger,
} from '../runtime/managed-documents/transaction/semantic-ledger-projection.ts';
import {
  IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
  reconciliationInvalid,
} from '../modules/why-knowledge/implementation-reconciliation.ts';
import { runSessionOperation } from './lifecycle-context.ts';

export const {
  inspectImplementationReconciliation,
  recordImplementationReconciliation,
  assertCurrentImplementationReconciliation,
} = createImplementationReconciliationService<SessionInspection>({
  listSessions,
  inspect: inspectSession.bind(undefined, productionChangeContract),
  withSessionOperation: runSessionOperation,
  context(inspection) {
    const { session, git, contract } = inspection;
    const investigation = contract.investigation;
    return {
      session: {
        sessionId: session.sessionId,
        changeId: session.changeId,
        taskId: session.taskId,
        baseline: session.baseline,
        ...(session.planningAssurance?.investigationBaseline === undefined
          ? {}
          : {
              investigationBaseline:
                session.planningAssurance.investigationBaseline,
            }),
        completionStarted:
          session.completionReportId !== undefined ||
          session.finishReportId !== undefined ||
          session.commitReportId !== undefined,
        ...(session.implementationReconciliationReportId === undefined
          ? {}
          : {
              implementationReconciliationReportId:
                session.implementationReconciliationReportId,
            }),
        ...(session.implementationReconciliationPaths === undefined
          ? {}
          : {
              implementationReconciliationPaths:
                session.implementationReconciliationPaths,
            }),
      },
      readRequirement: () =>
        investigation == null
          ? null
          : readCurrentImplementationReconciliationRequirement(investigation),
      deriveTarget: () =>
        deriveImplementationTarget({
          repositoryRoot: git.repositoryRoot,
          baseline: session.baseline,
          changedPaths: inspection.changedPaths,
        }),
      deriveTermDelta(productionPaths) {
        if (investigation == null)
          throw reconciliationInvalid(
            'Implementation term-floor replay requires the governing investigation.',
          );
        return deriveImplementationTermDelta({
          repositoryRoot: git.repositoryRoot,
          baselineCommit: session.baseline.head,
          productionPaths,
          investigation,
        });
      },
      readReport: (reportId) =>
        readImmutableReport(
          runtimePaths(git.gitCommonDirectory, contract.config.runtimeDirectory)
            .reports,
          session.sessionId,
          reportId,
        ),
      assertLedgerProjection: (value) =>
        assertReconciledLedgerProjection(git.repositoryRoot, value),
      projectLedger(actualMutations) {
        if (
          investigation == null ||
          investigation.manifest.applicability.kind !== 'ordinary'
        )
          throw reconciliationInvalid(
            'Implementation reconciliation requires ordinary investigation WHY evidence.',
          );
        return projectReconciledInvestigationManifestWhyToLedger({
          repositoryRoot: git.repositoryRoot,
          changeId: session.changeId,
          baselineCommit: session.baseline.head,
          whyOverlays:
            investigation.manifest.applicability.semanticDelta.whyOverlays,
          policyDigest: IMPLEMENTATION_RECONCILIATION_POLICY_DIGEST,
          actualMutations,
        });
      },
      writeReport: (report) => writeSessionReport(inspection, report),
      persistReport(reportId, ledgerProjection) {
        persistSession(inspection, {
          ...session,
          implementationReconciliationReportId: reportId,
          ...(ledgerProjection === null
            ? {}
            : {
                implementationReconciliationPaths: [...ledgerProjection.paths],
              }),
        });
      },
    };
  },
});
