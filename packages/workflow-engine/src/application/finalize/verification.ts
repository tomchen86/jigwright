import type { MaintainerManifestOperations } from '../../modules/authority/maintainer-manifest.ts';
import type { ChangeContractServices } from '../../modules/lifecycle/change-routing.ts';
import type { ReviewedGeneratedAssetInventory } from '../../modules/source/mutation-class-policy.ts';
import type { TaskStrategyExecutionGate } from '../../modules/assurance/task-strategy-gate.ts';
import path from 'node:path';
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
import { type CheckDependency } from '../../modules/authority/maintainer-manifest-contracts.ts';
import {
  discoverRepository,
  fingerprintWorkingState,
  runGit,
} from '../../runtime/repository-transaction/git.ts';
import { assertSessionId } from '../../foundation/repository-path/repository-path.ts';
import { writeImmutableReport } from '../../runtime/storage-journal/report-store.ts';
import type { WorkflowReport } from '../../modules/lifecycle/workflow-report.ts';
import {
  runtimePaths,
  withSessionOperation,
} from '../../runtime/session-workspace/session-store.ts';
import { ensureTaskMechanicalTransformationEvidence } from './task-mechanical-transform.ts';
import { type ProtectedTaskApplyAuthorizationBinding } from '../../runtime/storage-journal/finalize-transaction.ts';
import { inspectSession } from '../../runtime/repository-validation/session-inspection.ts';
import type { SessionInspection } from '../../modules/lifecycle/session-inspection.ts';
import { readFileAtRevision } from '../../runtime/repository-transaction/git-command.ts';
import { persistSession } from '../../runtime/session-workspace/session-persistence.ts';

/** Execute current required checks and publish immutable session evidence. */

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
};

type TrustedCheckPolicy = {
  checkDependencies: Record<string, CheckDependency[]>;
  externalStateFreshness: Record<string, { maxAgeMs: number }>;
};

type SessionCheckDependencies = Readonly<{
  reviewedAssets: ReviewedGeneratedAssetInventory;
  manifestOperations: MaintainerManifestOperations;
  taskStrategyExecutionGate: TaskStrategyExecutionGate<SessionInspection>;
  changeContract: ChangeContractServices;
  createExecution: CheckExecutionFactory;
}>;

/** Binds capabilities without observing repository, environment, or clock state. */
export function createSessionCheckService(services: SessionCheckDependencies) {
  return Object.freeze({
    checkSession: checkSession.bind(undefined, services),
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
    manifestOperations,
    taskStrategyExecutionGate,
    changeContract,
  } = services;
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
  persistSession(verified.inspection, {
    ...verified.inspection.session,
    latestCheckReportId: reportId,
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
