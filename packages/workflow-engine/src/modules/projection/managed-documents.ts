import type { HandoffChange } from './handoff.ts';
import type { SystemDescriptionSnapshot } from '../source/spec-ownership.ts';
import type { InvestigationManifestV3 } from '../investigation/manifest/investigation-manifest-types.ts';

export type RepositoryTextReader = (relativePath: string) => string | undefined;

export type GeneratedDocumentMutation = {
  path: string;
  before: string | undefined;
  after: string;
};

export type ManagedDocumentValidationContext = Readonly<{
  contracts: readonly HandoffChange[];
  readText: RepositoryTextReader;
  systemDescriptionSnapshot?: SystemDescriptionSnapshot;
}>;

/** Policy-aware document projections; each operation observes the current repository. */
export type ManagedDocumentOperations = Readonly<{
  validateManagedDocuments(
    repositoryRoot: string,
    context?: ManagedDocumentValidationContext,
  ): string[];
  refreshCompletionDocuments(
    repositoryRoot: string,
  ): GeneratedDocumentMutation[];
  planCompletionDocuments(
    repositoryRoot: string,
    taskProjection?: Readonly<{ changeId: string; tasks: string }>,
  ): GeneratedDocumentMutation[];
  refreshPlanningDocuments(
    repositoryRoot: string,
    changeId: string,
    manifest: InvestigationManifestV3 | undefined,
  ): GeneratedDocumentMutation[];
}>;
