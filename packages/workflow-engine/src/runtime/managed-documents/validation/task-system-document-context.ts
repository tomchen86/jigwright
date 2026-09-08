/** Reads task documentation from its committed baseline, including recovery. */
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
