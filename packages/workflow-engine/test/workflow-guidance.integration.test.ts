import { planningTransitionExecution as productionPlanningExecution } from '../src/composition-root/planning-execution-epoch-production.ts';
import { productionChangeRoutingAdmissionReader } from '../src/composition-root/change-routing-observation-production.ts';
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
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  projectWorkflowNextSteps,
  WORKFLOW_GUIDANCE_CATALOG,
  workflowCommandGuidance,
  workflowFailureRecoveryCommand,
  workflowResultNextSteps,
} from '../src/modules/guidance/next-steps/workflow-guidance.ts';
import {
  createManagedWorkflowCommandRegistry,
  MANAGED_WORKFLOW_COMMAND_REGISTRY,
  resolveManagedWorkflowCommandRoute,
} from '../src/modules/guidance/catalog/managed-workflow-command-registry.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../src/foundation/errors/errors.ts';
import { finalizeTask } from '../src/composition-root/finalization-production.ts';
import { reviseTask } from '../src/application/revise/task-revision.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../src/application/propose/planning-transition.ts';
import {
  getSession,
  startSession,
} from '../src/application/execute-task/session.ts';
import {
  configureChecks,
  createFixtureRepository,
  git,
  runtimeRoot,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';
import { satisfyCurrentTaskDiffReview } from './support/task-diff-review-fixture.ts';
import { recordGovernanceFinding } from '../src/composition-root/governance-findings-production.ts';

const cliPath = path.join(
  sourceRepositoryRoot,
  'packages/workflow-engine/src/entrypoints/cli/workflow-cli.ts',
);

test('retired start command is absent and fails before repository mutation', () => {
  assert.equal(
    MANAGED_WORKFLOW_COMMAND_REGISTRY.entries.some(
      ({ id }) => (id as string) === 'start',
    ),
    false,
  );
  const cliSource = fs.readFileSync(cliPath, 'utf8');
  assert.doesNotMatch(cliSource, /session start will fail/u);
  assert.doesNotMatch(cliSource, /migrate accepted legacy requirements/u);
  assert.doesNotMatch(cliSource, /REQUIREMENT_LOG/u);

  const repository = createFixtureRepository();
  try {
    const beforeStatus = git(repository, ['status', '--porcelain=v1']);
    const runtime = path.join(repository, '.git/workflow-engine');
    const runtimeExisted = fs.existsSync(runtime);
    const run = spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        cliPath,
        'start',
        'demo-change',
        '--task',
        '1.1',
        '--json',
      ],
      { cwd: repository, encoding: 'utf8' },
    );

    assert.equal(run.status, 2, run.stderr);
    assert.equal(
      (
        JSON.parse(run.stderr.trim().split('\n').at(-1) ?? '') as {
          error: { code: string };
        }
      ).error.code,
      'INVALID_USAGE',
    );
    assert.equal(git(repository, ['status', '--porcelain=v1']), beforeStatus);
    assert.equal(fs.existsSync(runtime), runtimeExisted);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow guide exposes one versioned advisory catalog with finalize as the preferred surface', () => {
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, 'guide', '--json'],
    { cwd: sourceRepositoryRoot, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    command: 'guide',
    ok: true,
    guide: WORKFLOW_GUIDANCE_CATALOG,
    nextSteps: [],
  });
  assert.equal(WORKFLOW_GUIDANCE_CATALOG.authority, 'advisory');
  assert.equal(WORKFLOW_GUIDANCE_CATALOG.schemaVersion, 1);
  assert.equal(WORKFLOW_GUIDANCE_CATALOG.kind, 'workflow-command-guide.v1');
  assert.equal(
    WORKFLOW_GUIDANCE_CATALOG.catalogVersion,
    'managed-task-lifecycle.v3',
  );
  assert.equal(workflowCommandGuidance('finalize').status, 'preferred');
  assert.deepEqual(workflowCommandGuidance('finalize').usage, [
    'pnpm workflow finalize <session-id> --message <subject> [--full-gate] [--json]',
  ]);
  assert.deepEqual(workflowCommandGuidance('open-task').usage, [
    'pnpm workflow open-task <change-id> [--task <task-id>] [--mandate <mandate-task-id>] [--json]',
  ]);
  assert.deepEqual(workflowCommandGuidance('route').usage, [
    'pnpm workflow route <prepare --intent <intent.json> --output <review.json> [--grant <challenge-id>]|apply <review.json>|status> [--json]',
  ]);
  assert.match(
    workflowCommandGuidance('route').preconditions.join('\n'),
    /task, Manifest, and PlanReview facts/u,
  );
  assert.match(
    workflowCommandGuidance('open-task').preconditions.join('\n'),
    /protected task scope requires/u,
  );
  assert.equal(
    MANAGED_WORKFLOW_COMMAND_REGISTRY.entries.some(
      ({ id }) => (id as string) === 'finalize-task',
    ),
    false,
  );
  assert.equal(
    new Set(WORKFLOW_GUIDANCE_CATALOG.commands.map(({ id }) => id)).size,
    WORKFLOW_GUIDANCE_CATALOG.commands.length,
  );
});

