/**
 * Preflight one reviewed provider executable against the exact definition and required capability flags.
 *
 * Invariants:
 * - Candidate inspection, definition admission, probe order, and authentication classification stay exact.
 * - The caller supplies its reviewed adapter capability flags and existing runner host.
 */

import {assertKnownBuiltInProviderDefinitionSnapshot} from '@jigwright/core/built-in-provider-definition';
import { createProviderExecutionEnvironment } from './execution-environment.ts';
import type { ProviderDefinitionSnapshot } from '@jigwright/core/provider-definition-snapshot';
import type {
  ProviderRunnerHost,
  ProviderPreflightOptions,
  ProviderResolution,
} from './provider-runner.ts';
import { providerProfileStale } from './provider-runner-values.ts';
import { isRegularExecutable } from './provider-runner-files.ts';

import { type ProviderId } from '../../modules/provider-orchestration/provider-registry.ts';
import {
  type ProviderExecutableIdentity,
  type ProviderProcessOutcome,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import { type ProviderExecutableObservation } from '@jigwright/agent-runtime/provider-executable-identity';
import { isWithinDirectory } from './provider-runner-files.ts';
import { isRecord } from './provider-runner-values.ts';

export const PROBE_TIMEOUT_MS = 10_000;

export const PROBE_OUTPUT_BYTES = 64 * 1024;

/**
 * The bounded preflight surface of a reviewed provider. Every field is
 * code-owned: the fixed candidate paths, the ordered version/help probes with
 * their required advertised flags, and the provider's own authentication status
 * command. Reviewed real-path install roots are derived per candidate.
 */
export type ProviderPreflightSpec = {
  helpProbes: ReadonlyArray<{
    args: readonly string[];
    requiredFlags: readonly string[];
  }>;
  authArgs: readonly string[];
};

const REVIEWED_CANDIDATE_REAL_ROOTS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  '/opt/homebrew/bin/claude': Object.freeze([
    '/opt/homebrew/Caskroom/claude-code',
    '/opt/homebrew/Cellar/claude-code',
  ]),
  '/usr/local/bin/claude': Object.freeze([
    '/usr/local/Caskroom/claude-code',
    '/usr/local/Cellar/claude-code',
  ]),
  '/opt/homebrew/bin/codex': Object.freeze([
    '/opt/homebrew/Caskroom/codex',
    '/opt/homebrew/Cellar/codex',
  ]),
  '/usr/local/bin/codex': Object.freeze([
    '/usr/local/Caskroom/codex',
    '/usr/local/Cellar/codex',
  ]),
});

/**
 * A reviewed candidate's real path may only be the candidate executable itself
 * or a file under the exact reviewed package roots for that candidate. Any
 * sibling package or broader prefix path is unsafe.
 */
export function isReviewedRealPath(
  candidatePath: string,
  realPath: string,
): boolean {
  if (realPath === candidatePath) {
    return true;
  }
  return (REVIEWED_CANDIDATE_REAL_ROOTS[candidatePath] ?? []).some(
    (installRoot) => isWithinDirectory(installRoot, realPath),
  );
}

type CandidateInspection =
  | Readonly<{ state: 'absent' }>
  | Readonly<{ state: 'unsafe' }>
  | Readonly<{
      state: 'observed';
      identity: ProviderExecutableIdentity;
    }>;

export function normalizeCandidateInspection(
  candidatePath: string,
  value: ProviderExecutableIdentity | ProviderExecutableObservation | null,
): CandidateInspection {
  if (value === null) return { state: 'absent' };
  if (!('state' in value)) {
    return value.candidatePath === candidatePath
      ? { state: 'observed', identity: value }
      : { state: 'unsafe' };
  }
  if (value.candidatePath !== candidatePath) return { state: 'unsafe' };
  if (value.state === 'absent') {
    return value.identity === null && value.unsafeReason === null
      ? { state: 'absent' }
      : { state: 'unsafe' };
  }
  if (value.state === 'unsafe') return { state: 'unsafe' };
  return value.identity !== null &&
    value.identity.candidatePath === candidatePath &&
    value.unsafeReason === null
    ? { state: 'observed', identity: value.identity }
    : { state: 'unsafe' };
}

export function advertisesFlags(
  requiredFlags: readonly string[],
  helpText: string,
): boolean {
  return requiredFlags.every((flag) => helpText.includes(flag));
}

