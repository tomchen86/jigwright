import { verifyWorkflowBootstrapHost } from './workflow-bootstrap-host.ts';
import { WORKFLOW_BOOTSTRAP_HOST_MANIFEST_DIGEST } from './workflow-bootstrap-host-pin.ts';
import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from './built-in-engine-closure-pin.ts';
/**
 * Verifies and runs this package host for every ordinary repository command.
 *
 * Invariants:
 * - The built-in closure is verified against its pin, so a changed or indirect engine never launches.
 * - Read-only inspection and session status are recognised ahead of provisioning, so looking never provisions.
 * - The child process exit code is passed through unchanged; the launcher never reports success for a failed run.
 */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertParentInterventionFenceCleared,
  bootstrapInterventionStateRoot,
  initializeBuiltInControlPlaneSupervisor,
  resolveParentInterventionFence,
  resolveRecoveryOperationalTrustRootFence,
  resolveRecoveryQuarantineMarker,
  verifyBuiltInEngineClosure,
} from './control-plane-trust.ts';
import { canonicalJson } from './canonical-json.ts';

const ENGINE_PACKAGE_ROOT = path.resolve(import.meta.dirname, '..');

try {
  const repository = discoverRepositoryIdentity(process.cwd());
  const stateRoot = bootstrapInterventionStateRoot(
    repository.gitCommonDirectory,
  );
  const argv = process.argv.slice(2);
  let invocation: { executable: string; argv: string[] };
  const quarantine = resolveRecoveryQuarantineMarker(
    repository.gitCommonDirectory,
  );
  const operationalTrustFence = resolveRecoveryOperationalTrustRootFence(
    repository.gitCommonDirectory,
  );
  if (quarantine !== null) {
    if (!isQuarantinePermittedRecoveryInvocation(argv)) {
      throw launcherError(
        'WORKFLOW_RECOVERY_QUARANTINED',
        'Workflow execution is fenced by an active Recovery Quarantine marker.',
      );
    }
    invocation = sealedInterventionInvocation(argv);
  } else if (operationalTrustFence) {
    if (!isOperationalTrustFenceRecoveryInvocation(argv)) {
      throw launcherError(
        'RECOVERY_OPERATIONAL_TRUST_NOT_ACTIVATED',
        'A restored operational trust root exists without an out-of-band pinned activation channel; ordinary workflow execution remains fenced.',
      );
    }
    invocation = sealedInterventionInvocation(argv);
  } else if (isSealedRecoveryInvocation(argv)) {
    invocation = sealedInterventionInvocation(argv);
  } else {
    const fence = resolveParentInterventionFence(stateRoot, repository);
    if (isInitialControlPlaneProvisioning(argv)) {
      assertParentInterventionFenceCleared(fence);
      if (
        resolveRecoveryQuarantineMarker(repository.gitCommonDirectory) !== null
      ) {
        throw launcherError(
          'WORKFLOW_RECOVERY_QUARANTINED',
          'Workflow execution became Recovery Quarantined before control-plane initialization.',
        );
      }
      const supervisor = initializeBuiltInControlPlaneSupervisor(
        stateRoot,
        ENGINE_PACKAGE_ROOT,
        repository,
      );
      process.stdout.write(
        `${canonicalJson({
          kind: 'control-plane-initialization.v1',
          supervisor,
        })}\n`,
      );
      process.exit(0);
    }
    if (fence !== null && isSealedInterventionInvocation(argv)) {
      invocation = sealedInterventionInvocation(argv);
    } else {
      if (
        !isReadOnlyHelpInvocation(argv) &&
        !isReadOnlyRepositoryInspectionInvocation(argv)
      ) {
        assertParentInterventionFenceCleared(fence);
      }
      invocation = builtInInvocation(argv);
    }
  }
  const quarantineAtLaunch = resolveRecoveryQuarantineMarker(
    repository.gitCommonDirectory,
  );
  const operationalTrustFenceAtLaunch =
    resolveRecoveryOperationalTrustRootFence(repository.gitCommonDirectory);
  if (
    quarantineAtLaunch !== null &&
    !isQuarantinePermittedRecoveryInvocation(argv)
  ) {
    throw launcherError(
      'WORKFLOW_RECOVERY_QUARANTINED',
      'Workflow execution became Recovery Quarantined before engine launch.',
    );
  }
  if (
    quarantineAtLaunch === null &&
    operationalTrustFenceAtLaunch &&
    !isOperationalTrustFenceRecoveryInvocation(argv)
  ) {
    throw launcherError(
      'RECOVERY_OPERATIONAL_TRUST_NOT_ACTIVATED',
      'A restored operational trust root appeared without an out-of-band pinned activation channel before engine launch.',
    );
  }
  const result = childProcess.spawnSync(
    invocation.executable,
    invocation.argv,
    {
      cwd: process.cwd(),
      env: launchEnvironment(),
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} catch (error) {
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `${JSON.stringify({
      kind: 'workflow-launcher-error.v1',
      code,
      message,
    })}\n`,
  );
  process.exit(errorExitCode(error));
}

function isInitialControlPlaneProvisioning(argv: readonly string[]): boolean {
  return (
    argv.length === 3 &&
    argv[0] === 'control-plane' &&
    argv[1] === 'initialize' &&
    argv[2] === '--json'
  );
}

function isReadOnlyRepositoryInspectionInvocation(
  argv: readonly string[],
): boolean {
  return (
    isReadOnlySessionStatusInvocation(argv) ||
    isReadOnlyRouteStatusInvocation(argv) ||
    isReadOnlyTaskPreflightInvocation(argv)
  );
}

function isReadOnlySessionStatusInvocation(argv: readonly string[]): boolean {
  if (
    (argv.length === 1 || (argv.length === 2 && argv[1] === '--json')) &&
    argv[0] === 'status'
  ) {
    return true;
  }
  return (
    (argv.length === 2 || (argv.length === 3 && argv[2] === '--json')) &&
    argv[0] === 'status' &&
    typeof argv[1] === 'string' &&
    argv[1].length > 0 &&
    argv[1].length <= 255 &&
    argv[1].trim() === argv[1] &&
    !argv[1].startsWith('-') &&
    !argv[1].includes('\0') &&
    !argv[1].includes('\n')
  );
}

function isReadOnlyRouteStatusInvocation(argv: readonly string[]): boolean {
  return (
    (argv.length === 2 || (argv.length === 3 && argv[2] === '--json')) &&
    argv[0] === 'route' &&
    argv[1] === 'status'
  );
}

function isReadOnlyTaskPreflightInvocation(argv: readonly string[]): boolean {
  const args = argv[argv.length - 1] === '--json' ? argv.slice(0, -1) : argv;
  return (
    (args.length === 2 || args.length === 4) &&
    args[0] === 'task-preflight' &&
    isBoundedNonOptionArgument(args[1]) &&
    (args.length === 2 ||
      (args[2] === '--task' && isBoundedNonOptionArgument(args[3])))
  );
}

function isBoundedNonOptionArgument(value: string | undefined): boolean {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 255 &&
    value.trim() === value &&
    !value.startsWith('-') &&
    !value.includes('\0') &&
    !value.includes('\n')
  );
}

