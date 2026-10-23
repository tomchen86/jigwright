import crypto from 'node:crypto';
import { canonicalJson } from '@jigwright/core/canonical-json';
import type { LocalEngineBinding } from '../src/modules/authority/intervention-bootstrap-contract.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createHarnessBootstrapParentState,
  type HarnessBootstrapParentBindings,
} from '../src/application/control-plane/harness-bootstrap-parent-state.ts';
import { createHarnessBootstrapDependencies } from '../bootstrap/harness-bootstrap-production.ts';
import {
  admitHarnessBootstrapParent,
  type HarnessBootstrapParentObservation,
} from '../src/modules/lifecycle/harness-bootstrap-parent-session.ts';
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
    'lifecycle/harness-bootstrap-parent-session',
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

test('parent snapshot retains complete session bytes and reference before serializing intent and policy', () => {
  const f = fixture();
  const session = f.observation.candidates[0]!.session;
  Object.assign(session, {
    artifacts: { design: 'design-digest' },
    allowedPaths: ['src/**'],
    requiredChecks: ['unit'],
    requiredCheckDigests: { unit: 'unit-digest' },
    mandateBinding: {
      schemaVersion: 1,
      mandateTaskId: 'mandate-task',
      mandateId: 'mandate',
      mandateDigest: 'mandate-digest',
      changeId: 'change-a',
      externalAuditRoot: '/audit',
    },
    planningAssurance: {
      applicabilityKind: 'sealed-investigation',
      applicabilityDigest: 'app-digest',
      applicabilityNodeId: 'app-node',
      investigationBaseline: session.baseline,
      planningGenerationId: 'generation',
      planTargetDigest: 'plan',
      reviewNodeId: 'review',
      reviewResultDigest: 'result',
      reviewDispositionNodeId: null,
      reviewRoleResultDigest: 'role',
      reviewRoleResultForm: 'ordinary-provider',
      reviewOrchestration: 'engine-spawned-provider',
      requiredIndependence: 'provider-independent',
      achievedIndependence: 'provider-independent',
      degradationAuthorized: false,
      advisoryVerdict: 'advisory-approve',
      reviewGrantId: null,
      reviewGrantEnvelopeDigest: null,
      reviewGrantUseDigest: null,
      reviewGrantTransitionDigest: null,
      directHumanReviewAttestationDigest: null,
    },
    revisionLeaseId: 'lease',
    implementationReconciliationReportId: 'reconciliation',
    implementationReconciliationPaths: ['src/a.ts'],
    documentationRemediation: {
      reviewRecordDigests: ['review'],
      paths: ['README.md'],
    },
    latestCheckReportId: 'check',
    completionReportId: 'completion',
    finishReportId: 'finish',
    commitReportId: 'commit',
    commitHash: 'hash',
    committedAt: 'committed',
    abortedAt: 'aborted',
    abortReason: 'reason',
    extraRuntimeField: { retained: true },
  });
  Object.assign(session.baseline, { extraRuntimeField: 'baseline-extra' });
  const bytes = canonicalJson(session);
  f.bindings.persistTrustedBootstrapSessionSnapshot = (root, actual) => {
    f.events.push('snapshot');
    assert.equal(root, '/state/intervention-control');
    assert.equal(actual, session);
    assert.equal(canonicalJson(actual), bytes);
    // The existing callback receives the actual object before later serialization.
    session.taskId = 'after-snapshot';
    session.allowedPaths.push('docs/**');
    return '/state/full-snapshot.json';
  };
  const result = f.run();
  assert.deepEqual(f.events, [
    'observe',
    'binding-path',
    'supervisor',
    'snapshot',
  ]);
  assert.equal(result.sessionSnapshotPath, '/state/full-snapshot.json');
  assert.equal(result.parent.sessionSchema, 'workflow-session.v1');
  assert.equal(
    result.pendingIntent,
    canonicalJson({
      kind: 'harness-bootstrap-parent-resume-intent.v1',
      sessionId: session.sessionId,
      changeId: session.changeId,
      taskId: 'after-snapshot',
      branch: session.branch,
      baseline: session.baseline,
    }),
  );
  assert.equal(
    result.policyDigest,
    `sha256:${crypto
      .createHash('sha256')
      .update(
        canonicalJson({
          kind: 'harness-bootstrap-parent-policy-binding.v1',
          changeId: session.changeId,
          taskId: 'after-snapshot',
          artifacts: session.artifacts,
          allowedPaths: ['src/**', 'docs/**'],
          requiredChecks: session.requiredChecks,
          requiredCheckDigests: session.requiredCheckDigests,
          planningAssurance: session.planningAssurance,
          mandateBinding: session.mandateBinding,
        }),
      )
      .digest('hex')}`,
  );
});

