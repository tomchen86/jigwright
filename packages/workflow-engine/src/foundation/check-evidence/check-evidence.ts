/**
 * Owns shared check observations and their exact failure-evidence codec.
 *
 * Invariants:
 * - Successful observations retain their mutable full metadata shape.
 * - Failed observations bind bounded output excerpts and exact canonical digests.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../errors/errors.ts';
export type CheckEvidence = {
  checkId: string;
  outcome: 'passed';
  exitCode: 0;
  runner: string;
  runnerDigest: string;
  destructiveDatabase: boolean;
  databaseIdentity?: string;
  completedAt?: string;
  externalSnapshotDigest?: string;
  maxAgeMs?: number;
};

export type ObservedCheckFailure = Readonly<{
  checkId: string;
  outcome: 'failed';
  exitCode: number;
  runner: string;
  runnerDigest: string;
  stdoutDigest: string;
  stderrDigest: string;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  failureFingerprint: string;
}>;

export type ObservedCheckOutcome = CheckEvidence | ObservedCheckFailure;

export const OBSERVED_CHECK_FAILURE_EXCERPT_BYTES = 8 * 1024;

export function parseObservedCheckFailure(
  value: unknown,
): ObservedCheckFailure {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(
        [
          'checkId',
          'outcome',
          'exitCode',
          'runner',
          'runnerDigest',
          'stdoutDigest',
          'stderrDigest',
          'stdoutExcerpt',
          'stderrExcerpt',
          'stdoutTruncated',
          'stderrTruncated',
          'failureFingerprint',
        ].sort(),
      ) ||
    typeof value.checkId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.checkId) ||
    value.outcome !== 'failed' ||
    !Number.isSafeInteger(value.exitCode) ||
    (value.exitCode as number) < 1 ||
    (value.exitCode as number) > 255 ||
    typeof value.runner !== 'string' ||
    value.runner.trim() !== value.runner ||
    Buffer.byteLength(value.runner, 'utf8') < 1 ||
    Buffer.byteLength(value.runner, 'utf8') > 1024 ||
    !isDigest(value.runnerDigest) ||
    !isDigest(value.stdoutDigest) ||
    !isDigest(value.stderrDigest) ||
    typeof value.stdoutExcerpt !== 'string' ||
    typeof value.stderrExcerpt !== 'string' ||
    Buffer.byteLength(value.stdoutExcerpt, 'utf8') >
      OBSERVED_CHECK_FAILURE_EXCERPT_BYTES ||
    Buffer.byteLength(value.stderrExcerpt, 'utf8') >
      OBSERVED_CHECK_FAILURE_EXCERPT_BYTES ||
    typeof value.stdoutTruncated !== 'boolean' ||
    typeof value.stderrTruncated !== 'boolean' ||
    !isDigest(value.failureFingerprint)
  ) {
    throw observedFailureInvalid();
  }
  const body = {
    checkId: value.checkId,
    outcome: value.outcome,
    exitCode: value.exitCode,
    runner: value.runner,
    runnerDigest: value.runnerDigest,
    stdoutDigest: value.stdoutDigest,
    stderrDigest: value.stderrDigest,
    stdoutExcerpt: value.stdoutExcerpt,
    stderrExcerpt: value.stderrExcerpt,
    stdoutTruncated: value.stdoutTruncated,
    stderrTruncated: value.stderrTruncated,
  };
  if (
    value.failureFingerprint !== sha256(canonicalJson(body)) ||
    (!value.stdoutTruncated &&
      value.stdoutDigest !== sha256(value.stdoutExcerpt)) ||
    (!value.stderrTruncated &&
      value.stderrDigest !== sha256(value.stderrExcerpt))
  ) {
    throw observedFailureInvalid();
  }
  return Object.freeze({
    ...body,
    failureFingerprint: value.failureFingerprint,
  }) as ObservedCheckFailure;
}

function observedFailureInvalid() {
  return workflowError(
    'OBSERVED_CHECK_FAILURE_INVALID',
    'Observed check failure evidence is invalid.',
    ExitCode.staleState,
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
export { sha256 };
