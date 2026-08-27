import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  listProviderInvocationLifecycleProjections,
  scanProviderInvocationLifecycles,
} from '../src/runtime/storage-journal/investigation-session-store.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import { providerExecutionPolicySnapshotPath } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import { createFixtureRepository, git } from './fixture.ts';

test('an invocation without its current execution policy snapshot is unsafe', () => {
  const fixture = prepareLegacyInvocation('legacy-projection-tolerated');
  try {
    const scan = scanProviderInvocationLifecycles(fixture.runtime);
    assert.equal(scan.projections.length, 0);
    assert.equal(scan.unsafeInvocations.length, 1);
    assert.throws(
      () => listProviderInvocationLifecycleProjections(fixture.runtime),
      /provider state is missing, unsafe, or non-canonical/i,
    );
  } finally {
    fixture.dispose();
  }
});

test('a current invocation projects the exact lifecycle facts it recorded', () => {
  const fixture = prepareLegacyInvocation('current-projection-faithful', {
    keepSnapshot: true,
  });
  try {
    const [projection] = listProviderInvocationLifecycleProjections(
      fixture.runtime,
    );
    assert.equal(projection?.invocationId, fixture.invocationId);
    assert.equal(projection?.investigationId, fixture.state.investigationId);
    assert.equal(projection?.changeId, fixture.state.changeId);
    assert.equal(projection?.purpose, fixture.state.purpose);
    assert.equal(projection?.state, fixture.state.state);
    assert.equal(projection?.attempt, fixture.state.attempt);
    assert.equal(projection?.revision, fixture.state.revision);
    assert.equal(projection?.requestDigest, fixture.state.requestDigest);
    assert.equal(projection?.manifestDigest, fixture.state.manifestDigest);
  } finally {
    fixture.dispose();
  }
});

test('an invocation missing more than the policy snapshot stays unsafe', () => {
  const fixture = prepareLegacyInvocation('current-projection-damaged', {
    keepSnapshot: true,
  });
  try {
    fs.rmSync(path.join(fixture.directory, 'manifest.json'), { force: true });
    const scan = scanProviderInvocationLifecycles(fixture.runtime);
    assert.equal(scan.projections.length, 0);
    assert.equal(scan.unsafeInvocations.length, 1);
    assert.throws(
      () => listProviderInvocationLifecycleProjections(fixture.runtime),
      /provider state is missing, unsafe, or non-canonical/i,
    );
  } finally {
    fixture.dispose();
  }
});

test('a present but mismatched policy snapshot stays unsafe', () => {
  const fixture = prepareLegacyInvocation('current-projection-mismatched', {
    keepSnapshot: true,
  });
  try {
    const snapshot = JSON.parse(
      fs.readFileSync(fixture.snapshotPath, 'utf8'),
    ) as { requestDigest: string };
    snapshot.requestDigest = 'f'.repeat(64);
    fs.writeFileSync(fixture.snapshotPath, `${canonicalJson(snapshot)}\n`, {
      mode: 0o600,
    });
    const scan = scanProviderInvocationLifecycles(fixture.runtime);
    assert.equal(scan.projections.length, 0);
    assert.equal(scan.unsafeInvocations.length, 1);
    assert.throws(
      () => listProviderInvocationLifecycleProjections(fixture.runtime),
      /provider state is missing, unsafe, or non-canonical/i,
    );
  } finally {
    fixture.dispose();
  }
});

test('a V1 policy snapshot is not a current lifecycle projection', () => {
  const fixture = prepareLegacyInvocation('current-projection-v1-refused', {
    keepSnapshot: true,
  });
  try {
    const current = JSON.parse(
      fs.readFileSync(fixture.snapshotPath, 'utf8'),
    ) as Record<string, unknown>;
    fs.writeFileSync(
      fixture.snapshotPath,
      `${canonicalJson({
        schemaVersion: 1,
        kind: current.kind,
        invocationId: current.invocationId,
        requestDigest: current.requestDigest,
        policyDigest: current.policyDigest,
        policyDocument: current.policyDocument,
      })}\n`,
      { mode: 0o600 },
    );

    const scan = scanProviderInvocationLifecycles(fixture.runtime);
    assert.equal(scan.projections.length, 0);
    assert.equal(scan.unsafeInvocations.length, 1);
    assert.throws(
      () => listProviderInvocationLifecycleProjections(fixture.runtime),
      /provider state is missing, unsafe, or non-canonical/i,
    );
  } finally {
    fixture.dispose();
  }
});

function prepareLegacyInvocation(
  changeId: string,
  options: { keepSnapshot?: boolean } = {},
) {
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  const mandate = prepareExecutionMandate(repository, changeId);
  startPropose(
    repository,
    changeId,
    {
      schemaVersion: 1,
      summary: `Create ${changeId} provider invocation state.`,
      explicitPaths: ['packages/workflow-engine/src/execution-core.ts'],
      explicitSymbols: ['createExecutionJob'],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    {
      explicitActor: 'codex',
      environment: {},
      taskMandateId: mandate.taskId,
      taskMandateValidation: { signer: mandate.signer },
      providerDriver() {},
    },
  );
  const { runtime } = loadInvestigationRuntimeContext(repository);
  const [invocationId] = fs.readdirSync(runtime.invocations).sort();
  assert.ok(invocationId, 'the propose must have created an invocation');
  const directory = path.join(runtime.invocations, invocationId);
  const snapshotPath = providerExecutionPolicySnapshotPath(
    runtime,
    invocationId,
  );

  assert.ok(fs.existsSync(snapshotPath), 'the writer must record a snapshot');
  if (options.keepSnapshot !== true) {
    fs.rmSync(snapshotPath, { force: true });
  }
  const state = JSON.parse(
    fs.readFileSync(path.join(directory, 'state.json'), 'utf8'),
  ) as {
    investigationId: string;
    changeId: string;
    purpose: 'survey' | 'plan-review';
    state: string;
    attempt: number;
    revision: number;
    requestDigest: string;
    manifestDigest: string;
  };

  return {
    repository,
    runtime,
    invocationId,
    directory,
    snapshotPath,
    state,
    dispose() {
      mandate.dispose();
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}