test('task completion guidance puts pending Finding triage first without exceeding three steps', () => {
  const intakeCounts = {
    schemaVersion: 1,
    inbox: 2,
    pendingFindings: 3,
    backlog: 4,
  } as const;
  for (const command of ['complete-task', 'finalize'] as const) {
    const nextSteps = workflowResultNextSteps({ command, intakeCounts });
    assert.equal(nextSteps.length <= 3, true);
    assert.deepEqual(nextSteps[0], {
      command: 'pnpm workflow finding list --json',
      why: '3 pending Findings remain. Choose one: pnpm workflow finding convert <finding-id> --json; pnpm workflow finding link <finding-id> --change <change-id> --json; pnpm workflow finding dismiss <finding-id> --reason <reason> --json.',
    });
  }

  assert.deepEqual(
    workflowResultNextSteps({
      command: 'finalize',
      intakeCounts: { ...intakeCounts, pendingFindings: 0 },
    }),
    projectWorkflowNextSteps(['status']),
  );
});

test('WHY-answer guidance warns about the seam between files before sealing', () => {
  const proposeResult = (nextAction: string) => ({
    command: 'propose',
    result: {
      kind: 'workflow-propose',
      changeId: 'demo-change',
      nextAction,
    },
  });

  const nextSteps = workflowResultNextSteps(
    proposeResult('submit-why-answers'),
  );
  assert.equal(nextSteps.length <= 3, true);
  assert.equal(
    nextSteps[0]?.command,
    'pnpm workflow propose demo-change --resume --input <why-answers.json> --json',
  );
  assert.match(nextSteps[0]!.why, /seams/);
  assert.match(nextSteps[0]!.why, /more than one author/);

  assert.equal(
    workflowResultNextSteps(proposeResult('submit-group-dispositions')).some(
      (step) => /seams/.test(step.why),
    ),
    false,
    'the seam warning belongs to the checkpoint that starts the deep read',
  );
});

test('update-base guidance requires a finished current branch without an active writer', () => {
  const guidance = workflowCommandGuidance('update-base');
  const contract = [
    guidance.purpose,
    ...guidance.preconditions,
    ...guidance.consequences,
  ].join('\n');

  assert.match(guidance.purpose, /finished managed task branch/i);
  assert.match(contract, /no active or revising task session/i);
  assert.match(
    contract,
    /one exact committed finished managed task[^.]*current branch HEAD/i,
  );
  assert.match(contract, /clean worktree and branch/i);
  assert.match(contract, /locally available[^.]*base advances shared history/i);
  assert.doesNotMatch(contract, /active task session in this worktree/i);
});

test('help projects every managed guide usage exactly once', () => {
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, 'help'],
    { cwd: sourceRepositoryRoot, encoding: 'utf8' },
  );
  assert.equal(run.status, 0, run.stderr);
  const usageLines = run.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('pnpm workflow '));
  for (const command of WORKFLOW_GUIDANCE_CATALOG.commands) {
    for (const usage of command.usage) {
      assert.equal(
        usageLines.filter((line) => line === usage).length,
        1,
        usage,
      );
    }
  }
});

