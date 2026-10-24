import type {
  ChangeContractServices,
  ChangeRoutingAdmissionReader,
  ChangeRoutingInspector,
} from '../modules/lifecycle/change-routing.ts';
import {
  assertChangeRoutingAdmission,
  inspectChangeRouting,
} from '../runtime/change-routing/routing-observation.ts';
import {
  loadStableValidatedChangeContract,
  productionChangeRoutingAuthorityPort,
} from './validated-contract-context.ts';

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

/** The change-contract capabilities production operations receive together. */
export const productionChangeContract: ChangeContractServices = Object.freeze({
  admissionReader: productionChangeRoutingAdmissionReader,
  loadStableValidatedChangeContract,
});
