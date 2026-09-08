import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import {
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  createPlanReviewTargetSnapshotNode,
  readPlanReviewTargetSnapshotNode,
} from '../src/modules/assurance/plan-review.ts';
import { validatePlanReview } from '../src/modules/assurance/plan-review-validation.ts';
import {
  resolvePlanReviewPlanningEvidence,
  resolvePlanReviewRepositoryEvidence,
} from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  createCurrentPlanReviewProviderEvidenceForTest,
  createFixtureRepository,
  git,
} from './fixture.ts';
import {
  DIGESTS,
  reviewContext,
  providerResultFor,
  challengeSubmission,
  currentValidationInput,
  planningTargetFor,
  isWorkflowError,
} from './plan-review-contract-fixture.ts';

test('planning citation namespace is exact and rejects absent or out-of-range snapshot locations', () => {
  const context = reviewContext();
  const planningPath = 'openspec/changes/demo-change/proposal.md';
  const planningTarget = planningTargetFor(
    context,
    'proposal.md',
    '# Proposal\n\nPreserve the behavior.\n',
  );
  const planningArtifact = planningTarget.artifacts[0]!;
  const submission = challengeSubmission({
    findings: [
      {
        kind: 'challenge',
        severity: 'high',
        category: 'missing-scope',
        currentChangeImpact: 'required',
        summary: 'The exact planning proposal requires review.',
        evidence: [
          {
            kind: 'planning-location',
            path: planningPath,
            line: planningArtifact.lineCount,
            observation:
              'The immutable planning snapshot carries this requirement.',
          },
        ],
      },
    ],
  });
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: providerResultFor(context, submission),
    submission,
  });
  const input = currentValidationInput(context, reviewNode);
  const valid = validatePlanReview({
    ...input,
    planningTarget,
    planningEvidence: {
      snapshotDigest: planningTarget.snapshotDigest,
      locations: [
        {
          path: planningPath,
          sha256: planningArtifact.sha256,
          byteLength: planningArtifact.byteLength,
          lineCount: planningArtifact.lineCount,
        },
      ],
    },
  });
  assert.equal(valid.current, true);
  assert.equal(valid.eligible, true);

  for (const locations of [
    [],
    [
      {
        path: planningPath,
        sha256: 'f'.repeat(64),
        byteLength: 110,
        lineCount: 11,
      },
    ],
  ]) {
    const rejected = validatePlanReview({
      ...input,
      planningTarget,
      planningEvidence: {
        snapshotDigest: planningTarget.snapshotDigest,
        locations,
      },
    });
    assert.equal(rejected.current, false);
    assert.equal(rejected.eligible, false);
    assert.ok(rejected.staleReasons.includes('REPOSITORY_EVIDENCE_MISMATCH'));
  }
});

test('repository-location cannot cite a planning snapshot member', () => {
  const context = reviewContext();
  const planningPath = 'openspec/changes/demo-change/proposal.md';
  const submission = challengeSubmission({
    findings: [
      {
        kind: 'challenge',
        severity: 'high',
        category: 'missing-scope',
        currentChangeImpact: 'required',
        summary: 'The exact planning proposal requires review.',
        evidence: [
          {
            kind: 'repository-location',
            path: planningPath,
            line: 1,
            observation: 'This deliberately uses the wrong namespace.',
          },
        ],
      },
    ],
  });
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: providerResultFor(context, submission),
    submission,
  });
  assert.throws(
    () =>
      resolvePlanReviewRepositoryEvidence(
        '/unused',
        'a'.repeat(40),
        reviewNode,
        {
          artifacts: [{ path: planningPath }],
        } as never,
      ),
    (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_NOT_READY'),
  );
});

