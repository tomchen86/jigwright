import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createGrantCoordinatorKernel,
  inspectPreparedGrantDescendants,
} from '../src/modules/authority/grant-coordinator.ts';
import { createGrantRecordStore } from '../src/modules/authority/grant-record-store.ts';
import { createFileGrantRecordStore } from '../src/runtime/lifecycle-ledgers/grant-store.ts';
import {
  createTransitionRegistry,
  type TransitionDefinition,
} from '../src/modules/authority/grant-transition-registry.ts';
import {
  parseGrantPolicyV2,
  codeOwnedApprovalModuleRegistry,
} from '../src/modules/authority/grant-policy.ts';
import type {
  GrantRequestInput,
  StateBinding,
} from '../src/modules/authority/grant-core.ts';
import { parseGrantRecord } from '../src/modules/authority/grant-records.ts';
import { createMemoryGrantRecordStore } from './support/memory-grant-record-store.ts';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';
import {
  CHALLENGE_ID,
  OPERATION_ID,
  NOW,
  policyInput,
  humanProof,
  digest,
} from './grant-coordinator-fixture.ts';

function setup(
  options: {
    loseOwnershipAt?: number;
    refuseAfterAuthentication?: boolean;
    crashAfterEffect?: boolean;
  } = {},
) {
  const events: string[] = [];
  const memory = createMemoryGrantRecordStore(events);
  let state: StateBinding = {
    kind: 'investigation-state',
    digest: digest('1'),
  };
  let applications = 0;
  let ownershipChecks = 0;
  let crash = options.crashAfterEffect ?? false;
  const failure = new Error('injected interruption');
  const definition: TransitionDefinition<Record<string, never>> = {
    transitionId: 'investigation.abort.v1',
    parameterSchemaDigest: digest('2'),
    consequenceDigest: digest('3'),
    resolutionKind: 'non-retry',
    allowedApprovalMethods: ['human-presence'],
    validateParameters(value) {
      assert.deepEqual(value, {});
      return {};
    },
    renderTrustedChoice() {
      return { title: 'Abort', consequences: ['Becomes terminal.'] };
    },
    observeState() {
      events.push('observe');
      return state;
    },
    async execute(context) {
      events.push(`execute:${context.recovered}`);
      assert.equal(context.operationId, OPERATION_ID);
      if (state.digest !== digest('9')) {
        applications += 1;
        state = { ...state, digest: digest('9') };
      }
      if (crash) {
        crash = false;
        throw failure;
      }
      return { outcome: 'completed', details: { terminal: true } };
    },
  };
  const ids = [CHALLENGE_ID, OPERATION_ID];
  const kernel = createGrantCoordinatorKernel({
    store: memory.store,
    registry: createTransitionRegistry([definition]),
    policy: parseGrantPolicyV2(policyInput(), {
      registry: codeOwnedApprovalModuleRegistry(),
    }),
    now() {
      events.push('clock');
      return new Date(NOW);
    },
    randomUUID() {
      events.push('random');
      return ids.shift()!;
    },
    openApprovalSession(presentation) {
      events.push('open');
      return {
        async collectDecision() {
          events.push('decision');
          return {
            choiceId: presentation.choices[0]!.choiceId,
            approvalMethod: 'human-presence',
            reasonCode: 'cannot-complete-review',
            reason: 'No reviewer input remains.',
            sessionNonce: 'nonce-55555555555555555555555555555555',
          };
        },
        async authenticate(subject) {
          events.push('authenticate');
          if (options.refuseAfterAuthentication)
            state = { ...state, digest: digest('8') };
          return [humanProof(subject.approvalSubjectDigest)];
        },
        async close() {
          events.push('close');
        },
      };
    },
    async withLifecycleOperation(_id, operation) {
      events.push('lock');
      try {
        return await operation(() => {
          events.push('owned');
          ownershipChecks += 1;
          if (ownershipChecks === options.loseOwnershipAt) throw failure;
        });
      } finally {
        events.push('unlock');
      }
    },
  });
  const request: GrantRequestInput = {
    sourceModuleId: 'investigation',
    failureCode: 'reviewer-terms-exhausted',
    facts: {},
    stateBinding: state,
    candidates: [
      {
        transitionId: definition.transitionId,
        parameters: {},
        allowedReasonCodes: ['cannot-complete-review'],
        reasonRequired: true,
        proposedReason: 'No reviewer input remains.',
      },
    ],
  };
  return {
    ...memory,
    events,
    kernel,
    request,
    failure,
    applications: () => applications,
  };
}

test('memory store runs the complete Grant protocol with lazy observations and exact lock/read order', async () => {
  const f = setup();
  assert.deepEqual(f.events, []);
  await f.kernel.requestGrant(f.request);
  assert.deepEqual(f.events, [
    'clock',
    'random',
    'initialize',
    'read',
    'create',
  ]);
  f.events.length = 0;
  const result = await f.kernel.resolveChallenge(CHALLENGE_ID);
  assert.equal(result.outcome, 'completed');
  assert.equal(f.applications(), 1);
  assert.deepEqual(f.events, [
    'accessible',
    'read',
    'open',
    'decision',
    'clock',
    'authenticate',
    'close',
    'lock',
    'owned',
    'accessible',
    'read',
    'observe',
    'owned',
    'random',
    'clock',
    'initialize',
    'accessible',
    'read',
    'replace:prepared',
    'owned',
    'owned',
    'execute:false',
    'owned',
    'observe',
    'clock',
    'accessible',
    'read',
    'replace:completed',
    'unlock',
  ]);
  assert.equal(
    parseGrantRecord(f.records.get(CHALLENGE_ID)!).state,
    'completed',
  );
});

