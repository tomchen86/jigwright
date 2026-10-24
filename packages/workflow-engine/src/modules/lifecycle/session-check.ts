/** Data returned by session checks and their caller-supplied execution options. */
import type { CheckEvidence } from '../../foundation/check-evidence/check-evidence.ts';

/** Execute current required checks and publish immutable session evidence. */

export type SessionCheck = {
  sessionId: string;
  changeId: string;
  taskId: string;
  changedPaths: string[];
  unexpectedPaths: string[];
  checks: CheckEvidence[];
  executedCheckIds: string[];
  reusedCheckIds: string[];
  passed: true;
  reportId: string;
};

export type SessionCheckOptions = {
  environment?: NodeJS.ProcessEnv;
  /** Trusted clock used to bind persisted check completion and freshness. */
  now?: () => Date;
  /**
   * Engine-owned trust seam for current external snapshots. Production callers
   * must never populate this from argv, candidate content, persisted session
   * fields, or ambient environment values.
   */
  externalSnapshotDigests?: Readonly<Record<string, string>>;
};