test('managed guide registry owns nested routes and rejects duplicate projections', () => {
  assert.equal(
    resolveManagedWorkflowCommandRoute(['maintainer', 'review-diff-attest']).id,
    'maintainer-review-diff-attest',
  );
  assert.equal(
    resolveManagedWorkflowCommandRoute(['boundary', 'vectors']).id,
    'boundary-vectors',
  );
  assert.equal(
    resolveManagedWorkflowCommandRoute(['boundary', 'remap']).id,
    'boundary-remap',
  );
  const first = MANAGED_WORKFLOW_COMMAND_REGISTRY.entries[0]!;
  const second = MANAGED_WORKFLOW_COMMAND_REGISTRY.entries[1]!;
  assert.throws(
    () =>
      createManagedWorkflowCommandRegistry([
        first,
        { ...second, route: first.route },
      ]),
    /routes must be unique/u,
  );
  assert.throws(
    () =>
      createManagedWorkflowCommandRegistry([
        first,
        { ...second, usage: first.usage },
      ]),
    /usage lines must be unique/u,
  );
  assert.throws(
    () =>
      createManagedWorkflowCommandRegistry([
        first,
        { ...second, id: first.id },
      ]),
    /IDs must be unique/u,
  );
});

test('JSON status stays read-only and same-digest resume emits at most three catalog-backed next steps', () => {
  const repository = createFixtureRepository();
  try {
    const statusBefore = snapshotRepositoryObservation(repository);
    const emptyStatus = runCli(repository, ['status', '--json']);
    assert.equal(emptyStatus.status, 0, emptyStatus.stderr);
    const emptyStatusOutput = JSON.parse(emptyStatus.stdout) as {
      intakeCounts: unknown;
      nextSteps: unknown;
    };
    assert.deepEqual(emptyStatusOutput.intakeCounts, {
      schemaVersion: 1,
      inbox: 0,
      pendingFindings: 0,
      backlog: 0,
    });
    assert.deepEqual(emptyStatusOutput.nextSteps, [
      {
        command: 'pnpm workflow guide --json',
        why: workflowCommandGuidance('guide').purpose,
      },
    ]);
    assert.deepEqual(snapshotRepositoryObservation(repository), statusBefore);

    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentV3Change(repository);
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    recordGovernanceFinding(
      {
        repositoryRoot: repository,
        runtimeRoot: runtimeRoot(repository),
        sessionId: session.sessionId,
        changeId: session.changeId,
        branch: git(repository, ['branch', '--show-current']).trim(),
        head: git(repository, ['rev-parse', 'HEAD']).trim(),
        tree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
      },
      {
        schemaVersion: 1,
        text: 'Triage this current task observation.',
        sourceRefs: [],
      },
      () => '2026-09-02T02:00:00.000Z',
    );
    const countedStatus = runCli(repository, [
      'status',
      session.sessionId,
      '--json',
    ]);
    assert.equal(countedStatus.status, 0, countedStatus.stderr);
    assert.deepEqual(
      (JSON.parse(countedStatus.stdout) as { intakeCounts: unknown })
        .intakeCounts,
      { schemaVersion: 1, inbox: 0, pendingFindings: 1, backlog: 0 },
    );
    const implementationPath = path.join(repository, 'src/feature.ts');
    fs.writeFileSync(implementationPath, 'export const value = 1;\n');
    reviseTask(
      productionChangeRoutingAdmissionReader,
      repository,
      session.sessionId,
      'Keep the reviewed plan.',
    );
    const headBeforeResume = git(repository, ['rev-parse', 'HEAD']).trim();

    const resumed = runCli(repository, [
      'resume-task',
      session.sessionId,
      '--json',
    ]);
    assert.equal(resumed.status, 0, resumed.stderr);
    const output = JSON.parse(resumed.stdout) as {
      result: { session: { sessionId: string; state: string } };
      nextSteps: Array<{ command: string; why: string }>;
    };
    assert.equal(output.result.session.sessionId, session.sessionId);
    assert.equal(output.result.session.state, 'active');
    assert.deepEqual(
      output.nextSteps.map(({ command }) => command),
      [
        `pnpm workflow status ${session.sessionId} --json`,
        `pnpm workflow check ${session.sessionId} --json`,
        `pnpm workflow finalize ${session.sessionId} --message <subject> --json`,
      ],
    );
    assert.equal(output.nextSteps.length <= 3, true);
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      headBeforeResume,
    );
    assert.equal(
      fs.readFileSync(implementationPath, 'utf8'),
      'export const value = 1;\n',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('next-step projection keeps two likely transitions and sends overflow to the explicit guide', () => {
  const sessionId =
    'session-20260812000000000-00000000-0000-4000-8000-000000000000';
  assert.deepEqual(
    projectWorkflowNextSteps(['status', 'check', 'finalize', 'abort'], {
      sessionId,
    }),
    [
      {
        command: `pnpm workflow status ${sessionId} --json`,
        why: workflowCommandGuidance('status').purpose,
      },
      {
        command: `pnpm workflow check ${sessionId} --json`,
        why: workflowCommandGuidance('check').purpose,
      },
      {
        command: 'pnpm workflow guide --json',
        why: workflowCommandGuidance('guide').purpose,
      },
    ],
  );
});

test('route prepare and apply project exact read-only status without guessing a change', () => {
  for (const action of ['prepare', 'apply']) {
    const commands = workflowResultNextSteps({
      command: 'route',
      result: { action },
    }).map(({ command }) => command);
    assert.deepEqual(commands, ['pnpm workflow route status --json']);
    assert.equal(
      commands.some((command) => command.includes('<')),
      false,
    );
  }
  assert.equal(
    resolveManagedWorkflowCommandRoute(['route', 'status']).id,
    'route-status',
  );
  assert.equal(workflowCommandGuidance('route-status').status, 'read-only');
});

test('route status projects only executable current routing next steps', () => {
  const routeStatus = (
    sourcePresent: boolean,
    primaryChangeId: string | null,
    changes: Array<{ changeId: string; state: string }>,
    concurrentChangeIds: string[] = [],
  ) =>
    workflowResultNextSteps({
      command: 'route',
      result: {
        action: 'status',
        result: {
          schemaVersion: 1,
          sourcePresent,
          sourceDigest: null,
          primaryChangeId,
          concurrentChangeIds,
          changes,
        },
      },
    }).map(({ command }) => command);

  assert.deepEqual(
    routeStatus(
      true,
      'demo-change',
      [
        { changeId: 'demo-change', state: 'primary' },
        { changeId: 'repair-change', state: 'concurrent' },
      ],
      ['repair-change'],
    ),
    [
      'pnpm workflow open-task demo-change --json',
      'pnpm workflow open-task repair-change --json',
    ],
  );
  assert.deepEqual(
    routeStatus(
      true,
      null,
      [{ changeId: 'repair-change', state: 'concurrent' }],
      ['repair-change'],
    ),
    ['pnpm workflow open-task repair-change --json'],
  );
  assert.deepEqual(
    routeStatus(true, null, [{ changeId: 'demo-change', state: 'ready' }]),
    ['pnpm workflow guide --json'],
  );
  assert.deepEqual(
    routeStatus(
      true,
      null,
      [{ changeId: 'repair-change', state: 'ready' }],
      ['repair-change'],
    ),
    ['pnpm workflow guide --json'],
  );
  assert.deepEqual(
    routeStatus(false, null, [{ changeId: 'demo-change', state: 'ready' }]),
    ['pnpm workflow open-task demo-change --json'],
  );

  for (const commands of [
    routeStatus(true, 'demo-change', [
      { changeId: 'demo-change', state: 'primary' },
    ]),
    routeStatus(true, null, [{ changeId: 'demo-change', state: 'ready' }]),
    routeStatus(false, null, [{ changeId: 'demo-change', state: 'ready' }]),
  ]) {
    assert.equal(
      commands.some((command) => command.includes('<change-id>')),
      false,
    );
  }
});

test('archive-pr local results project exact ownerless next steps without crossing the remote gate', () => {
  const commands = (result: Readonly<Record<string, unknown>>) =>
    workflowResultNextSteps(result).map(({ command }) => command);
  const preparationIdentity = `sha256:${'a'.repeat(64)}`;

  assert.deepEqual(
    commands({
      command: 'archive-pr',
      action: 'doctor',
      result: {
        schemaVersion: 1,
        kind: 'archive-pull-request-candidate-inventory',
        base: 'origin/main',
        items: [
          { changeId: 'blocked-change', state: 'blocked' },
          { changeId: 'demo-change', state: 'eligible' },
          { changeId: 'old-change', state: 'already-archived' },
        ],
      },
    }),
    [
      'pnpm workflow archive-pr dry-run demo-change --json',
      'pnpm workflow guide --json',
    ],
  );
  assert.deepEqual(
    commands({
      command: 'archive-pr',
      action: 'dry-run',
      result: {
        schemaVersion: 1,
        kind: 'archive-pr-dry-run.v1',
        remoteState: 'not-observed',
        operationalGate: 'pending',
        local: { preparation: { preparationIdentity } },
      },
    }),
    [
      `pnpm workflow archive-pr status ${preparationIdentity} --json`,
      'pnpm workflow guide --json',
    ],
  );
  for (const result of [
    {
      command: 'archive-pr',
      action: 'doctor',
      result: { items: [{ changeId: 'blocked-change', state: 'blocked' }] },
    },
    {
      command: 'archive-pr',
      action: 'status',
      result: {
        state: 'local-preparation-current',
        preparationIdentity,
      },
    },
    {
      command: 'archive-pr',
      action: 'prepare',
      result: { kind: 'archive-pr-publication-grant-required.v1' },
    },
  ]) {
    const projected = commands(result);
    assert.deepEqual(projected, ['pnpm workflow guide --json']);
    assert.equal(
      projected.some((command) =>
        /archive-pr (?:prepare|open)|\bgit push\b/u.test(command),
      ),
      false,
    );
  }
});

test('task-strategy retry and exhaustion guidance exposes executable recovery without weakening the budget', () => {
  const sessionId =
    'session-20260812000000000-00000000-0000-4000-8000-000000000000';
  assert.deepEqual(
    workflowResultNextSteps({
      command: 'resume',
      result: { sessionId, state: 'provider-failed' },
    }).map(({ command }) => command),
    [
      `pnpm workflow resume ${sessionId} --json`,
      `pnpm workflow status ${sessionId} --json`,
      'pnpm workflow guide --json',
    ],
  );
  assert.deepEqual(
    workflowResultNextSteps({
      command: 'resume',
      result: { sessionId, state: 'correction-exhausted' },
    }).map(({ command }) => command),
    [
      `pnpm workflow status ${sessionId} --json`,
      `pnpm workflow abort ${sessionId} --reason 'Correction budget exhausted' --json`,
      'pnpm workflow guide --json',
    ],
  );
});

test('task-strategy correction-required is an explicit resumable state', () => {
  const sessionId =
    'session-20260812000000000-00000000-0000-4000-8000-000000000000';
  assert.deepEqual(
    workflowResultNextSteps({
      command: 'resume',
      result: { sessionId, state: 'correction-required' },
    }).map(({ command }) => command),
    [
      `pnpm workflow resume ${sessionId} --json`,
      `pnpm workflow status ${sessionId} --json`,
    ],
  );
});

test('error recovery emits one exact executable command and never treats advisory prose as authority', () => {
  const sessionId =
    'session-20260812000000000-00000000-0000-4000-8000-000000000000';
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'TASK_DIFF_REVIEW_CHALLENGE_OPEN',
        'Advisory dispositions are not Final Assurance.',
        ExitCode.verification,
      ),
      ['finalize', sessionId, '--message', 'Complete exact task'],
    ),
    `pnpm workflow review-diff ${sessionId} --json`,
  );
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'FINALIZE_RECOVERY_REQUIRED',
        'A durable finalize transaction requires recovery.',
        ExitCode.staleState,
        { recovery: 'Inspect it, then decide what to do.' },
      ),
      ['finalize', sessionId, '--message', 'Complete exact task'],
    ),
    `pnpm workflow finalize-recover ${sessionId} --json`,
  );
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'OPEN_TASK_RECOVERY_REQUIRED',
        'The durable opening transaction requires recovery.',
        ExitCode.staleState,
        { recovery: 'pnpm workflow status opening-123 --json' },
      ),
      ['open-task', 'demo-change'],
    ),
    'pnpm workflow status opening-123 --json',
  );
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'MAINTAINER_INTERACTIVE_REQUIRED',
        'Run from a controlling terminal.',
        ExitCode.unsafeEnvironment,
      ),
      [
        'maintainer',
        'revision-approval',
        sessionId,
        '--reason',
        "literal $(touch /tmp/no) and 'quote'",
      ],
    ),
    `pnpm workflow maintainer revision-approval ${sessionId} --reason 'literal $(touch /tmp/no) and '"'"'quote'"'"'' --json`,
  );
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'MAINTAINER_INTERACTIVE_REQUIRED',
        'Run from a controlling terminal.',
        ExitCode.unsafeEnvironment,
      ),
      ['maintainer', 'revoke', 'grant-id', '--reason', 'line one\nline two'],
    ),
    'pnpm workflow guide --json',
  );
  assert.equal(
    workflowFailureRecoveryCommand(
      workflowError(
        'DIRTY_WORKTREE',
        'The checkout is dirty.',
        ExitCode.guard,
        { recovery: 'Delete or stash whatever seems appropriate.' },
      ),
      ['open-task', 'demo-change'],
    ),
    'pnpm workflow guide --json',
  );
});

