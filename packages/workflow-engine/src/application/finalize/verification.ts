import type { MaintainerManifestOperations } from '../../modules/authority/maintainer-manifest.ts';
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
import type { ReviewedGeneratedAssetInventory } from '../../modules/source/mutation-class-policy.ts';
import type { TaskStrategyExecutionGate } from '../../modules/assurance/task-strategy-gate.ts';
import crypto from 'node:crypto';
import path from 'node:path';
import type { LocalEngineSelectionReaders } from '../../modules/authority/local-engine-selection.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { loadWorkflowConfig } from '../../runtime/workflow-configuration/workflow-configuration.ts';
import { digestRequiredCheckDefinitions } from '../../modules/lifecycle/contract-digests.ts';
import type {
  CheckEvidence,
  CheckEvidenceMetadata,
} from '../../foundation/check-evidence/check-evidence.ts';
import type { CheckExecutionFactory } from '../../modules/assurance/check-execution-port.ts';
import {
  prepareCheckBatch,
  requirePassedCheck,
} from '../../modules/assurance/check-execution.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  readLocalEngineBinding,
  readPersistedWipBundle,
} from '../control-plane/intervention-control-bootstrap.ts';
import { readPersistedEngineAdoption } from '../../runtime/storage-journal/intervention-control-persistence.ts';
import { type CheckDependency } from '../../modules/authority/maintainer-manifest-contracts.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import {
  readImmutableReport,
  writeImmutableReport,
} from '../../runtime/storage-journal/report-store.ts';
import type { WorkflowReport } from '../../modules/lifecycle/workflow-report.ts';
import {
  assertInspectionReport,
  assertReportChecks,
} from '../../modules/lifecycle/workflow-report.ts';
import {
  readSessionFile,
  runtimePaths,
  type WorkflowSession,
  withSessionOperation,
  writeJsonAtomic,
} from '../../runtime/session-workspace/session-store.ts';
import { ensureTaskMechanicalTransformationEvidence } from './task-mechanical-transform.ts';
import { type ProtectedTaskApplyAuthorizationBinding } from '../../runtime/storage-journal/finalize-transaction.ts';
import { inspectSession } from '../session-inspection/session-inspection.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import { readFileAtRevision } from '../../runtime/repository-transaction/git-command.ts';

/**
 * Inspects task sessions, executes checks, and reconciles evidence after
 * engine adoption.
 *
 * Invariants:
 * - Adoption reconciliation rejects a session changed since its trusted
 *   checkpoint.
 */

export type SessionCheck = {
  sessionId: string;
  changeId: string;
  taskId: string;
  changedPaths: string[];
  unexpectedPaths: string[];
  checks: CheckEvidence[];
  executedCheckIds: string[];
  reusedCheckIds: string[];
  passed: true;
  reportId: string;
};

export type SessionCheckOptions = {
  environment?: NodeJS.ProcessEnv;
  /** Trusted clock used to bind persisted check completion and freshness. */
  now?: () => Date;
  /**
   * Engine-owned trust seam for current external snapshots. Production callers
   * must never populate this from argv, candidate content, persisted session
   * fields, or ambient environment values.
   */
  externalSnapshotDigests?: Readonly<Record<string, string>>;
  /** Test-only crash window after immutable publication and before CAS. */
  testAfterReconciliationReport?: () => void;
};

type TrustedCheckPolicy = {
  checkDependencies: Record<string, CheckDependency[]>;
  externalStateFreshness: Record<string, { maxAgeMs: number }>;
};

type SessionCheckDependencies = Readonly<{
  reviewedAssets: ReviewedGeneratedAssetInventory;
  localEngineSelection: LocalEngineSelectionReaders;
  manifestOperations: MaintainerManifestOperations;
  taskStrategyExecutionGate: TaskStrategyExecutionGate<SessionInspection>;
  changeContract: ChangeContractServices;
  createExecution: CheckExecutionFactory;
}>;

/** Binds capabilities without observing repository, environment, or clock state. */
export function createSessionCheckService(services: SessionCheckDependencies) {
  return Object.freeze({
    checkSession: checkSession.bind(undefined, services),
    reconcileSessionChecksAfterLocalEngineAdoption:
      reconcileSessionChecksAfterLocalEngineAdoption.bind(undefined, services),
    executeChecks: executeChecks.bind(undefined, services),
  });
}

