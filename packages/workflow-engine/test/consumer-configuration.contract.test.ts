import test from 'node:test';
import { parseRepositoryConsumerConfiguration } from '../src/modules/repository-consumer/repository-consumer-policy.ts';
import { createFixtureRepositoryConsumerPortV1 } from '../../fixture-adapter/src/repository-consumer.ts';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  loadRepositoryConsumerConfiguration,
  repositoryConsumerPath,
} from '../src/runtime/repository-observation/repository-consumer.ts';
import { readChangeSchemaName } from '../src/runtime/repository-observation/change-metadata.ts';
import { createWorkItem } from '../src/composition-root/work-registry-production.ts';
import { assertDisposableDatabaseForRepository } from '../src/adapters/consumer/repository/work-registry/database-policy.ts';
import os from 'node:os';
import { createOpenSpecPlanningProviderPort } from '../src/composition-root/openspec-planning-provider-production.ts';
import { type RepositoryConsumerConfigurationV1 } from '@jigwright/core/repository-consumer-port';
import { writeJson } from './portability-consumer-fixture.ts';

test('a neutral consumer selects schema, documents, work registry, and database policy without expense fallback', () => {
  const repository = createConsumerRepository('orbit-consumer');
  try {
    const fixturePort = createFixtureRepositoryConsumerPortV1(repository, {
      repositoryName: 'orbit-consumer',
      planningSchema: 'orbit-spec-v1',
      documentAdapter: 'fixture-documents-v1',
    });
    assert.equal(
      fixturePort.load(repository).planning.currentSchemaName,
      'orbit-spec-v1',
    );
    assert.equal(
      fixturePort.load(repository).documents.adapterId,
      'fixture-documents-v1',
    );

    const config = orbitConsumerConfiguration();
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      config,
    );

    const metadataPath = path.join(repository, 'plans/demo/.openspec.yaml');
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(
      metadataPath,
      'schema: orbit-spec-v1\ncreated: 2026-08-24\n',
    );
    fs.mkdirSync(path.join(repository, 'openspec/schemas/expense-app'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repository, 'openspec/schemas/expense-app/schema.yaml'),
      'poisoned: true\n',
    );

    const loaded = loadRepositoryConsumerConfiguration(repository);
    assert.equal(loaded.source, 'tracked');
    assert.deepEqual(loaded.configuration, config);
    assert.equal(
      readChangeSchemaName(repository, metadataPath),
      'orbit-spec-v1',
    );
    const created = createWorkItem(
      repository,
      {
        schemaVersion: 1,
        kind: 'feature',
        lane: 'now',
        title: 'Orbit fixture item',
        summary: 'Use the configured Work Registry root.',
        sourceRefs: [],
      },
      {
        now: () => '2026-08-24T00:00:00.000Z',
        createId: () => 'WORK-01ARZ3NDEKTSV4RRFFQ69G5FAV',
      },
    );
    assert.equal(
      created.relativePath,
      'state/work/items/2026/WORK-01ARZ3NDEKTSV4RRFFQ69G5FAV.yaml',
    );
    assert.equal(
      fs.existsSync(path.join(repository, created.relativePath)),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(repository, 'docs/work-registry/items')),
      false,
    );
    assert.throws(
      () => assertDisposableDatabaseForRepository(repository, {}),
      hasWorkflowCode('DESTRUCTIVE_DATABASE_POLICY_UNAVAILABLE'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the tracked Jigwright package configuration is explicit', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const loaded = loadRepositoryConsumerConfiguration(repositoryRoot);
  assert.equal(loaded.source, 'tracked');
  assert.equal(loaded.configuration.consumerId, 'jigwright');
  assert.equal(loaded.configuration.planning.currentSchemaName, 'jigwright');
  assert.deepEqual(loaded.configuration.planning.managedSchemaNames, [
    'jigwright',
  ]);
  assert.equal(loaded.configuration.databasePolicy.adapterId, 'disabled-v1');
});

test('repository consumer documents and Work Registry accept only current keys', () => {
  const repository = createConsumerRepository('orbit-consumer');
  try {
    const configuration = orbitConsumerConfiguration();
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      configuration,
    );

    const loaded = loadRepositoryConsumerConfiguration(repository);
    assert.deepEqual(Object.keys(loaded.configuration.documents).sort(), [
      'adapterId',
      'handoffPath',
    ]);
    assert.deepEqual(
      loaded.configuration.workRegistry,
      configuration.workRegistry,
    );
    assert.deepEqual(Object.keys(loaded.configuration.workRegistry).sort(), [
      'adapterId',
      'backlogPath',
      'changeOriginRoot',
      'historyRoot',
      'inventoryPath',
      'itemRoot',
      'transitionPolicyPath',
    ]);

    for (const [legacyKey, legacyPath] of [
      ['issueLogPath', 'notebook/issue-index.md'],
      ['issueSourcePath', 'notebook/issues.json'],
    ] as const) {
      writeJson(path.join(repository, 'workflow/repository-consumer.json'), {
        ...configuration,
        documents: {
          ...configuration.documents,
          [legacyKey]: legacyPath,
        },
      });
      assert.throws(
        () => loadRepositoryConsumerConfiguration(repository),
        hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
      );
    }

    writeJson(path.join(repository, 'workflow/repository-consumer.json'), {
      ...configuration,
      documents: {
        ...configuration.documents,
        handoffPath: configuration.workRegistry.backlogPath,
      },
    });
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );

    writeJson(path.join(repository, 'workflow/repository-consumer.json'), {
      ...configuration,
      workRegistry: null,
    });
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );

    writeJson(path.join(repository, 'workflow/repository-consumer.json'), {
      ...configuration,
      workRegistry: {
        ...configuration.workRegistry,
        sourceRoot: 'state/sources',
      },
    });
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );

    const { workRegistry: _workRegistry, ...defaultedConfiguration } =
      configuration;
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      defaultedConfiguration,
    );
    assert.deepEqual(
      loadRepositoryConsumerConfiguration(repository).configuration
        .workRegistry,
      {
        adapterId: 'filesystem-work-registry-v1',
        itemRoot: 'docs/work-registry/items',
        inventoryPath: 'docs/work-registry/inventory.json',
        backlogPath: 'docs/BACKLOG.md',
        historyRoot: 'docs/work-history',
        transitionPolicyPath: 'workflow/work-registry-policy.json',
        changeOriginRoot: 'openspec/changes',
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('expense-app repositories fail closed without tracked consumer configuration', () => {
  const repository = createConsumerRepository('expense-app');
  try {
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('neutral repositories fail closed on missing, unknown, and escaping configuration', () => {
  const repository = createConsumerRepository('orbit-consumer');
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-consumer-config-outside-'),
  );
  try {
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_MISSING'),
    );

    const unknown =
      orbitConsumerConfiguration() as MutableConsumerConfiguration;
    unknown.documents.adapterId = 'expense-autodetect-v1';
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      unknown,
    );
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_UNSUPPORTED'),
    );

    const unknownPlanning =
      orbitConsumerConfiguration() as MutableConsumerConfiguration;
    unknownPlanning.planning.providerId = 'fixture-plan';
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      unknownPlanning,
    );
    fs.mkdirSync(path.join(repository, 'openspec/schemas/expense-app'), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(repository, 'openspec/schemas/expense-app/schema.yaml'),
      'poisoned: true\n',
    );
    assert.throws(
      () =>
        createOpenSpecPlanningProviderPort(
          repository,
          loadRepositoryConsumerConfiguration(repository).configuration
            .planning,
        ),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_UNSUPPORTED'),
    );

    const escaping =
      orbitConsumerConfiguration() as MutableConsumerConfiguration;
    escaping.documents.handoffPath = '../handoff.md';
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      escaping,
    );
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );

    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      orbitConsumerConfiguration(),
    );
    fs.symlinkSync(outside, path.join(repository, 'notebook'), 'dir');
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );

    fs.rmSync(path.join(repository, 'notebook'));
    fs.mkdirSync(path.join(repository, 'notebook'));
    const outsideHandoff = path.join(outside, 'handoff.md');
    fs.writeFileSync(outsideHandoff, '# Outside handoff\n');
    fs.symlinkSync(
      outsideHandoff,
      path.join(repository, 'notebook/handoff.md'),
      'file',
    );
    assert.throws(
      () => loadRepositoryConsumerConfiguration(repository),
      hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('consumer paths canonicalize a symlinked repository root while remaining contained', () => {
  const repository = createConsumerRepository('orbit-consumer');
  const aliasRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-consumer-alias-'),
  );
  const alias = path.join(aliasRoot, 'repository');
  try {
    writeJson(
      path.join(repository, 'workflow/repository-consumer.json'),
      orbitConsumerConfiguration(),
    );
    fs.symlinkSync(repository, alias, 'dir');

    assert.equal(
      repositoryConsumerPath(alias, 'notebook/future/handoff.md'),
      path.join(fs.realpathSync(repository), 'notebook/future/handoff.md'),
    );
  } finally {
    fs.rmSync(aliasRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function orbitConsumerConfiguration(): RepositoryConsumerConfigurationV1 & {
  readonly workRegistry: NonNullable<
    RepositoryConsumerConfigurationV1['workRegistry']
  >;
} {
  return {
    schemaVersion: 1,
    adapterId: 'configured-repository-v1',
    consumerId: 'orbit-consumer',
    planning: {
      providerId: 'openspec',
      packageSchemaNames: [],
      requiredSchemaNames: ['orbit-spec-v1'],
      supportedSchemaNames: ['orbit-spec-v1'],
      managedSchemaNames: ['orbit-spec-v1'],
      currentSchemaName: 'orbit-spec-v1',
    },
    documents: {
      adapterId: 'filesystem-documents-v1',
      handoffPath: 'notebook/handoff.md',
    },
    workRegistry: {
      adapterId: 'filesystem-work-registry-v1',
      itemRoot: 'state/work/items',
      inventoryPath: 'state/work/inventory.json',
      backlogPath: 'notebook/backlog.md',
      historyRoot: 'notebook/history',
      transitionPolicyPath: 'state/work/policy.json',
      changeOriginRoot: 'plans',
    },
    databasePolicy: { adapterId: 'disabled-v1' },
  };
}

type MutableConsumerConfiguration = {
  -readonly [
    Key in keyof RepositoryConsumerConfigurationV1
  ]: RepositoryConsumerConfigurationV1[Key] extends Readonly<
    Record<string, unknown>
  >
    ? {
        -readonly [
          Nested in keyof RepositoryConsumerConfigurationV1[Key]
        ]: RepositoryConsumerConfigurationV1[Key][Nested];
      }
    : RepositoryConsumerConfigurationV1[Key];
};

function createConsumerRepository(repositoryName: string): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-consumer-config-'),
  );
  writeJson(path.join(repository, 'workflow/config.json'), {
    schemaVersion: 1,
    repositoryName,
    changeRoot: 'plans',
    runtimeDirectory: 'jigwright-runtime',
    protectedBranches: ['trunk'],
    branchTemplate: 'changes/{changeId}',
  });
  return repository;
}

function hasWorkflowCode(expected: string): (error: unknown) => boolean {
  return (error: unknown): boolean =>
    error instanceof Error &&
    'code' in error &&
    (error as Error & { code: unknown }).code === expected;
}

test('consumer policy validates supplied values without reading repository files', (t) => {
  const supplied = orbitConsumerConfiguration();
  const forbidden = () => {
    throw new Error('Consumer policy attempted filesystem I/O');
  };
  t.mock.method(fs, 'readFileSync', forbidden);
  t.mock.method(fs, 'lstatSync', forbidden);
  t.mock.method(fs, 'realpathSync', forbidden);
  const parsed = parseRepositoryConsumerConfiguration(supplied);
  assert.deepEqual(parsed, supplied);
  assert.ok(Object.isFrozen(parsed.planning.supportedSchemaNames));
  assert.ok(Object.isFrozen(parsed.workRegistry));
  assert.throws(
    () =>
      parseRepositoryConsumerConfiguration({
        ...supplied,
        documents: {
          ...supplied.documents,
          handoffPath: supplied.workRegistry.backlogPath,
        },
      }),
    hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_INVALID'),
  );
  assert.throws(
    () =>
      parseRepositoryConsumerConfiguration({
        ...supplied,
        databasePolicy: { adapterId: 'unregistered-database-v1' },
      }),
    hasWorkflowCode('REPOSITORY_CONSUMER_CONFIG_UNSUPPORTED'),
  );
});
