import { planningTransitionExecution as productionPlanningExecution } from '../../src/composition-root/planning-execution-epoch-production.ts';
import {
  productionChangeRoutingInspector,
  productionChangeContract,
} from '../../src/composition-root/change-routing-observation-production.ts';
import { managedDocuments } from '../../src/composition-root/managed-documents-production.ts';
import { loadChangeContract as productionChangeContractReader } from '../../src/composition-root/consumer-contract-production.ts';
const commitPlanningTransition =
  commitPlanningTransitionWithContractReader.bind(
    undefined,
    productionPlanningExecution,
    managedDocuments,
    productionChangeContractReader,
  );
const renderHandoff = renderHandoffWithContractReader.bind(
  undefined,
  productionChangeRoutingInspector,
  productionChangeContractReader,
);
import {
  writeReadyV3ExemptChange,
  sourceRepositoryRoot,
  git,
  installFakeOpenSpec,
  prepareCurrentV3IntroductionFixture,
  runtimeRoot,
} from '../fixture.ts';
import { commitPlanningTransition as commitPlanningTransitionWithContractReader } from '../../src/application/propose/planning-transition.ts';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  applyChangeRoutingReview,
  prepareChangeRoutingReview,
} from '../../src/composition-root/change-routing-production.ts';
import { renderHandoff as renderHandoffWithContractReader } from '../../src/adapters/consumer/repository/handoff/handoff.ts';
import { startSession } from '../../src/application/execute-task/session.ts';
import { commitSession } from '../../src/runtime/finalization/commit.ts';
import { finalizeTask } from './session-lifecycle-host.ts';

export function prepareCurrentChange(
  repository: string,
  changeId = 'demo-change',
) {
  const ready = writeReadyV3ExemptChange(repository, changeId);
  commitPlanningTransition(repository, changeId);
  return ready;
}

export function enableDisposableDatabasePolicy(repository: string): void {
  const consumerConfigPath = path.join(
    repository,
    'workflow/repository-consumer.json',
  );
  const consumerConfig = JSON.parse(
    fs.readFileSync(consumerConfigPath, 'utf8'),
  ) as { databasePolicy: { adapterId: string } };
  consumerConfig.databasePolicy.adapterId = 'postgresql-disposable-v1';
  fs.writeFileSync(
    consumerConfigPath,
    `${JSON.stringify(consumerConfig, null, 2)}\n`,
  );
}

export function prepareCurrentChangeOnMain(
  repository: string,
  changeId = 'demo-change',
): void {
  const maintainerPolicyPath = path.join(
    repository,
    'workflow/maintainer-policy.json',
  );
  if (!fs.existsSync(maintainerPolicyPath)) {
    fs.copyFileSync(
      path.join(sourceRepositoryRoot, 'workflow/maintainer-policy.json'),
      maintainerPolicyPath,
    );
    git(repository, ['add', 'workflow/maintainer-policy.json']);
    git(repository, ['commit', '-m', 'Track fixture maintainer policy']);
  }
  const branch = `work/${changeId}`;
  git(repository, ['checkout', '-b', branch]);
  prepareCurrentChange(repository, changeId);
  git(repository, ['checkout', 'main']);
  git(repository, ['merge', '--ff-only', branch]);
  git(repository, ['branch', '-d', branch]);
}

