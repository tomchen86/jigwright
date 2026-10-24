/** Synthetic historical Grant claims and retired artifact fixtures. */
import { createEvidenceNode } from '../src/foundation/evidence-node/evidence-node.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { refreshFixturePlanReview } from './ci-planning-assurance-fixture.ts';
import { write, CHANGE_ID } from './ci-planning-fixture.ts';

export function writeGrantClaim(
  repository: string,
  use: {
    grantId: string;
    signedEnvelopeDigest: string;
    transitionDigest: string;
  },
): void {
  refreshFixturePlanReview(repository);
  appendSyntheticGrantRoleResult(repository, 'plan-review.json', {
    grantUse: use,
  });
}

export function writePlanReviewWithoutRole(repository: string): void {
  const reviewNode = createEvidenceNode({
    type: 'fixture-plan-review',
    nodeSchema: 'fixture.plan-review.v1',
    evaluator: 'fixture.plan-review.v1',
    policyDigest: '1'.repeat(64),
    exactInputDigests: { target: '2'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.plan-review-output.v1',
    output: { verdict: 'advisory-approve' },
    runtimeMetadata: {},
  });
  write(
    repository,
    `openspec/changes/${CHANGE_ID}/plan-review.json`,
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'plan-review-artifact',
      changeId: CHANGE_ID,
      nodes: [reviewNode],
      currentRefs: { planReview: reviewNode.nodeId },
    })}\n`,
  );
}

function writeRetiredV1InvestigationArtifact(repository: string): void {
  const surveyNode = createEvidenceNode({
    type: 'fixture-blind-survey',
    nodeSchema: 'fixture.blind-survey.v1',
    evaluator: 'fixture.blind-survey.v1',
    policyDigest: '7'.repeat(64),
    exactInputDigests: { target: '8'.repeat(64) },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.blind-survey-output.v1',
    output: { complete: true },
    runtimeMetadata: {},
  });
  write(
    repository,
    `openspec/changes/${CHANGE_ID}/investigation.json`,
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'investigation-artifact',
      changeId: CHANGE_ID,
      legacyMigration: false,
      nodes: [surveyNode],
      currentRefs: { blindSurvey: surveyNode.nodeId },
      roleResults: [
        {
          grantUse: {
            grantId: '10101010-1010-4010-8010-101010101010',
            signedEnvelopeDigest: '2'.repeat(64),
            transitionDigest: '3'.repeat(64),
          },
        },
      ],
    })}\n`,
  );
}

export function writeRetiredInvestigationArtifact(
  repository: string,
  schemaVersion: 1 | 2,
): void {
  writeRetiredV1InvestigationArtifact(repository);
  if (schemaVersion === 1) return;

  const artifactPath = path.join(
    repository,
    `openspec/changes/${CHANGE_ID}/investigation.json`,
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<
    string,
    unknown
  >;
  artifact.schemaVersion = 2;
  artifact.replay = {
    schemaVersion: 1,
    kind: 'git-backed-investigation-replay',
  };
  fs.writeFileSync(artifactPath, `${canonicalJson(artifact)}\n`);
}

export function writeRoleContextSharingClaim(
  repository: string,
  grantId: string,
): void {
  const targetDigest = 'a'.repeat(64);
  const envelope = {
    payload: {
      version: 1,
      signatureNamespace: 'workflow.role-context-sharing-grant.v1',
      grantId,
      repositoryId: 'github:R_fixture',
      repositoryOrigin: 'https://github.com/example/fixture.git',
      policyBlob: 'b'.repeat(40),
      roleContextSharingPolicyDigest: 'c'.repeat(64),
      centralRoleConfigurationDigest: 'd'.repeat(64),
      changeOverrideDigest: 'e'.repeat(64),
      providerRegistryDigest: 'f'.repeat(64),
      eligibilityPolicyDigest: '1'.repeat(64),
      changeId: CHANGE_ID,
      taskId: null,
      baselineCommit: '2'.repeat(40),
      baselineTree: '3'.repeat(40),
      targetDigest,
      lifecyclePhase: 'plan-review',
      subjectDigest: targetDigest,
      planningGeneration: '4'.repeat(64),
      rolePairs: ['author-reviewer'],
      contextGeneration: 1,
      sessionGeneration: 1,
      sharedEngineSessionId: 'fixture-shared-engine-session',
      providerDefinitionDigest: '5'.repeat(64),
      authorizedEffect: 'role-context-sharing-degradation',
      reason: 'Exercise immutable R-007 history-wide uniqueness.',
      issuedAt: '2026-08-21T00:00:00.000Z',
      expiresAt: '2026-08-21T00:30:00.000Z',
      maxUses: 1,
      signer: 'fixture-maintainer',
    },
    signature: 'fixture-signature',
  };
  refreshFixturePlanReview(repository);
  appendSyntheticGrantRoleResult(repository, 'plan-review.json', {
    grantUse: null,
    roleContextSharingUse: {
      kind: 'role-context-sharing-consumed-use.v1',
      grantId,
      envelope,
      expectedBinding: { targetDigest },
      useProjectionDigest: crypto
        .createHash('sha256')
        .update(canonicalJson({ admissionDigest: '9'.repeat(64) }))
        .digest('hex'),
      use: { admissionDigest: '9'.repeat(64) },
    },
  });
}

export function appendSyntheticGrantRoleResult(
  repository: string,
  artifactName: 'investigation.json' | 'plan-review.json',
  roleResult: unknown,
): void {
  const artifactPath = path.join(
    repository,
    'openspec/changes/demo-change',
    artifactName,
  );
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as {
    roleResults?: unknown[];
  };
  artifact.roleResults = [...(artifact.roleResults ?? []), roleResult];
  fs.writeFileSync(artifactPath, `${canonicalJson(artifact)}\n`);
}

export function syntheticGrantedRoleResult(
  role: 'plan-reviewer' | 'plan-reviewer',
  grantUse: {
    grantId: string;
    signedEnvelopeDigest: string;
    transitionDigest: string;
  },
  digestDigit: string,
): unknown {
  const digest = digestDigit.repeat(64);
  const contentKind = role === 'plan-reviewer' ? 'blind-survey' : 'plan-review';
  return {
    schemaVersion: 1,
    form: 'granted-caller-supplied',
    role,
    targetDigest: digest,
    assignment: {},
    author: {},
    participant: {},
    orchestration: 'caller-supplied',
    requiredIndependence: 'provider-independent',
    achievedIndependence: 'none',
    content: {
      kind: contentKind,
      nodeId: digest,
      resultDigest: digest,
      outputSchema: {
        id: `fixture.${contentKind}.v1`,
        version: 1,
        digest,
      },
      evaluator: `fixture.${contentKind}.v1`,
      policyDigest: digest,
      contentDigest: digest,
      current: true,
    },
    providerInvocation: null,
    grantUse,
    directHumanReviewAttestation: null,
    resultDigest: digest,
  };
}
