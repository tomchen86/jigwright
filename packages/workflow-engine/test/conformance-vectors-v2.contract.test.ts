import { spawnSync } from 'node:child_process';
import { sourceRepositoryRoot } from './fixture.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';

import { canonicalJson } from '@jigwright/core/canonical-json';
import { loadWorkflowConformanceVectorsV2 } from '../src/runtime/repository-transaction/conformance-vectors.ts';
import {
  parsePlanningProviderBinding,
  planningProviderBindingDigest,
  renderPlanningProviderBinding,
  type PlanningProviderBindingV1,
} from '@jigwright/core/planning-provider-binding';
import { parseManagedTrailers } from '@jigwright/core/managed-transition-trailers';
import { createProviderWrapperProtocolParser } from '@jigwright/agent-runtime/harness-jsonl-v1';
import {
  renderProviderWrapperFrame,
  type ProviderWrapperFrame,
  type ProviderWrapperProtocolBinding,
} from '@jigwright/core/harness-jsonl-v1-contracts';
import {
  COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
  COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  selectCollaborationGrantSignatureNamespaceV1,
} from '@jigwright/grants/collaboration-grant-envelope-reader';

import {
  approvalSubjectDigest,
  createApprovalSubject,
  createGrantChallenge,
} from '../src/modules/authority/grant-core.ts';
import {
  createTransitionRegistry,
  type TransitionDefinition,
} from '../src/modules/authority/grant-transition-registry.ts';
import {
  assertPlanReviewSubject,
  planReviewSubjectDigest,
} from '../src/modules/assurance/plan-review.ts';

const vectors = loadWorkflowConformanceVectorsV2();

test('conformance storage preserves plain-file bounds and malformed JSON errors', (t) => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'conformance-storage-'),
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'vectors.json');
  fs.writeFileSync(file, JSON.stringify(vectors));
  assert.deepEqual(
    loadWorkflowConformanceVectorsV2({ vectorPath: file }),
    vectors,
  );
  const alias = path.join(directory, 'alias.json');
  fs.symlinkSync(file, alias);
  for (const vectorPath of [
    directory,
    alias,
    path.join(directory, 'missing'),
  ]) {
    assert.throws(
      () => loadWorkflowConformanceVectorsV2({ vectorPath }),
      /bounded plain file/,
    );
  }
  for (const bytes of ['', ' '.repeat(1024 * 1024 + 1)]) {
    fs.writeFileSync(file, bytes);
    assert.throws(
      () => loadWorkflowConformanceVectorsV2({ vectorPath: file }),
      /bounded plain file/,
    );
  }
  fs.writeFileSync(file, '{');
  assert.throws(
    () => loadWorkflowConformanceVectorsV2({ vectorPath: file }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        'Workflow conformance vectors are malformed JSON.',
      );
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    },
  );
});

test('v2 vectors anchor canonical JSON, digest identity, trailers, and journal records', () => {
  const canonical = first('canonical-json');
  assert.equal(canonicalJson(canonical.input), canonical.canonical);

  const digest = first('digest-identity');
  assert.equal(sha256(String(digest.utf8)), digest.digest);

  const trailer = first('managed-trailer');
  assert.deepEqual(
    parseManagedTrailers(String(trailer.message)),
    trailer.parsed,
  );
  const centralTrailer = vectors.domains['managed-trailer'].find(
    ({ id }) => id === 'managed-central-authority-trailer',
  );
  assert.ok(centralTrailer);
  assert.deepEqual(
    parseManagedTrailers(String(centralTrailer.message)),
    centralTrailer.parsed,
  );
  const partialCentralTrailer = vectors.domains['managed-trailer'].find(
    ({ id }) => id === 'managed-central-authority-partial-rejected',
  );
  assert.ok(partialCentralTrailer);
  assert.equal(partialCentralTrailer.outcome, 'reject');
  assert.throws(
    () => parseManagedTrailers(String(partialCentralTrailer.message)),
    /non-canonical managed trailer/u,
  );

  const journal = first('journal-record');
  assert.equal(canonicalJson(journal.record), journal.canonical);
  assert.equal(sha256(String(journal.canonical)), journal.digest);
});