test('resolved review evidence uses canonical UTF-8 path ordering', () => {
  const repository = createFixtureRepository();
  const bmpPath = 'docs/\ue000.md';
  const astralPath = 'docs/\u{10000}.md';
  try {
    fs.mkdirSync(path.join(repository, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repository, bmpPath), 'BMP path\n');
    fs.writeFileSync(path.join(repository, astralPath), 'Astral path\n');
    git(repository, ['add', '--', bmpPath, astralPath]);
    git(repository, ['commit', '-m', 'Add Unicode evidence paths']);
    const tree = git(repository, ['rev-parse', 'HEAD^{tree}']).trim();
    const context = reviewContext();
    const submission = challengeSubmission({
      findings: [
        {
          kind: 'challenge',
          severity: 'high',
          category: 'missing-scope',
          currentChangeImpact: 'required',
          summary: 'The BMP evidence path must remain canonical.',
          evidence: [
            {
              kind: 'repository-location',
              path: bmpPath,
              line: 1,
              observation: 'This path sorts first by UTF-8 bytes.',
            },
          ],
        },
        {
          kind: 'challenge',
          severity: 'high',
          category: 'missing-consumers',
          currentChangeImpact: 'required',
          summary: 'The astral evidence path must remain canonical.',
          evidence: [
            {
              kind: 'repository-location',
              path: astralPath,
              line: 1,
              observation: 'This path sorts second by UTF-8 bytes.',
            },
          ],
        },
      ],
    });
    const reviewNode = createPlanReviewNode({
      subject: context.subject,
      assignment: context.assignment,
      providerResultNode: providerResultFor(context, submission),
      submission,
    });

    assert.deepEqual(
      resolvePlanReviewRepositoryEvidence(
        repository,
        tree,
        reviewNode,
      ).locations.map(({ path: evidencePath }) => evidencePath),
      [bmpPath, astralPath],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('resolved planning evidence uses canonical UTF-8 path ordering', () => {
  const repository = createFixtureRepository();
  const bmpRelative = '\ue000.md';
  const astralRelative = '\u{10000}.md';
  const changePrefix = 'openspec/changes/demo-change';
  const contents = new Map<string, Buffer>([
    ['.openspec.yaml', Buffer.from('schema: expense-app-v2\n')],
    [bmpRelative, Buffer.from('BMP path\n')],
    [astralRelative, Buffer.from('Astral path\n')],
  ]);
  try {
    const context = reviewContext();
    const materializationNode = createEvidenceNode({
      type: 'propose-planning-materialization',
      nodeSchema: 'test.utf8-materialization.v1',
      evaluator: 'test.utf8-materialization.v1',
      policyDigest: DIGESTS.reviewPolicy,
      exactInputDigests: {},
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'test.utf8-materialization-output.v1',
      output: { testOnly: true },
      runtimeMetadata: {},
    });
    const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
      changeId: 'demo-change',
      changePrefix,
      subject: context.subject,
      materializationNode,
      artifacts: contents,
    });
    const targetSnapshot = readPlanReviewTargetSnapshotNode(targetSnapshotNode);
    for (const [relativePath, content] of contents) {
      const absolutePath = path.join(repository, changePrefix, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content, { mode: 0o644 });
    }
    const bmpPath = `${changePrefix}/${bmpRelative}`;
    const astralPath = `${changePrefix}/${astralRelative}`;
    const submission = challengeSubmission({
      findings: [
        {
          kind: 'challenge',
          severity: 'high',
          category: 'missing-scope',
          currentChangeImpact: 'required',
          summary: 'The BMP planning path must remain canonical.',
          evidence: [
            {
              kind: 'planning-location',
              path: bmpPath,
              line: 1,
              observation: 'This path sorts first by UTF-8 bytes.',
            },
          ],
        },
        {
          kind: 'challenge',
          severity: 'high',
          category: 'missing-consumers',
          currentChangeImpact: 'required',
          summary: 'The astral planning path must remain canonical.',
          evidence: [
            {
              kind: 'planning-location',
              path: astralPath,
              line: 1,
              observation: 'This path sorts second by UTF-8 bytes.',
            },
          ],
        },
      ],
    });
    const providerEvidence = createCurrentPlanReviewProviderEvidenceForTest({
      subject: context.subject,
      assignment: context.assignment,
      submission,
      targetSnapshotNode,
      policyDigest: DIGESTS.reviewPolicy,
      runtimeObservation: 'current',
    });
    const providerResultNode = createPlanReviewProviderResultNode({
      subject: context.subject,
      assignment: context.assignment,
      request: providerEvidence.request,
      result: providerEvidence.result,
      targetSnapshotNode,
    });
    const reviewNode = createPlanReviewNode({
      subject: context.subject,
      assignment: context.assignment,
      providerResultNode,
      submission,
    });

    assert.deepEqual(
      resolvePlanReviewPlanningEvidence(
        repository,
        targetSnapshot,
        reviewNode,
      ).locations.map(({ path: evidencePath }) => evidencePath),
      [bmpPath, astralPath],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('planning-location cannot cite a nonmember repository path', () => {
  const repositoryRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'plan-review-namespace-'),
  );
  const planningPath = 'openspec/changes/demo-change/proposal.md';
  const planningBytes = Buffer.from('# Proposal\n');
  const absolutePlanningPath = path.join(repositoryRoot, planningPath);
  fs.mkdirSync(path.dirname(absolutePlanningPath), { recursive: true });
  fs.writeFileSync(absolutePlanningPath, planningBytes, { mode: 0o644 });
  try {
    const context = reviewContext();
    const submission = challengeSubmission({
      findings: [
        {
          kind: 'challenge',
          severity: 'high',
          category: 'missing-scope',
          currentChangeImpact: 'required',
          summary: 'A repository file is mislabeled as planning evidence.',
          evidence: [
            {
              kind: 'planning-location',
              path: 'docs/WORKFLOW.md',
              line: 1,
              observation: 'This deliberately uses the wrong namespace.',
            },
          ],
        },
      ],
    });
    const reviewNode = createPlanReviewNode({
      subject: context.subject,
      assignment: context.assignment,
      providerResultNode: providerResultFor(context, submission),
      submission,
    });
    assert.throws(
      () =>
        resolvePlanReviewPlanningEvidence(
          repositoryRoot,
          {
            artifacts: [
              {
                path: planningPath,
                sha256: crypto
                  .createHash('sha256')
                  .update(planningBytes)
                  .digest('hex'),
                byteLength: planningBytes.byteLength,
                lineCount: 1,
              },
            ],
          } as never,
          reviewNode,
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_NOT_READY'),
    );
  } finally {
    fs.rmSync(repositoryRoot, { recursive: true, force: true });
  }
});
