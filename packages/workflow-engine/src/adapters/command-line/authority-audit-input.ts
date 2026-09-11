/** Parses the audit command grammar and defines its exact input error presentation. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  AuthorityAuditRequest,
  AuthorityAuditInputErrors,
} from '../../modules/authority/authority-audit-contract.ts';
export function authorityAuditUsage(): string {
  return [
    'Usage: pnpm workflow audit <command> --audit-root <absolute-external-path>',
    '  audit profile development --audit-root <absolute-external-path>',
    '  audit profile protected --audit-root <absolute-external-path> --backend-root <absolute-private-path> --destruction-public-key <absolute-private-file>',
    '  audit show <task-id> --audit-root <absolute-external-path>',
    '  audit verify <repository-id> --audit-root <absolute-external-path>',
    '  audit anchor --audit-root <absolute-external-path>',
    '  audit verify-anchors --audit-root <absolute-external-path>',
    '  audit destroy --grant-file <absolute-private-file> --audit-root <absolute-external-path>',
  ].join('\n');
}

export function parseArguments(argv: readonly string[]): AuthorityAuditRequest {
  if (argv.length === 0 || argv.some((value) => typeof value !== 'string')) {
    throw auditUsageError();
  }
  const action = argv[0];
  if (action === 'profile') {
    const subject = assertSubject(argv[1]);
    if (subject === 'development') {
      const flags = parseExactFlags(argv.slice(2), ['--audit-root']);
      return {
        action,
        subject,
        auditRoot: flags.get('--audit-root')!,
      };
    }
    if (subject === 'protected') {
      const flags = parseExactFlags(argv.slice(2), [
        '--audit-root',
        '--backend-root',
        '--destruction-public-key',
      ]);
      return {
        action,
        subject,
        auditRoot: flags.get('--audit-root')!,
        backendRoot: flags.get('--backend-root')!,
        destructionPublicKey: flags.get('--destruction-public-key')!,
      };
    }
    throw auditUsageError();
  }
  if (action === 'show' || action === 'verify') {
    const subject = assertSubject(argv[1]);
    const flags = parseExactFlags(argv.slice(2), ['--audit-root']);
    return {
      action,
      subject,
      auditRoot: flags.get('--audit-root')!,
    };
  }
  if (action === 'anchor' || action === 'verify-anchors') {
    const flags = parseExactFlags(argv.slice(1), ['--audit-root']);
    return { action, auditRoot: flags.get('--audit-root')! };
  }
  if (action === 'destroy') {
    const flags = parseExactFlags(argv.slice(1), [
      '--audit-root',
      '--grant-file',
    ]);
    return {
      action,
      auditRoot: flags.get('--audit-root')!,
      grantFile: flags.get('--grant-file')!,
    };
  }
  throw auditUsageError();
}

function parseExactFlags(
  argv: readonly string[],
  expectedFlags: readonly string[],
): ReadonlyMap<string, string> {
  if (argv.length !== expectedFlags.length * 2) throw auditUsageError();
  const permitted = new Set(expectedFlags);
  const parsed = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      typeof flag !== 'string' ||
      !permitted.has(flag) ||
      parsed.has(flag) ||
      typeof value !== 'string' ||
      value.length === 0 ||
      value.trim() !== value ||
      value.includes('\0')
    ) {
      throw auditUsageError();
    }
    parsed.set(flag, value);
  }
  if (expectedFlags.some((flag) => !parsed.has(flag))) throw auditUsageError();
  return parsed;
}

function assertSubject(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes('\0') ||
    Buffer.byteLength(value) > 512
  ) {
    throw auditUsageError();
  }
  return value;
}

export const auditUsageError: AuthorityAuditInputErrors['auditUsageError'] =
  () => {
    return workflowError(
      'AUTHORITY_AUDIT_USAGE',
      authorityAuditUsage(),
      ExitCode.usage,
    );
  };

export const protectedConfigurationInputInvalid: AuthorityAuditInputErrors['protectedConfigurationInputInvalid'] =
  () => {
    return workflowError(
      'AUTHORITY_AUDIT_PROTECTED_CONFIGURATION_INVALID',
      'Protected audit configuration requires a canonical, private, external backend root.',
      ExitCode.unsafeEnvironment,
    );
  };

export const inputFileUnsafe: AuthorityAuditInputErrors['inputFileUnsafe'] = (
  label,
) => {
  return workflowError(
    'AUTHORITY_AUDIT_INPUT_FILE_UNSAFE',
    `Authority audit ${label} must be an exact canonical regular 0600 file.`,
    ExitCode.unsafeEnvironment,
  );
};

export const destructionGrantFileInvalid: AuthorityAuditInputErrors['destructionGrantFileInvalid'] =
  () => {
    return workflowError(
      'AUTHORITY_AUDIT_DESTRUCTION_GRANT_INVALID',
      'Audit destruction grant file is not exact canonical JSON.',
      ExitCode.verification,
    );
  };
