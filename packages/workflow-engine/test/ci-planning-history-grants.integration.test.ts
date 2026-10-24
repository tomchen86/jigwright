import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { managedDocuments } from '../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );
/** Immutable historical planning Grant claims and duplicate-use detection. */
import test from 'node:test';
import {
  collectCurrentCollaborationGrantUses,
  collectHistoricalCollaborationGrantUses,
  validateCiPlanningCommit,
} from '../src/composition-root/ci-replay-production.ts';
import assert from 'node:assert/strict';
import { git, isWorkflowError } from './fixture.ts';
import fs from 'node:fs';
import { assertUniqueCollaborationGrantUses } from '../src/runtime/grants/grant-services.ts';
import path from 'node:path';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/runtime/planning-transition/planning-transition.ts';
import { prepareCurrentV3IntroductionRepository } from './ci-planning-assurance-fixture.ts';
import {
  writeRetiredInvestigationArtifact,
  writeGrantClaim,
  writeRoleContextSharingClaim,
  writePlanReviewWithoutRole,
  appendSyntheticGrantRoleResult,
  syntheticGrantedRoleResult,
} from './ci-planning-history-fixture.ts';
import {
  commitPlan,
  CHANGE_ID,
  commit,
  changeDirectory,
  write,
} from './ci-planning-fixture.ts';

test('CI collects current v3 Manifest grant identities from semanticDelta', () => {
  const collaborationUse = {
    kind: 'collaboration-grant-use-identity.v1',
    grantId: '20202020-2020-4020-8020-202020202020',
    signedEnvelopeDigest: '2'.repeat(64),
    transitionDigest: '3'.repeat(64),
  };
  const roleContextSharingUse = {
    kind: 'role-context-sharing-use-identity.v1',
    grantId: '40404040-4040-4040-8040-404040404040',
    signedEnvelopeDigest: '5'.repeat(64),
    transitionDigest: '6'.repeat(64),
    useProjectionDigest: '7'.repeat(64),
    admissionDigest: '8'.repeat(64),
  };
  const planReviewUse = {
    grantId: '90909090-9090-4090-8090-909090909090',
    signedEnvelopeDigest: 'a'.repeat(64),
    transitionDigest: 'b'.repeat(64),
  };

  const uses = collectCurrentCollaborationGrantUses({
    investigation: {
      manifest: {
        applicability: {
          kind: 'ordinary',
          semanticDelta: {
            investigationRoleResults: [
              {
                grantUse: collaborationUse,
                roleContextSharingUse: null,
              },
              {
                grantUse: null,
                roleContextSharingUse,
              },
            ],
          },
        },
      },
    },
    planReview: { roleResults: [{ grantUse: planReviewUse }] },
  } as never);

  assert.deepEqual(uses, [
    {
      grantId: collaborationUse.grantId,
      signedEnvelopeDigest: collaborationUse.signedEnvelopeDigest,
      transitionDigest: collaborationUse.transitionDigest,
    },
    {
      grantId: roleContextSharingUse.grantId,
      signedEnvelopeDigest: roleContextSharingUse.signedEnvelopeDigest,
      transitionDigest: roleContextSharingUse.transitionDigest,
      useProjectionDigest: roleContextSharingUse.useProjectionDigest,
      admissionDigest: roleContextSharingUse.admissionDigest,
    },
    planReviewUse,
  ]);
});

