import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  parseExecutionArtifact,
  parseInvestigationArtifact,
  parsePlanReviewArtifact,
} from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import {
  SPEC_DRIVEN_SCHEMA_GRAPH,
  currentSchemaGraph,
  inspectOpenSpecSchemaContract,
  schemaGraphFor,
} from '../src/adapters/planning/openspec/documents/openspec-schema-contract.ts';
import {
  parseInstructions,
  parseStatus,
} from '../src/adapters/planning/openspec/documents/openspec-payloads.ts';
import { isWorkflowError, sourceRepositoryRoot } from './fixture.ts';

test('schema contract pins package provenance and the configured current graph', () => {
  const contract = inspectOpenSpecSchemaContract(sourceRepositoryRoot);

  assert.equal(contract.version, '1.6.0');
  assert.equal(contract.packageSchema.name, 'spec-driven');
  assert.equal(contract.packageSchema.source, 'package');
  assert.deepEqual(contract.packageSchema.graph, SPEC_DRIVEN_SCHEMA_GRAPH);
  assert.equal(contract.currentSchema.name, 'jigwright');
  assert.equal(contract.currentSchema.source, 'project');
  assert.equal(
    contract.currentSchema.files['schema.yaml']?.digest,
    '478b443b3e542b5de7ba92b2929d4e0deb771659da335dea784a7786bb8f23d1',
  );
  assert.equal(
    contract.currentSchema.files['templates/guard.json']?.digest,
    'f1c44b8e477fa42dcf7d42de603e374b27073dd36e06a3f0027ab35fd16aec5a',
  );
  assert.deepEqual(
    contract.currentSchema.graph,
    currentSchemaGraph('jigwright'),
  );
  assert.deepEqual(contract.currentSchema.graph.apply, {
    requires: ['investigation', 'tasks', 'guard', 'execution', 'plan-review'],
    tracks: 'tasks.md',
  });
  assert.equal(contract.trackedPaths.length, 11);
  assert.equal(
    contract.configPath,
    path.join(sourceRepositoryRoot, 'openspec/config.yaml'),
  );
  assert.equal(Object.keys(contract.sourceDigests).length, 5);
  assert.equal(
    contract.currentSchema.files['templates/proposal.md']?.digest,
    contract.packageSchema.files['templates/proposal.md']?.digest,
  );
  assert.match(
    fs.readFileSync(contract.currentSchema.files['schema.yaml']!.path, 'utf8'),
    /Jigwright current-v3 investigation-first workflow[\s\S]*hand execution to `pnpm workflow`[\s\S]*Do not edit task checkboxes/,
  );
  for (const schema of [contract.packageSchema, contract.currentSchema]) {
    for (const file of Object.values(schema.files)) {
      assert.equal(file.mode, '100644');
      assert.match(file.digest, /^[0-9a-f]{64}$/);
    }
  }
});

test('only the configured current schema reuses the current-v3 graph', () => {
  const currentSchemaName = 'orbit-spec-v1';

  assert.deepEqual(
    schemaGraphFor(currentSchemaName, currentSchemaName),
    currentSchemaGraph(currentSchemaName),
  );
  assert.equal(
    schemaGraphFor('spec-driven', currentSchemaName),
    SPEC_DRIVEN_SCHEMA_GRAPH,
  );
  assert.throws(
    () => schemaGraphFor('unreviewed-schema', currentSchemaName),
    (error) => isWorkflowError(error, 'OPENSPEC_SCHEMA_CONTRACT_INVALID'),
  );
  for (const retiredName of ['expense-app', 'expense-app-v2']) {
    assert.throws(
      () => schemaGraphFor(retiredName, currentSchemaName),
      (error) => isWorkflowError(error, 'OPENSPEC_SCHEMA_CONTRACT_INVALID'),
    );
  }
});

