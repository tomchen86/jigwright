import { loadChangeContract as productionChangeContractReader } from '../src/composition-root/consumer-contract-production.ts';
const loadValidatedChangeContractWithReader =
  loadValidatedChangeContractWithReaderWithContractReader.bind(
    undefined,
    productionChangeContractReader,
  );
import { productionPlanningAssurance } from '../src/composition-root/planning-assurance-production.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  parsePlanningProviderBinding,
  planningProviderBindingDigest,
  renderPlanningProviderBinding,
  type PlanningProviderBindingV1,
} from '../src/modules/planning-provider/planning-provider-binding.ts';
import {
  evaluatePlanningProvider,
  type PlanningProviderChangeResult,
  type PlanningProviderPort,
} from '../src/modules/planning-provider/planning-provider-port.ts';
import { loadValidatedChangeContract as loadValidatedChangeContractWithReaderWithContractReader } from '../src/adapters/planning/openspec/documents/managed-change-contract.ts';
import { createOpenSpecPlanningProviderPort } from '../src/composition-root/openspec-planning-provider-production.ts';
import { repositoryPlanningPolicy } from '../src/runtime/repository-observation/workflow-configuration.ts';
import { parseValidation } from '../src/adapters/planning/openspec/documents/openspec-payloads.ts';
import { resolveCurrentOpenSpecProviderBinding } from '../src/adapters/planning/openspec/documents/openspec-provider-binding.ts';
import { planningProviderBindingReader } from '../src/runtime/repository-transaction/planning-provider-binding-store.ts';
import { sealInvestigationManifestDraft } from '../src/modules/investigation/manifest/investigation-manifest.ts';
import { buildInvestigationManifestDraft } from '../src/composition-root/investigation-production.ts';
import { type InvestigationManifestV3 } from '../src/modules/investigation/manifest/investigation-manifest-types.ts';
import { investigationManifestPublicationNamespace } from '../src/modules/investigation/manifest/investigation-publication-contracts.ts';
import {
  createFixtureRepository,
  git,
  ordinaryPlanReviewReplayPortForTest,
  sourceRepositoryRoot,
  writeReadyV3ExemptChange,
} from './fixture.ts';

const CHANGE_ID = 'fixture-managed-change';

function loadValidatedChangeContract(
  repositoryRoot: string,
  changeId: string,
  planningProvider: PlanningProviderPort = createOpenSpecPlanningProviderPort(
    repositoryRoot,
    repositoryPlanningPolicy(repositoryRoot),
  ),
) {
  return loadValidatedChangeContractWithReader(
    repositoryRoot,
    changeId,
    planningProviderBindingReader,
    ordinaryPlanReviewReplayPortForTest,
    planningProvider,
    productionPlanningAssurance,
  );
}

