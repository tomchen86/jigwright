import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { LocalEngineSelectionReaders } from '../src/modules/authority/local-engine-selection.ts';
import { createProductionSessionCheckService } from '../src/composition-root/session-check-production.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { getSession } from '../src/runtime/repository-observation/workflow-session-context.ts';
import { createProductionFinalizationService } from '../src/composition-root/finalization-production.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  isWorkflowError,
  runtimeRoot,
} from './fixture.ts';
import { prepareCurrentChange } from './support/session-lifecycle-fixture.ts';
import { localEngineSelectionReaders } from './support/local-engine-selection-host.ts';

const resumeBinding = Object.freeze({
  kind: 'local-engine-resume-binding.v1' as const,
  parentChangeId: 'demo-change',
  checkpointId: `sha256:${'1'.repeat(64)}` as const,
  engineDigest: `sha256:${'2'.repeat(64)}` as const,
});

function environmentWithoutResumeBinding(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING;
  return environment;
}

function sessionFixture() {
  const repository = fs.realpathSync(createFixtureRepository());
  git(repository, ['checkout', '-b', 'work/demo-change']);
  prepareCurrentChange(repository);
  const session = startSession(
    productionChangeContract,
    repository,
    'demo-change',
    '1.1',
  );
  return { repository, session };
}

test('local adoption admission retains distinct absent, missing, malformed and mismatched resume-binding errors', () => {
  const { repository, session } = sessionFixture();
  try {
    const observations: string[] = [];
    const cases = [
      { selection: null, raw: undefined, code: null },
      {
        selection: null,
        raw: '{}',
        code: 'SESSION_LOCAL_ENGINE_RESUME_BINDING_INVALID',
      },
      {
        selection: { resumeBinding },
        raw: undefined,
        code: 'SESSION_LOCAL_ENGINE_RESUME_BINDING_REQUIRED',
      },
      {
        selection: { resumeBinding },
        raw: '{',
        code: 'SESSION_LOCAL_ENGINE_RESUME_BINDING_INVALID',
      },
      {
        selection: { resumeBinding },
        raw: 'null',
        code: 'SESSION_LOCAL_ENGINE_RESUME_BINDING_INVALID',
      },
      {
        selection: { resumeBinding },
        raw: JSON.stringify({
          ...resumeBinding,
          checkpointId: `sha256:${'3'.repeat(64)}`,
        }),
        code: 'SESSION_LOCAL_ENGINE_RESUME_BINDING_INVALID',
      },
      {
        selection: {
          resumeBinding: { ...resumeBinding, parentChangeId: 'another-change' },
        },
        raw: JSON.stringify({
          ...resumeBinding,
          parentChangeId: 'another-change',
        }),
        code: 'SESSION_LOCAL_ENGINE_RESUME_BINDING_INVALID',
      },
    ];
    for (const { selection, raw, code } of cases) {
      observations.length = 0;
      const readers: LocalEngineSelectionReaders = {
        bootstrapInterventionStateRoot(gitCommonDirectory) {
          observations.push('state-root');
          return localEngineSelectionReaders.bootstrapInterventionStateRoot(
            gitCommonDirectory,
          );
        },
        resolveLocalEngineSelection(_stateRoot, identity) {
          observations.push('selection');
          assert.deepEqual(identity, {
            worktreeRoot: repository,
            branchRef: 'refs/heads/work/demo-change',
          });
          return selection;
        },
      };
      const environment = environmentWithoutResumeBinding();
      if (raw !== undefined)
        environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING = raw;
      const reconcile = () =>
        createProductionSessionCheckService(
          readers,
        ).reconcileSessionChecksAfterLocalEngineAdoption(
          repository,
          session.sessionId,
          { environment },
        );
      if (code === null) assert.equal(reconcile(), null);
      else assert.throws(reconcile, (error) => isWorkflowError(error, code));
      assert.deepEqual(observations, ['state-root', 'selection']);
    }
    const failure = new Error('selection observation failed');
    assert.throws(
      () =>
        createProductionSessionCheckService({
          ...localEngineSelectionReaders,
          resolveLocalEngineSelection() {
            throw failure;
          },
        }).reconcileSessionChecksAfterLocalEngineAdoption(
          repository,
          session.sessionId,
          { environment: environmentWithoutResumeBinding() },
        ),
      (error) => error === failure,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('checkSession reobserves local selection after immutable report publication and before session publication', () => {
  const repository = fs.realpathSync(createFixtureRepository());
  const counterDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'session-selection-observation-'),
  );
  const counterPath = path.join(counterDirectory, 'checks.log');
  try {
    fs.writeFileSync(
      path.join(repository, 'scripts/count-selection-check.mjs'),
      "import fs from 'node:fs';\nfs.appendFileSync(process.argv[2], 'checked\\n');\n",
    );
    configureChecks(
      repository,
      {
        fixture: {
          command: ['node', 'scripts/count-selection-check.mjs', counterPath],
          destructiveDatabase: false,
        },
      },
      ['fixture'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentChange(repository);
    const session = startSession(
      productionChangeContract,
      repository,
      'demo-change',
      '1.1',
    );
    const reportDirectory = path.join(
      runtimeRoot(repository),
      'reports',
      session.sessionId,
    );
    const observations: string[] = [];
    let selectionReads = 0;
    const readers: LocalEngineSelectionReaders = {
      bootstrapInterventionStateRoot(gitCommonDirectory) {
        observations.push('state-root');
        return localEngineSelectionReaders.bootstrapInterventionStateRoot(
          gitCommonDirectory,
        );
      },
      resolveLocalEngineSelection(_stateRoot, identity) {
        selectionReads++;
        observations.push(`selection-${selectionReads}`);
        assert.deepEqual(identity, {
          worktreeRoot: repository,
          branchRef: 'refs/heads/work/demo-change',
        });
        if (selectionReads === 1) {
          assert.equal(fs.existsSync(counterPath), false);
          return null;
        }
        assert.equal(fs.readFileSync(counterPath, 'utf8'), 'checked\n');
        assert.ok(
          fs
            .readdirSync(reportDirectory)
            .some((file) => file.endsWith('.json')),
        );
        assert.equal(
          getSession(repository, session.sessionId).latestCheckReportId,
          undefined,
        );
        return { resumeBinding };
      },
    };
    assert.throws(
      () =>
        createProductionSessionCheckService(readers).checkSession(
          repository,
          session.sessionId,
          { environment: environmentWithoutResumeBinding() },
        ),
      (error) =>
        isWorkflowError(error, 'SESSION_LOCAL_ENGINE_RESUME_BINDING_REQUIRED'),
    );
    assert.deepEqual(observations, [
      'state-root',
      'selection-1',
      'state-root',
      'selection-2',
    ]);
    assert.equal(
      getSession(repository, session.sessionId).latestCheckReportId,
      undefined,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(counterDirectory, { recursive: true, force: true });
  }
});

test('production finalization assembly does not observe local engine selection before invocation', () => {
  const unexpected = () => {
    throw new Error('selection was observed during assembly');
  };
  const services = createProductionFinalizationService({
    bootstrapInterventionStateRoot: unexpected,
    resolveLocalEngineSelection: unexpected,
  });
  assert.equal(typeof services.completeTask, 'function');
  assert.equal(
    typeof services.finalizeProtectedTaskApplyUnderGrant,
    'function',
  );
});
