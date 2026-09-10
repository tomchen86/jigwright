import fs from 'node:fs';
import path from 'node:path';
const sourceRepositoryRoot = path.resolve(import.meta.dirname, '../../..');

export function installFakeOpenSpec(repository: string): void {
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

  const manifestPath = path.join(repository, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.devDependencies['@fission-ai/openspec'] = '1.6.0';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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
    `import './runtime-helper.js';
import { applyFixtureArchiveSpecs } from './archive-helper.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
function configuredCurrentSchemaName(root) {
  const configPath = path.join(root, 'workflow/repository-consumer.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf8')).planning.currentSchemaName;
}
if (process.argv[2] === 'init') {
  await import('./openspec-asset-init.mjs');
  process.exit(0);
}
if (process.argv[2] === '--version') {
  process.stdout.write('1.6.0\\n');
  process.exit(0);
}
if (process.argv[2] === 'doctor') {
  process.stdout.write(JSON.stringify({
    root: {
      path: process.cwd(), source: 'nearest', healthy: true, status: []
    },
    store: null,
    references: [],
    status: []
  }));
  process.exit(0);
}
if (process.argv[2] === 'schema') {
  const operation = process.argv[3];
  const schemaName = process.argv[4];
  const root = process.cwd();
  const packageRoot = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..'
  );
  const schemaPath = schemaName === 'spec-driven'
    ? path.join(packageRoot, 'schemas/spec-driven')
    : path.join(root, 'openspec/schemas', schemaName);
  process.stderr.write('Note: Schema commands are experimental and may change.\\n');
  process.stdout.write(JSON.stringify(operation === 'which'
    ? {
        name: schemaName,
        source: schemaName === 'spec-driven' ? 'package' : 'project',
        path: schemaPath,
        shadows: []
      }
    : { name: schemaName, path: schemaPath, valid: true, issues: [] }
  ));
  process.exit(0);
}
if (process.argv[2] === 'instructions') {
  const artifactId = process.argv[3];
  const changeId = process.argv[5];
  const schemaName = process.argv[7];
  const root = process.cwd();
  const changeRoot = path.join(root, 'openspec/changes', changeId);
  const graph = [
    ['investigation', 'investigation.json', []],
    ['proposal', 'proposal.md', ['investigation']],
    ['specs', 'specs/**/*.md', ['proposal']],
    ['design', 'design.md', ['proposal']],
    ['tasks', 'tasks.md', ['specs', 'design']],
    ['guard', 'guard.json', ['tasks']],
    ['execution', 'execution.json', ['tasks']],
    ['plan-review', 'plan-review.json', ['guard', 'execution']]
  ];
  const artifact = graph.find(([id]) => id === artifactId);
  if (
    schemaName !== configuredCurrentSchemaName(root) ||
    !artifact
  ) {
    process.stderr.write('unsupported fixture instructions');
    process.exit(2);
  }
  const exists = (id) => {
    const candidate = graph.find(([entryId]) => entryId === id);
    if (!candidate) return false;
    if (candidate[1] === 'specs/**/*.md') {
      return fs.existsSync(path.join(changeRoot, 'specs/demo/spec.md'));
    }
    return fs.existsSync(path.join(changeRoot, candidate[1]));
  };
  const outputPath = artifact[1];
  const resolvedOutputPath = path.join(changeRoot, outputPath);
  const existingOutputPaths = exists(artifactId)
    ? [outputPath === 'specs/**/*.md'
        ? path.join(changeRoot, 'specs/demo/spec.md')
        : resolvedOutputPath]
    : [];
  process.stdout.write(JSON.stringify({
    changeName: changeId,
    artifactId,
    schemaName,
    changeDir: changeRoot,
    planningHome: {
      kind: 'repo', root,
      changesDir: path.join(root, 'openspec/changes'),
      defaultSchema: 'spec-driven'
    },
    outputPath,
    resolvedOutputPath,
    existingOutputPaths,
    dependencies: artifact[2].map((id) => {
      const dependency = graph.find(([entryId]) => entryId === id);
      return {
        id,
        path: dependency[1],
        description: id + ' dependency',
        done: exists(id)
      };
    }),
    unlocks: graph
      .filter(([, , dependencies]) => dependencies.includes(artifactId))
      .map(([id]) => id)
      .sort(),
    instruction: 'Author the reviewed ' + artifactId + ' artifact.',
    template: artifactId === 'proposal' ? '# Proposal\\n' : '',
    root: { path: root, source: 'nearest' }
  }));
  process.exit(0);
}
if (process.argv[2] === 'status') {
  const changeId = process.argv[4];
  const schemaName = process.argv[6];
  const root = process.cwd();
  const changeRoot = path.join(root, 'openspec/changes', changeId);
  const gitDirectory = path.join(root, '.git');
  const lifecycleMutation = path.join(gitDirectory, 'mutate-on-lifecycle-start');
  const operationLock = path.join(
    gitDirectory,
    'workflow-engine/operations/repository-lifecycle.lock'
  );
  const checkMutation = path.join(gitDirectory, 'mutate-on-next-status');
  const statusCountdown = path.join(gitDirectory, 'mutate-status-countdown');
  const allowedStatusCountdown = path.join(
    gitDirectory,
    'mutate-allowed-status-countdown'
  );
  if (fs.existsSync(lifecycleMutation) && fs.existsSync(operationLock)) {
    fs.rmSync(lifecycleMutation);
    fs.writeFileSync(path.join(root, 'src/injected.ts'), 'export const injected = true;\\n');
  } else if (fs.existsSync(checkMutation)) {
    fs.rmSync(checkMutation);
    fs.writeFileSync(path.join(root, 'src/feature.ts'), 'export const injected = true;\\n');
  } else if (fs.existsSync(allowedStatusCountdown)) {
    const remaining = Number(fs.readFileSync(allowedStatusCountdown, 'utf8'));
    if (remaining <= 1) {
      fs.rmSync(allowedStatusCountdown);
      fs.appendFileSync(
        path.join(root, 'src/feature.ts'),
        'export const postCheckDrift = true;\\n'
      );
    } else {
      fs.writeFileSync(allowedStatusCountdown, String(remaining - 1));
    }
  } else if (fs.existsSync(statusCountdown)) {
    const remaining = Number(fs.readFileSync(statusCountdown, 'utf8'));
    if (remaining <= 1) {
      fs.rmSync(statusCountdown);
      fs.appendFileSync(path.join(changeRoot, 'proposal.md'), '\\nPost-stage mutation.\\n');
    } else {
      fs.writeFileSync(statusCountdown, String(remaining - 1));
    }
  }
  const packageArtifacts = [
    ['proposal', 'proposal.md', [path.join(changeRoot, 'proposal.md')]],
    ['design', 'design.md', [path.join(changeRoot, 'design.md')]],
    ['specs', 'specs/**/*.md', [path.join(changeRoot, 'specs/demo/spec.md')]],
    ['tasks', 'tasks.md', [path.join(changeRoot, 'tasks.md')]]
  ];
  const currentArtifacts = [
    ['investigation', 'investigation.json', [path.join(changeRoot, 'investigation.json')]],
    ['proposal', 'proposal.md', [path.join(changeRoot, 'proposal.md')]],
    ['specs', 'specs/**/*.md', [path.join(changeRoot, 'specs/demo/spec.md')]],
    ['design', 'design.md', [path.join(changeRoot, 'design.md')]],
    ['tasks', 'tasks.md', [path.join(changeRoot, 'tasks.md')]],
    ['guard', 'guard.json', [path.join(changeRoot, 'guard.json')]],
    ['execution', 'execution.json', [path.join(changeRoot, 'execution.json')]],
    ['plan-review', 'plan-review.json', [path.join(changeRoot, 'plan-review.json')]]
  ];
  const currentSchema = configuredCurrentSchemaName(root);
  const usesCurrentGraph = schemaName === currentSchema;
  const artifacts = usesCurrentGraph
    ? currentArtifacts
    : packageArtifacts;
  const dependencies = usesCurrentGraph
    ? {
        investigation: [],
        proposal: ['investigation'],
        specs: ['proposal'],
        design: ['proposal'],
        tasks: ['specs', 'design'],
        guard: ['tasks'],
        execution: ['tasks'],
        'plan-review': ['guard', 'execution']
      }
    : {
        proposal: [],
        design: [],
        specs: [],
        tasks: [],
      };
  const done = Object.fromEntries(artifacts.map(([id, , existingOutputPaths]) => [
    id,
    existingOutputPaths.some((candidate) => fs.existsSync(candidate))
  ]));
  const statuses = artifacts.map(([id, outputPath]) => {
    const missingDeps = dependencies[id].filter((dependency) => !done[dependency]);
    return {
      id,
      outputPath,
      status: done[id] ? 'done' : missingDeps.length === 0 ? 'ready' : 'blocked',
      ...(missingDeps.length === 0 ? {} : { missingDeps })
    };
  });
  process.stdout.write(JSON.stringify({
    changeName: changeId,
    schemaName,
    changeRoot,
    planningHome: {
      kind: 'repo', root,
      changesDir: path.join(root, 'openspec/changes'),
      defaultSchema: 'spec-driven'
    },
    artifactPaths: Object.fromEntries(artifacts.map(([id, outputPath, existingOutputPaths]) => [
      id,
      {
        outputPath,
        resolvedOutputPath: path.join(changeRoot, outputPath),
        existingOutputPaths: existingOutputPaths.filter((candidate) =>
          fs.existsSync(candidate)
        )
      }
    ])),
    artifacts: statuses,
    applyRequires: usesCurrentGraph
      ? ['investigation', 'tasks', 'guard', 'execution', 'plan-review']
      : ['tasks'],
    isComplete: statuses.every(({ status }) => status === 'done'),
    root: { path: root, source: 'nearest' }
  }));
  process.exit(0);
}
if (process.argv[2] === 'archive') {
  const changeId = process.argv[3];
  const expected = ['archive', changeId, '--yes', '--json'];
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expected)) {
    process.stderr.write('unexpected archive argv');
    process.exit(2);
  }
  const root = process.cwd();
  const changeRoot = path.join(root, 'openspec/changes', changeId);
  const deltaRoot = path.join(changeRoot, 'specs');
  const marker = fs.readdirSync(deltaRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => fs.readFileSync(path.join(deltaRoot, entry.name, 'spec.md'), 'utf8'))
    .join('\\n');
  if (marker.includes('PARTIAL_FAILURE')) {
    process.stdout.write(JSON.stringify({
      archive: null,
      root: { path: root, source: 'nearest' },
      status: [{ code: 'archive_spec_update_failed' }]
    }));
    process.exit(1);
  }
  const applied = applyFixtureArchiveSpecs(root, changeId);
  const archiveName = new Date().toISOString().slice(0, 10) + '-' + changeId;
  const archivePath = path.join(root, 'openspec/changes/archive', archiveName);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.renameSync(changeRoot, archivePath);
  if (marker.includes('ARCHIVE_UNEXPECTED')) {
    fs.writeFileSync(path.join(root, 'unexpected.txt'), 'unexpected\\n');
  }
  process.stdout.write(JSON.stringify({
    archive: {
      change: changeId,
      archivedAs: archiveName,
      path: marker.includes('ARCHIVE_ESCAPE')
        ? path.join(root, '..', 'escape')
        : archivePath,
      specsUpdated: true,
      totals: applied.totals
    },
    root: { path: root, source: 'nearest' }
  }));
  process.exit(0);
}
if (process.argv[2] === 'validate' && process.argv.includes('--specs')) {
  const specsRoot = path.join(process.cwd(), 'openspec/specs');
  const ids = fs.existsSync(specsRoot)
    ? fs.readdirSync(specsRoot).filter((id) => {
        const spec = path.join(specsRoot, id, 'spec.md');
        return fs.existsSync(spec) && fs.statSync(spec).isFile();
      }).sort()
    : [];
  const items = ids.map((id) => ({
    id, type: 'spec', valid: true, issues: [], durationMs: 1
  }));
  process.stdout.write(JSON.stringify({
    items,
    summary: {
      totals: { items: items.length, passed: items.length, failed: 0 },
      byType: { spec: { items: items.length, passed: items.length, failed: 0 } }
    },
    version: '1.0',
    root: { path: process.cwd(), source: 'nearest' }
  }));
  process.exit(0);
}
const changeId = process.argv[3];
const changeRoot = path.join(process.cwd(), 'openspec/changes', changeId);
const invalid = fs.readFileSync(path.join(changeRoot, 'proposal.md'), 'utf8')
  .includes('INVALID');
const passed = invalid ? 0 : 1;
const failed = invalid ? 1 : 0;
process.stdout.write(JSON.stringify({
  items: [{
    id: changeId,
    type: 'change',
    valid: !invalid,
    issues: invalid
      ? [{ level: 'ERROR', path: 'proposal.md', message: 'invalid fixture' }]
      : [],
    durationMs: 1
  }],
  summary: {
    totals: { items: 1, passed, failed },
    byType: { change: { items: 1, passed, failed } }
  },
  version: '1.0',
  root: { path: process.cwd(), source: 'nearest' }
}));
process.exitCode = invalid ? 1 : 0;
`,
  );
  fs.copyFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/test/fixtures/openspec-assets/fake-openspec.mjs',
    ),
    path.join(packageDirectory, 'bin/openspec-asset-init.mjs'),
  );
  fs.writeFileSync(
    path.join(packageDirectory, 'bin/runtime-helper.js'),
    'export const fixtureRuntime = true;\n',
  );
  fs.copyFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/test/fixtures/fake-openspec-archive.mjs',
    ),
    path.join(packageDirectory, 'bin/archive-helper.js'),
  );
}
