import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createProductionSessionCheckService } from '../src/composition-root/session-check-production.ts';
import { createProductionFinalizationService } from '../src/composition-root/finalization-production.ts';
import { startSession } from '../src/application/execute-task/session.ts';
import { getSession } from '../src/runtime/repository-observation/workflow-session-context.ts';
import { productionChangeContract } from '../src/composition-root/change-routing-observation-production.ts';
import { createFixtureRepository, git, runtimeRoot } from './fixture.ts';
import { prepareCurrentChange } from './support/session-lifecycle-fixture.ts';

for (const binding of [undefined, 'retired malformed binding']) {
  test(`ordinary check and completion ignore consumer engine selection; binding=${binding ?? 'absent'}`, () => {
    const repository = fs.realpathSync(createFixtureRepository());
    try {
      git(repository, ['checkout', '-b', 'work/demo-change']);
      const changeRoot = path.join(repository, 'openspec/changes/demo-change');
      fs.appendFileSync(
        path.join(changeRoot, 'tasks.md'),
        '\n- [ ] 1.2 Keep the change open\n',
      );
      const guardPath = path.join(changeRoot, 'guard.json');
      const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8'));
      guard.tasks['1.2'] = structuredClone(guard.tasks['1.1']);
      fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
      prepareCurrentChange(repository);
      const session = startSession(
        productionChangeContract,
        repository,
        'demo-change',
        '1.1',
      );
      fs.writeFileSync(
        path.join(repository, 'src/feature.ts'),
        'export const feature = true;\n',
      );
      const stateRoot = path.join(
        runtimeRoot(repository),
        'intervention-control',
      );
      const bindings = path.join(stateRoot, 'local-parent-sessions');
      fs.mkdirSync(bindings, { recursive: true });
      const bindingPath = path.join(
        bindings,
        `${crypto.createHash('sha256').update('parent-session\0demo-change').digest('hex')}.json`,
      );
      fs.writeFileSync(
        bindingPath,
        '{"retired":"candidate engine selection"}\n',
      );
      const environment = { ...process.env };
      delete environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING;
      if (binding !== undefined)
        environment.WORKFLOW_LOCAL_ENGINE_RESUME_BINDING = binding;
      const checked = createProductionSessionCheckService().checkSession(
        repository,
        session.sessionId,
        { environment },
      );
      assert.equal(checked.passed, true);
      assert.equal(
        getSession(repository, session.sessionId).latestCheckReportId,
        checked.reportId,
      );
      assert.deepEqual(checked.reusedCheckIds, []);
      const completed = createProductionFinalizationService().completeTask(
        repository,
        session.sessionId,
        environment,
      );
      assert.deepEqual(completed.completedTaskIds, ['1.1']);
      assert.equal(
        fs.readFileSync(bindingPath, 'utf8'),
        '{"retired":"candidate engine selection"}\n',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}
