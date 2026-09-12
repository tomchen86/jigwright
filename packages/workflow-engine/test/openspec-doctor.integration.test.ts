import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { diagnoseOpenSpec } from '../src/adapters/planning/openspec/documents/openspec-doctor.ts';
import { parseDoctor } from '../src/adapters/planning/openspec/documents/openspec-doctor-payload.ts';
import { isWorkflowError, sourceRepositoryRoot } from './fixture.ts';
import { ExitCode } from '../src/foundation/errors/errors.ts';

test('OpenSpec doctor validates payload health instead of trusting exit zero', () => {
  const unhealthy = parseDoctor(
    {
      root: {
        path: sourceRepositoryRoot,
        source: 'nearest',
        healthy: false,
        status: [
          {
            severity: 'error',
            code: 'openspec_config_missing',
            message: 'Missing openspec/config.yaml or openspec/config.yml.',
            target: 'openspec.config',
          },
        ],
      },
      store: null,
      references: [],
      status: [],
    },
    sourceRepositoryRoot,
    0,
  );

  assert.equal(unhealthy.resolved, true);
  assert.equal(unhealthy.healthy, false);
  assert.deepEqual(
    unhealthy.diagnostics.map(({ code }) => code),
    ['openspec_config_missing'],
  );
});

test('OpenSpec doctor rejects stores, external roots, and exit/payload drift', () => {
  const healthyRoot = {
    path: sourceRepositoryRoot,
    source: 'nearest',
    healthy: true,
    status: [],
  };
  const cases: Array<{ value: unknown; status: number }> = [
    {
      value: {
        root: { ...healthyRoot, path: path.dirname(sourceRepositoryRoot) },
        store: null,
        references: [],
        status: [],
      },
      status: 0,
    },
    {
      value: {
        root: { ...healthyRoot, store_id: 'shadow-store' },
        store: {
          id: 'shadow-store',
          metadata: { present: true, valid: true },
          status: [],
        },
        references: [],
        status: [],
      },
      status: 0,
    },
    {
      value: {
        root: null,
        store: null,
        references: [],
        status: [
          {
            severity: 'error',
            code: 'no_openspec_root',
            message: 'No OpenSpec root found.',
          },
        ],
      },
      status: 0,
    },
    {
      value: {
        root: healthyRoot,
        store: null,
        references: [],
        status: [],
      },
      status: 1,
    },
    {
      value: {
        root: {
          ...healthyRoot,
          status: [
            {
              severity: 'error',
              code: 'openspec_config_missing',
              message: 'Missing openspec/config.yaml or openspec/config.yml.',
              target: 'openspec.config',
            },
          ],
        },
        store: null,
        references: [],
        status: [],
      },
      status: 0,
    },
    {
      value: {
        root: { ...healthyRoot, healthy: false },
        store: null,
        references: [],
        status: [],
      },
      status: 0,
    },
    {
      value: {
        root: healthyRoot,
        store: null,
        references: [],
        status: [
          {
            severity: 'warning',
            code: 'unknown_relationship_warning',
            message: 'Unknown warning.',
            target: 'relationships',
          },
        ],
      },
      status: 0,
    },
    {
      value: {
        root: healthyRoot,
        store: null,
        references: [
          {
            store_id: 'external-store',
            root: 'relative-external-store',
            status: [],
          },
        ],
        status: [],
      },
      status: 0,
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => parseDoctor(fixture.value, sourceRepositoryRoot, fixture.status),
      (error) => isWorkflowError(error, 'OPENSPEC_PAYLOAD_INVALID'),
    );
  }
});

test('OpenSpec doctor accepts the pinned exit-one diagnostic envelope', () => {
  const result = parseDoctor(
    {
      root: null,
      store: null,
      references: [],
      status: [
        {
          severity: 'error',
          code: 'no_openspec_root',
          message: 'No OpenSpec root found.',
          target: 'openspec.root',
          fix: 'Run openspec init.',
        },
      ],
    },
    sourceRepositoryRoot,
    1,
  );

  assert.equal(result.resolved, false);
  assert.equal(result.healthy, false);
  assert.equal(result.root, null);
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ['no_openspec_root'],
  );
});

