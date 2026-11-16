/** Feature storage boundary: writes to a target are only supplied inside its lock. */
import type {
  ProposalRecord,
  ReviewRecord,
} from './document-refresh-policy.ts';

export type RefreshTarget = Readonly<{
  target: string;
  readPolicy(): string;
  readText(): string;
  withLock<T>(operation: (commit: (content: string) => void) => T): T;
}>;

export type DocumentRefreshStorage = Readonly<{
  readRecord(kind: 'proposal' | 'review', id: string): unknown;
  writeRecord(record: ProposalRecord | ReviewRecord): string;
  openTarget(requestedTarget: string): RefreshTarget;
}>;
