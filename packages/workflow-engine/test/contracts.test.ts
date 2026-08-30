import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import * as repositoryContracts from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  assertDisposableDatabase,
  createCheckEnvironment,
} from '../src/adapters/consumer/repository/work-registry/database-policy.ts';
import {
  loadChangeContract,
  loadWorkflowConfig,
  parseExecutionArtifact,
  parseHistoricalInvestigationArtifact,
  parsePlanReviewArtifact,
  parseTasks,
  workflowNamespaceConfig,
} from '../src/adapters/consumer/repository/work-registry/contracts.ts';
import {
  createConvergenceRecord,
  createDescendantReuseProof,
} from '../src/adapters/planning/investigation/evidence-convergence.ts';
import {
  currentParentEvidenceRef,
  descendantReuseProofEvidenceRef,
} from '../src/adapters/planning/investigation/evidence-reuse-path.ts';
import { createEvidenceNode } from '../src/adapters/planning/investigation/evidence-node.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { deriveInvestigationFirstPlanningSubject } from '../src/modules/assurance/planning-assurance-validator.ts';
import {
  buildInvestigationManifestDraft,
  sealInvestigationManifestDraft,
  type InvestigationManifestV3,
} from '../src/modules/investigation/manifest/investigation-manifest.ts';
import {
  assertPolicyPathInsideRepository,
  matchesAllowedPath,
  normalizeChangedPath,
  normalizePolicyPath,
} from '../src/runtime/session-workspace/paths.ts';
import {
  investigationManifestPublicationNamespace,
  publishInvestigationManifestV3,
  readInvestigationPublicationRefState,
  resumeInvestigationManifestPublication,
  type InvestigationManifestPublicationPhase,
} from '../src/runtime/managed-documents/transaction/investigation-publication.ts';
import { workflowContractArtifactPaths } from '../src/adapters/consumer/repository/work-registry/contract-artifacts.ts';
import {
  createFixtureRepository,
  writeManagedChangeArtifacts,
} from './fixture.ts';

if (import.meta.main) await import('./contracts-legacy-family.ts');

test('the retired investigation parser alias is absent', () => {
  assert.equal('parseInvestigationArtifact' in repositoryContracts, false);
});

test('maintainer policy is a pinned workflow contract artifact', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const artifacts = workflowContractArtifactPaths(repositoryRoot).map(
    (artifact) => path.relative(repositoryRoot, artifact),
  );

  assert.ok(artifacts.includes('workflow/maintainer-policy.json'));
  assert.ok(
    artifacts.includes('workflow/schemas/maintainer-policy.schema.json'),
  );
  assert.ok(
    artifacts.includes('workflow/schemas/maintainer-grant.schema.json'),
  );
  assert.ok(
    artifacts.includes('workflow/schemas/authority-attestation.schema.json'),
  );
  assert.ok(artifacts.includes('workflow/path-roles.json'));
  assert.ok(artifacts.includes('workflow/grant-policy.json'));
  assert.ok(artifacts.includes('workflow/schemas/grant-policy.schema.json'));
});

test('retired documentation closure activation is absent from current contract artifacts', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const marker = path.join(
    repositoryRoot,
    'workflow/schemas/documentation-closure-v1.schema.json',
  );

  assert.equal(fs.existsSync(marker), false);
  assert.equal(
    workflowContractArtifactPaths(repositoryRoot).includes(marker),
    false,
  );
});

test('task authorization binds the one reviewed path-role registry artifact', () => {
  const repository = createFixtureRepository();
  try {
    const configPath = path.join(repository, 'workflow/config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      taskAuthorization: { pathRoleRegistry: string };
    };
    config.taskAuthorization.pathRoleRegistry = 'workflow/other-roles.json';
    fs.copyFileSync(
      path.join(repository, 'workflow/path-roles.json'),
      path.join(repository, 'workflow/other-roles.json'),
    );
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    assert.throws(
      () => loadWorkflowConfig(repository),
      (error) =>
        error instanceof WorkflowError &&
        error.code === 'INVALID_WORKFLOW_CONFIG',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('workflow namespace is current-only and consumer-configured', () => {
  const repository = createFixtureRepository();
  try {
    const fallback = workflowNamespaceConfig(loadWorkflowConfig(repository));
    assert.deepEqual(fallback, {
      schemaVersion: 1,
      consumerNamespace: 'fixture',
    });

    const configPath = path.join(repository, 'workflow/config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<
      string,
      unknown
    >;
    config.consumerNamespace = 'sample-consumer';
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    const explicit = workflowNamespaceConfig(loadWorkflowConfig(repository));
    assert.deepEqual(explicit, {
      schemaVersion: 1,
      consumerNamespace: 'sample-consumer',
    });

    config.acceptedLegacySchemaPrefixes = [];
    fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
    assert.throws(() => loadWorkflowConfig(repository));
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('runner security suite is portable to the package working directory', () => {
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--test',
      'test/runner-package-security.integration.test.ts',
    ],
    {
      cwd: path.resolve(import.meta.dirname, '..'),
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) => name !== 'NODE_TEST_CONTEXT',
        ),
      ),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
});

test('format verification delegates to the registered canonical authority', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'),
  );
  assert.equal(
    manifest.scripts['format:check'],
    'pnpm workflow run-check workflow-format --json',
  );

  const formatWorkflow = fs.readFileSync(
    path.join(repositoryRoot, '.github/workflows/format.yml'),
    'utf8',
  );
  assert.match(formatWorkflow, /run: pnpm run format:check/);
  assert.doesNotMatch(formatWorkflow, /prettier\s+--check/);

  const checks = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'workflow/checks.json'), 'utf8'),
  );
  const registeredFormat = checks.checks['workflow-format'];
  const assetSeparatedFormatCommand = [
    'node-package-bin',
    '.',
    'prettier',
    'prettier',
    '--check',
    '--ignore-unknown',
    'packages/workflow-engine',
    'workflow/ai-adapter-policy.json',
    'workflow/checks.json',
    'workflow/config.json',
    'workflow/document-policy.json',
    'workflow/maintainer-policy.json',
    'workflow/path-roles.json',
    'workflow/schemas',
    'scripts/check-openspec.mjs',
    'openspec/config.yaml',
    'package.json',
    'pnpm-workspace.yaml',
    'AGENTS.md',
    'README.md',
    'docs/README.md',
    'docs/WORKFLOW.md',
    'docs/ROADMAP.md',
    'docs/architecture/ARCHITECTURE.md',
    '.github/CODEOWNERS',
    '.github/workflows/format.yml',
    '.github/workflows/workflow-assurance.yml',
    'prettier.config.cjs',
  ];
  assert.equal(registeredFormat?.destructiveDatabase, false);
  assert.deepEqual(registeredFormat?.command, assetSeparatedFormatCommand);
  const config = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'workflow/config.json'), 'utf8'),
  );
  assert.deepEqual(config.allTasksTerminalChecks, [
    {
      checkId: 'workflow-full-gate',
      subsumes: ['workflow-tests'],
    },
  ]);
  assert.deepEqual(config.taskAuthorization, {
    pathRoleRegistry: 'workflow/path-roles.json',
    mandateRequiredRoles: [
      'contract-surface',
      'control-plane',
      'grant',
      'lifecycle',
      'policy',
      'verification-infrastructure',
    ],
  });
  assert.deepEqual(checks.checks['workflow-full-gate'], {
    command: [
      'node',
      '--experimental-strip-types',
      'scripts/workflow-full-gate.ts',
    ],
    destructiveDatabase: false,
    liveStderr: true,
  });
});

