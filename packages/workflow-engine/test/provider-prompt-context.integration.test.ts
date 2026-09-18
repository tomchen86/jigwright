import assert from 'node:assert/strict';
import { builtInProviderAdapters } from '../src/composition-root/built-in-provider-adapter-production.ts';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { buildContextManifest } from '../src/modules/authority/execution-governance-context.ts';
import {
  inspectDurableEpochContextStore,
  rolloverDurableEpochContextStore,
} from '../src/runtime/storage-journal/execution-governance-epoch-store.ts';
import {
  inspectDurableRetentionCatalog,
  storeDurableEvidence,
} from '../src/runtime/storage-journal/execution-governance-evidence-store.ts';
import {
  assembleProviderPromptManifest,
  ensureProviderPromptContext,
  prepareProviderPromptContextForInvocation,
  providerPromptContextStoreRoot,
} from '../src/runtime/provider-execution/provider-execution-governance.ts';
import { createProviderRunnerForTesting } from '../src/runtime/provider-execution/provider-runner.ts';
import {
  createRunnerFixture,
  providerRequest,
  semanticOutput,
  successfulProbe,
  claudeRunnerHost,
  isWorkflowError,
  sha256,
} from './provider-adapter-fixture.ts';

test('production prompt assembly reads only the exact current manifest and excludes unrelated durable evidence', () => {
  const fixture = createRunnerFixture();
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const binding = ensureProviderPromptContext(
      providerPromptContextStoreRoot(fixture.input.invocationDirectory),
      fixture.request,
      manifest,
      'investigation-provider-runner-test',
    );
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const catalog = inspectDurableRetentionCatalog(
      storeRoot,
      binding.workflowId,
    );
    const oldEvidence = 'OLD_EPOCH_EVIDENCE_MUST_NOT_ENTER_PROMPT';
    storeDurableEvidence(storeRoot, {
      workflowId: binding.workflowId,
      expectedCatalogGeneration: catalog.generation,
      record: {
        schemaVersion: 1,
        kind: 'evidence-retention',
        evidenceId: 'unreferenced-old-provider-evidence',
        itemIdentity: null,
        workflowId: binding.workflowId,
        epoch: binding.epoch,
        evidenceClass: 'raw',
        digest: `sha256:${sha256(oldEvidence)}`,
        retention: 'active',
        createdAt: '2026-08-03T14:00:00.000Z',
        expiresAt: null,
        pin: null,
      },
      content: oldEvidence,
    });

    let managedPrompt = '';
    const host = claudeRunnerHost((input) => {
      managedPrompt = input.stdinContent.toString('utf8');
      return successfulProbe(
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          structured_output: semanticOutput(fixture.request),
        }),
      );
    });
    createProviderRunnerForTesting(builtInProviderAdapters, host).run(
      fixture.input,
      {
        platform: 'darwin',
      },
    );
    assert.equal(managedPrompt.includes(oldEvidence), false);
    const parsed = JSON.parse(managedPrompt) as { manifest: unknown };
    assert.deepEqual(parsed.manifest, manifest);
  } finally {
    fixture.cleanup();
  }
});

test('provider prompt context identity is isolated by the durable investigation owner', () => {
  const fixture = createRunnerFixture();
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const first = ensureProviderPromptContext(
      storeRoot,
      fixture.request,
      manifest,
      'investigation-context-owner-a',
    );
    const second = ensureProviderPromptContext(
      storeRoot,
      fixture.request,
      manifest,
      'investigation-context-owner-b',
    );

    assert.notEqual(first.workflowId, second.workflowId);
    assert.equal(first.ownerWorkflowId, 'investigation-context-owner-a');
    assert.equal(second.ownerWorkflowId, 'investigation-context-owner-b');
  } finally {
    fixture.cleanup();
  }
});

test('production prompt assembly rejects a stale request after durable context rollover', () => {
  const fixture = createRunnerFixture();
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const binding = ensureProviderPromptContext(
      storeRoot,
      fixture.request,
      manifest,
      'investigation-provider-runner-test',
    );
    const nextContent = canonicalJson({
      kind: 'new-current-provider-context',
      sentinel: 'CURRENT_ONLY',
    });
    const next = buildContextManifest({
      workflowId: binding.workflowId,
      epoch: 2,
      contractVersion: binding.manifest.contractVersion,
      baselineDigest: binding.manifest.baselineDigest,
      intentDigest: binding.manifest.intentDigest,
      termSetDigest: binding.manifest.termSetDigest,
      planningSnapshotDigest: binding.manifest.planningSnapshotDigest,
      items: [{ identity: 'provider-input-manifest', content: nextContent }],
    });
    const current = inspectDurableEpochContextStore(
      storeRoot,
      binding.workflowId,
    );
    rolloverDurableEpochContextStore(storeRoot, {
      workflowId: binding.workflowId,
      expectedGeneration: 1,
      expectedEpoch: 1,
      expectedContextDigest: binding.contextDigest,
      nextManifest: next,
      items: [{ identity: 'provider-input-manifest', content: nextContent }],
      reason: 'Test a semantically changed provider context.',
      restartFrom: 'survey',
      carriedForward: [],
      carryForwardManifest: {
        sourceWorkflow: binding.workflowId,
        sourceEpoch: 1,
        carriedForward: [],
        excluded: [
          {
            identity: 'provider-input-manifest',
            reason: 'The provider context changed for this stale-request test.',
          },
        ],
      },
      invalidated: ['provider-input-manifest'],
      verification: null,
      createdAt: new Date(Date.parse(current.updatedAt) + 1),
    });
    assert.throws(
      () =>
        assembleProviderPromptManifest(
          storeRoot,
          fixture.request,
          manifest,
          'investigation-provider-runner-test',
        ),
      (error) => isWorkflowError(error, 'PROVIDER_CONTEXT_STALE_OR_WRONG'),
    );
  } finally {
    fixture.cleanup();
  }
});