export function prepareConcurrentTaskWorktree(
  repository: string,
  changeId: string,
  allowedPath: string | readonly string[],
  exclusiveResources: string[] = [],
  readyOptions: Parameters<typeof writeReadyV3ExemptChange>[2] = {},
): { parent: string; worktree: string } {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-concurrent-task-worktree-'),
  );
  const worktree = path.join(parent, changeId);
  git(repository, [
    'worktree',
    'add',
    '--quiet',
    '-b',
    `work/${changeId}`,
    worktree,
    'main',
  ]);
  installFakeOpenSpec(worktree);
  const guardPath = path.join(
    worktree,
    'openspec/changes',
    changeId,
    'guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    changeId: string;
    tasks: Record<
      string,
      { allowedPaths: string[]; exclusiveResources?: string[] }
    >;
  };
  guard.changeId = changeId;
  guard.tasks['1.1']!.allowedPaths =
    typeof allowedPath === 'string' ? [allowedPath] : [...allowedPath];
  if (exclusiveResources.length > 0) {
    guard.tasks['1.1']!.exclusiveResources = [...exclusiveResources].sort();
  }
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  writeReadyV3ExemptChange(worktree, changeId, readyOptions);
  commitPlanningTransition(worktree, changeId);
  return { parent, worktree };
}

function createTaskWorktreeFromPlannedBase(
  repository: string,
  changeId: string,
): { parent: string; worktree: string } {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-planned-task-worktree-'),
  );
  const worktree = path.join(parent, changeId);
  git(repository, ['worktree', 'add', '--quiet', worktree, `work/${changeId}`]);
  installFakeOpenSpec(worktree);
  return { parent, worktree };
}

export function addConcurrentChangeSkeleton(
  repository: string,
  changeId: string,
): void {
  const changeDirectory = path.join(repository, 'openspec/changes', changeId);
  fs.cpSync(
    path.join(repository, 'openspec/changes/demo-change'),
    changeDirectory,
    { recursive: true },
  );
  const guardPath = path.join(changeDirectory, 'guard.json');
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    changeId: string;
  };
  guard.changeId = changeId;
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  const providerBinding = JSON.parse(
    fs.readFileSync(
      path.join(repository, 'workflow/change-providers/demo-change.json'),
      'utf8',
    ),
  ) as { changeId: string; planningRoot: string };
  providerBinding.changeId = changeId;
  providerBinding.planningRoot = `openspec/changes/${changeId}`;
  fs.writeFileSync(
    path.join(repository, 'workflow/change-providers', `${changeId}.json`),
    `${JSON.stringify(providerBinding, null, 2)}\n`,
  );
}

export function declareConcurrentWorkset(
  repository: string,
  concurrentChangeId: string,
): void {
  prepareCurrentChangeOnMain(repository, 'demo-change');
  prepareCurrentChangeOnMain(repository, concurrentChangeId);
  applyChangeRoutingReview(
    repository,
    prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'focus', changeId: 'demo-change' },
    }),
  );
  applyChangeRoutingReview(
    repository,
    prepareChangeRoutingReview(repository, {
      schemaVersion: 1,
      action: { kind: 'set-concurrent', changeId: concurrentChangeId },
    }),
  );
  renderHandoff(repository);
  git(repository, ['add', '.']);
  git(repository, ['commit', '-m', 'Declare concurrent test workset']);
}

export function removeConcurrentTaskWorktree(
  repository: string,
  fixture: { parent: string; worktree: string },
): void {
  git(repository, ['worktree', 'remove', '--force', fixture.worktree]);
  fs.rmSync(fixture.parent, { recursive: true, force: true });
}

