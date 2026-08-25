import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WorkflowNamespaceError,
  assertAllowedSignatureNamespace,
  createWorkflowNamespaceConfig,
  createWorkflowRecordIdentity,
  selectWorkflowRecordSchema,
  workflowSchemaId,
} from '../src/workflow-namespace.ts';

test('new workflow records use a neutral schema and carry consumer namespace separately', () => {
  const config = createWorkflowNamespaceConfig({
    consumerNamespace: 'expense-app',
    acceptedLegacyPrefixes: ['expense-app.workflow.'],
  });
  assert.deepEqual(createWorkflowRecordIdentity(config, 'task-result', 2), {
    schema: 'workflow.task-result.v2',
    consumerNamespace: 'expense-app',
  });
  assert.equal(workflowSchemaId('task-result', 2), 'workflow.task-result.v2');
});

test('legacy record schemas are exact-read compatibility and unknown versions fail closed', () => {
  const config = createWorkflowNamespaceConfig({
    consumerNamespace: 'expense-app',
    acceptedLegacyPrefixes: ['expense-app.workflow.'],
  });
  assert.deepEqual(
    selectWorkflowRecordSchema(
      'expense-app.workflow.task-result.v1',
      workflowSchemaId('task-result', 2),
      ['expense-app.workflow.task-result.v1'],
      config,
    ),
    {
      schema: 'expense-app.workflow.task-result.v1',
      generation: 'legacy',
    },
  );
  assert.throws(
    () =>
      selectWorkflowRecordSchema(
        'expense-app.workflow.task-result.v3',
        workflowSchemaId('task-result', 2),
        ['expense-app.workflow.task-result.v1'],
        config,
      ),
    (error: unknown) =>
      error instanceof WorkflowNamespaceError &&
      error.code === 'WORKFLOW_SCHEMA_NAMESPACE_UNSUPPORTED',
  );
});

test('signed history verifies only under its record-owned allowlisted namespace', () => {
  const seen: string[] = [];
  const selected = assertAllowedSignatureNamespace(
    'expense-app.workflow.maintainer-grant.v1',
    [
      'expense-app.workflow.maintainer-grant.v1',
      'workflow.maintainer-grant.v2',
    ],
  );
  seen.push(selected);
  assert.deepEqual(seen, ['expense-app.workflow.maintainer-grant.v1']);
  assert.throws(
    () =>
      assertAllowedSignatureNamespace('workflow.maintainer-grant.v3', [
        'expense-app.workflow.maintainer-grant.v1',
        'workflow.maintainer-grant.v2',
      ]),
    (error: unknown) =>
      error instanceof WorkflowNamespaceError &&
      error.code === 'WORKFLOW_SIGNATURE_NAMESPACE_UNSUPPORTED',
  );
});