test('current schema has the exact investigation-first graph and route-back engine templates', () => {
  const contract = inspectOpenSpecSchemaContract(sourceRepositoryRoot);

  assert.deepEqual(
    currentSchemaGraph('jigwright').artifacts.map(
      ({ id, generates, requires }) => ({ id, generates, requires }),
    ),
    [
      { id: 'investigation', generates: 'investigation.json', requires: [] },
      {
        id: 'proposal',
        generates: 'proposal.md',
        requires: ['investigation'],
      },
      { id: 'specs', generates: 'specs/**/*.md', requires: ['proposal'] },
      { id: 'design', generates: 'design.md', requires: ['proposal'] },
      {
        id: 'tasks',
        generates: 'tasks.md',
        requires: ['specs', 'design'],
      },
      { id: 'guard', generates: 'guard.json', requires: ['tasks'] },
      { id: 'execution', generates: 'execution.json', requires: ['tasks'] },
      {
        id: 'plan-review',
        generates: 'plan-review.json',
        requires: ['guard', 'execution'],
      },
    ],
  );

  for (const artifact of [
    'investigation.json',
    'execution.json',
    'plan-review.json',
  ]) {
    const template = fs.readFileSync(
      contract.currentSchema.files[`templates/${artifact}`]!.path,
      'utf8',
    );
    assert.match(template, /pnpm workflow propose/);
    assert.match(template, /engine-owned/i);
    const parsed = JSON.parse(template);
    if (artifact === 'investigation.json') {
      assert.throws(
        () => parseInvestigationArtifact(parsed, 'demo-change'),
        (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
      );
    } else if (artifact === 'execution.json') {
      assert.throws(
        () =>
          parseExecutionArtifact(
            parsed,
            'demo-change',
            [],
            { schemaVersion: 1, changeId: 'demo-change', tasks: {} },
            { schemaVersion: 1, checks: {} },
            [],
          ),
        (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
      );
    } else {
      assert.throws(
        () => parsePlanReviewArtifact(parsed, 'demo-change'),
        (error) => isWorkflowError(error, 'INVALID_PLAN_REVIEW_ARTIFACT'),
      );
    }
  }
  assert.match(
    fs.readFileSync(
      contract.currentSchema.files['templates/design.md']!.path,
      'utf8',
    ),
    /<!-- workflow:investigation-ledger:start v1 -->[\s\S]*<!-- workflow:investigation-ledger:end v1 -->/,
  );
  const config = fs.readFileSync(
    path.join(sourceRepositoryRoot, 'openspec/config.yaml'),
    'utf8',
  );
  assert.deepEqual(
    config.split('\n').filter((line) => line.startsWith('schema:')),
    ['schema: jigwright'],
  );
});

test('schema contract rejects digest, graph, file-set, mode, and symlink drift', () => {
  const cases: Array<(repository: string) => void> = [
    (repository) => {
      const provenancePath = path.join(
        repository,
        'openspec/schemas/jigwright/provenance.json',
      );
      const provenance = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
      provenance.source.files['templates/proposal.md'] = '0'.repeat(64);
      fs.writeFileSync(
        provenancePath,
        `${JSON.stringify(provenance, null, 2)}\n`,
      );
    },
    (repository) => {
      const configPath = path.join(repository, 'openspec/config.yaml');
      fs.appendFileSync(configPath, "'schema': spec-driven\n");
    },
    (repository) => {
      const schemaPath = path.join(
        repository,
        'openspec/schemas/jigwright/schema.yaml',
      );
      fs.writeFileSync(
        schemaPath,
        fs
          .readFileSync(schemaPath, 'utf8')
          .replace('tracks: tasks.md', 'tracks: guard.json'),
      );
    },
    (repository) => {
      fs.chmodSync(
        path.join(
          repository,
          'openspec/schemas/jigwright/templates/guard.json',
        ),
        0o755,
      );
    },
    (repository) => {
      const target = path.join(
        repository,
        'openspec/schemas/jigwright/templates/guard.json',
      );
      fs.rmSync(target);
      fs.symlinkSync(path.join(repository, 'package.json'), target);
    },
    (repository) => {
      fs.writeFileSync(
        path.join(repository, 'openspec/schemas/jigwright/unreviewed.txt'),
        'unexpected\n',
      );
    },
    (repository) => {
      const configPath = path.join(repository, 'openspec/config.yaml');
      fs.writeFileSync(
        configPath,
        fs
          .readFileSync(configPath, 'utf8')
          .replace('schema: jigwright', 'schema: spec-driven'),
      );
    },
    (repository) => {
      const schemaPath = path.join(
        repository,
        'openspec/schemas/jigwright/schema.yaml',
      );
      fs.writeFileSync(
        schemaPath,
        fs
          .readFileSync(schemaPath, 'utf8')
          .replace('name: jigwright', 'name: unreviewed-schema'),
      );
    },
    (repository) => {
      fs.writeFileSync(
        path.join(repository, 'openspec/schemas/jigwright/unreviewed.txt'),
        'unexpected\n',
      );
    },
    (repository) => {
      fs.appendFileSync(
        path.join(
          repository,
          'openspec/schemas/jigwright/templates/investigation.json',
        ),
        '\n',
      );
    },
    (repository) => {
      fs.rmSync(
        path.join(
          repository,
          'openspec/schemas/jigwright/templates/plan-review.json',
        ),
      );
    },
  ];

  for (const mutate of cases) {
    const repository = createSchemaFixture();
    try {
      mutate(repository);
      assert.throws(
        () => inspectOpenSpecSchemaContract(repository),
        (error) => isWorkflowError(error, 'OPENSPEC_SCHEMA_CONTRACT_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('schema contract normalizes restrictive regular-file permissions to Git 100644', () => {
  const repository = createSchemaFixture();
  try {
    fs.chmodSync(
      path.join(repository, 'openspec/schemas/jigwright/schema.yaml'),
      0o600,
    );
    fs.chmodSync(path.join(repository, 'openspec/config.yaml'), 0o600);
    assert.equal(
      inspectOpenSpecSchemaContract(repository).currentSchema.files[
        'schema.yaml'
      ]?.mode,
      '100644',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('schema status validation uses the configured current graph exactly', () => {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-schema-status-')),
  );
  const changeRoot = path.join(repository, 'openspec/changes/example-change');
  fs.mkdirSync(path.join(changeRoot, 'specs/example'), { recursive: true });
  for (const file of [
    'investigation.json',
    'proposal.md',
    'design.md',
    'tasks.md',
    'guard.json',
    'execution.json',
    'plan-review.json',
    'specs/example/spec.md',
  ]) {
    fs.writeFileSync(path.join(changeRoot, file), `${file}\n`);
  }
  try {
    const payload = completeCurrentStatusPayload(repository, changeRoot);
    const status = parseStatus(payload, {
      repositoryRoot: repository,
      changeId: 'example-change',
      schemaName: 'jigwright',
      currentSchemaName: 'jigwright',
    });
    assert.deepEqual(status.applyRequires, [
      'investigation',
      'tasks',
      'guard',
      'execution',
      'plan-review',
    ]);
    assert.deepEqual(
      status.artifacts.map(({ id, outputPath }) => ({ id, outputPath })),
      [
        { id: 'investigation', outputPath: 'investigation.json' },
        { id: 'proposal', outputPath: 'proposal.md' },
        { id: 'specs', outputPath: 'specs/**/*.md' },
        { id: 'design', outputPath: 'design.md' },
        { id: 'tasks', outputPath: 'tasks.md' },
        { id: 'guard', outputPath: 'guard.json' },
        { id: 'execution', outputPath: 'execution.json' },
        { id: 'plan-review', outputPath: 'plan-review.json' },
      ],
    );

    for (const mutate of [
      (value: ReturnType<typeof completeCurrentStatusPayload>) => {
        value.applyRequires = ['tasks'];
      },
      (value: ReturnType<typeof completeCurrentStatusPayload>) => {
        (value.artifacts[5] as { outputPath: string }).outputPath =
          'policy.json';
      },
      (value: ReturnType<typeof completeCurrentStatusPayload>) => {
        (value.artifactPaths.guard as { outputPath: string }).outputPath =
          'policy.json';
      },
      (value: ReturnType<typeof completeCurrentStatusPayload>) => {
        (value.artifacts[5] as Record<string, unknown>).unexpected = true;
      },
      (value: ReturnType<typeof completeCurrentStatusPayload>) => {
        (value.artifactPaths.guard as Record<string, unknown>).unexpected =
          true;
      },
      (value: ReturnType<typeof completeCurrentStatusPayload>) => {
        (value.artifacts[5] as { outputPath: string }).outputPath =
          'guard\u0085.json';
      },
    ]) {
      const invalid = completeCurrentStatusPayload(repository, changeRoot);
      mutate(invalid);
      assert.throws(
        () =>
          parseStatus(invalid, {
            repositoryRoot: repository,
            changeId: 'example-change',
            schemaName: 'jigwright',
            currentSchemaName: 'jigwright',
          }),
        (error) => isWorkflowError(error, 'OPENSPEC_PAYLOAD_INVALID'),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current status and instructions use the exact investigation-first graph', () => {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-schema-v2-status-')),
  );
  const changeRoot = path.join(repository, 'openspec/changes/example-change');
  fs.mkdirSync(path.join(changeRoot, 'specs/example'), { recursive: true });
  for (const file of [
    'investigation.json',
    'proposal.md',
    'design.md',
    'tasks.md',
    'guard.json',
    'execution.json',
    'plan-review.json',
    'specs/example/spec.md',
  ]) {
    fs.writeFileSync(path.join(changeRoot, file), `${file}\n`);
  }
  try {
    const status = parseStatus(
      completeCurrentStatusPayload(repository, changeRoot),
      {
        repositoryRoot: repository,
        changeId: 'example-change',
        schemaName: 'jigwright',
        currentSchemaName: 'jigwright',
      },
    );
    assert.deepEqual(status.applyRequires, [
      'investigation',
      'tasks',
      'guard',
      'execution',
      'plan-review',
    ]);
    assert.deepEqual(status.artifactIds, [
      'investigation',
      'proposal',
      'specs',
      'design',
      'tasks',
      'guard',
      'execution',
      'plan-review',
    ]);

    const configuredStatusPayload = completeCurrentStatusPayload(
      repository,
      changeRoot,
    );
    configuredStatusPayload.schemaName = 'orbit-spec-v1';
    const configuredStatus = parseStatus(configuredStatusPayload, {
      repositoryRoot: repository,
      changeId: 'example-change',
      schemaName: 'orbit-spec-v1',
      currentSchemaName: 'orbit-spec-v1',
    });
    assert.deepEqual(configuredStatus.applyRequires, status.applyRequires);
    assert.deepEqual(configuredStatus.artifactIds, status.artifactIds);

    const instructionPayload = {
      changeName: 'example-change',
      artifactId: 'plan-review',
      schemaName: 'jigwright',
      changeDir: changeRoot,
      planningHome: {
        kind: 'repo',
        root: repository,
        changesDir: path.join(repository, 'openspec/changes'),
        defaultSchema: 'jigwright',
      },
      outputPath: 'plan-review.json',
      resolvedOutputPath: path.join(changeRoot, 'plan-review.json'),
      existingOutputPaths: [path.join(changeRoot, 'plan-review.json')],
      instruction: 'Return to the workflow engine.',
      template: '{"kind":"workflow-propose-required"}\n',
      dependencies: [
        {
          id: 'guard',
          done: true,
          path: 'guard.json',
          description: 'Guard',
        },
        {
          id: 'execution',
          done: true,
          path: 'execution.json',
          description: 'Execution',
        },
      ],
      unlocks: [],
      root: { path: repository, source: 'nearest' },
    };
    const instruction = parseInstructions(instructionPayload, {
      repositoryRoot: repository,
      changeId: 'example-change',
      schemaName: 'jigwright',
      artifactId: 'plan-review',
      currentSchemaName: 'jigwright',
    });
    assert.equal(instruction.outputPath, 'plan-review.json');
    const configuredInstruction = parseInstructions(
      { ...instructionPayload, schemaName: 'orbit-spec-v1' },
      {
        repositoryRoot: repository,
        changeId: 'example-change',
        schemaName: 'orbit-spec-v1',
        artifactId: 'plan-review',
        currentSchemaName: 'orbit-spec-v1',
      },
    );
    assert.equal(configuredInstruction.outputPath, 'plan-review.json');

    const reordered = completeCurrentStatusPayload(repository, changeRoot);
    reordered.applyRequires = [
      'tasks',
      'investigation',
      'guard',
      'execution',
      'plan-review',
    ];
    assert.throws(
      () =>
        parseStatus(reordered, {
          repositoryRoot: repository,
          changeId: 'example-change',
          schemaName: 'jigwright',
          currentSchemaName: 'jigwright',
        }),
      (error) => isWorkflowError(error, 'OPENSPEC_PAYLOAD_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('instruction payload recomputes dependency readiness and rejects C1 paths', () => {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-schema-instructions-')),
  );
  const changeDir = path.join(repository, 'openspec/changes/example-change');
  fs.mkdirSync(changeDir, { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'tasks.md'), '# Tasks\n');
  fs.writeFileSync(path.join(changeDir, 'guard.json'), '{}\n');
  const valid = {
    changeName: 'example-change',
    artifactId: 'guard',
    schemaName: 'jigwright',
    changeDir,
    planningHome: {
      kind: 'repo',
      root: repository,
      changesDir: path.join(repository, 'openspec/changes'),
      defaultSchema: 'jigwright',
    },
    outputPath: 'guard.json',
    resolvedOutputPath: path.join(changeDir, 'guard.json'),
    existingOutputPaths: [path.join(changeDir, 'guard.json')],
    instruction: 'Create guard policy.',
    template: '{}\n',
    dependencies: [
      {
        id: 'tasks',
        done: true,
        path: 'tasks.md',
        description: 'Tasks',
      },
    ],
    unlocks: ['plan-review'],
    root: { path: repository, source: 'nearest' },
  };
  try {
    assert.equal(
      parseInstructions(valid, {
        repositoryRoot: repository,
        changeId: 'example-change',
        schemaName: 'jigwright',
        artifactId: 'guard',
        currentSchemaName: 'jigwright',
      }).outputPath,
      'guard.json',
    );
    for (const invalid of [
      {
        ...valid,
        dependencies: [{ ...valid.dependencies[0]!, done: false }],
      },
      {
        ...valid,
        outputPath: 'guard\u0085.json',
        resolvedOutputPath: path.join(changeDir, 'guard\u0085.json'),
        existingOutputPaths: [],
      },
    ]) {
      assert.throws(
        () =>
          parseInstructions(invalid, {
            repositoryRoot: repository,
            changeId: 'example-change',
            schemaName: 'jigwright',
            artifactId: 'guard',
            currentSchemaName: 'jigwright',
          }),
        (error) => isWorkflowError(error, 'OPENSPEC_PAYLOAD_INVALID'),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function completeCurrentStatusPayload(repository: string, changeRoot: string) {
  const outputs = {
    investigation: 'investigation.json',
    proposal: 'proposal.md',
    specs: 'specs/**/*.md',
    design: 'design.md',
    tasks: 'tasks.md',
    guard: 'guard.json',
    execution: 'execution.json',
    'plan-review': 'plan-review.json',
  } as const;
  const artifactIds = [
    'investigation',
    'proposal',
    'specs',
    'design',
    'tasks',
    'guard',
    'execution',
    'plan-review',
  ] as const;
  const existing = {
    investigation: [path.join(changeRoot, 'investigation.json')],
    proposal: [path.join(changeRoot, 'proposal.md')],
    specs: [path.join(changeRoot, 'specs/example/spec.md')],
    design: [path.join(changeRoot, 'design.md')],
    tasks: [path.join(changeRoot, 'tasks.md')],
    guard: [path.join(changeRoot, 'guard.json')],
    execution: [path.join(changeRoot, 'execution.json')],
    'plan-review': [path.join(changeRoot, 'plan-review.json')],
  };
  return {
    changeName: 'example-change',
    schemaName: 'jigwright',
    changeRoot,
    planningHome: {
      kind: 'repo',
      root: repository,
      changesDir: path.join(repository, 'openspec/changes'),
      defaultSchema: 'jigwright',
    },
    artifactPaths: Object.fromEntries(
      artifactIds.map((id) => [
        id,
        {
          outputPath: outputs[id],
          resolvedOutputPath: path.join(changeRoot, outputs[id]),
          existingOutputPaths: existing[id],
        },
      ]),
    ),
    artifacts: artifactIds.map((id) => ({
      id,
      outputPath: outputs[id],
      status: 'done' as const,
    })),
    applyRequires: [
      'investigation',
      'tasks',
      'guard',
      'execution',
      'plan-review',
    ],
    isComplete: true,
    root: { path: repository, source: 'nearest' },
  };
}

function createSchemaFixture(): string {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-schema-contract-')),
  );
  const packageDirectory = path.join(
    repository,
    'node_modules/@fission-ai/openspec',
  );
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  fs.cpSync(
    path.join(
      sourceRepositoryRoot,
      'node_modules/@fission-ai/openspec/schemas/spec-driven',
    ),
    path.join(packageDirectory, 'schemas/spec-driven'),
    { recursive: true },
  );
  fs.mkdirSync(path.join(repository, 'openspec'), { recursive: true });
  fs.copyFileSync(
    path.join(sourceRepositoryRoot, 'openspec/config.yaml'),
    path.join(repository, 'openspec/config.yaml'),
  );
  fs.cpSync(
    path.join(sourceRepositoryRoot, 'openspec/schemas/jigwright'),
    path.join(repository, 'openspec/schemas/jigwright'),
    { recursive: true },
  );
  for (const filePath of [
    'workflow/config.json',
    'workflow/repository-consumer.json',
  ]) {
    const target = path.join(repository, filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(sourceRepositoryRoot, filePath), target);
  }
  fs.writeFileSync(
    path.join(repository, 'package.json'),
    `${JSON.stringify(
      {
        name: 'schema-contract-fixture',
        private: true,
        devDependencies: { '@fission-ai/openspec': '1.6.0' },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(repository, 'pnpm-workspace.yaml'),
    "packages: []\n\nallowBuilds:\n  '@fission-ai/openspec': false\n",
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
  fs.writeFileSync(
    path.join(packageDirectory, 'package.json'),
    `${JSON.stringify(
      {
        name: '@fission-ai/openspec',
        version: '1.6.0',
        type: 'module',
        bin: { openspec: './bin/openspec.js' },
      },
      null,
      2,
    )}\n`,
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'bin/openspec.js'),
    "process.stdout.write('1.6.0\\n');\n",
  );
  return repository;
}

function cryptoDigest(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
