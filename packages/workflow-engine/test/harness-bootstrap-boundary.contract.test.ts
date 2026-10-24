import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHarnessBootstrapDependencies } from '../bootstrap/harness-bootstrap-production.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';
test('bootstrap and recovery canonical contracts have a complete pure value/type closure', () => {
  for (const name of [
    'authority/intervention-bootstrap-contract',
    'authority/recovery-quarantine-contract',
    'authority/recovery-trust-root-contract',
    'lifecycle/workflow-session-contract',
    'repository-consumer/repository-git-state',
  ]) {
    assertPureDependencyClosure(
      fileURLToPath(new URL(`../src/modules/${name}.ts`, import.meta.url)),
    );
  }
});
test('bootstrap construction preserves lazy signer resolution and override identity', () => {
  const lazy = createHarnessBootstrapDependencies(
    '/nonexistent-bootstrap-repository',
  );
  assert.equal(typeof lazy.maintenanceSigner?.sign, 'function');
  const events: string[] = [];
  const now = () => new Date('2026-08-01T00:00:00.000Z');
  const dependencies = createHarnessBootstrapDependencies(
    '/nonexistent-bootstrap-repository',
    {
      now,
      maintenanceSigner: {
        assertHumanPresent() {
          events.push('presence');
        },
        identity() {
          events.push('identity');
          return 'signer-a';
        },
        sign(payload, namespace) {
          events.push(`sign:${payload}:${namespace}`);
          return 'signature';
        },
        verify() {
          events.push('verify');
        },
      },
    },
  );
  assert.equal(dependencies.now, now);
  assert.deepEqual(events, []);
  assert.equal(dependencies.maintenanceSigner!.identity(), 'signer-a');
  assert.equal(
    dependencies.maintenanceSigner!.sign('payload', 'namespace'),
    'signature',
  );
  assert.deepEqual(events, ['identity', 'sign:payload:namespace']);
});
