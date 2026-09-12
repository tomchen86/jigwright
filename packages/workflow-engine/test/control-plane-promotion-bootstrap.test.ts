import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createControlPlaneCandidateMaterial } from '../src/application/control-plane/control-plane-candidate-material.ts';
import type { ControlPlaneCandidateMaterialBindings } from '../src/application/control-plane/control-plane-promotion-producer.ts';
import { ExitCode } from '../src/foundation/errors/errors.ts';
import type { ControlPlanePromotionBootstrapObservations } from '../src/modules/authority/intervention-bootstrap-contract.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const digest = `sha256:${'a'.repeat(64)}` as const;

function fixture(historyExists = false) {
  const events: string[] = [];
  const history = { marker: 'verified-history' };
  const artifact = {
    kind: 'engine-artifact.v1' as const,
    sourceChangeId: 'built-in',
    sourceDigest: digest,
    executableDigest: digest,
    protocolVersion: 1,
    canReadSessionSchemas: ['current-v3'],
    writesSessionSchema: 'current-v3',
    policySchemaVersion: 1,
    smokeReportDigest: digest,
    artifactId: digest,
  };
  const observations: ControlPlanePromotionBootstrapObservations = {
    bootstrapInterventionStateRoot(common) {
      assert.equal(common, '/git');
      events.push('bootstrap-state-root');
      return '/state';
    },
    readInitialControlPlaneSupervisorAnchorEvidence(stateRoot, repositoryId) {
      assert.equal(stateRoot, '/state');
      assert.equal(repositoryId, 'repository');
      events.push('initial-evidence');
      return {
        repositoryId,
        activeTrustCommit: 'base',
        publishedRecordDigest: digest,
        supervisorRecordDigest: digest,
        generation: 1,
        activeArtifact: {
          artifactId: digest,
          executableDigest: digest,
          closureDigest: digest,
        },
        recordedAt: '2026-09-12T00:00:00.000Z',
      };
    },
    readBuiltInControlPlaneEngineArtifact(stateRoot) {
      assert.equal(stateRoot, '/state');
      events.push('built-in-artifact');
      return artifact;
    },
  };
  const bindings = {
    path,
    fs: {
      lstatSync(file: string) {
        events.push(`lstat:${file}`);
        return historyExists && file === '/history' ? {} : undefined;
      },
    },
    ExitCode,
    producerError(code: string, message: string) {
      return Object.assign(new Error(message), { code });
    },
    controlPlaneSupervisorHistoryDirectory() {
      events.push('history-path');
      return '/history';
    },
    readControlPlaneSupervisorHistory() {
      events.push('read-history');
      return history;
    },
    createControlPlaneSupervisorHistoryAnchor(input: {
      activeTrustCommit: string;
      authority: { initialBootstrapPublishedDigest: string };
    }) {
      assert.equal(input.activeTrustCommit, 'base');
      assert.equal(input.authority.initialBootstrapPublishedDigest, digest);
      events.push('create-anchor');
      return input;
    },
    appendControlPlaneSupervisorHistoryRecord() {
      events.push('append-anchor');
    },
  } as unknown as ControlPlaneCandidateMaterialBindings;
  const material = createControlPlaneCandidateMaterial(() => {
    events.push('bindings');
    return bindings;
  });
  const supervisor = {
    kind: 'control-plane-supervisor-state.v1' as const,
    repositoryId: 'repository',
    activeArtifact: {
      artifactId: digest,
      executableDigest: digest,
      closureDigest: digest,
      executablePath: '/engine',
    },
    generation: 1,
    transition: null,
    updatedAt: '2026-09-12T00:00:00.000Z',
    recordDigest: digest,
  };
  return { events, observations, material, supervisor, history, artifact };
}

test('promotion bootstrap contracts have a complete pure dependency closure', () => {
  assertPureDependencyClosure(
    fileURLToPath(
      new URL(
        '../src/modules/authority/intervention-bootstrap-contract.ts',
        import.meta.url,
      ),
    ),
  );
});

test('material construction is inert and observes the expected state root before the supplied path', () => {
  const f = fixture();
  assert.deepEqual(f.events, []);
  assert.throws(
    () => f.material.assertProducerStateRoot('/git', '/other', f.observations),
    { code: 'CONTROL_PLANE_PRODUCER_STATE_ROOT_MISMATCH' },
  );
  assert.deepEqual(f.events, [
    'bindings',
    'bootstrap-state-root',
    'lstat:/other',
  ]);
});

test('a successor without history refuses before initial evidence or built-in artifact observations', () => {
  const f = fixture();
  assert.throws(
    () =>
      f.material.ensureTerminalSupervisorHistory(
        '/state',
        { ...f.supervisor, generation: 2 },
        'base',
        f.observations,
      ),
    { code: 'CONTROL_PLANE_PRODUCER_HISTORY_REQUIRED' },
  );
  assert.deepEqual(f.events, ['bindings', 'history-path', 'lstat:/history']);
});

test('initial evidence is validated and persisted before reading history and the built-in artifact', () => {
  const f = fixture();
  const result = f.material.ensureTerminalSupervisorHistory(
    '/state',
    f.supervisor,
    'base',
    f.observations,
  );
  assert.equal(result.history, f.history);
  assert.equal(result.restartArtifact, f.artifact);
  assert.deepEqual(f.events, [
    'bindings',
    'history-path',
    'lstat:/history',
    'initial-evidence',
    'create-anchor',
    'append-anchor',
    'read-history',
    'built-in-artifact',
  ]);
});

test('existing initial history reads the built-in artifact without rereading initial bootstrap evidence', () => {
  const f = fixture(true);
  const result = f.material.ensureTerminalSupervisorHistory(
    '/state',
    f.supervisor,
    'base',
    f.observations,
  );
  assert.equal(result.history, f.history);
  assert.equal(result.restartArtifact, f.artifact);
  assert.deepEqual(f.events, [
    'bindings',
    'history-path',
    'lstat:/history',
    'read-history',
    'built-in-artifact',
  ]);
});
