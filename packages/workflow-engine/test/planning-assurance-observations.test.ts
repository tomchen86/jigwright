import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  planningAssuranceDependencies,
  productionPlanningAssurance,
} from '../src/composition-root/planning-assurance-production.ts';
import { loadChangeContract } from '../src/composition-root/consumer-contract-production.ts';
import {
  deriveInvestigationFirstPlanningSubject,
  validateInvestigationFirstPlanningReadiness,
} from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  resolvePlanReviewRepositoryEvidence,
  resolvePlanReviewPlanningEvidence,
} from '../src/modules/assurance/planning-assurance-evidence.ts';
import type {
  PlanningAssuranceDependencies,
  PlanningAssuranceEvidenceObservations,
} from '../src/modules/assurance/planning-assurance-observations.ts';
import { createPlanReviewNode } from '../src/modules/assurance/plan-review.ts';
import {
  createFixtureRepository,
  writeReadyV3ExemptChange,
  ordinaryPlanReviewReplayPortForTest,
  isWorkflowError,
} from './fixture.ts';
import {
  reviewContext,
  providerResultFor,
  challengeSubmission,
  planningTargetFor,
} from './plan-review-contract-fixture.ts';

const unreachable = (): never => {
  throw new Error('Unexpected observation');
};

function reviewWithEvidence(
  evidence: ReturnType<
    typeof challengeSubmission
  >['findings'][number]['evidence'],
) {
  const context = reviewContext();
  const submission = challengeSubmission();
  submission.findings[0]!.evidence = evidence;
  return createPlanReviewNode({
    subject: context.subject,
    assignment: context.assignment,
    providerResultNode: providerResultFor(context, submission),
    submission,
  });
}

