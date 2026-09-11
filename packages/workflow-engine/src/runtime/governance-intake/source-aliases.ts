/** Read the optional repository Source alias document. */
import fs from 'node:fs';
import path from 'node:path';
import {
  GOVERNANCE_SOURCE_ALIASES_PATH,
  parseGovernanceSourceAliases,
  type GovernanceSourceAlias,
} from '../../modules/governance-intake/source-aliases.ts';
export function readGovernanceSourceAliases(
  repositoryRoot: string,
): Readonly<Record<string, GovernanceSourceAlias>> {
  const target = path.join(repositoryRoot, GOVERNANCE_SOURCE_ALIASES_PATH);
  return parseGovernanceSourceAliases(
    fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : undefined,
  );
}
