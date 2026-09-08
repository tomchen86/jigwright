/** Production availability composition and persisted/verifiable ordinary provider probe observations. */
import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  createFixtureRepository,
  builtInProviderDefinitionSnapshotForTest,
  isWorkflowError,
} from './fixture.ts';
import {
  createProviderAvailabilityPilotRunner,
  verifyProviderAvailabilityPilot,
} from '../src/runtime/provider-execution/provider-availability-pilot.ts';
import path from 'node:path';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import crypto from 'node:crypto';
import { PROVIDER_RUNNER_RESIDUALS } from '../src/runtime/provider-execution/provider-runner.ts';
import {
  providerProbeEvidence,
  executableIdentity,
} from './provider-availability-pilot-fixture.ts';
import { runCli } from './ai-adapter-evaluation-fixture.ts';

test('provider availability effects are wired only by production composition', () => {
  const runtimeSource = fs.readFileSync(
    new URL(
      '../src/runtime/provider-execution/provider-availability-pilot.ts',
      import.meta.url,
    ),
    'utf8',
  );

  assert.doesNotMatch(runtimeSource, /runProvider:\s*runBuiltInProvider/u);
  assert.doesNotMatch(runtimeSource, /probeBuiltInProviderFamilyEvidence/u);

  const compositionSource = fs.readFileSync(
    new URL(
      '../src/composition-root/provider-availability-pilot-production.ts',
      import.meta.url,
    ),
    'utf8',
  );
  const cliSource = fs.readFileSync(
    new URL('../src/entrypoints/cli/ai-adapter-cli.ts', import.meta.url),
    'utf8',
  );
  assert.match(compositionSource, /runBuiltInProvider/u);
  assert.match(compositionSource, /probeBuiltInProviderFamilyEvidence/u);
  assert.match(
    cliSource,
    /composition-root\/provider-availability-pilot-production\.ts/u,
  );
});