test('OpenSpec doctor reports a canonical resolved reference as outside policy', () => {
  const referenceRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-openspec-reference-')),
  );
  try {
    const result = parseDoctor(
      {
        root: {
          path: sourceRepositoryRoot,
          source: 'nearest',
          healthy: true,
          status: [],
        },
        store: null,
        references: [
          { store_id: 'shared-specs', root: referenceRoot, status: [] },
        ],
        status: [],
      },
      sourceRepositoryRoot,
      0,
    );

    assert.equal(result.root?.healthy, true);
    assert.equal(result.healthy, false);
    assert.deepEqual(
      result.diagnostics.map(({ code }) => code),
      ['OPENSPEC_REFERENCE_STORE_REJECTED'],
    );
  } finally {
    fs.rmSync(referenceRoot, { recursive: true, force: true });
  }
});

test('workflow OpenSpec diagnostics report package provenance and semantic failures', () => {
  const repository = createDoctorFixture();
  try {
    const report = diagnoseOpenSpec(repository);

    assert.equal(report.expectedVersion, '1.6.0');
    assert.equal(report.healthy, false);
    assert.deepEqual(report.installation, {
      ok: true,
      packageName: '@fission-ai/openspec',
      declaredVersion: '1.6.0',
      lockfileVersion: '9.0',
      lockedVersion: '1.6.0',
      integrity:
        'sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==',
      buildScriptsAllowed: false,
      installedVersion: '1.6.0',
      packageDirectory: path.join(
        repository,
        'node_modules/@fission-ai/openspec',
      ),
      binPath: path.join(
        repository,
        'node_modules/@fission-ai/openspec/bin/openspec.js',
      ),
    });
    assert.deepEqual(report.runtime, { ok: true, version: '1.6.0' });
    assert.deepEqual(report.root, {
      ok: false,
      path: repository,
      source: 'nearest',
      healthy: false,
      storeActive: false,
    });
    assert.deepEqual(report.schemas, [
      {
        name: 'spec-driven',
        expectedSource: 'package',
        ok: false,
        resolution: {
          source: 'package',
          path: path.join(
            repository,
            'node_modules/@fission-ai/openspec/schemas/spec-driven',
          ),
        },
        validation: { valid: false, issueCount: 1 },
      },
      {
        name: 'expense-app',
        expectedSource: 'project',
        ok: true,
        resolution: {
          source: 'project',
          path: path.join(repository, 'openspec/schemas/expense-app'),
        },
        validation: { valid: true, issueCount: 0 },
      },
      {
        name: 'expense-app-v2',
        expectedSource: 'project',
        ok: true,
        resolution: {
          source: 'project',
          path: path.join(repository, 'openspec/schemas/expense-app-v2'),
        },
        validation: { valid: true, issueCount: 0 },
      },
    ]);
    assert.deepEqual(
      report.diagnostics.map(({ code }) => code),
      ['openspec_config_missing', 'OPENSPEC_SCHEMA_INVALID'],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow OpenSpec diagnostics derive schema expectations from repository policy', () => {
  const repository = createDoctorFixture('1.6.0', {
    packageSchemaNames: ['spec-driven'],
    requiredSchemaNames: ['spec-driven', 'jigwright'],
    supportedSchemaNames: ['spec-driven', 'jigwright'],
    managedSchemaNames: ['jigwright'],
    currentSchemaName: 'jigwright',
  });
  try {
    const report = diagnoseOpenSpec(repository);

    assert.deepEqual(
      report.schemas.map(({ name, expectedSource }) => ({
        name,
        expectedSource,
      })),
      [
        { name: 'spec-driven', expectedSource: 'package' },
        { name: 'jigwright', expectedSource: 'project' },
      ],
    );
    assert.equal(
      report.diagnostics.some(
        ({ target }) => target?.includes('expense-app') === true,
      ),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow OpenSpec diagnostics fail closed on invalid repository schema policy', () => {
  const repository = createDoctorFixture();
  writeRepositoryConsumerConfiguration(repository, {
    ...DEFAULT_DOCTOR_PLANNING,
    currentSchemaName: 'missing-schema',
  });
  try {
    const report = diagnoseOpenSpec(repository);

    assert.equal(report.healthy, false);
    assert.deepEqual(report.schemas, []);
    assert.deepEqual(report.diagnostics.at(-1), {
      severity: 'error',
      code: 'OPENSPEC_SCHEMA_POLICY_DIAGNOSTIC_FAILED',
      message:
        'Repository consumer configuration does not match schema version 1.',
      target: 'openspec.schema-policy',
      causeCode: 'REPOSITORY_CONSUMER_CONFIG_INVALID',
    });
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow OpenSpec diagnostics preserve an observed runtime version mismatch', () => {
  const repository = createDoctorFixture('1.7.0');
  try {
    const report = diagnoseOpenSpec(repository);

    assert.equal(report.healthy, false);
    assert.deepEqual(report.runtime, { ok: false, version: '1.7.0' });
    assert.deepEqual(
      report.diagnostics.map(({ code }) => code),
      ['OPENSPEC_RUNTIME_DIAGNOSTIC_FAILED'],
    );
    assert.equal(report.diagnostics[0]?.causeCode, 'OPENSPEC_VERSION_MISMATCH');
    assert.equal(report.root.path, null);
    assert.equal(report.schemas[0]?.resolution, null);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow OpenSpec diagnostics reject a symlinked package schema', () => {
  const repository = createDoctorFixture();
  const externalSchema = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-openspec-schema-')),
  );
  const schemaPath = path.join(
    repository,
    'node_modules/@fission-ai/openspec/schemas/spec-driven',
  );
  fs.rmSync(schemaPath, { recursive: true, force: true });
  fs.symlinkSync(externalSchema, schemaPath, 'dir');
  try {
    const report = diagnoseOpenSpec(repository);

    assert.equal(report.healthy, false);
    assert.equal(report.schemas[0]?.resolution, null);
    assert.equal(report.schemas[0]?.validation, null);
    assert.deepEqual(
      report.diagnostics.slice(-2).map(({ code, causeCode }) => ({
        code,
        causeCode,
      })),
      [
        {
          code: 'OPENSPEC_SCHEMA_RESOLUTION_DIAGNOSTIC_FAILED',
          causeCode: 'OPENSPEC_PATH_UNSAFE',
        },
        {
          code: 'OPENSPEC_SCHEMA_VALIDATION_DIAGNOSTIC_FAILED',
          causeCode: 'OPENSPEC_PATH_UNSAFE',
        },
      ],
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(externalSchema, { recursive: true, force: true });
  }
});

test('real workflow doctor reports the pinned local OpenSpec installation', () => {
  const output = execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
      'doctor',
      '--json',
    ],
    {
      cwd: sourceRepositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const result = JSON.parse(output) as Record<string, unknown>;
  const openspec = result.openspec as Record<string, unknown>;

  assert.equal(result.ok, true);
  assert.equal(openspec.expectedVersion, '1.6.0');
  assert.equal(openspec.healthy, true);
  assert.deepEqual(openspec.runtime, { ok: true, version: '1.6.0' });
  assert.deepEqual(openspec.diagnostics, []);
  assert.deepEqual(
    (openspec.schemas as Array<Record<string, unknown>>).map(
      ({ name, expectedSource }) => ({ name, expectedSource }),
    ),
    [
      { name: 'spec-driven', expectedSource: 'package' },
      { name: 'jigwright', expectedSource: 'project' },
    ],
  );
});

test('workflow doctor derives base-spec diagnostics from the configured change root', () => {
  const configuredRepository = createDoctorFixture();
  const defaultRepository = createDoctorFixture();
  try {
    writeDoctorWorkflowConfig(configuredRepository, 'plans');
    fs.rmSync(path.join(configuredRepository, 'openspec/specs'), {
      recursive: true,
    });
    fs.mkdirSync(path.join(configuredRepository, 'specs'));
    initializeDoctorFixtureRepository(configuredRepository);

    const beforeConfigured = doctorFixtureStatus(configuredRepository);
    const present = runWorkflowDoctor(configuredRepository);
    assert.equal(
      present.warnings.some(({ code }) => code === 'NO_BASE_SPECS'),
      false,
    );
    assert.equal(
      doctorFixtureStatus(configuredRepository),
      beforeConfigured,
      'doctor must not mutate a repository with configured base specs',
    );

    fs.rmSync(path.join(configuredRepository, 'specs'), { recursive: true });
    const beforeMissingConfigured = doctorFixtureStatus(configuredRepository);
    const missingConfigured = runWorkflowDoctor(configuredRepository);
    assert.deepEqual(
      missingConfigured.warnings.find(({ code }) => code === 'NO_BASE_SPECS'),
      {
        code: 'NO_BASE_SPECS',
        message:
          'specs does not exist yet; create the current managed base specifications before planning changes.',
      },
    );
    assert.equal(
      doctorFixtureStatus(configuredRepository),
      beforeMissingConfigured,
      'doctor must not repair missing configured base specs',
    );

    writeDoctorWorkflowConfig(defaultRepository, 'openspec/changes');
    fs.rmSync(path.join(defaultRepository, 'openspec/specs'), {
      recursive: true,
    });
    initializeDoctorFixtureRepository(defaultRepository);
    const missingDefault = runWorkflowDoctor(defaultRepository);
    assert.deepEqual(
      missingDefault.warnings.find(({ code }) => code === 'NO_BASE_SPECS'),
      {
        code: 'NO_BASE_SPECS',
        message:
          'openspec/specs does not exist yet; create the current managed base specifications before planning changes.',
      },
    );
  } finally {
    fs.rmSync(configuredRepository, { recursive: true, force: true });
    fs.rmSync(defaultRepository, { recursive: true, force: true });
  }
});

test('workflow doctor reports unhealthy OpenSpec and malformed colocated contracts honestly', () => {
  const root = createDoctorFixture();
  try {
    writeDoctorWorkflowConfig(root, 'openspec/changes');
    initializeDoctorFixtureRepository(root);
    const unhealthy = runWorkflowDoctor(root);
    assert.equal(unhealthy.ok, false);
    fs.writeFileSync(
      path.join(root, 'spec.md'),
      '# Invalid contract\n\n## Purpose\nTBD\n\n## Requirements\n',
    );
    const malformed = runWorkflowDoctor(root);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.systemDocuments.configured, true);
    assert.equal(malformed.systemDocuments.healthy, false);
    assert.ok(
      malformed.systemDocuments.diagnostics.some(
        (issue) => issue.code === 'purpose-missing',
      ),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

type DoctorPlanningConfiguration = Readonly<{
  packageSchemaNames: string[];
  requiredSchemaNames: string[];
  supportedSchemaNames: string[];
  managedSchemaNames: string[];
  currentSchemaName: string;
}>;

const DEFAULT_DOCTOR_PLANNING: DoctorPlanningConfiguration = {
  packageSchemaNames: ['spec-driven'],
  requiredSchemaNames: ['spec-driven', 'expense-app'],
  supportedSchemaNames: ['spec-driven', 'expense-app', 'expense-app-v2'],
  managedSchemaNames: ['expense-app', 'expense-app-v2'],
  currentSchemaName: 'expense-app-v2',
};

function createDoctorFixture(
  runtimeVersion = '1.6.0',
  planning: DoctorPlanningConfiguration = DEFAULT_DOCTOR_PLANNING,
): string {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-openspec-doctor-')),
  );
  const packageDirectory = path.join(
    repository,
    'node_modules/@fission-ai/openspec',
  );
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'openspec/changes'), { recursive: true });
  fs.mkdirSync(path.join(repository, 'openspec/specs'), { recursive: true });
  for (const schemaName of planning.packageSchemaNames) {
    fs.mkdirSync(path.join(packageDirectory, 'schemas', schemaName), {
      recursive: true,
    });
  }
  for (const schemaName of planning.managedSchemaNames) {
    fs.mkdirSync(path.join(repository, 'openspec/schemas', schemaName), {
      recursive: true,
    });
  }
  writeJson(path.join(repository, 'workflow/config.json'), {
    repositoryName: 'doctor-fixture',
  });
  writeRepositoryConsumerConfiguration(repository, planning);
  writeJson(path.join(repository, 'package.json'), {
    name: 'doctor-fixture',
    private: true,
    devDependencies: { '@fission-ai/openspec': '1.6.0' },
  });
  fs.writeFileSync(
    path.join(repository, 'pnpm-workspace.yaml'),
    [
      'packages:',
      "  - 'packages/*'",
      '',
      'allowBuilds:',
      "  '@fission-ai/openspec': false",
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    path.join(repository, 'pnpm-lock.yaml'),
    [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    devDependencies:',
      "      '@fission-ai/openspec':",
      '        specifier: 1.6.0',
      '        version: 1.6.0',
      '',
      'packages:',
      '',
      "  '@fission-ai/openspec@1.6.0':",
      '    resolution: {integrity: sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==}',
      '    hasBin: true',
      '',
      'snapshots:',
      '',
      "  '@fission-ai/openspec@1.6.0': {}",
      '',
    ].join('\n'),
  );
  writeJson(path.join(packageDirectory, 'package.json'), {
    name: '@fission-ai/openspec',
    version: '1.6.0',
    type: 'module',
    bin: { openspec: './bin/openspec.js' },
  });
  fs.writeFileSync(
    path.join(packageDirectory, 'bin/openspec.js'),
    `const args = process.argv.slice(2);
if (args[0] === '--version') {
  process.stdout.write(${JSON.stringify(`${runtimeVersion}\n`)});
} else if (args[0] === 'doctor') {
  process.stdout.write(JSON.stringify({
    root: {
      path: process.cwd(), source: 'nearest', healthy: false,
      status: [{
        severity: 'error', code: 'openspec_config_missing',
        message: 'Missing openspec/config.yaml or openspec/config.yml.',
        target: 'openspec.config'
      }]
    },
    store: null, references: [], status: []
  }));
} else if (args[0] === 'schema' && args[1] === 'which') {
  const project = args[2] !== 'spec-driven';
  process.stderr.write('Note: Schema commands are experimental and may change.\\n');
  process.stdout.write(JSON.stringify({
    name: args[2], source: project ? 'project' : 'package',
    path: project
      ? process.cwd() + '/openspec/schemas/' + args[2]
      : new URL('../schemas/spec-driven', import.meta.url).pathname,
    shadows: []
  }));
} else if (args[0] === 'schema' && args[1] === 'validate') {
  const project = args[2] !== 'spec-driven';
  process.stderr.write('Note: Schema commands are experimental and may change.\\n');
  process.stdout.write(JSON.stringify({
    name: args[2],
    path: project
      ? process.cwd() + '/openspec/schemas/' + args[2]
      : new URL('../schemas/spec-driven', import.meta.url).pathname,
    valid: project,
    issues: project ? [] : [{
      level: 'error', path: 'schema.yaml', message: 'invalid fixture schema'
    }]
  }));
}
`,
  );
  return repository;
}

function writeRepositoryConsumerConfiguration(
  repository: string,
  planning: DoctorPlanningConfiguration,
): void {
  writeJson(path.join(repository, 'workflow/repository-consumer.json'), {
    schemaVersion: 1,
    adapterId: 'configured-repository-v1',
    consumerId: 'doctor-fixture',
    planning: {
      providerId: 'openspec',
      ...planning,
    },
    documents: {
      adapterId: 'filesystem-documents-v1',
      handoffPath: 'docs/CURRENT_AND_NEXT_STEPS.md',
    },
    workRegistry: {
      adapterId: 'filesystem-work-registry-v1',
      itemRoot: 'docs/work-registry/items',
      inventoryPath: 'docs/work-registry/inventory.json',
      backlogPath: 'docs/BACKLOG.md',
      historyRoot: 'docs/work-history',
      transitionPolicyPath: 'workflow/work-registry-policy.json',
      changeOriginRoot: 'openspec/changes',
    },
    databasePolicy: { adapterId: 'disabled-v1' },
  });
}

function initializeDoctorFixtureRepository(repository: string): void {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main'], {
    cwd: repository,
    stdio: 'ignore',
  });
  execFileSync('git', ['add', '.'], { cwd: repository, stdio: 'ignore' });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Jigwright Test',
      '-c',
      'user.email=jigwright-test@example.invalid',
      '-c',
      'commit.gpgSign=false',
      'commit',
      '--quiet',
      '-m',
      'Create doctor fixture',
    ],
    { cwd: repository, stdio: 'ignore' },
  );
}

function writeDoctorWorkflowConfig(
  repository: string,
  changeRoot: string,
): void {
  writeJson(path.join(repository, 'workflow/config.json'), {
    schemaVersion: 1,
    repositoryName: 'doctor-fixture',
    changeRoot,
    runtimeDirectory: 'workflow-engine',
    protectedBranches: ['main'],
    branchTemplate: 'work/{changeId}',
  });
}

function runWorkflowDoctor(repository: string): {
  ok: boolean;
  systemDocuments: {
    configured: boolean;
    healthy: boolean;
    diagnostics: Array<{ code: string }>;
  };
  warnings: Array<{ code: string; message: string }>;
} {
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(
        sourceRepositoryRoot,
        'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
      ),
      'doctor',
      '--json',
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  assert.ok(
    result.status === 0 || result.status === ExitCode.verification,
    result.stderr,
  );
  return JSON.parse(result.stdout) as ReturnType<typeof runWorkflowDoctor>;
}

function doctorFixtureStatus(repository: string): string {
  return execFileSync('git', ['status', '--short'], {
    cwd: repository,
    encoding: 'utf8',
  });
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}
