import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import { canonicalJson } from '@jigwright/core/canonical-json';
import { loadWorkflowConformanceVectorsV2 } from '@jigwright/core/conformance-vectors';
import {
  parsePlanningProviderBinding,
  planningProviderBindingDigest,
  renderPlanningProviderBinding,
  type PlanningProviderBindingV1,
} from '@jigwright/core/planning-provider-binding';
import { parseManagedTrailers } from '@jigwright/core/managed-transition-trailers';
import {
  createProviderWrapperProtocolParser,
  renderProviderWrapperFrame,
  type ProviderWrapperFrame,
  type ProviderWrapperProtocolBinding,
} from '@jigwright/agent-runtime/harness-jsonl-v1';
import {
  COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
  COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
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

test('v2 vectors preserve the legacy SSH namespace reader without fallback', () => {
  const vector = first('legacy-ssh-envelope');
  assert.equal(
    COLLABORATION_GRANT_ENVELOPE_READER_CONTRACT_VERSION_V1,
    vector.readerContractVersion,
  );
  assert.equal(
    selectCollaborationGrantSignatureNamespaceV1({ version: 1 }),
    vector.signatureNamespace,
  );
  assert.equal(
    selectCollaborationGrantSignatureNamespaceV1({
      version: 2,
      signatureNamespace: COLLABORATION_GRANT_V2_SIGNATURE_NAMESPACE,
    }),
    vector.currentNamespace,
  );
  assert.equal(
    COLLABORATION_GRANT_V1_SIGNATURE_NAMESPACE,
    vector.signatureNamespace,
  );
  assert.throws(
    () =>
      selectCollaborationGrantSignatureNamespaceV1({
        version: vector.unknownVersion,
      } as never),
    /unsupported/u,
  );
});

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