function isReadOnlyHelpInvocation(argv: readonly string[]): boolean {
  return (
    argv.length === 1 &&
    (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')
  );
}

function isSealedInterventionInvocation(argv: readonly string[]): boolean {
  return (
    (argv[0] === 'intervention' &&
      (argv[1] === 'status' || argv[1] === 'recover')) ||
    (argv[0] === 'change' &&
      (argv[1] === 'intervene' || argv[1] === 'revoke-intervention')) ||
    (argv[0] === 'engine' &&
      (argv[1] === 'build-artifact' || argv[1] === 'adopt'))
  );
}

function isSealedRecoveryInvocation(argv: readonly string[]): boolean {
  const args = exactRecoveryArguments(argv);
  if (args === null) return false;
  return (
    isExactControlPlaneRollback(args) ||
    (args.length === 5 &&
      args[0] === 'recovery-authority' &&
      args[1] === 'import' &&
      isExactAbsoluteLauncherPath(args[2]) &&
      args[3] === '--expectations' &&
      isExactAbsoluteLauncherPath(args[4])) ||
    (args.length === 4 &&
      args[0] === 'recovery-authority' &&
      args[1] === 'status' &&
      args[2] === '--expectations' &&
      isExactAbsoluteLauncherPath(args[3])) ||
    isExactRecoveryAuthorityRestore(args) ||
    isExactQuarantineOperation(args, 'enter') ||
    isExactQuarantineOperation(args, 'release')
  );
}

function isQuarantinePermittedRecoveryInvocation(
  argv: readonly string[],
): boolean {
  const args = exactRecoveryArguments(argv);
  return (
    args !== null &&
    (isExactControlPlaneRollback(args) ||
      isExactRecoveryAuthorityRestore(args) ||
      isExactQuarantineOperation(args, 'release'))
  );
}

function isOperationalTrustFenceRecoveryInvocation(
  argv: readonly string[],
): boolean {
  const args = exactRecoveryArguments(argv);
  return args !== null && isExactQuarantineOperation(args, 'enter');
}

function exactRecoveryArguments(
  argv: readonly string[],
): readonly string[] | null {
  const json = argv.at(-1) === '--json';
  if (
    argv.filter((argument) => argument === '--json').length !== (json ? 1 : 0)
  ) {
    return null;
  }
  return json ? argv.slice(0, -1) : argv;
}

function isExactControlPlaneRollback(argv: readonly string[]): boolean {
  return (
    argv.length === 3 &&
    argv[0] === 'control-plane' &&
    argv[1] === 'rollback' &&
    isExactLauncherIdentifier(argv[2])
  );
}

function isExactRecoveryAuthorityRestore(argv: readonly string[]): boolean {
  return (
    argv.length === 5 &&
    argv[0] === 'recovery-authority' &&
    argv[1] === 'restore-trust-root' &&
    isExactAbsoluteLauncherPath(argv[2]) &&
    argv[3] === '--expectations' &&
    isExactAbsoluteLauncherPath(argv[4])
  );
}

function isExactQuarantineOperation(
  argv: readonly string[],
  operation: 'enter' | 'release',
): boolean {
  return (
    argv.length === 5 &&
    argv[0] === 'recovery-quarantine' &&
    argv[1] === operation &&
    isExactAbsoluteLauncherPath(argv[2]) &&
    argv[3] === '--expectations' &&
    isExactAbsoluteLauncherPath(argv[4])
  );
}

function isExactAbsoluteLauncherPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function isExactLauncherIdentifier(value: unknown): value is string {
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

function sealedInterventionInvocation(argv: string[]): {
  executable: string;
  argv: string[];
} {
  return {
    executable: process.execPath,
    argv: [
      '--experimental-strip-types',
      path.join(
        ENGINE_PACKAGE_ROOT,
        'bootstrap',
        'harness-bootstrap-launcher.ts',
      ),
      ...argv,
    ],
  };
}

function builtInInvocation(argv: string[]): {
  executable: string;
  argv: string[];
} {
  verifyBuiltInEngineClosure(ENGINE_PACKAGE_ROOT);
  const builtInEngine = verifyWorkflowBootstrapHost(
    ENGINE_PACKAGE_ROOT,
    WORKFLOW_BOOTSTRAP_HOST_MANIFEST_DIGEST,
    BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
  );
  return {
    executable: process.execPath,
    argv: ['--experimental-strip-types', builtInEngine, ...argv],
  };
}

function discoverRepositoryIdentity(cwd: string): {
  gitCommonDirectory: string;
  worktreeRoot: string;
  branchRef: string | null;
} {
  const gitExecutable = process.platform === 'win32' ? 'git' : '/usr/bin/git';
  const gitCommonDirectory = exactGitDirectory(
    gitExecutable,
    cwd,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    'common directory',
  );
  const worktreeRoot = exactGitDirectory(
    gitExecutable,
    cwd,
    ['rev-parse', '--path-format=absolute', '--show-toplevel'],
    'worktree root',
  );
  const branch = childProcess.spawnSync(
    gitExecutable,
    ['symbolic-ref', '--quiet', 'HEAD'],
    {
      cwd,
      encoding: 'utf8',
      env: process.env,
      windowsHide: true,
    },
  );
  if (
    branch.status === 1 &&
    branch.error === undefined &&
    branch.signal === null
  ) {
    return { gitCommonDirectory, worktreeRoot, branchRef: null };
  }
  if (
    branch.error !== undefined ||
    branch.signal !== null ||
    branch.status !== 0 ||
    typeof branch.stdout !== 'string'
  ) {
    throw launcherError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNAVAILABLE',
      'Workflow launcher could not resolve the repository branch.',
    );
  }
  const branchRef = branch.stdout.trim();
  if (
    branchRef.length === 0 ||
    branchRef.includes('\0') ||
    branchRef.includes('\n')
  ) {
    throw launcherError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNSAFE',
      'Git returned an invalid branch ref.',
    );
  }
  return { gitCommonDirectory, worktreeRoot, branchRef };
}

