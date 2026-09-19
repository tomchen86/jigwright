/** Binds failure currentness observation to the complete production repository context. */
import { createInvestigationV3FailureObservations } from '../runtime/repository-observation/investigation-v3-failure-source.ts';
import {
  investigationManifestPublicationGitStateDigest,
  investigationManifestPublicationStateDigest,
  observeInvestigationManifestPublicationState,
  readBoundInvestigationManifestPublicationRef,
} from '../runtime/managed-documents/transaction/investigation-publication.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';
export const investigationFailureObservations =
  createInvestigationV3FailureObservations(loadInvestigationRuntimeContext, {
    investigationManifestPublicationGitStateDigest,
    investigationManifestPublicationStateDigest,
    observeInvestigationManifestPublicationState,
    readBoundInvestigationManifestPublicationRef,
  });
export const { captureInvestigationV3DirectFailureEmission } =
  investigationFailureObservations;