test('repository exposes only reviewed planning and workflow routing skills', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const agentSkillsRoot = path.join(repositoryRoot, '.agents/skills');
  const skillNames = fs
    .readdirSync(agentSkillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillNames, [
    'openspec-explore',
    'openspec-propose',
    'workflow-engine',
  ]);
  for (const skillName of skillNames) {
    const agentSkill = fs.readFileSync(
      path.join(agentSkillsRoot, skillName, 'SKILL.md'),
      'utf8',
    );
    const canonicalSkill = fs.readFileSync(
      path.join(repositoryRoot, '.codex/skills', skillName, 'SKILL.md'),
      'utf8',
    );
    assert.equal(agentSkill, canonicalSkill, `${skillName} mirror drifted`);
  }

  const nestedSpectraMetadata = fs
    .readdirSync(path.join(repositoryRoot, 'openspec'), { recursive: true })
    .filter((entry) => path.basename(entry.toString()) === '.spectra.yaml');
  assert.deepEqual(nestedSpectraMetadata, []);

  const agents = fs.readFileSync(
    path.join(repositoryRoot, 'AGENTS.md'),
    'utf8',
  );
  const maintenance = fs.readFileSync(
    path.join(repositoryRoot, '.agents/README.md'),
    'utf8',
  );
  const roadmap = fs.readFileSync(
    path.join(repositoryRoot, 'docs/ROADMAP.md'),
    'utf8',
  );
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, 'docs/WORKFLOW.md'),
    'utf8',
  );
  assert.doesNotMatch(agents, /spectra/i);
  assert.match(agents, /`openspec-explore`/);
  assert.match(agents, /`openspec-propose`/);
  assert.match(agents, /`workflow-engine`/);
  const workflowEngineSkill = fs.readFileSync(
    path.join(agentSkillsRoot, 'workflow-engine', 'SKILL.md'),
    'utf8',
  );
  for (const command of [
    'pnpm workflow guide',
    'pnpm workflow open-task',
    'pnpm workflow status',
    'pnpm workflow resume',
    'pnpm workflow review-diff',
    'pnpm workflow finalize',
    'pnpm workflow archive',
  ]) {
    assert.match(
      workflowEngineSkill,
      new RegExp(command.replaceAll(' ', '\\s+')),
    );
  }
  assert.match(workflowEngineSkill, /does not authorize/i);
  assert.doesNotMatch(workflowEngineSkill, /pnpm workflow maintainer/);
  assert.doesNotMatch(workflowEngineSkill, /git (?:add|commit|push)/);
  for (const skillName of skillNames) {
    assert.match(workflow, new RegExp('`' + skillName + '`'));
  }
  for (const frictionField of [
    'provider wait count/rate',
    'collaboration-grant count/rate',
    'provider latency',
    'direct human review/action count',
  ]) {
    assert.match(workflow, new RegExp(frictionField.replaceAll(' ', '\\s+')));
  }
  assert.match(maintenance, /^# Repository skill mirror maintenance/m);
  assert.doesNotMatch(maintenance, /spectra update/i);
  assert.doesNotMatch(roadmap, /spectra/i);
});

test('agent guide documents the complete public workflow surface and source-size rule', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const agents = fs.readFileSync(
    path.join(repositoryRoot, 'AGENTS.md'),
    'utf8',
  );
  const commands = [
    'pnpm workflow doctor',
    'pnpm workflow validate-change',
    'pnpm workflow plan-commit',
    'pnpm workflow run-check',
    'pnpm workflow archive',
    'pnpm workflow openspec-assets generate',
    'pnpm workflow openspec-assets check',
    'pnpm workflow openspec-assets install-prompts',
    'pnpm workflow open-task',
    'pnpm workflow finalize',
    'pnpm workflow start',
    'pnpm workflow status',
    'pnpm workflow check',
    'pnpm workflow ci',
    'pnpm workflow adapter evaluate',
    'pnpm workflow adapter availability-pilot',
    'pnpm workflow adapter verify-availability-pilot',
    'pnpm workflow issue add',
    'pnpm workflow issue update',
    'pnpm workflow issue close',
    'pnpm workflow issue render',
    'pnpm workflow issue validate',
    'pnpm workflow maintainer grant',
    'pnpm workflow maintainer inspect',
    'pnpm workflow grant revoke',
    'pnpm workflow documents validate',
    'pnpm workflow document-refresh propose',
    'pnpm workflow document-refresh show',
    'pnpm workflow document-refresh review',
    'pnpm workflow document-refresh apply',
    'pnpm workflow handoff validate',
    'pnpm workflow hook pre-commit',
    'pnpm workflow hook commit-msg',
    'pnpm workflow hook pre-push',
    'pnpm workflow hook post-merge',
    'pnpm workflow complete-task',
    'pnpm workflow finish',
    'pnpm workflow rollback-completion',
    'pnpm workflow commit',
    'pnpm workflow abort',
  ];

  for (const command of commands) {
    assert.match(agents, new RegExp(command.replaceAll(' ', '\\s+')));
  }
  assert.match(
    agents,
    /Legacy V1 issuance[\s\S]{0,160}public authority-session commands[\s\S]{0,160}entrypoints are absent[\s\S]{0,160}inspection parsers[\s\S]{0,40}cannot authorize[\s\S]{0,20}new[\s\S]{0,5}work/i,
  );
  assert.doesNotMatch(agents, /pnpm workflow handoff render/);
  assert.match(
    agents,
    /Do not change, split, or refactor source\s+solely because it exceeds 500 lines\./,
  );
  assert.doesNotMatch(agents, /keep files under 500 LOC/i);
});

