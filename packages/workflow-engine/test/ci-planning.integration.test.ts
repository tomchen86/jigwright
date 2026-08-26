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
import { loadChangeContract } from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { createEvidenceNode } from '../src/adapters/compatibility/investigation-v2/evidence-node.ts';
import { INVESTIGATION_PLANNING_ACTIVATION_MARKER as ACTIVATION_MARKER } from '../src/adapters/planning/openspec/documents/openspec-schema-contract.ts';
import {
  createPlanReviewNode,
  createPlanReviewProviderResultNode,
  createPlanReviewTargetSnapshotNode,
  PLAN_REVIEW_COVERAGE,
  PLAN_REVIEW_OUTPUT_SCHEMA,
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
  git,
  isWorkflowError,
  sourceRepositoryRoot,
} from './fixture.ts';

const CHANGE_ID = 'planned-change';

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

test('CI collects a collaboration grant claimed by two historical plan transitions', () => {
  const repository = createRepository();
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

test('CI collects a blind-survey grant claimed by two historical plan transitions', () => {
  const repository = createRepository();
  try {
    writeSurveyGrantClaim(repository, {
      grantId: '11111111-1111-4111-8111-111111111111',
      signedEnvelopeDigest: '2'.repeat(64),
      transitionDigest: '3'.repeat(64),
    });
    commitPlan(repository);

    writeSurveyGrantClaim(repository, {
      grantId: '44444444-4444-4444-8444-444444444444',
      signedEnvelopeDigest: '5'.repeat(64),
      transitionDigest: '6'.repeat(64),
    });
    commit(repository, 'Record an alternate survey generation');

    writeSurveyGrantClaim(repository, {
      grantId: '11111111-1111-4111-8111-111111111111',
      signedEnvelopeDigest: '2'.repeat(64),
      transitionDigest: '3'.repeat(64),
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
  const repository = createRepository();
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
  const repository = createRepository();
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
  const repository = createRepository();
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
  const repository = createRepository();
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

test('CI treats legacy and role-free planning history as zero grant claims', async (t) => {
  await t.test('legacy plan without evidence artifacts', () => {
    const repository = createRepository();
    try {
      writePlanningTree(repository);
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

  await t.test('tracked artifact without role results', () => {
    const repository = createRepository();
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
});

test('CI collects a PlanReview grant from a current v3 plan transition', () => {
  const repository = createFixtureRepository();
  const reviewUse = {
    grantId: '67676767-6767-4676-8676-676767676767',
    signedEnvelopeDigest: '8'.repeat(64),
    transitionDigest: '9'.repeat(64),
  };
  try {
    git(repository, ['checkout', '-b', 'work/demo-change']);
    writeReadyV3ExemptChange(repository);
    refreshFixturePlanReview(repository);
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
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI replays a configured current schema from immutable consumer config', () => {
  const repository = createFixtureRepository();
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
    consumer.planning.requiredSchemaNames = [
      'spec-driven',
      'orbit-spec-v1',
    ];
    consumer.planning.supportedSchemaNames = [
      'spec-driven',
      'orbit-spec-v1',
    ];
    consumer.planning.managedSchemaNames = ['orbit-spec-v1'];
    consumer.planning.currentSchemaName = 'orbit-spec-v1';
    fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);
    const openSpecConfigPath = path.join(repository, 'openspec/config.yaml');
    fs.writeFileSync(
      openSpecConfigPath,
      fs
        .readFileSync(openSpecConfigPath, 'utf8')
        .replace(/^schema: jigwright$/m, 'schema: orbit-spec-v1'),
    );
    fs.cpSync(
      path.join(repository, 'openspec/schemas/jigwright'),
      path.join(repository, 'openspec/schemas/orbit-spec-v1'),
      { recursive: true },
    );
    const namedSchemaPath = path.join(
      repository,
      'openspec/schemas/orbit-spec-v1/schema.yaml',
    );
    fs.writeFileSync(
      namedSchemaPath,
      fs
        .readFileSync(namedSchemaPath, 'utf8')
        .replace(/^name: jigwright$/m, 'name: orbit-spec-v1'),
    );
    git(repository, [
      'add',
      'workflow/repository-consumer.json',
      'openspec/config.yaml',
      'openspec/schemas/orbit-spec-v1',
    ]);
    git(repository, ['commit', '-m', 'Select Orbit current schema']);
    git(repository, ['checkout', '-b', 'work/demo-change']);

    writeReadyV3ExemptChange(repository, 'demo-change', 'orbit-spec-v1');
    refreshFixturePlanReview(repository);
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

    consumer.planning.currentSchemaName = 'expense-app-v2';
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

test('CI accepts an exact planning introduction reconstructed from Git', () => {
  const repository = createRepository();
  try {
    writePlanningTree(repository);
    const commit = commitPlan(repository);

    assert.deepEqual(validateCiPlanningCommit(repository, commit, CHANGE_ID), {
      changeId: CHANGE_ID,
      kind: 'introduction',
      beforeTasks: undefined,
      afterTasks: [{ id: '1.1', completed: false }],
      changedPaths: planningPaths(CHANGE_ID),
      // A legacy plan declares no investigation-first evidence, so replay
      // reports the legacy grammar and no semantic assurance.
      schemaName: 'expense-app',
      planningAssurance: null,
      collaborationGrantUses: [],
    });
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
  const repository = createRepository();
  try {
    writePlanningTree(repository);
    writeProviderBinding(repository);
    const plan = commitPlan(repository);

    const result = validateCiPlanningCommit(repository, plan, CHANGE_ID);
    assert.equal(result.kind, 'introduction');
    assert.deepEqual(
      result.changedPaths,
      [
        ...planningPaths(CHANGE_ID),
        `workflow/change-providers/${CHANGE_ID}.json`,
      ].sort(),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI refuses a forged planning-provider v1 migration', () => {
  const repository = createRepository();
  try {
    writePlanningTree(repository);
    writeProviderBinding(repository);
    commitPlan(repository);

    writeProviderBinding(repository, { providerId: 'spectra' });
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'proposal.md'),
      '\nForged provider migration.\n',
    );
    const revision = commitPlan(repository);
    assert.throws(
      () => validateCiPlanningCommit(repository, revision, CHANGE_ID),
      (error) => isWorkflowError(error, 'PROVIDER_MIGRATION_UNSUPPORTED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI keeps planning-provider activation monotonic after its marker is deleted', () => {
  const repository = createRepository();
  const marker = 'workflow/schemas/planning-provider-binding.schema.json';
  try {
    write(repository, marker, '{}\n');
    commit(repository, 'Activate planning-provider bindings');
    fs.rmSync(path.join(repository, marker));
    commit(repository, 'Attempt to erase planning-provider activation');

    writePlanningTree(repository);
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
  const repository = createRepository();
  try {
    writePlanningTree(
      repository,
      [
        '- [ ] 1.1 First task',
        '- [ ] 1.2 Removable task',
        '- [ ] 1.3 Completed task',
      ].join('\n'),
    );
    commitPlan(repository);
    writeTasks(
      repository,
      [
        '- [ ] 1.1 First task',
        '- [ ] 1.2 Removable task',
        '- [x] 1.3 Completed task',
      ].join('\n'),
    );
    commit(repository, 'Complete fixture task');

    writeTasks(
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
    const revision = commitPlan(repository);

    assert.deepEqual(
      validateCiPlanningCommit(repository, revision, CHANGE_ID),
      {
        changeId: CHANGE_ID,
        kind: 'revision',
        beforeTasks: [
          { id: '1.1', completed: false },
          { id: '1.2', completed: false },
          { id: '1.3', completed: true },
        ],
        afterTasks: [
          { id: '1.3', completed: true },
          { id: '1.1', completed: false },
          { id: '2.1', completed: false },
        ],
        changedPaths: [
          `openspec/changes/${CHANGE_ID}/design.md`,
          `openspec/changes/${CHANGE_ID}/tasks.md`,
        ],
        schemaName: 'expense-app',
        planningAssurance: null,
        collaborationGrantUses: [],
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a checked task in a planning introduction or revision', async (t) => {
  await t.test('introduction', () => {
    const repository = createRepository();
    try {
      writePlanningTree(repository, '- [x] 1.1 Already complete');
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
    const repository = createRepository();
    try {
      writePlanningTree(repository);
      commitPlan(repository);
      writeTasks(repository, '- [x] 1.1 Illegally completed');
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
      const repository = createRepository();
      try {
        writePlanningTree(repository);
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
    const repository = createRepository();
    try {
      writePlanningTree(repository);
      const designPath = path.join(changeDirectory(repository), 'design.md');
      fs.rmSync(designPath);
      fs.symlinkSync('proposal.md', designPath);
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_PLANNING_TREE_UNSAFE'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('executable', () => {
    const repository = createRepository();
    try {
      writePlanningTree(repository);
      fs.chmodSync(path.join(changeDirectory(repository), 'design.md'), 0o755);
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_PLANNING_TREE_UNSAFE'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
});

test('CI rejects an incomplete planning tree and a non-canonical plan message', async (t) => {
  await t.test('missing required artifact', () => {
    const repository = createRepository();
    try {
      writePlanningTree(repository);
      fs.rmSync(path.join(changeDirectory(repository), 'guard.json'));
      const commitHash = commitPlan(repository);
      assert.throws(
        () => validateCiPlanningCommit(repository, commitHash, CHANGE_ID),
        (error) => isWorkflowError(error, 'CI_PLANNING_TREE_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });

  await t.test('wrong subject', () => {
    const repository = createRepository();
    try {
      writePlanningTree(repository);
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
  const repository = createRepository();
  try {
    git(repository, ['checkout', '-b', 'side']);
    write(repository, 'side.txt', 'side\n');
    commit(repository, 'Add side branch');
    git(repository, ['checkout', 'main']);
    writePlanningTree(repository);
    commitPlan(repository);
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

test('CI replays a pre-activation legacy plan after the anchor lands later', () => {
  const repository = createRepository();
  try {
    writePlanningTree(repository);
    const plan = commitPlan(repository);
    // The anchor is introduced after the governing generation, exactly as the
    // cutover commit does on a branch that already carries legacy plans.
    activate(repository);

    assert.equal(
      validateCiPlanningCommit(repository, plan, CHANGE_ID).schemaName,
      'expense-app',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a legacy plan introduced after the activation anchor', () => {
  const repository = createRepository();
  try {
    activate(repository);
    writePlanningTree(repository);
    const plan = commitPlan(repository);

    assert.throws(
      () => validateCiPlanningCommit(repository, plan, CHANGE_ID),
      (error) => isWorkflowError(error, 'PLANNING_SCHEMA_DOWNGRADE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI fails closed when a post-activation plan tree drops the anchor marker', () => {
  const repository = createRepository();
  try {
    activate(repository);
    git(repository, ['rm', '--quiet', '--', ACTIVATION_MARKER]);
    commit(repository, 'Delete the activation marker');
    writePlanningTree(repository);
    write(
      repository,
      `openspec/changes/${CHANGE_ID}/.openspec.yaml`,
      'schema: expense-app-v2\ncreated: 2026-07-15\n',
    );
    const plan = commitPlan(repository);

    assert.throws(
      () => validateCiPlanningCommit(repository, plan, CHANGE_ID),
      (error) =>
        isWorkflowError(error, 'INVESTIGATION_ACTIVATION_MARKER_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function activate(repository: string): string {
  write(
    repository,
    ACTIVATION_MARKER,
    fs.readFileSync(path.join(sourceRepositoryRoot, ACTIVATION_MARKER), 'utf8'),
  );
  return commit(repository, 'Activate investigation-first planning');
}

function createRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-ci-planning-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  write(repository, 'README.md', '# Fixture\n');
  commit(repository, 'Create fixture');
  return repository;
}

function writePlanningTree(
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

function writeGrantClaim(
  repository: string,
  use: {
    grantId: string;
    signedEnvelopeDigest: string;
    transitionDigest: string;
  },
): void {
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
      roleResults: [{ grantUse: use }],
    })}\n`,
  );
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

function writeSurveyGrantClaim(
  repository: string,
  use: {
    grantId: string;
    signedEnvelopeDigest: string;
    transitionDigest: string;
  },
): void {
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
      roleResults: [{ grantUse: use }],
    })}\n`,
  );
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
  const reviewNode = createEvidenceNode({
    type: 'fixture-plan-review',
    nodeSchema: 'fixture.plan-review.v1',
    evaluator: 'fixture.plan-review.v1',
    policyDigest: '6'.repeat(64),
    exactInputDigests: { target: '7'.repeat(64) },
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
      roleResults: [
        {
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
        },
      ],
    })}\n`,
  );
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

function planningPaths(changeId: string): string[] {
  const prefix = `openspec/changes/${changeId}`;
  return [
    `${prefix}/.openspec.yaml`,
    `${prefix}/design.md`,
    `${prefix}/guard.json`,
    `${prefix}/proposal.md`,
    `${prefix}/specs/demo/spec.md`,
    `${prefix}/tasks.md`,
  ];
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
            legacyBootstrap: null,
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
  const providerResultNode = createPlanReviewProviderResultNode({
    subject: context.subject,
    assignment,
    submission,
    providerPolicyDigest: context.policies.reviewPolicyDigest,
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
      nodeId: reviewNode.nodeId,
      resultDigest: reviewNode.resultDigest,
      outputSchema: PLAN_REVIEW_OUTPUT_SCHEMA,
      evaluator: reviewNode.evaluator,
      policyDigest: reviewNode.policyDigest,
      contentDigest: reviewNode.resultDigest,
      current: true,
    },
    providerInvocation: {
      invocationId: 'fixture-current-plan-review-invocation',
      requestDigest: 'c'.repeat(64),
      outputDigest: 'd'.repeat(64),
      providerId: assignment.providerId,
      sessionId: assignment.sessionId,
      targetDigest: assignment.targetDigest,
      engineSpawned: true,
    },
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
  const repository = createRepository();
  try {
    writePlanningTree(repository);
    const noisePath = path.join(
      changeDirectory(repository),
      'requirement-audit.md',
    );
    fs.writeFileSync(noisePath, 'Bootstrap-era audit noise.\n');
    commit(repository, 'Add bootstrap noise');
    fs.rmSync(noisePath);
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'design.md'),
      '\nNoise retired.\n',
    );
    const revision = commitPlan(repository);

    const result = validateCiPlanningCommit(repository, revision, CHANGE_ID);
    assert.equal(result.kind, 'revision');
    assert.deepEqual(result.changedPaths, [
      `openspec/changes/${CHANGE_ID}/design.md`,
      `openspec/changes/${CHANGE_ID}/requirement-audit.md`,
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI accepts a revision that repairs a bootstrap-era planning tree', () => {
  const repository = createRepository();
  try {
    writePlanningTree(repository);
    const metadataPath = path.join(
      changeDirectory(repository),
      '.openspec.yaml',
    );
    fs.rmSync(metadataPath);
    const noisePath = path.join(
      changeDirectory(repository),
      'requirement-audit.md',
    );
    fs.writeFileSync(noisePath, 'Bootstrap-era audit noise.\n');
    commit(repository, 'Admit bootstrap tree without metadata');
    fs.writeFileSync(metadataPath, 'schema: spec-driven\n');
    fs.rmSync(noisePath);
    const revision = commitPlan(repository);

    const result = validateCiPlanningCommit(repository, revision, CHANGE_ID);
    assert.equal(result.kind, 'revision');
    assert.deepEqual(result.changedPaths, [
      `openspec/changes/${CHANGE_ID}/.openspec.yaml`,
      `openspec/changes/${CHANGE_ID}/requirement-audit.md`,
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI does not reinterpret corrupt provider metadata as a bootstrap repair', () => {
  const repository = createRepository();
  try {
    writePlanningTree(repository);
    const metadataPath = path.join(
      changeDirectory(repository),
      '.openspec.yaml',
    );
    fs.writeFileSync(
      metadataPath,
      'schema: spec-driven\ncreated: 2026-07-24\ncorrupt: true\n',
    );
    commit(repository, 'Admit corrupt bootstrap metadata');
    fs.writeFileSync(metadataPath, 'schema: spec-driven\n');
    const revision = commitPlan(repository);

    assert.throws(
      () => validateCiPlanningCommit(repository, revision, CHANGE_ID),
      (error) => isWorkflowError(error, 'PROVIDER_BINDING_LEGACY_UNPROVEN'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI still rejects a revision whose before tree stays incomplete', () => {
  const repository = createRepository();
  try {
    writePlanningTree(repository);
    fs.rmSync(path.join(changeDirectory(repository), '.openspec.yaml'));
    commit(repository, 'Admit bootstrap tree without metadata');
    fs.appendFileSync(
      path.join(changeDirectory(repository), 'design.md'),
      '\nRevision without repair.\n',
    );
    const revision = commitPlan(repository);

    assert.throws(
      () => validateCiPlanningCommit(repository, revision, CHANGE_ID),
      (error) => isWorkflowError(error, 'CI_PLANNING_TREE_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('CI rejects a planning tree with duplicate entries', () => {
  const repository = createRepository();
  try {
    writePlanningTree(repository);
    const introduction = commitPlan(repository);

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
  const added = createRepository();
  try {
    writePlanningTree(added);
    commitPlan(added);
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

  const escaping = createRepository();
  try {
    writePlanningTree(escaping);
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
    const escapeCommit = commitPlan(escaping);
    assert.throws(
      () => validateCiPlanningCommit(escaping, escapeCommit, CHANGE_ID),
      (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
    );
  } finally {
    fs.rmSync(escaping, { recursive: true, force: true });
  }
});
