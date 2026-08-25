import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { GrantCoordinator } from '../src/modules/authority/grant-coordinator.ts';
import { dispatchHumanGrantCli } from '../src/entrypoints/cli/human-grant-cli.ts';
import {
  executeHumanResolutionGrant,
  recoverHumanResolutionGrant,
} from '../src/adapters/compatibility/investigation-v2/investigation-session.ts';
import { isWorkflowError } from './fixture.ts';

test('human grant CLI exposes registered investigation and Work Registry requests without accepting agent decisions', async () => {
  const calls: string[] = [];
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-human-grant-cli-'),
  );
  const reviewPath = path.join(repositoryRoot, 'review.json');
  fs.writeFileSync(
    reviewPath,
    `${JSON.stringify({
      action: 'accept',
      expectedDigest: `sha256:${'a'.repeat(64)}`,
      summary: 'Reviewed intake.',
    })}\n`,
  );
  const coordinator = {
    contractVersion: 'central-grant-request-port.v1' as const,
    challengeContractVersion: 'central-grant-challenge-port.v1' as const,
    async requestGrant() {
      throw new Error('not used');
    },
    inspectChallenge(challengeId) {
      calls.push(`inspect:${challengeId}`);
      return { challengeId } as never;
    },
    async resolveChallenge(challengeId) {
      calls.push(`decide:${challengeId}`);
      return { challengeId } as never;
    },
    async recoverChallenge(challengeId) {
      calls.push(`recover:${challengeId}`);
      return { challengeId } as never;
    },
  } satisfies GrantCoordinator;
  const dependencies = {
    coordinator: () => coordinator,
    async requestInvestigationV3(
      _cwd: string,
      investigationId: string,
      proposedReason: string,
    ) {
      calls.push(`request-v3:${investigationId}:${proposedReason}`);
      return { investigationId, proposedReason };
    },
    async requestChangeRoutingContinuation(
      _cwd: string,
      changeId: string,
      proposedReason: string,
    ) {
      calls.push(`request-route:${changeId}:${proposedReason}`);
      return { changeId, proposedReason };
    },
    async requestWorkItemReview(
      _cwd: string,
      workItemId: string,
      review: unknown,
      proposedReason: string,
    ) {
      calls.push(
        `request-work-review:${workItemId}:${String((review as { action?: unknown }).action)}:${proposedReason}`,
      );
      return { workItemId };
    },
    async requestWorkItemPromotion(
      _cwd: string,
      workItemId: string,
      changeId: string,
      expectedDigest: string,
      proposedReason: string,
    ) {
      calls.push(
        `request-work-promotion:${workItemId}:${changeId}:${expectedDigest}:${proposedReason}`,
      );
      return { workItemId, changeId };
    },
    async requestArchivePullRequestPublication(
      _cwd: string,
      preparationIdentity: string,
      proposedReason: string,
    ) {
      calls.push(
        `request-archive-publication:${preparationIdentity}:${proposedReason}`,
      );
      return { preparationIdentity };
    },
  };

  await dispatchHumanGrantCli(
    [
      'grant',
      'human',
      'request-archive-publication',
      `sha256:${'c'.repeat(64)}`,
      '--reason',
      'Authorize the exact reviewed archive preparation.',
    ],
    repositoryRoot,
    dependencies,
  );
  await dispatchHumanGrantCli(
    [
      'grant',
      'human',
      'request-change-routing-continuation',
      'demo-change',
      '--reason',
      'Continue the exact reviewed parked change.',
    ],
    repositoryRoot,
    dependencies,
  );
  await dispatchHumanGrantCli(
    [
      'grant',
      'human',
      'request-investigation-v3',
      'investigation-demo',
      '--reason',
      'The v3 blocker requires a bounded human continuation.',
    ],
    repositoryRoot,
    dependencies,
  );
  await dispatchHumanGrantCli(
    [
      'grant',
      'human',
      'request-work-item-review',
      'WORK-01K39R0V00000000000000000E',
      '--input',
      reviewPath,
      '--reason',
      'Approve the exact protected intake.',
    ],
    repositoryRoot,
    dependencies,
  );
  await dispatchHumanGrantCli(
    [
      'grant',
      'human',
      'request-work-item-promotion',
      'WORK-01K39R0V00000000000000000E',
      '--change',
      'deliver-registry-item',
      '--expected',
      `sha256:${'b'.repeat(64)}`,
      '--reason',
      'Approve the exact protected promotion.',
    ],
    repositoryRoot,
    dependencies,
  );
  await dispatchHumanGrantCli(
    ['grant', 'human', 'decide', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    repositoryRoot,
    dependencies,
  );
  assert.deepEqual(calls, [
    `request-archive-publication:sha256:${'c'.repeat(64)}:Authorize the exact reviewed archive preparation.`,
    'request-route:demo-change:Continue the exact reviewed parked change.',
    'request-v3:investigation-demo:The v3 blocker requires a bounded human continuation.',
    'request-work-review:WORK-01K39R0V00000000000000000E:accept:Approve the exact protected intake.',
    `request-work-promotion:WORK-01K39R0V00000000000000000E:deliver-registry-item:sha256:${'b'.repeat(64)}:Approve the exact protected promotion.`,
    'decide:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  ]);

  await assert.rejects(
    dispatchHumanGrantCli(
      ['grant', 'human', 'install'],
      repositoryRoot,
      dependencies,
    ),
    (error) => isWorkflowError(error, 'USAGE'),
  );

  await assert.rejects(
    dispatchHumanGrantCli(
      [
        'grant',
        'human',
        'request-investigation',
        'investigation-demo',
        '--reason',
        'Legacy v2 continuation must remain unavailable.',
      ],
      repositoryRoot,
      dependencies,
    ),
    (error) => isWorkflowError(error, 'USAGE'),
  );

  await assert.rejects(
    dispatchHumanGrantCli(
      [
        'grant',
        'human',
        'decide',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        '--choice',
        'investigation.abort.v1',
        '--reason',
        'agent-supplied',
      ],
      repositoryRoot,
      dependencies,
    ),
    (error) => isWorkflowError(error, 'USAGE'),
  );
  assert.equal(calls.length, 6);
  fs.rmSync(repositoryRoot, { recursive: true, force: true });
});

test('legacy human-resolution apply and recovery cannot start a live transition', () => {
  assert.throws(
    () =>
      executeHumanResolutionGrant(
        '/path/that/must/not/be-read',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    (error) =>
      isWorkflowError(error, 'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED'),
  );

  const cli = path.resolve(import.meta.dirname, '../src/cli.ts');
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      cli,
      'human-resolution-apply',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '--json',
    ],
    { cwd: os.tmpdir(), encoding: 'utf8' },
  );
  assert.equal(result.status, 10);
  assert.equal(
    (JSON.parse(result.stderr) as { error: { code: string } }).error.code,
    'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED',
  );

  assert.throws(
    () =>
      recoverHumanResolutionGrant(
        '/path/that/must/not/be-read',
        'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ),
    (error) =>
      isWorkflowError(error, 'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED'),
  );

  const recovery = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      cli,
      'human-resolution-recover',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '--json',
    ],
    { cwd: os.tmpdir(), encoding: 'utf8' },
  );
  assert.equal(recovery.status, 10);
  assert.equal(
    (JSON.parse(recovery.stderr) as { error: { code: string } }).error.code,
    'LEGACY_GRANT_V1_LIVE_TRANSITION_DISABLED',
  );
});