export type SessionCheckService = ReturnType<typeof createSessionCheckService>;

function checkSession(
  services: SessionCheckDependencies,
  cwd: string,
  requestedSessionId: string,
  options: SessionCheckOptions = {},
): SessionCheck {
  const discovered = discoverRepository(cwd);
  const config = loadWorkflowConfig(discovered.repositoryRoot);
  const runtime = runtimePaths(
    discovered.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const sessionId = assertSessionId(requestedSessionId);
  return withSessionOperation(runtime, sessionId, () =>
    checkSessionUnlocked(services, cwd, sessionId, options),
  );
}

function checkSessionUnlocked(
  services: SessionCheckDependencies,
  cwd: string,
  requestedSessionId: string,
  options: SessionCheckOptions,
): SessionCheck {
  const {
    reviewedAssets,
    localEngineSelection,
    manifestOperations,
    taskStrategyExecutionGate,
    changeContract,
  } = services;
  const reconciled = reconcileSessionChecksAfterLocalEngineAdoption(
    services,
    cwd,
    requestedSessionId,
    options,
  );
  if (reconciled !== null) return reconciled;
  const initial = inspectSession(changeContract, cwd, requestedSessionId);
  ensureTaskMechanicalTransformationEvidence(reviewedAssets, initial);
  taskStrategyExecutionGate.assertExecutionAdmitted(
    initial,
    options.environment ?? process.env,
  );
  const trustedPolicy = tryLoadTrustedCheckPolicy(
    manifestOperations,
    initial.git.repositoryRoot,
    initial.session.baseline.head,
    initial.session.requiredChecks,
  );
  const evidenceMetadata = trustedPolicy
    ? createSessionEvidenceMetadata(
        initial.session.requiredChecks,
        trustedPolicy,
        options,
      )
    : undefined;
  const verified = executeChecks(services, {
    cwd,
    initial,
    checkIds: initial.session.requiredChecks,
    environment: options.environment ?? process.env,
    evidenceMetadata,
  });
  const report: WorkflowReport = {
    schemaVersion: 1,
    kind: 'check',
    sessionId: initial.session.sessionId,
    changeId: initial.session.changeId,
    taskId: initial.session.taskId,
    createdAt: new Date().toISOString(),
    baseline: initial.session.baseline,
    branch: initial.session.branch,
    artifactDigests: verified.inspection.artifactDigests,
    allowedPaths: initial.session.allowedPaths,
    requiredChecks: initial.session.requiredChecks,
    requiredCheckDigests: digestRequiredCheckDefinitions(
      initial.contract.checks,
      initial.session.requiredChecks,
    ),
    changedPaths: verified.inspection.changedPaths,
    fingerprint: verified.inspection.fingerprint,
    checks: verified.checks,
    ...(trustedPolicy
      ? {
          checkDependencies: trustedPolicy.checkDependencies,
          externalStateFreshness: trustedPolicy.externalStateFreshness,
        }
      : {}),
  };
  const reportId = writeSessionReport(verified.inspection, report);
  const localAdoption = resolveVerifiedLocalAdoption(
    localEngineSelection,
    verified.inspection,
    options.environment ?? process.env,
  );
  persistSession(verified.inspection, {
    ...verified.inspection.session,
    latestCheckReportId: reportId,
    ...(localAdoption
      ? { checkEvidenceEngineDigest: localAdoption.toEngineDigest }
      : {}),
  });

  return {
    sessionId: initial.session.sessionId,
    changeId: initial.session.changeId,
    taskId: initial.session.taskId,
    changedPaths: verified.inspection.changedPaths,
    unexpectedPaths: [],
    checks: verified.checks,
    executedCheckIds: [...initial.session.requiredChecks],
    reusedCheckIds: [],
    passed: true,
    reportId,
  };
}

type VerifiedLocalAdoption = {
  txId: string;
  checkpointId: `sha256:${string}`;
  fromEngineDigest: `sha256:${string}`;
  toEngineDigest: `sha256:${string}`;
  committedAt: string;
  journalDigest: `sha256:${string}`;
  snapshotSession: WorkflowSession;
};

/**
 * Reconcile only check evidence affected by a bootstrap-verified local engine
 * adoption.  The immutable replacement report is intentionally timestamped
 * from the adoption journal, so a crash after publication but before the
 * session CAS replays to the same content-addressed report ID.
 */
function reconcileSessionChecksAfterLocalEngineAdoption(
  services: SessionCheckDependencies,
  cwd: string,
  requestedSessionId: string,
  options: SessionCheckOptions = {},
): SessionCheck | null {
  const { localEngineSelection, manifestOperations, changeContract } = services;
  const initial = inspectSession(changeContract, cwd, requestedSessionId);
  const adoption = resolveVerifiedLocalAdoption(
    localEngineSelection,
    initial,
    options.environment ?? process.env,
  );
  if (adoption === null || !initial.session.latestCheckReportId) return null;
  if (initial.session.checkEvidenceEngineDigest === adoption.toEngineDigest) {
    return null;
  }
  if (
    initial.session.checkEvidenceEngineDigest !== undefined &&
    initial.session.checkEvidenceEngineDigest !== adoption.fromEngineDigest
  ) {
    throw workflowError(
      'SESSION_CHECK_ENGINE_BINDING_CONFLICT',
      'Durable check evidence is bound to neither side of the verified local engine adoption.',
      ExitCode.staleState,
    );
  }
  if (
    canonicalJson(adoption.snapshotSession) !== canonicalJson(initial.session)
  ) {
    throw workflowError(
      'SESSION_ADOPTION_CHECKPOINT_CHANGED',
      'The durable parent session changed after its intervention checkpoint.',
      ExitCode.staleState,
    );
  }

  const previousReportId = initial.session.latestCheckReportId;
  const previousReport = readImmutableReport(
    runtimePaths(
      initial.git.gitCommonDirectory,
      initial.contract.config.runtimeDirectory,
    ).reports,
    initial.session.sessionId,
    previousReportId,
  );
  assertInspectionReport(
    previousReport,
    initial,
    'check',
    'CHECK_REPORT_STALE',
  );
  assertReportChecks(
    previousReport,
    initial,
    initial.session.requiredChecks,
    'CHECK_REPORT_STALE',
  );
  if (previousReport.parentReportId !== undefined) {
    throw workflowError(
      'CHECK_REPORT_STALE',
      'The current check report has an unexpected report parent.',
      ExitCode.staleState,
    );
  }

  const trustedPolicy = loadTrustedCheckPolicy(
    manifestOperations,
    initial.git.repositoryRoot,
    initial.session.baseline.head,
    initial.session.requiredChecks,
  );
  const { checkDependencies, externalStateFreshness } = trustedPolicy;
  if (
    previousReport.checkDependencies !== undefined &&
    canonicalJson(previousReport.checkDependencies) !==
      canonicalJson(checkDependencies)
  ) {
    throw workflowError(
      'SESSION_CHECK_ATTESTATION_MISMATCH',
      'Persisted check dependency attestation differs from its trust-base declaration.',
      ExitCode.staleState,
    );
  }
  if (
    previousReport.externalStateFreshness !== undefined &&
    canonicalJson(previousReport.externalStateFreshness) !==
      canonicalJson(externalStateFreshness)
  ) {
    throw workflowError(
      'SESSION_CHECK_ATTESTATION_MISMATCH',
      'Persisted external-state freshness attestation differs from its trust-base declaration.',
      ExitCode.staleState,
    );
  }

  const previousChecks = previousReport.checks as CheckEvidence[];
  const previousById = new Map(
    previousChecks.map((evidence) => [evidence.checkId, evidence]),
  );
  const now = (options.now ?? (() => new Date()))();
  if (!Number.isFinite(now.getTime())) {
    throw workflowError(
      'SESSION_CHECK_CLOCK_INVALID',
      'The trusted check freshness clock is invalid.',
      ExitCode.staleState,
    );
  }
  const identityExecution = services.createExecution(
    initial.git.repositoryRoot,
    options.environment ?? process.env,
  );
  const externalStateInvalidated = new Set<string>();
  const invalidatedCheckIds = initial.session.requiredChecks.filter(
    (checkId) => {
      const dependencies = checkDependencies[checkId]!;
      const definition = initial.contract.checks.checks[checkId];
      const runner = identityExecution.pin({ checkId, definition }).runner;
      const evidence = previousById.get(checkId)!;
      const externalInvalid = dependencies.includes('external-state')
        ? !isReusableExternalStateEvidence(
            checkId,
            evidence,
            externalStateFreshness[checkId],
            options.externalSnapshotDigests?.[checkId],
            now,
          )
        : false;
      if (externalInvalid) externalStateInvalidated.add(checkId);
      return (
        dependencies.includes('harness-engine') ||
        externalInvalid ||
        evidence.runnerDigest !== runner.digest
      );
    },
  );
  const invalidated = new Set(invalidatedCheckIds);
  const reusedCheckIds = initial.session.requiredChecks.filter(
    (checkId) => !invalidated.has(checkId),
  );
  const rerun = executeChecks(services, {
    cwd,
    initial,
    checkIds: invalidatedCheckIds,
    environment: options.environment ?? process.env,
    evidenceMetadata: createSessionEvidenceMetadata(
      invalidatedCheckIds,
      trustedPolicy,
      options.now
        ? options
        : {
            ...options,
            // A durable adoption timestamp is conservative (never later than
            // actual completion) and keeps crash replay content-addressed.
            now: () => new Date(adoption.committedAt),
          },
    ),
  });
  const rerunById = new Map(
    rerun.checks.map((evidence) => [evidence.checkId, evidence]),
  );
  const checks = initial.session.requiredChecks.map(
    (checkId) => rerunById.get(checkId) ?? previousById.get(checkId)!,
  );
  const selectiveInvalidation = {
    schemaVersion: 1 as const,
    kind: 'local-engine-check-invalidation.v1' as const,
    adoptionTxId: adoption.txId,
    checkpointId: adoption.checkpointId,
    fromEngineDigest: adoption.fromEngineDigest,
    toEngineDigest: adoption.toEngineDigest,
    changedDependencies:
      externalStateInvalidated.size > 0
        ? (['external-state', 'harness-engine'] as const)
        : (['harness-engine'] as const),
    invalidatedCheckIds,
    reusedCheckIds,
    checkDependencies,
    ...(Object.keys(externalStateFreshness).length > 0
      ? { externalStateFreshness }
      : {}),
  };
  const report: WorkflowReport = {
    ...previousReport,
    createdAt: adoption.committedAt,
    checks,
    checkDependencies,
    ...(Object.keys(externalStateFreshness).length > 0
      ? { externalStateFreshness }
      : {}),
    reconciledFromReportId: previousReportId,
    selectiveInvalidation,
  };
  const reportId = writeSessionReport(rerun.inspection, report);
  options.testAfterReconciliationReport?.();
  persistSession(rerun.inspection, {
    ...rerun.inspection.session,
    latestCheckReportId: reportId,
    checkEvidenceEngineDigest: adoption.toEngineDigest,
  });
  return {
    sessionId: initial.session.sessionId,
    changeId: initial.session.changeId,
    taskId: initial.session.taskId,
    changedPaths: rerun.inspection.changedPaths,
    unexpectedPaths: [],
    checks,
    executedCheckIds: invalidatedCheckIds,
    reusedCheckIds,
    passed: true,
    reportId,
  };
}

function resolveVerifiedLocalAdoption(
  {
    bootstrapInterventionStateRoot,
    resolveLocalEngineSelection,
  }: LocalEngineSelectionReaders,
  inspection: SessionInspection,
  environment: NodeJS.ProcessEnv,
): VerifiedLocalAdoption | null {
  const stateRoot = bootstrapInterventionStateRoot(
    inspection.git.gitCommonDirectory,
  );
  const selection = resolveLocalEngineSelection(stateRoot, {
    worktreeRoot: inspection.git.repositoryRealPath,
    branchRef: inspection.git.branch
      ? `refs/heads/${inspection.git.branch}`
      : null,
  });
  const rawResumeBinding = environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING;
  if (selection === null) {
    if (rawResumeBinding !== undefined) {
      throw workflowError(
        'SESSION_LOCAL_ENGINE_RESUME_BINDING_INVALID',
        'A local engine resume binding was supplied without a verified adoption.',
        ExitCode.staleState,
      );
    }
    return null;
  }
  if (rawResumeBinding === undefined) {
    throw workflowError(
      'SESSION_LOCAL_ENGINE_RESUME_BINDING_REQUIRED',
      'A committed local adoption must resume through the bootstrap-selected engine.',
      ExitCode.staleState,
    );
  }
  let parsedResumeBinding: unknown;
  try {
    parsedResumeBinding = JSON.parse(rawResumeBinding);
  } catch {
    throw workflowError(
      'SESSION_LOCAL_ENGINE_RESUME_BINDING_INVALID',
      'The local engine resume binding is malformed.',
      ExitCode.staleState,
    );
  }
  if (
    canonicalJson(parsedResumeBinding) !==
      canonicalJson(selection.resumeBinding) ||
    selection.resumeBinding.parentChangeId !== inspection.session.changeId
  ) {
    throw workflowError(
      'SESSION_LOCAL_ENGINE_RESUME_BINDING_INVALID',
      'The local engine resume binding differs from bootstrap-verified state.',
      ExitCode.staleState,
    );
  }

  const bindingPath = path.join(
    stateRoot,
    'local-parent-sessions',
    `${crypto
      .createHash('sha256')
      .update(`parent-session\0${inspection.session.changeId}`)
      .digest('hex')}.json`,
  );
  const binding = readLocalEngineBinding(bindingPath);
  const adoption = readPersistedEngineAdoption(stateRoot, binding.txId);
  const journal = adoption.journal;
  if (
    journal.state !== 'COMMITTED' ||
    journal.parentChangeId !== inspection.session.changeId ||
    journal.txId !== binding.txId ||
    journal.checkpointId !== selection.resumeBinding.checkpointId ||
    journal.toEngineDigest !== selection.resumeBinding.engineDigest ||
    journal.toEngineDigest !== binding.engineDigest
  ) {
    throw workflowError(
      'SESSION_LOCAL_ENGINE_ADOPTION_MISMATCH',
      'Bootstrap selection, local binding, and adoption journal disagree.',
      ExitCode.staleState,
    );
  }
  const committedAt = journal.history.at(-1)?.at;
  if (
    journal.history.at(-1)?.state !== 'COMMITTED' ||
    typeof committedAt !== 'string'
  ) {
    throw workflowError(
      'SESSION_LOCAL_ENGINE_ADOPTION_MISMATCH',
      'Committed adoption journal lacks a terminal timestamp.',
      ExitCode.staleState,
    );
  }
  const bundle = readPersistedWipBundle(stateRoot, journal.checkpointId);
  let snapshotSession: unknown;
  try {
    snapshotSession = JSON.parse(
      Buffer.from(bundle.session.contentBase64, 'base64').toString('utf8'),
    );
  } catch {
    throw workflowError(
      'SESSION_ADOPTION_CHECKPOINT_INVALID',
      'The intervention checkpoint does not contain a valid session snapshot.',
      ExitCode.staleState,
    );
  }
  if (!isWorkflowSessionSnapshot(snapshotSession, inspection.session)) {
    throw workflowError(
      'SESSION_ADOPTION_CHECKPOINT_INVALID',
      'The intervention checkpoint session identity is invalid.',
      ExitCode.staleState,
    );
  }
  return {
    txId: journal.txId,
    checkpointId: journal.checkpointId,
    fromEngineDigest: journal.fromEngineDigest,
    toEngineDigest: journal.toEngineDigest,
    committedAt,
    journalDigest: journal.journalDigest,
    snapshotSession,
  };
}

function isWorkflowSessionSnapshot(
  value: unknown,
  current: WorkflowSession,
): value is WorkflowSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 1 &&
    (value as { sessionId?: unknown }).sessionId === current.sessionId &&
    (value as { changeId?: unknown }).changeId === current.changeId &&
    (value as { taskId?: unknown }).taskId === current.taskId
  );
}