test('public guidance exposes the investigation-first and repeated managed-task lifecycle', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const agents = fs.readFileSync(
    path.join(repositoryRoot, 'AGENTS.md'),
    'utf8',
  );
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, 'docs/WORKFLOW.md'),
    'utf8',
  );
  const roadmap = fs.readFileSync(
    path.join(repositoryRoot, 'docs/ROADMAP.md'),
    'utf8',
  );

  for (const surface of [agents, workflow]) {
    assert.match(surface, /pnpm workflow propose/);
    assert.match(surface, /pnpm workflow open-task/);
    assert.match(surface, /pnpm workflow finalize <session-id>/);
    assert.match(surface, /pnpm workflow finalize-task/);
  }
  assert.match(workflow, /propose → \[ open-task → finalize \]×N → archive/);
  assert.match(
    workflow,
    /(?:checked\s+tree[\s\S]{0,160}staged\s+tree|stages only[\s\S]{0,160}checked\s+tree)/i,
  );
  assert.match(workflow, /durable transaction[\s\S]{0,120}replay-safe/i);
  assert.match(
    workflow,
    /intermediate finalize[\s\S]{0,120}targeted[\s\S]{0,120}requiredChecks/i,
  );
  assert.match(workflow, /all-terminal[\s\S]{0,200}allTasksTerminalChecks/i);
  assert.match(
    workflow,
    /workflow-full-gate[\s\S]{0,120}covers `workflow-tests`[\s\S]{0,120}do\s+not\s+run\s+twice/i,
  );
  assert.match(workflow, /no[\s\S]{0,80}(?:defer|skip) flag/i);
  assert.match(
    workflow,
    /This finalize completes the change → running full gate\./,
  );
  for (const hint of [
    'Monitor: pnpm workflow:test:status',
    'Machine status: pnpm workflow:test:status --json',
    'Full log: <exact stdout log path>',
    'Failures: pnpm workflow:test:failures',
  ]) {
    assert.match(
      workflow,
      new RegExp(hint.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
  assert.match(
    workflow,
    /Compatibility lifecycle[\s\S]{0,240}check[\s\S]{0,120}complete-task[\s\S]{0,120}finish/i,
  );
  assert.match(
    workflow,
    /longer route[\s\S]{0,120}cannot bypass the full gate/i,
  );
  assert.match(roadmap, /current-only full gate[\s\S]{0,160}exact-tarball/i);
});

test('public guidance preserves the assurance registry and keeps exemptions distinct', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const agents = fs.readFileSync(
    path.join(repositoryRoot, 'AGENTS.md'),
    'utf8',
  );
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, 'docs/WORKFLOW.md'),
    'utf8',
  );
  const expectedClaims = [
    [
      '`C-TERM-SCAN`',
      'Every currently effective sealed term was scanned under the governed scan policy',
      'Hard',
      'T1.5 sealed-investigation branch',
    ],
    [
      '`C-TERM-SUPERSESSION`',
      'Engine-floor terms cannot be removed; an agent term leaves the effective set only by reviewed, reasoned, audit-visible supersession',
      'Hard engine floor; audit-monotone but correctable agent contribution',
      'T1.5',
    ],
    [
      '`C-TERM-COMPLETENESS`',
      'The effective term set is semantically complete',
      'Soft and not provable',
      'Residual, never delivered as hard',
    ],
    [
      '`C-REVIEW-CURRENT`',
      'A review artifact exists, is immutable, and is current for its exact target',
      'Hard',
      'T1.5',
    ],
    [
      '`C-REVIEW-JUDGMENT`',
      'The reviewer judgment is correct',
      'Soft',
      'Human/agent judgment',
    ],
    [
      '`C-WHY-BINDING`',
      'Every required WHY field exists and is bound to exact source blobs',
      'Hard structure',
      'T1.5 sealed-investigation branch',
    ],
    [
      '`C-WHY-TRUTH`',
      'The WHY explanation is true or proves understanding',
      'Soft',
      'Human/agent judgment',
    ],
    [
      '`C-ARTIFACT-ORDER`',
      'Authoritative design materialization follows sealed investigation inputs',
      'Hard artifact order; cognition order is not proved',
      'T1.5 when investigation applies; exemption is separately labeled',
    ],
    [
      '`C-SEMANTIC-INJECTION`',
      '`proposedTerms` is the only review-to-lifecycle semantic cost injection path and stays within aggregate budgets',
      'Hard structural choke point and budgets; semantic usefulness is soft',
      'T1.5',
    ],
    [
      '`C-EXACT-CLOSURE`',
      'Exact declared bytes are absent from the governed live closure scope',
      'Hard',
      'T2.4 `mechanical-transform` engine evidence on exact candidate trees',
    ],
    [
      '`C-GRAPH-COMPLETENESS`',
      'All semantic consumers and dependency edges have been found',
      'Soft and not proved by grep or declared DAG structure',
      'Residual, never delivered as hard',
    ],
    [
      '`C-CANONICALIZATION`',
      'Canonical subjects preserve every assurance-relevant distinction',
      'Tested and fail-closed; residual implementation risk remains',
      'T1.5 for planning subjects; later owners extend their subjects',
    ],
    [
      '`C-COVERAGE-COMPOSITION`',
      'Composed review manifests cover exactly the claimed subject',
      'Hard algorithm over declared facts; semantic adequacy is soft',
      'Future T2.3; not delivered by T1.5',
    ],
    [
      '`C-CONVERGENCE`',
      'A reused descendant has a complete valid proof path to the current generation',
      'Hard validator over declared graph; proof/canonicalizer defects remain residual',
      'T1.5',
    ],
    [
      '`C-PROVIDER-IDENTITY`',
      'Local provider identity from runtime hints or adapter assignment',
      'Soft',
      'T1.5 records assurance only',
    ],
    [
      '`C-CONTAINMENT`',
      'A local provider is confined against the same OS user',
      'Soft without stronger isolation',
      'Not delivered as hard',
    ],
    [
      '`C-DEGRADED-INDEPENDENCE`',
      'A collaboration grant recreates missing provider independence',
      'False; grant authorizes only visible degradation',
      'T1.5',
    ],
    [
      '`C-AVAILABILITY`',
      'The ordinary two-provider path meets wait, grant, latency, and cost budgets',
      'Empirical pilot claim',
      'T1.5 pilot, never structural proof',
    ],
  ];

  const registry = workflow.match(
    /### Stable assurance claim registry\n([\s\S]*?)\n## Managed Task Lifecycle/,
  );
  assert.notEqual(registry, null);
  const actualClaims = registry![1]!
    .split('\n')
    .filter((line) => /^\|\s*`C-[A-Z-]+`\s*\|/.test(line))
    .map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim()),
    );
  assert.deepEqual(actualClaims, expectedClaims);
  assert.match(agents, /stable\s+claim-ID\/hardness registry/i);
  assert.match(agents, /do not invent a stronger synonym/i);
  assert.match(workflow, /investigation exemption/i);
  assert.match(workflow, /task-execution exemption/i);
  assert.match(
    workflow,
    /C-TERM-SCAN[\s\S]{0,120}C-WHY-BINDING[\s\S]{0,120}inapplicable/i,
  );
  assert.match(
    workflow,
    /task-execution exemption[\s\S]{0,160}does not[\s\S]{0,120}investigation exemption/i,
  );
  assert.match(
    workflow,
    /investigation exemption[\s\S]{0,180}PlanReview[\s\S]{0,120}checks[\s\S]{0,120}Git/i,
  );
  for (const boundary of [
    /semantic completeness[\s\S]{0,120}(?:soft|not proved)/i,
    /WHY truth[\s\S]{0,120}(?:soft|not proved)/i,
    /provider identity[\s\S]{0,120}(?:soft|not cryptographic)/i,
    /same-user containment[\s\S]{0,120}(?:soft|not proved)/i,
    /reviewer judgment[\s\S]{0,120}(?:soft|not proved)/i,
    /exact-byte closure[\s\S]{0,120}deterministic[\s\S]{0,80}mechanical-transform[\s\S]{0,160}does not claim[\s\S]{0,80}graph completeness[\s\S]{0,80}semantic equivalence/i,
    /degraded[\s\S]{0,160}does not recreate[\s\S]{0,80}independence/i,
    /availability[\s\S]{0,160}empirical[\s\S]{0,120}not structural/i,
  ]) {
    assert.match(workflow, boundary);
  }
});

test('the public asset CLI exposes only the tool-plural command', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const cliPath = path.join(
    repositoryRoot,
    'packages/workflow-engine/src/cli.ts',
  );
  const run = (args: string[]) =>
    spawnSync(
      process.execPath,
      ['--experimental-strip-types', cliPath, ...args, '--json'],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

  const current = run(['openspec-assets', 'check']);
  assert.equal(current.status, 0, current.stderr);
  assert.equal(JSON.parse(current.stdout).command, 'openspec-assets');

  const legacy = run(['codex-assets', 'check']);
  assert.equal(legacy.status, 2);
  assert.equal(JSON.parse(legacy.stderr).error.code, 'INVALID_USAGE');

  const help = run(['help']);
  assert.equal(help.status, 0, help.stderr);
  const usage = JSON.parse(help.stdout).usage as string;
  assert.match(usage, /pnpm workflow openspec-assets/);
  assert.doesNotMatch(usage, /pnpm workflow codex-assets/);
});

test('the retired Codex-only asset implementation and home are absent', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  for (const retiredPath of [
    'packages/workflow-engine/src/codex-planning-asset-contract.ts',
    'packages/workflow-engine/src/codex-planning-assets.ts',
    'packages/workflow-engine/test/codex-planning-assets.integration.test.ts',
    'workflow/codex-assets',
  ]) {
    assert.equal(
      fs.existsSync(path.join(repositoryRoot, retiredPath)),
      false,
      `${retiredPath} must not remain as a compatibility surface`,
    );
  }
});