test('v2 vectors bind Manifest v3 identity to the separate PlanReview subject', () => {
  const vector = first('manifest-plan-review');
  const subject = vector.subject as Parameters<
    typeof planReviewSubjectDigest
  >[0];
  assert.equal(planReviewSubjectDigest(subject), vector.subjectDigest);
  const replay = {
    schemaVersion: 1,
    subjectDigest: vector.subjectDigest,
    ...subject,
  };
  assert.deepEqual(assertPlanReviewSubject(replay), replay);
  assert.throws(
    () =>
      assertPlanReviewSubject({
        ...replay,
        manifestDigest: vector.mismatchedManifestDigest,
      }),
    /digest does not match/u,
  );
});

test('v2 vectors anchor Central Grant challenge, ApprovalSubject, and registered transition identities', () => {
  const vector = first('central-grant');
  const request = vector.request as {
    sourceModuleId: string;
    failureCode: string;
    facts: unknown;
    stateBinding: { kind: string; digest: `sha256:${string}` };
    candidate: {
      transitionId: string;
      parameters: unknown;
      allowedReasonCodes: readonly string[];
      reasonRequired: boolean;
      proposedReason: string;
    };
  };
  const registryVector = vector.registry as {
    parameterSchemaDigest: `sha256:${string}`;
    consequenceDigest: `sha256:${string}`;
    resolutionKind: 'non-retry';
    allowedApprovalMethods: readonly ('human-presence' | 'ssh')[];
  };
  const definition: TransitionDefinition<{ resume: true }> = {
    transitionId: request.candidate.transitionId,
    ...registryVector,
    validateParameters(value: unknown) {
      assert.deepEqual(value, { resume: true });
      return value as { resume: true };
    },
    renderTrustedChoice() {
      return {
        title: 'Resume vector',
        consequences: ['Resume the exact vector transition.'],
      };
    },
    observeState() {
      return request.stateBinding;
    },
    async execute() {
      return { outcome: 'completed' as const, details: { ok: true } };
    },
  };
  const registry = createTransitionRegistry([definition]);
  const challenge = createGrantChallenge(
    {
      sourceModuleId: request.sourceModuleId,
      failureCode: request.failureCode,
      facts: request.facts,
      stateBinding: request.stateBinding,
      candidates: [request.candidate],
    },
    registry,
    {
      challengeId: String(vector.challengeId),
      now: new Date(String(vector.issuedAt)),
      expiresAt: String(vector.expiresAt),
    },
  );
  assert.equal(challenge.challengeDigest, vector.challengeDigest);
  assert.equal(challenge.choices[0]!.choiceId, vector.choiceId);
  const subject = createApprovalSubject(
    challenge,
    {
      choiceId: challenge.choices[0]!.choiceId,
      approvalMethod: 'human-presence',
      reasonCode: request.candidate.allowedReasonCodes[0]!,
      reason: 'Approve the exact vector transition.',
      sessionNonce: String(vector.sessionNonce),
    },
    { now: new Date(String(vector.issuedAt)) },
  );
  assert.equal(approvalSubjectDigest(subject), vector.approvalSubjectDigest);
  const grantRecord = {
    schemaVersion: 1,
    kind: 'grant-record.v1',
    state: 'pending',
    challenge,
    recordedAt: challenge.issuedAt,
  };
  assert.equal(canonicalJson(grantRecord), canonicalJson(vector.grantRecord));
  assert.equal(canonicalJson(grantRecord), vector.grantRecordCanonical);
  assert.equal(
    `sha256:${sha256(String(vector.grantRecordCanonical))}`,
    vector.grantRecordDigest,
  );
  assert.throws(
    () => registry.resolve('unknown-vector-transition'),
    /not registered/u,
  );
});