function loadTrustedCheckPolicy(
  manifestOperations: MaintainerManifestOperations,
  repositoryRoot: string,
  trustBaseCommit: string,
  requiredChecks: string[],
): TrustedCheckPolicy {
  let value: unknown;
  try {
    value = JSON.parse(
      readFileAtRevision(
        repositoryRoot,
        trustBaseCommit,
        'workflow/maintainer-profiles.json',
      ),
    );
  } catch {
    throw checkDependenciesInvalid(
      'Trust base does not contain maintainer check dependency declarations.',
    );
  }
  if (
    !isRecordValue(value) ||
    value.schemaVersion !== 1 ||
    !isRecordValue(value.profiles) ||
    Object.keys(value.profiles).length === 0
  ) {
    throw checkDependenciesInvalid(
      'Trust-base maintainer check dependency declarations are malformed.',
    );
  }
  const profiles = Object.keys(value.profiles)
    .sort()
    .map((profileId) =>
      manifestOperations.loadCapabilityProfileFromTrustBase(
        repositoryRoot,
        trustBaseCommit,
        profileId,
      ),
    );
  const checkDependencies = Object.fromEntries(
    requiredChecks.map((checkId) => {
      const declarations = profiles
        .filter((profile) => profile.requiredChecks.includes(checkId))
        .map((profile) => profile.checkDependencies[checkId]!)
        .map((dependencies) => canonicalJson(dependencies));
      const unique = [...new Set(declarations)];
      if (unique.length !== 1) {
        throw checkDependenciesInvalid(
          unique.length === 0
            ? `Required check ${checkId} lacks a trust-base dependency declaration.`
            : `Required check ${checkId} has conflicting trust-base dependency declarations.`,
        );
      }
      return [checkId, JSON.parse(unique[0]!) as CheckDependency[]];
    }),
  );
  const externalStateFreshness = Object.fromEntries(
    requiredChecks.flatMap((checkId) => {
      if (!checkDependencies[checkId]!.includes('external-state')) return [];
      const declarations = profiles
        .filter((profile) => profile.requiredChecks.includes(checkId))
        .map((profile) => profile.externalStateFreshness?.[checkId]?.maxAgeMs);
      const unique = [...new Set(declarations)];
      if (
        unique.length !== 1 ||
        !Number.isSafeInteger(unique[0]) ||
        Number(unique[0]) < 1
      ) {
        throw checkDependenciesInvalid(
          unique.length > 1
            ? `Required external-state check ${checkId} has conflicting trust-base freshness declarations.`
            : `Required external-state check ${checkId} lacks a valid trust-base freshness declaration.`,
        );
      }
      return [[checkId, { maxAgeMs: Number(unique[0]) }]];
    }),
  );
  return { checkDependencies, externalStateFreshness };
}

