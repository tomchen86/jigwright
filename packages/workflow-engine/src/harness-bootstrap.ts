#!/usr/bin/env node

import { createHarnessBootstrapAudit } from './application/control-plane/harness-bootstrap-audit.ts';
import { createHarnessBootstrapRecoveryProduction } from './application/control-plane/harness-bootstrap-production.ts';
import { createHarnessBootstrapRecoveryCommands } from './application/control-plane/harness-bootstrap-recovery-commands.ts';
import type {
  HarnessBootstrapRuntimeOverrides,
  RecoveryAuthorityStatus,
  HarnessRecoveryRefusalAuthority,
} from './application/control-plane/harness-bootstrap-contracts.ts';
export type { HarnessBootstrapRuntimeOverrides } from './application/control-plane/harness-bootstrap-contracts.ts';

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from '../bootstrap/built-in-engine-closure-pin.ts';
import { deriveAuthorityAuditRepositoryId } from './runtime/storage-journal/authority-audit-ledger.ts';

import { recordAuthorityAuditEvent } from './runtime/storage-journal/authority-audit-service.ts';
import { canonicalJson } from './foundation/canonical-json/canonical-json.ts';

import { loadWorkflowConfig } from './adapters/consumer/repository/work-registry/contracts.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from './foundation/errors/errors.ts';
import {
  discoverRepository,
  runGit,
} from './runtime/repository-transaction/git.ts';
import {
  bootstrapInterventionStateRoot,
  bootstrapInterventionUsage,
  dispatchBootstrapInterventionCommand,
  type BootstrapInterventionCliDependencies,
  type DurableInterventionParentState,
} from './entrypoints/cli/intervention-control-bootstrap-cli.ts';
import {
  persistTrustedBootstrapSessionSnapshot,
  readLocalEngineBinding,
} from './application/control-plane/intervention-control-bootstrap.ts';
import {
  readControlPlaneSupervisorState,
  type ControlPlaneRecoveryRollbackResult,
} from './application/control-plane/intervention-control-updater.ts';

import { parseMaintainerPolicy } from './modules/authority/maintainer-policy.ts';
import {
  createInteractiveSshSigner,
  type MaintainerSignerProvider,
  verifySshSignatureWithPublicKey,
} from './adapters/signing/ssh/maintainer-signer.ts';
import {
  importRecoveryAuthorityDescriptor,
  readRecoveryAuthorityDescriptor,
  verifyRecoveryAuthorityDescriptor,
  type RecoveryAuthorityDescriptorV1,
} from './recovery-authority.ts';
import {
  executeRecoveryQuarantineEnter,
  executeRecoveryQuarantineRelease,
  readRecoveryQuarantineMarker,
  type RecoveryQuarantineEnterResult,
  type RecoveryQuarantineReleaseResult,
} from './recovery-quarantine.ts';
import {
  RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
  executeRecoveryOperationalTrustRootRestore,
  type RecoveryOperationalTrustRootRestoreResult,
} from './recovery-trust-root-restore.ts';
import {
  listActiveWorkflowSessionIds,
  readSessionFile,
  runtimePaths,
} from './runtime/session-workspace/session-store.ts';

interface HarnessBootstrapResult {
  kind: 'harness-bootstrap-cli-result.v1';
  ok: true;
  result:
    | ReturnType<typeof dispatchBootstrapInterventionCommand>
    | ControlPlaneRecoveryRollbackResult
    | RecoveryAuthorityDescriptorV1
    | RecoveryAuthorityStatus
    | RecoveryQuarantineEnterResult
    | RecoveryQuarantineReleaseResult
    | RecoveryOperationalTrustRootRestoreResult;
}

/**
 * Direct local recovery entry for intervention commands. This deliberately
 * excludes src/cli.ts, while its remaining src-dependent closure is recorded
 * by bootstrap/harness-bootstrap-dependency-closure.json.
 */
