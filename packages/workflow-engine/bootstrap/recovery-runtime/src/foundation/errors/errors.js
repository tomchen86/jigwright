/**
 * Defines workflow failure categories and constructs structured workflow
 * errors.
 *
 * Invariants:
 * - A workflow error retains its code, exit category and optional details
 *   and recovery text.
 * - A durable failure message keeps the original throw's name and message.
 */
export const ExitCode = {
    internal: 1,
    usage: 2,
    guard: 10,
    conflict: 11,
    unsafeEnvironment: 12,
    verification: 13,
    staleState: 14,
};
export class WorkflowError extends Error {
    code;
    exitCode;
    details;
    recovery;
    constructor(options) {
        super(options.message);
        this.name = 'WorkflowError';
        this.code = options.code;
        this.exitCode = options.exitCode;
        this.details = options.details;
        this.recovery = options.recovery;
    }
}
export function workflowError(code, message, exitCode, options = {}) {
    return new WorkflowError({ code, message, exitCode, ...options });
}
const DURABLE_FAILURE_REASON_LIMIT = 512;
/**
 * Composes a durable failure message that keeps the original throw's reason.
 *
 * A caught throw is the only account of why an attempt failed; a summary that
 * drops it leaves two unrelated crashes indistinguishable on the record.
 */
export function durableFailureMessage(summary, error) {
    const reason = (error instanceof WorkflowError
        ? error.message
        : error instanceof Error
            ? `${error.name}: ${error.message}`
            : String(error))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, DURABLE_FAILURE_REASON_LIMIT);
    return reason === '' ? `${summary}.` : `${summary}: ${reason}`;
}
