import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { discoverRepository } from '../src/runtime/repository-transaction/git.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import type { ProviderInvocationRequest } from '../src/modules/provider-orchestration/provider-contracts.ts';
import {
  claimProviderInvocationForWorker,
  completeProviderInvocationFromRunner,
  prepareProviderInvocationAcceptanceBinding,
  providerResidualsGeneration,
  readProviderInvocation,
  readProviderInvocationRequest,
  releaseProviderInvocationWorkerFence,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import { startPropose } from '../src/application/propose/propose-orchestrator.ts';
import {
  builtInProviderDefinitionSnapshotForTest,
  createFixtureRepository,
  git,
  isWorkflowError,
} from './fixture.ts';

const SHORT_RESIDUALS = PROVIDER_RUNNER_RESIDUALS.filter(
  (code) => code !== 'PROVIDER_INPUT_CONSUMPTION_NOT_OBSERVABLE',
);

test('provider residual admission accepts only the exact current list', () => {
  assert.deepEqual(classify(PROVIDER_RUNNER_RESIDUALS), {
    generation: 'current',
    missing: [],
  });

  const invalid = [
    SHORT_RESIDUALS,
    [...SHORT_RESIDUALS, 'PROVIDER_NETWORK_EGRESS_NOT_CONFINED'],
    [...PROVIDER_RUNNER_RESIDUALS, ...PROVIDER_RUNNER_RESIDUALS],
    [...PROVIDER_RUNNER_RESIDUALS].reverse(),
    [...SHORT_RESIDUALS, SHORT_RESIDUALS.at(-1)!],
    [],
    '',
    {},
    null,
  ];
  for (const residuals of invalid) {
    assert.throws(
      () => classify(residuals),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_RESULT_INVALID'),
      JSON.stringify(residuals),
    );
  }
});

test('current runner completion rejects a non-current residual list', () => {
  const repository = createFixtureRepository();
  const changeId = 'residuals-current-strict';
  let fence: { invocationId: string; token: string } | null = null;
  try {
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: 'Reject a current runner report with non-current residuals.',
        explicitPaths: ['src/.gitkeep'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      { explicitActor: 'codex', environment: {} },
    );
    const invocationId = started.investigation!.providerInvocationId;
    const runtime = investigationRuntimePaths(
      discoverRepository(repository).gitCommonDirectory,
      'workflow-engine',
    );
    const request = readProviderInvocationRequest(runtime, invocationId);
    const claim = claimProviderInvocationForWorker(runtime, invocationId, {
      workerId: `worker-${changeId}`,
      leaseDurationMs: request.limits.timeoutMs,
    });
    fence = { invocationId, token: claim.workerFenceToken };
    const acceptanceBinding = prepareProviderInvocationAcceptanceBinding(
      runtime,
      invocationId,
      'schema-v4',
    );

    assert.throws(
      () =>
        completeProviderInvocationFromRunner(runtime, invocationId, {
          expectedRevision: claim.record.revision,
          leaseGeneration: claim.record.leaseGeneration,
          leaseToken: claim.leaseToken,
          report: workerReport(request, invocationId, SHORT_RESIDUALS),
          acceptanceBinding,
        }),
      (error) => isWorkflowError(error, 'PROVIDER_INVOCATION_RESULT_INVALID'),
    );
    assert.equal(readProviderInvocation(runtime, invocationId).result, null);
  } finally {
    if (fence !== null) {
      releaseProviderInvocationWorkerFence(
        investigationRuntimePaths(
          discoverRepository(repository).gitCommonDirectory,
          'workflow-engine',
        ),
        fence.invocationId,
        fence.token,
      );
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function classify(residuals: unknown) {
  return providerResidualsGeneration({
    result: { runtimeObservation: { residuals } },
  } as never);
}

function workerReport(
  request: ProviderInvocationRequest,
  invocationId: string,
  residuals: readonly string[],
) {
  const semanticOutput = {
    reference: invocationId,
    terms: [{ kind: 'symbol', value: 'ProviderRunnerResiduals' }],
  };
  return {
    invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: crypto
      .createHash('sha256')
      .update(canonicalJson(semanticOutput))
      .digest('hex'),
    assurance: 'unchanged-governed-projection' as const,
    projection: {
      unchanged: true as const,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false as const,
    residuals: [...residuals],
    executable: {
      candidatePath: '/opt/homebrew/bin/claude',
      realPath: '/opt/homebrew/bin/claude',
      device: '1',
      inode: '2',
      mode: 0o100755,
      uid: 501,
      gid: 20,
      size: 1024,
      mtimeNs: '123456789',
      sha256: 'b'.repeat(64),
    },
    elapsedMs: 7,
    providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
      request.providerId,
    ),
  };
}
