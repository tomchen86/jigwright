import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { BuiltInProviderFamily } from '@jigwright/core/built-in-provider-catalog';
import {
  resolveActorIdentity,
  type ActorAssurance,
  type ActorResolution,
  type ActorResolutionInput,
  type ActorSignal,
  type ResolvedActor,
} from '../src/modules/authority/actor-identity.ts';
import type { CollaborationAvailableActor } from '../src/modules/authority/collaboration-grant-codec.ts';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const sharedContracts: [
  Equal<
    ActorAssurance,
    Extract<CollaborationAvailableActor, { kind: 'provider' }>['assurance']
  >,
  Equal<
    ResolvedActor,
    { providerId: BuiltInProviderFamily; assurance: ActorAssurance }
  >,
] = [true, true];
// @ts-expect-error A resolved identity must retain its full observed signals.
const incomplete: ActorResolution = {
  outcome: 'resolved',
  actor: { providerId: 'codex', assurance: 'self-declared' },
};
void incomplete;

test('actor authority preserves observation order, complete contracts and honest mutable results', () => {
  assert.deepEqual(sharedContracts, [true, true]);
  const observed: string[] = [];
  const hints: Record<string, string> = {
    AGENT: 'codex',
    CLAUDECODE: '0',
    CLAUDE_CODE_ENTRYPOINT: '',
    CODEX_SANDBOX: 'active',
  };
  const environment = new Proxy(hints, {
    get(target, key: string) {
      observed.push(key);
      return target[key];
    },
  });
  const input: ActorResolutionInput = {
    get explicitActor() {
      observed.push('explicitActor');
      return 'codex';
    },
    get environment() {
      observed.push('environment');
      return environment;
    },
  };
  const result = resolveActorIdentity(input);
  assert.deepEqual(observed, [
    'explicitActor',
    'explicitActor',
    'explicitActor',
    'environment',
    'AGENT',
    'environment',
    'CLAUDECODE',
    'environment',
    'CLAUDE_CODE_ENTRYPOINT',
    'environment',
    'CODEX_SANDBOX',
  ]);
  const explicit: ActorSignal = {
    source: 'explicit',
    name: '--actor',
    providerId: 'codex',
    assurance: 'self-declared',
  };
  assert.deepEqual(result, {
    outcome: 'resolved',
    actor: { providerId: 'codex', assurance: 'runtime-hint' },
    signals: [
      explicit,
      {
        source: 'runtime-hint',
        name: 'AGENT',
        providerId: 'codex',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CODEX_SANDBOX',
        providerId: 'codex',
        assurance: 'runtime-hint',
      },
    ],
  });
  assert.equal(Object.isFrozen(result), false);
  assert.equal(Object.isFrozen(result.signals), false);
  result.signals.push(explicit);
  assert.equal(resolveActorIdentity(input).signals.length, 3);
  observed.length = 0;
  hints.AGENT = 'claude';
  hints.CLAUDECODE = '1';
  hints.CLAUDE_CODE_ENTRYPOINT = 'cli';
  const conflict = resolveActorIdentity(input);
  assert.equal(conflict.outcome, 'actor-resolution-required');
  assert.equal('actor' in conflict, false);
  assert.deepEqual(
    conflict.signals.map((signal) => signal.name),
    [
      '--actor',
      'AGENT',
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CODEX_SANDBOX',
    ],
  );
  assert.equal(observed.at(-1), 'CODEX_SANDBOX');
  assert.deepEqual(resolveActorIdentity({ environment: {} }), {
    outcome: 'actor-resolution-required',
    code: 'ACTOR_IDENTITY_REQUIRED',
    signals: [],
  });
  assert.deepEqual(
    resolveActorIdentity({ explicitActor: 'codex', environment: {} }),
    {
      outcome: 'resolved',
      actor: { providerId: 'codex', assurance: 'self-declared' },
      signals: [explicit],
    },
  );
  assert.throws(
    () =>
      resolveActorIdentity({
        explicitActor: 'unknown',
        get environment() {
          return assert.fail(
            'Invalid explicit identity must fail before hints.',
          );
        },
      }),
    {
      code: 'ACTOR_PROVIDER_UNKNOWN',
      message: 'Explicit actor "unknown" is not a registered provider.',
    },
  );
});

test('actor and Grant authority reject provider value or type backedges without a retired facade', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const reader = readRepositoryDependencies(root);
  const provider =
    'packages/workflow-engine/src/modules/provider-orchestration/';
  const authority = 'packages/workflow-engine/src/modules/authority/';
  assert.equal(
    fs.existsSync(path.join(root, provider, 'actor-identity.ts')),
    false,
  );
  const actor = reader.read(path.join(root, authority, 'actor-identity.ts'));
  assert.ok(
    actor.edges.some(
      (edge) =>
        edge.to === 'packages/core/src/built-in-provider-catalog.ts' &&
        edge.loadsModule,
    ),
  );
  assert.equal(
    reader.read(path.join(root, provider, 'role-independence.ts')).edges.length,
    0,
  );
  for (const name of [
    'actor-identity',
    'collaboration-grant-codec',
    'collaboration-grant-records',
    'collaboration-grant-use',
  ]) {
    const file = path.join(root, authority, name + '.ts');
    const assertOwner = (additionalSource = '') => {
      assert.ok(
        !reader
          .read(file, additionalSource)
          .edges.some((edge) => edge.to.startsWith(provider)),
        'Authority depends on provider orchestration.',
      );
    };
    assertOwner();
    for (const source of [
      "\nimport { isProviderId as forbidden } from '../provider-orchestration/provider-registry.ts';",
      "\nimport type { IndependenceDimension as Forbidden } from '../provider-orchestration/role-independence.ts';",
    ])
      assert.throws(() => assertOwner(source), /Authority depends on provider/);
  }
});
