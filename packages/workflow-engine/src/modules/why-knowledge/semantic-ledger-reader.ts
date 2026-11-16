/** Required validated ledger observations for domain reuse decisions. */
import type { LedgerEntry } from './semantic-ledger.ts';

export type LedgerIndex = Readonly<{
  schemaVersion: 1;
  kind: 'semantic-ledger-index';
  subjects: Readonly<Record<string, Readonly<{ currentEntryId: string }>>>;
}>;

export type SemanticLedgerReader = Readonly<{
  readLedgerEntry: (repositoryRoot: string, entryId: string) => LedgerEntry;
  readLedgerIndex: (repositoryRoot: string) => LedgerIndex;
}>;
