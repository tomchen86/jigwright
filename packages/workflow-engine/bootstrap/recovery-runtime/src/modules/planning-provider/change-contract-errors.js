import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
export function invalidContract(code, message, filePath, details = {}) {
    return workflowError(code, message, ExitCode.guard, {
        details: { filePath, ...details },
    });
}
export function artifactInvalid(code, message) {
    return workflowError(code, message, ExitCode.guard);
}