test('changed state after authentication refuses before prepare in memory', async () => {
  const f = setup({ refuseAfterAuthentication: true });
  await f.kernel.requestGrant(f.request);
  f.events.length = 0;
  await assert.rejects(f.kernel.resolveChallenge(CHALLENGE_ID), {
    code: 'GRANT_STATE_CHANGED',
  });
  assert.equal(parseGrantRecord(f.records.get(CHALLENGE_ID)!).state, 'pending');
  assert.equal(f.applications(), 0);
  assert.deepEqual(f.events.slice(-6), [
    'lock',
    'owned',
    'accessible',
    'read',
    'observe',
    'unlock',
  ]);
  assert.equal(
    f.events.some((x) => x.startsWith('replace:')),
    false,
  );
});

test('lost lock stops before the under-lock read and before any prepare', async () => {
  const f = setup({ loseOwnershipAt: 1 });
  await f.kernel.requestGrant(f.request);
  f.events.length = 0;
  await assert.rejects(
    f.kernel.resolveChallenge(CHALLENGE_ID),
    (error) => error === f.failure,
  );
  assert.deepEqual(f.events.slice(f.events.indexOf('lock')), [
    'lock',
    'owned',
    'unlock',
  ]);
  assert.equal(parseGrantRecord(f.records.get(CHALLENGE_ID)!).state, 'pending');
});

test('lost lock after durable prepare leaves the exact operation recoverable', async () => {
  const f = setup({ loseOwnershipAt: 3 });
  await f.kernel.requestGrant(f.request);
  await assert.rejects(
    f.kernel.resolveChallenge(CHALLENGE_ID),
    (error) => error === f.failure,
  );
  const prepared = parseGrantRecord(f.records.get(CHALLENGE_ID)!);
  assert.equal(prepared.state, 'prepared');
  assert.equal(f.applications(), 0);
  f.events.length = 0;
  const result = await f.kernel.recoverChallenge(CHALLENGE_ID);
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(result.recovered, true);
  assert.equal(f.applications(), 1);
  assert.deepEqual(f.events, [
    'accessible',
    'read',
    'lock',
    'owned',
    'accessible',
    'read',
    'owned',
    'execute:true',
    'owned',
    'observe',
    'clock',
    'accessible',
    'read',
    'replace:completed',
    'unlock',
  ]);
});

test('memory recovery repeats an applied idempotent operation and terminal replay avoids a second lock', async () => {
  const f = setup({ crashAfterEffect: true });
  await f.kernel.requestGrant(f.request);
  await assert.rejects(
    f.kernel.resolveChallenge(CHALLENGE_ID),
    (error) => error === f.failure,
  );
  assert.equal(f.applications(), 1);
  const prepared = f.records.get(CHALLENGE_ID)!;
  assert.equal(parseGrantRecord(prepared).state, 'prepared');
  f.events.length = 0;
  await f.kernel.recoverChallenge(CHALLENGE_ID);
  assert.equal(f.applications(), 1);
  assert.equal(f.events.includes('authenticate'), false);
  assert.equal(f.events.includes('random'), false);
  f.events.length = 0;
  await f.kernel.recoverChallenge(CHALLENGE_ID);
  assert.deepEqual(f.events, ['accessible', 'read']);
});

test('record-store validation and required persistence failures keep their original observation phase', async () => {
  const f = setup();
  assert.throws(() => f.store.persistGrantChallenge({} as never), {
    code: 'GRANT_STORE_UNSAFE',
  });
  assert.deepEqual(f.events, ['initialize']);
  f.events.length = 0;
  assert.throws(() => f.store.readGrantRecord('invalid'), {
    code: 'GRANT_STORE_UNSAFE',
  });
  assert.deepEqual(f.events, []);
  await f.kernel.requestGrant(f.request);
  assert.equal(inspectPreparedGrantDescendants(f.store, CHALLENGE_ID), null);
  const exact = new Error('storage failure');
  const store = createGrantRecordStore({
    ...f.persistence,
    initialize() {
      throw exact;
    },
  });
  assert.throws(
    () => store.persistGrantChallenge({} as never),
    (error) => error === exact,
  );
  assert.equal(f.records.size, 1);
});

test('file store binding performs no eager filesystem access', () => {
  const store = createFileGrantRecordStore({
    root: '/nonexistent/grant-memory-boundary',
    records: '/nonexistent/grant-memory-boundary/records',
  });
  assert.throws(() => store.readGrantRecord(CHALLENGE_ID), {
    code: 'GRANT_STORE_UNSAFE',
  });
});

test('Grant coordinator and record owners have complete pure dependency closures', () => {
  for (const name of [
    'grant-coordinator',
    'grant-records',
    'grant-record-store',
  ]) {
    assertPureDependencyClosure(
      fileURLToPath(
        new URL(`../src/modules/authority/${name}.ts`, import.meta.url),
      ),
    );
  }
});
