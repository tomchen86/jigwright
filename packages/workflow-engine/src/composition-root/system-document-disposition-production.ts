/** Bind document disposition rules to repository observations and durable Grant records. */
import {
  loadActiveSessionContext,
  runSessionOperation,
} from './lifecycle-context.ts';
import {
  listChangedPaths,
  fingerprintRepositoryProjection,
} from '../runtime/repository-transaction/git.ts';
import { createSystemDocumentDispositionService } from '../application/finalize/system-document-dispositions.ts';
import { observeSystemDocumentCandidate } from '../application/finalize/system-document-candidate.ts';
import { readSystemDescriptionSnapshot } from '../runtime/repository-transaction/system-description-snapshot.ts';
import {
  combineOpenSpecDeltas,
  specDeltaChangesContract,
} from '../runtime/repository-transaction/archive-delta-verifier.ts';
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
    observeSystemDocumentCandidate: (cwd, sessionId) =>
      observeSystemDocumentCandidate(cwd, sessionId, {
        loadActiveSessionContext,
        readSystemDescriptionSnapshot,
        listChangedPaths,
        fingerprintRepositoryProjection,
        deltaChangesContract: (documentPath, before, deltas) =>
          specDeltaChangesContract(
            documentPath,
            before,
            combineOpenSpecDeltas(deltas),
          ),
      }),
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
