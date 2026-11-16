/** Bind document disposition rules to repository observations and durable Grant records. */
import { runSessionOperation } from './lifecycle-context.ts';

import { createSystemDocumentDispositionService } from '../runtime/repository-validation/system-document-dispositions.ts';
import { observeSystemDocumentCandidate } from '../runtime/repository-validation/system-document-candidate.ts';

import {
  grantStorePaths,
  createFileGrantRecordStore,
} from '../runtime/lifecycle-ledgers/grant-store.ts';
import {
  readSystemDocumentReviewRecord,
  writeSystemDocumentReviewRecord,
} from '../runtime/storage-journal/system-document-review-store.ts';

export const systemDocumentDispositions =
  createSystemDocumentDispositionService({
    observeSystemDocumentCandidate,
    runSessionOperation,
    readSystemDocumentReviewRecord,
    writeSystemDocumentReviewRecord,
    readCompletedGrant(runtimeRoot, challengeId) {
      const record = createFileGrantRecordStore(
        grantStorePaths(runtimeRoot),
      ).readGrantRecord(challengeId);
      return record.state === 'completed' ? record : null;
    },
  });
