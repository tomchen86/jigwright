import type {
  ChangeRoutingAdmissionReader,
  ChangeRoutingInspector,
} from '../modules/lifecycle/change-routing.ts';
import {
  assertChangeRoutingAdmission,
  inspectChangeRouting,
} from '../runtime/repository-observation/change-routing.ts';
import { productionChangeRoutingAuthorityPort } from './validated-contract-context.ts';

export const productionChangeRoutingAdmissionReader: ChangeRoutingAdmissionReader =
  (root, changeId) =>
    assertChangeRoutingAdmission(
      root,
      changeId,
      productionChangeRoutingAuthorityPort,
    );
// Preserve callers' structural-only inspection when no authority port is supplied.
export const productionChangeRoutingInspector: ChangeRoutingInspector =
  inspectChangeRouting;
