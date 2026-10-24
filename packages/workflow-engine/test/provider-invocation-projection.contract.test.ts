import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  listProviderInvocationLifecycleProjections,
  scanProviderInvocationLifecycles,
} from '../src/runtime/storage-journal/provider-invocation-lifecycle.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import { providerExecutionPolicySnapshotPath } from '../src/runtime/storage-journal/provider-invocation-policy.ts';
import { startPropose } from '../src/composition-root/propose-production.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import { createFixtureRepository, git } from './fixture.ts';

test('current invocation projection admits exact state and rejects malformed current inputs', () => {
  const fixture = prepareCurrentInvocation();
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

    const snapshotBytes = fs.readFileSync(fixture.snapshotPath, 'utf8');
    const manifestPath = path.join(fixture.directory, 'manifest.json');
    const manifestBytes = fs.readFileSync(manifestPath, 'utf8');
    const cases = [
      {
        name: 'missing policy snapshot',
        mutate() {
          fs.rmSync(fixture.snapshotPath, { force: true });
        },
      },
      {
        name: 'missing manifest',
        mutate() {
          fs.rmSync(manifestPath, { force: true });
        },
      },
      {
        name: 'mismatched policy snapshot',
        mutate() {
          const snapshot = JSON.parse(snapshotBytes) as {
            requestDigest: string;
          };
          snapshot.requestDigest = 'f'.repeat(64);
          fs.writeFileSync(
            fixture.snapshotPath,
            `${canonicalJson(snapshot)}\n`,
            { mode: 0o600 },
          );
        },
      },
      {
        name: 'unsupported V1 policy snapshot',
        mutate() {
          const current = JSON.parse(snapshotBytes) as Record<string, unknown>;
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
        },
      },
    ];

    for (const testCase of cases) {
      fs.writeFileSync(fixture.snapshotPath, snapshotBytes, { mode: 0o600 });
      fs.writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
      testCase.mutate();
      const scan = scanProviderInvocationLifecycles(fixture.runtime);
      assert.equal(scan.projections.length, 0, testCase.name);
      assert.equal(scan.unsafeInvocations.length, 1, testCase.name);
      assert.throws(
        () => listProviderInvocationLifecycleProjections(fixture.runtime),
        /provider state is missing, unsafe, or non-canonical/i,
        testCase.name,
      );
    }
  } finally {
    fixture.dispose();
  }
});

function prepareCurrentInvocation() {
  const changeId = 'current-projection-contract';
  const repository = createFixtureRepository();
  git(repository, ['checkout', '-b', `work/${changeId}`]);
  const mandate = prepareExecutionMandate(repository, changeId);
  startPropose(
    repository,
    changeId,
    {
      schemaVersion: 1,
      summary: 'Create current provider invocation state.',
      sourceRefs: [],
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
