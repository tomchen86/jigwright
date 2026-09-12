/** Parse recovery argv and render commands supplied by its verified host. */
import type {
  HarnessBootstrapRuntimeOverrides,
  RecoveryAuthorityStatus,
  HarnessRecoveryRefusalAuthority,
} from '../../application/control-plane/harness-bootstrap-contracts.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  dispatchBootstrapInterventionCommand,
  bootstrapInterventionStateRoot,
  bootstrapInterventionUsage,
} from './intervention-control-bootstrap-cli.ts';
import { type ControlPlaneRecoveryRollbackResult } from '../../application/control-plane/intervention-control-updater.ts';
import { type RecoveryAuthorityDescriptorV1 } from '../../modules/authority/recovery-authority-contract.ts';
import {
  type RecoveryQuarantineEnterResult,
  type RecoveryQuarantineReleaseResult,
} from '../../modules/authority/recovery-quarantine-contract.ts';
import { type RecoveryOperationalTrustRootRestoreResult } from '../../modules/authority/recovery-trust-root-contract.ts';
import type { HarnessBootstrapProduction } from '../../composition-root/harness-bootstrap-production.ts';
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

export function createHarnessBootstrapCli({
  createHarnessBootstrapDependencies,
  auditHarnessRecoveryRefusal,
  createHarnessBootstrapCommandDispatcher,
}: Pick<
  HarnessBootstrapProduction,
  | 'createHarnessBootstrapDependencies'
  | 'auditHarnessRecoveryRefusal'
  | 'createHarnessBootstrapCommandDispatcher'
>) {
  const {
    isRecoveryAuthorityCommand,
    isRecoveryQuarantineCommand,
    isControlPlaneRecoveryCommand,
    assertHarnessRecoveryQuarantineRouting,
    dispatchRecoveryAuthorityCommand,
    dispatchRecoveryQuarantineCommand,
    dispatchSealedControlPlaneRecovery,
    harnessBootstrapUsage,
  } = createHarnessBootstrapCommandDispatcher({
    bootstrapInterventionStateRoot,
    bootstrapInterventionUsage,
  });
  function runHarnessBootstrapCli(
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
  return { runHarnessBootstrapCli };
}
