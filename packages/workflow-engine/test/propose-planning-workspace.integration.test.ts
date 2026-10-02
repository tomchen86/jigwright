import { listGovernanceFindings } from '../src/composition-root/governance-findings-production.ts';
import {
  listWorkItems,
  showWorkItem,
} from '../src/composition-root/work-registry-production.ts';
import {
  readFindingRecordForTest,
  snapshotFindingRefForTest,
} from './governance-intake-fixture.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import type { InvestigationSession } from '../src/modules/investigation/domain/investigation-session-types.ts';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createInvestigationCheckpointEnvelope } from '../src/adapters/planning/investigation/investigation-session.ts';
import {
  preparePlanningDraftWorkspace,
  readPlanningDraftWorkspace,
} from '../src/composition-root/planning-workspace-production.ts';
import { startPropose } from '../src/composition-root/propose-production.ts';
import {
  captureGovernanceSource,
  listGovernanceSources,
  readGovernanceSource,
} from '../src/composition-root/governance-sources-production.ts';
import { prepareExecutionMandate } from './execution-mandate-fixture.ts';
import {
  createFixtureRepository,
  git,
  runtimeRoot,
  sourceRepositoryRoot,
} from './fixture.ts';

test('fresh and resumed propose stay inside one engine-owned planning worktree', () => {
  const repository = createFixtureRepository();
  const inputDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'propose-workspace-input-')),
  );
  const changeId = 'owned-planning-draft';
  const mandate = prepareExecutionMandate(repository, changeId);
  const sourceHead = git(repository, ['rev-parse', 'HEAD']).trim();
  const sourceBranch = git(repository, [
    'symbolic-ref',
    '--short',
    'HEAD',
  ]).trim();
  const intentPath = path.join(inputDirectory, 'intent.json');
  let planningWorktree: string | undefined;
  try {
    fs.writeFileSync(
      intentPath,
      `${JSON.stringify({
        schemaVersion: 1,
        summary: 'Keep every planning draft byte out of the source worktree.',
        sourceRefs: [],
        explicitPaths: ['src/.gitkeep'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      })}\n`,
    );

    const started = runWorkflowCli(repository, [
      'propose',
      changeId,
      '--intent',
      intentPath,
      '--mandate',
      mandate.taskId,
      '--actor',
      'codex',
    ]);
    assert.equal(started.status, 0, started.stderr);
    const startedPayload = JSON.parse(started.stdout) as {
      result: {
        state: string;
        investigation: Parameters<
          typeof createInvestigationCheckpointEnvelope
        >[0];
      };
    };
    assert.equal(startedPayload.result.state, 'awaiting-main-terms');

    const owner = readPlanningDraftWorkspace(repository, changeId);
    assert.ok(owner);
    planningWorktree = owner.worktreePath;
    assert.equal(owner.baseCommit, sourceHead);
    assert.equal(owner.branch, `work/${changeId}`);
    assert.equal(
      git(planningWorktree, ['rev-parse', 'HEAD']).trim(),
      sourceHead,
    );
    assert.equal(
      git(planningWorktree, ['symbolic-ref', '--short', 'HEAD']).trim(),
      `work/${changeId}`,
    );
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), sourceHead);
    assert.equal(
      git(repository, ['symbolic-ref', '--short', 'HEAD']).trim(),
      sourceBranch,
    );
    assert.equal(git(repository, ['status', '--porcelain=v1']), '');
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes', changeId)),
      false,
    );

    const investigationId = startedPayload.result.investigation.investigationId;
    const session = JSON.parse(
      fs.readFileSync(
        path.join(
          runtimeRoot(repository),
          'investigations/sessions',
          `${investigationId}.json`,
        ),
        'utf8',
      ),
    ) as { repositoryRoot: string; branch: string };
    assert.equal(session.repositoryRoot, planningWorktree);
    assert.equal(session.branch, `work/${changeId}`);

    const sessionPath = path.join(
      runtimeRoot(repository),
      'investigations/sessions',
      `${investigationId}.json`,
    );
    const ownerPath = path.join(
      runtimeRoot(repository),
      'planning-drafts',
      `${changeId}.json`,
    );
    const ownerBeforeStatus = fs.readFileSync(ownerPath);
    const sessionBeforeStatus = fs.readFileSync(sessionPath);
    const status = runWorkflowCli(repository, ['status', investigationId]);
    assert.equal(status.status, 0, status.stderr);
    assert.equal(
      JSON.parse(status.stdout).result.investigation.investigationId,
      investigationId,
    );
    assert.deepEqual(fs.readFileSync(ownerPath), ownerBeforeStatus);
    assert.deepEqual(fs.readFileSync(sessionPath), sessionBeforeStatus);

    const proposalPath = path.join(
      planningWorktree,
      'openspec/changes',
      changeId,
      'proposal.md',
    );
    fs.mkdirSync(path.dirname(proposalPath), { recursive: true });
    fs.writeFileSync(proposalPath, '# Owned planning draft\n');
    const checkpointPath = path.join(inputDirectory, 'main-terms.json');
    fs.writeFileSync(
      checkpointPath,
      `${JSON.stringify(
        createInvestigationCheckpointEnvelope(
          startedPayload.result.investigation,
          {
            reference: 'owned-worktree-main-survey',
            terms: [
              {
                kind: 'symbol',
                value: 'OwnedPlanningDraft',
                rationale:
                  'The main investigation must remain bound to the owned worktree.',
                expectedRelationship:
                  'The planning transition consumes this exact draft lineage.',
              },
            ],
          },
        ),
      )}\n`,
    );

    const resumed = runWorkflowCli(repository, [
      'propose',
      changeId,
      '--resume',
      '--input',
      checkpointPath,
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(
      JSON.parse(resumed.stdout).result.state,
      'waiting-for-provider',
    );
    assert.equal(
      fs.readFileSync(proposalPath, 'utf8'),
      '# Owned planning draft\n',
    );
    assert.equal(git(repository, ['status', '--porcelain=v1']), '');
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes', changeId)),
      false,
    );
    assert.deepEqual(readPlanningDraftWorkspace(repository, changeId), owner);
  } finally {
    if (planningWorktree) {
      git(repository, ['worktree', 'remove', '--force', planningWorktree]);
      fs.rmSync(path.dirname(planningWorktree), {
        recursive: true,
        force: true,
      });
    }
    mandate.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(inputDirectory, { recursive: true, force: true });
  }
});

