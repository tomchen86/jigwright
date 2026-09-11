/** Binds failure currentness observation to the complete production repository context. */
import { createInvestigationV3FailureObservations } from '../runtime/repository-observation/investigation-v3-failure-source.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
export const investigationFailureObservations =
  createInvestigationV3FailureObservations(loadInvestigationRuntimeContext);
export const { captureInvestigationV3DirectFailureEmission } =
  investigationFailureObservations;