test('v2 vectors bind the current Collaboration Grant reader and reject retired payloads', () => {
  const vector = firstRecord('collaboration-grant-envelope');
  assert.equal(
    COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
    vector.readerContractVersion,
  );
  assert.equal(
    selectCollaborationGrantSignatureNamespaceV1({
      version: vector.payloadVersion,
      signatureNamespace: vector.signatureNamespace,
    } as never),
    COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  );
  assert.equal(
    vector.signatureNamespace,
    COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  );
  assert.equal(vector.unsupportedVersionOutcome, 'reject');
  for (const version of [vector.retiredVersion, vector.unknownVersion]) {
    assert.throws(
      () =>
        selectCollaborationGrantSignatureNamespaceV1({
          version,
        } as never),
      /unsupported/u,
      String(version),
    );
  }
});

test('the tracked Collaboration Grant schema is exact current V2', () => {
  const raw = fs.readFileSync(
    path.join(
      import.meta.dirname,
      '../../../workflow/schemas/collaboration-grant.schema.json',
    ),
    'utf8',
  );
  const schema = JSON.parse(raw) as {
    properties: {
      payload: {
        required: string[];
        properties: Record<
          string,
          { const?: unknown; enum?: unknown[]; oneOf?: unknown[] }
        >;
        allOf: unknown[];
      };
    };
    $defs: {
      contentAdmission: {
        properties: { kind: { enum: unknown[] } };
      };
    };
  };
  const payload = schema.properties.payload;
  assert.deepEqual(payload.required, [
    'version',
    'signatureNamespace',
    'grantId',
    'repositoryId',
    'repositoryOrigin',
    'policyBlob',
    'collaborationPolicyDigest',
    'changeId',
    'taskId',
    'baselineCommit',
    'baselineTree',
    'targetDigest',
    'lifecyclePhase',
    'rolePair',
    'availableActor',
    'degradedForm',
    'authorizedEffect',
    'reason',
    'issuedAt',
    'expiresAt',
    'maxUses',
    'signer',
  ]);
  assert.equal(payload.properties.version?.const, 2);
  assert.equal(
    payload.properties.signatureNamespace?.const,
    COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
  );
  assert.deepEqual(payload.properties.lifecyclePhase?.enum, [
    'blind-survey',
    'plan-review',
    'task-diff-review',
    'task-implementation',
  ]);
  assert.deepEqual(payload.properties.collaborationPolicyDigest?.enum, [
    'bb689839bcaa521293058978dc8e3a1e7666dd47b2e2c07cdeb622fbb1fad7b4',
    '70a46206375649f3d2bf07fff13b6d2dbf36c79c449ebd5e08dd8d95d1b14bbd',
  ]);
  assert.deepEqual(
    (payload.allOf.slice(0, 4) as PhaseSchemaRule[]).map((rule) => ({
      phase: rule.if.properties.lifecyclePhase.const,
      policyDigest: rule.then.properties.collaborationPolicyDigest.const,
      authorRole: rule.then.properties.rolePair.properties.authorRole.const,
      conflictingRole:
        rule.then.properties.rolePair.properties.conflictingRole.const,
    })),
    [
      {
        phase: 'blind-survey',
        policyDigest:
          'bb689839bcaa521293058978dc8e3a1e7666dd47b2e2c07cdeb622fbb1fad7b4',
        authorRole: 'investigation-author',
        conflictingRole: 'plan-reviewer',
      },
      {
        phase: 'plan-review',
        policyDigest:
          'bb689839bcaa521293058978dc8e3a1e7666dd47b2e2c07cdeb622fbb1fad7b4',
        authorRole: 'plan-author',
        conflictingRole: 'plan-reviewer',
      },
      {
        phase: 'task-diff-review',
        policyDigest:
          '70a46206375649f3d2bf07fff13b6d2dbf36c79c449ebd5e08dd8d95d1b14bbd',
        authorRole: 'task-implementer',
        conflictingRole: 'task-diff-reviewer',
      },
      {
        phase: 'task-implementation',
        policyDigest:
          'bb689839bcaa521293058978dc8e3a1e7666dd47b2e2c07cdeb622fbb1fad7b4',
        authorRole: 'red-author',
        conflictingRole: 'task-implementer',
      },
    ],
  );
  const directHuman = (payload.allOf as DegradedFormSchemaRule[]).find(
    (rule) => rule.if.properties.degradedForm?.const === 'direct-human-review',
  );
  assert.deepEqual(directHuman?.then.properties.lifecyclePhase?.enum, [
    'plan-review',
    'task-diff-review',
  ]);
  assert.deepEqual(schema.$defs.contentAdmission.properties.kind.enum, [
    'blind-survey',
    'plan-review',
    'task-diff-review',
    'task-implementation',
  ]);
  assert.doesNotMatch(raw, /workflow\.collaboration-grant\.v1/u);
  assert.doesNotMatch(
    raw,
    /fead45158ecbb42192deddac55e7b0becc3d1daafa2347b14ab977080dd98f77/u,
  );
});