test('CI rejects retired investigation schemas in immutable planning history', async (t) => {
  for (const schemaVersion of [1, 2] as const) {
    await t.test(`schema version ${schemaVersion}`, () => {
      const repository = prepareCurrentV3IntroductionRepository();
      try {
        writeRetiredInvestigationArtifact(repository, schemaVersion);
        commitPlan(repository);

        assert.throws(
          () =>
            collectHistoricalCollaborationGrantUses(
              repository,
              git(repository, ['rev-parse', 'HEAD']).trim(),
              CHANGE_ID,
            ),
          (error) =>
            isWorkflowError(error, 'CI_PLANNING_GRANT_HISTORY_INVALID'),
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }
});

test('CI collects a collaboration grant claimed by two historical plan transitions', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    writeGrantClaim(repository, {
      grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      signedEnvelopeDigest: 'b'.repeat(64),
      transitionDigest: 'c'.repeat(64),
    });
    commitPlan(repository);

    writeGrantClaim(repository, {
      grantId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      signedEnvelopeDigest: 'e'.repeat(64),
      transitionDigest: 'f'.repeat(64),
    });
    commit(repository, 'Record an alternate review generation');

    writeGrantClaim(repository, {
      grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      signedEnvelopeDigest: 'b'.repeat(64),
      transitionDigest: 'c'.repeat(64),
    });
    commitPlan(repository);

    const uses = collectHistoricalCollaborationGrantUses(
      repository,
      git(repository, ['rev-parse', 'HEAD']).trim(),
      CHANGE_ID,
    );
    assert.equal(uses.length, 2);
    assert.throws(
      () => assertUniqueCollaborationGrantUses(uses),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_DUPLICATE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects one R-007 signed envelope claimed by two historical plan transitions', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  const grantId = '91919191-9191-4191-8191-919191919191';
  try {
    writeRoleContextSharingClaim(repository, grantId);
    commitPlan(repository);

    writeRoleContextSharingClaim(
      repository,
      '82828282-8282-4282-8282-828282828282',
    );
    commit(repository, 'Record an alternate R-007 generation');

    writeRoleContextSharingClaim(repository, grantId);
    commitPlan(repository);

    const uses = collectHistoricalCollaborationGrantUses(
      repository,
      git(repository, ['rev-parse', 'HEAD']).trim(),
      CHANGE_ID,
    );
    assert.equal(uses.length, 2);
    assert.throws(
      () => assertUniqueCollaborationGrantUses(uses),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_DUPLICATE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects two distinct R-007 grants that claim one exact terminal use', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    writeRoleContextSharingClaim(
      repository,
      '73737373-7373-4373-8373-737373737373',
    );
    commitPlan(repository);

    writeRoleContextSharingClaim(
      repository,
      '64646464-6464-4464-8464-646464646464',
    );
    commitPlan(repository);

    const uses = collectHistoricalCollaborationGrantUses(
      repository,
      git(repository, ['rev-parse', 'HEAD']).trim(),
      CHANGE_ID,
    );
    assert.equal(uses.length, 2);
    assert.notEqual(uses[0]!.grantId, uses[1]!.grantId);
    assert.notEqual(
      uses[0]!.signedEnvelopeDigest,
      uses[1]!.signedEnvelopeDigest,
    );
    assert.throws(
      () => assertUniqueCollaborationGrantUses(uses),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_DUPLICATE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI keeps a side-branch grant claim hidden by a TREESAME merge', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    writePlanReviewWithoutRole(repository);
    commit(repository, 'Record the common planning evidence');
    const commonPlanReview = fs.readFileSync(
      path.join(changeDirectory(repository), 'plan-review.json'),
      'utf8',
    );

    git(repository, ['checkout', '-b', 'side-review']);
    writeGrantClaim(repository, {
      grantId: '77777777-7777-4777-8777-777777777777',
      signedEnvelopeDigest: '8'.repeat(64),
      transitionDigest: '9'.repeat(64),
    });
    commitPlan(repository);

    git(repository, ['checkout', 'main']);
    write(repository, 'main.txt', 'main divergence\n');
    commit(repository, 'Diverge the main line');
    git(repository, ['merge', '--no-ff', '--no-commit', 'side-review']);
    fs.writeFileSync(
      path.join(changeDirectory(repository), 'plan-review.json'),
      commonPlanReview,
    );
    git(repository, ['add', '-A']);
    git(repository, ['commit', '-m', 'Merge and restore planning evidence']);

    writeGrantClaim(repository, {
      grantId: '77777777-7777-4777-8777-777777777777',
      signedEnvelopeDigest: '8'.repeat(64),
      transitionDigest: '9'.repeat(64),
    });
    commitPlan(repository);

    const uses = collectHistoricalCollaborationGrantUses(
      repository,
      git(repository, ['rev-parse', 'HEAD']).trim(),
      CHANGE_ID,
    );
    assert.equal(uses.length, 2);
    assert.throws(
      () => assertUniqueCollaborationGrantUses(uses),
      (error) => isWorkflowError(error, 'COLLABORATION_GRANT_USE_DUPLICATE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI accepts distinct grants across managed planning transitions', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    writeGrantClaim(repository, {
      grantId: '12121212-1212-4121-8121-121212121212',
      signedEnvelopeDigest: '3'.repeat(64),
      transitionDigest: '4'.repeat(64),
    });
    commitPlan(repository);
    writeGrantClaim(repository, {
      grantId: '56565656-5656-4565-8565-565656565656',
      signedEnvelopeDigest: '7'.repeat(64),
      transitionDigest: '8'.repeat(64),
    });
    commitPlan(repository);

    const uses = collectHistoricalCollaborationGrantUses(
      repository,
      git(repository, ['rev-parse', 'HEAD']).trim(),
      CHANGE_ID,
    );
    assert.equal(uses.length, 2);
    assert.doesNotThrow(() => assertUniqueCollaborationGrantUses(uses));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI treats current role-free planning history as zero grant claims', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    writePlanReviewWithoutRole(repository);
    commitPlan(repository);
    assert.deepEqual(
      collectHistoricalCollaborationGrantUses(
        repository,
        git(repository, ['rev-parse', 'HEAD']).trim(),
        CHANGE_ID,
      ),
      [],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI collects a PlanReview grant from a current v3 plan transition', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  const reviewUse = {
    grantId: '67676767-6767-4676-8676-676767676767',
    signedEnvelopeDigest: '8'.repeat(64),
    transitionDigest: '9'.repeat(64),
  };
  try {
    appendSyntheticGrantRoleResult(
      repository,
      'plan-review.json',
      syntheticGrantedRoleResult('plan-reviewer', reviewUse, 'b'),
    );
    const plan = commitPlanningTransition(repository, 'demo-change');

    assert.deepEqual(
      validateCiPlanningCommit(repository, plan.commitHash, 'demo-change')
        .collaborationGrantUses,
      [reviewUse],
    );
    assert.deepEqual(
      collectHistoricalCollaborationGrantUses(
        repository,
        plan.commitHash,
        'demo-change',
      ),
      [reviewUse],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
