/** Coordinates reconciliation against one observed session and its durable reports. */
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  assertImplementationTermDispositions,
  type ImplementationTermDelta,
} from '../../modules/assurance/implementation-term-dispositions.ts';
import {
  assertImplementationReconciled,
  reconcileImplementation,
  type ActualMutation,
  type ChangedRange,
  type ReconciliationVerdict,
} from '../../modules/why-knowledge/semantic-reconciliation.ts';
import {
  RECONCILIATION_REPORT_KIND,
  REPORT_SCHEMA,
  assertReconciliationRequest,
  assertEngineOwnedRequestFields,
  canonicalActualMutations,
  assertActualMutationCoverage,
  assertBoundedText,
  reconciliationInvalid,
  deepFreeze,
  type ImplementationReconciliationRequest,
  type ImplementationReconciliationRecord,
  type CurrentImplementationReconciliationRequirement,
  type ReconciledLedgerProjection,
} from '../../modules/why-knowledge/implementation-reconciliation.ts';

export type ReconciliationSessionFacts = Readonly<{
  sessionId: string;
  changeId: string;
  taskId: string;
  baseline: Readonly<{ head: string; tree: string }>;
  investigationBaseline?: Readonly<{ head: string; tree: string }>;
  completionStarted: boolean;
  implementationReconciliationReportId?: string;
  implementationReconciliationPaths?: readonly string[];
}>;
export type ReconciliationReport = Readonly<{
  schemaVersion: 1;
  kind: 'implementation-reconciliation';
  sessionId: string;
  changeId: string;
  taskId: string;
  createdAt: string;
  reconciliationSchema: string;
  request: ImplementationReconciliationRequest;
  verdict: ReconciliationVerdict;
  ledgerProjection: ReconciledLedgerProjection | null;
}>;
export type ReconciliationContext = Readonly<{
  session: ReconciliationSessionFacts;
  readRequirement(): CurrentImplementationReconciliationRequirement | null;
  deriveTarget(): {
    digest: string;
    changedRanges: readonly ChangedRange[];
    productionPaths: readonly string[];
  };
  deriveTermDelta(productionPaths: readonly string[]): ImplementationTermDelta;
  readReport(reportId: string): Readonly<{
    kind: string;
    changeId: string;
    taskId: string;
    reconciliationSchema?: unknown;
    request?: unknown;
    verdict?: unknown;
    ledgerProjection?: unknown;
  }>;
  assertLedgerProjection(value: unknown): ReconciledLedgerProjection;
  projectLedger(
    actualMutations: readonly ActualMutation[],
  ): ReconciledLedgerProjection | null;
  writeReport(report: ReconciliationReport): string;
  persistReport(
    reportId: string,
    projection: ReconciledLedgerProjection | null,
  ): void;
}>;
export function createImplementationReconciliationService<Inspection>(
  ports: Readonly<{
    listSessions(cwd: string): readonly Readonly<{
      state: string;
      changeId: string;
      sessionId: string;
    }>[];
    inspect(cwd: string, sessionId: string): Inspection;
    context(inspection: Inspection): ReconciliationContext;
    withSessionOperation<T>(
      cwd: string,
      sessionId: string,
      operation: () => T,
    ): T;
  }>,
) {
  const inspectSession = (cwd: string, sessionId: string) =>
    ports.context(ports.inspect(cwd, sessionId));
  const runSessionOperation = ports.withSessionOperation;
  const listSessions = ports.listSessions;
  function inspectImplementationReconciliation(
    cwd: string,
    requestedChangeId: string,
  ): ImplementationReconciliationRequest {
    const session = activeSessionForChange(cwd, requestedChangeId);
    return requestForInspection(inspectSession(cwd, session.sessionId));
  }

  /**
   * Persist one immutable reconciliation report and move only the owning task
   * session's pointer. Repeating exact input is idempotent; a changed target
   * requires a new immutable report and leaves the old report readable.
   */
  function recordImplementationReconciliation(
    cwd: string,
    requestedChangeId: string,
    candidate: unknown,
  ): ImplementationReconciliationRecord {
    const initial = activeSessionForChange(cwd, requestedChangeId);
    return runSessionOperation(cwd, initial.sessionId, () => {
      const inspection = inspectSession(cwd, initial.sessionId);
      if (inspection.session.completionStarted) {
        throw workflowError(
          'IMPLEMENTATION_RECONCILIATION_TOO_LATE',
          'Implementation reconciliation must be recorded before completion projection or staging.',
          ExitCode.staleState,
        );
      }
      const resolvedRequirement = requiredRequirementForInspection(inspection);
      const expected = requestForInspection(inspection, resolvedRequirement);
      const submitted = assertReconciliationRequest(candidate);
      assertEngineOwnedRequestFields(expected, submitted);
      const actualMutations = canonicalActualMutations(
        submitted.actualMutations,
      );
      assertActualMutationCoverage(
        expected.plannedMutations,
        expected.changedRanges,
        actualMutations,
      );
      const verdict = reconcileImplementation(
        expected.plannedMutations,
        actualMutations,
        expected.changedRanges,
      );
      assertImplementationReconciled(verdict);
      if (verdict.unplannedSubjects.length > 0) {
        throw workflowError(
          'SEMANTIC_DELTA_REVIEW_REQUIRED',
          'Implementation introduced subjects outside the reviewed planning-time mutation set.',
          ExitCode.verification,
          { details: { unplannedSubjects: verdict.unplannedSubjects } },
        );
      }
      const termDispositions = assertImplementationTermDispositions(
        expected.termDelta,
        submitted.termDispositions,
      );
      const request: ImplementationReconciliationRequest = deepFreeze({
        ...expected,
        actualMutations,
        termDispositions,
      });
      const currentReportId =
        inspection.session.implementationReconciliationReportId;
      if (currentReportId !== undefined) {
        const existing = readImplementationReconciliationReport(
          inspection,
          currentReportId,
        );
        if (canonicalJson(existing.request) === canonicalJson(request)) {
          return deepFreeze({
            reportId: currentReportId,
            request: existing.request,
            verdict: existing.verdict,
            ledgerProjection: existing.ledgerProjection,
          });
        }
        throw workflowError(
          'IMPLEMENTATION_TERM_ESCALATION_REQUIRED',
          'The single post-implementation term-review round was already consumed; changed implementation requires a fresh reviewed planning generation.',
          ExitCode.verification,
        );
      }
      const ledgerProjection = inspection.projectLedger(actualMutations);
      const report: ReconciliationReport = {
        schemaVersion: 1,
        kind: RECONCILIATION_REPORT_KIND,
        sessionId: inspection.session.sessionId,
        changeId: inspection.session.changeId,
        taskId: inspection.session.taskId,
        createdAt: new Date().toISOString(),
        reconciliationSchema: REPORT_SCHEMA,
        request,
        verdict,
        ledgerProjection,
      };
      const reportId = inspection.writeReport(report);
      inspection.persistReport(reportId, ledgerProjection);
      return deepFreeze({ reportId, request, verdict, ledgerProjection });
    });
  }

  /** Gate used by complete, finish, and projected finalize. */
  function assertCurrentImplementationReconciliation(
    inspection: ReconciliationContext,
  ): ImplementationReconciliationRecord | null {
    const requirement = requirementForInspection(inspection);
    if (requirement === null) return null;
    const reportId = inspection.session.implementationReconciliationReportId;
    if (reportId === undefined) {
      throw workflowError(
        'IMPLEMENTATION_RECONCILIATION_REQUIRED',
        'The current implementation has no durable structured reconciliation.',
        ExitCode.verification,
        {
          recovery:
            'Inspect and submit `workflow semantic-ledger reconcile --change <id>` before finalizing the task.',
        },
      );
    }
    const report = readImplementationReconciliationReport(inspection, reportId);
    const sessionPaths =
      inspection.session.implementationReconciliationPaths ?? [];
    const projectedPaths = report.ledgerProjection?.paths ?? [];
    if (canonicalJson(sessionPaths) !== canonicalJson(projectedPaths)) {
      throw workflowError(
        'IMPLEMENTATION_RECONCILIATION_CORRUPT',
        'The task session does not bind the exact semantic-ledger projection paths.',
        ExitCode.staleState,
      );
    }
    const expected = requestForInspection(inspection, requirement);
    try {
      assertEngineOwnedRequestFields(expected, report.request);
    } catch {
      throw workflowError(
        'IMPLEMENTATION_RECONCILIATION_STALE',
        'Implementation bytes or their reviewed reconciliation authority changed after the reconciliation was recorded.',
        ExitCode.staleState,
      );
    }
    assertActualMutationCoverage(
      expected.plannedMutations,
      expected.changedRanges,
      report.request.actualMutations,
    );
    assertImplementationTermDispositions(
      expected.termDelta,
      report.request.termDispositions,
    );
    const verdict = reconcileImplementation(
      expected.plannedMutations,
      report.request.actualMutations,
      expected.changedRanges,
    );
    assertImplementationReconciled(verdict);
    if (verdict.unplannedSubjects.length > 0) {
      throw workflowError(
        'SEMANTIC_DELTA_REVIEW_REQUIRED',
        'The recorded implementation includes subjects outside the reviewed mutation set.',
        ExitCode.verification,
        { details: { unplannedSubjects: verdict.unplannedSubjects } },
      );
    }
    return deepFreeze({
      reportId,
      request: report.request,
      verdict,
      ledgerProjection: report.ledgerProjection,
    });
  }

  function requestForInspection(
    inspection: ReconciliationContext,
    resolvedRequirement?: CurrentImplementationReconciliationRequirement,
  ): ImplementationReconciliationRequest {
    const resolved =
      resolvedRequirement ?? requiredRequirementForInspection(inspection);
    const target = inspection.deriveTarget();
    const termDelta = inspection.deriveTermDelta(target.productionPaths);
    return deepFreeze({
      schemaVersion: 2,
      kind: 'implementation-reconciliation',
      changeId: inspection.session.changeId,
      sessionId: inspection.session.sessionId,
      baseline: { ...inspection.session.baseline },
      requirementId: resolved.requirementId,
      requirementDigest: resolved.requirementDigest,
      investigationManifestDigest: resolved.investigationManifestDigest,
      implementationTargetDigest: target.digest,
      plannedMutations: resolved.requirement.plannedMutations,
      changedRanges: target.changedRanges,
      termDelta,
      termDispositions: Object.freeze([]),
      actualMutations: Object.freeze([]),
    });
  }

  function requiredRequirementForInspection(
    inspection: ReconciliationContext,
  ): CurrentImplementationReconciliationRequirement {
    const resolved = requirementForInspection(inspection);
    if (resolved === null) {
      throw workflowError(
        'IMPLEMENTATION_RECONCILIATION_NOT_APPLICABLE',
        'The governing investigation has no implementation reconciliation requirement.',
        ExitCode.guard,
      );
    }
    return resolved;
  }

  function requirementForInspection(
    inspection: ReconciliationContext,
  ): CurrentImplementationReconciliationRequirement | null {
    const resolved = inspection.readRequirement();
    if (resolved === null) return null;
    const requirement = resolved.requirement;
    const expectedInvestigationBaseline =
      inspection.session.investigationBaseline;
    if (
      requirement.changeId !== inspection.session.changeId ||
      expectedInvestigationBaseline === undefined ||
      canonicalJson(requirement.baseline) !==
        canonicalJson(expectedInvestigationBaseline)
    ) {
      throw reconciliationInvalid(
        'Implementation reconciliation requirement does not match the governing planning generation.',
      );
    }
    return resolved;
  }

  function activeSessionForChange(
    cwd: string,
    requestedChangeId: string,
  ): Readonly<{ sessionId: string }> {
    const changeId = assertBoundedText(requestedChangeId, 'change ID', 512);
    const sessions = listSessions(cwd).filter(
      (session) => session.state === 'active' && session.changeId === changeId,
    );
    if (sessions.length !== 1) {
      throw workflowError(
        'IMPLEMENTATION_RECONCILIATION_SESSION_REQUIRED',
        `Implementation reconciliation requires exactly one active task session for ${changeId}.`,
        ExitCode.guard,
        { details: { activeSessionCount: sessions.length } },
      );
    }
    return sessions[0]!;
  }

  function readImplementationReconciliationReport(
    inspection: ReconciliationContext,
    reportId: string,
  ): {
    request: ImplementationReconciliationRequest;
    verdict: ReconciliationVerdict;
    ledgerProjection: ReconciledLedgerProjection | null;
  } {
    const report = inspection.readReport(reportId);
    if (
      report.kind !== RECONCILIATION_REPORT_KIND ||
      report.changeId !== inspection.session.changeId ||
      report.taskId !== inspection.session.taskId ||
      report.reconciliationSchema !== REPORT_SCHEMA
    ) {
      throw workflowError(
        'IMPLEMENTATION_RECONCILIATION_CORRUPT',
        'The implementation reconciliation report identity is invalid.',
        ExitCode.staleState,
      );
    }
    const request = assertReconciliationRequest(report.request);
    const actualMutations = canonicalActualMutations(request.actualMutations);
    const normalizedRequest = deepFreeze({ ...request, actualMutations });
    const verdict = reconcileImplementation(
      normalizedRequest.plannedMutations,
      actualMutations,
      normalizedRequest.changedRanges,
    );
    if (canonicalJson(verdict) !== canonicalJson(report.verdict)) {
      throw workflowError(
        'IMPLEMENTATION_RECONCILIATION_CORRUPT',
        'The implementation reconciliation verdict does not match its evidence.',
        ExitCode.staleState,
      );
    }
    let ledgerProjection: ReconciledLedgerProjection | null;
    try {
      ledgerProjection =
        report.ledgerProjection === null
          ? null
          : inspection.assertLedgerProjection(report.ledgerProjection);
    } catch {
      throw workflowError(
        'IMPLEMENTATION_RECONCILIATION_STALE',
        'The semantic-ledger projection changed after reconciliation.',
        ExitCode.staleState,
      );
    }
    return { request: normalizedRequest, verdict, ledgerProjection };
  }

  return Object.freeze({
    inspectImplementationReconciliation,
    recordImplementationReconciliation,
    assertCurrentImplementationReconciliation: (inspection: Inspection) =>
      assertCurrentImplementationReconciliation(ports.context(inspection)),
  });
}
