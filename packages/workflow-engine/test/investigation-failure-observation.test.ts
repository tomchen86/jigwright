import assert from 'node:assert/strict';
import test from 'node:test';
import { createInvestigationV3FailureObservations } from '../src/runtime/repository-observation/investigation-v3-failure-source.ts';
import { createInvestigationV3Blocker } from '../src/modules/investigation/manifest/investigation-manifest.ts';
import {
  investigationV3DirectFailureSource,
  type InvestigationV3FailureObservations,
  type InvestigationV3FailureIdentity,
} from '../src/modules/investigation/seal/investigation-v3-failure-source.ts';
import {
  createInvestigationV3GrantRequest,
  investigationV3GrantTransitionDefinitions,
} from '../src/modules/investigation/seal/investigation-v3-grant.ts';
import {
  WorkflowError,
  ExitCode,
  workflowError,
} from '../src/foundation/errors/errors.ts';

function identity(): InvestigationV3FailureIdentity {
  return {
    repositoryId: 'fixture',
    changeId: 'sample-change',
    investigationId: 'investigation-example',
    sessionRevision: 1,
    sessionSnapshotDigest: 'a'.repeat(64),
    blocker: createInvestigationV3Blocker({
      attemptedTransition: 'build-draft',
      candidate: {},
      failureCode: 'REPLAY_INPUT_MISSING',
      message: 'Fixture failure',
    }),
  };
}
function source() {
  return investigationV3DirectFailureSource({
    schemaVersion: 1,
    sessionSnapshotDigest: 'a'.repeat(64),
    currentRefDigest: `sha256:${'b'.repeat(64)}`,
    effectiveState: 'awaiting-main-terms',
    lifecycleStateDigest: `sha256:${'c'.repeat(64)}`,
    gitStateDigest: `sha256:${'d'.repeat(64)}`,
  });
}

test('initial failure observation and direct capture preserve fail-closed errors; transition reobservation records unavailability', () => {
  const observedIdentity = identity(),
    failure = workflowError(
      'FIXTURE_CONTEXT_UNAVAILABLE',
      'context absent',
      ExitCode.guard,
    );
  let calls = 0;
  const observations = createInvestigationV3FailureObservations(() => {
    calls++;
    throw failure;
  });
  assert.throws(
    () =>
      observations.initialInvestigationV3FailureSourceObservation({
        cwd: '/absent',
        identity: observedIdentity,
        source: source(),
      }),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED' &&
      error.message.includes('before the central challenge') &&
      error.message.includes('FIXTURE_CONTEXT_UNAVAILABLE'),
  );
  assert.throws(
    () =>
      observations.captureInvestigationV3DirectFailureEmission({
        cwd: '/absent',
        identity: observedIdentity,
      }),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'INVESTIGATION_V3_FAILURE_SOURCE_CHANGED' &&
      error.message.includes('at emission') &&
      error.message.includes('FIXTURE_CONTEXT_UNAVAILABLE'),
  );
  const unavailable = observations.observeInvestigationV3FailureSource({
    cwd: '/absent',
    expectedIdentity: observedIdentity,
    source: source(),
  });
  assert.deepEqual(unavailable.identity, observedIdentity);
  assert.equal(unavailable.publicationRecoveryKind, null);
  assert.match(unavailable.sourceStateDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(
    calls,
    3,
    'every operation must observe afresh rather than reuse or cache context',
  );
});

test('Grant observes source before challenge construction and rechecks repository identity separately on each authority observation', () => {
  const failure = identity(),
    direct = source();
  if (direct.observerId !== 'investigation-v3.direct-failure.v1')
    assert.fail('direct source');
  const events: string[] = [];
  let repositoryId = 'fixture';
  const observations: InvestigationV3FailureObservations = {
    readRepositoryId(cwd) {
      events.push(`repository:${cwd}`);
      return repositoryId;
    },
    initialInvestigationV3FailureSourceObservation(input) {
      events.push('initial');
      assert.deepEqual(input.identity, failure);
      return {
        identity: failure,
        sourceStateDigest: `sha256:${'e'.repeat(64)}`,
        publicationRecoveryKind: null,
      };
    },
    observeInvestigationV3FailureSource(input) {
      events.push('source');
      assert.deepEqual(input.expectedIdentity, failure);
      return {
        identity: failure,
        sourceStateDigest: `sha256:${'e'.repeat(64)}`,
        publicationRecoveryKind: null,
      };
    },
    captureInvestigationV3DirectFailureEmission() {
      assert.fail('Grant does not capture a replacement emission');
    },
  };
  const request = createInvestigationV3GrantRequest(observations, {
    cwd: '/fixture',
    failure,
    emission: direct.emission,
    proposedReason: 'preserve authority',
  });
  assert.deepEqual(events, ['initial']);
  const transition = investigationV3GrantTransitionDefinitions(
    observations,
    '/fixture',
  )[0];
  const parameters = transition.validateParameters(
    request.candidates[0]!.parameters,
  );
  transition.observeState(parameters);
  transition.observeState(parameters);
  assert.deepEqual(events, [
    'initial',
    'repository:/fixture',
    'source',
    'repository:/fixture',
    'source',
  ]);
  repositoryId = 'different';
  assert.throws(
    () => transition.observeState(parameters),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'INVESTIGATION_V3_GRANT_REPOSITORY_MISMATCH',
  );
  assert.deepEqual(
    events.slice(-2),
    ['source', 'repository:/fixture'],
    'repository mismatch must precede source observation',
  );
});
