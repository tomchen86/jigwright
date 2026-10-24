/** Matches completed document-disposition Grant receipts against the exact candidate and report. */
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { SYSTEM_DOCUMENT_DISPOSITION_TRANSITION } from '../source/document-disposition.ts';
import { approvalSubjectDigest } from './grant-core.ts';
import type { TerminalGrantRecord } from './grant-records.ts';

export function matchesSystemDocumentGrantReceipt(
  record: Pick<
    TerminalGrantRecord,
    'challenge' | 'operationId' | 'approvalSubject' | 'outcome'
  >,
  reportId: string,
  candidateDigest: string,
  value: Record<string, unknown>,
): boolean {
  const choice = record.challenge.choices.find(
    ({ choiceId }) => choiceId === record.approvalSubject.choiceId,
  );
  return (
    choice?.transitionId === SYSTEM_DOCUMENT_DISPOSITION_TRANSITION &&
    isRecord(choice.parameters) &&
    choice.parameters.candidateDigest === candidateDigest &&
    record.operationId === value.operationId &&
    approvalSubjectDigest(record.approvalSubject) ===
      value.approvalSubjectDigest &&
    record.outcome.outcome === 'completed' &&
    isRecord(record.outcome.details) &&
    record.outcome.details.reportId === reportId
  );
}
