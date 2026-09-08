/** CI repository, planning-path, task, configuration, and Git tree fixture builders. */
import {
  createCentralRoleProviderDefault,
  renderCentralRoleProviderDefault,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import type { CentralRoleProviderDefaultV1 } from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import fs from 'node:fs';
import path from 'node:path';
import { CENTRAL_ROLE_PROVIDER_DEFAULT_PATH } from '../src/runtime/repository-transaction/central-role-provider-default-store.ts';
import {
  renderAgentRolePlanV2,
  agentRolePlanV2Digest,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import type { AgentRolePlanBodyV2 } from '../src/modules/provider-orchestration/agent-role-plan.ts';
import { agentRolePlanV2Path } from '../src/modules/source/planning-role-policy-paths.ts';
import { renderPlanningProviderBinding } from '../src/modules/planning-provider/planning-provider-binding.ts';
import os from 'node:os';
import { git, sourceRepositoryRoot } from './fixture.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

export const CHANGE_ID = 'demo-change';

export function overrideCentralConfiguration(
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

export function writeOverrideCentralConfiguration(
  repository: string,
  configuration = overrideCentralConfiguration(),
): void {
  fs.writeFileSync(
    path.join(repository, CENTRAL_ROLE_PROVIDER_DEFAULT_PATH),
    renderCentralRoleProviderDefault(configuration),
  );
}

export function writeAgentRolePlanV2(
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

export function writePlanningProviderBindingForChange(
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

export function createPackageSchemaRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-ci-planning-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  write(repository, 'README.md', '# Fixture\n');
  for (const relativePath of [
    'workflow/config.json',
    'workflow/repository-consumer.json',
  ]) {
    write(
      repository,
      relativePath,
      fs.readFileSync(path.join(sourceRepositoryRoot, relativePath), 'utf8'),
    );
  }
  commit(repository, 'Create fixture');
  return repository;
}

export function writePackageSchemaPlanningTree(
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

export function configureFixtureCurrentSchema(
  repository: string,
  currentSchemaName: string,
): void {
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
  consumer.planning.requiredSchemaNames = ['spec-driven', currentSchemaName];
  consumer.planning.supportedSchemaNames = ['spec-driven', currentSchemaName];
  consumer.planning.managedSchemaNames = [currentSchemaName];
  consumer.planning.currentSchemaName = currentSchemaName;
  fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);

  const openSpecConfigPath = path.join(repository, 'openspec/config.yaml');
  fs.writeFileSync(
    openSpecConfigPath,
    fs
      .readFileSync(openSpecConfigPath, 'utf8')
      .replace(/^schema: jigwright$/m, `schema: ${currentSchemaName}`),
  );
  fs.cpSync(
    path.join(repository, 'openspec/schemas/jigwright'),
    path.join(repository, 'openspec/schemas', currentSchemaName),
    { recursive: true },
  );
  const namedSchemaPath = path.join(
    repository,
    'openspec/schemas',
    currentSchemaName,
    'schema.yaml',
  );
  fs.writeFileSync(
    namedSchemaPath,
    fs
      .readFileSync(namedSchemaPath, 'utf8')
      .replace(/^name: jigwright$/m, `name: ${currentSchemaName}`),
  );
}

export function writeProviderBinding(
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

export function writeCurrentTasksAndGuard(
  repository: string,
  tasks: string,
): void {
  writeTasks(repository, tasks);
  const taskIds = [...tasks.matchAll(/^- \[[ x]\] (\d+(?:\.\d+)*)\b/gm)].map(
    (match) => match[1]!,
  );
  assert.equal(new Set(taskIds).size, taskIds.length);
  assert.equal(taskIds.length > 0, true);
  const guardPath = path.join(changeDirectory(repository), 'guard.json');
  const guard = JSON.parse(fs.readFileSync(guardPath, 'utf8')) as {
    schemaVersion: 1;
    changeId: string;
    tasks: Record<string, { allowedPaths: string[]; requiredChecks: string[] }>;
  };
  guard.tasks = Object.fromEntries(
    taskIds.map((taskId) => [
      taskId,
      { allowedPaths: ['src/**'], requiredChecks: ['fixture'] },
    ]),
  );
  fs.writeFileSync(guardPath, `${JSON.stringify(guard, null, 2)}\n`);
}

export function mktree(repository: string, listing: string): string {
  return execFileSync('git', ['-C', repository, 'mktree'], {
    encoding: 'utf8',
    input: listing,
  }).trim();
}

export function replaceTreeEntry(
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

export function commitPlan(
  repository: string,
  subject = `Plan ${CHANGE_ID}`,
): string {
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

export function commit(repository: string, subject: string): string {
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', subject]);
  return git(repository, ['rev-parse', 'HEAD']).trim();
}

export function changeDirectory(repository: string): string {
  return path.join(repository, 'openspec/changes', CHANGE_ID);
}

export function write(
  repository: string,
  relativePath: string,
  content: string,
): void {
  const filePath = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}