export function indicatesAuthenticated(
  providerId: ProviderId,
  outcome: ProviderProcessOutcome,
): boolean {
  if (!probeSucceeded(outcome)) {
    return false;
  }
  const text = outcome.stdout.trim();
  if (providerId === 'claude') {
    try {
      const parsed = JSON.parse(text);
      return isRecord(parsed) && parsed.loggedIn === true;
    } catch {
      return false;
    }
  }
  // `codex login status` writes its human-readable confirmation to stderr
  // whenever stdout is not a TTY, which it never is under the engine's
  // sanitized non-interactive probe environment. Reading stdout alone
  // therefore misclassified an authenticated Codex as `unauthenticated` and
  // made the provider-independent role path unreachable. Accept the exact
  // confirmation from either stream; a zero exit is still required, and no
  // other output shape is admitted.
  return [text, outcome.stderr.trim()].some((line) =>
    /^logged in(?:\s+using\b.*)?$/i.test(line),
  );
}

export function probeSucceeded(outcome: ProviderProcessOutcome): boolean {
  return (
    outcome.exitCode === 0 &&
    !outcome.timedOut &&
    outcome.signal === null &&
    outcome.spawnErrorCode === null
  );
}

export function preflightProviderSnapshot(
  host: ProviderRunnerHost,
  specs: Readonly<Record<ProviderId, ProviderPreflightSpec>>,
  definitionSnapshot: ProviderDefinitionSnapshot,
  options: ProviderPreflightOptions,
  selectedExecutableCandidate?: string,
): ProviderResolution {
  const admittedDefinition = assertKnownBuiltInProviderDefinitionSnapshot(
    definitionSnapshot,
    {
      platform: options.platform,
    },
  );
  const providerId = admittedDefinition.providerFamily as ProviderId;
  const spec = specs[providerId];
  if (
    selectedExecutableCandidate !== undefined &&
    !admittedDefinition.executableCandidates.includes(
      selectedExecutableCandidate,
    )
  ) {
    throw providerProfileStale();
  }
  const candidates =
    selectedExecutableCandidate === undefined
      ? admittedDefinition.executableCandidates
      : [selectedExecutableCandidate];

  // Inspect every fixed candidate; never a caller-PATH or dynamic location. A
  // candidate must be a regular executable whose real path is the candidate
  // itself or lives under its own reviewed install root; a symlink escaping to
  // any other real path is unsafe and is never probed.
  const resolved: ProviderExecutableIdentity[] = [];
  let sawUnsafeCandidate = false;
  for (const candidate of candidates) {
    const inspection = normalizeCandidateInspection(
      candidate,
      host.inspectCandidate(candidate),
    );
    if (inspection.state === 'absent') {
      continue;
    }
    if (inspection.state === 'unsafe') {
      sawUnsafeCandidate = true;
      continue;
    }
    const identity = inspection.identity;
    if (
      !isRegularExecutable(identity.mode) ||
      !isReviewedRealPath(candidate, identity.realPath)
    ) {
      sawUnsafeCandidate = true;
      continue;
    }
    resolved.push(identity);
  }
  if (resolved.length === 0) {
    return { status: sawUnsafeCandidate ? 'unsafe-candidate' : 'absent' };
  }

  const environment = createProviderExecutionEnvironment(
    providerId,
    process.execPath,
    options.temporaryDirectory,
    options.sourceEnvironment,
  );
  const probe = (executable: string, args: string[]): ProviderProcessOutcome =>
    host.runProbe({
      executable,
      args,
      cwd: options.temporaryDirectory,
      environment,
      timeoutMs: PROBE_TIMEOUT_MS,
      maxOutputBytes: PROBE_OUTPUT_BYTES,
    });

  let fallback: ProviderResolution | undefined;
  for (const executable of resolved) {
    const versionOutcome = probe(executable.realPath, ['--version']);
    if (
      !probeSucceeded(versionOutcome) ||
      versionOutcome.stdout.trim() === ''
    ) {
      fallback ??= { status: 'incompatible', executable };
      continue;
    }
    const version = versionOutcome.stdout.trim();

    let compatible = true;
    for (const helpProbe of spec.helpProbes) {
      const helpOutcome = probe(executable.realPath, [...helpProbe.args]);
      if (
        !probeSucceeded(helpOutcome) ||
        !advertisesFlags(helpProbe.requiredFlags, helpOutcome.stdout)
      ) {
        compatible = false;
        break;
      }
    }
    if (!compatible) {
      fallback ??= { status: 'incompatible', executable, version };
      continue;
    }

    const authOutcome = probe(executable.realPath, [...spec.authArgs]);
    if (!indicatesAuthenticated(providerId, authOutcome)) {
      fallback = { status: 'unauthenticated', executable, version };
      continue;
    }

    return { status: 'available', executable, version };
  }
  return (
    fallback ?? {
      status: sawUnsafeCandidate ? 'unsafe-candidate' : 'absent',
    }
  );
}
