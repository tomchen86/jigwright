/**
 * Publishes immutable document decisions and their exact candidate pointer.
 *
 * Invariants:
 * - A candidate pointer names a verified content record, never mutable decision text.
 * - Grant exceptions retain the authorizing challenge and operation separately from review.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { replaceTextAtomic } from '../repository-transaction/atomic-text.ts';
import {
  assertPlainDirectory,
  ensurePlainDirectory,
} from '../repository-transaction/filesystem-safety.ts';
import {
  readContentRecord,
  writeContentRecord,
  type ContentRecord,
} from './content-record-store.ts';

export function readSystemDocumentReviewRecord(
  runtimeRoot: string,
  candidateDigest: string,
): { reportId: string; record: ContentRecord } | null {
  const paths = reviewPaths(runtimeRoot, candidateDigest);
  const stat = fs.lstatSync(paths.pointer, { throwIfNoEntry: false });
  if (!stat) return null;
  assertPlainDirectory(path.dirname(paths.pointer));
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    fs.realpathSync(paths.pointer) !== paths.pointer
  )
    throw invalid();
  const pointer: unknown = JSON.parse(fs.readFileSync(paths.pointer, 'utf8'));
  if (!isRecord(pointer) || typeof pointer.reportId !== 'string')
    throw invalid();
  const record = readContentRecord(paths.records, pointer.reportId);
  if (
    record.kind !== 'system-document-disposition-record.v1' ||
    record.candidateDigest !== candidateDigest
  )
    throw invalid();
  return { reportId: pointer.reportId, record };
}

export function writeSystemDocumentReviewRecord(
  runtimeRoot: string,
  record: ContentRecord & { candidateDigest: string },
): string {
  const paths = reviewPaths(runtimeRoot, record.candidateDigest);
  const reportId = writeContentRecord(paths.records, record);
  ensurePlainDirectory(path.dirname(paths.pointer));
  replaceTextAtomic(paths.pointer, `${JSON.stringify({ reportId })}\n`, {
    allowCreate: true,
    defaultMode: 0o600,
  });
  const descriptor = fs.openSync(path.dirname(paths.pointer), 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  return reportId;
}

function reviewPaths(runtimeRoot: string, candidateDigest: string) {
  if (!/^sha256:[0-9a-f]{64}$/.test(candidateDigest)) throw invalid();
  const root = path.join(runtimeRoot, 'system-document-dispositions');
  return {
    records: path.join(root, 'records'),
    pointer: path.join(root, 'candidates', `${candidateDigest.slice(7)}.json`),
  };
}

function invalid() {
  return workflowError(
    'SYSTEM_DOCUMENT_REVIEW_RECORD_INVALID',
    'The stored document decision cannot be read; record the current candidate again or request its exact Grant exception.',
    ExitCode.staleState,
  );
}
