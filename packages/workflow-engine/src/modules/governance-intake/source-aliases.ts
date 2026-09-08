/**
 * Resolve named owner requirements to their canonical Source records.
 *
 * Invariants:
 * - Alias records contain titles and references; wording lives in Sources.
 */
import fs from 'node:fs';
import path from 'node:path';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { readGovernanceSource } from './governance-intake.ts';

export const GOVERNANCE_SOURCE_ALIASES_PATH =
  'workflow/source-ledger/aliases.json';
export type GovernanceSourceAlias = Readonly<{
  title: string;
  sourceRefs: readonly string[];
}>;

export function readGovernanceSourceAliases(
  repositoryRoot: string,
): Readonly<Record<string, GovernanceSourceAlias>> {
  const target = path.join(repositoryRoot, GOVERNANCE_SOURCE_ALIASES_PATH);
  return parseGovernanceSourceAliases(
    fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined,
  );
}

/** Read aliases from the same immutable snapshot as their consuming documents. */
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

export function resolveGovernanceSourceAlias(
  repositoryRoot: string,
  alias: string,
) {
  const aliases = readGovernanceSourceAliases(repositoryRoot);
  if (!Object.hasOwn(aliases, alias))
    throw workflowError(
      'GOVERNANCE_SOURCE_ALIAS_UNKNOWN',
      `Unknown Source alias: ${alias}.`,
      ExitCode.usage,
    );
  return aliases[alias]!.sourceRefs.map((ref) =>
    readGovernanceSource(repositoryRoot, ref),
  );
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
