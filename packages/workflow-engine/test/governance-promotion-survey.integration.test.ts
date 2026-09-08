import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { captureGovernanceSource } from '../src/modules/governance-intake/governance-intake.ts';
import { dispatchGovernanceIntakeCommand } from '../src/entrypoints/cli/governance-intake-cli.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  applyWorkItemReview,
  createWorkItem,
  prepareWorkItemPromotionSurvey,
  promoteWorkItem,
  workItemDigest,
} from '../src/modules/governance-intake/work-registry.ts';
import {
  runGitForTest,
  configureRepositoryConsumer,
  hasCode,
} from './governance-intake-fixture.ts';

test('promotion recomputes immutable consumers and rejects poisoned same-head survey facts before mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-survey-'));
  configureRepositoryConsumer(root);
  try {
    runGitForTest(root, ['init', '-b', 'main']);
    runGitForTest(root, ['config', 'user.name', 'Jigwright Test']);
    runGitForTest(root, ['config', 'user.email', 'jigwright@example.test']);
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src/first.ts'),
      'export const sharedAuthority = true;\n',
    );
    fs.writeFileSync(
      path.join(root, 'src/second.ts'),
      'import { sharedAuthority } from "./first";\n',
    );
    runGitForTest(root, ['add', 'src']);
    runGitForTest(root, ['commit', '-m', 'Add survey facts']);

    const source = captureGovernanceSource(root, {
      semanticAuthor: 'agent',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T04:42:30.000Z',
      contextRef: 'session:survey-current-consumers',
      text: 'Inspect current consumers before promotion.\n',
      supersedes: null,
    }).source;

    const item = createWorkItem(
      root,
      {
        schemaVersion: 1,
        kind: 'research',
        lane: 'next',
        title: 'Survey current consumers',
        summary: 'Inspect current consumers before promotion.',
        sourceRefs: [source.id],
      },
      {
        now: () => '2026-08-24T04:43:00.000Z',
        createId: () => 'WORK-01K39R0V000000000000000005',
      },
    ).item;
    const accepted = applyWorkItemReview(
      root,
      item.id,
      {
        action: 'accept',
        expectedDigest: workItemDigest(item),
        summary: item.interpretation.summary,
      },
      () => '2026-08-24T04:43:30.000Z',
    );
    fs.mkdirSync(path.join(root, 'openspec/changes/survey-change'), {
      recursive: true,
    });
    assert.throws(
      () =>
        promoteWorkItem(
          root,
          accepted.id,
          'survey-change',
          () => '2026-08-24T04:44:00.000Z',
          workItemDigest(accepted),
        ),
      (error: unknown) =>
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === 'WORK_REGISTRY_SURVEY_REQUIRED',
    );
    const survey = prepareWorkItemPromotionSurvey(
      root,
      accepted.id,
      'survey-change',
      {
        schemaVersion: 1,
        symbols: ['sharedAuthority'],
        emptyReason: null,
      },
    );
    assert.deepEqual(survey.survey.symbols, [
      {
        symbol: 'sharedAuthority',
        consumerPaths: ['src/first.ts', 'src/second.ts'],
      },
    ]);
    const surveyPath = path.join(root, survey.relativePath);
    const surveyBytes = fs.readFileSync(surveyPath, 'utf8');
    const poisonedSurvey = {
      ...(JSON.parse(surveyBytes) as Record<string, unknown>),
      symbols: [
        {
          symbol: 'sharedAuthority',
          consumerPaths: [],
        },
      ],
    };
    const poisonedSurveyBytes = `${canonicalJson(poisonedSurvey)}\n`;
    fs.writeFileSync(surveyPath, poisonedSurveyBytes);
    const itemPath = path.join(
      root,
      'docs/work-registry/items/2026',
      `${accepted.id}.yaml`,
    );
    const itemBytes = fs.readFileSync(itemPath, 'utf8');
    const originPath = path.join(
      root,
      'openspec/changes/survey-change/origin.json',
    );

    assert.throws(
      () =>
        promoteWorkItem(
          root,
          accepted.id,
          'survey-change',
          () => '2026-08-24T04:44:00.000Z',
          workItemDigest(accepted),
        ),
      hasCode('WORK_REGISTRY_SURVEY_REQUIRED'),
    );
    assert.equal(fs.readFileSync(surveyPath, 'utf8'), poisonedSurveyBytes);
    assert.equal(fs.readFileSync(itemPath, 'utf8'), itemBytes);
    assert.equal(fs.existsSync(originPath), false);

    fs.writeFileSync(surveyPath, surveyBytes);
    const promoted = promoteWorkItem(
      root,
      accepted.id,
      'survey-change',
      () => '2026-08-24T04:44:00.000Z',
      workItemDigest(accepted),
    );
    assert.equal(promoted.item.stage, 'active');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one promote command skips surveys for maintainer premises and prepares a current empty survey for agent premises', () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-conditional-promotion-survey-'),
  );
  configureRepositoryConsumer(root);
  try {
    runGitForTest(root, ['init', '-b', 'main']);
    runGitForTest(root, ['config', 'user.name', 'Jigwright Test']);
    runGitForTest(root, ['config', 'user.email', 'jigwright@example.test']);
    const maintainerSource = captureGovernanceSource(root, {
      semanticAuthor: 'maintainer',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T04:45:00.000Z',
      contextRef: 'direct-human:thread/turn-45',
      text: 'Promote this reviewed maintainer premise.\n',
      supersedes: null,
    }).source;
    const agentSource = captureGovernanceSource(root, {
      semanticAuthor: 'agent',
      capturedBy: 'jigwright',
      capturedAt: '2026-08-24T04:45:10.000Z',
      contextRef: 'session:conditional-survey',
      text: 'Promote this reviewed agent premise.\n',
      supersedes: null,
    }).source;
    const prepare = (
      id: string,
      changeId: string,
      sourceRefs: readonly string[],
    ) => {
      const created = createWorkItem(
        root,
        {
          schemaVersion: 1,
          kind: 'feature',
          lane: 'next',
          title: `Conditional survey for ${changeId}`,
          summary: 'Bind survey evidence only to agent-authored premises.',
          sourceRefs,
        },
        {
          now: () => '2026-08-24T04:45:20.000Z',
          createId: () => id,
        },
      );
      const accepted = applyWorkItemReview(
        root,
        created.item.id,
        {
          action: 'accept',
          expectedDigest: workItemDigest(created.item),
          summary: created.item.interpretation.summary,
        },
        () => '2026-08-24T04:45:30.000Z',
      );
      fs.mkdirSync(path.join(root, 'openspec/changes', changeId), {
        recursive: true,
      });
      return accepted;
    };
    const maintainer = prepare(
      'WORK-01K39R0V00000000000000000N',
      'maintainer-premise',
      [maintainerSource.id],
    );
    const agent = prepare('WORK-01K39R0V00000000000000000P', 'agent-premise', [
      agentSource.id,
    ]);
    const protectedMaintainer = prepare(
      'WORK-01K39R0V00000000000000000Q',
      'protected-maintainer-premise',
      [maintainerSource.id],
    );
    runGitForTest(root, ['add', '.']);
    runGitForTest(root, ['commit', '-m', 'Prepare conditional surveys']);

    assert.equal(
      dispatchGovernanceIntakeCommand(
        'work-item',
        [
          'promote',
          maintainer.id,
          '--change',
          'maintainer-premise',
          '--expected',
          workItemDigest(maintainer),
        ],
        root,
        { now: () => '2026-08-24T04:46:00.000Z' },
      ).action,
      'promote',
    );
    assert.equal(
      fs.existsSync(
        path.join(root, 'openspec/changes/maintainer-premise/survey.json'),
      ),
      false,
    );

    assert.equal(
      dispatchGovernanceIntakeCommand(
        'work-item',
        [
          'promote',
          agent.id,
          '--change',
          'agent-premise',
          '--expected',
          workItemDigest(agent),
        ],
        root,
        { now: () => '2026-08-24T04:46:10.000Z' },
      ).action,
      'promote',
    );
    const agentSurvey = JSON.parse(
      fs.readFileSync(
        path.join(root, 'openspec/changes/agent-premise/survey.json'),
        'utf8',
      ),
    );
    assert.deepEqual(agentSurvey.symbols, []);
    assert.match(agentSurvey.emptyReason, /agent-authored premise/u);

    fs.mkdirSync(path.join(root, 'workflow'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'workflow/work-registry-policy.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        transitions: {
          intake: 'ordinary',
          prioritize: 'ordinary',
          promote: 'central-grant',
        },
      })}\n`,
    );
    const protectedItemPath = path.join(
      root,
      'docs/work-registry/items/2026',
      `${protectedMaintainer.id}.yaml`,
    );
    const protectedItemBytes = fs.readFileSync(protectedItemPath, 'utf8');
    assert.throws(
      () =>
        dispatchGovernanceIntakeCommand(
          'work-item',
          [
            'promote',
            protectedMaintainer.id,
            '--change',
            'protected-maintainer-premise',
            '--expected',
            workItemDigest(protectedMaintainer),
          ],
          root,
        ),
      hasCode('WORK_REGISTRY_GRANT_REQUIRED'),
    );
    assert.equal(
      fs.readFileSync(protectedItemPath, 'utf8'),
      protectedItemBytes,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          root,
          'openspec/changes/protected-maintainer-premise/survey.json',
        ),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(
          root,
          'openspec/changes/protected-maintainer-premise/origin.json',
        ),
      ),
      false,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
