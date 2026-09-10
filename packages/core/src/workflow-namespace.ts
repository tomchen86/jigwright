/**
 * Validates consumer namespaces, versioned schema identities and signature
 * namespace selection.
 *
 * Invariants:
 * - A signature namespace is accepted only when it appears in the
 *   caller-supplied allowlist.
 */
const CONSUMER_NAMESPACE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const SCHEMA_KIND = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

export type WorkflowNamespaceErrorCode =
  | 'WORKFLOW_NAMESPACE_CONFIG_INVALID'
  | 'WORKFLOW_SCHEMA_ID_INVALID'
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
}>;

export type WorkflowRecordIdentity = Readonly<{
  schema: string;
  consumerNamespace: string;
}>;

export function createWorkflowNamespaceConfig(input: {
  consumerNamespace: string;
}): WorkflowNamespaceConfig {
  if (!CONSUMER_NAMESPACE.test(input.consumerNamespace)) {
    throw new WorkflowNamespaceError(
      'WORKFLOW_NAMESPACE_CONFIG_INVALID',
      'Workflow namespace configuration is invalid.',
    );
  }

  return Object.freeze({
    schemaVersion: 1,
    consumerNamespace: input.consumerNamespace,
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
