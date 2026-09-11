/**
 * Loads the system document context owned by a task baseline.
 *
 * Invariants:
 * - Documentation is read from the session baseline tree and selected by
 *   the session allowed paths.
 */
import { systemDocumentContext } from '../../../modules/source/system-document-context.ts';
import { readSystemDescriptionSnapshot } from '../../repository-transaction/system-description-snapshot.ts';
import type { WorkflowSession } from '../../session-workspace/session-store.ts';

export function taskSystemDocumentContext(
  session: Pick<
    WorkflowSession,
    'repositoryRoot' | 'baseline' | 'allowedPaths'
  >,
) {
  return systemDocumentContext(
    readSystemDescriptionSnapshot(
      session.repositoryRoot,
      session.baseline.tree,
    ),
    session.allowedPaths,
  );
}
