import { createManagedDocumentServices } from '../runtime/managed-documents/validation/managed-documents.ts';
import { handoffDocuments } from './handoff-production.ts';

export const managedDocuments = createManagedDocumentServices(handoffDocuments);
export const {
  validateManagedDocuments,
  refreshCompletionDocuments,
  planCompletionDocuments,
  refreshPlanningDocuments,
} = managedDocuments;