test('core consumes a fake planning-provider port and rejects contradictory evidence', () => {
  const change: PlanningProviderChangeResult = Object.freeze({
    readiness: 'ready',
    blockers: [],
    valid: true,
    diagnostics: [],
    validationDigest: 'b'.repeat(64),
  });
  let validationCalls = 0;
  const fake: PlanningProviderPort = {
    id: 'fixture-provider',
    contractVersion: 7,
    inspectInstallation: () => ({
      providerId: 'fixture-provider',
      adapterContractVersion: 7,
      providerVersion: '1.0.0',
      installationDigest: 'a'.repeat(64),
    }),
    validateChange: () => {
      validationCalls += 1;
      return change;
    },
    inspectChange: () => change,
  };
  const context = {
    repositoryRoot: '/fixture/repository',
    planningRoot: 'fixture/changes/demo-change',
    changeId: 'demo-change',
    contractName: 'fixture-contract',
    revision: { kind: 'worktree' as const },
    readOnly: true as const,
  };

  const evaluation = evaluatePlanningProvider(fake, context);
  assert.match(evaluation.evaluationDigest, /^[0-9a-f]{64}$/u);
  assert.ok(Object.isFrozen(evaluation.installation));
  assert.ok(Object.isFrozen(evaluation.change));
  assert.ok(Object.isFrozen(evaluation.change.diagnostics));
  assert.equal(validationCalls, 1);
  assert.throws(
    () =>
      evaluatePlanningProvider(
        {
          ...fake,
          inspectInstallation: () => ({
            providerId: 'other-provider',
            adapterContractVersion: 7,
            providerVersion: '1.0.0',
            installationDigest: 'a'.repeat(64),
          }),
        },
        context,
      ),
    (error) => isWorkflowError(error, 'PLANNING_PROVIDER_CONTRACT_INVALID'),
  );
  assert.throws(
    () =>
      evaluatePlanningProvider(
        { ...fake, inspectInstallation: () => null as never },
        context,
      ),
    (error) => isWorkflowError(error, 'PLANNING_PROVIDER_CONTRACT_INVALID'),
  );
  assert.throws(
    () =>
      evaluatePlanningProvider(
        {
          ...fake,
          inspectChange: () => ({
            ...change,
            readiness: 'blocked',
          }),
        },
        context,
      ),
    (error) => isWorkflowError(error, 'PLANNING_PROVIDER_CONTRACT_INVALID'),
  );
  assert.throws(
    () =>
      evaluatePlanningProvider(
        {
          ...fake,
          validateChange: () => ({
            ...change,
            validationDigest: 'c'.repeat(64),
          }),
        },
        context,
      ),
    (error) => isWorkflowError(error, 'PLANNING_PROVIDER_CONTRACT_INVALID'),
  );

  for (const invalidChange of [
    {
      ...change,
      readiness: 'blocked' as const,
      blockers: [
        { artifactId: 'task', status: 'blocked', missingDependencies: [] },
        { artifactId: 'task', status: 'blocked', missingDependencies: [] },
      ],
    },
    {
      ...change,
      readiness: 'blocked' as const,
      blockers: [
        {
          artifactId: 'task',
          status: 'blocked',
          missingDependencies: ['z', 'a'],
        },
      ],
    },
    {
      ...change,
      readiness: 'blocked' as const,
      blockers: [
        {
          artifactId: 'task',
          status: 'blocked',
          missingDependencies: ['a', 'a'],
        },
      ],
    },
    {
      ...change,
      diagnostics: [
        { level: 'ERROR' as const, path: 'proposal.md', message: 'invalid' },
      ],
    },
    { ...change, executable: '/tmp/provider' },
    {
      ...change,
      diagnostics: [
        {
          level: 'INFO' as const,
          path: 7,
          message: 'invalid',
          argv: ['unsafe'],
        },
      ],
    },
    null,
  ]) {
    assert.throws(
      () =>
        evaluatePlanningProvider(
          { ...fake, inspectChange: () => invalidChange as never },
          context,
        ),
      (error) => isWorkflowError(error, 'PLANNING_PROVIDER_CONTRACT_INVALID'),
    );
  }
});

test('planning-provider binding is canonical and plane-specific', () => {
  const binding: PlanningProviderBindingV1 = {
    schemaVersion: 1,
    changeId: CHANGE_ID,
    providerId: 'openspec',
    adapterContractVersion: 1,
    providerRequirement: {
      package: '@fission-ai/openspec',
      version: '1.6.0',
    },
    planningRoot: `openspec/changes/${CHANGE_ID}`,
  };
  const source = renderPlanningProviderBinding(binding);
  assert.deepEqual(parsePlanningProviderBinding(source, CHANGE_ID), binding);
  assert.match(planningProviderBindingDigest(binding), /^[0-9a-f]{64}$/u);

  assert.throws(
    () =>
      parsePlanningProviderBinding(
        source.replace('"schemaVersion": 1', '"schemaVersion": 2'),
        CHANGE_ID,
      ),
    (error) => isWorkflowError(error, 'PROVIDER_BINDING_VERSION_UNSUPPORTED'),
  );
  assert.throws(
    () => parsePlanningProviderBinding(`${source.trimEnd()} \n`, CHANGE_ID),
    (error) => isWorkflowError(error, 'PROVIDER_BINDING_INVALID'),
  );
  assert.throws(
    () =>
      parsePlanningProviderBinding(
        renderPlanningProviderBinding({
          ...binding,
          planningRoot: '../escape',
        }),
        CHANGE_ID,
      ),
    (error) => isWorkflowError(error, 'PROVIDER_BINDING_INVALID'),
  );
});

