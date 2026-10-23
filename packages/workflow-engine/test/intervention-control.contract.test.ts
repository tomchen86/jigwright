import {
  HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
  validateWorkflowSupersedeReason,
} from '../src/modules/authority/intervention-control.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

test('maintenance signature namespace uses the Jigwright product identity', () => {
  assert.equal(
    HARNESS_MAINTENANCE_SIGNATURE_NAMESPACE,
    'jigwright.harness-maintenance-grant.v1',
  );
});

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

test('supersede rejects execution failures', () => {
  assert.deepEqual(validateWorkflowSupersedeReason('workflow-replaced'), {
    allowed: true,
    reason: 'workflow-replaced',
  });
  assert.throws(
    () => validateWorkflowSupersedeReason('provider-timeout'),
    hasCode('SUPERSEDE_EXECUTION_FAILURE_FORBIDDEN'),
  );
  assert.throws(
    () => validateWorkflowSupersedeReason('contract-or-baseline-change'),
    hasCode('SUPERSEDE_REQUIRES_EPOCH_ROLLOVER'),
  );
  assert.throws(
    () => validateWorkflowSupersedeReason('mystery-reason'),
    hasCode('SUPERSEDE_REASON_UNSUPPORTED'),
  );
});
