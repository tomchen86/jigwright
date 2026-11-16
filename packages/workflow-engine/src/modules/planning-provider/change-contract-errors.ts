import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export function invalidContract(
  code: string,
  message: string,
  filePath: string,
  details: Record<string, unknown> = {},
): ReturnType<typeof workflowError> {
  return workflowError(code, message, ExitCode.guard, {
    details: { filePath, ...details },
  });
}

export function artifactInvalid(code: string, message: string) {
  return workflowError(code, message, ExitCode.guard);
}