test('parent policy retains nullish defaults without normalizing the stored session', () => {
  for (const absent of [null, undefined]) {
    const f = fixture();
    const session = f.observation.candidates[0]!.session;
    if (absent === undefined) {
      Reflect.deleteProperty(session, 'planningAssurance');
      delete session.mandateBinding;
    } else {
      session.planningAssurance = null;
      session.mandateBinding = null;
    }
    const original = canonicalJson(session);
    f.bindings.persistTrustedBootstrapSessionSnapshot = (_root, actual) => {
      assert.equal(actual, session);
      assert.equal(canonicalJson(actual), original);
      return '/state/snapshot.json';
    };
    assert.equal(
      f.run().policyDigest,
      `sha256:${crypto
        .createHash('sha256')
        .update(
          canonicalJson({
            kind: 'harness-bootstrap-parent-policy-binding.v1',
            changeId: session.changeId,
            taskId: session.taskId,
            artifacts: {},
            allowedPaths: [],
            requiredChecks: [],
            requiredCheckDigests: {},
            planningAssurance: null,
            mandateBinding: null,
          }),
        )
        .digest('hex')}`,
    );
  }
  // An own undefined property is invalid canonical data. Persistence must still
  // fail before the later policy defaults could normalize that property.
  const f = fixture();
  const session = f.observation.candidates[0]!.session;
  Object.defineProperty(session, 'planningAssurance', {
    value: undefined,
    enumerable: true,
  });
  f.bindings.persistTrustedBootstrapSessionSnapshot = (_root, actual) => {
    f.events.push('snapshot');
    assert.equal(actual, session);
    canonicalJson(actual);
    assert.fail('undefined snapshot data was accepted');
  };
  assert.throws(f.run, { code: 'CANONICAL_JSON_INVALID' });
  assert.deepEqual(f.events, [
    'observe',
    'binding-path',
    'supervisor',
    'snapshot',
  ]);
});

test('parent candidate, stale identity and state-root failures keep their precedence and prevent external work', () => {
  for (const [count, code] of [
    [0, 'HARNESS_BOOTSTRAP_PARENT_SESSION_NOT_FOUND'],
    [2, 'HARNESS_BOOTSTRAP_PARENT_SESSION_AMBIGUOUS'],
  ] as const) {
    const f = fixture();
    const candidate = f.observation.candidates[0]!;
    Object.defineProperty(candidate, 'session', {
      get() {
        assert.fail('candidate read before cardinality admission');
      },
    });
    f.observation.candidates = Array.from({ length: count }, () => candidate);
    assert.throws(f.run, { code });
    assert.deepEqual(f.events, ['observe']);
  }
  const changes: Array<
    (observation: HarnessBootstrapParentObservation) => void
  > = [
    (o) => {
      o.candidates[0]!.session.state = 'aborted';
    },
    (o) => {
      o.candidates[0]!.session.repositoryRoot = '/other';
    },
    (o) => {
      o.candidates[0]!.session.gitCommonDirectory = '/other/.git';
    },
    (o) => {
      o.candidates[0]!.session.branch = 'other';
    },
    (o) => {
      o.repository.branch = 'other';
    },
    (o) => {
      o.candidates[0]!.session.baseline.head = 'other';
    },
    (o) => {
      o.candidates[0]!.session.baseline.tree = 'other';
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f.observation);
    assert.throws(
      () =>
        admitHarnessBootstrapParent(f.observation, 'change-a', '/wrong-root'),
      {
        code: 'HARNESS_BOOTSTRAP_PARENT_SESSION_STALE',
      },
    );
    assert.throws(f.run, { code: 'HARNESS_BOOTSTRAP_PARENT_SESSION_STALE' });
    assert.deepEqual(f.events, ['observe']);
  }
  const f = fixture();
  f.observation.runtime = { ...f.observation.runtime, root: '/other-state' };
  assert.throws(f.run, { code: 'HARNESS_BOOTSTRAP_STATE_ROOT_MISMATCH' });
  assert.deepEqual(f.events, ['observe']);
});