function exactGitDirectory(
  gitExecutable: string,
  cwd: string,
  argv: string[],
  label: string,
): string {
  const result = childProcess.spawnSync(gitExecutable, argv, {
    cwd,
    encoding: 'utf8',
    env: process.env,
    windowsHide: true,
  });
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== 'string'
  ) {
    throw launcherError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNAVAILABLE',
      `Workflow launcher could not resolve the repository ${label}.`,
    );
  }
  const output = result.stdout.trim();
  if (output.length === 0 || output.includes('\0') || output.includes('\n')) {
    throw launcherError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNSAFE',
      'Git returned an invalid common-directory path.',
    );
  }
  const candidate = path.isAbsolute(output)
    ? output
    : path.resolve(cwd, output);
  const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw launcherError(
      'WORKFLOW_LAUNCHER_REPOSITORY_UNSAFE',
      'Git common directory is missing, indirect, or unsafe.',
    );
  }
  return fs.realpathSync(candidate);
}

function launchEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING;
  delete environment.WORKFLOW_LOCAL_ENGINE_TX_ID;
  delete environment.WORKFLOW_LOCAL_ENGINE_CHILD_WORKTREE;
  return environment;
}

function launcherError(
  code: string,
  message: string,
): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'WORKFLOW_LAUNCHER_FAILED';
}

function errorExitCode(error: unknown): number {
  if (
    typeof error === 'object' &&
    error !== null &&
    'exitCode' in error &&
    Number.isSafeInteger(error.exitCode) &&
    Number(error.exitCode) > 0 &&
    Number(error.exitCode) <= 255
  ) {
    return Number(error.exitCode);
  }
  return 1;
}