function tryLoadTrustedCheckPolicy(
  manifestOperations: MaintainerManifestOperations,
  repositoryRoot: string,
  trustBaseCommit: string,
  requiredChecks: string[],
): TrustedCheckPolicy | undefined {
  try {
    runGit(repositoryRoot, [
      'cat-file',
      '-e',
      `${trustBaseCommit}:workflow/maintainer-profiles.json`,
    ]);
  } catch {
    return undefined;
  }
  return loadTrustedCheckPolicy(
    manifestOperations,
    repositoryRoot,
    trustBaseCommit,
    requiredChecks,
  );
}

function createSessionEvidenceMetadata(
  checkIds: string[],
  trustedPolicy: TrustedCheckPolicy,
  options: SessionCheckOptions,
): Readonly<Record<string, CheckEvidenceMetadata>> {
  const clock = options.now ?? (() => new Date());
  return Object.fromEntries(
    checkIds.map((checkId) => {
      const dependencies = trustedPolicy.checkDependencies[checkId]!;
      if (!dependencies.includes('external-state')) {
        return [checkId, { completedAt: clock }];
      }
      const externalSnapshotDigest = options.externalSnapshotDigests?.[checkId];
      const freshness = trustedPolicy.externalStateFreshness[checkId];
      if (
        typeof externalSnapshotDigest !== 'string' ||
        !/^[0-9a-f]{64}$/.test(externalSnapshotDigest) ||
        !freshness
      ) {
        throw workflowError(
          'SESSION_EXTERNAL_STATE_SNAPSHOT_REQUIRED',
          `Required external-state check ${checkId} lacks a trusted current snapshot.`,
          ExitCode.staleState,
          { details: { checkId } },
        );
      }
      return [
        checkId,
        {
          completedAt: clock,
          externalSnapshotDigest,
          maxAgeMs: freshness.maxAgeMs,
        },
      ];
    }),
  );
}

