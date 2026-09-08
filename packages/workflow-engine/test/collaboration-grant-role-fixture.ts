/** Role content, participant, and observed provider invocation fixtures. */
import type {
  ProviderInvocationRequest,
  ProviderProcessOutcome,
} from '../src/modules/provider-orchestration/provider-contracts.ts';
import { investigationRuntimePaths } from '../src/runtime/session-workspace/paths.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  claimProviderInvocation,
  completeProviderInvocation,
} from '../src/runtime/storage-journal/provider-invocation-store.ts';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import type { ProviderRunnerReport } from '../src/runtime/provider-execution/provider-runner.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { builtInProviderDefinitionSnapshotForTest } from './fixture.ts';
import crypto from 'node:crypto';
import type { RoleParticipant } from '../src/modules/provider-orchestration/role-scheduler.ts';
import {
  CONTENT_NODE_ID,
  CONTENT_RESULT_DIGEST,
} from './collaboration-grant-signed-fixture.ts';

export function roleContent(kind: 'blind-survey' | 'plan-review') {
  return {
    kind,
    nodeId: CONTENT_NODE_ID,
    resultDigest: CONTENT_RESULT_DIGEST,
    outputSchema: {
      id: `${kind}-output.v1`,
      version: 1,
      digest: '5'.repeat(64),
    },
    evaluator: `${kind}-evaluator.v1`,
    policyDigest: '6'.repeat(64),
    contentDigest: CONTENT_RESULT_DIGEST,
    current: true as const,
  };
}

function completeFixtureProviderInvocation(
  request: ProviderInvocationRequest,
  repository: string,
): void {
  const paths = investigationRuntimePaths(
    fs.realpathSync(path.join(repository, '.git')),
    'workflow-engine',
  );
  const claim = claimProviderInvocation(paths, request.invocationId, {
    workerId: 'granted-propose-worker',
    leaseDurationMs: 60_000,
  });
  const output = {
    reference: request.invocationId,
    terms: [{ kind: 'symbol', value: 'GrantedSurveyNeedle' }],
  };
  const wireResult = {
    schemaVersion: 1,
    requestDigest: request.requestDigest,
    invocationId: request.invocationId,
    nonce: request.nonce,
    purpose: request.purpose,
    providerId: request.providerId,
    roleAssignmentDigest: request.roleAssignmentDigest,
    capabilityProfile: request.capabilityProfile,
    repositoryId: request.repositoryId,
    baseCommit: request.baseCommit,
    baseTree: request.baseTree,
    targetDigest: request.targetDigest,
    inputManifestDigest: request.inputManifestDigest,
    authorizationNodeId: request.authorizationNodeId,
    outputSchema: request.outputSchema,
    evaluatorVersion: request.evaluatorVersion,
    policyDigest: request.policyDigest,
    limits: request.limits,
    observedTouchedPaths: [],
    output,
  };
  const outcome: ProviderProcessOutcome = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    spawnErrorCode: null,
    elapsedMs: 1,
    stdout: JSON.stringify(wireResult),
    stderr: '',
  };
  completeProviderInvocation(paths, request.invocationId, {
    expectedRevision: claim.record.revision,
    leaseGeneration: claim.record.leaseGeneration,
    leaseToken: claim.leaseToken,
    outcome,
  });
}

function fakeProviderRunnerReport(
  request: ProviderInvocationRequest,
  semanticOutput: unknown,
): ProviderRunnerReport {
  return {
    invocationId: request.invocationId,
    providerId: request.providerId,
    purpose: request.purpose,
    requestDigest: request.requestDigest,
    semanticOutput,
    semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
    assurance: 'unchanged-governed-projection',
    projection: {
      unchanged: true,
      changedCategories: [],
      beforeDigest: 'a'.repeat(64),
      afterDigest: 'a'.repeat(64),
    },
    sameUserProcessConfined: false,
    residuals: [...PROVIDER_RUNNER_RESIDUALS],
    executable: {
      candidatePath: '/opt/homebrew/bin/codex',
      realPath: '/opt/homebrew/bin/codex',
      device: '1',
      inode: '2',
      mode: 0o100755,
      uid: 501,
      gid: 20,
      size: 1024,
      mtimeNs: '123456789',
      sha256: 'b'.repeat(64),
    },
    elapsedMs: 5,
    providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
      request.providerId,
    ),
  };
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function participant(
  providerId: 'codex' | 'claude',
  sessionId: string,
): RoleParticipant {
  return {
    providerId,
    sessionId,
    principalId: 'fixture-agent',
    identityAssurance: 'runtime-hint',
    engineSpawned: true,
  };
}
