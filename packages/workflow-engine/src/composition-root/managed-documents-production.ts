import { productionChangeRoutingInspector } from './change-routing-observation-production.ts';
import { createManagedDocumentServices } from '../runtime/managed-documents/validation/managed-documents.ts';
import {
  projectHandoff,
  projectHandoffForTaskProjection,
  renderHandoffForChange,
  validateHandoff,
} from '../adapters/consumer/repository/handoff/handoff.ts';
import { loadChangeContract } from './consumer-contract-production.ts';

export const managedDocuments = createManagedDocumentServices({
  projectHandoff: projectHandoff.bind(undefined, productionChangeRoutingInspector, loadChangeContract),
  projectHandoffForTaskProjection: projectHandoffForTaskProjection.bind(
    undefined, productionChangeRoutingInspector,
    loadChangeContract,
  ),
  renderHandoffForChange: renderHandoffForChange.bind(
    undefined, productionChangeRoutingInspector,
    loadChangeContract,
  ),
  validateHandoff: validateHandoff.bind(undefined, productionChangeRoutingInspector, loadChangeContract),
});
export const {
  validateManagedDocuments,
  refreshCompletionDocuments,
  planCompletionDocuments,
  refreshPlanningDocuments,
} = managedDocuments;