test('break-glass maintainer operator contract is complete and bootstrap-only', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const workflow = fs.readFileSync(
    path.join(repositoryRoot, 'docs/WORKFLOW.md'),
    'utf8',
  );
  const roadmap = fs.readFileSync(
    path.join(repositoryRoot, 'docs/ROADMAP.md'),
    'utf8',
  );

  for (const command of [
    'pnpm workflow maintainer grant',
    'pnpm workflow maintainer attest',
    'pnpm workflow maintainer attestation-relay',
    'pnpm workflow maintainer inspect',
    'pnpm workflow grant revoke',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(' ', '\\s+')));
  }
  assert.match(
    workflow,
    /legacy V1[\s\S]{0,160}public authority-session commands[\s\S]{0,160}entrypoints are absent[\s\S]{0,160}inspection surfaces[\s\S]{0,160}cannot authorize[\s\S]{0,20}new[\s\S]{0,5}work/i,
  );

  assert.match(workflow, /controlling interactive terminal/i);
  assert.match(workflow, /git config --local gpg\.format ssh/);
  assert.match(workflow, /git config --local user\.signingkey/);
  assert.match(workflow, /workflow-grant\/\*\*/);
  assert.match(workflow, /workflow-attestation\/\*\*/);
  assert.match(workflow, /migration gate/i);
  assert.match(workflow, /protected environment/i);
  assert.match(workflow, /one-way/i);
  assert.match(workflow, /repository-admin, out-of-band/i);
  assert.match(roadmap, /bootstrap-only/i);
  assert.match(roadmap, /workflow-grant\/\*\*/);
  assert.match(roadmap, /workflow-attestation\/\*\*/);
  assert.match(roadmap, /protected environment/i);
});