export function runHarnessBootstrapCli(
  argv: readonly string[],
  cwd = process.cwd(),
  overrides: HarnessBootstrapRuntimeOverrides = {},
): number {
  let refusalAuthority: HarnessRecoveryRefusalAuthority | null = null;
  const json = argv.at(-1) === '--json';
  const outputFlagCount = argv.filter(
    (argument) => argument === '--json',
  ).length;
  const withoutOutputFlag = json ? argv.slice(0, -1) : [...argv];
  const args =
    withoutOutputFlag[0] === 'intervention'
      ? withoutOutputFlag.slice(1)
      : withoutOutputFlag;

  try {
    if (outputFlagCount !== (json ? 1 : 0)) {
      throw workflowError(
        'HARNESS_RECOVERY_COMMAND_UNSUPPORTED',
        harnessBootstrapUsage(),
        ExitCode.usage,
      );
    }
    assertHarnessRecoveryQuarantineRouting(args, cwd, (authority) => {
      refusalAuthority = authority;
    });
    if (
      args.length === 0 ||
      args[0] === '--help' ||
      args[0] === '-h' ||
      args[0] === 'help'
    ) {
      process.stdout.write(`${harnessBootstrapUsage()}\n`);
      return 0;
    }
    const result = isRecoveryAuthorityCommand(args)
      ? dispatchRecoveryAuthorityCommand(args, cwd, overrides)
      : isRecoveryQuarantineCommand(args)
        ? dispatchRecoveryQuarantineCommand(args, cwd, overrides)
        : isControlPlaneRecoveryCommand(args)
          ? dispatchSealedControlPlaneRecovery(args, cwd, overrides)
          : dispatchBootstrapInterventionCommand(
              args,
              cwd,
              createHarnessBootstrapDependencies(cwd, overrides),
            );
    const output: HarnessBootstrapResult = {
      kind: 'harness-bootstrap-cli-result.v1',
      ok: true,
      result,
    };
    process.stdout.write(
      `${json ? JSON.stringify(output) : JSON.stringify(output, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    if (error instanceof WorkflowError && refusalAuthority !== null) {
      auditHarnessRecoveryRefusal(refusalAuthority, args, error, overrides);
    }
    const failure =
      error instanceof WorkflowError
        ? error
        : workflowError(
            'INTERNAL_ERROR',
            error instanceof Error ? error.message : String(error),
            ExitCode.internal,
          );
    const output = {
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.details ? { details: failure.details } : {}),
        ...(failure.recovery ? { recovery: failure.recovery } : {}),
      },
    };
    process.stderr.write(
      `${json ? JSON.stringify(output) : JSON.stringify(output, null, 2)}\n`,
    );
    return failure.exitCode;
  }
}

export function createHarnessBootstrapDependencies(
  cwd: string,
  overrides: HarnessBootstrapRuntimeOverrides = {},
): BootstrapInterventionCliDependencies {
  let resolvedSigner = overrides.maintenanceSigner;
  const resolveSigner = (): MaintainerSignerProvider => {
    if (resolvedSigner === undefined) {
      const repository = discoverRepository(cwd);
      const policy = parseMaintainerPolicy(
        JSON.parse(
          runGit(repository.repositoryRoot, [
            'show',
            `${repository.head}:workflow/maintainer-policy.json`,
          ]),
        ),
      );
      resolvedSigner = createInteractiveSshSigner(
        repository.repositoryRoot,
        policy,
      );
    }
    return resolvedSigner;
  };
  return {
    now: overrides.now ?? (() => new Date()),
    maintenanceSigner: {
      assertHumanPresent: () => resolveSigner().assertHumanPresent(),
      identity: () => resolveSigner().identity(),
      sign: (payload, namespace) => resolveSigner().sign(payload, namespace),
      verify: (payload, signature, identity, namespace) =>
        resolveSigner().verify(payload, signature, identity, namespace),
    },
    presentMaintenanceSummary:
      overrides.presentMaintenanceSummary ??
      ((summary) => {
        process.stderr.write(`\n${summary.humanReadable}\n\n`);
      }),
    resolveParentDurableState: ({ parentChangeId, stateRoot }) =>
      resolveHarnessBootstrapParentState(cwd, parentChangeId, stateRoot),
    verifyHumanSignature(
      payload: string,
      signature: string,
      signerIdentity: string,
      namespace: string,
    ): boolean {
      if (overrides.verifyHumanSignature) {
        return overrides.verifyHumanSignature(
          payload,
          signature,
          signerIdentity,
          namespace,
        );
      }
      try {
        resolveSigner().verify(payload, signature, signerIdentity, namespace);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function resolveHarnessBootstrapParentState(
  cwd: string,
  parentChangeId: string,
  stateRoot: string,
): DurableInterventionParentState {
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const runtime = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const candidates = listActiveWorkflowSessionIds(runtime)
    .map((sessionId) => ({
      sessionId,
      sessionPath: path.join(runtime.sessions, `${sessionId}.json`),
    }))
    .map((entry) => ({ ...entry, session: readSessionFile(entry.sessionPath) }))
    .filter(({ session }) => session.changeId === parentChangeId);
  if (candidates.length === 0) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_PARENT_SESSION_NOT_FOUND',
      'No active durable workflow session exists for the requested parent change.',
      ExitCode.staleState,
    );
  }
  if (candidates.length !== 1) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_PARENT_SESSION_AMBIGUOUS',
      'More than one active durable workflow session claims the parent change.',
      ExitCode.staleState,
    );
  }
  const { session } = candidates[0]!;
  const expectedBranch = `work/${parentChangeId}`;
  if (
    session.state !== 'active' ||
    session.repositoryRoot !== repository.repositoryRealPath ||
    session.gitCommonDirectory !== repository.gitCommonDirectory ||
    session.branch !== expectedBranch ||
    repository.branch !== expectedBranch ||
    session.baseline.head !== repository.head ||
    session.baseline.tree !== repository.tree
  ) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_PARENT_SESSION_STALE',
      'Durable parent session identity, branch, or baseline differs from the current worktree.',
      ExitCode.staleState,
    );
  }

  const expectedStateRoot = path.join(runtime.root, 'intervention-control');
  if (stateRoot !== expectedStateRoot) {
    throw workflowError(
      'HARNESS_BOOTSTRAP_STATE_ROOT_MISMATCH',
      'Bootstrap dispatcher state root differs from the durable workflow runtime.',
      ExitCode.verification,
    );
  }
  const localBinding = readOptionalParentBinding(stateRoot, parentChangeId);
  let engineBinding: DurableInterventionParentState['parent']['engineBinding'] =
    BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST;
  let sessionSchema = `workflow-session.v${session.schemaVersion}`;
  if (localBinding !== null) {
    if (
      localBinding.parentChangeId !== parentChangeId ||
      localBinding.parentWorkspacePath !== repository.repositoryRealPath ||
      localBinding.parentBranch !== `refs/heads/${expectedBranch}` ||
      localBinding.interventionState !== 'adopted' ||
      localBinding.blocker !== null
    ) {
      throw workflowError(
        'HARNESS_BOOTSTRAP_PARENT_BINDING_CONFLICT',
        'Existing local engine binding is not a committed parent overlay.',
        ExitCode.staleState,
      );
    }
    engineBinding = localBinding.engineDigest;
    sessionSchema = localBinding.sessionSchema;
  } else {
    const supervisor = readOptionalSupervisor(stateRoot);
    if (supervisor !== null) {
      engineBinding = supervisor.activeArtifact.executableDigest;
    }
  }

  return {
    parent: {
      changeId: parentChangeId,
      status: 'active',
      engineBinding,
      sessionSchema,
      blocker: null,
    },
    sessionSnapshotPath: persistTrustedBootstrapSessionSnapshot(
      stateRoot,
      session,
    ),
    pendingIntent: canonicalJson({
      kind: 'harness-bootstrap-parent-resume-intent.v1',
      sessionId: session.sessionId,
      changeId: session.changeId,
      taskId: session.taskId,
      branch: session.branch,
      baseline: session.baseline,
    }),
    policyDigest: digestCanonical({
      kind: 'harness-bootstrap-parent-policy-binding.v1',
      changeId: session.changeId,
      taskId: session.taskId,
      artifacts: session.artifacts,
      allowedPaths: session.allowedPaths,
      requiredChecks: session.requiredChecks,
      requiredCheckDigests: session.requiredCheckDigests,
      planningAssurance: session.planningAssurance ?? null,
      mandateBinding: session.mandateBinding ?? null,
    }),
  };
}

function readOptionalParentBinding(stateRoot: string, parentChangeId: string) {
  const identity = crypto
    .createHash('sha256')
    .update(`parent-session\0${parentChangeId}`)
    .digest('hex');
  const bindingPath = path.join(
    stateRoot,
    'local-parent-sessions',
    `${identity}.json`,
  );
  if (!fs.lstatSync(bindingPath, { throwIfNoEntry: false })) return null;
  return readLocalEngineBinding(bindingPath);
}

function readOptionalSupervisor(stateRoot: string) {
  try {
    return readControlPlaneSupervisorState(stateRoot);
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      error.code === 'CONTROL_PLANE_SUPERVISOR_NOT_FOUND'
    ) {
      return null;
    }
    throw error;
  }
}

function digestCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

const {
  auditHarnessRecoveryRefusal,
  productionRecoveryTrustRootAuditSink,
  productionRecoveryQuarantineAuditSink,
  productionControlPlaneAuditSink,
  productionRecoveryAuditSink,
} = createHarnessBootstrapAudit({
  deriveAuthorityAuditRepositoryId,
  recordAuthorityAuditEvent,
});

const {
  recoveryOperationalTrustRootDependencies,
  recoveryQuarantineDependencies,
  createHarnessRecoveryDependencies,
} = createHarnessBootstrapRecoveryProduction({
  RECOVERY_TRUST_ROOT_RESTORE_NAMESPACE,
  verifySshSignatureWithPublicKey,
  createHarnessBootstrapDependencies,
  productionRecoveryTrustRootAuditSink,
  productionRecoveryQuarantineAuditSink,
  productionControlPlaneAuditSink,
  productionRecoveryAuditSink,
});

const {
  isRecoveryAuthorityCommand,
  isRecoveryQuarantineCommand,
  isControlPlaneRecoveryCommand,
  assertHarnessRecoveryQuarantineRouting,
  dispatchRecoveryAuthorityCommand,
  dispatchRecoveryQuarantineCommand,
  dispatchSealedControlPlaneRecovery,
  harnessBootstrapUsage,
} = createHarnessBootstrapRecoveryCommands({
  discoverRepository,
  bootstrapInterventionStateRoot,
  bootstrapInterventionUsage,
  importRecoveryAuthorityDescriptor,
  readRecoveryAuthorityDescriptor,
  verifyRecoveryAuthorityDescriptor,
  executeRecoveryOperationalTrustRootRestore,
  executeRecoveryQuarantineEnter,
  executeRecoveryQuarantineRelease,
  readRecoveryQuarantineMarker,
  recoveryOperationalTrustRootDependencies,
  recoveryQuarantineDependencies,
  createHarnessRecoveryDependencies,
});

const entryPath = process.argv[1];
if (
  entryPath &&
  import.meta.url === pathToFileURL(path.resolve(entryPath)).href
) {
  process.exitCode = runHarnessBootstrapCli(process.argv.slice(2));
}
