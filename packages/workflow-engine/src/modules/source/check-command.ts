/**
 * Owns resolved and pinned check-runner facts and exposes canonical check
 * command parsing and registry types.
 *
 * Invariants:
 * - Resolved runner identity retains its executable, arguments and digest;
 *   pinning preserves those facts as readonly values.
 */
export {
  parseCheckCommand,
  parseChecksConfigSource,
} from '@jigwright/core/check-command';
export type {
  CheckDefinition,
  ChecksConfig,
  ChecksConfigParseResult,
  ParsedCheckCommand,
} from '@jigwright/core/check-command';

/** Identity and command facts for a resolved, pinned check runner. */
export type ResolvedCheckRunner = {
  runner: string;
  executable: string;
  args: string[];
  digest: string;
};

export type PinnedCheckRunner = Readonly<ResolvedCheckRunner>;

/**
 * Resolves one configured check command to a reviewed executable identity.
 * Implementations know the repository layout and belong to the consumer adapter.
 */
export type CheckRunnerResolver = (
  repositoryRoot: string,
  checkId: string,
  definition: CheckDefinition,
) => ResolvedCheckRunner;

import type { CheckDefinition } from '@jigwright/core/check-command';
/** Resolves a pinned executable identity for a declared repository check. */
export type CheckRunnerPin = (
  repositoryRoot: string,
  checkId: string,
  definition: CheckDefinition,
) => PinnedCheckRunner;
