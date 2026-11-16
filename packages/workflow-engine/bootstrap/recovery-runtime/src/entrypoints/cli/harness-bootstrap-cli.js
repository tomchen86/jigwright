import { ExitCode, WorkflowError, workflowError, } from "../../foundation/errors/errors.js";
import { assertSupportedBootstrapInterventionCommand, bootstrapInterventionUsage, dispatchBootstrapInterventionCommand, } from "./intervention-control-bootstrap-cli.js";
export function createHarnessBootstrapCli({ createHarnessBootstrapDependencies, auditHarnessRecoveryRefusal, createHarnessBootstrapCommandDispatcher, }) {
    const { isRecoveryAuthorityCommand, isRecoveryQuarantineCommand, assertHarnessRecoveryQuarantineRouting, dispatchRecoveryAuthorityCommand, dispatchRecoveryQuarantineCommand, harnessBootstrapUsage, } = createHarnessBootstrapCommandDispatcher({
        bootstrapInterventionUsage,
    });
    function runHarnessBootstrapCli(argv, cwd = process.cwd(), overrides = {}) {
        let refusalAuthority = null;
        const json = argv.at(-1) === '--json';
        const outputFlagCount = argv.filter((argument) => argument === '--json').length;
        const withoutOutputFlag = json ? argv.slice(0, -1) : [...argv];
        const args = withoutOutputFlag[0] === 'intervention'
            ? withoutOutputFlag.slice(1)
            : withoutOutputFlag;
        try {
            if (outputFlagCount !== (json ? 1 : 0)) {
                throw workflowError('HARNESS_RECOVERY_COMMAND_UNSUPPORTED', harnessBootstrapUsage(), ExitCode.usage);
            }
            if (args[0] === 'control-plane') {
                throw workflowError('HARNESS_RECOVERY_COMMAND_UNSUPPORTED', harnessBootstrapUsage(), ExitCode.usage);
            }
            if (args.length > 0 &&
                !['--help', '-h', 'help'].includes(args[0]) &&
                !isRecoveryAuthorityCommand(args) &&
                !isRecoveryQuarantineCommand(args)) {
                assertSupportedBootstrapInterventionCommand(args);
            }
            assertHarnessRecoveryQuarantineRouting(args, cwd, (authority) => {
                refusalAuthority = authority;
            });
            if (args.length === 0 ||
                args[0] === '--help' ||
                args[0] === '-h' ||
                args[0] === 'help') {
                process.stdout.write(`${harnessBootstrapUsage()}\n`);
                return 0;
            }
            const result = isRecoveryAuthorityCommand(args)
                ? dispatchRecoveryAuthorityCommand(args, cwd, overrides)
                : isRecoveryQuarantineCommand(args)
                    ? dispatchRecoveryQuarantineCommand(args, cwd, overrides)
                    : dispatchBootstrapInterventionCommand(args, cwd, createHarnessBootstrapDependencies(cwd, overrides));
            const output = {
                kind: 'harness-bootstrap-cli-result.v1',
                ok: true,
                result,
            };
            process.stdout.write(`${json ? JSON.stringify(output) : JSON.stringify(output, null, 2)}\n`);
            return 0;
        }
        catch (error) {
            if (error instanceof WorkflowError && refusalAuthority !== null) {
                auditHarnessRecoveryRefusal(refusalAuthority, args, error, overrides);
            }
            const failure = error instanceof WorkflowError
                ? error
                : workflowError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error), ExitCode.internal);
            const output = {
                ok: false,
                error: {
                    code: failure.code,
                    message: failure.message,
                    ...(failure.details ? { details: failure.details } : {}),
                    ...(failure.recovery ? { recovery: failure.recovery } : {}),
                },
            };
            process.stderr.write(`${json ? JSON.stringify(output) : JSON.stringify(output, null, 2)}\n`);
            return failure.exitCode;
        }
    }
    return { runHarnessBootstrapCli };
}
