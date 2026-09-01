import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { renderPlanningProviderBinding } from '../src/modules/planning-provider/planning-provider-binding.ts';
import {
  createCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
  type CentralRoleProviderDefaultV1,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import {
  agentRolePlanV2Digest,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import { assertUniqueCollaborationGrantUses } from '../src/modules/authority/collaboration-grant.ts';
import {
  collectCurrentCollaborationGrantUses,
  collectHistoricalCollaborationGrantUses,
  validateCiPlanningCommit,
} from '../src/entrypoints/ci/ci-planning.ts';
import { loadHistoricalTaskAuthority } from '../src/entrypoints/ci/ci-historical-contract.ts';
import { loadChangeContract } from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import {
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  createPlanReviewTargetSnapshotNode,
  PLAN_REVIEW_COVERAGE,
} from '../src/modules/assurance/plan-review.ts';
import { deriveInvestigationFirstPlanningSubject } from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  buildInvestigationManifestDraft,
  sealInvestigationManifestDraft,
  type InvestigationManifestV3,
} from '../src/modules/investigation/manifest/investigation-manifest.ts';
import { investigationManifestPublicationNamespace } from '../src/runtime/managed-documents/transaction/investigation-publication.ts';
import { commitPlanningTransition } from '../src/application/propose/planning-transition.ts';
import { admitRoleResult } from '../src/modules/provider-orchestration/role-scheduler.ts';
import { agentRolePlanV2Path } from '../src/modules/source/planning-role-policy-paths.ts';
import { CENTRAL_ROLE_PROVIDER_DEFAULT_PATH } from '../src/runtime/repository-transaction/central-role-provider-default-store.ts';
import {
  createFixtureRepository,
  createCurrentPlanReviewProviderEvidenceForTest,
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

const CHANGE_ID = 'demo-change';

test('CI planning task replay crosses the production planning composition root', () => {
  const ciPlanningSource = fs.readFileSync(
    new URL('../src/entrypoints/ci/ci-planning.ts', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(
    ciPlanningSource,
    /adapters\/planning\/openspec\/documents\/planning-contract/u,
  );
  for (const helper of [
    'amendmentLeftWorkMarkedDone',
    'assertPlanningTaskHistory',
    'taskStates',
  ]) {
    assert.match(ciPlanningSource, new RegExp(`\\b${helper}\\b`, 'u'));
  }
});

function overrideCentralConfiguration(
  ranking: readonly string[] = ['claude', 'codex'],
): CentralRoleProviderDefaultV1 {
  return createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: [
      {
        roles: ['author'],
        sessionGroups: [['author']],
        providerRule: { kind: 'adaptive-author' },
      },
      {
        roles: ['builder'],
        sessionGroups: [['builder']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: null,
        },
      },
      {
        roles: ['reviewer'],
        sessionGroups: [['reviewer']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: ranking[0]!,
        },
      },
    ],
    globalProviderRanking: [...ranking],
  });
}

function writeOverrideCentralConfiguration(
  repository: string,
  configuration = overrideCentralConfiguration(),
): void {
  fs.writeFileSync(
    path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH),
    renderCentralRoleProviderDefault(configuration),
  );
}

function writeAgentRolePlanV2(
  repository: string,
  changeId: string,
  baseCentralConfigurationDigest: string,
): void {
  const body: AgentRolePlanBodyV2 = {
    schemaVersion: 2,
    changeId,
    baseCentralConfigurationDigest,
    roleLanes: [],
    pairwiseRequirements: [],
    customWrapperPolicy: 'forbidden',
    grantReferences: [],
  };
  const destination = path.join(repository, agentRolePlanV2Path(changeId));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(
    destination,
    renderAgentRolePlanV2({
      ...body,
      planDigest: agentRolePlanV2Digest(body),
    }),
  );
}

function writePlanningProviderBindingForChange(
  repository: string,
  changeId: string,
): void {
  write(
    repository,
    `workflow/change-providers/${changeId}.json`,
    renderPlanningProviderBinding({
      schemaVersion: 1,
      changeId,
      providerId: 'openspec',
      adapterContractVersion: 1,
      providerRequirement: {
        package: '@fission-ai/openspec',
        version: '1.6.0',
      },
      planningRoot: `openspec/changes/${changeId}`,
    }),
  );
}

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

test('CI replays a configured current schema from immutable consumer config', () => {
  const repository = prepareCurrentV3IntroductionRepository({
    currentSchemaName: 'orbit-spec-v1',
  });
  try {
    const consumerPath = path.join(
      repository,
      'workflow/repository-consumer.json',
    );
    const consumer = JSON.parse(fs.readFileSync(consumerPath, 'utf8')) as {
      planning: {
        requiredSchemaNames: string[];
        supportedSchemaNames: string[];
        managedSchemaNames: string[];
        currentSchemaName: string;
      };
    };
    const plan = commitPlanningTransition(repository, 'demo-change');
    const replay = validateCiPlanningCommit(
      repository,
      plan.commitHash,
      'demo-change',
    );
    assert.equal(replay.schemaName, 'orbit-spec-v1');
    assert.equal(
      replay.planningAssurance?.planningGenerationId,
      plan.planningAssurance?.planningGenerationId,
    );

    consumer.planning.currentSchemaName = 'untrusted-checkout-schema';
    fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);
    assert.equal(
      validateCiPlanningCommit(repository, plan.commitHash, 'demo-change')
        .schemaName,
      'orbit-spec-v1',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects v3 planning assurance whose baseline is not the exact plan parent tree', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    refreshFixturePlanReview(repository);

    fs.appendFileSync(
      path.join(repository, 'README.md'),
      '\nAdvance parent.\n',
    );
    git(repository, ['add', '--', 'README.md']);
    git(repository, ['commit', '-m', 'Advance planning parent']);

    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    const plan = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, plan, 'demo-change'),
      (error) => isWorkflowError(error, 'CI_PLANNING_BASELINE_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI committed v3 replay rejects a stale PlanReview without private-ref fallback', () => {
  const repository = createFixtureRepository();
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    refreshFixturePlanReview(repository);
    const planReviewPath = path.join(
      repository,
      'openspec/changes/demo-change/plan-review.json',
    );
    const stalePlanReview = fs.readFileSync(planReviewPath);

    fs.appendFileSync(path.join(repository, 'README.md'), '\nNew baseline.\n');
    git(repository, ['add', '--', 'README.md']);
    git(repository, ['commit', '-m', 'Advance Manifest baseline']);
    writeReadyV3ExemptChange(repository);
    fs.writeFileSync(planReviewPath, stalePlanReview);

    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-m',
      'Plan demo-change',
      '-m',
      'Change: demo-change\nTransition: plan',
    ]);
    const plan = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, plan, 'demo-change'),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_NOT_READY'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI refuses package-schema planning history before provider or task replay', () => {
  const repository = createPackageSchemaRepository();
  try {
    writePackageSchemaPlanningTree(repository, '- [x] 1.1 Already complete');
    const plan = commitPlan(repository);

    assert.throws(
      () => validateCiPlanningCommit(repository, plan, CHANGE_ID),
      (error) => isWorkflowError(error, 'OPENSPEC_MANAGED_SCHEMA_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a current-schema parent missing a required artifact even when the revision repairs it', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  const changeId = CHANGE_ID;
  try {
    commitPlanningTransition(repository, changeId);

    fs.rmSync(
      path.join(repository, 'openspec/changes', changeId, 'execution.json'),
    );
    commit(repository, 'Admit incomplete current planning tree');

    writeReadyV3ExemptChange(repository, changeId);
    refreshFixturePlanReview(repository);
    const revision = commitPlanningTransition(repository, changeId);

    assert.throws(
      () => validateCiPlanningCommit(repository, revision.commitHash, changeId),
      (error) => isWorkflowError(error, 'CI_PLANNING_TREE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI accepts an exact planning introduction reconstructed from Git', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    const plan = commitPlanningTransition(repository, CHANGE_ID);
    const replay = validateCiPlanningCommit(
      repository,
      plan.commitHash,
      CHANGE_ID,
    );

    assert.equal(replay.changeId, CHANGE_ID);
    assert.equal(replay.kind, 'introduction');
    assert.equal(replay.beforeTasks, undefined);
    assert.deepEqual(replay.afterTasks, [{ id: '1.1', completed: false }]);
    assert.deepEqual(replay.changedPaths, plan.changedPaths);
    assert.equal(replay.schemaName, 'jigwright');
    assert.equal(
      replay.planningAssurance?.planningGenerationId,
      plan.planningAssurance?.planningGenerationId,
    );
    assert.deepEqual(replay.collaborationGrantUses, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current planning and immutable CI reject dangling or noncanonical governance origins without mutation', () => {
  const originPath = `openspec/changes/${CHANGE_ID}/origin.json`;
  const cases = [
    {
      name: 'dangling Source citation',
      bytes: `${canonicalJson({
        schemaVersion: 1,
        sourceRefs: [`SRC-${'f'.repeat(64)}`],
        workItemRefs: [],
      })}\n`,
    },
    {
      name: 'noncanonical bytes',
      bytes: `${JSON.stringify(
        { schemaVersion: 1, sourceRefs: [], workItemRefs: [] },
        null,
        2,
      )}\n`,
    },
  ] as const;

  for (const scenario of cases) {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      write(repository, originPath, scenario.bytes);
      const beforeHead = git(repository, ['rev-parse', 'HEAD']).trim();
      const beforeStatus = git(repository, ['status', '--porcelain=v1', '-z']);

      assert.throws(
        () => commitPlanningTransition(repository, CHANGE_ID),
        (error) => isWorkflowError(error, 'WORK_REGISTRY_INVALID'),
        scenario.name,
      );
      assert.equal(
        fs.readFileSync(path.join(repository, originPath), 'utf8'),
        scenario.bytes,
      );
      assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), beforeHead);
      assert.equal(
        git(repository, ['status', '--porcelain=v1', '-z']),
        beforeStatus,
      );

      const invalidCommit = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, invalidCommit, CHANGE_ID),
        (error) => isWorkflowError(error, 'WORK_REGISTRY_INVALID'),
        scenario.name,
      );
      assert.equal(
        execFileSync('git', ['show', `${invalidCommit}:${originPath}`], {
          cwd: repository,
          encoding: 'utf8',
        }),
        scenario.bytes,
      );
      assert.equal(
        git(repository, ['rev-parse', 'HEAD']).trim(),
        invalidCommit,
      );
      assert.equal(git(repository, ['status', '--porcelain=v1', '-z']), '');
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('CI replays task authority from an immutable current-schema planning introduction', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    const plan = commitPlanningTransition(repository, CHANGE_ID);

    const authority = loadHistoricalTaskAuthority(
      repository,
      plan.commitHash,
      CHANGE_ID,
      '1.1',
    );

    assert.equal(authority.taskId, '1.1');
    assert.deepEqual(authority.requiredChecks, ['fixture']);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays a v2 agent-role override first added by the planning introduction', () => {
  const repository = createFixtureRepository();
  const changeId = 'demo-change';
  const changeBackup = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ci-agent-role-plan-change-'),
  );
  try {
    const central = overrideCentralConfiguration();
    const changePath = path.join(repository, 'openspec/changes', changeId);
    const backupPath = path.join(changeBackup, changeId);
    fs.cpSync(changePath, backupPath, { recursive: true });
    fs.rmSync(changePath, {
      recursive: true,
      force: true,
    });
    fs.rmSync(
      path.join(repository, `workflow/change-providers/${changeId}.json`),
      { force: true },
    );
    write(
      repository,
      'openspec/changes/other-change/keep.md',
      'Unrelated baseline change container.\n',
    );
    writeOverrideCentralConfiguration(repository, central);
    git(repository, ['add', '-A']);
    git(repository, [
      'commit',
      '-q',
      '-m',
      'Prepare absent change with central role provider default',
    ]);

    git(repository, ['checkout', '-b', `work/${changeId}`]);
    fs.cpSync(backupPath, changePath, { recursive: true });
    writeReadyV3ExemptChange(repository);
    writePlanningProviderBindingForChange(repository, changeId);
    writeAgentRolePlanV2(repository, changeId, central.configurationDigest);
    refreshFixturePlanReview(repository);
    const plan = commitPlanningTransition(repository, changeId);

    assert.equal(
      plan.changedPaths.includes(agentRolePlanV2Path(changeId)),
      true,
    );
    const replay = validateCiPlanningCommit(
      repository,
      plan.commitHash,
      changeId,
    );
    assert.equal(replay.kind, 'introduction');
    assert.equal(
      replay.changedPaths.includes(agentRolePlanV2Path(changeId)),
      true,
    );
    assert.equal(
      replay.planningAssurance?.planningGenerationId,
      plan.planningAssurance?.planningGenerationId,
    );

    writeOverrideCentralConfiguration(
      repository,
      overrideCentralConfiguration(['codex', 'claude']),
    );
    assert.equal(
      validateCiPlanningCommit(repository, plan.commitHash, changeId)
        .planningAssurance?.planningGenerationId,
      plan.planningAssurance?.planningGenerationId,
      'CI replay must ignore mutable worktree configuration',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(changeBackup, { recursive: true, force: true });
  }
});

test('CI fails closed when a committed central configuration drifts from the v2 override base', () => {
  const repository = createFixtureRepository();
  const changeId = 'demo-change';
  try {
    const central = overrideCentralConfiguration();
    writeOverrideCentralConfiguration(repository, central);
    git(repository, ['add', CENTRAL_ROLE_PROVIDER_DEFAULT_PATH]);
    git(repository, [
      'commit',
      '-q',
      '-m',
      'Add central role provider default',
    ]);
    git(repository, ['checkout', '-b', `work/${changeId}`]);
    writeReadyV3ExemptChange(repository);
    writeAgentRolePlanV2(repository, changeId, central.configurationDigest);
    refreshFixturePlanReview(repository);
    const revision = commitPlanningTransition(repository, changeId);
    assert.equal(revision.kind, 'revision');
    assert.equal(
      revision.changedPaths.includes(agentRolePlanV2Path(changeId)),
      true,
    );

    writeOverrideCentralConfiguration(
      repository,
      overrideCentralConfiguration(['codex', 'claude']),
    );
    git(repository, ['add', CENTRAL_ROLE_PROVIDER_DEFAULT_PATH]);
    git(repository, [
      'commit',
      '-q',
      '-m',
      'Change central role provider default',
    ]);
    fs.appendFileSync(
      path.join(repository, 'openspec/changes', changeId, 'design.md'),
      '\nCommitted central drift.\n',
    );
    git(repository, ['add', `openspec/changes/${changeId}/design.md`]);
    git(repository, [
      'commit',
      '-q',
      '-m',
      `Plan ${changeId}`,
      '-m',
      `Change: ${changeId}\nTransition: plan`,
    ]);
    const drift = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, drift, changeId),
      (error) => isWorkflowError(error, 'AGENT_ROLE_PLAN_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays an explicit planning-provider binding from the planning commit', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    const plan = commitPlanningTransition(repository, CHANGE_ID);

    const result = validateCiPlanningCommit(
      repository,
      plan.commitHash,
      CHANGE_ID,
    );
    assert.equal(result.kind, 'introduction');
    assert.deepEqual(result.changedPaths, plan.changedPaths);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI refuses changing the exact planning-provider binding', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(repository, CHANGE_ID);

    writeProviderBinding(repository, { providerId: 'spectra' });
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'proposal.md'),
      '\nForged provider replacement.\n',
    );
    writeReadyV3ExemptChange(repository, CHANGE_ID);
    refreshFixturePlanReview(repository);
    const revision = commitPlan(repository);
    assert.throws(
      () => validateCiPlanningCommit(repository, revision, CHANGE_ID),
      (error) => isWorkflowError(error, 'PROVIDER_MIGRATION_UNSUPPORTED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI refuses a planning introduction without its explicit provider binding', () => {
  const repository = prepareCurrentV3IntroductionRepository({
    includeProviderBinding: false,
  });
  try {
    const plan = commitPlan(repository);
    assert.throws(
      () => validateCiPlanningCommit(repository, plan, CHANGE_ID),
      (error) => isWorkflowError(error, 'PROVIDER_BINDING_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI accepts a revision that reorders and removes unfinished tasks', () => {
  const repository = prepareCurrentV3IntroductionRepository({
    tasks: [
      '- [ ] 1.1 First task',
      '- [ ] 1.2 Removable task',
      '- [ ] 1.3 Completed task',
    ].join('\n'),
  });
  try {
    commitPlanningTransition(repository, CHANGE_ID);
    writeCurrentTasksAndGuard(
      repository,
      [
        '- [ ] 1.1 First task',
        '- [ ] 1.2 Removable task',
        '- [x] 1.3 Completed task',
      ].join('\n'),
    );
    commit(repository, 'Complete fixture task');

    writeCurrentTasksAndGuard(
      repository,
      [
        '- [x] 1.3 Completed task',
        '- [ ] 1.1 First task',
        '- [ ] 2.1 New task',
      ].join('\n'),
    );
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'design.md'),
      '\nRevision.\n',
    );
    writeReadyV3ExemptChange(repository, CHANGE_ID);
    refreshFixturePlanReview(repository);
    const revision = commitPlanningTransition(repository, CHANGE_ID);
    const replay = validateCiPlanningCommit(
      repository,
      revision.commitHash,
      CHANGE_ID,
    );

    assert.equal(replay.kind, 'revision');
    assert.deepEqual(replay.beforeTasks, [
      { id: '1.1', completed: false },
      { id: '1.2', completed: false },
      { id: '1.3', completed: true },
    ]);
    assert.deepEqual(replay.afterTasks, [
      { id: '1.3', completed: true },
      { id: '1.1', completed: false },
      { id: '2.1', completed: false },
    ]);
    assert.deepEqual(replay.changedPaths, revision.changedPaths);
    assert.equal(replay.schemaName, 'jigwright');
    assert.equal(
      replay.planningAssurance?.planningGenerationId,
      revision.planningAssurance?.planningGenerationId,
    );
    assert.deepEqual(replay.collaborationGrantUses, []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a checked task in a planning introduction or revision', async (t) => {
  await t.test('introduction', () => {
    const repository = prepareCurrentV3IntroductionRepository({
      tasks: '- [x] 1.1 Already complete',
    });
    try {
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'PLANNING_TASK_STATE_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('revision', () => {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      commitPlanningTransition(repository, CHANGE_ID);
      writeCurrentTasksAndGuard(repository, '- [x] 1.1 Illegally completed');
      writeReadyV3ExemptChange(repository, CHANGE_ID);
      refreshFixturePlanReview(repository);
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'PLANNING_TASK_STATE_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});

test('CI rejects code, base specs, archives, and another change in a plan', async (t) => {
  const cases = [
    ['code', 'src/feature.ts'],
    ['base spec', 'openspec/specs/demo/spec.md'],
    ['archive', `openspec/changes/archive/2026-07-15-${CHANGE_ID}/proposal.md`],
    ['another change', 'openspec/changes/other-change/proposal.md'],
    ['dependency manifest', 'package.json'],
  ] as const;

  for (const [label, extraPath] of cases) {
    await t.test(label, () => {
      const repository = prepareCurrentV3IntroductionRepository();
      try {
        write(repository, extraPath, `${label}\n`);
        const commitHash = commitPlan(repository);
        assert.throws(
          () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
          (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
        );
      } finally {
        fs.rmSync(repository, { recursive: true, force: true });
      }
    });
  }
});

test('CI rejects symlink and executable planning artifacts from the Git tree', async (t) => {
  await t.test('symlink', () => {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      const designPath = path.join(changeDirectory(repository), 'design.md');
      fs.rmSync(designPath);
      fs.symlinkSync('proposal.md', designPath);
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_COMMITTED_CHECKOUT_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('executable', () => {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      fs.chmodSync(path.join(changeDirectory(repository), 'design.md'), 0o755);
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_COMMITTED_CHECKOUT_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});

test('CI rejects an incomplete planning tree and a non-canonical plan message', async (t) => {
  await t.test('missing required artifact', () => {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      fs.rmSync(path.join(changeDirectory(repository), 'execution.json'));
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'MISSING_CHANGE_ARTIFACT'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('wrong subject', () => {
    const repository = prepareCurrentV3IntroductionRepository();
    try {
      const commitHash = commitPlan(repository, 'Revise plan');
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_PLANNING_MESSAGE_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});

test('CI rejects a merge commit even when it uses the plan message', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(repository, CHANGE_ID);
    git(repository, ['checkout', '-b', 'side']);
    write(repository, 'side.txt', 'side\n');
    commit(repository, 'Add side branch');
    git(repository, ['checkout', `work/${CHANGE_ID}`]);
    write(repository, 'main.txt', 'main\n');
    commit(repository, 'Advance planning branch');
    git(repository, [
      'merge',
      '--no-ff',
      'side',
      '-m',
      `Plan ${CHANGE_ID}`,
      '-m',
      `Change: ${CHANGE_ID}\nTransition: plan`,
    ]);
    const merge = git(repository, ['rev-parse', 'HEAD']).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, merge, CHANGE_ID),
      (error) => isWorkflowError(error, 'CI_PLANNING_NON_LINEAR'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createPackageSchemaRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-ci-planning-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  write(repository, 'README.md', '# Fixture\n');
  for (const relativePath of [
    'workflow/config.json',
    'workflow/repository-consumer.json',
  ]) {
    write(
      repository,
      relativePath,
      fs.readFileSync(path.join(sourceRepositoryRoot, relativePath), 'utf8'),
    );
  }
  commit(repository, 'Create fixture');
  return repository;
}

function writePackageSchemaPlanningTree(
  repository: string,
  tasks = '- [ ] 1.1 Demo task',
): void {
  const prefix = `openspec/changes/${CHANGE_ID}`;
  write(repository, `${prefix}/.openspec.yaml`, 'schema: spec-driven\n');
  write(repository, `${prefix}/proposal.md`, '# Proposal\n');
  write(repository, `${prefix}/design.md`, '# Design\n');
  writeTasks(repository, tasks);
  write(repository, `${prefix}/guard.json`, '{}\n');
  write(
    repository,
    `${prefix}/specs/demo/spec.md`,
    '# Delta\n\n## ADDED Requirements\n',
  );
}

function prepareCurrentV3IntroductionRepository(
  options: {
    currentSchemaName?: string;
    includeProviderBinding?: boolean;
    tasks?: string;
  } = {},
): string {
  const repository = createFixtureRepository();
  const backupRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'ci-current-v3-introduction-'),
  );
  const changePath = path.join(repository, 'openspec/changes', CHANGE_ID);
  const backupPath = path.join(backupRoot, CHANGE_ID);
  try {
    fs.cpSync(changePath, backupPath, { recursive: true });
    fs.rmSync(changePath, { recursive: true, force: true });
    fs.rmSync(
      path.join(repository, `workflow/change-providers/${CHANGE_ID}.json`),
      { force: true },
    );
    write(
      repository,
      'openspec/changes/other-change/keep.md',
      'Unrelated baseline change container.\n',
    );
    if (options.currentSchemaName !== undefined) {
      configureFixtureCurrentSchema(repository, options.currentSchemaName);
    }
    commit(repository, 'Prepare absent current change');

    git(repository, ['checkout', '-b', `work/${CHANGE_ID}`]);
    fs.cpSync(backupPath, changePath, { recursive: true });
    if (options.tasks !== undefined) {
      writeCurrentTasksAndGuard(repository, options.tasks);
    }
    writeReadyV3ExemptChange(repository, CHANGE_ID, options.currentSchemaName);
    writePlanningProviderBindingForChange(repository, CHANGE_ID);
    refreshFixturePlanReview(repository);
    if (options.includeProviderBinding === false) {
      fs.rmSync(
        path.join(repository, `workflow/change-providers/${CHANGE_ID}.json`),
      );
    }
    return repository;
  } catch (error) {
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  } finally {
    fs.rmSync(backupRoot, { recursive: true, force: true });
  }
}

function configureFixtureCurrentSchema(
  repository: string,
  currentSchemaName: string,
): void {
  const consumerPath = path.join(
    repository,
    'workflow/repository-consumer.json',
  );
  const consumer = JSON.parse(fs.readFileSync(consumerPath, 'utf8')) as {
    planning: {
      requiredSchemaNames: string[];
      supportedSchemaNames: string[];
      managedSchemaNames: string[];
      currentSchemaName: string;
    };
  };
  consumer.planning.requiredSchemaNames = ['spec-driven', currentSchemaName];
  consumer.planning.supportedSchemaNames = ['spec-driven', currentSchemaName];
  consumer.planning.managedSchemaNames = [currentSchemaName];
  consumer.planning.currentSchemaName = currentSchemaName;
  fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);

  const openSpecConfigPath = path.join(repository, 'openspec/config.yaml');
  fs.writeFileSync(
    openSpecConfigPath,
    fs
      .readFileSync(openSpecConfigPath, 'utf8')
      .replace(/^schema: jigwright$/m, `schema: ${currentSchemaName}`),
  );
  fs.cpSync(
    path.join(repository, 'openspec/schemas/jigwright'),
    path.join(repository, 'openspec/schemas', currentSchemaName),
    { recursive: true },
  );
  const namedSchemaPath = path.join(
    repository,
    'openspec/schemas',
    currentSchemaName,
    'schema.yaml',
  );
  fs.writeFileSync(
    namedSchemaPath,
    fs
      .readFileSync(namedSchemaPath, 'utf8')
      .replace(/^name: jigwright$/m, `name: ${currentSchemaName}`),
  );
}

function writeProviderBinding(
  repository: string,
  overrides: Partial<Parameters<typeof renderPlanningProviderBinding>[0]> = {},
): void {
  const binding = {
    schemaVersion: 1 as const,
    changeId: CHANGE_ID,
    providerId: 'openspec',
    adapterContractVersion: 1,
    providerRequirement: {
      package: '@fission-ai/openspec',
      version: '1.6.0',
    },
    planningRoot: `openspec/changes/${CHANGE_ID}`,
    ...overrides,
  };
  write(
    repository,
    `workflow/change-providers/${CHANGE_ID}.json`,
    renderPlanningProviderBinding(binding),
  );
}

function writeTasks(repository: string, tasks: string): void {
  write(
    repository,
    `openspec/changes/${CHANGE_ID}/tasks.md`,
    `# Tasks\n\n${tasks}\n`,
  );
}

function writeCurrentTasksAndGuard(repository: string, tasks: string): void {
  writeTasks(repository, tasks);
  const taskIds = [...tasks.matchAll(/^- \[[ x]\] (\d+(?:\.\d+)*)\b/gm)].map(
    (match) => match[1]!,
  );
  assert.equal(new Set(taskIds).size, taskIds.length);
  assert.equal(taskIds.length > 0, true);
  const guardPath = path.join(changeDirectory(repository), 'guard.json');
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    schemaVersion: 1;
    changeId: string;
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  guard.tasks = Object.fromEntries(
    taskIds.map((taskId) => [
      taskId,
      { allowedPaths: ['src/**'], requiredChecks: ['fixture'] },
    ]),
  );
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
}

function writeGrantClaim(
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

function writePlanReviewWithoutRole(repository: string): void {
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

function writeRetiredInvestigationArtifact(
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

function writeRoleContextSharingClaim(
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

function mktree(repository: string, listing: string): string {
  return execFileSync('git', ['-C', repository, 'mktree'], {
    encoding: 'utf8',
    input: listing,
  }).trim();
}

function replaceTreeEntry(
  repository: string,
  treeRef: string,
  name: string,
  newHash: string,
): string {
  const listing = git(repository, ['ls-tree', treeRef])
    .split('\n')
    .filter(Boolean)
    .map((line) =>
      line.endsWith(`\t${name}`)
        ? line.replace(/^(\d+ \S+) [0-9a-f]+\t/, `$1 ${newHash}\t`)
        : line,
    )
    .join('\n');
  return mktree(repository, `${listing}\n`);
}

function commitPlan(repository: string, subject = `Plan ${CHANGE_ID}`): string {
  git(repository, ['add', '-A']);
  git(repository, [
    'commit',
    '-m',
    subject,
    '-m',
    `Change: ${CHANGE_ID}\nTransition: plan`,
  ]);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

function commit(repository: string, subject: string): string {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', subject]);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

function changeDirectory(repository: string): string {
  return path.join(repository, 'openspec/changes', CHANGE_ID);
}

function write(
  repository: string,
  relativePath: string,
  content: string,
): void {
  const filePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function writeReadyV3ExemptChange(
  repository: string,
  changeId = 'demo-change',
  schemaName = (
    JSON.parse(
      fs.readFileSync(
        path.join(repository, 'workflow/repository-consumer.json'),
        'utf8',
      ),
    ) as { planning: { currentSchemaName: string } }
  ).planning.currentSchemaName,
): void {
  const changeRoot = path.join(repository, 'openspec/changes', changeId);
  const baseline = {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
  const sessionSnapshotDigest = crypto
    .createHash('sha256')
    .update(`ci-current-v3-session\0${changeId}`)
    .digest('hex');
  const repositoryConfig = JSON.parse(
    fs.readFileSync(path.join(repository, 'workflow/config.json'), 'utf8'),
  ) as { repositoryName: string };
  const built = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state: {
      schemaVersion: 1,
      applicabilityKind: 'exemption',
      repositoryId: repositoryConfig.repositoryName,
      changeId,
      investigationId: `${changeId}-investigation`,
      normalizedIntent: {
        schemaVersion: 1,
        summary: 'Exercise immutable CI replay with a current v3 Manifest.',
        explicitPaths: [`openspec/changes/${changeId}/proposal.md`],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      authoring: { sessionRevision: 3, sessionSnapshotDigest },
      exemption: {
        category: 'documentation-only',
        baseline,
        declaredPaths: [`openspec/changes/${changeId}/proposal.md`],
        declaredChangeClasses: ['documentation-only'],
        rationale: 'The fixture change is documentation-only.',
        semanticAuthor: {
          id: 'codex',
          provenance: 'checkpoint:ci-current-v3',
        },
        nonTrivialBehaviorReliance: 'none-declared',
        researchBudgetMinutes: null,
      },
    },
  });
  if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
  const sealed = sealInvestigationManifestDraft({
    draft: built.draft,
    approval: {
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:ci-current-v3-approval',
      },
      approvalProvenanceDigest: crypto
        .createHash('sha256')
        .update(`ci-current-v3-approval\0${changeId}`)
        .digest('hex'),
    },
  });
  if (sealed.outcome !== 'sealed') assert.fail(sealed.blocker.failureCode);

  fs.writeFileSync(
    path.join(changeRoot, '.openspec.yaml'),
    `schema: ${schemaName}\ncreated: 2026-07-15\n`,
  );
  fs.writeFileSync(
    path.join(changeRoot, 'investigation.json'),
    `${canonicalJson(sealed.manifest)}\n`,
  );
  writeCurrentV3Ref(repository, sealed.manifest);
  const guard = JSON.parse(
    fs.readFileSync(path.join(changeRoot, 'guard.json'), 'utf8'),
  ) as {
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  fs.writeFileSync(
    path.join(changeRoot, 'execution.json'),
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'execution-artifact',
      changeId,
      tasks: Object.fromEntries(
        Object.entries(guard.tasks).map(([taskId, policy]) => [
          taskId,
          {
            strategy: 'direct-reviewed',
            enforcement: 'available',
            allowedPaths: policy.allowedPaths,
            requiredChecks: policy.requiredChecks,
            diffReview: 'policy-required',
            exemptionKind: 'documentation-only',
            exemptionReason: 'Fixture documentation-only task.',
          },
        ]),
      ),
    })}\n`,
  );
  const placeholder = createEvidenceNode({
    type: 'pending-plan-review',
    nodeSchema: 'fixture.pending-plan-review.v1',
    evaluator: 'fixture.pending-plan-review.v1',
    policyDigest: '3'.repeat(64),
    exactInputDigests: {
      manifest: sealed.manifest.manifestDigest,
      investigationTarget:
        sealed.manifest.investigationApproval.investigationTargetDigest,
    },
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema: 'fixture.pending-plan-review-output.v1',
    output: { pending: true },
    runtimeMetadata: {},
  });
  fs.writeFileSync(
    path.join(changeRoot, 'plan-review.json'),
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'plan-review-artifact',
      changeId,
      nodes: [placeholder],
      currentRefs: { planReview: placeholder.nodeId },
    })}\n`,
  );
}

function writeCurrentV3Ref(
  repository: string,
  manifest: InvestigationManifestV3,
): void {
  const lifecycle = {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
  };
  const commonValue = git(repository, ['rev-parse', '--git-common-dir']).trim();
  const privateRoot = fs.realpathSync(
    path.isAbsolute(commonValue)
      ? commonValue
      : path.resolve(repository, commonValue),
  );
  const config = JSON.parse(
    fs.readFileSync(path.join(repository, 'workflow/config.json'), 'utf8'),
  ) as { runtimeDirectory: string };
  const refPath = path.join(
    privateRoot,
    config.runtimeDirectory,
    investigationManifestPublicationNamespace(lifecycle),
    'current.json',
  );
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(
    refPath,
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'investigation-manifest-current',
      ...lifecycle,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest:
        manifest.investigationApproval.investigationTargetDigest,
      manifestPath: `openspec/changes/${manifest.changeId}/investigation.json`,
    })}\n`,
  );
}

function appendSyntheticGrantRoleResult(
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

function syntheticGrantedRoleResult(
  role: 'blind-surveyor' | 'plan-reviewer',
  grantUse: {
    grantId: string;
    signedEnvelopeDigest: string;
    transitionDigest: string;
  },
  digestDigit: string,
): unknown {
  const digest = digestDigit.repeat(64);
  const contentKind =
    role === 'blind-surveyor' ? 'blind-survey' : 'plan-review';
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

function refreshFixturePlanReview(repository: string): void {
  const changeId = 'demo-change';
  const changeRoot = path.join(repository, 'openspec/changes', changeId);
  const contract = loadChangeContract(repository, changeId);
  const context = deriveInvestigationFirstPlanningSubject(repository, contract);
  const applicabilityNode = context.applicabilityNode;
  const assignment = {
    role: 'plan-reviewer' as const,
    providerId: 'claude' as const,
    sessionId: 'fixture-current-plan-review-session',
    targetDigest: context.subject.subjectDigest,
    requiredIndependence: 'provider-independent' as const,
    achievedIndependence: 'provider-independent' as const,
  };
  const snapshotRelativePaths = [
    '.openspec.yaml',
    'design.md',
    'execution.json',
    'guard.json',
    'investigation.json',
    'proposal.md',
    'specs/demo/spec.md',
    'tasks.md',
  ];
  const snapshotContents = new Map(
    snapshotRelativePaths.map((relativePath) => [
      relativePath,
      fs.readFileSync(path.join(changeRoot, relativePath)),
    ]),
  );
  const materializationNode = createEvidenceNode({
    type: 'propose-exemption-planning-materialization',
    nodeSchema: 'fixture.propose-exemption-planning-materialization.v1',
    evaluator: 'fixture.propose-exemption-planning-materialization.v1',
    policyDigest: context.policies.reviewPolicyDigest,
    exactInputDigests: {},
    semanticParentResultDigests: {},
    provenanceParentNodeIds: {},
    outputSchema:
      'fixture.propose-exemption-planning-materialization-output.v1',
    output: {
      artifacts: Object.fromEntries(
        [...snapshotContents].map(([relativePath, content]) => [
          relativePath,
          crypto.createHash('sha256').update(content).digest('hex'),
        ]),
      ),
    },
    runtimeMetadata: {},
  });
  const targetSnapshotNode = createPlanReviewTargetSnapshotNode({
    changeId,
    changePrefix: `openspec/changes/${changeId}`,
    subject: context.subject,
    materializationNode,
    artifacts: snapshotContents,
  });
  const submission = {
    schemaVersion: 2 as const,
    verdict: 'advisory-approve' as const,
    coverage: [...PLAN_REVIEW_COVERAGE],
    scopeAssessment: {
      kind: 'no-challenge' as const,
      evidence: [
        {
          kind: 'investigation-node' as const,
          nodeId: applicabilityNode.nodeId,
          resultDigest: applicabilityNode.resultDigest,
        },
      ],
    },
    findings: [],
    proposedTerms: [],
    suggestions: [],
    residualRisk: 'The fixture grant claims remain subject to aggregate CI.',
    uncertainty: 'The fixture uses a structured planning exemption.',
  };
  const providerEvidence = createCurrentPlanReviewProviderEvidenceForTest({
    subject: context.subject,
    assignment,
    submission,
    targetSnapshotNode,
    policyDigest: context.policies.reviewPolicyDigest,
    invocationId: 'fixture-current-plan-review-invocation',
    runtimeObservation: 'current',
  });
  const providerResultNode = createPlanReviewProviderResultNode({
    subject: context.subject,
    assignment,
    request: providerEvidence.request,
    result: providerEvidence.result,
    targetSnapshotNode,
  });
  const reviewNode = createPlanReviewNode({
    subject: context.subject,
    assignment,
    providerResultNode,
    submission,
  });
  const roleResult = admitRoleResult({
    assignment,
    author: {
      providerId: 'codex',
      sessionId: 'fixture-plan-author-session',
      principalId: undefined,
      identityAssurance: 'runtime-hint',
      engineSpawned: false,
    },
    participant: {
      providerId: 'claude',
      sessionId: assignment.sessionId,
      principalId: undefined,
      identityAssurance: 'adapter-assigned',
      engineSpawned: true,
    },
    content: {
      kind: 'plan-review',
      nodeId: providerResultNode.nodeId,
      resultDigest: providerResultNode.resultDigest,
      outputSchema: providerEvidence.request.outputSchema,
      evaluator: providerEvidence.request.evaluatorVersion,
      policyDigest: providerEvidence.request.policyDigest,
      contentDigest: providerResultNode.resultDigest,
      current: true,
    },
    providerInvocation: providerEvidence.providerInvocation,
    grantUse: null,
    grantValidation: null,
  });
  fs.writeFileSync(
    path.join(changeRoot, 'plan-review.json'),
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'plan-review-artifact',
      changeId,
      nodes: [targetSnapshotNode, providerResultNode, reviewNode].sort(
        (left, right) => left.nodeId.localeCompare(right.nodeId),
      ),
      currentRefs: { planReview: reviewNode.nodeId },
      roleResults: [roleResult],
    })}\n`,
  );
}

test('CI accepts a revision that deletes non-canonical planning noise', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(repository, CHANGE_ID);
    const noisePath = path.join(
      changeDirectory(repository),
      'requirement-audit.md',
    );
    fs.writeFileSync(noisePath, 'Non-canonical planning noise.\n');
    commit(repository, 'Add non-canonical planning noise');
    fs.rmSync(noisePath);
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'design.md'),
      '\nNoise retired.\n',
    );
    writeReadyV3ExemptChange(repository, CHANGE_ID);
    refreshFixturePlanReview(repository);
    const revision = commitPlanningTransition(repository, CHANGE_ID);

    const result = validateCiPlanningCommit(
      repository,
      revision.commitHash,
      CHANGE_ID,
    );
    assert.equal(result.kind, 'revision');
    assert.deepEqual(result.changedPaths, revision.changedPaths);
    assert.equal(
      result.changedPaths.includes(
        `openspec/changes/${CHANGE_ID}/requirement-audit.md`,
      ),
      true,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects corrupt current-schema metadata before provider replay', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(repository, CHANGE_ID);
    const metadataPath = path.join(
      changeDirectory(repository),
      '.openspec.yaml',
    );
    fs.writeFileSync(
      metadataPath,
      'schema: jigwright\ncreated: 2026-07-24\ncorrupt: true\n',
    );
    commit(repository, 'Admit corrupt current metadata');
    writeReadyV3ExemptChange(repository, CHANGE_ID);
    refreshFixturePlanReview(repository);
    const revision = commitPlan(repository);

    assert.throws(
      () => validateCiPlanningCommit(repository, revision, CHANGE_ID),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_METADATA_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI still rejects a revision whose before tree stays incomplete', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(repository, CHANGE_ID);
    fs.rmSync(path.join(changeDirectory(repository), 'execution.json'));
    commit(repository, 'Admit incomplete current planning tree');
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'design.md'),
      '\nRevision without repair.\n',
    );
    const revision = commitPlan(repository);

    assert.throws(
      () => validateCiPlanningCommit(repository, revision, CHANGE_ID),
      (error) => isWorkflowError(error, 'MISSING_CHANGE_ARTIFACT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a planning tree with duplicate entries', () => {
  const repository = prepareCurrentV3IntroductionRepository();
  try {
    const introduction = commitPlanningTransition(
      repository,
      CHANGE_ID,
    ).commitHash;

    const prefix = `openspec/changes/${CHANGE_ID}`;
    const forgedBlob = execFileSync(
      'git',
      ['-C', repository, 'hash-object', '-w', '--stdin'],
      { encoding: 'utf8', input: '# Forged proposal\n' },
    ).trim();
    const duplicatedChangeTree = mktree(
      repository,
      `${git(repository, ['ls-tree', `${introduction}:${prefix}`])}100644 blob ${forgedBlob}\tproposal.md\n`,
    );
    const changesTree = replaceTreeEntry(
      repository,
      `${introduction}:openspec/changes`,
      CHANGE_ID,
      duplicatedChangeTree,
    );
    const openspecTree = replaceTreeEntry(
      repository,
      `${introduction}:openspec`,
      'changes',
      changesTree,
    );
    const rootTree = replaceTreeEntry(
      repository,
      introduction,
      'openspec',
      openspecTree,
    );
    const revision = execFileSync(
      'git',
      [
        '-C',
        repository,
        'commit-tree',
        rootTree,
        '-p',
        introduction,
        '-m',
        `Plan ${CHANGE_ID}`,
        '-m',
        `Change: ${CHANGE_ID}\nTransition: plan`,
      ],
      { encoding: 'utf8' },
    ).trim();

    assert.throws(
      () => validateCiPlanningCommit(repository, revision, CHANGE_ID),
      (error) => isWorkflowError(error, 'CI_PLANNING_TREE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI still rejects added or escaping non-canonical planning paths', () => {
  const added = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(added, CHANGE_ID);
    writeReadyV3ExemptChange(added, CHANGE_ID);
    refreshFixturePlanReview(added);
    fs.writeFileSync(
      path.join(changeDirectory(added), 'requirement-audit.md'),
      'New noise.\n',
    );
    const additionCommit = commitPlan(added);
    assert.throws(
      () => validateCiPlanningCommit(added, additionCommit, CHANGE_ID),
      (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
    );
  } finally {
    fs.rmSync(added, { recursive: true, force: true });
  }

  const escaping = prepareCurrentV3IntroductionRepository();
  try {
    commitPlanningTransition(escaping, CHANGE_ID);
    const outsidePath = path.join(
      escaping,
      'openspec/changes/other-change-note.md',
    );
    fs.writeFileSync(outsidePath, 'Outside the named change tree.\n');
    commit(escaping, 'Add outside note');
    fs.rmSync(outsidePath);
    fs.appendFileSync(
      path.join(changeDirectory(escaping), 'design.md'),
      '\nRevision.\n',
    );
    writeReadyV3ExemptChange(escaping, CHANGE_ID);
    refreshFixturePlanReview(escaping);
    const escapeCommit = commitPlan(escaping);
    assert.throws(
      () => validateCiPlanningCommit(escaping, escapeCommit, CHANGE_ID),
      (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
    );
  } finally {
    fs.rmSync(escaping, { recursive: true, force: true });
  }
});
