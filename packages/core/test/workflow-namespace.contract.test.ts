import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WorkflowNamespaceError,
  assertAllowedSignatureNamespace,
  createWorkflowNamespaceConfig,
  createWorkflowRecordIdentity,
  workflowSchemaId,
} from '../src/workflow-namespace.ts';

test('new workflow records use a neutral schema and carry consumer namespace separately', () => {
  const config = createWorkflowNamespaceConfig({
    consumerNamespace: 'expense-app',
  });
  assert.deepEqual(config, {
    schemaVersion: 1,
    consumerNamespace: 'expense-app',
  });
  assert.deepEqual(createWorkflowRecordIdentity(config, 'task-result', 2), {
    schema: 'workflow.task-result.v2',
    consumerNamespace: 'expense-app',
  });
  assert.equal(workflowSchemaId('task-result', 2), 'workflow.task-result.v2');
});

test('workflow namespace configuration has no legacy schema admission surface', () => {
  const config = createWorkflowNamespaceConfig({
    consumerNamespace: 'expense-app',
  });
  assert.equal('acceptedLegacyPrefixes' in config, false);
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
