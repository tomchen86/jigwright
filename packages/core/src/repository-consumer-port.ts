export type RepositoryPlanningConfigurationV1 = Readonly<{
  providerId: string;
  packageSchemaNames: readonly string[];
  requiredSchemaNames: readonly string[];
  supportedSchemaNames: readonly string[];
  managedSchemaNames: readonly string[];
  currentSchemaName: string;
}>;

export type RepositoryDocumentConfigurationV1 = Readonly<{
  adapterId: string;
  handoffPath: string;
  issueSourcePath: string;
  issueLogPath: string;
}>;

export type RepositoryWorkRegistryConfigurationV1 = Readonly<{
  adapterId: string;
  itemRoot: string;
  inventoryPath: string;
  backlogPath: string;
  historyRoot: string;
  sourceRoot: string;
  transitionPolicyPath: string;
  changeOriginRoot: string;
}>;

export type RepositoryDatabasePolicyConfigurationV1 = Readonly<{
  adapterId: string;
}>;

export type RepositoryConsumerConfigurationV1 = Readonly<{
  schemaVersion: 1;
  adapterId: string;
  consumerId: string;
  planning: RepositoryPlanningConfigurationV1;
  documents: RepositoryDocumentConfigurationV1;
  workRegistry: RepositoryWorkRegistryConfigurationV1;
  databasePolicy: RepositoryDatabasePolicyConfigurationV1;
}>;

/**
 * Consumer-owned repository policy enters Jigwright only through this port.
 * Implementations may read tracked files but may not supply commands or Git
 * transition authority.
 */
export type RepositoryConsumerPortV1 = Readonly<{
  contractVersion: 'jigwright.repository-consumer-port.v1';
  load(repositoryRoot: string): RepositoryConsumerConfigurationV1;
}>;