test('documentation entry point is a project overview and archive policy remains immutable', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const readme = fs.readFileSync(
    path.join(repositoryRoot, 'docs/README.md'),
    'utf8',
  );
  const gitignore = fs.readFileSync(
    path.join(repositoryRoot, '.gitignore'),
    'utf8',
  );
  const documentPolicy = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, 'workflow/document-policy.json'),
      'utf8',
    ),
  ) as { documents: Record<string, unknown> };

  assert.match(readme, /^# Jigwright Documentation$/m);
  assert.match(readme, /current-v3/i);
  assert.match(readme, /docs\/WORKFLOW\.md/);
  assert.match(readme, /openspec\/specs/);
  assert.doesNotMatch(readme, /expense-app/i);
  assert.doesNotMatch(readme, /apps\/(?:api|mobile|web)/);
  assert.doesNotMatch(readme, /^# Documentation Entry Point$/m);
  assert.doesNotMatch(readme, /^## Target Structure$/m);
  assert.doesNotMatch(gitignore, /^\/memo\/$/m);

  assert.deepEqual(documentPolicy.documents['docs/archive/**'], {
    mode: 'immutable',
    enforcement: 'planned',
  });
  assert.ok(documentPolicy.documents['docs/ROADMAP.md']);
  assert.ok(documentPolicy.documents['openspec/specs/**']);
  assert.ok(documentPolicy.documents['openspec/changes/**']);
});

test('parseTasks reads ordered checkbox tasks', () => {
  const tasks = parseTasks(`
# Tasks

- [ ] 1.1 Add failing test
- [x] 1.2 Implement behavior
`);

  assert.deepEqual(tasks, [
    { id: '1.1', completed: false, title: 'Add failing test' },
    { id: '1.2', completed: true, title: 'Implement behavior' },
  ]);
});

test('change contracts admit a strict v3 Manifest from the observed current tree', () => {
  const repository = createFixtureRepository();
  try {
    const artifacts = writeManagedChangeArtifacts(repository);
    const manifest = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, manifest).outcome,
      'published',
    );
    const contract = loadChangeContract(repository, 'demo-change');

    assert.equal(contract.schemaName, 'jigwright');
    assert.deepEqual(contract.investigation?.manifest, manifest);
    assert.deepEqual(contract.investigation?.validation, {
      kind: 'manifest-authority-admissible',
      manifestDigest: manifest.manifestDigest,
      investigationTargetDigest:
        manifest.investigationApproval.investigationTargetDigest,
    });
    assert.deepEqual(contract.investigation?.currentTreeObservation, {
      kind: 'current-tracked-tree',
      path: 'openspec/changes/demo-change/investigation.json',
      contentDigest: crypto
        .createHash('sha256')
        .update(`${canonicalJson(manifest)}\n`)
        .digest('hex'),
    });
    assert.deepEqual(contract.execution, artifacts.execution);
    assert.deepEqual(contract.planReview, artifacts.planReview);
    for (const artifact of [
      'investigation.json',
      'execution.json',
      'plan-review.json',
    ]) {
      assert.ok(
        contract.artifactPaths.includes(
          path.join(repository, 'openspec/changes/demo-change', artifact),
        ),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('the configured current schema owns investigation-first contract semantics', () => {
  const repository = createFixtureRepository();
  try {
    const artifacts = writeManagedChangeArtifacts(repository);
    const manifest = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, manifest).outcome,
      'published',
    );
    const changeDirectory = path.join(
      repository,
      'openspec/changes/demo-change',
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'origin.json'),
      `${canonicalJson({ schemaVersion: 1, sources: [] })}\n`,
    );
    fs.writeFileSync(
      path.join(changeDirectory, 'survey.json'),
      `${canonicalJson({ schemaVersion: 1, consumers: [] })}\n`,
    );
    const consumerPath = path.join(
      repository,
      'workflow/repository-consumer.json',
    );
    const consumer = JSON.parse(fs.readFileSync(consumerPath, 'utf8')) as {
      planning: {
        supportedSchemaNames: string[];
        managedSchemaNames: string[];
        currentSchemaName: string;
      };
    };
    consumer.planning.supportedSchemaNames.push('orbit-spec-v1');
    consumer.planning.managedSchemaNames.push('orbit-spec-v1');
    consumer.planning.currentSchemaName = 'orbit-spec-v1';
    fs.writeFileSync(consumerPath, `${JSON.stringify(consumer, null, 2)}\n`);
    fs.writeFileSync(
      path.join(changeDirectory, '.openspec.yaml'),
      'schema: orbit-spec-v1\ncreated: 2026-07-15\n',
    );

    const contract = loadChangeContract(repository, 'demo-change');
    assert.equal(contract.schemaName, 'orbit-spec-v1');
    assert.deepEqual(contract.investigation?.manifest, manifest);
    assert.deepEqual(contract.execution, artifacts.execution);
    assert.deepEqual(contract.planReview, artifacts.planReview);
    for (const artifact of [
      'investigation.json',
      'execution.json',
      'origin.json',
      'survey.json',
      'plan-review.json',
    ]) {
      assert.equal(
        contract.artifactPaths.includes(path.join(changeDirectory, artifact)),
        true,
        artifact,
      );
    }
    const subject = deriveInvestigationFirstPlanningSubject(
      repository,
      contract,
    );
    assert.equal(subject.target.schemaName, 'orbit-spec-v1');
    assert.equal(
      subject.target.components.some(
        ({ role, path: componentPath }) =>
          role === 'schema-metadata' &&
          componentPath === 'openspec/changes/demo-change/.openspec.yaml',
      ),
      true,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current change loading rejects a v3 Manifest whose digest no longer replays', () => {
  const repository = createFixtureRepository();
  try {
    writeManagedChangeArtifacts(repository);
    const published = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, published).outcome,
      'published',
    );
    const manifest = structuredClone(published);
    manifest.manifestDigest = 'f'.repeat(64);
    fs.writeFileSync(
      path.join(repository, 'openspec/changes/demo-change/investigation.json'),
      `${canonicalJson(manifest)}\n`,
    );

    assert.throws(
      () => loadChangeContract(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'RECONSTRUCTION_MISMATCH'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current change loading rejects tracked revision bytes until private current-ref recovery completes', () => {
  const repository = createFixtureRepository();
  try {
    writeManagedChangeArtifacts(repository);
    const first = buildCurrentV3Investigation(repository, 'demo-change', 3);
    assert.equal(
      publishCurrentV3Investigation(repository, first).outcome,
      'published',
    );
    assert.equal(
      loadChangeContract(repository, 'demo-change').investigation?.manifest
        .manifestDigest,
      first.manifestDigest,
    );

    const second = buildCurrentV3Investigation(repository, 'demo-change', 4);
    const interrupted = publishCurrentV3Investigation(
      repository,
      second,
      (phase) => {
        if (phase === 'manifest-installed') {
          throw new Error('simulated tracked revision crash');
        }
      },
    );
    assert.equal(interrupted.outcome, 'blocked');
    if (interrupted.outcome === 'blocked') {
      assert.equal(
        interrupted.blocker.failureCode,
        'PUBLICATION_RECOVERY_REQUIRED',
      );
    }
    assert.throws(
      () => loadChangeContract(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'REVIEW_TARGET_STALE'),
    );

    const publication = contractPublicationFixture(repository, second);
    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot: publication.privateRoot,
      paths: publication.paths,
      lifecycle: publication.lifecycle,
      withTransitionLock: (operation) => operation(publication.expected),
    });
    assert.equal(resumed.outcome, 'published');
    assert.equal(
      loadChangeContract(repository, 'demo-change').investigation?.manifest
        .manifestDigest,
      second.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('current change loading resolves its private ref from a linked-worktree git-common root', () => {
  const repository = createFixtureRepository();
  const privateStorage = fs.mkdtempSync(
    path.join(os.tmpdir(), 'contracts-current-v3-private-'),
  );
  try {
    writeManagedChangeArtifacts(repository);
    const privateRoot = path.join(privateStorage, 'git-common');
    fs.renameSync(path.join(repository, '.git'), privateRoot);
    fs.writeFileSync(path.join(repository, '.git'), `gitdir: ${privateRoot}\n`);
    const manifest = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, manifest).outcome,
      'published',
    );
    assert.equal(
      loadChangeContract(repository, 'demo-change').investigation?.manifest
        .manifestDigest,
      manifest.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(privateStorage, { recursive: true, force: true });
  }
});

test('raw change loading rejects final and ancestor metadata symlink escapes', () => {
  for (const escape of ['metadata', 'change-directory'] as const) {
    const repository = createFixtureRepository();
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-metadata-outside-'),
    );
    try {
      const changeDirectory = path.join(
        repository,
        'openspec/changes/demo-change',
      );
      if (escape === 'metadata') {
        const metadataPath = path.join(changeDirectory, '.openspec.yaml');
        const outsideMetadata = path.join(outside, '.openspec.yaml');
        fs.writeFileSync(
          outsideMetadata,
          'schema: expense-app\ncreated: 2026-07-15\n',
        );
        fs.rmSync(metadataPath);
        fs.symlinkSync(outsideMetadata, metadataPath);
      } else {
        const outsideChange = path.join(outside, 'demo-change');
        fs.renameSync(changeDirectory, outsideChange);
        fs.symlinkSync(outsideChange, changeDirectory, 'dir');
      }
      assert.throws(
        () => loadChangeContract(repository, 'demo-change'),
        (error) => isWorkflowError(error, 'OPENSPEC_CHANGE_TREE_UNSAFE'),
        escape,
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('raw change loading rejects the reserved archive container', () => {
  const repository = createFixtureRepository();
  try {
    assert.throws(
      () => loadChangeContract(repository, 'archive'),
      (error) => isWorkflowError(error, 'PLANNING_CHANGE_ID_RESERVED'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('engine artifact validators reject noncanonical, forged, over-keyed, and scope-expanding inputs', () => {
  const repository = createFixtureRepository();
  try {
    const { investigation, execution, planReview } =
      writeManagedChangeArtifacts(repository);
    assert.deepEqual(
      parseHistoricalInvestigationArtifact(investigation, 'demo-change'),
      investigation,
    );
    const currentInvestigation = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, currentInvestigation).outcome,
      'published',
    );
    assert.deepEqual(
      parseExecutionArtifact(
        execution,
        'demo-change',
        loadChangeContract(repository, 'demo-change').tasks,
        loadChangeContract(repository, 'demo-change').guard,
        loadChangeContract(repository, 'demo-change').checks,
        loadChangeContract(repository, 'demo-change').behaviorContracts,
      ),
      execution,
    );
    assert.deepEqual(
      parsePlanReviewArtifact(planReview, 'demo-change'),
      planReview,
    );

    const forgedInvestigation = structuredClone(investigation);
    forgedInvestigation.nodes[0]!.resultDigest = 'f'.repeat(64);
    assert.throws(
      () =>
        parseHistoricalInvestigationArtifact(
          forgedInvestigation,
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    assert.throws(
      () =>
        parseHistoricalInvestigationArtifact(
          { ...investigation, unexpected: true },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    assert.throws(
      () =>
        parsePlanReviewArtifact(
          { ...planReview, changeId: 'another-change' },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_PLAN_REVIEW_ARTIFACT'),
    );
    assert.throws(
      () =>
        parseHistoricalInvestigationArtifact(
          {
            ...investigation,
            nodes: [investigation.nodes[0], investigation.nodes[0]],
          },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    assert.throws(
      () =>
        parsePlanReviewArtifact(
          {
            ...planReview,
            currentRefs: { planReview: '9'.repeat(64) },
          },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_PLAN_REVIEW_ARTIFACT'),
    );
    assert.throws(
      () =>
        parseHistoricalInvestigationArtifact(
          { ...investigation, legacyMigration: true },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    const namedMigration = {
      ...investigation,
      changeId: 'establish-investigation-first-planning',
      legacyMigration: true,
    };
    assert.deepEqual(
      parseHistoricalInvestigationArtifact(
        namedMigration,
        'establish-investigation-first-planning',
      ),
      namedMigration,
    );
    const orphan = createEvidenceNode({
      type: 'fixture-orphan',
      nodeSchema: 'fixture.orphan.v1',
      evaluator: 'fixture.orphan.v1',
      policyDigest: '6'.repeat(64),
      exactInputDigests: {},
      semanticParentResultDigests: { parent: '7'.repeat(64) },
      provenanceParentNodeIds: { parent: '8'.repeat(64) },
      outputSchema: 'fixture.orphan-output.v1',
      output: { valid: false },
      runtimeMetadata: {},
    });
    assert.throws(
      () =>
        parseHistoricalInvestigationArtifact(
          {
            ...investigation,
            nodes: [orphan],
            currentRefs: { sealedInvestigation: orphan.nodeId },
          },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    const parent = investigation.nodes[0]!;
    const mismatchedRoles = createEvidenceNode({
      type: 'fixture-child',
      nodeSchema: 'fixture.child.v1',
      evaluator: 'fixture.child.v1',
      policyDigest: '6'.repeat(64),
      exactInputDigests: {},
      semanticParentResultDigests: { semantic: parent.resultDigest },
      provenanceParentNodeIds: { provenance: parent.nodeId },
      outputSchema: 'fixture.child-output.v1',
      output: { valid: false },
      runtimeMetadata: {},
    });
    assert.throws(
      () =>
        parseHistoricalInvestigationArtifact(
          {
            ...investigation,
            nodes: [parent, mismatchedRoles].sort((left, right) =>
              left.nodeId.localeCompare(right.nodeId),
            ),
            currentRefs: { sealedInvestigation: mismatchedRoles.nodeId },
          },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    const forgedParentResult = createEvidenceNode({
      type: 'fixture-child',
      nodeSchema: 'fixture.child.v1',
      evaluator: 'fixture.child.v1',
      policyDigest: '6'.repeat(64),
      exactInputDigests: {},
      semanticParentResultDigests: { parent: '7'.repeat(64) },
      provenanceParentNodeIds: { parent: parent.nodeId },
      outputSchema: 'fixture.child-output.v1',
      output: { valid: false },
      runtimeMetadata: {},
    });
    assert.throws(
      () =>
        parseHistoricalInvestigationArtifact(
          {
            ...investigation,
            nodes: [parent, forgedParentResult].sort((left, right) =>
              left.nodeId.localeCompare(right.nodeId),
            ),
            currentRefs: { sealedInvestigation: forgedParentResult.nodeId },
          },
          'demo-change',
        ),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
    const oldParent = createEvidenceNode({
      type: 'fixture-parent',
      nodeSchema: 'fixture.parent.v1',
      evaluator: 'fixture.parent.v1',
      policyDigest: 'a'.repeat(64),
      exactInputDigests: { source: 'b'.repeat(64) },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'fixture.parent-output.v1',
      output: { equivalent: true },
      runtimeMetadata: {},
    });
    const newParent = createEvidenceNode({
      type: 'fixture-parent',
      nodeSchema: 'fixture.parent.v1',
      evaluator: 'fixture.parent.v1',
      policyDigest: 'a'.repeat(64),
      exactInputDigests: { source: 'c'.repeat(64) },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'fixture.parent-output.v1',
      output: { equivalent: true },
      runtimeMetadata: {},
    });
    const descendant = createEvidenceNode({
      type: 'fixture-descendant',
      nodeSchema: 'fixture.descendant.v1',
      evaluator: 'fixture.descendant.v1',
      policyDigest: 'd'.repeat(64),
      exactInputDigests: {},
      semanticParentResultDigests: { source: oldParent.resultDigest },
      provenanceParentNodeIds: { source: oldParent.nodeId },
      outputSchema: 'fixture.descendant-output.v1',
      output: { valid: true },
      runtimeMetadata: {},
    });
    const convergence = createConvergenceRecord({
      oldParent,
      newParent,
      validatorVersion: 'evidence-currentness.v1',
      runtimeMetadata: {},
    });
    const reuseProof = createDescendantReuseProof({
      descendant,
      parentRole: 'source',
      oldParent,
      newParent,
      convergenceRecord: convergence,
      validatorVersion: 'evidence-currentness.v1',
      runtimeMetadata: {},
    });
    const artifactWithReuse = {
      ...investigation,
      nodes: [oldParent, newParent, descendant, convergence, reuseProof].sort(
        (left, right) => left.nodeId.localeCompare(right.nodeId),
      ),
      currentRefs: {
        sealedInvestigation: descendant.nodeId,
        [currentParentEvidenceRef(descendant.nodeId, 'source')]:
          newParent.nodeId,
        [descendantReuseProofEvidenceRef(descendant.nodeId, 'source')]:
          reuseProof.nodeId,
      },
    };
    assert.deepEqual(
      parseHistoricalInvestigationArtifact(artifactWithReuse, 'demo-change'),
      artifactWithReuse,
    );

    const expandedExecution = structuredClone(execution);
    expandedExecution.tasks['1.1']!.allowedPaths = ['outside/**'];
    const contract = loadChangeContract(repository, 'demo-change');
    assert.throws(
      () =>
        parseExecutionArtifact(
          expandedExecution,
          'demo-change',
          contract.tasks,
          contract.guard,
          contract.checks,
          contract.behaviorContracts,
        ),
      (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
    );

    const investigationPath = path.join(
      repository,
      'openspec/changes/demo-change/investigation.json',
    );
    fs.writeFileSync(
      investigationPath,
      `${JSON.stringify(investigation, null, 2)}\n`,
    );
    assert.throws(
      () => loadChangeContract(repository, 'demo-change'),
      (error) => isWorkflowError(error, 'INVALID_INVESTIGATION_ARTIFACT'),
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('execution artifacts use one exact strategy variant per task without claiming execution', () => {
  const repository = createFixtureRepository();
  try {
    writeManagedChangeArtifacts(repository);
    const currentInvestigation = buildCurrentV3Investigation(repository);
    assert.equal(
      publishCurrentV3Investigation(repository, currentInvestigation).outcome,
      'published',
    );
    const contract = loadChangeContract(repository, 'demo-change');
    const common = {
      enforcement: 'planned' as const,
      allowedPaths: ['src/**'],
      requiredChecks: ['fixture'],
      diffReview: 'required' as const,
    };
    const transformationContract = {
      rule: 'Rename the reviewed symbol exactly.',
      examples: [{ before: 'OLD_NAME', after: 'NEW_NAME' }],
      fileScopes: ['src/features/**'],
      oldTerms: [{ kind: 'symbol' as const, value: 'OLD_NAME' }],
      replacementTerms: [{ kind: 'symbol' as const, value: 'NEW_NAME' }],
      retainedDispositions: [],
      redInapplicableReason:
        'Exact-byte closure and registered checks specify this codemod.',
    };
    const variants = [
      {
        ...common,
        strategy: 'cross-agent-tdd' as const,
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: null,
          },
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Demo succeeds',
          },
        ],
        testPathScopes: ['src/__tests__/**'],
        fixturePathScopes: ['src/__tests__/fixtures/**'],
        implementationPathScopes: ['src/features/**'],
        redCheck: 'fixture',
        greenChecks: ['fixture'],
        requiredImplementerIndependence: 'provider-independent' as const,
      },
      {
        ...common,
        strategy: 'mechanical-transform' as const,
        transformationContract,
      },
      {
        ...common,
        strategy: 'direct-reviewed' as const,
        exemptionKind: 'documentation-only' as const,
        exemptionReason: 'Only authored documentation changes.',
      },
      {
        ...common,
        strategy: 'tdd-single-agent' as const,
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Demo succeeds',
          },
        ],
        testPathScopes: ['src/__tests__/**'],
        fixturePathScopes: ['src/__tests__/fixtures/**'],
        implementationPathScopes: ['src/features/**'],
        redCheck: 'fixture',
        greenChecks: ['fixture'],
        requiredImplementerIndependence: 'none' as const,
      },
    ];

    for (const task of variants) {
      const artifact = {
        schemaVersion: 1 as const,
        kind: 'execution-artifact' as const,
        changeId: 'demo-change',
        tasks: { '1.1': task },
      };
      assert.deepEqual(
        parseExecutionArtifact(
          artifact,
          'demo-change',
          contract.tasks,
          contract.guard,
          contract.checks,
          contract.behaviorContracts,
        ),
        artifact,
      );
    }

    const invalid = [
      {
        ...variants[0],
        strategy: 'unknown-strategy',
      },
      {
        ...variants[1],
        exemptionReason: 'mixed union branch',
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          examples: [],
        },
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          fileScopes: ['outside/**'],
        },
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          replacementTerms: [],
        },
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          replacementTerms: [{ kind: 'symbol' as const, value: 'OLD_NAME' }],
        },
      },
      {
        ...variants[1],
        transformationContract: {
          ...transformationContract,
          retainedDispositions: [
            {
              term: { kind: 'symbol' as const, value: 'OLD_NAME' },
              path: 'outside/reference.md',
              mutationClass: 'live' as const,
              reason:
                'A live residual cannot be dispositioned outside mutation authority.',
            },
          ],
        },
      },
      {
        ...variants[2],
        requiredChecks: ['unregistered'],
      },
      {
        ...variants[2],
        allowedPaths: [],
      },
      {
        ...variants[2],
        exemptionKind: 'legacy-bootstrap',
        legacyBootstrap: 'establish-investigation-first-planning',
      },
      {
        ...variants[0],
        enforcement: 'available',
      },
      {
        ...variants[1],
        enforcement: 'available',
      },
      {
        ...variants[0],
        behaviorContractRefs: ['specs/demo/spec.md#demo'],
      },
      {
        ...variants[0],
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Missing behavior',
            scenario: null,
          },
        ],
      },
      {
        ...variants[0],
        behaviorContractRefs: [
          {
            specPath: 'specs/demo/spec.md',
            requirement: 'Demo behavior',
            scenario: 'Missing scenario',
          },
        ],
      },
      {
        ...variants[0],
        implementationPathScopes: ['src/__tests__/fixtures/**'],
      },
      {
        ...variants[0],
        testPathScopes: ['outside/**'],
      },
      {
        ...variants[0],
        requiredImplementerIndependence: 'none',
      },
      {
        ...variants[3],
        requiredImplementerIndependence: 'provider-independent',
      },
    ];
    for (const task of invalid) {
      assert.throws(
        () =>
          parseExecutionArtifact(
            {
              schemaVersion: 1,
              kind: 'execution-artifact',
              changeId: 'demo-change',
              tasks: { '1.1': task },
            },
            'demo-change',
            contract.tasks,
            contract.guard,
            contract.checks,
            contract.behaviorContracts,
          ),
        (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
      );
    }
    assert.throws(
      () =>
        parseExecutionArtifact(
          {
            schemaVersion: 1,
            kind: 'execution-artifact',
            changeId: 'demo-change',
            tasks: {},
          },
          'demo-change',
          [],
          { schemaVersion: 1, changeId: 'demo-change', tasks: {} },
          contract.checks,
          contract.behaviorContracts,
        ),
      (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
    );

    const overbroadBootstrap = {
      schemaVersion: 1 as const,
      kind: 'execution-artifact' as const,
      changeId: 'establish-investigation-first-planning',
      tasks: {
        '1.1': {
          ...variants[2],
          exemptionKind: 'legacy-bootstrap' as const,
          legacyBootstrap: 'establish-investigation-first-planning' as const,
        },
      },
    };
    assert.throws(
      () =>
        parseExecutionArtifact(
          overbroadBootstrap,
          overbroadBootstrap.changeId,
          contract.tasks,
          contract.guard,
          contract.checks,
          contract.behaviorContracts,
        ),
      (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
    );

    const bootstrapTasks = [
      { id: '6.8', completed: true, title: 'Activate the schema.' },
      { id: '7.1', completed: false, title: 'Adopt the schema.' },
    ];
    const bootstrapGuard = {
      schemaVersion: 1 as const,
      changeId: 'establish-investigation-first-planning',
      tasks: {
        '6.8': {
          allowedPaths: ['src/**'],
          requiredChecks: ['fixture'],
        },
        '7.1': {
          allowedPaths: ['src/**'],
          requiredChecks: ['fixture'],
        },
      },
    };
    const bootstrapExecution = {
      schemaVersion: 1 as const,
      kind: 'execution-artifact' as const,
      changeId: 'establish-investigation-first-planning',
      tasks: {
        '6.8': variants[2],
        '7.1': {
          ...variants[2],
          exemptionKind: 'legacy-bootstrap' as const,
          exemptionReason:
            'Adopt the named pre-T2 plan under its reviewed bootstrap.',
          legacyBootstrap: 'establish-investigation-first-planning' as const,
        },
      },
    };
    for (const tasks of [
      bootstrapTasks,
      bootstrapTasks.map((task) => ({ ...task, completed: true })),
    ]) {
      assert.throws(
        () =>
          parseExecutionArtifact(
            bootstrapExecution,
            bootstrapExecution.changeId,
            tasks,
            bootstrapGuard,
            contract.checks,
            contract.behaviorContracts,
          ),
        (error) => isWorkflowError(error, 'INVALID_EXECUTION_ARTIFACT'),
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('parseTasks rejects duplicate task IDs', () => {
  assert.throws(
    () =>
      parseTasks(`
- [ ] 1.1 First
- [ ] 1.1 Duplicate
`),
    (error) => isWorkflowError(error, 'DUPLICATE_TASK_ID'),
  );
});

test('parseTasks preserves wrapped task titles', () => {
  assert.deepEqual(
    parseTasks(`
- [ ] 3.2 Generate the six-field semantic handoff
      from controlled change state without hashes.
`),
    [
      {
        id: '3.2',
        completed: false,
        title:
          'Generate the six-field semantic handoff from controlled change state without hashes.',
      },
    ],
  );
});

test('policy paths accept exact paths and segment-aware directory prefixes', () => {
  assert.equal(
    normalizePolicyPath('apps/api/src/file.ts'),
    'apps/api/src/file.ts',
  );
  assert.equal(normalizePolicyPath('apps/api/**'), 'apps/api/**');
  assert.equal(matchesAllowedPath('apps/api/src/file.ts', 'apps/api/**'), true);
  assert.equal(matchesAllowedPath('apps/api', 'apps/api/**'), true);
  assert.equal(
    matchesAllowedPath('apps/api-copy/file.ts', 'apps/api/**'),
    false,
  );
  assert.equal(
    matchesAllowedPath('apps/api/src/file.ts', 'apps/api/src/file.ts'),
    true,
  );
  assert.equal(
    normalizeChangedPath('apps/api/src/[slug]/file?.ts'),
    'apps/api/src/[slug]/file?.ts',
  );
  assert.equal(
    matchesAllowedPath('apps/api/src/[slug]/file?.ts', 'apps/api/**'),
    true,
  );
});

test('generic changed paths reject Git directory markers', () => {
  assert.throws(
    () => normalizeChangedPath('memo/'),
    (error) => isWorkflowError(error, 'INVALID_REPOSITORY_PATH'),
  );
});

test('policy paths reject traversal, absolute paths, and unsupported globs', () => {
  for (const invalidPath of [
    '../secret',
    '/tmp/secret',
    'C:\\secret',
    './apps/api',
    'apps/*/src',
    'apps/api/',
  ]) {
    assert.throws(
      () => normalizePolicyPath(invalidPath),
      (error) => isWorkflowError(error, 'INVALID_POLICY_PATH'),
      invalidPath,
    );
  }
});

test('policy validation rejects an existing symlink escape', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-path-root-'));
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'workflow-path-outside-'),
  );
  try {
    fs.symlinkSync(outside, path.join(root, 'escape'));
    assert.throws(
      () => assertPolicyPathInsideRepository(root, 'escape/**'),
      (error) => isWorkflowError(error, 'PATH_ESCAPES_REPOSITORY'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('disposable database policy accepts only explicit isolated test identities', () => {
  const evidence = assertDisposableDatabase({
    WORKFLOW_DISPOSABLE_DATABASE: '1',
    TEST_DATABASE_URL:
      'postgres://runner:super-secret@127.0.0.1:5433/expense_ci?sslmode=disable',
    DATABASE_URL: 'postgres://app:secret@127.0.0.1:5433/expense_dev',
  });

  assert.deepEqual(evidence, {
    identity: 'postgresql://127.0.0.1:5433/expense_ci',
  });
  assert.equal(JSON.stringify(evidence).includes('super-secret'), false);
  assert.equal(JSON.stringify(evidence).includes('sslmode'), false);
});

test('check environment exposes only deterministic runtime and validated database values', () => {
  const callerEnvironment = {
    ...process.env,
    PATH: '/tmp/fake-bin',
    NODE_OPTIONS: '--require=/tmp/inject.cjs',
    NODE_PATH: '/tmp/modules',
    LD_PRELOAD: '/tmp/inject.so',
    DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
    GIT_DIR: '/tmp/decoy.git',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    PRIVATE_TOKEN: 'marker-secret',
    DATABASE_URL: 'postgres://app:secret@localhost/expense_dev',
    COMPOSE_TEST_DATABASE_URL:
      'postgres://compose:secret@localhost/expense_test',
  };

  const nonDestructive = createCheckEnvironment(callerEnvironment, false);

  for (const key of [
    'NODE_OPTIONS',
    'NODE_PATH',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'GIT_DIR',
    'SSH_AUTH_SOCK',
    'PRIVATE_TOKEN',
    'DATABASE_URL',
    'COMPOSE_TEST_DATABASE_URL',
    'TEST_DATABASE_URL',
  ]) {
    assert.equal(Object.hasOwn(nonDestructive, key), false, key);
  }
  assert.equal(nonDestructive.PATH?.includes('/tmp/fake-bin'), false);
  assert.equal(nonDestructive.CI, '1');
  assert.equal(nonDestructive.WORKFLOW_CHECK_EXECUTION, '1');

  const destructive = createCheckEnvironment(
    {
      ...callerEnvironment,
      WORKFLOW_DISPOSABLE_DATABASE: '1',
      TEST_DATABASE_URL:
        'postgres://runner:marker-secret@localhost/expense_test',
    },
    true,
  );
  assert.equal(
    destructive.TEST_DATABASE_URL,
    'postgres://runner:marker-secret@localhost/expense_test',
  );
  assert.equal(destructive.WORKFLOW_DISPOSABLE_DATABASE, '1');
  assert.equal(JSON.stringify(nonDestructive).includes('marker-secret'), false);
});

test(
  'check environment ignores a caller-controlled temporary directory',
  { skip: process.platform === 'win32' },
  () => {
    const attackerDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'workflow-fake-tmp-'),
    );
    const originalTemporaryDirectory = process.env.TMPDIR;
    try {
      process.env.TMPDIR = attackerDirectory;

      const environment = createCheckEnvironment({}, false);

      assert.equal(environment.TMPDIR, fs.realpathSync('/tmp'));
      assert.notEqual(environment.TMPDIR, fs.realpathSync(attackerDirectory));
    } finally {
      if (originalTemporaryDirectory === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = originalTemporaryDirectory;
      }
      fs.rmSync(attackerDirectory, { recursive: true, force: true });
    }
  },
);

test('disposable database policy fails closed without leaking connection secrets', () => {
  const cases: Array<{
    name: string;
    environment: NodeJS.ProcessEnv;
    code: string;
  }> = [
    {
      name: 'confirmation missing',
      environment: {
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_test',
      },
      code: 'DISPOSABLE_DATABASE_CONFIRMATION_REQUIRED',
    },
    {
      name: 'test URL missing',
      environment: { WORKFLOW_DISPOSABLE_DATABASE: '1' },
      code: 'TEST_DATABASE_URL_REQUIRED',
    },
    {
      name: 'unsupported protocol',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'mysql://runner:marker-secret@localhost/expense_test',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'no disposable name token',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_sandbox',
      },
      code: 'UNSAFE_TEST_DATABASE_IDENTITY',
    },
    {
      name: 'forbidden production token',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_prod_test',
      },
      code: 'UNSAFE_TEST_DATABASE_IDENTITY',
    },
    {
      name: 'same identity as development URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@db.example.test:5432/expense_test?ssl=true',
        DATABASE_URL:
          'postgresql://app:other-secret@db.example.test/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'different DNS aliases cannot prove database isolation',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@ci-db.internal:6543/expense_test',
        DATABASE_URL:
          'postgres://app:other-secret@primary-db.internal:5432/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'trailing-dot hostname aliases development URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@localhost./expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'IPv4 and localhost loopback aliases match',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@127.0.0.1/expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'IPv4-mapped IPv6 loopback aliases localhost',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://test-user:marker-secret@[::ffff:127.0.0.1]/expense_test',
        DATABASE_URL: 'postgres://app:other-secret@localhost/expense_test',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
    {
      name: 'query overrides the PostgreSQL target',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@safe.example.test:6543/expense_test?host=prod.example.test&port=5432',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'percent-encoded hostname is ambiguous',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@%70rod.example.test/expense_test',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'control character in URL',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@localhost/expense_test\0',
      },
      code: 'UNSAFE_TEST_DATABASE_URL',
    },
    {
      name: 'driver-equivalent encoded database identity',
      environment: {
        WORKFLOW_DISPOSABLE_DATABASE: '1',
        TEST_DATABASE_URL:
          'postgres://runner:marker-secret@db.example.test/expense_%74est%23x',
        DATABASE_URL:
          'postgres://app:other-secret@db.example.test/expense_test%2523x',
      },
      code: 'TEST_DATABASE_MATCHES_DATABASE_URL',
    },
  ];

  for (const fixture of cases) {
    assert.throws(
      () => assertDisposableDatabase(fixture.environment),
      (error) => {
        assert.equal(isWorkflowError(error, fixture.code), true, fixture.name);
        const rendered = JSON.stringify({
          error,
          message: error instanceof Error ? error.message : String(error),
        });
        assert.equal(rendered.includes('marker-secret'), false, fixture.name);
        assert.equal(rendered.includes('other-secret'), false, fixture.name);
        return true;
      },
    );
  }
});

function buildCurrentV3Investigation(
  repository: string,
  changeId = 'demo-change',
  sessionRevision = 3,
): InvestigationManifestV3 {
  const baseline = {
    commitOid: execFileSync('git', ['-C', repository, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim(),
    treeOid: execFileSync(
      'git',
      ['-C', repository, 'rev-parse', 'HEAD^{tree}'],
      { encoding: 'utf8' },
    ).trim(),
  };
  const sessionSnapshotDigest = crypto
    .createHash('sha256')
    .update(`contracts-current-v3-session\0${sessionRevision}`)
    .digest('hex');
  const built = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state: {
      schemaVersion: 1,
      applicabilityKind: 'exemption',
      repositoryId: 'fixture',
      changeId,
      investigationId: `${changeId}-investigation`,
      normalizedIntent: {
        schemaVersion: 1,
        summary: 'Exercise the current v3 contract reader.',
        explicitPaths: ['docs/example.md'],
        explicitSymbols: [],
        explicitConfigKeys: [],
        renamePairs: [],
      },
      authoring: { sessionRevision, sessionSnapshotDigest },
      exemption: {
        category: 'documentation-only',
        baseline,
        declaredPaths: ['docs/example.md'],
        declaredChangeClasses: ['documentation-only'],
        rationale: 'This reader fixture changes documentation only.',
        semanticAuthor: {
          id: 'owner',
          provenance: 'checkpoint:contracts-current-v3',
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
        provenance: 'checkpoint:contracts-current-v3-approval',
      },
      approvalProvenanceDigest: crypto
        .createHash('sha256')
        .update('contracts-current-v3-approval')
        .digest('hex'),
    },
  });
  if (sealed.outcome !== 'sealed') assert.fail(sealed.blocker.failureCode);
  return sealed.manifest;
}

function contractPublicationFixture(
  repository: string,
  manifest: InvestigationManifestV3,
) {
  const lifecycle = {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    sessionRevision: manifest.authoring.sessionRevision,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
  };
  const namespace = investigationManifestPublicationNamespace(lifecycle);
  const paths = {
    manifestPath: `openspec/changes/${manifest.changeId}/investigation.json`,
    currentRefPath: `workflow-engine/${namespace}/current.json`,
    journalPath: `workflow-engine/${namespace}/journal.json`,
  };
  const gitCommonValue = execFileSync(
    'git',
    ['-C', repository, 'rev-parse', '--git-common-dir'],
    { encoding: 'utf8' },
  ).trim();
  const privateRoot = fs.realpathSync(
    path.isAbsolute(gitCommonValue)
      ? gitCommonValue
      : path.resolve(repository, gitCommonValue),
  );
  const refState = readInvestigationPublicationRefState({
    repositoryRoot: repository,
    privateRoot,
    currentRefPath: paths.currentRefPath,
    lifecycle,
  });
  if (refState.outcome !== 'read') assert.fail(refState.blocker.failureCode);
  return {
    lifecycle,
    paths,
    privateRoot,
    expected: {
      ...lifecycle,
      currentRefDigest: refState.currentRefDigest,
    },
  };
}

function publishCurrentV3Investigation(
  repository: string,
  manifest: InvestigationManifestV3,
  observePhase?: (phase: InvestigationManifestPublicationPhase) => void,
) {
  const publication = contractPublicationFixture(repository, manifest);
  return publishInvestigationManifestV3({
    repositoryRoot: repository,
    privateRoot: publication.privateRoot,
    paths: publication.paths,
    manifest,
    expected: publication.expected,
    withTransitionLock: (operation) => operation(publication.expected),
    observePhase,
  });
}

function isWorkflowError(error: unknown, code: string): boolean {
  return error instanceof WorkflowError && error.code === code;
}
