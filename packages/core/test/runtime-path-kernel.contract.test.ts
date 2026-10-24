import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  assertChangeId,
  assertInvestigationId,
  assertInvocationId,
  assertSessionId,
  assertTaskId,
} from '../src/workflow-identifiers.ts';
import { projectInvestigationRuntimePaths } from '../src/runtime-path-kernel.ts';

test('runtime path kernel preserves exact identifier grammar with caller-owned errors', () => {
  const invalid = new TypeError('fixture identifier invalid');
  const assertions = [
    [assertChangeId, 'demo-change', 'Demo-change'],
    [assertTaskId, '1.2', '1'],
    [assertSessionId, 'session-AbC-123', 'session_123'],
    [assertInvestigationId, 'investigation-AbC-123', 'investigation_123'],
    [assertInvocationId, 'invocation-AbC-123', 'invocation_123'],
  ] as const;

  for (const [assertIdentifier, valid, malformed] of assertions) {
    assert.equal(
      assertIdentifier(valid, () => invalid),
      valid,
    );
    assert.throws(
      () => assertIdentifier(malformed, () => invalid),
      (error) => error === invalid,
      malformed,
    );
  }
});

test('core projects investigation layout from the supplied canonical base without filesystem access', () => {
  const base = path.resolve('a-nonexistent-canonical-git-common-directory');
  const projected = projectInvestigationRuntimePaths(base, 'runtime');
  assert.deepEqual(projected, {
    base,
    root: path.join(base, 'runtime', 'investigations'),
    objects: path.join(base, 'runtime', 'investigations', 'objects', 'sha256'),
    refs: path.join(base, 'runtime', 'investigations', 'refs'),
    sessions: path.join(base, 'runtime', 'investigations', 'sessions'),
    invocations: path.join(base, 'runtime', 'investigations', 'invocations'),
    locks: path.join(base, 'runtime', 'investigations', 'locks'),
  });
});