type PhaseSchemaRule = {
  if: { properties: { lifecyclePhase: { const: string } } };
  then: {
    properties: {
      collaborationPolicyDigest: { const: string };
      rolePair: {
        properties: {
          authorRole: { const: string };
          conflictingRole: { const: string };
        };
      };
    };
  };
};

type DegradedFormSchemaRule = {
  if: { properties: { degradedForm?: { const: string } } };
  then: { properties: { lifecyclePhase?: { enum: string[] } } };
};

function firstRecord(domain: string): Record<string, unknown> {
  const domains = vectors.domains as Readonly<
    Record<string, readonly Record<string, unknown>[]>
  >;
  const vector = domains[domain]?.[0];
  assert.ok(vector, domain);
  return vector;
}

test('v2 vectors anchor wrapper frames, engine receipt, and planning binding digest', () => {
  const protocol = first('agent-protocol-frame');
  const frames = protocol.frames as ProviderWrapperFrame[];
  assert.deepEqual(frames.map(renderProviderWrapperFrame), protocol.rendered);
  const parser = createProviderWrapperProtocolParser({
    binding: protocol.binding as ProviderWrapperProtocolBinding,
  });
  for (const line of protocol.rendered as string[]) {
    parser.push(Buffer.from(line));
  }
  assert.equal(
    parser.finish({ cancellationForced: false }).receiptDigest,
    protocol.receiptDigest,
  );

  const planning = first('planning-binding');
  const binding = planning.binding as PlanningProviderBindingV1;
  assert.equal(planningProviderBindingDigest(binding), planning.digest);
  assert.deepEqual(
    parsePlanningProviderBinding(
      renderPlanningProviderBinding(binding),
      binding.changeId,
    ),
    binding,
  );
  assert.throws(
    () =>
      parsePlanningProviderBinding(
        `${JSON.stringify(
          {
            ...binding,
            schemaVersion: 2,
          },
          null,
          2,
        )}\n`,
        binding.changeId,
      ),
    /schema version/u,
  );
});

function first(domain: keyof typeof vectors.domains): Record<string, unknown> {
  return vectors.domains[domain][0] as Record<string, unknown>;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

const cliPath = path.join(
  sourceRepositoryRoot,
  'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
);

test('jigwright verifies the public language-neutral conformance corpus', () => {
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      cliPath,
      'boundary',
      'vectors',
      '--check',
      '--json',
    ],
    { cwd: sourceRepositoryRoot, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const output = JSON.parse(run.stdout) as {
    result: {
      kind: string;
      status: string;
      domainCount: number;
      vectorSetDigest: string;
    };
  };
  assert.deepEqual(output.result, {
    kind: 'jigwright.conformance-vectors-check.v1',
    status: 'current',
    domainCount: 9,
    vectorSetDigest:
      'sha256:b2113b55d86f6fd83cac7a1f3c62cea5df3b27a9feb0e5df5be011de694b089a',
  });
});
