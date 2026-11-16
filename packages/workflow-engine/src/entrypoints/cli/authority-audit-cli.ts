/** Parses audit commands and presents their synchronous application results. */
import { authorityAuditCommands } from '../../composition-root/authority-audit-production.ts';

export type AuthorityAuditCliRuntime = NonNullable<
  Parameters<typeof authorityAuditCommands.execute>[2]
>;
type WithCliKind<T> = T extends object
  ? Readonly<{ kind: 'authority-audit-cli-result.v1' }> & T
  : never;
export type AuthorityAuditCliResult = WithCliKind<
  ReturnType<typeof authorityAuditCommands.execute>
>;
type AuthorityAuditProfileCliResult = Extract<
  AuthorityAuditCliResult,
  { action: 'profile' }
>;
type AuthorityAuditShowCliResult = Extract<
  AuthorityAuditCliResult,
  { action: 'show' }
>;
type AuthorityAuditVerifyCliResult = Extract<
  AuthorityAuditCliResult,
  { action: 'verify' }
>;
type AuthorityAuditAnchorCliResult = Extract<
  AuthorityAuditCliResult,
  { action: 'anchor' }
>;
type AuthorityAuditVerifyAnchorsCliResult = Extract<
  AuthorityAuditCliResult,
  { action: 'verify-anchors' }
>;
type AuthorityAuditDestroyCliResult = Extract<
  AuthorityAuditCliResult,
  { action: 'destroy' }
>;

export function dispatchAuthorityAuditCommand(
  argv: readonly ['profile', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditProfileCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly ['show', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditShowCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly ['verify', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditVerifyCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly ['anchor', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditAnchorCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly ['verify-anchors', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditVerifyAnchorsCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly ['destroy', ...string[]],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditDestroyCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly string[],
  cwd: string,
  runtime?: AuthorityAuditCliRuntime,
): AuthorityAuditCliResult;
export function dispatchAuthorityAuditCommand(
  argv: readonly string[],
  cwd: string,
  runtime: AuthorityAuditCliRuntime = {},
): AuthorityAuditCliResult {
  const parsed = authorityAuditCommands.parseArguments(argv);
  const result = authorityAuditCommands.execute(parsed, cwd, runtime);
  return { kind: 'authority-audit-cli-result.v1', ...result };
}

export const resolveAuthorityAuditScope = authorityAuditCommands.resolveScope;
export const authorityAuditUsage = authorityAuditCommands.usage;
