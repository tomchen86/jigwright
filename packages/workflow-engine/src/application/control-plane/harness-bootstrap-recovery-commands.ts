/**
 * Routes sealed recovery commands and enforces the quarantine command
 * boundary.
 *
 * Invariants:
 * - Active quarantine permits only exact release, trust-root restore or
 *   trust-root restore commands.
 */
import fs from 'node:fs';
import {
  ExitCode,
  workflowError,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import type {
  RecoveryAuthorityDescriptorImporter,
  RecoveryAuthorityDescriptorReader,
  RecoveryAuthorityDescriptorV1,
  RecoveryAuthorityImportBoundary,
  verifyRecoveryAuthorityDescriptor,
} from '../../modules/authority/recovery-authority-contract.ts';
import type {
  RecoveryQuarantineDependencies,
  RecoveryQuarantineEnterResult,
  RecoveryQuarantineEnvelope,
  RecoveryQuarantineMarker,
  RecoveryQuarantineReleaseResult,
} from '../../modules/authority/recovery-quarantine-contract.ts';
import type {
  RecoveryOperationalTrustRootRestoreDependencies,
  RecoveryOperationalTrustRootRestoreResult,
} from '../../modules/authority/recovery-trust-root-contract.ts';
import type {
  HarnessBootstrapRuntimeOverrides,
  HarnessRecoveryRefusalAuthority,
  RecoveryAuthorityStatus,
} from './harness-bootstrap-contracts.ts';
import {
  assertPrivateRecoveryDirectory,
  ensureRecoveryAuthorityStateRoot,
  hasRecoveryOperationalTrustRootFence,
  isExactAbsolutePath,
  readExternalRecoveryEnvelope,
  readExternalRecoveryExpectations,
  readExternalRecoveryInput,
  readExternalRecoveryTrustRootAuditRoot,
  recoveryAuthorityStateRoot,
  requireRecoveryAuthorityStateRoot,
} from './harness-bootstrap-external-input.ts';
import type { createHarnessBootstrapRecoveryProduction } from './harness-bootstrap-production.ts';
export interface HarnessBootstrapRecoveryCommandBindings extends ReturnType<
  typeof createHarnessBootstrapRecoveryProduction
> {
  discoverRepository: (cwd: string) => {
    repositoryRoot: string;
    repositoryRealPath: string;
    gitCommonDirectory: string;
    branch: string | null;
    head: string;
    tree: string;
    statusEntries: string[];
  };
  bootstrapInterventionUsage(): string;
  importRecoveryAuthorityDescriptor: RecoveryAuthorityDescriptorImporter;
  readRecoveryAuthorityDescriptor: RecoveryAuthorityDescriptorReader;
  verifyRecoveryAuthorityDescriptor: typeof verifyRecoveryAuthorityDescriptor;
  executeRecoveryOperationalTrustRootRestore(
    externalEnvelopePath: string,
    privateStoreRoot: string,
    boundary: RecoveryAuthorityImportBoundary,
    dependencies: RecoveryOperationalTrustRootRestoreDependencies,
  ): RecoveryOperationalTrustRootRestoreResult;
  executeRecoveryQuarantineEnter(
    storageRoot: string,
    envelope: RecoveryQuarantineEnvelope,
    dependencies: RecoveryQuarantineDependencies,
  ): RecoveryQuarantineEnterResult;
  executeRecoveryQuarantineRelease(
    storageRoot: string,
    envelope: RecoveryQuarantineEnvelope,
    dependencies: RecoveryQuarantineDependencies,
  ): RecoveryQuarantineReleaseResult;
  readRecoveryQuarantineMarker(
    storageRoot: string,
  ): RecoveryQuarantineMarker | null;
}

export function createHarnessBootstrapRecoveryCommands(
  bindings: HarnessBootstrapRecoveryCommandBindings,
) {
  const {
    discoverRepository,
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
  } = bindings;

  function isRecoveryAuthorityCommand(args: readonly string[]): boolean {
    return args[0] === 'recovery-authority';
  }

  function isRecoveryQuarantineCommand(args: readonly string[]): boolean {
    return args[0] === 'recovery-quarantine';
  }

  function assertHarnessRecoveryQuarantineRouting(
    args: readonly string[],
    cwd: string,
    observeRefusalAuthority: (
      authority: HarnessRecoveryRefusalAuthority,
    ) => void,
  ): void {
    let repository: ReturnType<typeof discoverRepository>;
    try {
      repository = discoverRepository(cwd);
    } catch (error) {
      if (
        args.length === 0 ||
        args[0] === '--help' ||
        args[0] === '-h' ||
        args[0] === 'help'
      ) {
        return;
      }
      throw error;
    }
    const marker = readOptionalRecoveryQuarantineMarker(
      recoveryAuthorityStateRoot(repository.gitCommonDirectory),
    );
    if (marker !== null) {
      observeRefusalAuthority({
        repositoryRoot: repository.repositoryRealPath,
        marker,
      });
    }
    const operationalTrustFence = hasRecoveryOperationalTrustRootFence(
      recoveryAuthorityStateRoot(repository.gitCommonDirectory),
    );
    if (marker !== null) {
      if (
        isExactRecoveryQuarantineCommand(args, 'release') ||
        isExactRecoveryAuthorityRestoreCommand(args)
      ) {
        return;
      }
      throw workflowError(
        'WORKFLOW_RECOVERY_QUARANTINED',
        'Only exact sealed Recovery Quarantine release, trust-root restore, is available while quarantine is active.',
        ExitCode.guard,
      );
    }
    if (operationalTrustFence) {
      if (isExactRecoveryQuarantineCommand(args, 'enter')) return;
      throw workflowError(
        'RECOVERY_OPERATIONAL_TRUST_NOT_ACTIVATED',
        'A restored operational trust root exists without an out-of-band pinned activation channel; only exact Recovery Quarantine entry remains available.',
        ExitCode.guard,
      );
    }
  }

  function dispatchRecoveryAuthorityCommand(
    args: readonly string[],
    cwd: string,
    overrides: HarnessBootstrapRuntimeOverrides,
  ):
    | RecoveryAuthorityDescriptorV1
    | RecoveryAuthorityStatus
    | RecoveryOperationalTrustRootRestoreResult {
    const repository = discoverRepository(cwd);
    const boundary = recoveryImportBoundary(repository);
    if (
      args.length === 5 &&
      args[0] === 'recovery-authority' &&
      args[1] === 'import' &&
      isExactAbsolutePath(args[2]) &&
      args[3] === '--expectations' &&
      isExactAbsolutePath(args[4])
    ) {
      const expectations = readExternalRecoveryExpectations(args[4], boundary);
      const descriptor = verifyRecoveryAuthorityDescriptor(
        readExternalRecoveryInput(args[2], boundary),
        expectations,
      );
      const stateRoot = ensureRecoveryAuthorityStateRoot(
        repository.gitCommonDirectory,
      );
      assertRecoveryQuarantineInactive(stateRoot);
      return importRecoveryAuthorityDescriptor(
        args[2],
        stateRoot,
        expectations,
        boundary,
      );
    }
    if (isExactRecoveryAuthorityRestoreCommand(args)) {
      return dispatchRecoveryOperationalTrustRootRestore(
        args,
        repository,
        boundary,
        overrides,
      );
    }
    if (
      args.length === 4 &&
      args[0] === 'recovery-authority' &&
      args[1] === 'status' &&
      args[2] === '--expectations' &&
      isExactAbsolutePath(args[3])
    ) {
      const expectations = readExternalRecoveryExpectations(args[3], boundary);
      const stateRoot = requireRecoveryAuthorityStateRoot(
        repository.gitCommonDirectory,
      );
      assertRecoveryQuarantineInactive(stateRoot);
      return {
        kind: 'recovery-authority-status.v1',
        descriptor: readRecoveryAuthorityDescriptor(
          stateRoot,
          expectations,
          boundary,
        ),
        quarantine: null,
      };
    }
    throw workflowError(
      'HARNESS_RECOVERY_COMMAND_UNSUPPORTED',
      harnessBootstrapUsage(),
      ExitCode.usage,
    );
  }

  function dispatchRecoveryOperationalTrustRootRestore(
    args: readonly string[],
    repository: ReturnType<typeof discoverRepository>,
    boundary: RecoveryAuthorityImportBoundary,
    overrides: HarnessBootstrapRuntimeOverrides,
  ): RecoveryOperationalTrustRootRestoreResult {
    const envelopePath = args[2]!;
    const expectationsPath = args[4]!;
    const expectations = readExternalRecoveryExpectations(
      expectationsPath,
      boundary,
    );
    const stateRoot = requireRecoveryAuthorityStateRoot(
      repository.gitCommonDirectory,
    );
    const descriptor = readRecoveryAuthorityDescriptor(
      stateRoot,
      expectations,
      boundary,
    );
    const externalAuditRoot = readExternalRecoveryTrustRootAuditRoot(
      envelopePath,
      boundary,
    );
    const markerDigest = requireMatchingRecoveryQuarantine(
      stateRoot,
      descriptor,
      externalAuditRoot,
    );
    const dependencies = recoveryOperationalTrustRootDependencies(
      descriptor,
      expectations,
      externalAuditRoot,
      repository.repositoryRealPath,
      overrides,
    );
    overrides.beforeRecoveryTrustRootExecute?.();
    const markerDigestAtExecution = requireMatchingRecoveryQuarantine(
      stateRoot,
      descriptor,
      externalAuditRoot,
    );
    if (markerDigestAtExecution !== markerDigest) {
      throw recoveryTrustRootQuarantineMismatch();
    }
    return executeRecoveryOperationalTrustRootRestore(
      envelopePath,
      stateRoot,
      boundary,
      dependencies,
    );
  }

  function requireMatchingRecoveryQuarantine(
    stateRoot: string,
    descriptor: RecoveryAuthorityDescriptorV1,
    externalAuditRoot: string,
  ): string {
    const marker = readRecoveryQuarantineMarker(stateRoot);
    if (marker === null) {
      throw workflowError(
        'RECOVERY_TRUST_ROOT_QUARANTINE_REQUIRED',
        'Operational trust-root restore requires an active canonical Recovery Quarantine marker.',
        ExitCode.guard,
      );
    }
    if (
      marker.repositoryId !== descriptor.repositoryIdentity.repositoryId ||
      marker.authorityDescriptorDigest !== descriptor.descriptorDigest ||
      marker.authorityGeneration !== descriptor.generation ||
      marker.recoveryRuntimeDigest !== descriptor.sealedRuntime.closureDigest ||
      marker.externalAuditRoot !== externalAuditRoot
    ) {
      throw recoveryTrustRootQuarantineMismatch();
    }
    return marker.markerDigest;
  }

  function recoveryTrustRootQuarantineMismatch(): WorkflowError {
    return workflowError(
      'RECOVERY_TRUST_ROOT_QUARANTINE_MISMATCH',
      'Operational trust-root restore does not bind the exact active Recovery Quarantine marker.',
      ExitCode.verification,
    );
  }

  function dispatchRecoveryQuarantineCommand(
    args: readonly string[],
    cwd: string,
    overrides: HarnessBootstrapRuntimeOverrides,
  ): RecoveryQuarantineEnterResult | RecoveryQuarantineReleaseResult {
    const operation =
      args[1] === 'enter'
        ? ('enter' as const)
        : args[1] === 'release'
          ? ('release' as const)
          : null;
    if (
      operation === null ||
      !isExactRecoveryQuarantineCommand(args, operation)
    ) {
      throw workflowError(
        'HARNESS_RECOVERY_COMMAND_UNSUPPORTED',
        harnessBootstrapUsage(),
        ExitCode.usage,
      );
    }
    const repository = discoverRepository(cwd);
    const boundary = recoveryImportBoundary(repository);
    const expectations = readExternalRecoveryExpectations(args[4], boundary);
    const stateRoot = requireRecoveryAuthorityStateRoot(
      repository.gitCommonDirectory,
    );
    const descriptor = readRecoveryAuthorityDescriptor(
      stateRoot,
      expectations,
      boundary,
    );
    const envelope = readExternalRecoveryEnvelope(args[2], boundary);
    const dependencies = recoveryQuarantineDependencies(
      descriptor,
      expectations,
      envelope,
      repository.repositoryRealPath,
      overrides,
    );
    if (operation === 'enter') assertRecoveryQuarantineInactive(stateRoot);
    return operation === 'enter'
      ? executeRecoveryQuarantineEnter(stateRoot, envelope, dependencies)
      : executeRecoveryQuarantineRelease(stateRoot, envelope, dependencies);
  }

  function assertRecoveryQuarantineInactive(storageRoot: string): void {
    if (readRecoveryQuarantineMarker(storageRoot) !== null) {
      throw workflowError(
        'WORKFLOW_RECOVERY_QUARANTINED',
        'Recovery Authority import, status, and enter are unavailable while quarantine is active.',
        ExitCode.guard,
      );
    }
  }

  function isExactRecoveryQuarantineCommand(
    args: readonly string[],
    operation: 'enter' | 'release',
  ): boolean {
    return (
      args.length === 5 &&
      args[0] === 'recovery-quarantine' &&
      args[1] === operation &&
      isExactAbsolutePath(args[2]) &&
      args[3] === '--expectations' &&
      isExactAbsolutePath(args[4])
    );
  }

  function isExactRecoveryAuthorityRestoreCommand(
    args: readonly string[],
  ): boolean {
    return (
      args.length === 5 &&
      args[0] === 'recovery-authority' &&
      args[1] === 'restore-trust-root' &&
      isExactAbsolutePath(args[2]) &&
      args[3] === '--expectations' &&
      isExactAbsolutePath(args[4])
    );
  }

  function recoveryImportBoundary(
    repository: ReturnType<typeof discoverRepository>,
  ): RecoveryAuthorityImportBoundary {
    return {
      repositoryWorktreeRoot: repository.repositoryRealPath,
      gitCommonDirectory: repository.gitCommonDirectory,
    };
  }

  function readOptionalRecoveryQuarantineMarker(storageRoot: string) {
    if (fs.lstatSync(storageRoot, { throwIfNoEntry: false }) === undefined) {
      return null;
    }
    assertPrivateRecoveryDirectory(storageRoot);
    return readRecoveryQuarantineMarker(storageRoot);
  }

  function harnessBootstrapUsage(): string {
    return [
      bootstrapInterventionUsage(),
      '  pnpm harness-bootstrap recovery-authority import <external-descriptor.json> --expectations <external-expectations.json> [--json]',
      '  pnpm harness-bootstrap recovery-authority status --expectations <external-expectations.json> [--json]',
      '  pnpm harness-bootstrap recovery-authority restore-trust-root <external-pre-signed-envelope.json> --expectations <external-expectations.json> [--json]',
      '  pnpm harness-bootstrap recovery-quarantine enter <external-signed-envelope.json> --expectations <external-expectations.json> [--json]',
      '  pnpm harness-bootstrap recovery-quarantine release <external-signed-envelope.json> --expectations <external-expectations.json> [--json]',
    ].join('\n');
  }

  function isExactCliIdentifier(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 255 &&
      value.trim() === value &&
      !value.startsWith('-') &&
      !value.includes('\0') &&
      !value.includes('\n') &&
      !value.includes('\r')
    );
  }

  return {
    isRecoveryAuthorityCommand,
    isRecoveryQuarantineCommand,
    assertHarnessRecoveryQuarantineRouting,
    dispatchRecoveryAuthorityCommand,
    dispatchRecoveryQuarantineCommand,
    harnessBootstrapUsage,
  };
}
