import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createProviderInvocationRequest,
  type ProviderOutputSchema,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  BLIND_SURVEY_OUTPUT_SCHEMA,
  providerOutputSchemaGeneration,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { isWorkflowError } from './fixture.ts';

test('provider output admission accepts only the exact current code-owned schema', () => {
  const current = createRequest(BLIND_SURVEY_OUTPUT_SCHEMA);
  assert.equal(providerOutputSchemaGeneration(current), 'code-owned');

  const unsupported: ProviderOutputSchema[] = [
    {
      ...BLIND_SURVEY_OUTPUT_SCHEMA,
      digest: 'a'.repeat(64),
    },
    {
      ...BLIND_SURVEY_OUTPUT_SCHEMA,
      version: BLIND_SURVEY_OUTPUT_SCHEMA.version + 1,
    },
    {
      id: 'foreign.provider-output',
      version: 1,
      digest: 'b'.repeat(64),
    },
  ];
  for (const outputSchema of unsupported) {
    assert.throws(
      () => providerOutputSchemaGeneration(createRequest(outputSchema)),
      (error) => isWorkflowError(error, 'PROVIDER_OUTPUT_SCHEMA_UNSUPPORTED'),
      JSON.stringify(outputSchema),
    );
  }
});

function createRequest(outputSchema: ProviderOutputSchema) {
  const targetDigest = '1'.repeat(64);
  return createProviderInvocationRequest({
    invocationId: 'invocation-output-schema-current',
    nonce: 'invocation-output-schema-current-nonce',
    purpose: 'survey',
    providerId: 'claude',
    roleAssignment: {
      role: 'blind-surveyor',
      providerId: 'claude',
      sessionId: 'provider-session-output-schema-current',
      targetDigest,
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
    },
    capabilityProfile: 'repository-read-only',
    repositoryId: 'fixture',
    baseCommit: '2'.repeat(40),
    baseTree: '3'.repeat(40),
    targetDigest,
    inputManifestDigest: '4'.repeat(64),
    authorizationNodeId: '5'.repeat(64),
    writeAllowedPaths: [],
    outputSchema,
    evaluatorVersion: 'blind-survey.v1',
    policyDigest: '6'.repeat(64),
    limits: { timeoutMs: 300_000, aggregateOutputBytes: 1_048_576 },
  });
}