test('provider availability pilot durably verifies a credential-safe ordinary Codex and Claude observation', () => {
  const repository = createFixtureRepository();
  const uuids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  let tick = 0;
  try {
    const runPilot = createProviderAvailabilityPilotRunner({
      now() {
        return new Date(Date.UTC(2026, 7, 15, 0, 0, tick++));
      },
      randomUUID() {
        return uuids.shift()!;
      },
      probe(providerId) {
        return providerProbeEvidence(providerId, 'host-observed');
      },
      runProvider(input) {
        const semanticOutput = {
          reference: input.request.invocationId,
          terms: [
            {
              kind: 'literal-content',
              value: 'RAW_PROVIDER_TERM_MUST_NOT_BE_RECORDED',
            },
          ],
        };
        const providerRuntime = path.join(input.invocationDirectory, 'runtime');
        fs.mkdirSync(providerRuntime, { mode: 0o700 });
        for (const [name, content] of [
          ['prompt.json', '{}\n'],
          ['schema.json', `${canonicalJson(input.semanticOutputSchema)}\n`],
          ['semantic-output.json', `${canonicalJson(semanticOutput)}\n`],
        ] as const) {
          fs.writeFileSync(path.join(providerRuntime, name), content, {
            mode: 0o600,
          });
        }
        return {
          invocationId: input.request.invocationId,
          providerId: input.providerId,
          purpose: input.request.purpose,
          requestDigest: input.request.requestDigest,
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
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: executableIdentity(input.providerId),
          elapsedMs: input.providerId === 'codex' ? 12 : 14,
          providerDefinitionSnapshot: builtInProviderDefinitionSnapshotForTest(
            input.providerId,
          ),
        };
      },
    });
    const result = runPilot(repository, {
      recordPath: 'workflow/provider-availability-pilots/healthy-fixture.json',
    });

    assert.equal(result.record.accepted, true);
    assert.equal(result.record.decision, 'healthy-two-provider-observed');
    assert.equal(result.record.authority, 'empirical-observation-only');
    assert.deepEqual(result.record.friction, {
      providerWaitCount: 0,
      collaborationGrantCount: 0,
      humanActionCount: 0,
    });
    assert.deepEqual(
      result.record.observations.map(
        ({ providerId, state, role, achievedIndependence, grantUsed }) => ({
          providerId,
          state,
          role,
          achievedIndependence,
          grantUsed,
        }),
      ),
      [
        {
          providerId: 'codex',
          state: 'succeeded',
          role: 'plan-reviewer',
          achievedIndependence: 'provider-independent',
          grantUsed: false,
        },
        {
          providerId: 'claude',
          state: 'succeeded',
          role: 'plan-reviewer',
          achievedIndependence: 'provider-independent',
          grantUsed: false,
        },
      ],
    );
    assert.deepEqual(
      verifyProviderAvailabilityPilot(repository, result.recordPath),
      result.record,
    );
    const recordedBytes = fs.readFileSync(
      path.join(repository, result.recordPath),
      'utf8',
    );
    assert.equal(
      recordedBytes.includes('RAW_PROVIDER_TERM_MUST_NOT_BE_RECORDED'),
      false,
    );

    const verified = runCli(repository, [
      'adapter',
      'verify-availability-pilot',
      '--record',
      result.recordPath,
      '--json',
    ]);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(JSON.parse(verified.stdout).result.accepted, true);

    const tamperedPath =
      'workflow/provider-availability-pilots/tampered-fixture.json';
    const tampered = structuredClone(result.record) as { accepted: boolean };
    tampered.accepted = false;
    fs.writeFileSync(
      path.join(repository, tamperedPath),
      `${canonicalJson(tampered)}\n`,
    );
    assert.throws(
      () => verifyProviderAvailabilityPilot(repository, tamperedPath),
      (error) => isWorkflowError(error, 'PROVIDER_AVAILABILITY_PILOT_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider availability pilot records adapter unavailability without launching or claiming success', () => {
  const repository = createFixtureRepository();
  let launches = 0;
  try {
    const runPilot = createProviderAvailabilityPilotRunner({
      now: () => new Date('2026-08-15T01:00:00.000Z'),
      randomUUID: () => '33333333-3333-4333-8333-333333333333',
      probe(providerId) {
        return providerProbeEvidence(
          providerId,
          'host-observed',
          'unauthenticated',
        );
      },
      runProvider() {
        launches += 1;
        assert.fail('an unavailable adapter must not launch');
      },
    });
    const result = runPilot(repository, {
      recordPath:
        'workflow/provider-availability-pilots/unavailable-fixture.json',
    });

    assert.equal(launches, 0);
    assert.equal(result.record.accepted, false);
    assert.equal(result.record.decision, 'incomplete');
    assert.equal(result.record.friction.providerWaitCount, 2);
    assert.deepEqual(
      result.record.observations.map(
        ({ providerId, state, resolutionStatus, invocationId }) => ({
          providerId,
          state,
          resolutionStatus,
          invocationId,
        }),
      ),
      [
        {
          providerId: 'codex',
          state: 'unavailable',
          resolutionStatus: 'unauthenticated',
          invocationId: null,
        },
        {
          providerId: 'claude',
          state: 'unavailable',
          resolutionStatus: 'unauthenticated',
          invocationId: null,
        },
      ],
    );
    assert.deepEqual(
      verifyProviderAvailabilityPilot(repository, result.recordPath),
      result.record,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('provider availability pilot refuses synthetic or authority-forged AgentRuntime probe evidence before launch', () => {
  const repository = createFixtureRepository();
  try {
    for (const [name, evidence] of [
      [
        'synthetic-fixture',
        providerProbeEvidence('codex', 'synthetic-fixture'),
      ],
      [
        'forged-authority',
        {
          ...providerProbeEvidence('codex', 'host-observed'),
          authority: 'availability-authority',
        },
      ],
    ] as const) {
      let launches = 0;
      const runPilot = createProviderAvailabilityPilotRunner({
        now: () => new Date('2026-08-15T02:00:00.000Z'),
        randomUUID: () => '44444444-4444-4444-8444-444444444444',
        probe() {
          return evidence as never;
        },
        runProvider() {
          launches += 1;
          assert.fail(
            'unadmitted evidence must not unlock empirical execution',
          );
        },
      });
      assert.throws(
        () =>
          runPilot(repository, {
            recordPath: `workflow/provider-availability-pilots/${name}.json`,
          }),
        (error: unknown) =>
          error instanceof TypeError &&
          'code' in error &&
          error.code === 'AGENT_RUNTIME_PORT_INVALID',
      );
      assert.equal(launches, 0);
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
