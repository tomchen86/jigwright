/**
 * Computes identities for the required registered check definitions.
 *
 * Invariants:
 * - Each requested check is hashed from its serialized registry definition.
 */
import crypto from 'node:crypto';

import type { ChecksConfig } from '../source/check-command.ts';

export function digestRequiredCheckDefinitions(
  checks: ChecksConfig,
  checkIds: string[],
): Record<string, string> {
  return Object.fromEntries(
    checkIds.map((checkId) => [
      checkId,
      crypto
        .createHash('sha256')
        .update(JSON.stringify(checks.checks[checkId]))
        .digest('hex'),
    ]),
  );
}
