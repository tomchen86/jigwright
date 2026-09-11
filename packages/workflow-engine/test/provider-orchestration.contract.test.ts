/** Provider registry, actor identity, independence, and ordinary role selection contracts. */
import test from 'node:test';
import {
  listBuiltInProviders,
  requireProviderCapability,
} from '../src/modules/provider-orchestration/provider-registry.ts';
import assert from 'node:assert/strict';
import {listBuiltInProviderFamilies, listBuiltInProviderCapabilityDescriptors} from '@jigwright/core/built-in-provider-definition';
import fs from 'node:fs';
import { resolveActorIdentity } from '../src/modules/provider-orchestration/actor-identity.ts';
import {
  assessRoleIndependence,
  scheduleOrdinaryRole,
} from '../src/modules/provider-orchestration/role-assignment.ts';
import { createProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  isWorkflowError,
  participant,
  DIGESTS,
  requestInput,
} from './provider-orchestration-fixture.ts';

test('built-in provider registry is exact, immutable, and capability-scoped', () => {
  const providers = listBuiltInProviders();

  assert.deepEqual(providers, [
    {
      id: 'codex',
      capabilities: [
        {
          purpose: 'survey',
          profile: 'repository-read-only',
        },
        {
          purpose: 'plan-review',
          profile: 'repository-read-only',
        },
        {
          purpose: 'task-implementation',
          profile: 'repository-read-only',
        },
        {
          purpose: 'task-diff-review',
          profile: 'repository-read-only',
        },
      ],
    },
    {
      id: 'claude',
      capabilities: [
        {
          purpose: 'survey',
          profile: 'repository-read-only',
        },
        {
          purpose: 'plan-review',
          profile: 'repository-read-only',
        },
        {
          purpose: 'task-implementation',
          profile: 'repository-read-only',
        },
        {
          purpose: 'task-diff-review',
          profile: 'repository-read-only',
        },
      ],
    },
  ]);
  assert.equal(Object.isFrozen(providers), true);
  assert.equal(Object.isFrozen(providers[0]), true);
  assert.equal(Object.isFrozen(providers[0]?.capabilities), true);
  assert.equal(Object.isFrozen(providers[0]?.capabilities[0]), true);
  assert.strictEqual(listBuiltInProviders(), providers);
  assert.deepEqual(
    providers.map(({ id }) => id),
    listBuiltInProviderFamilies(),
  );
  assert.deepEqual(
    providers,
    listBuiltInProviderCapabilityDescriptors().map(
      ({ providerFamily: id, capabilities }) => ({ id, capabilities }),
    ),
  );

  const registrySource = fs.readFileSync(
    new URL(
      '../src/modules/provider-orchestration/provider-registry.ts',
      import.meta.url,
    ),
    'utf8',
  );
  assert.match(
    registrySource,
    /from '@jigwright\/core\/built-in-provider-catalog';/u,
  );
  assert.doesNotMatch(
    registrySource,
    /export type ProviderId\s*=\s*['"]codex['"]\s*\|\s*['"]claude['"]/u,
  );
  assert.doesNotMatch(
    registrySource,
    /\[\s*['"]codex['"]\s*,\s*['"]claude['"]\s*\]/u,
  );
  assert.doesNotMatch(registrySource, /function readOnlyCapabilities\(/u);
  assert.doesNotMatch(
    registrySource,
    /export type CapabilityPurpose\s*=\s*['"]survey['"]/u,
  );

  assert.equal(
    requireProviderCapability('claude', 'plan-review', 'repository-read-only')
      .id,
    'claude',
  );
  assert.throws(
    () =>
      requireProviderCapability(
        'unknown' as 'codex',
        'survey',
        'repository-read-only',
      ),
    (error) => isWorkflowError(error, 'PROVIDER_UNKNOWN'),
  );
  assert.throws(
    () =>
      requireProviderCapability(
        'codex',
        'implementation' as 'survey',
        'repository-read-only',
      ),
    (error) => isWorkflowError(error, 'PROVIDER_CAPABILITY_UNSUPPORTED'),
  );
});

test('actor resolution preserves all agreeing soft signals and their grade', () => {
  const hinted = resolveActorIdentity({ environment: { CLAUDECODE: '1' } });
  assert.equal(hinted.outcome, 'resolved');
  if (hinted.outcome !== 'resolved') assert.fail('expected runtime hint');
  assert.deepEqual(hinted.actor, {
    providerId: 'claude',
    assurance: 'runtime-hint',
  });

  const result = resolveActorIdentity({
    explicitActor: 'claude',
    environment: {
      AGENT: 'claude',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      PATH: '/tmp/fake-provider-bin',
    },
  });

  assert.deepEqual(result, {
    outcome: 'resolved',
    actor: {
      providerId: 'claude',
      assurance: 'runtime-hint',
    },
    signals: [
      {
        source: 'explicit',
        name: '--actor',
        providerId: 'claude',
        assurance: 'self-declared',
      },
      {
        source: 'runtime-hint',
        name: 'AGENT',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDECODE',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDE_CODE_ENTRYPOINT',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
    ],
  });
  assert.equal(
    JSON.stringify(result).includes('/tmp/fake-provider-bin'),
    false,
  );
});

test('actor resolution distinguishes explicit-only, missing, and conflicts', () => {
  assert.deepEqual(
    resolveActorIdentity({
      explicitActor: 'codex',
      environment: {},
    }),
    {
      outcome: 'resolved',
      actor: {
        providerId: 'codex',
        assurance: 'self-declared',
      },
      signals: [
        {
          source: 'explicit',
          name: '--actor',
          providerId: 'codex',
          assurance: 'self-declared',
        },
      ],
    },
  );
  assert.deepEqual(
    resolveActorIdentity({
      environment: {
        AGENT: 'unknown-agent',
        CLAUDECODE: '0',
        CLAUDE_CODE_ENTRYPOINT: '',
        CODEX_SANDBOX: '',
      },
    }),
    {
      outcome: 'actor-resolution-required',
      code: 'ACTOR_IDENTITY_REQUIRED',
      signals: [],
    },
  );

  const conflict = resolveActorIdentity({
    explicitActor: 'codex',
    environment: {
      CLAUDECODE: '1',
      CODEX_SANDBOX: 'seatbelt',
    },
  });
  assert.deepEqual(conflict, {
    outcome: 'actor-resolution-required',
    code: 'ACTOR_IDENTITY_CONFLICT',
    signals: [
      {
        source: 'explicit',
        name: '--actor',
        providerId: 'codex',
        assurance: 'self-declared',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDECODE',
        providerId: 'claude',
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
  assert.equal('actor' in conflict, false);

  const runtimeConflict = resolveActorIdentity({
    environment: {
      AGENT: 'codex',
      CLAUDECODE: '1',
    },
  });
  assert.deepEqual(runtimeConflict, {
    outcome: 'actor-resolution-required',
    code: 'ACTOR_IDENTITY_CONFLICT',
    signals: [
      {
        source: 'runtime-hint',
        name: 'AGENT',
        providerId: 'codex',
        assurance: 'runtime-hint',
      },
      {
        source: 'runtime-hint',
        name: 'CLAUDECODE',
        providerId: 'claude',
        assurance: 'runtime-hint',
      },
    ],
  });
  assert.equal('actor' in runtimeConflict, false);

  assert.throws(
    () =>
      resolveActorIdentity({
        explicitActor: 'unregistered',
        environment: {},
      }),
    (error) => isWorkflowError(error, 'ACTOR_PROVIDER_UNKNOWN'),
  );
});

test('role independence keeps provider, session, and principal dimensions separate', () => {
  const author = participant({
    providerId: 'codex',
    sessionId: 'author-session',
    principalId: 'principal-a',
  });

  assert.deepEqual(
    assessRoleIndependence(
      author,
      participant({
        providerId: 'codex',
        sessionId: 'fresh-session',
        principalId: 'principal-b',
      }),
    ),
    {
      principalIndependent: true,
      providerIndependent: false,
      sessionIndependent: true,
      achievedIndependence: 'principal-independent',
    },
  );
  assert.deepEqual(
    assessRoleIndependence(
      author,
      participant({
        providerId: 'claude',
        sessionId: 'author-session',
        principalId: 'principal-a',
      }),
    ),
    {
      principalIndependent: false,
      providerIndependent: true,
      sessionIndependent: false,
      achievedIndependence: 'provider-independent',
    },
  );
  assert.deepEqual(
    assessRoleIndependence(author, {
      providerId: undefined,
      sessionId: undefined,
      principalId: undefined,
      identityAssurance: 'self-declared',
      engineSpawned: false,
    }),
    {
      principalIndependent: null,
      providerIndependent: false,
      sessionIndependent: false,
      achievedIndependence: 'none',
    },
  );
  assert.deepEqual(
    assessRoleIndependence(
      {
        providerId: undefined,
        sessionId: undefined,
        principalId: undefined,
        identityAssurance: 'self-declared',
        engineSpawned: false,
      },
      participant({
        providerId: 'claude',
        sessionId: 'adapter-session',
        identityAssurance: 'adapter-assigned',
      }),
    ),
    {
      principalIndependent: null,
      providerIndependent: false,
      sessionIndependent: false,
      achievedIndependence: 'none',
    },
  );
});

test('ordinary role scheduling uses fresh sessions and preserves explicit provider diversity', () => {
  const author = participant({
    providerId: 'codex',
    sessionId: 'author-session',
  });
  for (const requestedIndependence of [
    'principal-independent',
    'none',
  ] as const) {
    assert.throws(
      () =>
        scheduleOrdinaryRole({
          role: 'plan-reviewer',
          author,
          targetDigest: DIGESTS.target,
          requestedIndependence,
          candidates: [],
        }),
      (error) => isWorkflowError(error, 'ROLE_INDEPENDENCE_DOWNGRADE'),
    );
  }
  const scheduled = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    author,
    targetDigest: DIGESTS.target,
    candidates: [
      {
        providerId: 'codex',
        sessionId: 'codex-survey',
        enabled: true,
        available: true,
      },
      {
        providerId: 'claude',
        sessionId: 'claude-survey',
        enabled: true,
        available: true,
      },
    ],
  });
  assert.equal(scheduled.outcome, 'assigned');
  if (scheduled.outcome !== 'assigned') {
    assert.fail('expected an assigned alternate provider');
  }
  assert.equal(scheduled.assignment.providerId, 'codex');
  assert.equal(
    scheduled.assignment.requiredIndependence,
    'session-independent',
  );
  assert.equal(
    scheduled.assignment.achievedIndependence,
    'session-independent',
  );

  const providerDiverse = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    author,
    targetDigest: DIGESTS.target,
    requestedIndependence: 'provider-independent',
    candidates: [
      {
        providerId: 'codex',
        sessionId: 'codex-survey',
        enabled: true,
        available: true,
      },
      {
        providerId: 'claude',
        sessionId: 'claude-survey',
        enabled: true,
        available: true,
      },
    ],
  });
  assert.equal(providerDiverse.outcome, 'assigned');
  if (providerDiverse.outcome !== 'assigned') {
    assert.fail('expected an explicitly provider-diverse assignment');
  }
  assert.equal(providerDiverse.assignment.providerId, 'claude');
  assert.equal(
    providerDiverse.assignment.achievedIndependence,
    'provider-independent',
  );
  const unavailableCandidates = [
    {
      providerId: 'codex' as const,
      sessionId: 'codex-survey',
      enabled: true,
      available: true,
    },
    {
      providerId: 'claude' as const,
      sessionId: 'claude-survey',
      enabled: true,
      available: false,
    },
  ];
  const waitingRequest = {
    role: 'plan-reviewer' as const,
    author,
    targetDigest: DIGESTS.target,
    requestedIndependence: 'provider-independent' as const,
    candidates: unavailableCandidates,
  };
  assert.deepEqual(scheduleOrdinaryRole(waitingRequest), {
    outcome: 'collaboration-grant-required',
    role: 'plan-reviewer',
    requiredIndependence: 'provider-independent',
    reason: 'NO_REQUIRED_INDEPENDENCE_CANDIDATE',
  });
  unavailableCandidates[1]!.available = true;
  assert.deepEqual(scheduleOrdinaryRole(waitingRequest), providerDiverse);

  const sameProviderReviewer = scheduleOrdinaryRole({
    role: 'plan-reviewer',
    purpose: 'survey',
    author,
    targetDigest: DIGESTS.target,
    candidates: [
      {
        providerId: 'codex',
        sessionId: 'fresh-codex-review',
        enabled: true,
        available: true,
      },
      {
        providerId: 'claude',
        sessionId: 'claude-review',
        enabled: false,
        available: true,
      },
    ],
  });
  assert.equal(sameProviderReviewer.outcome, 'assigned');
  if (sameProviderReviewer.outcome !== 'assigned') {
    assert.fail('expected a fresh Reviewer session assignment');
  }
  assert.deepEqual(sameProviderReviewer.assignment, {
    role: 'plan-reviewer',
    providerId: 'codex',
    sessionId: 'fresh-codex-review',
    targetDigest: DIGESTS.target,
    requiredIndependence: 'session-independent',
    achievedIndependence: 'session-independent',
  });
  const preAnchorRequest = createProviderInvocationRequest({
    ...requestInput(sameProviderReviewer.assignment),
    purpose: 'survey',
  });
  assert.equal(preAnchorRequest.roleAssignment.role, 'plan-reviewer');
  assert.equal(preAnchorRequest.purpose, 'survey');
  assert.deepEqual(
    scheduleOrdinaryRole({
      role: 'plan-reviewer',
      author,
      targetDigest: DIGESTS.target,
      candidates: [
        {
          providerId: 'claude',
          sessionId: 'unavailable-claude-survey',
          enabled: true,
          available: false,
        },
      ],
    }),
    {
      outcome: 'collaboration-grant-required',
      role: 'plan-reviewer',
      requiredIndependence: 'session-independent',
      reason: 'NO_REQUIRED_INDEPENDENCE_CANDIDATE',
    },
  );
  assert.throws(
    () =>
      scheduleOrdinaryRole({
        role: 'plan-reviewer',
        author,
        targetDigest: DIGESTS.target,
        candidates: [
          {
            providerId: 'unregistered' as 'claude',
            sessionId: 'unknown-provider-session',
            enabled: true,
            available: true,
          },
        ],
      }),
    (error) => isWorkflowError(error, 'PROVIDER_UNKNOWN'),
  );
  assert.deepEqual(
    scheduleOrdinaryRole({
      role: 'plan-reviewer',
      author,
      targetDigest: DIGESTS.target,
      requestedIndependence: 'provider-independent',
      candidates: [],
    }),
    {
      outcome: 'collaboration-grant-required',
      role: 'plan-reviewer',
      requiredIndependence: 'provider-independent',
      reason: 'NO_REQUIRED_INDEPENDENCE_CANDIDATE',
    },
  );
});