export function prepareFinishedNonFinalTaskForBaseUpdate(repository: string) {
  const documentPolicyPath = path.join(
    repository,
    'workflow/document-policy.json',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(documentPolicyPath, 'utf8'),
  ) as { documents: Record<string, unknown> };
  documentPolicy.documents['docs/CURRENT_AND_NEXT_STEPS.md'] = {
    mode: 'generated',
    enforcement: 'active',
    transition: 'completion',
  };
  fs.writeFileSync(
    documentPolicyPath,
    `${JSON.stringify(documentPolicy, null, 2)}\n`,
  );
  renderHandoff(repository);
  git(repository, [
    'add',
    'workflow/document-policy.json',
    'docs/CURRENT_AND_NEXT_STEPS.md',
  ]);
  git(repository, ['commit', '-m', 'Track fixture handoff']);
  const guardPath = path.join(
    repository,
    'openspec/changes/demo-change/guard.json',
  );
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  guard.tasks['1.1']!.allowedPaths = ['src/task/**'];
  guard.tasks['1.2'] = structuredClone(guard.tasks['1.1']!);
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
  fs.appendFileSync(
    path.join(repository, 'openspec/changes/demo-change/tasks.md'),
    '\n- [ ] 1.2 Keep the fixture change open\n',
  );
  prepareCurrentV3IntroductionFixture(repository, 'demo-change');
  prepareCurrentChange(repository);
  git(repository, ['checkout', 'main']);
  git(repository, ['merge', '--ff-only', 'work/demo-change']);
  const fixture = createTaskWorktreeFromPlannedBase(repository, 'demo-change');
  const started = startSession(
    productionChangeContract,
    fixture.worktree,
    'demo-change',
    '1.1',
  );
  fs.mkdirSync(path.join(fixture.worktree, 'src/task'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.worktree, 'src/task/feature.ts'),
    'export const feature = true;\n',
  );
  finalizeTask(fixture.worktree, started.sessionId);
  const committed = commitSession(
    productionChangeContract,
    fixture.worktree,
    started.sessionId,
    'Complete concurrent fixture task',
  );
  return { committed, fixture, started };
}

export function snapshotTaskPreflightState(repository: string) {
  return {
    head: git(repository, ['rev-parse', 'HEAD']).trim(),
    tree: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
    status: git(repository, ['status', '--porcelain=v2', '-z']),
    refs: git(repository, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)',
    ]),
    worktrees: git(repository, ['worktree', 'list', '--porcelain']),
    runtime: snapshotTaskPreflightDirectory(runtimeRoot(repository)),
  };
}

export type TaskSessionPreflightCliOutput = {
  result: {
    schemaVersion: number;
    kind: string;
    authority: string;
    status: string;
    changeId: string;
    taskId: string;
    observed: {
      repositoryRoot: string;
      gitCommonDirectory: string;
      branch: string;
      head: string;
      tree: string;
    };
    routing: {
      role: string;
      worksetDigest: string;
      concurrencyEnabled: boolean;
    };
    scope: {
      allowedPaths: string[];
      requiredChecks: string[];
      authorization: {
        requiresMandate: boolean;
        mode: string;
        roles: string[];
        matchedPatterns: string[];
        unclassifiedScope: boolean;
        policyDigest: string;
      };
    };
    isolation: {
      schemaVersion: number;
      routingRole: string;
      worktreeDigest: string;
      resources: unknown[];
    };
    mutationBoundary: {
      git: string;
      runtime: string;
      grants: string;
    };
  };
  nextSteps: Array<{ command: string; why: string }>;
};

function snapshotTaskPreflightDirectory(
  root: string,
): ReadonlyArray<Readonly<Record<string, unknown>>> {
  if (!fs.existsSync(root)) return Object.freeze([]);
  const entries: Array<Readonly<Record<string, unknown>>> = [];
  const visit = (absolute: string, relative: string): void => {
    const stats = fs.lstatSync(absolute);
    if (stats.isSymbolicLink()) {
      entries.push(
        Object.freeze({
          path: relative,
          kind: 'symlink',
          mode: stats.mode & 0o777,
          target: fs.readlinkSync(absolute),
        }),
      );
      return;
    }
    if (stats.isDirectory()) {
      entries.push(
        Object.freeze({
          path: relative,
          kind: 'directory',
          mode: stats.mode & 0o777,
        }),
      );
      for (const name of fs.readdirSync(absolute).sort()) {
        visit(
          path.join(absolute, name),
          relative ? `${relative}/${name}` : name,
        );
      }
      return;
    }
    entries.push(
      Object.freeze({
        path: relative,
        kind: 'file',
        mode: stats.mode & 0o777,
        bytes: fs.readFileSync(absolute).toString('base64'),
      }),
    );
  };
  visit(root, '');
  return Object.freeze(entries);
}