function parentBinding(): LocalEngineBinding {
  const digest = `sha256:${'e'.repeat(64)}` as const;
  return {
    kind: 'local-parent-session-metadata.v2',
    parentChangeId: 'change-a',
    parentWorkspacePath: '/repo',
    parentBranch: 'refs/heads/work/change-a',
    interventionChangeId: 'engine-upgrade',
    txId: 'tx',
    checkpointId: digest,
    engineDigest: digest,
    activeArtifact: {
      artifactId: digest,
      executableDigest: digest,
      executablePath: '/engine',
    },
    sessionSchema: 'engine-session.v2',
    blocker: null,
    interventionState: 'adopted',
    generation: 2,
    updatedAt: '2026-08-01T00:00:00.000Z',
    recordDigest: digest,
  };
}

test('parent binding override and each conflict retain admission before snapshot and skip supervisor', () => {
  const base = parentBinding();
  const changes: Array<Partial<LocalEngineBinding>> = [
    {},
    { parentChangeId: 'other' },
    { parentWorkspacePath: '/other' },
    { parentBranch: 'refs/heads/other' },
    { interventionState: 'active' },
    {
      blocker: {
        kind: 'harness-intervention',
        checkpointId: base.checkpointId,
        blockedBy: 'other',
      },
    },
  ];
  for (const [index, change] of changes.entries()) {
    const f = fixture();
    f.bindings.observeParentBindingPath = () => {
      f.events.push('binding-path');
      return '/binding.json';
    };
    f.bindings.readLocalEngineBinding = (file) => {
      f.events.push('read-binding');
      assert.equal(file, '/binding.json');
      return { ...base, ...change };
    };
    if (index === 0) {
      const result = f.run();
      assert.equal(result.parent.engineBinding, base.engineDigest);
      assert.equal(result.parent.sessionSchema, base.sessionSchema);
      assert.deepEqual(f.events, [
        'observe',
        'binding-path',
        'read-binding',
        'snapshot',
      ]);
    } else {
      assert.throws(f.run, {
        code: 'HARNESS_BOOTSTRAP_PARENT_BINDING_CONFLICT',
      });
      assert.deepEqual(f.events, ['observe', 'binding-path', 'read-binding']);
    }
  }
});

test('parent supervisor override retains schema and propagates foreign absence errors before persistence', () => {
  const f = fixture();
  const digest = `sha256:${'e'.repeat(64)}` as const;
  f.bindings.readControlPlaneSupervisorState = (root) => {
    f.events.push('supervisor');
    assert.equal(root, '/state/intervention-control');
    return {
      kind: 'control-plane-supervisor-state.v1',
      repositoryId: 'repo',
      activeArtifact: {
        artifactId: digest,
        executableDigest: digest,
        closureDigest: digest,
        executablePath: '/engine',
      },
      generation: 1,
      transition: null,
      updatedAt: '2026-08-01T00:00:00.000Z',
      recordDigest: digest,
    };
  };
  const result = f.run();
  assert.equal(result.parent.engineBinding, digest);
  assert.equal(result.parent.sessionSchema, 'workflow-session.v1');
  assert.deepEqual(f.events, [
    'observe',
    'binding-path',
    'supervisor',
    'snapshot',
  ]);
  for (const failure of [
    Object.assign(new Error('foreign missing'), {
      code: 'CONTROL_PLANE_SUPERVISOR_NOT_FOUND',
    }),
    workflowError(
      'CONTROL_PLANE_SUPERVISOR_CORRUPT',
      'corrupt',
      ExitCode.staleState,
    ),
  ]) {
    const failed = fixture();
    failed.bindings.readControlPlaneSupervisorState = () => {
      failed.events.push('supervisor');
      throw failure;
    };
    assert.throws(failed.run, (error) => error === failure);
    assert.deepEqual(failed.events, ['observe', 'binding-path', 'supervisor']);
  }
});
