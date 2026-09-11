import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAsyncCliDispatcherForTesting,
  createRoleAssignmentFailGrantResult,
} from '../src/entrypoints/cli/workflow-cli.ts';
import { ExitCode, workflowError } from '../src/foundation/errors/errors.ts';
import { workflowResultNextSteps } from '../src/modules/guidance/next-steps/workflow-guidance.ts';

test('AgentRuntime preflight refusal becomes a prepared-invocation Central Fail-Grant envelope', async () => {
  let requested: readonly string[] | null = null;
  const result = await createRoleAssignmentFailGrantResult(
    ['propose', 'demo-change'],
    '/fixture',
    workflowError(
      'AGENT_RUNTIME_GRANT_REQUIRED',
      'The exact assignment needs approval.',
      ExitCode.verification,
      {
        details: {
          invocationId: 'provider-invocation-1',
          changeId: 'demo-change',
          recordDigest: '1'.repeat(64),
        },
      },
    ),
    async (cwd, invocationId, reason) => {
      requested = [cwd, invocationId, reason];
      return {
        challengeId: '11111111-1111-4111-8111-111111111111',
        challengeDigest: `sha256:${'2'.repeat(64)}` as const,
      };
    },
  );

  assert.equal(requested?.[0], '/fixture');
  assert.equal(requested?.[1], 'provider-invocation-1');
  assert.match(requested?.[2] ?? '', /exact prepared provider invocation/u);
  assert.deepEqual(result, {
    command: 'propose',
    ok: true,
    result: {
      schemaVersion: 1,
      kind: 'workflow-fail-grant-required.v1',
      invocationId: 'provider-invocation-1',
      state: 'human-action-required',
      nextAction: 'human-action',
      failure: {
        code: 'AGENT_RUNTIME_GRANT_REQUIRED',
        message: 'The exact assignment needs approval.',
        details: {
          invocationId: 'provider-invocation-1',
          changeId: 'demo-change',
          recordDigest: '1'.repeat(64),
        },
      },
      grant: {
        challengeId: '11111111-1111-4111-8111-111111111111',
        challengeDigest: `sha256:${'2'.repeat(64)}`,
      },
      providerInvocationState: 'prepared',
      inputSchema: {
        schemaVersion: 1,
        kind: 'central-grant-resolution.v1',
        inspectCommand:
          'pnpm workflow grant human inspect 11111111-1111-4111-8111-111111111111 --json',
        decisionCommand:
          'pnpm workflow grant human decide 11111111-1111-4111-8111-111111111111 --json',
        retryAfterDecision:
          'pnpm workflow provider-worker provider-invocation-1 --json',
      },
    },
  });
});

test('unrelated AgentRuntime failures are not mislabeled as Fail-Grant', async () => {
  assert.equal(
    await createRoleAssignmentFailGrantResult(
      ['provider-worker', 'provider-invocation-1'],
      '/fixture',
      workflowError(
        'AGENT_RUNTIME_DATA_AUTHORIZATION_DENIED',
        'Policy denied the provider.',
        ExitCode.verification,
      ),
      async () => assert.fail('must not request a Grant'),
    ),
    null,
  );
});

test('hidden provider-worker dispatch publishes the same Fail-Grant envelope', async () => {
  let requestCount = 0;
  const dispatch = createAsyncCliDispatcherForTesting(
    async () => {
      throw workflowError(
        'AGENT_RUNTIME_GRANT_REQUIRED',
        'The exact assignment needs approval.',
        ExitCode.verification,
        { details: { invocationId: 'provider-invocation-2' } },
      );
    },
    async (_cwd, invocationId) => {
      requestCount += 1;
      assert.equal(invocationId, 'provider-invocation-2');
      return {
        challengeId: '33333333-3333-4333-8333-333333333333',
        challengeDigest: `sha256:${'4'.repeat(64)}` as const,
      };
    },
  );

  const result = await dispatch(
    ['provider-worker', 'provider-invocation-2'],
    '/fixture',
  );
  assert.equal(requestCount, 1);
  assert.equal(result.ok, true);
  assert.equal(
    (result.result as { kind: string }).kind,
    'workflow-fail-grant-required.v1',
  );
  assert.equal(
    (result.result as { providerInvocationState: string })
      .providerInvocationState,
    'prepared',
  );
  assert.deepEqual(
    workflowResultNextSteps(result, [
      'provider-worker',
      'provider-invocation-2',
    ]).map(({ command }) => command),
    [
      'pnpm workflow grant human inspect 33333333-3333-4333-8333-333333333333 --json',
      'pnpm workflow grant human decide 33333333-3333-4333-8333-333333333333 --json',
      'pnpm workflow provider-worker provider-invocation-2 --json',
    ],
  );
});
