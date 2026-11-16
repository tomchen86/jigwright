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
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/runtime/planning-transition/planning-transition.ts';
import { committedPlanningGeneration } from '../src/runtime/repository-transaction/planning-generation-history.ts';
import {
  createPlanningAmendmentDecision,
  replacePlanningAmendmentDecisionMarker,
} from '../src/modules/lifecycle/planning-amendment-decision.ts';
import {
  createFixtureRepository,
  git,
  prepareCurrentV3IntroductionFixture,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { commitCurrentFixtureTask } from './support/task-diff-review-fixture.ts';

test('amend-plan requires the normative --change option and rejects the retired positional form', () => {
  const repository = createFixtureRepository();
  try {
    prepareCurrentV3IntroductionFixture(repository);
    writeReadyV3ExemptChange(repository);
    commitPlanningTransition(repository, 'demo-change');

    commitCurrentFixtureTask(repository, {
      message: 'Complete demo execution',
    });

    const proposalPath = path.join(
      repository,
      'openspec/changes/demo-change/proposal.md',
    );
    const amendsPlanningGeneration = committedPlanningGeneration(
      repository,
      'HEAD',
      'openspec/changes',
      'demo-change',
    );
    assert.notEqual(amendsPlanningGeneration, null);
    const decision = createPlanningAmendmentDecision({
      reason: 'archive-applicability-failure',
      executionImpact: 'none',
      rationale:
        'The correction restores archive applicability without invalidating completed execution.',
      amendsPlanningGeneration: amendsPlanningGeneration!,
    });
    fs.writeFileSync(
      proposalPath,
      replacePlanningAmendmentDecisionMarker(
        `${fs.readFileSync(proposalPath, 'utf8').trimEnd()}\n\nReviewed archive correction.\n`,
        decision,
      ),
    );
    writeReadyV3ExemptChange(repository);

    const headBeforeRetiredInvocation = git(repository, [
      'rev-parse',
      'HEAD',
    ]).trim();
    const proposalBeforeRetiredInvocation = fs.readFileSync(proposalPath);
    const retiredInvocation = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'amend-plan',
        'demo-change',
        '--reason',
        'archive-applicability-failure',
        '--execution-impact',
        'none',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    assert.equal(
      retiredInvocation.status,
      2,
      `${retiredInvocation.stdout}${retiredInvocation.stderr}`,
    );
    assert.equal(
      (JSON.parse(retiredInvocation.stderr) as { error: { code: string } })
        .error.code,
      'INVALID_USAGE',
    );
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      headBeforeRetiredInvocation,
    );
    assert.deepEqual(
      fs.readFileSync(proposalPath),
      proposalBeforeRetiredInvocation,
    );

    const output = execFileSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'amend-plan',
        '--change',
        'demo-change',
        '--reason',
        'archive-applicability-failure',
        '--execution-impact',
        'none',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );
    const payload = JSON.parse(output) as {
      command: string;
      ok: boolean;
      result: { amendment: { executionImpact: string } };
    };
    assert.equal(payload.command, 'amend-plan');
    assert.equal(payload.ok, true);
    assert.equal(payload.result.amendment.executionImpact, 'none');
    assert.match(
      git(repository, ['show', '-s', '--format=%B', 'HEAD']),
      /Transition: amend-plan[\s\S]*Execution-Impact: none/,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
