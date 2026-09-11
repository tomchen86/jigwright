/** Capture Sources against a required immutable ledger capability. */
import {
  createGovernanceSourceV1,
  type GovernanceSourceAuthoringV1,
  type GovernanceSourceV1,
} from '@jigwright/core/governance-source';
import { governanceSourceRelativePath } from '../../modules/governance-intake/governance-intake.ts';
import {
  sourceAliasReferences,
  type GovernanceSourceAlias,
} from '../../modules/governance-intake/source-aliases.ts';
export type GovernanceSourceLedger = Readonly<{
  readSource(repositoryRoot: string, sourceId: string): GovernanceSourceV1;
  readAliases(
    repositoryRoot: string,
  ): Readonly<Record<string, GovernanceSourceAlias>>;
  listSources(repositoryRoot: string): GovernanceSourceV1[];
  publishSource(repositoryRoot: string, source: GovernanceSourceV1): boolean;
}>;
export function createGovernanceSourceServices(ledger: GovernanceSourceLedger) {
  function captureGovernanceSource(
    repositoryRoot: string,
    input: GovernanceSourceAuthoringV1,
  ) {
    const source = createGovernanceSourceV1(input);
    if (source.supersedes !== null)
      ledger.readSource(repositoryRoot, source.supersedes);
    const relativePath = governanceSourceRelativePath(source.id);
    const created = ledger.publishSource(repositoryRoot, source);
    return { source, relativePath, created };
  }
  function resolveGovernanceSourceAlias(repositoryRoot: string, alias: string) {
    return sourceAliasReferences(ledger.readAliases(repositoryRoot), alias).map(
      (ref) => ledger.readSource(repositoryRoot, ref),
    );
  }
  return {
    resolveGovernanceSourceAlias,
    readGovernanceSourceAliases: ledger.readAliases,
    captureGovernanceSource,
    readGovernanceSource: ledger.readSource,
    listGovernanceSources: ledger.listSources,
  };
}
