/** Performs audit input observations with the original descriptor and failure ordering. */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { runGit } from '../repository-transaction/git.ts';
import { canonicalAuditDestructionGrantEnvelope } from '../storage-journal/authority-audit-destruction-records.ts';
import type {
  AuthorityAuditInputErrors,
  AuthorityAuditInputOperations,
  AuditDestructionGrantEnvelope,
  AuthorityAuditRepositoryObservations,
} from '../../modules/authority/authority-audit-contract.ts';
const MAX_AUDIT_INPUT_PATH_BYTES = 4_096;
const MAX_AUDIT_INPUT_FILE_BYTES = 32_768;

export const readAuthorityAuditPolicyAtHead: AuthorityAuditRepositoryObservations['readPolicyAtHead'] =
  (repositoryRoot, head) =>
    runGit(repositoryRoot, ['show', `${head}:workflow/maintainer-policy.json`]);

export function createAuthorityAuditInputReader(
  errors: AuthorityAuditInputErrors,
): AuthorityAuditInputOperations {
  const {
    auditUsageError,
    protectedConfigurationInputInvalid,
    inputFileUnsafe,
    destructionGrantFileInvalid,
  } = errors;
  const assertExternalAuditRoot: AuthorityAuditInputOperations['assertExternalAuditRoot'] =
    (value) => {
      if (!isCanonicalAbsolutePath(value)) throw auditUsageError();
      return value;
    };

  const assertProtectedBackendRootInput: AuthorityAuditInputOperations['assertProtectedBackendRootInput'] =
    (backendRoot, scope) => {
      if (!isCanonicalAbsolutePath(backendRoot)) throw auditUsageError();
      let stats: fs.Stats;
      let realBackendRoot: string;
      try {
        stats = fs.lstatSync(backendRoot);
        realBackendRoot = fs.realpathSync(backendRoot);
      } catch {
        throw protectedConfigurationInputInvalid();
      }
      if (
        !stats.isDirectory() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o700 ||
        realBackendRoot !== backendRoot ||
        pathsOverlap(backendRoot, scope.repositoryRoot) ||
        pathsOverlap(backendRoot, scope.externalAuditRoot)
      ) {
        throw protectedConfigurationInputInvalid();
      }
    };

  const readPrivateInputFile: AuthorityAuditInputOperations['readPrivateInputFile'] =
    (filePathValue, label) => {
      const filePath = assertCanonicalInputFilePath(filePathValue);
      let descriptor: number | undefined;
      try {
        const realPath = fs.realpathSync(filePath);
        const before = fs.lstatSync(filePath);
        if (
          realPath !== filePath ||
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.nlink !== 1 ||
          (before.mode & 0o777) !== 0o600 ||
          before.size < 1 ||
          before.size > MAX_AUDIT_INPUT_FILE_BYTES
        ) {
          throw inputFileUnsafe(label);
        }
        descriptor = fs.openSync(
          filePath,
          fs.constants.O_RDONLY |
            (typeof fs.constants.O_NOFOLLOW === 'number'
              ? fs.constants.O_NOFOLLOW
              : 0),
        );
        const opened = fs.fstatSync(descriptor);
        if (
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.nlink !== 1 ||
          (opened.mode & 0o777) !== 0o600 ||
          opened.size !== before.size
        ) {
          throw inputFileUnsafe(label);
        }
        const content = fs.readFileSync(descriptor, 'utf8');
        const after = fs.fstatSync(descriptor);
        if (
          after.dev !== opened.dev ||
          after.ino !== opened.ino ||
          after.nlink !== 1 ||
          after.size !== opened.size ||
          after.mtimeMs !== opened.mtimeMs ||
          after.ctimeMs !== opened.ctimeMs ||
          Buffer.byteLength(content) !== opened.size
        ) {
          throw inputFileUnsafe(label);
        }
        return content;
      } catch (error) {
        if (isWorkflowErrorCode(error, 'AUTHORITY_AUDIT_INPUT_FILE_UNSAFE')) {
          throw error;
        }
        throw inputFileUnsafe(label);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    };

  const readCanonicalAuditDestructionGrant: AuthorityAuditInputOperations['readCanonicalAuditDestructionGrant'] =
    (grantFile) => {
      const bytes = readPrivateInputFile(grantFile, 'audit destruction grant');
      let raw: unknown;
      try {
        raw = JSON.parse(bytes) as unknown;
      } catch {
        throw destructionGrantFileInvalid();
      }
      const canonical = canonicalAuditDestructionGrantEnvelope(
        raw as AuditDestructionGrantEnvelope,
      );
      if (bytes !== canonical) throw destructionGrantFileInvalid();
      return JSON.parse(canonical) as AuditDestructionGrantEnvelope;
    };

  const assertControllingTerminal: AuthorityAuditInputOperations['assertControllingTerminal'] =
    (runtime) => {
      const stdinIsTTY = runtime.stdinIsTTY ?? process.stdin.isTTY === true;
      const stdoutIsTTY = runtime.stdoutIsTTY ?? process.stdout.isTTY === true;
      if (stdinIsTTY !== true || stdoutIsTTY !== true) {
        throw workflowError(
          'AUTHORITY_AUDIT_CONTROLLING_TERMINAL_REQUIRED',
          'Protected audit configuration requires both controlling stdin and stdout terminals.',
          ExitCode.guard,
        );
      }
    };

  const exactRuntimeNow: AuthorityAuditInputOperations['exactRuntimeNow'] = (
    runtime,
  ) => {
    const now = runtime.now ?? new Date();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw workflowError(
        'AUTHORITY_AUDIT_CLOCK_INVALID',
        'Authority audit command requires a valid trusted runtime clock.',
        ExitCode.usage,
      );
    }
    return new Date(now.getTime());
  };

  function assertCanonicalInputFilePath(value: string): string {
    if (!isCanonicalAbsolutePath(value)) throw auditUsageError();
    return value;
  }

  function isCanonicalAbsolutePath(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      value.length > 0 &&
      Buffer.byteLength(value) <= MAX_AUDIT_INPUT_PATH_BYTES &&
      !value.includes('\0') &&
      path.isAbsolute(value) &&
      path.normalize(value) === value
    );
  }

  function pathsOverlap(left: string, right: string): boolean {
    const leftToRight = path.relative(left, right);
    const rightToLeft = path.relative(right, left);
    return (
      leftToRight === '' ||
      rightToLeft === '' ||
      (!leftToRight.startsWith('..') && !path.isAbsolute(leftToRight)) ||
      (!rightToLeft.startsWith('..') && !path.isAbsolute(rightToLeft))
    );
  }

  function isWorkflowErrorCode(error: unknown, code: string): boolean {
    return (
      error instanceof Error &&
      'code' in error &&
      (error as { code?: unknown }).code === code
    );
  }

  return {
    assertExternalAuditRoot,
    assertProtectedBackendRootInput,
    readPrivateInputFile,
    readCanonicalAuditDestructionGrant,
    assertControllingTerminal,
    exactRuntimeNow,
  };
}
