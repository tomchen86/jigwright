import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
  dispatchInterventionControlCommand,
  parseInterventionControlCommand,
} from '../src/entrypoints/cli/intervention-control-cli.ts';
import {
  REQUIRED_PROTECTED_CAPABILITIES,
  createProtectedCapabilityManifest,
  protectedCapabilityClosureDigest,
  type ExactControlPlaneChange,
  type ProtectedCapabilityEntry,
} from '../src/modules/authority/intervention-control.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';

const NOW = new Date('2026-08-03T10:00:00.000Z');

function digest(label: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(label).digest('hex')}`;
}

function hasCode(code: string) {
  return (error: unknown): boolean =>
    error instanceof WorkflowError && error.code === code;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function interveneRequest() {
  return {
    interventionChangeId: 'intervention-B',
    parent: {
      changeId: 'parent-A',
      status: 'active',
      engineBinding: digest('engine-E1'),
      sessionSchema: 'v4',
      blocker: null,
    },
    checkpoint: {
      parentChangeId: 'parent-A',
      baseOid: 'a'.repeat(40),
      worktreeFingerprint: digest('worktree'),
      trackedTreeDigest: digest('tracked'),
      untrackedBundleDigest: digest('untracked'),
      sessionStateDigest: digest('session'),
      pendingIntentDigest: digest('intent'),
      engineDigest: digest('engine-E1'),
      policyDigest: digest('policy'),
      createdAt: NOW.toISOString(),
    },
  };
}

test('production parser rejects caller-supplied intervention and adoption JSON before dispatch', () => {
  const request = interveneRequest();
  const argv = ['change', 'intervene', 'parent-A', '--request', json(request)];
  for (const callerSupplied of [
    argv,
    ['engine', 'adopt', '--request', json({ action: 'prepare' })],
  ]) {
    assert.throws(
      () => parseInterventionControlCommand(callerSupplied),
      hasCode('INTERVENTION_CALLER_SUPPLIED_MAINTENANCE_INPUT_DISABLED'),
    );
    assert.throws(
      () => dispatchInterventionControlCommand(callerSupplied),
      hasCode('INTERVENTION_CALLER_SUPPLIED_MAINTENANCE_INPUT_DISABLED'),
    );
  }
});

test('production parser rejects caller-supplied engine recovery journals', () => {
  const argv = ['engine', 'recover', '--request', json({ journal: {} })];
  for (const invoke of [
    () => parseInterventionControlCommand(argv),
    () => dispatchInterventionControlCommand(argv),
  ]) {
    assert.throws(invoke, hasCode('INTERVENTION_CONTROL_COMMAND_UNSUPPORTED'));
  }
});

function protectedEntries(): ProtectedCapabilityEntry[] {
  return REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
    const entrypoints = [`packages/bootstrap/${capability}.ts`];
    const dependencies = [`packages/bootstrap/shared/${capability}.ts`];
    const contentDigest = digest(`content:${capability}`);
    return {
      capability,
      entrypoints,
      dependencies,
      contentDigest,
      closureDigest: protectedCapabilityClosureDigest(
        entrypoints,
        dependencies,
        contentDigest,
      ),
    };
  });
}

function controlPlaneFixture() {
  const beforeManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries: protectedEntries(),
  });
  const entries = protectedEntries();
  const changedContent = digest('changed-control-content');
  entries[0] = {
    ...entries[0],
    contentDigest: changedContent,
    closureDigest: protectedCapabilityClosureDigest(
      entries[0].entrypoints,
      entries[0].dependencies,
      changedContent,
    ),
  };
  const afterManifest = createProtectedCapabilityManifest({
    schemaVersion: 1,
    manifestPath: beforeManifest.manifestPath,
    entries,
  });
  const changes: ExactControlPlaneChange[] = [
    {
      path: beforeManifest.entries[0].entrypoints[0],
      beforeDigest: beforeManifest.entries[0].contentDigest,
      afterDigest: changedContent,
    },
    {
      path: beforeManifest.manifestPath,
      beforeDigest: beforeManifest.manifestDigest,
      afterDigest: afterManifest.manifestDigest,
    },
  ];
  return { beforeManifest, afterManifest, changes };
}

test('control-plane classify remains read-only and legacy verify-grant is unsupported', () => {
  const fixture = controlPlaneFixture();
  const classification = dispatchInterventionControlCommand([
    'control-plane',
    'classify',
    '--request',
    json({
      beforeManifest: fixture.beforeManifest,
      afterManifest: fixture.afterManifest,
      changes: fixture.changes,
    }),
  ]);
  assert.equal(classification.kind, 'control-plane-classify');
  if (classification.kind !== 'control-plane-classify') {
    assert.fail('Expected a protected capability classification.');
  }
  assert.equal(classification.impact.class, 'C');
  assert.equal(classification.effectsPerformed, false);

  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'control-plane',
        'verify-grant',
        '--request',
        json({}),
      ]),
    hasCode('INTERVENTION_CONTROL_COMMAND_UNSUPPORTED'),
  );
});

test('dispatcher rejects promotion and live ref mutation rather than performing effects', () => {
  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'engine',
        'promote',
        digest('engine-E2'),
      ]),
    hasCode('INTERVENTION_CONTROL_GLOBAL_PROMOTION_FORBIDDEN'),
  );
  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'control-plane',
        'update-ref',
        'refs/heads/main',
      ]),
    hasCode('INTERVENTION_CONTROL_LIVE_REF_MUTATION_FORBIDDEN'),
  );
  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'control-plane',
        'classify',
        '--request',
        json({ updateRef: 'refs/heads/main' }),
      ]),
    hasCode('INTERVENTION_CONTROL_LIVE_REF_MUTATION_FORBIDDEN'),
  );
});

test('workflow supersede validation and malformed requests retain domain error codes', () => {
  assert.deepEqual(
    dispatchInterventionControlCommand([
      'workflow',
      'validate-supersede-reason',
      'workflow-replaced',
    ]),
    {
      kind: 'workflow-supersede-reason',
      validation: { allowed: true, reason: 'workflow-replaced' },
      effectsPerformed: false,
    },
  );
  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'workflow',
        'validate-supersede-reason',
        'provider-timeout',
      ]),
    hasCode('SUPERSEDE_EXECUTION_FAILURE_FORBIDDEN'),
  );
  assert.throws(
    () =>
      dispatchInterventionControlCommand([
        'change',
        'intervene',
        'parent-A',
        '--request',
        '{bad-json',
      ]),
    hasCode('INTERVENTION_CALLER_SUPPLIED_MAINTENANCE_INPUT_DISABLED'),
  );
  assert.throws(
    () => dispatchInterventionControlCommand(['unknown', 'command']),
    hasCode('INTERVENTION_CONTROL_COMMAND_UNSUPPORTED'),
  );
});