test('validated managed contract consumes the caller-composed planning-provider port', () => {
  const repository = createManagedRepository();
  let installationCalls = 0;
  let validationCalls = 0;
  let inspectionCalls = 0;
  const rejected = Object.freeze({
    id: 'openspec',
    contractVersion: 1,
    inspectInstallation: () => {
      installationCalls += 1;
      return {
        providerId: 'openspec',
        adapterContractVersion: 1,
        providerVersion: '1.6.0',
        installationDigest: 'a'.repeat(64),
      };
    },
    validateChange: () => {
      validationCalls += 1;
      return rejectedChangeResult();
    },
    inspectChange: () => {
      inspectionCalls += 1;
      return rejectedChangeResult();
    },
  }) satisfies PlanningProviderPort;
  try {
    assert.throws(
      () => loadValidatedChangeContract(repository, CHANGE_ID, rejected),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_INVALID'),
    );
    assert.throws(
      () =>
        loadValidatedChangeContract(repository, CHANGE_ID, {
          ...rejected,
          id: 'other-provider',
        }),
      (error) => isWorkflowError(error, 'PLANNING_PROVIDER_BINDING_MISMATCH'),
    );
    assert.equal(installationCalls, 1);
    assert.equal(validationCalls, 1);
    assert.equal(inspectionCalls, 1);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed validation re-observes through the required live reader after provider evaluation', () => {
  const repository = createManagedRepository();
  const changed = new Error('second live observation failed');
  const observations: string[] = [];
  try {
    assert.throws(
      () =>
        loadValidatedChangeContractWithReaderWithContractReader(
          (...args) => {
            observations.push(args[1]);
            if (observations.length === 2) throw changed;
            return productionChangeContractReader(...args);
          },
          repository,
          CHANGE_ID,
          planningProviderBindingReader,
          ordinaryPlanReviewReplayPortForTest,
          createOpenSpecPlanningProviderPort(
            repository,
            repositoryPlanningPolicy(repository),
          ),
          productionPlanningAssurance,
        ),
      (error) => error === changed,
    );
    assert.deepEqual(observations, [CHANGE_ID, CHANGE_ID]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('planning-provider readers reject unsafe current binding files', () => {
  for (const mutate of [
    (repository: string, bindingPath: string) =>
      fs.chmodSync(bindingPath, 0o755),
    (repository: string, bindingPath: string) => {
      const target = path.join(repository, 'binding-target.json');
      fs.renameSync(bindingPath, target);
      fs.symlinkSync(target, bindingPath);
    },
    (repository: string, bindingPath: string) => {
      fs.linkSync(bindingPath, path.join(repository, 'binding-alias.json'));
    },
  ]) {
    const repository = createManagedRepository();
    try {
      const bindingPath = path.join(
        repository,
        `workflow/change-providers/${CHANGE_ID}.json`,
      );
      mutate(repository, bindingPath);
      assert.throws(
        () =>
          resolveCurrentOpenSpecProviderBinding(
            planningProviderBindingReader,
            repository,
            'openspec/changes',
            CHANGE_ID,
          ),
        (error) => isWorkflowError(error, 'PROVIDER_BINDING_INVALID'),
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('validated managed contract binds OpenSpec readiness to a full mode-aware snapshot', () => {
  const repository = createManagedRepository();
  let contract;
  try {
    contract = loadValidatedChangeContract(repository, CHANGE_ID);
    fs.rmSync(
      path.join(repository, `workflow/change-providers/${CHANGE_ID}.json`),
    );
    assert.throws(
      () => loadValidatedChangeContract(repository, CHANGE_ID),
      (error) => isWorkflowError(error, 'PROVIDER_BINDING_MISSING'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }

  assert.equal(contract.changeId, CHANGE_ID);
  assert.equal(contract.schemaName, 'jigwright');
  assert.deepEqual(contract.openspec, {
    version: '1.6.0',
    schemaName: 'jigwright',
    statusComplete: true,
    validationValid: true,
  });
  assert.deepEqual(contract.diagnostics, []);
  assert.match(contract.contractDigest, /^[0-9a-f]{64}$/);
  assert.equal(contract.planningProvider.source, 'explicit');
  assert.equal(contract.planningProvider.binding.providerId, 'openspec');

  for (const requiredPath of [
    `openspec/changes/${CHANGE_ID}/.openspec.yaml`,
    `openspec/changes/${CHANGE_ID}/proposal.md`,
    `workflow/change-providers/${CHANGE_ID}.json`,
    'openspec/config.yaml',
    'openspec/schemas/jigwright/schema.yaml',
    'workflow/ai-adapter-policy.json',
    'workflow/checks.json',
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ]) {
    assert.match(
      contract.artifactDigests[requiredPath] ?? '',
      /^[0-9a-f]{64}$/,
    );
    assert.equal(contract.artifactModes[requiredPath], '100644');
  }
  assert.deepEqual(
    Object.keys(contract.artifactDigests),
    [...Object.keys(contract.artifactDigests)].sort(),
  );
});

test('validated managed contract rejects a non-managed schema at admission', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => loadValidatedChangeContract(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'OPENSPEC_MANAGED_SCHEMA_REQUIRED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('validated v3 readiness reads applicability from the current Manifest', () => {
  const repository = createManagedRepository();
  try {
    writeCurrentV3Investigation(repository, CHANGE_ID);
    fs.writeFileSync(path.join(repository, '.openspec-status-incomplete'), '1');

    assert.throws(
      () => loadValidatedChangeContract(repository, CHANGE_ID),
      (error) => {
        assert.ok(error instanceof WorkflowError);
        assert.equal(error.code, 'OPENSPEC_CHANGE_NOT_READY');
        assert.notEqual(
          error.details?.reason,
          'investigation-applicability-required',
        );
        return true;
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed contract rejects unsafe metadata and incomplete artifact trees before readiness is trusted', () => {
  const cases: Array<{
    name: string;
    mutate(repository: string): void;
    code: string;
  }> = [
    {
      name: 'wrong schema',
      mutate(repository) {
        fs.writeFileSync(
          changePath(repository, '.openspec.yaml'),
          'schema: spec-driven\ncreated: 2026-07-15\n',
        );
      },
      code: 'OPENSPEC_MANAGED_SCHEMA_REQUIRED',
    },
    {
      name: 'duplicate metadata',
      mutate(repository) {
        fs.appendFileSync(
          changePath(repository, '.openspec.yaml'),
          'schema: jigwright\n',
        );
      },
      code: 'OPENSPEC_CHANGE_METADATA_INVALID',
    },
    {
      name: 'empty artifact',
      mutate(repository) {
        fs.writeFileSync(changePath(repository, 'proposal.md'), ' \n\t\n');
      },
      code: 'OPENSPEC_CHANGE_ARTIFACT_EMPTY',
    },
    {
      name: 'unexpected artifact',
      mutate(repository) {
        fs.writeFileSync(changePath(repository, 'notes.txt'), 'extra\n');
      },
      code: 'PLANNING_PATHS_INVALID',
    },
    {
      name: 'executable artifact',
      mutate(repository) {
        fs.chmodSync(changePath(repository, 'proposal.md'), 0o755);
      },
      code: 'OPENSPEC_CHANGE_TREE_UNSAFE',
    },
    {
      name: 'executable metadata',
      mutate(repository) {
        fs.chmodSync(changePath(repository, '.openspec.yaml'), 0o755);
      },
      code: 'OPENSPEC_CHANGE_TREE_UNSAFE',
    },
    {
      name: 'symlink artifact',
      mutate(repository) {
        const proposalPath = changePath(repository, 'proposal.md');
        fs.rmSync(proposalPath);
        fs.symlinkSync(path.join(repository, 'package.json'), proposalPath);
      },
      code: 'OPENSPEC_CHANGE_TREE_UNSAFE',
    },
    {
      name: 'symlink metadata',
      mutate(repository) {
        const metadataPath = changePath(repository, '.openspec.yaml');
        fs.rmSync(metadataPath);
        fs.symlinkSync(path.join(repository, 'package.json'), metadataPath);
      },
      code: 'OPENSPEC_CHANGE_TREE_UNSAFE',
    },
  ];

  for (const fixture of cases) {
    const repository = createManagedRepository();
    try {
      fixture.mutate(repository);
      assert.throws(
        () => loadValidatedChangeContract(repository, CHANGE_ID),
        (error) => isWorkflowError(error, fixture.code),
        fixture.name,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('managed readiness rejects a missing guard even when tasks and provider status are complete', () => {
  const repository = createManagedRepository();
  try {
    loadValidatedChangeContract(repository, CHANGE_ID);
    const tasks = fs.readFileSync(changePath(repository, 'tasks.md'));
    fs.rmSync(changePath(repository, 'guard.json'));

    assert.throws(
      () => loadValidatedChangeContract(repository, CHANGE_ID),
      (error) => isWorkflowError(error, 'MISSING_CHANGE_ARTIFACT'),
    );
    assert.deepEqual(
      fs.readFileSync(changePath(repository, 'tasks.md')),
      tasks,
    );
    assert.equal(fs.existsSync(changePath(repository, 'guard.json')), false);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current managed tree rejects paths outside its schema grammar', () => {
  const repository = createFixtureRepository();
  try {
    writeReadyV3ExemptChange(repository);
    fs.writeFileSync(
      path.join(repository, 'openspec/changes/demo-change/notes.txt'),
      'not a managed artifact\n',
    );
    assert.throws(
      () => loadValidatedChangeContract(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'PLANNING_PATHS_INVALID'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed contract emits stable sorted diagnostics for strict OpenSpec failure', () => {
  const repository = createManagedRepository();
  try {
    fs.appendFileSync(
      changePath(repository, 'proposal.md'),
      '\nOPENSPEC_INVALID\n',
    );

    assert.throws(
      () => loadValidatedChangeContract(repository, CHANGE_ID),
      (error) => {
        assert.equal(isWorkflowError(error, 'OPENSPEC_CHANGE_INVALID'), true);
        assert.deepEqual((error as WorkflowError).details, {
          diagnostics: [
            {
              level: 'ERROR',
              path: 'proposal.md',
              message: 'invalid proposal',
              line: 2,
              column: 1,
            },
            {
              level: 'WARNING',
              path: 'specs/fixture-capability/spec.md',
              message: 'secondary diagnostic',
            },
          ],
        });
        return true;
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('managed contract rejects incomplete status and mutation across the OpenSpec boundary', () => {
  const incomplete = createManagedRepository();
  try {
    fs.writeFileSync(path.join(incomplete, '.openspec-status-incomplete'), '1');
    assert.throws(
      () => loadValidatedChangeContract(incomplete, CHANGE_ID),
      (error) => {
        assert.equal(isWorkflowError(error, 'OPENSPEC_CHANGE_NOT_READY'), true);
        assert.deepEqual((error as WorkflowError).details, {
          diagnostics: [
            {
              artifactId: 'guard',
              missingDependencies: [],
              status: 'ready',
            },
          ],
        });
        return true;
      },
    );
  } finally {
    fs.rmSync(incomplete, { recursive: true, force: true });
  }

  const mutated = createManagedRepository();
  try {
    fs.writeFileSync(path.join(mutated, '.mutate-during-status'), '1');
    assert.throws(
      () => loadValidatedChangeContract(mutated, CHANGE_ID),
      (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_STATE_CHANGED'),
    );
  } finally {
    fs.rmSync(mutated, { recursive: true, force: true });
  }
});

test('strict validation rejects unsafe diagnostics and valid/error contradictions', () => {
  for (const issue of [
    { level: 'WARNING', path: '/tmp/escape', message: 'unsafe path' },
    { level: 'WARNING', path: '../escape', message: 'unsafe path' },
    { level: 'WARNING', path: 'proposal.md', message: 'unsafe\u0085message' },
    { level: 'ERROR', path: 'proposal.md', message: 'contradiction' },
  ]) {
    assert.throws(
      () =>
        parseValidation(
          {
            items: [
              {
                id: CHANGE_ID,
                type: 'change',
                valid: true,
                issues: [issue],
                durationMs: 1,
              },
            ],
            summary: {
              totals: { items: 1, passed: 1, failed: 0 },
              byType: { change: { items: 1, passed: 1, failed: 0 } },
            },
            version: '1.0',
            root: { path: sourceRepositoryRoot, source: 'nearest' },
          },
          {
            repositoryRoot: sourceRepositoryRoot,
            expectedType: 'change',
            expectedId: CHANGE_ID,
          },
        ),
      (error) => isWorkflowError(error, 'OPENSPEC_PAYLOAD_INVALID'),
    );
  }
});

function rejectedChangeResult(): PlanningProviderChangeResult {
  return Object.freeze({
    readiness: 'ready',
    blockers: Object.freeze([]),
    valid: false,
    diagnostics: Object.freeze([
      Object.freeze({
        level: 'ERROR' as const,
        path: 'proposal.md',
        message: 'Rejected by the caller-composed planning provider.',
      }),
    ]),
    validationDigest: 'b'.repeat(64),
  });
}

function createManagedRepository(): string {
  const repository = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'managed-change-contract-')),
  );
  for (const filePath of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
  ]) {
    copy(filePath, repository);
  }
  fs.cpSync(
    path.join(sourceRepositoryRoot, 'workflow'),
    path.join(repository, 'workflow'),
    { recursive: true },
  );
  fs.mkdirSync(path.join(repository, 'openspec'), { recursive: true });
  copy('openspec/config.yaml', repository);
  fs.cpSync(
    path.join(sourceRepositoryRoot, 'openspec/schemas/jigwright'),
    path.join(repository, 'openspec/schemas/jigwright'),
    { recursive: true },
  );
  writeSyntheticChange(repository);
  const bindingDirectory = path.join(repository, 'workflow/change-providers');
  fs.mkdirSync(bindingDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(bindingDirectory, `${CHANGE_ID}.json`),
    renderPlanningProviderBinding({
      schemaVersion: 1,
      changeId: CHANGE_ID,
      providerId: 'openspec',
      adapterContractVersion: 1,
      providerRequirement: {
        package: '@fission-ai/openspec',
        version: '1.6.0',
      },
      planningRoot: `openspec/changes/${CHANGE_ID}`,
    }),
  );
  installFakeOpenSpec(repository);
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'workflow@example.test']);
  git(repository, ['config', 'user.name', 'Workflow Test']);
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Create managed fixture baseline']);
  writeReadyV3ExemptChange(repository, CHANGE_ID);
  return repository;
}

function installFakeOpenSpec(repository: string): void {
  const packageDirectory = path.join(
    repository,
    'node_modules/@fission-ai/openspec',
  );
  fs.mkdirSync(path.join(packageDirectory, 'bin'), { recursive: true });
  fs.cpSync(
    path.join(
      fs.realpathSync(
        path.join(sourceRepositoryRoot, 'node_modules/@fission-ai/openspec'),
      ),
      'schemas/spec-driven',
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
    fakeOpenSpecSource(),
  );
  fs.chmodSync(path.join(packageDirectory, 'bin/openspec.js'), 0o755);
}

function fakeOpenSpecSource(): string {
  return `import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const root = process.cwd();
if (args[0] === '--version') {
  process.stdout.write('1.6.0\\n');
  process.exit(0);
}
if (args[0] === 'schema') {
  const operation = args[1];
  const schemaName = args[2];
  const packageRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
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
    : { name: schemaName, path: schemaPath, valid: true, issues: [] }));
  process.exit(0);
}
if (args[0] === 'status') {
  const changeId = args[args.indexOf('--change') + 1];
  const schemaName = args[args.indexOf('--schema') + 1];
  const changeRoot = path.join(root, 'openspec/changes', changeId);
  const mutatePath = path.join(root, '.mutate-during-status');
  if (fs.existsSync(mutatePath)) {
    fs.rmSync(mutatePath);
    fs.appendFileSync(path.join(changeRoot, 'proposal.md'), '\\nMutation during status.\\n');
  }
  const incomplete = fs.existsSync(path.join(root, '.openspec-status-incomplete'));
  const specPaths = fs.readdirSync(path.join(changeRoot, 'specs'), { recursive: true })
    .filter((entry) => String(entry).endsWith('spec.md'))
    .map((entry) => path.join(changeRoot, 'specs', String(entry)))
    .sort();
  const currentArtifacts = [
    ['investigation', 'investigation.json', [path.join(changeRoot, 'investigation.json')], 'done'],
    ['proposal', 'proposal.md', [path.join(changeRoot, 'proposal.md')], 'done'],
    ['specs', 'specs/**/*.md', specPaths, 'done'],
    ['design', 'design.md', [path.join(changeRoot, 'design.md')], 'done'],
    ['tasks', 'tasks.md', [path.join(changeRoot, 'tasks.md')], 'done'],
    ['guard', 'guard.json', incomplete ? [] : [path.join(changeRoot, 'guard.json')], incomplete ? 'ready' : 'done'],
    ['execution', 'execution.json', [path.join(changeRoot, 'execution.json')], 'done'],
    ['plan-review', 'plan-review.json', [path.join(changeRoot, 'plan-review.json')], 'done']
  ];
  const artifacts = currentArtifacts;
  process.stdout.write(JSON.stringify({
    changeName: changeId,
    schemaName,
    changeRoot,
    planningHome: {
      kind: 'repo', root,
      changesDir: path.join(root, 'openspec/changes'),
      defaultSchema: 'jigwright'
    },
    artifactPaths: Object.fromEntries(artifacts.map(([id, outputPath, existingOutputPaths]) => [
      id,
      { outputPath, resolvedOutputPath: path.join(changeRoot, outputPath), existingOutputPaths }
    ])),
    artifacts: artifacts.map(([id, outputPath, _paths, status]) => ({ id, outputPath, status })),
    applyRequires: ['investigation', 'tasks', 'guard', 'execution', 'plan-review'],
    isComplete: !incomplete,
    root: { path: root, source: 'nearest' }
  }));
  process.exit(0);
}
if (args[0] === 'validate') {
  const changeId = args[1];
  const proposal = fs.readFileSync(
    path.join(root, 'openspec/changes', changeId, 'proposal.md'),
    'utf8'
  );
  const invalid = proposal.includes('OPENSPEC_INVALID');
  const issues = invalid
    ? [
        {
          level: 'WARNING',
          path: 'specs/fixture-capability/spec.md',
          message: 'secondary diagnostic'
        },
        {
          level: 'ERROR',
          path: 'proposal.md',
          message: 'invalid proposal',
          line: 2,
          column: 1
        }
      ]
    : [];
  process.stdout.write(JSON.stringify({
    items: [{
      id: changeId,
      type: 'change',
      valid: !invalid,
      issues,
      durationMs: 7
    }],
    summary: {
      totals: { items: 1, passed: invalid ? 0 : 1, failed: invalid ? 1 : 0 },
      byType: {
        change: { items: 1, passed: invalid ? 0 : 1, failed: invalid ? 1 : 0 }
      }
    },
    version: '1.0',
    root: { path: root, source: 'nearest' }
  }));
  process.exitCode = invalid ? 1 : 0;
}
`;
}

function writeSyntheticChange(repository: string): void {
  const changeRoot = path.join(repository, 'openspec/changes', CHANGE_ID);
  fs.mkdirSync(path.join(changeRoot, 'specs/fixture-capability'), {
    recursive: true,
  });
  const artifacts: Array<[string, string]> = [
    ['.openspec.yaml', 'schema: jigwright\ncreated: 2026-07-19\n'],
    [
      'proposal.md',
      '## Why\n\nSynthetic fixture change for contract tests.\n\n## What Changes\n\n- Exercise the managed contract loader.\n',
    ],
    [
      'design.md',
      '## Context\n\nSynthetic design content for contract fixtures.\n',
    ],
    [
      'tasks.md',
      '## 1. Fixture\n\n- [ ] 1.1 Exercise the managed contract loader.\n',
    ],
    [
      'guard.json',
      `${JSON.stringify(
        {
          schemaVersion: 1,
          changeId: CHANGE_ID,
          tasks: {
            '1.1': {
              allowedPaths: ['package.json'],
              requiredChecks: ['workflow-tests'],
            },
          },
        },
        null,
        2,
      )}\n`,
    ],
    [
      'specs/fixture-capability/spec.md',
      '## ADDED Requirements\n\n### Requirement: Fixture capability\n\nThe fixture MUST exist.\n\n#### Scenario: Fixture loads\n\n- **WHEN** the fixture change is validated\n- **THEN** the loader accepts it\n',
    ],
    [
      'specs/demo/spec.md',
      '## ADDED Requirements\n\n### Requirement: Demo capability\n\nThe fixture MUST expose the demo capability.\n\n#### Scenario: Demo loads\n\n- **WHEN** the current fixture is validated\n- **THEN** the demo capability is present\n',
    ],
  ];
  for (const [relativePath, content] of artifacts) {
    const artifactPath = path.join(changeRoot, relativePath);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, content);
  }
}

function writeCurrentV3Investigation(
  repository: string,
  changeId: string,
): InvestigationManifestV3 {
  const baseline = {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
  const sessionSnapshotDigest = crypto
    .createHash('sha256')
    .update('managed-current-v3-session')
    .digest('hex');
  const built = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state: {
      schemaVersion: 1,
      applicabilityKind: 'exemption',
      repositoryId: 'jigwright',
      changeId,
      investigationId: `${changeId}-investigation`,
      normalizedIntent: {
        schemaVersion: 1,
        summary: 'Exercise the managed current v3 reader.',
        sourceRefs: [],
        explicitPaths: ['package.json'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      authoring: { sessionRevision: 3, sessionSnapshotDigest },
      exemption: {
        category: 'formatting-only',
        baseline,
        declaredPaths: ['package.json'],
        declaredChangeClasses: ['formatting-only'],
        rationale: 'The fixture changes formatting only.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:managed-current-v3',
        },
        nonTrivialBehaviorReliance: 'none-declared',
        researchBudgetMinutes: null,
      },
    },
  });
  if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
  const sealed = sealInvestigationManifestDraft({
    draft: built.draft,
    approval: {
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:managed-current-v3-approval',
      },
      approvalProvenanceDigest: crypto
        .createHash('sha256')
        .update('managed-current-v3-approval')
        .digest('hex'),
    },
  });
  if (sealed.outcome !== 'sealed') assert.fail(sealed.blocker.failureCode);
  fs.writeFileSync(
    changePath(repository, 'investigation.json'),
    `${canonicalJson(sealed.manifest)}\n`,
  );
  writeCurrentV3Ref(repository, sealed.manifest);
  return sealed.manifest;
}

function writeCurrentV3Ref(
  repository: string,
  manifest: InvestigationManifestV3,
): void {
  const lifecycle = {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
  };
  const commonValue = git(repository, ['rev-parse', '--git-common-dir']).trim();
  const privateRoot = fs.realpathSync(
    path.isAbsolute(commonValue)
      ? commonValue
      : path.resolve(repository, commonValue),
  );
  const config = JSON.parse(
    fs.readFileSync(path.join(repository, 'workflow/config.json'), 'utf8'),
  ) as { runtimeDirectory: string };
  const refPath = path.join(
    privateRoot,
    config.runtimeDirectory,
    investigationManifestPublicationNamespace(lifecycle),
    'current.json',
  );
  fs.mkdirSync(path.dirname(refPath), { recursive: true });
  fs.writeFileSync(
    refPath,
    `${canonicalJson({
      schemaVersion: 1,
      kind: 'investigation-manifest-current',
      ...lifecycle,
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest:
        manifest.investigationApproval.investigationTargetDigest,
      manifestPath: `openspec/changes/${manifest.changeId}/investigation.json`,
    })}\n`,
  );
}

function copy(relativePath: string, repository: string): void {
  const target = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(sourceRepositoryRoot, relativePath), target);
}

function changePath(repository: string, relativePath: string): string {
  return path.join(repository, 'openspec/changes', CHANGE_ID, relativePath);
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
