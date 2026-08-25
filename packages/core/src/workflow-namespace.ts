const CONSUMER_NAMESPACE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const SCHEMA_KIND = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const SCHEMA_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*\.v[1-9][0-9]*$/u;

export type WorkflowNamespaceErrorCode =
  | 'WORKFLOW_NAMESPACE_CONFIG_INVALID'
  | 'WORKFLOW_SCHEMA_ID_INVALID'
  | 'WORKFLOW_SCHEMA_NAMESPACE_UNSUPPORTED'
  | 'WORKFLOW_SIGNATURE_NAMESPACE_UNSUPPORTED';

export class WorkflowNamespaceError extends TypeError {
  readonly code: WorkflowNamespaceErrorCode;

  constructor(code: WorkflowNamespaceErrorCode, message: string) {
    super(message);
    this.name = 'WorkflowNamespaceError';
    this.code = code;
  }
}

export type WorkflowNamespaceConfig = Readonly<{
  schemaVersion: 1;
  consumerNamespace: string;
  acceptedLegacyPrefixes: readonly string[];
}>;

export type WorkflowRecordIdentity = Readonly<{
  schema: string;
  consumerNamespace: string;
}>;

export function createWorkflowNamespaceConfig(input: {
  consumerNamespace: string;
  acceptedLegacyPrefixes?: readonly string[];
}): WorkflowNamespaceConfig {
  const acceptedLegacyPrefixes = input.acceptedLegacyPrefixes ?? [];
  if (
    !CONSUMER_NAMESPACE.test(input.consumerNamespace) ||
    !Array.isArray(acceptedLegacyPrefixes) ||
    acceptedLegacyPrefixes.some(
      (prefix) =>
        typeof prefix !== 'string' ||
        !prefix.endsWith('.') ||
        !CONSUMER_NAMESPACE.test(prefix.slice(0, -1)),
    ) ||
    new Set(acceptedLegacyPrefixes).size !== acceptedLegacyPrefixes.length
  ) {
    throw new WorkflowNamespaceError(
      'WORKFLOW_NAMESPACE_CONFIG_INVALID',
      'Workflow namespace configuration is invalid.',
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    consumerNamespace: input.consumerNamespace,
    acceptedLegacyPrefixes: Object.freeze([...acceptedLegacyPrefixes]),
  });
}

export function workflowSchemaId(kind: string, version: number): string {
  if (
    !SCHEMA_KIND.test(kind) ||
    !Number.isSafeInteger(version) ||
    version < 1
  ) {
    throw new WorkflowNamespaceError(
      'WORKFLOW_SCHEMA_ID_INVALID',
      'Workflow schema identity is invalid.',
    );
  }
  return `workflow.${kind}.v${version}`;
}

export function createWorkflowRecordIdentity(
  config: WorkflowNamespaceConfig,
  kind: string,
  version: number,
): WorkflowRecordIdentity {
  const validated = createWorkflowNamespaceConfig(config);
  return Object.freeze({
    schema: workflowSchemaId(kind, version),
    consumerNamespace: validated.consumerNamespace,
  });
}

export function selectWorkflowRecordSchema(
  recordSchema: string,
  currentSchema: string,
  legacySchemas: readonly string[],
  config: WorkflowNamespaceConfig,
): Readonly<{ schema: string; generation: 'current' | 'legacy' }> {
  const validated = createWorkflowNamespaceConfig(config);
  if (
    typeof recordSchema !== 'string' ||
    !SCHEMA_ID.test(recordSchema) ||
    typeof currentSchema !== 'string' ||
    !SCHEMA_ID.test(currentSchema) ||
    !currentSchema.startsWith('workflow.') ||
    !Array.isArray(legacySchemas) ||
    legacySchemas.some(
      (schema) => typeof schema !== 'string' || !SCHEMA_ID.test(schema),
    )
  ) {
    throw new WorkflowNamespaceError(
      'WORKFLOW_SCHEMA_ID_INVALID',
      'Workflow schema identity is invalid.',
    );
  }

  if (recordSchema === currentSchema) {
    return Object.freeze({ schema: recordSchema, generation: 'current' });
  }

  if (
    legacySchemas.includes(recordSchema) &&
    validated.acceptedLegacyPrefixes.some((prefix) =>
      recordSchema.startsWith(prefix),
    )
  ) {
    return Object.freeze({ schema: recordSchema, generation: 'legacy' });
  }

  throw new WorkflowNamespaceError(
    'WORKFLOW_SCHEMA_NAMESPACE_UNSUPPORTED',
    'Workflow schema namespace or version is not supported.',
  );
}

export function assertAllowedSignatureNamespace(
  recordNamespace: string,
  allowedNamespaces: readonly string[],
): string {
  if (
    typeof recordNamespace === 'string' &&
    Array.isArray(allowedNamespaces) &&
    allowedNamespaces.includes(recordNamespace)
  ) {
    return recordNamespace;
  }
  throw new WorkflowNamespaceError(
    'WORKFLOW_SIGNATURE_NAMESPACE_UNSUPPORTED',
    'Signed record namespace is not allowlisted.',
  );
}
