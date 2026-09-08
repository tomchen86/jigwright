import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { dispatchGovernanceIntakeCommand } from '../src/entrypoints/cli/governance-intake-cli.ts';
import {
  listGovernanceSources,
  readGovernanceSource,
  captureGovernanceSource,
} from '../src/modules/governance-intake/governance-intake.ts';
import {
  applyWorkItemReview,
  correctWorkItemSource,
  createWorkItem,
  ensureWorkItemPromotionSurveyBinding,
  promoteWorkItem,
  showWorkItem,
  workItemDigest,
} from '../src/modules/governance-intake/work-registry.ts';
import {
  createGovernancePersistenceFixture,
  runGitForTest,
  hasCode,
} from './governance-intake-fixture.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { renderHumanCommandResult } from '../src/entrypoints/cli/human-command-output.ts';

test('correct preserves exact Source history, replaces active provenance and can be re-confirmed', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-source-correction-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const { repositoryRoot } = fixture;
    const id = fixture.item.item.id;
    const oldId = fixture.source.source.id;
    const originalBytes = fs.readFileSync(fixture.sourcePath);
    let item = applyWorkItemReview(repositoryRoot, id, {
      action: 'accept',
      expectedDigest: workItemDigest(fixture.item.item),
      summary: 'Original accepted interpretation.',
    });
    item = applyWorkItemReview(repositoryRoot, id, {
      action: 'prioritize',
      expectedDigest: workItemDigest(item),
      lane: 'now',
      blockedBy: [],
    });
    const originPath = path.join(
      repositoryRoot,
      'openspec/changes/corrected-change/origin.json',
    );
    fs.mkdirSync(path.dirname(originPath), { recursive: true });
    ensureWorkItemPromotionSurveyBinding(
      repositoryRoot,
      id,
      'corrected-change',
    );
    promoteWorkItem(repositoryRoot, id, 'corrected-change');
    const exactText =
      '  更正：保留這段逐字內容。\nsha256:' + 'a'.repeat(64) + '\n';
    const correct = () =>
      dispatchGovernanceIntakeCommand(
        'correct',
        [id, oldId, exactText],
        repositoryRoot,
        { now: () => '2026-09-08T01:00:00.000Z' },
      );
    const result = correct();
    assert.equal(result.originalText, exactText);
    const corrected = readGovernanceSource(
      repositoryRoot,
      String(result.sourceId),
    );
    assert.equal(corrected.supersedes, oldId);
    assert.equal(corrected.text, exactText);
    assert.deepEqual(fs.readFileSync(fixture.sourcePath), originalBytes);
    item = showWorkItem(repositoryRoot, id);
    assert.equal(item.stage, 'active');
    assert.equal(item.interpretation.status, 'agent-derived');
    assert.deepEqual(item.sourceRefs, [corrected.id]);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(originPath, 'utf8')).sourceRefs,
      [corrected.id],
    );
    item = applyWorkItemReview(repositoryRoot, id, {
      action: 'accept',
      expectedDigest: workItemDigest(item),
      summary: 'Confirmed corrected requirement.',
    });
    assert.equal(item.stage, 'active');
    assert.equal(
      showWorkItem(repositoryRoot, id).interpretation.status,
      'maintainer-confirmed',
    );
    const sourceCount = listGovernanceSources(repositoryRoot).length;
    assert.equal(correct().updated, false);
    assert.equal(listGovernanceSources(repositoryRoot).length, sourceCount);
    assert.deepEqual(showWorkItem(repositoryRoot, id), item);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('correction reuses captured wording after interruption and reopens backlog interpretation', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-correction-capture-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const repo = fixture.repositoryRoot;
    const id = fixture.item.item.id;
    const old = fixture.source.source.id;
    applyWorkItemReview(repo, id, {
      action: 'accept',
      expectedDigest: workItemDigest(fixture.item.item),
      summary: 'Original interpretation.',
    });
    const args = [id, old, '  New wording\nwith a second line.\n'];
    const sourcesBefore = listGovernanceSources(repo).length;
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand('correct', args, repo, {
          afterCorrectSourceCaptured() {
            throw new Error('interrupted after capture');
          },
        }),
      /interrupted after capture/,
    );
    assert.deepEqual(showWorkItem(repo, id).sourceRefs, [old]);
    assert.equal(listGovernanceSources(repo).length, sourcesBefore + 1);
    const corrected = dispatchGovernanceIntakeCommand('correct', args, repo);
    assert.equal(listGovernanceSources(repo).length, sourcesBefore + 1);
    let item = showWorkItem(repo, id);
    assert.equal(item.stage, 'backlog');
    assert.equal(item.interpretation.status, 'agent-derived');
    item = applyWorkItemReview(repo, id, {
      action: 'accept',
      expectedDigest: workItemDigest(item),
      summary: 'New interpretation confirmed.',
    });
    assert.equal(
      showWorkItem(repo, id).interpretation.status,
      'maintainer-confirmed',
    );
    assert.equal(
      dispatchGovernanceIntakeCommand('correct', args, repo).updated,
      false,
    );
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'correct',
          [id, old, 'Different late correction'],
          repo,
        ),
      /not linked/,
    );
    applyWorkItemReview(repo, id, {
      action: 'decline',
      expectedDigest: workItemDigest(item),
      outcome: 'obsolete',
    });
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'correct',
          [id, String(corrected.sourceId), 'After closure'],
          repo,
        ),
      /closed Work Item/,
    );
    assert.equal(listGovernanceSources(repo).length, sourcesBefore + 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function activate(
  fixture: ReturnType<typeof createGovernancePersistenceFixture>,
  id = fixture.item.item.id,
) {
  const repo = fixture.repositoryRoot;
  const current = showWorkItem(repo, id);
  const accepted = applyWorkItemReview(repo, id, {
    action: 'accept',
    expectedDigest: workItemDigest(current),
    summary: 'Confirmed for implementation.',
  });
  applyWorkItemReview(repo, id, {
    action: 'prioritize',
    expectedDigest: workItemDigest(accepted),
    lane: 'now',
    blockedBy: [],
  });
  fs.mkdirSync(path.join(repo, 'openspec/changes/corrected-change'), {
    recursive: true,
  });
  ensureWorkItemPromotionSurveyBinding(repo, id, 'corrected-change');
  return promoteWorkItem(repo, id, 'corrected-change');
}

test('active Source corrections recover after each journal and paired-write crash', () => {
  const moduleUrl = new URL(
    '../src/modules/governance-intake/work-registry.ts',
    import.meta.url,
  ).href;
  for (const cut of [
    'afterJournalPersisted',
    'afterOriginPublished',
    'afterItemPublished',
  ]) {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'jigwright-correction-recovery-'),
    );
    try {
      const fixture = createGovernancePersistenceFixture(root);
      const { item, originPath } = activate(fixture);
      const source = captureGovernanceSource(fixture.repositoryRoot, {
        ...fixture.sourceInput,
        text: 'Corrected before crash.',
        supersedes: fixture.source.source.id,
      }).source;
      const argv = [
        fixture.repositoryRoot,
        item.id,
        fixture.source.source.id,
        source.id,
        workItemDigest(item),
      ];
      const crashed = spawnSync(process.execPath, [
        '--experimental-strip-types',
        '--input-type=module',
        '--eval',
        `import {correctWorkItemSource} from ${JSON.stringify(moduleUrl)}; correctWorkItemSource(...${JSON.stringify(argv)}, {${cut}(){process.exit(86)}});`,
      ]);
      assert.equal(crashed.status, 86, crashed.stderr.toString());
      const recovered = showWorkItem(fixture.repositoryRoot, item.id);
      assert.deepEqual(recovered.sourceRefs, [source.id]);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(originPath, 'utf8')).sourceRefs,
        [source.id],
      );
      assert.equal(
        correctWorkItemSource(
          fixture.repositoryRoot,
          item.id,
          fixture.source.source.id,
          source.id,
          workItemDigest(item),
        ).updated,
        false,
      );
      const common = runGitForTest(fixture.repositoryRoot, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      assert.deepEqual(
        fs.readdirSync(
          path.join(common, 'workflow-engine/work-registry/promotion-journals'),
        ),
        [],
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('correction preserves shared origin citations and attachment replays preserve confirmation', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-correction-shared-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const repo = fixture.repositoryRoot;
    const first = activate(fixture);
    const second = createWorkItem(repo, {
      schemaVersion: 1,
      kind: 'feature',
      title: 'Related work',
      summary: 'Uses the same original Source.',
      lane: null,
      sourceRefs: [fixture.source.source.id],
    });
    activate(fixture, second.item.id);
    const result = dispatchGovernanceIntakeCommand(
      'correct',
      [
        first.item.id,
        fixture.source.source.id,
        'A correction for the first item.',
      ],
      repo,
    );
    assert.deepEqual(showWorkItem(repo, second.item.id).sourceRefs, [
      fixture.source.source.id,
    ]);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(first.originPath, 'utf8')).sourceRefs,
      [fixture.source.source.id, result.sourceId].sort(),
    );
    const sourcesBefore = listGovernanceSources(repo).length;
    dispatchGovernanceIntakeCommand(
      'attach',
      [second.item.id, String(result.sourceId)],
      repo,
    );
    let item = showWorkItem(repo, second.item.id);
    assert.deepEqual(
      item.sourceRefs,
      [fixture.source.source.id, result.sourceId].sort(),
    );
    item = applyWorkItemReview(repo, item.id, {
      action: 'accept',
      expectedDigest: workItemDigest(item),
      summary: 'Both Sources confirmed.',
    });
    assert.equal(
      dispatchGovernanceIntakeCommand(
        'attach',
        [item.id, String(result.sourceId)],
        repo,
      ).updated,
      false,
    );
    assert.deepEqual(showWorkItem(repo, item.id), item);
    assert.equal(listGovernanceSources(repo).length, sourcesBefore);
    const priorOrigin = JSON.parse(fs.readFileSync(first.originPath, 'utf8'));
    priorOrigin.sourceRefs = [fixture.source.source.id];
    fs.writeFileSync(first.originPath, `${canonicalJson(priorOrigin)}\n`);
    assert.equal(
      dispatchGovernanceIntakeCommand(
        'attach',
        [item.id, String(result.sourceId)],
        repo,
      ).updated,
      true,
    );
    assert.deepEqual(showWorkItem(repo, item.id), item);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(first.originPath, 'utf8')).sourceRefs,
      [fixture.source.source.id, result.sourceId].sort(),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('correction CAS rolls back its origin update while preserving a concurrent item edit', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-correction-cas-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const { item, originPath } = activate(fixture);
    const source = captureGovernanceSource(fixture.repositoryRoot, {
      ...fixture.sourceInput,
      text: 'Correction losing the CAS race.',
      supersedes: fixture.source.source.id,
    }).source;
    const itemPath = path.join(
      fixture.repositoryRoot,
      fixture.item.relativePath,
    );
    const beforeOrigin = fs.readFileSync(originPath);
    const concurrent = { ...item, title: 'An independent title edit.' };
    assert.throws(
      () =>
        correctWorkItemSource(
          fixture.repositoryRoot,
          item.id,
          fixture.source.source.id,
          source.id,
          workItemDigest(item),
          {
            afterOriginPublished() {
              fs.writeFileSync(itemPath, `${canonicalJson(concurrent)}\n`);
            },
          },
        ),
      hasCode('WORK_REGISTRY_TRANSACTION_CONFLICT'),
    );
    assert.deepEqual(showWorkItem(fixture.repositoryRoot, item.id), concurrent);
    assert.deepEqual(fs.readFileSync(originPath), beforeOrigin);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('intake mutation results expose canonical wording and Work Item titles', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-intake-wording-'),
  );
  try {
    const fixture = createGovernancePersistenceFixture(root);
    const repo = fixture.repositoryRoot;
    const exactText = '  Preserve SRC-' + 'b'.repeat(64) + '\nverbatim.\n';
    const sourceInput = path.join(root, 'source.json');
    fs.writeFileSync(
      sourceInput,
      JSON.stringify({ ...fixture.sourceInput, text: exactText }),
    );
    const captured = dispatchGovernanceIntakeCommand(
      'source',
      ['capture', '--input', sourceInput],
      repo,
    );
    assert.equal(captured.originalText, exactText);
    fs.mkdirSync(path.join(repo, 'openspec/changes/wording'), {
      recursive: true,
    });
    assert.equal(
      dispatchGovernanceIntakeCommand(
        'source',
        ['link-change', String(captured.sourceId), '--change', 'wording'],
        repo,
      ).originalText,
      exactText,
    );
    const findingInput = path.join(root, 'finding.json');
    fs.writeFileSync(
      findingInput,
      JSON.stringify({ schemaVersion: 1, text: exactText, sourceRefs: [] }),
    );
    const deps = {
      resolveRepositoryScope: () => fixture.findingContext,
      resolveRuntimeRoot: () => fixture.runtimeRoot,
    };
    const added = dispatchGovernanceIntakeCommand(
      'finding',
      ['add', '--input', findingInput],
      repo,
      deps,
    );
    assert.equal(added.originalText, exactText);
    const converted = dispatchGovernanceIntakeCommand(
      'finding',
      ['convert', String(added.findingId)],
      repo,
      deps,
    );
    assert.equal(converted.originalText, exactText);
    assert.equal(
      converted.title,
      showWorkItem(repo, String(converted.workItemId)).title,
    );
    const attached = dispatchGovernanceIntakeCommand(
      'attach',
      [fixture.item.item.id, String(captured.sourceId)],
      repo,
    );
    for (const result of [captured, added, converted, attached]) {
      assert.ok(
        renderHumanCommandResult({
          command: 'intake',
          ok: true,
          result,
        }).includes(exactText),
      );
    }
    assert.equal(attached.originalText, exactText);
    assert.equal(
      attached.title,
      showWorkItem(repo, fixture.item.item.id).title,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
