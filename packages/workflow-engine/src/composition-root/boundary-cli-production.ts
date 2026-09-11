/** Binds boundary commands to repository discovery, corpus storage and exact authority-remap projection. */
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { loadWorkflowConformanceVectorsV2 } from '../runtime/repository-transaction/conformance-vectors.ts';
import { projectAuthorityRemap } from './authority-remap.ts';
export const boundaryCommandOperations = {
  discoverRepository,
  loadWorkflowConformanceVectorsV2,
  projectAuthorityRemap,
};
