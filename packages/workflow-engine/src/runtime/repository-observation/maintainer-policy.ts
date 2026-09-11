/** Reads the repository policy before applying its pure schema and authority-path rules. */
import fs from 'node:fs';
import path from 'node:path';
import {
  parseMaintainerPolicy,
  invalidPolicy,
  type MaintainerPolicy,
} from '../../modules/authority/maintainer-policy.ts';

export function loadMaintainerPolicy(repositoryRoot: string): MaintainerPolicy {
  const policyPath = path.join(
    repositoryRoot,
    'workflow/maintainer-policy.json',
  );
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (error) {
    throw invalidPolicy('Unable to read workflow/maintainer-policy.json.', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return parseMaintainerPolicy(value);
}
