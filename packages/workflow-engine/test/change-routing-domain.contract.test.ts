import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { readModuleReferences } from './support/dependency-graph.ts';
import {
  applyIntent,
  synthesizeSource,
  requiredContinuationAction,
  inspectObservedRoutingChange,
  admissibleRoutingRole,
  readyRecord,
  type ObservedChange,
  type ChangeRoutingIntent,
} from '../src/modules/lifecycle/change-routing.ts';

const observed: readonly ObservedChange[] = [
  'demo-change',
  'repair-change',
].map((changeId) => ({
  changeId,
  archived: false,
  completed: false,
  factsDigest: `sha256:${'a'.repeat(64)}`,
  authorityChecked: false,
  authority: null,
  tasks: [{ id: '1.1', title: 'Task', completed: false }],
}));

test('routing decisions and automatic continuation operate on values without a repository', () => {
  const initial = synthesizeSource(observed);
  const blocked = applyIntent(
    initial,
    {
      schemaVersion: 1,
      action: {
        kind: 'block',
        changeId: 'demo-change',
        taskId: '1.1',
        reason: 'Wait for repair.',
        blocker: {
          kind: 'change',
          id: 'repair-change',
          resumeCondition: 'done',
        },
      },
    },
    observed,
  );
  const resume: ChangeRoutingIntent = {
    schemaVersion: 1,
    action: { kind: 'resume', changeId: 'demo-change' },
  };
  assert.throws(() => requiredContinuationAction(blocked, resume, observed), {
    code: 'CHANGE_ROUTING_RESUME_NOT_READY',
  });
  const completed = observed.map((change) =>
    change.changeId === 'repair-change'
      ? { ...change, completed: true }
      : change,
  );
  const record = blocked.records.find(
    (entry) => entry.changeId === 'demo-change',
  )!;
  assert.equal(
    inspectObservedRoutingChange(blocked, observed[0]!, record, null, completed)
      .state,
    'resume-available',
  );
  assert.equal(requiredContinuationAction(blocked, resume, completed), null);
  const resumed = applyIntent(blocked, resume, completed);
  assert.equal(resumed.primaryChangeId, null);
  assert.equal(resumed.records[0]!.disposition, 'ready');
  assert.equal(resumed.routingRevision, blocked.routingRevision + 1);
});

test('routing state and admission retain archived/completed/recovery precedence and workset boundaries', () => {
  const source = applyIntent(
    synthesizeSource(observed),
    { schemaVersion: 1, action: { kind: 'focus', changeId: 'demo-change' } },
    observed,
  );
  const change = observed[0]!;
  const record = readyRecord(change.changeId);
  assert.equal(
    inspectObservedRoutingChange(
      source,
      { ...change, archived: true },
      record,
      'recovery-required',
      observed,
    ).state,
    'archived',
  );
  assert.equal(
    inspectObservedRoutingChange(
      source,
      { ...change, completed: true },
      record,
      'recovery-required',
      observed,
    ).state,
    'completed-awaiting-archive',
  );
  assert.equal(
    inspectObservedRoutingChange(
      source,
      change,
      record,
      'recovery-required',
      observed,
    ).state,
    'recovery-required',
  );
  assert.equal(
    admissibleRoutingRole(source, change, record, null, change.changeId),
    'primary',
  );
  assert.equal(
    admissibleRoutingRole(
      source,
      change,
      record,
      'recovery-required',
      change.changeId,
    ),
    null,
  );
  assert.equal(
    admissibleRoutingRole(
      source,
      observed[1],
      readyRecord('repair-change'),
      null,
      'repair-change',
    ),
    null,
  );
});

test('routing domain and required Grant observer type closures cannot reach repository implementations', () => {
  const require = createRequire(import.meta.url);
  const pending = ['change-routing.ts', 'change-routing-grant.ts'].map((name) =>
    fileURLToPath(new URL(`../src/modules/lifecycle/${name}`, import.meta.url)),
  );
  const visited = new Set<string>();
  while (pending.length) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    assert.doesNotMatch(
      file,
      /\/src\/(?:runtime|application|adapters|composition-root|entrypoints)\//,
    );
    assert.doesNotMatch(file, /\/bootstrap\//);
    for (const reference of readModuleReferences(
      file,
      fs.readFileSync(file, 'utf8'),
    )) {
      const specifier = reference.specifier;
      assert.notEqual(specifier, null, file);
      assert.equal(
        /^(?:node:)?(?:fs(?:\/promises)?|child_process|process)$/.test(
          specifier!,
        ),
        false,
        `${file}: ${specifier}`,
      );
      if (specifier!.startsWith('.'))
        pending.push(path.resolve(path.dirname(file), specifier!));
      else if (specifier!.startsWith('@jigwright/core'))
        pending.push(require.resolve(specifier!));
      else
        assert.ok(
          specifier!.startsWith('node:'),
          `${file}: unexpected dependency ${specifier}`,
        );
    }
  }
});
