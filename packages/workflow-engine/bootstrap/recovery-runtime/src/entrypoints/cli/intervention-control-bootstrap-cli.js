/** Parse retained intervention commands and preserve their wire results. */
import { interventionMetadataDisposition } from "../../composition-root/human-revocation-production.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
export function assertSupportedBootstrapInterventionCommand(argv) {
    if (!(argv[0] === 'status' && argv.length === 2 && isNonEmpty(argv[1])) &&
        !(argv[0] === 'change' &&
            argv[1] === 'revoke-intervention' &&
            argv.length === 5 &&
            isNonEmpty(argv[2]) &&
            argv[3] === '--reason' &&
            isNonEmpty(argv[4]))) {
        throw workflowError('INTERVENTION_BOOTSTRAP_COMMAND_UNSUPPORTED', bootstrapInterventionUsage(), ExitCode.usage);
    }
}
export function dispatchBootstrapInterventionCommand(argv, cwd, dependencies = {}) {
    assertSupportedBootstrapInterventionCommand(argv);
    if (argv[0] === 'change' &&
        argv[1] === 'revoke-intervention' &&
        argv.length === 5 &&
        isNonEmpty(argv[2]) &&
        argv[3] === '--reason' &&
        isNonEmpty(argv[4])) {
        return result({
            action: 'revoke-intervention',
            ...interventionMetadataDisposition.revoke(cwd, argv[2], argv[4], dependencies),
        });
    }
    return result({
        action: 'status',
        ...interventionMetadataDisposition.inspect(cwd, argv[1]),
    });
}
export function bootstrapInterventionUsage() {
    return [
        'Usage:',
        '  pnpm workflow change revoke-intervention <parent-change-id> --reason <text> [--json]',
        '  pnpm workflow intervention status <parent-change-id> [--json]',
    ].join('\n');
}
function result(input) {
    return {
        kind: 'bootstrap-intervention-cli-result.v1',
        bindingPath: null,
        parentChangeId: null,
        checkpointId: null,
        workspaceId: null,
        intervention: null,
        parentSession: null,
        ...input,
    };
}
function isNonEmpty(value) {
    return (typeof value === 'string' && value.trim() === value && value.length > 0);
}