test('finding-converted immediate Source bootstrap resumes a source-only crash into one exact cited planning origin', () => {
  const repository = createFixtureRepository();
  const sourceText = 'Resume the exact immediate Source bootstrap.';
  const changeId = `source-${crypto.createHash('sha256').update(sourceText).digest('hex')}`;
  const mandate = prepareExecutionMandate(repository, changeId);
  let planningWorktree: string | undefined;
  try {
    const source = captureGovernanceSource(repository, {
      semanticAuthor: 'agent',
      capturedBy: 'jigwright-finding-convert',
      capturedAt: '2026-08-24T03:24:30.000Z',
      contextRef:
        'finding:FND-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      text: sourceText,
      supersedes: null,
    }).source;
    const owner = preparePlanningDraftWorkspace(repository, changeId);
    planningWorktree = owner.worktreePath;
    captureGovernanceSource(planningWorktree, {
      semanticAuthor: source.semanticAuthor,
      capturedBy: source.capturedBy,
      capturedAt: source.capturedAt,
      contextRef: source.contextRef,
      text: source.text,
      supersedes: source.supersedes,
    });
    assert.equal(
      fs.existsSync(
        path.join(
          planningWorktree,
          'openspec/changes',
          changeId,
          'origin.json',
        ),
      ),
      false,
    );

    const started = startPropose(
      repository,
      changeId,
      {
        schemaVersion: 1,
        summary: `Implement the immediate change cited by ${source.id}.`,
        sourceRefs: [source.id],
        explicitPaths: [],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      {
        explicitActor: 'codex',
        environment: {},
        taskMandateId: mandate.taskId,
        immediateSource: { sourceId: source.id, exactText: source.text },
      },
    );
    assert.equal(started.state, 'awaiting-main-terms');
    assert.deepEqual(readGovernanceSource(planningWorktree, source.id), source);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(
            planningWorktree,
            'openspec/changes',
            changeId,
            'origin.json',
          ),
          'utf8',
        ),
      ),
      { schemaVersion: 1, sourceRefs: [source.id], workItemRefs: [] },
    );
    assert.doesNotThrow(() =>
      preparePlanningDraftWorkspace(repository, changeId, {
        baseCommit: owner.baseCommit,
        workspaceParent: path.dirname(planningWorktree!),
      }),
    );
  } finally {
    if (planningWorktree) {
      git(repository, ['worktree', 'remove', '--force', planningWorktree]);
      fs.rmSync(path.dirname(planningWorktree), {
        recursive: true,
        force: true,
      });
    }
    mandate.dispose();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('top-level now starts the stable Source-bound planning workspace without an intent envelope', () => {
  const repository = createFixtureRepository();
  const original = 'Start the immediate Source-bound planning workspace.';
  const changeId = `source-${crypto.createHash('sha256').update(original).digest('hex')}`;
  let planningWorktree: string | undefined;
  try {
    const started = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          sourceRepositoryRoot,
          'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
        ),
        'now',
        original,
        '--json',
      ],
      {
        cwd: repository,
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENT: undefined,
          CLAUDECODE: undefined,
          CLAUDE_CODE_ENTRYPOINT: undefined,
          CODEX_SANDBOX: 'seatbelt',
          WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
        },
      },
    );
    assert.equal(started.status, 0, started.stderr);
    const payload = JSON.parse(started.stdout) as {
      result: {
        action: string;
        originalText: string;
        sourceId: string;
        changeId: string;
        propose: {
          state: string;
          investigation: { investigationId: string } | null;
        };
        nextSteps: string[];
      };
    };
    assert.equal(payload.result.action, 'now');
    assert.equal(payload.result.originalText, original);
    assert.equal(payload.result.changeId, changeId);
    assert.equal(payload.result.propose.state, 'awaiting-main-terms');
    assert.deepEqual(payload.result.nextSteps, [
      `pnpm workflow status ${payload.result.propose.investigation?.investigationId} --json`,
    ]);
    const owner = readPlanningDraftWorkspace(repository, changeId);
    assert.ok(owner);
    planningWorktree = owner.worktreePath;
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(
            planningWorktree,
            'openspec/changes',
            changeId,
            'origin.json',
          ),
          'utf8',
        ),
      ),
      {
        schemaVersion: 1,
        sourceRefs: [payload.result.sourceId],
        workItemRefs: [],
      },
    );
  } finally {
    if (planningWorktree) {
      git(repository, ['worktree', 'remove', '--force', planningWorktree]);
      fs.rmSync(path.dirname(planningWorktree), {
        recursive: true,
        force: true,
      });
    }
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('actual host Finding conversion keeps no Source, durable inbox/receipt, real planning bootstrap and exact replay', () => {
  const repository = createFixtureRepository();
  const inputDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'finding-propose-input-'),
  );
  const text =
    'Start this observed retry problem without inventing a user Source.\nPreserve the complete Finding text.';
  const changeId = `source-${crypto.createHash('sha256').update(text).digest('hex')}`;
  const inputPath = path.join(inputDirectory, 'finding.json');
  let planningWorktree: string | undefined;
  try {
    const sourceHead = git(repository, ['rev-parse', 'HEAD']).trim();
    const sourceBranch = git(repository, [
      'symbolic-ref',
      '--short',
      'HEAD',
    ]).trim();
    const sourcesBefore = listGovernanceSources(repository);
    const itemCountBefore = listWorkItems(repository).length;
    fs.writeFileSync(
      inputPath,
      `${JSON.stringify({ schemaVersion: 1, text, sourceRefs: [] })}\n`,
    );
    const added = runWorkflowCli(
      repository,
      ['finding', 'add', '--input', inputPath],
      false,
    );
    assert.equal(added.status, 0, added.stderr);
    const add = JSON.parse(added.stdout).result;
    assert.equal(add.action, 'add');
    assert.equal(add.originalText, text);
    const findingId = String(add.findingId);
    const workItemId = `WORK-${findingId.slice(4, 30).toUpperCase()}`;
    const originalFinding = readFindingRecordForTest(repository, add.path);
    assert.equal(
      listGovernanceFindings(runtimeRoot(repository)).find(
        (x) => x.id === findingId,
      )?.disposition,
      'pending',
    );

    const unresolved = runWorkflowCli(
      repository,
      ['finding', 'convert', findingId, '--now'],
      false,
    );
    assert.equal(unresolved.status, 0, unresolved.stderr);
    const first = JSON.parse(unresolved.stdout).result;
    assert.equal(first.action, 'convert');
    assert.equal(first.originalText, text);
    assert.equal(first.sourceId, null);
    assert.equal(first.kind, 'bug');
    assert.equal(first.workItemId, workItemId);
    assert.equal(first.immediateChange.sourceId, null);
    assert.equal(first.immediateChange.changeId, changeId);
    assert.equal(
      first.immediateChange.propose.state,
      'actor-resolution-required',
    );
    assert.equal(readPlanningDraftWorkspace(repository, changeId), null);
    const item = showWorkItem(repository, workItemId);
    assert.equal(item.stage, 'inbox');
    assert.equal(item.interpretation.summary, text);
    assert.deepEqual(item.sourceRefs, []);
    assert.deepEqual(item.changeRefs, []);
    assert.equal(listWorkItems(repository).length, itemCountBefore + 1);
    const finding = listGovernanceFindings(runtimeRoot(repository)).find(
      (x) => x.id === findingId,
    )!;
    assert.equal(finding.disposition, 'converted');
    assert.deepEqual(finding.target, { kind: 'work-item', id: workItemId });
    assert.deepEqual(
      readFindingRecordForTest(repository, add.path),
      originalFinding,
    );
    const receiptRef = snapshotFindingRefForTest(repository);
    assert.deepEqual(listGovernanceSources(repository), sourcesBefore);

    const started = runWorkflowCli(
      repository,
      ['finding', 'convert', findingId, '--now'],
      true,
    );
    const owner = readPlanningDraftWorkspace(repository, changeId);
    planningWorktree = owner?.worktreePath;
    assert.equal(started.status, 0, started.stderr);
    const result = JSON.parse(started.stdout).result;
    assert.equal(result.action, 'convert');
    assert.equal(result.originalText, text);
    assert.equal(result.sourceId, null);
    assert.equal(result.workItemId, workItemId);
    assert.equal(result.workItemCreated, false);
    assert.equal(result.created, false);
    assert.equal(result.immediateChange.sourceId, null);
    assert.equal(result.immediateChange.changeId, changeId);
    assert.equal(result.immediateChange.propose.state, 'awaiting-main-terms');
    const investigationId =
      result.immediateChange.propose.investigation.investigationId;
    assert.ok(owner);
    assert.equal(owner.baseCommit, sourceHead);
    assert.equal(owner.branch, `work/${changeId}`);
    assert.deepEqual(result.nextSteps, [
      `pnpm workflow status ${investigationId} --json`,
    ]);
    const sessionPath = path.join(
      runtimeRoot(repository),
      'investigations/sessions',
      `${investigationId}.json`,
    );
    const session = JSON.parse(
      fs.readFileSync(sessionPath, 'utf8'),
    ) as InvestigationSession;
    assert.equal(session.repositoryRoot, owner.worktreePath);
    assert.equal(session.branch, owner.branch);
    assert.equal(session.changeId, changeId);
    assert.equal(
      session.intentDigest,
      crypto
        .createHash('sha256')
        .update(
          canonicalJson({
            schemaVersion: 1,
            summary: text,
            sourceRefs: [],
            explicitPaths: [],
            explicitSymbols: [],
            explicitConfigKeys: [],
            renamePairs: [],
          }),
        )
        .digest('hex'),
    );
    assert.deepEqual(listGovernanceSources(repository), sourcesBefore);
    assert.deepEqual(listGovernanceSources(owner.worktreePath), sourcesBefore);
    assert.equal(
      fs.existsSync(
        path.join(
          owner.worktreePath,
          'openspec/changes',
          changeId,
          'origin.json',
        ),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(repository, 'openspec/changes', changeId)),
      false,
    );
    assert.deepEqual(showWorkItem(repository, workItemId), item);
    assert.equal(snapshotFindingRefForTest(repository), receiptRef);
    assert.equal(git(repository, ['rev-parse', 'HEAD']).trim(), sourceHead);
    assert.equal(
      git(repository, ['symbolic-ref', '--short', 'HEAD']).trim(),
      sourceBranch,
    );

    const retried = runWorkflowCli(
      repository,
      ['finding', 'convert', findingId, '--now'],
      true,
    );
    assert.equal(retried.status, 0, retried.stderr);
    const replay = JSON.parse(retried.stdout).result;
    assert.equal(replay.workItemId, workItemId);
    assert.equal(replay.sourceId, null);
    assert.equal(replay.workItemCreated, false);
    assert.equal(replay.created, false);
    assert.equal(replay.immediateChange.propose.state, 'awaiting-main-terms');
    assert.equal(
      replay.immediateChange.propose.investigation.investigationId,
      investigationId,
    );
    assert.deepEqual(readPlanningDraftWorkspace(repository, changeId), owner);
    assert.deepEqual(showWorkItem(repository, workItemId), item);
    assert.equal(listWorkItems(repository).length, itemCountBefore + 1);
    assert.equal(snapshotFindingRefForTest(repository), receiptRef);
    assert.deepEqual(
      readFindingRecordForTest(repository, add.path),
      originalFinding,
    );
    assert.deepEqual(listGovernanceSources(repository), sourcesBefore);
    assert.deepEqual(listGovernanceSources(owner.worktreePath), sourcesBefore);
    assert.equal(
      fs.existsSync(
        path.join(
          owner.worktreePath,
          'openspec/changes',
          changeId,
          'origin.json',
        ),
      ),
      false,
    );
  } finally {
    const errors: string[] = [];
    try {
      planningWorktree ??= readPlanningDraftWorkspace(
        repository,
        changeId,
      )?.worktreePath;
    } catch (error) {
      errors.push(String(error));
    }
    if (planningWorktree) {
      try {
        git(repository, ['worktree', 'remove', '--force', planningWorktree]);
      } catch (error) {
        errors.push(String(error));
      }
      try {
        fs.rmSync(path.dirname(planningWorktree), {
          recursive: true,
          force: true,
        });
      } catch (error) {
        errors.push(String(error));
      }
    }
    try {
      fs.rmSync(repository, { recursive: true, force: true });
    } catch (error) {
      errors.push(String(error));
    }
    try {
      fs.rmSync(inputDirectory, { recursive: true, force: true });
    } catch (error) {
      errors.push(String(error));
    }
    assert.deepEqual(errors, []);
    assert.equal(fs.existsSync(repository), false);
    assert.equal(fs.existsSync(inputDirectory), false);
    if (planningWorktree) assert.equal(fs.existsSync(planningWorktree), false);
  }
});

function runWorkflowCli(repository: string, args: string[], actor = false) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(
        sourceRepositoryRoot,
        'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
      ),
      ...args,
      '--json',
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT: undefined,
        CLAUDECODE: undefined,
        CLAUDE_CODE_ENTRYPOINT: undefined,
        CODEX_SANDBOX: actor ? 'seatbelt' : undefined,
        WORKFLOW_TEST_DISABLE_PROVIDER_DISPATCH: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}
