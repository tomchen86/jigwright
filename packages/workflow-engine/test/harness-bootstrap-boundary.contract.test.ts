import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createHarnessBootstrapParentState,
  type HarnessBootstrapParentBindings,
} from '../src/application/control-plane/harness-bootstrap-parent-state.ts';
import { createHarnessBootstrapDependencies } from '../bootstrap/harness-bootstrap-production.ts';
import type { HarnessBootstrapParentObservation } from '../src/modules/authority/harness-bootstrap-parent-contract.ts';
import { workflowError, ExitCode } from '../src/foundation/errors/errors.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

function fixture() {
  const events: string[] = [];
  const observation: HarnessBootstrapParentObservation = {
    repository: {
      repositoryRoot: '/repo',
      repositoryRealPath: '/repo',
      gitCommonDirectory: '/repo/.git',
      branch: 'work/change-a',
      head: 'a'.repeat(40),
      tree: 'b'.repeat(40),
      statusEntries: [],
    },
    runtime: {
      root: '/state',
      locks: '/state/locks',
      operations: '/state/operations',
      sessions: '/state/sessions',
      reports: '/state/reports',
      taskRevisions: '/state/revisions',
    },
    candidates: [
      {
        sessionId: 'session-a',
        sessionPath: '/state/sessions/session-a.json',
        session: {
          schemaVersion: 1,
          sessionId: 'session-a',
          state: 'active',
          changeId: 'change-a',
          taskId: 'task-a',
          repositoryRoot: '/repo',
          gitCommonDirectory: '/repo/.git',
          branch: 'work/change-a',
          baseline: { head: 'a'.repeat(40), tree: 'b'.repeat(40) },
          artifacts: {},
          allowedPaths: [],
          requiredChecks: [],
          requiredCheckDigests: {},
          planningAssurance: null,
          createdAt: '2026-08-01T00:00:00.000Z',
          isolation: {
            schemaVersion: 1,
            routingRole: 'single',
            routingWorksetDigest: `sha256:${'c'.repeat(64)}`,
            concurrencyEnabled: false,
            worktreeDigest: `sha256:${'d'.repeat(64)}`,
            resources: [],
          },
        },
      },
    ],
  };
  const bindings: HarnessBootstrapParentBindings = {
    BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST: `sha256:${'f'.repeat(64)}`,
    observeParentSessions(cwd, changeId) {
      events.push('observe');
      assert.equal(cwd, '/repo');
      assert.equal(changeId, 'change-a');
      return observation;
    },
    observeParentBindingPath() {
      events.push('binding-path');
      return null;
    },
    readLocalEngineBinding() {
      events.push('read-binding');
      throw new Error('unexpected binding read');
    },
    readControlPlaneSupervisorState() {
      events.push('supervisor');
      throw workflowError(
        'CONTROL_PLANE_SUPERVISOR_NOT_FOUND',
        'missing supervisor',
        ExitCode.staleState,
      );
    },
    persistTrustedBootstrapSessionSnapshot(root, session) {
      events.push('snapshot');
      assert.equal(root, '/state/intervention-control');
      assert.equal(session, observation.candidates[0]!.session);
      return '/state/snapshot.json';
    },
  };
  const run = () =>
    createHarnessBootstrapParentState(
      bindings,
    ).resolveHarnessBootstrapParentState(
      '/repo',
      'change-a',
      '/state/intervention-control',
    );
  return { bindings, observation, events, run };
}

test('bootstrap and recovery canonical contracts have a complete pure value/type closure', () => {
  for (const name of [
    'authority/intervention-bootstrap-contract',
    'authority/harness-bootstrap-parent-contract',
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

test('parent admission rejects a stale baseline before querying bindings or persisting a snapshot', () => {
  const f = fixture();
  f.observation.candidates[0]!.session.baseline.head = 'e'.repeat(40);
  assert.throws(f.run, { code: 'HARNESS_BOOTSTRAP_PARENT_SESSION_STALE' });
  assert.deepEqual(f.events, ['observe']);
});

test('required in-memory parent services preserve supervisor absence and snapshot publication order', () => {
  const f = fixture();
  const result = f.run();
  assert.deepEqual(f.events, [
    'observe',
    'binding-path',
    'supervisor',
    'snapshot',
  ]);
  assert.equal(
    result.parent.engineBinding,
    f.bindings.BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
  );
  assert.equal(result.sessionSnapshotPath, '/state/snapshot.json');
  assert.equal(JSON.parse(result.pendingIntent).sessionId, 'session-a');
});

test('parent snapshot still publishes before a later policy serialization failure', () => {
  const f = fixture(),
    failure = new Error('policy observation failed');
  Object.defineProperty(
    f.observation.candidates[0]!.session,
    'planningAssurance',
    {
      get() {
        f.events.push('policy');
        throw failure;
      },
      enumerable: true,
    },
  );
  assert.throws(f.run, (error) => error === failure);
  assert.deepEqual(f.events, [
    'observe',
    'binding-path',
    'supervisor',
    'snapshot',
    'policy',
  ]);
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