test('planning subject evaluates memory artifacts after repository removal and preserves incremental reads', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    const contract = loadChangeContract(repository, 'demo-change');
    const expected = productionPlanningAssurance.deriveSubject(
      repository,
      contract,
    );
    const artifacts = new Map(
      contract.artifactPaths.map((file) => [
        path.relative(repository, file),
        fs.readFileSync(file, 'utf8'),
      ]),
    );
    const schemas = new Map(
      ['guard', 'execution-artifact', 'investigation-manifest-v3'].map(
        (name) => {
          const filename = `workflow/schemas/${name}.schema.json`;
          return [
            filename,
            crypto
              .createHash('sha256')
              .update(fs.readFileSync(path.join(repository, filename), 'utf8'))
              .digest('hex'),
          ];
        },
      ),
    );
    const calls: string[] = [];
    const dependencies: PlanningAssuranceDependencies = {
      ...planningAssuranceDependencies,
      readCurrentSchema() {
        calls.push('schema');
        return contract.schemaName;
      },
      readPlanningArtifact(_root, artifactPath) {
        calls.push(artifactPath);
        const content = artifacts.get(artifactPath);
        assert.notEqual(content, undefined);
        return content!;
      },
      readPlanningSchemaDigest(_root, schemaPath) {
        calls.push(schemaPath);
        const digest = schemas.get(schemaPath);
        assert.notEqual(digest, undefined);
        return digest!;
      },
      readRepositoryCitation: unreachable,
      readPlanningSnapshotOrigin: unreachable,
      readPlanningSnapshotArtifact: unreachable,
      loadMaintainerPolicyAtCommit: unreachable,
      readCoverageTarget: unreachable,
    };
    fs.rmSync(repository, { recursive: true, force: true });
    assert.deepEqual(
      deriveInvestigationFirstPlanningSubject(
        dependencies,
        repository,
        contract,
        null,
      ),
      expected,
    );
    const changeRoot = path.relative(repository, contract.changeDirectory);
    assert.deepEqual(calls.slice(0, 7), [
      'schema',
      `${changeRoot}/design.md`,
      `${changeRoot}/proposal.md`,
      `${changeRoot}/tasks.md`,
      'workflow/schemas/guard.schema.json',
      'workflow/schemas/execution-artifact.schema.json',
      'workflow/schemas/investigation-manifest-v3.schema.json',
    ]);
    calls.length = 0;
    const stop = new Error('design observation failed');
    assert.throws(
      () =>
        deriveInvestigationFirstPlanningSubject(
          {
            ...dependencies,
            readPlanningArtifact(_root, p) {
              calls.push(p);
              throw stop;
            },
          },
          repository,
          contract,
          null,
        ),
      (error) => error === stop,
    );
    assert.deepEqual(calls, ['schema', `${changeRoot}/design.md`]);
    calls.length = 0;
    let schemaReads = 0;
    assert.throws(
      () =>
        validateInvestigationFirstPlanningReadiness(
          {
            ...dependencies,
            readCurrentSchema() {
              calls.push('schema');
              return ++schemaReads === 1
                ? contract.schemaName
                : 'changed-schema';
            },
          },
          repository,
          contract,
          ordinaryPlanReviewReplayPortForTest,
          null,
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_NOT_READY'),
    );
    assert.deepEqual(calls, ['schema', 'schema']);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('repository citation rules deduplicate and sort observations and reject planning namespace before reading', () => {
  const review = reviewWithEvidence([
    {
      kind: 'repository-location',
      path: 'z.ts',
      line: 1,
      observation: 'Second file',
    },
    {
      kind: 'repository-location',
      path: 'a.ts',
      line: 1,
      observation: 'First file',
    },
    {
      kind: 'repository-location',
      path: 'a.ts',
      line: 2,
      observation: 'Same exact blob',
    },
  ]);
  const calls: string[] = [];
  const observations: PlanningAssuranceEvidenceObservations = {
    readRepositoryCitation(root, tree, p) {
      calls.push(`${root}:${tree}:${p}`);
      return {
        blobOid: 'a'.repeat(40),
        content: p === 'a.ts' ? 'one\ntwo\n' : '',
      };
    },
    readPlanningSnapshotOrigin: unreachable,
    readPlanningSnapshotArtifact: unreachable,
  };
  assert.deepEqual(
    resolvePlanReviewRepositoryEvidence(
      observations,
      'memory',
      'pinned-tree',
      review,
    ),
    {
      tree: 'pinned-tree',
      locations: [
        { path: 'a.ts', blobOid: 'a'.repeat(40), lineCount: 2 },
        { path: 'z.ts', blobOid: 'a'.repeat(40), lineCount: 0 },
      ],
    },
  );
  assert.deepEqual(calls, [
    'memory:pinned-tree:a.ts',
    'memory:pinned-tree:z.ts',
  ]);
  const snapshot = planningTargetFor(reviewContext(), 'proposal.md', 'text\n');
  const planningPath = snapshot.artifacts[0]!.path;
  calls.length = 0;
  const invalid = reviewWithEvidence([
    {
      kind: 'repository-location',
      path: planningPath,
      line: 1,
      observation: 'Wrong namespace',
    },
  ]);
  assert.throws(
    () =>
      resolvePlanReviewRepositoryEvidence(
        observations,
        'memory',
        'pinned-tree',
        invalid,
        snapshot,
      ),
    (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_NOT_READY'),
  );
  assert.deepEqual(calls, []);
});

test('planning snapshot origin is re-observed before bytes and mismatching uncited artifacts fail immediately', () => {
  const content = Buffer.from('planning\n');
  const snapshot = planningTargetFor(
    reviewContext(),
    'proposal.md',
    content.toString('utf8'),
  );
  const first = snapshot.artifacts[0]!;
  const last = {
    ...first,
    path: first.path.replace('proposal.md', 'design.md'),
    snapshotFile: '0001.artifact',
  };
  const withUncited = { ...snapshot, artifacts: [first, last] };
  const review = reviewWithEvidence([
    {
      kind: 'planning-location',
      path: first.path,
      line: 1,
      observation: 'Exact planning bytes',
    },
  ]);
  const calls: string[] = [];
  const observations: PlanningAssuranceEvidenceObservations = {
    readRepositoryCitation: unreachable,
    readPlanningSnapshotOrigin(_root, observed) {
      assert.equal(observed, withUncited);
      calls.push('origin');
      return 'commit';
    },
    readPlanningSnapshotArtifact(_root, commit, p) {
      assert.equal(commit, 'commit');
      calls.push(p);
      return content;
    },
  };
  const expected = {
    snapshotDigest: withUncited.snapshotDigest,
    locations: [
      {
        path: first.path,
        sha256: first.sha256,
        byteLength: first.byteLength,
        lineCount: first.lineCount,
      },
    ],
  };
  for (let i = 0; i < 2; i++)
    assert.deepEqual(
      resolvePlanReviewPlanningEvidence(
        observations,
        'memory',
        withUncited,
        review,
      ),
      expected,
    );
  assert.deepEqual(calls, [
    'origin',
    first.path,
    last.path,
    'origin',
    first.path,
    last.path,
  ]);
  calls.length = 0;
  assert.throws(
    () =>
      resolvePlanReviewPlanningEvidence(
        {
          ...observations,
          readPlanningSnapshotArtifact(_root, _commit, p) {
            calls.push(p);
            return Buffer.from('mismatch');
          },
        },
        'memory',
        withUncited,
        review,
      ),
    (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_NOT_READY'),
  );
  assert.deepEqual(calls, ['origin', first.path]);
  const originFailure = new Error('origin is ambiguous');
  calls.length = 0;
  assert.throws(
    () =>
      resolvePlanReviewPlanningEvidence(
        {
          ...observations,
          readPlanningSnapshotOrigin() {
            calls.push('origin');
            throw originFailure;
          },
        },
        'memory',
        withUncited,
        review,
      ),
    (error) => error === originFailure,
  );
  assert.deepEqual(calls, ['origin']);
});