test('JSON errors default to a literal read-only guide command', () => {
  const run = spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, 'status', 'bad', 'extra', '--json'],
    { cwd: sourceRepositoryRoot, encoding: 'utf8' },
  );
  assert.equal(run.status, ExitCode.usage);
  const output = JSON.parse(run.stderr) as {
    ok: boolean;
    error: { code: string; message: string; recovery: string };
  };
  assert.equal(output.ok, false);
  assert.equal(output.error.code, 'INVALID_USAGE');
  assert.match(output.error.message, /Invalid arguments for workflow status/);
  assert.equal(output.error.recovery, 'pnpm workflow guide --json');
});

test('retired finalize-task cannot mutate while preferred finalize resumes one durable transaction', () => {
  const repository = createFixtureRepository();
  const counterPath = path.join(repository, '.git', 'guidance-finalize-count');
  try {
    fs.writeFileSync(
      path.join(repository, 'scripts/count-finalize.mjs'),
      [
        "import fs from 'node:fs';",
        'const counterPath = process.argv[2];',
        "const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, 'utf8')) : 0;",
        'fs.writeFileSync(counterPath, String(count + 1));',
        '',
      ].join('\n'),
    );
    configureChecks(
      repository,
      {
        finalization: {
          command: ['node', 'scripts/count-finalize.mjs', counterPath],
          destructiveDatabase: false,
        },
      },
      ['finalization'],
    );
    git(repository, ['checkout', '-b', 'work/demo-change']);
    prepareCurrentV3Change(repository);
    const session = startSession(
      productionChangeRoutingAdmissionReader,
      repository,
      'demo-change',
      '1.1',
    );
    recordGovernanceFinding(
      {
        repositoryRoot: repository,
        runtimeRoot: runtimeRoot(repository),
        sessionId: session.sessionId,
        changeId: session.changeId,
        branch: git(repository, ['branch', '--show-current']).trim(),
        head: git(repository, ['rev-parse', 'HEAD']).trim(),
        tree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
      },
      {
        schemaVersion: 1,
        text: 'Triage this observation after finalization.',
        sourceRefs: [],
      },
      () => '2026-09-02T03:00:00.000Z',
    );
    fs.writeFileSync(path.join(repository, 'src/feature.ts'), 'export {};\n');

    const beforeRetiredCommand = snapshotRepositoryObservation(repository);
    const retired = runCli(repository, [
      'finalize-task',
      session.sessionId,
      '--json',
    ]);
    assert.equal(retired.status, ExitCode.usage, retired.stderr);
    assert.equal(
      (JSON.parse(retired.stderr) as { error: { code: string } }).error.code,
      'INVALID_USAGE',
    );
    assert.deepEqual(
      snapshotRepositoryObservation(repository),
      beforeRetiredCommand,
    );
    assert.equal(fs.existsSync(counterPath), false);

    let transactionId: string | undefined;
    let candidateTree: string | undefined;
    assert.throws(
      () => finalizeTask(repository, session.sessionId),
      (error: unknown) => {
        if (
          !(error instanceof WorkflowError) ||
          error.code !== 'TASK_DIFF_REVIEW_REQUIRED'
        ) {
          return false;
        }
        transactionId = String(error.details?.transactionId);
        candidateTree = String(error.details?.candidateTree);
        return true;
      },
    );
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(getSession(repository, session.sessionId).state, 'active');
    satisfyCurrentTaskDiffReview(repository, session.sessionId);

    const preferred = runCli(repository, [
      'finalize',
      session.sessionId,
      '--message',
      'Complete through preferred finalize',
      '--json',
    ]);
    assert.equal(preferred.status, 0, preferred.stderr);
    const preferredOutput = JSON.parse(preferred.stdout) as {
      result: {
        transactionId: string;
        tree: string;
        commitHash: string;
      };
      intakeCounts: unknown;
      nextSteps: Array<{ command: string; why: string }>;
    };
    const preferredResult = preferredOutput.result;
    assert.deepEqual(preferredOutput.intakeCounts, {
      schemaVersion: 1,
      inbox: 0,
      pendingFindings: 1,
      backlog: 0,
    });
    assert.equal(
      preferredOutput.nextSteps[0]?.command,
      'pnpm workflow finding list --json',
    );
    assert.match(preferredOutput.nextSteps[0]?.why ?? '', /1 pending Finding/u);
    assert.match(
      preferredOutput.nextSteps[0]?.why ?? '',
      new RegExp(
        `finding link <finding-id> --change ${session.changeId} --json`,
        'u',
      ),
    );
    assert.doesNotMatch(
      preferredOutput.nextSteps[0]?.why ?? '',
      /finding link <finding-id> --change <change-id>/u,
    );
    assert.equal(preferredOutput.nextSteps.length <= 3, true);
    assert.equal(preferredResult.transactionId, transactionId);
    assert.equal(preferredResult.tree, candidateTree);
    assert.equal(fs.readFileSync(counterPath, 'utf8'), '1');
    assert.equal(getSession(repository, session.sessionId).state, 'committed');
    assert.equal(
      git(repository, ['rev-parse', 'HEAD']).trim(),
      preferredResult.commitHash,
    );
    assert.equal(git(repository, ['status', '--porcelain=v2', '-z']), '');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function runCli(repository: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', cliPath, ...args],
    { cwd: repository, encoding: 'utf8' },
  );
}

function snapshotRepositoryObservation(repository: string): {
  head: string;
  status: string;
  runtime: Array<readonly [string, string]>;
} {
  const runtimeRoot = path.join(repository, '.git', 'workflow-engine');
  const runtime = fs.existsSync(runtimeRoot)
    ? fs
        .readdirSync(runtimeRoot, { recursive: true, encoding: 'utf8' })
        .map(String)
        .sort()
        .map((relativePath) => {
          const absolutePath = path.join(runtimeRoot, relativePath);
          const stats = fs.lstatSync(absolutePath);
          const mode = (stats.mode & 0o777).toString(8).padStart(3, '0');
          return [
            `${stats.isDirectory() ? 'directory' : 'file'}:${relativePath}`,
            stats.isFile()
              ? `${mode}:${fs.readFileSync(absolutePath, 'hex')}`
              : mode,
          ] as const;
        })
    : [];
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
    runtime,
  };
}

function prepareCurrentV3Change(repository: string): void {
  writeReadyV3ExemptChange(repository);
  commitPlanningTransition(repository, 'demo-change');
}