function isReusableExternalStateEvidence(
  checkId: string,
  evidence: CheckEvidence,
  freshness: { maxAgeMs: number } | undefined,
  currentSnapshotDigest: string | undefined,
  now: Date,
): boolean {
  const completedAt = Date.parse(evidence.completedAt ?? '');
  return (
    freshness !== undefined &&
    typeof currentSnapshotDigest === 'string' &&
    /^[0-9a-f]{64}$/.test(currentSnapshotDigest) &&
    evidence.externalSnapshotDigest === currentSnapshotDigest &&
    evidence.maxAgeMs === freshness.maxAgeMs &&
    Number.isFinite(completedAt) &&
    completedAt <= now.getTime() &&
    now.getTime() - completedAt <= freshness.maxAgeMs &&
    evidence.checkId === checkId
  );
}

function checkDependenciesInvalid(message: string) {
  return workflowError(
    'SESSION_CHECK_DEPENDENCIES_INVALID',
    message,
    ExitCode.staleState,
  );
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type SessionCheckRun = {
  cwd: string;
  initial: SessionInspection;
  checkIds: string[];
  environment: NodeJS.ProcessEnv;
  projectedTaskIds?: string[];
  projectionSourceDigest?: string;
  authorizedTransitionPaths?: string[];
  evidenceMetadata?: Readonly<Record<string, CheckEvidenceMetadata>>;
  protectedApplyAuthorization?: ProtectedTaskApplyAuthorizationBinding;
};

function executeChecks(
  services: SessionCheckDependencies,
  {
    cwd,
    initial,
    checkIds,
    environment,
    projectedTaskIds = [],
    projectionSourceDigest,
    authorizedTransitionPaths = [],
    evidenceMetadata = {},
    protectedApplyAuthorization,
  }: SessionCheckRun,
): { checks: CheckEvidence[]; inspection: SessionInspection } {
  const { taskStrategyExecutionGate, changeContract } = services;
  const requiredChecks = checkIds.map((checkId) => ({
    checkId,
    definition: initial.contract.checks.checks[checkId],
  }));
  const pinnedChecks = prepareCheckBatch(
    requiredChecks,
    services.createExecution(initial.git.repositoryRoot, environment),
  );
  const fingerprint = fingerprintWorkingState(
    initial.git.repositoryRoot,
    initial.session.baseline.head,
    initial.git.statusEntries,
  );
  const checks: CheckEvidence[] = [];
  let inspection = initial;
  for (const { checkId, execution } of pinnedChecks) {
    const outcome = execution.execute(evidenceMetadata[checkId]);
    inspection = inspectSession(
      changeContract,
      cwd,
      initial.session.sessionId,
      {
        expectedSession: initial.session,
        projectedTaskIds,
        projectionSourceDigest,
        authorizedTransitionPaths,
        ...(protectedApplyAuthorization === undefined
          ? {}
          : { protectedApplyAuthorization }),
      },
    );
    if (
      fingerprintWorkingState(
        inspection.git.repositoryRoot,
        inspection.session.baseline.head,
        inspection.git.statusEntries,
      ) !== fingerprint
    ) {
      throw workflowError(
        'CHECK_MUTATED_WORKTREE',
        `Required check ${checkId} changed the Git working state.`,
        ExitCode.staleState,
        { details: { checkId } },
      );
    }
    if (outcome.outcome === 'failed') {
      taskStrategyExecutionGate.recordGreenFailure(inspection, checks, outcome);
    }
    checks.push(requirePassedCheck(checkId, outcome));
  }
  return { checks, inspection };
}

export function persistSession(
  inspection: SessionInspection,
  session: WorkflowSession,
): void {
  const runtime = runtimePaths(
    inspection.git.gitCommonDirectory,
    inspection.contract.config.runtimeDirectory,
  );
  const sessionPath = path.join(runtime.sessions, `${session.sessionId}.json`);
  const current = readSessionFile(sessionPath);
  if (JSON.stringify(current) !== JSON.stringify(inspection.session)) {
    throw workflowError(
      'SESSION_CHANGED_DURING_TRANSITION',
      'The session changed before its transition could be persisted.',
      ExitCode.staleState,
    );
  }
  writeJsonAtomic(sessionPath, session);
}

export function writeSessionReport(
  inspection: SessionInspection,
  report: WorkflowReport,
): string {
  const planningAssurance = inspection.session.planningAssurance ?? null;
  if (
    report.planningAssurance !== undefined &&
    JSON.stringify(report.planningAssurance) !==
      JSON.stringify(planningAssurance)
  ) {
    throw workflowError(
      'REPORT_PLANNING_ASSURANCE_MISMATCH',
      'Task report planning assurance does not match its governing session.',
      ExitCode.staleState,
    );
  }
  return writeImmutableReport(
    runtimePaths(
      inspection.git.gitCommonDirectory,
      inspection.contract.config.runtimeDirectory,
    ).reports,
    { ...report, planningAssurance },
  );
}

export type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