test('lifecycle invocation selection rolls semantic provider context once and stale workers cannot roll it back', () => {
  const fixture = createRunnerFixture();
  const firstManifest = JSON.parse(
    fs.readFileSync(
      path.join(fixture.input.invocationDirectory, 'manifest.json'),
      'utf8',
    ),
  ) as unknown;
  try {
    const storeRoot = providerPromptContextStoreRoot(
      fixture.input.invocationDirectory,
    );
    const owner = 'investigation-provider-runner-test';
    const first = prepareProviderPromptContextForInvocation(
      storeRoot,
      fixture.request,
      firstManifest,
      owner,
      new Date('2026-08-03T15:00:00.000Z'),
    );
    const secondManifest = {
      kind: 'test-manifest',
      invocationId: 'invocation-adapter-test-next-semantic-input',
    };
    const secondRequest = providerRequest(
      fixture.request.policyDigest,
      fixture.repository,
      fixture.request.providerId,
      fixture.request.limits.aggregateOutputBytes,
      secondManifest.invocationId,
      sha256(canonicalJson(secondManifest)),
      fixture.request.purpose,
      fixture.request.limits.timeoutMs,
    );
    const second = prepareProviderPromptContextForInvocation(
      storeRoot,
      secondRequest,
      secondManifest,
      owner,
      new Date('2026-08-03T15:05:00.000Z'),
    );

    assert.equal(second.workflowId, first.workflowId);
    assert.equal(second.epoch, first.epoch + 1);
    assert.equal(second.generation, first.generation + 1);
    assert.equal(
      ensureProviderPromptContext(
        storeRoot,
        secondRequest,
        secondManifest,
        owner,
      ).contextDigest,
      second.contextDigest,
    );
    assert.throws(
      () =>
        ensureProviderPromptContext(
          storeRoot,
          fixture.request,
          firstManifest,
          owner,
        ),
      (error) => isWorkflowError(error, 'PROVIDER_CONTEXT_STALE_OR_WRONG'),
    );
    assert.equal(
      ensureProviderPromptContext(
        storeRoot,
        secondRequest,
        secondManifest,
        owner,
      ).contextDigest,
      second.contextDigest,
    );
  } finally {
    fixture.cleanup();
  }
});

test('managed prompt exposes the scope and v3 structured coverage contracts only to plan review', () => {
  const scopeAssessmentInstruction =
    'The output "scopeEvidence" array cites what you read to assess scope. Report a scope problem as a "findings" entry with category "missing-scope" or "missing-consumers"; the engine derives the scope assessment from those categories.';
  const structuredCoverageInstruction =
    'In the immutable investigation.json v3 Manifest, find the unique applicability.semanticDelta.investigationRequirements[] entry whose kind is "plan-review-coverage-requirement". Read structured PlanReview coverage only from that entry\'s coverage.requiredTargetIds and coverage.targetBindings. Treat every requiredTargetIds entry as mandatory. For each required target, cite the matching targetBindings row\'s exact evidenceKind and path at least once in scopeAssessment, a finding, or a suggestion. Extra evidence is allowed; omitting a required row is rejected at plan commit.';
  for (const purpose of ['survey', 'plan-review'] as const) {
    const fixture = createRunnerFixture('claude', 1_048_576, 2, purpose);
    let executeCount = 0;
    try {
      const host = claudeRunnerHost((input) => {
        executeCount += 1;
        assert.ok(Buffer.isBuffer(input.stdinContent));
        const prompt = JSON.parse(input.stdinContent.toString('utf8')) as {
          instructions: string[];
        };
        assert.equal(
          prompt.instructions.includes(scopeAssessmentInstruction),
          purpose === 'plan-review',
        );
        assert.equal(
          prompt.instructions.includes(structuredCoverageInstruction),
          purpose === 'plan-review',
        );
        if (purpose === 'plan-review') {
          const renderedInstructions = prompt.instructions.join('\n');
          assert.doesNotMatch(renderedInstructions, /evidence node/i);
          assert.doesNotMatch(renderedInstructions, /\boutput\./);
        }
        return successfulProbe(
          JSON.stringify({
            type: 'result',
            subtype: 'success',
            structured_output: semanticOutput(fixture.request),
          }),
        );
      });
      createProviderRunnerForTesting(builtInProviderAdapters, host).run(
        fixture.input,
        {
          platform: 'darwin',
        },
      );
      assert.equal(executeCount, 1);
    } finally {
      fixture.cleanup();
    }
  }
});
