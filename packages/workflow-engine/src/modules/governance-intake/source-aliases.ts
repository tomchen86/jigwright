/** Parse named Source aliases; wording remains in immutable Source records. */
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
export const GOVERNANCE_SOURCE_ALIASES_PATH =
  'workflow/source-ledger/aliases.json';
export type GovernanceSourceAlias = Readonly<{
  title: string;
  sourceRefs: readonly string[];
}>;
export function parseGovernanceSourceAliases(
  text: string | undefined,
): Readonly<Record<string, GovernanceSourceAlias>> {
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!record(value) || value.schemaVersion !== 1 || !record(value.aliases)) {
    throw invalid();
  }
  const aliases: [string, GovernanceSourceAlias][] = [];
  for (const [alias, entry] of Object.entries(value.aliases)) {
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(alias) ||
      !record(entry) ||
      typeof entry.title !== 'string' ||
      entry.title.trim().length === 0 ||
      !Array.isArray(entry.sourceRefs) ||
      entry.sourceRefs.length === 0 ||
      !entry.sourceRefs.every(
        (ref: unknown) =>
          typeof ref === 'string' && /^SRC-[a-f0-9]{64}$/u.test(ref),
      ) ||
      new Set(entry.sourceRefs).size !== entry.sourceRefs.length ||
      Object.keys(entry).some((key) => key !== 'title' && key !== 'sourceRefs')
    )
      throw invalid();
    aliases.push([alias, { title: entry.title, sourceRefs: entry.sourceRefs }]);
  }
  return Object.fromEntries(aliases);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function invalid() {
  return workflowError(
    'GOVERNANCE_SOURCE_ALIASES_INVALID',
    `${GOVERNANCE_SOURCE_ALIASES_PATH} is invalid.`,
    ExitCode.verification,
  );
}
export function sourceAliasReferences(
  aliases: Readonly<Record<string, GovernanceSourceAlias>>,
  alias: string,
): readonly string[] {
  if (!Object.hasOwn(aliases, alias))
    throw workflowError(
      'GOVERNANCE_SOURCE_ALIAS_UNKNOWN',
      `Unknown Source alias: ${alias}.`,
      ExitCode.usage,
    );
  return aliases[alias]!.sourceRefs;
}
