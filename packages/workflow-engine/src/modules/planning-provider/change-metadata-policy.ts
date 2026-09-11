/** Parse canonical schema metadata text under the supplied consumer policy. */
import type { RepositoryConsumerConfigurationV1 } from '@jigwright/core/repository-consumer-port';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
export function parseChangeMetadataText(
  text: string,
  policy: RepositoryConsumerConfigurationV1['planning'],
): string {
  if (text.startsWith('\uFEFF') || text.includes('\0') || text.includes('\r')) {
    throw invalidMetadata();
  }
  const singleSchema = /^schema: ([a-z0-9]+(?:-[a-z0-9]+)*)\n$/.exec(text)?.[1];
  if (
    singleSchema !== undefined &&
    policy.packageSchemaNames.includes(singleSchema) &&
    policy.supportedSchemaNames.includes(singleSchema)
  ) {
    return singleSchema;
  }
  const lines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : [];
  const fields = new Map<string, string>();
  for (const line of lines) {
    const match = /^([a-z][a-z0-9-]*): ([^\s].*)$/.exec(line);
    if (!match || fields.has(match[1])) {
      throw invalidMetadata();
    }
    fields.set(match[1], match[2]);
  }
  if (
    fields.size !== 2 ||
    !fields.has('schema') ||
    !fields.has('created') ||
    !isCanonicalDate(fields.get('created') ?? '')
  ) {
    throw invalidMetadata();
  }
  const schemaName = fields.get('schema');
  if (
    schemaName === undefined ||
    !policy.managedSchemaNames.includes(schemaName) ||
    !policy.supportedSchemaNames.includes(schemaName)
  ) {
    throw workflowError(
      'OPENSPEC_MANAGED_SCHEMA_REQUIRED',
      'Managed changes must declare a reviewed consumer schema.',
      ExitCode.verification,
    );
  }
  return schemaName;
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(milliseconds) &&
    new Date(milliseconds).toISOString().slice(0, 10) === value
  );
}

export function invalidMetadata() {
  return workflowError(
    'OPENSPEC_CHANGE_METADATA_INVALID',
    'Managed change metadata must contain one reviewed schema and canonical created date.',
    ExitCode.guard,
  );
}
