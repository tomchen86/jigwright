import test from 'node:test';
import assert from 'node:assert/strict';
import * as repositoryContracts from '../src/runtime/repository-observation/change-contract-reader.ts';
import { loadWorkflowConfig } from '../src/runtime/repository-observation/workflow-configuration.ts';
import { workflowNamespaceConfig } from '../src/modules/repository-consumer/workflow-config.ts';
import path from 'node:path';
import fs from 'node:fs';
import * as governanceIntakeProduction from '../src/composition-root/governance-intake-production.ts';
import * as workRegistry from '../src/composition-root/work-registry-production.ts';
import { workflowContractArtifactPaths } from '../src/runtime/repository-observation/workflow-contract-artifacts.ts';
import { createFixtureRepository } from './fixture.ts';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import { execFileSync, spawnSync } from 'node:child_process';

test('retired investigation readers are absent', () => {
  for (const exportName of [
    'parseInvestigationArtifact',
    'parseHistoricalInvestigationArtifact',
  ]) {
    assert.equal(exportName in repositoryContracts, false, exportName);
  }
});

test('retired Issue CLI and compatibility mutation surfaces are absent', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const workRegistrySource = [
    'src/application/work-registry/work-registry.ts',
    'src/modules/governance-intake/work-registry-record.ts',
    'src/runtime/work-registry/transactions.ts',
  ]
    .map((file) =>
      fs.readFileSync(
        path.join(repositoryRoot, 'packages/workflow-engine', file),
        'utf8',
      ),
    )
    .join('\n');
  assert.equal(
    fs.existsSync(
      path.join(
        repositoryRoot,
        'packages/workflow-engine/src/entrypoints/cli/issue-cli.ts',
      ),
    ),
    false,
  );
  assert.deepEqual(Object.keys(governanceIntakeProduction).sort(), [
    'INTAKE_KINDS',
    'assertExistingGovernanceIntakeChange',
    'deferredIntakeDestination',
    'findActiveTaskSessionId',
    'isRequirementKind',
    'renderGovernanceIntakeHandoff',
    'resolveGovernanceIntakeRuntimeRoot',
    'resolveRepositoryFindingScope',
  ]);
  for (const exportName of [
    'updateLegacyIssueCompatibilityAlias',
    'closeLegacyIssueCompatibilityAlias',
  ]) {
    assert.equal(exportName in workRegistry, false, exportName);
  }
  assert.doesNotMatch(workRegistrySource, /replaceCanonicalFileExpected/u);
});

test('maintainer policy artifacts exclude the retired Maintainer Grant V1 schema', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const artifacts = workflowContractArtifactPaths(repositoryRoot).map(
    (artifact) => path.relative(repositoryRoot, artifact),
  );
  const retiredGrantSchema = path.join(
    repositoryRoot,
    'workflow/schemas/maintainer-grant.schema.json',
  );

  assert.ok(artifacts.includes('workflow/maintainer-policy.json'));
  assert.ok(
    artifacts.includes('workflow/schemas/maintainer-policy.schema.json'),
  );
  assert.equal(fs.existsSync(retiredGrantSchema), false);
  assert.equal(
    artifacts.includes('workflow/schemas/maintainer-grant.schema.json'),
    false,
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

test('active OpenSpec specifications are current-v3 only', () => {
  const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
  const specifications = [
    {
      path: 'packages/workflow-engine/src/modules/investigation/spec.md',
      currentRequirements: [
        'Manifest v3 and PlanReview Remain Separate Authorities',
        '`investigation.json` SHALL contain only the current schema-v3 Manifest',
        '`plan-review.json` SHALL remain a separate artifact bound to the exact',
        'MUST stale both the investigation seal and any PlanReview',
      ],
      retiredPhrases: [
        'Scenario: Pre-cutover plan is migrated',
        'legacy planning generation',
        'eligible managed migration',
        'At v3 cutover',
        'Scenario: Shadow v3 exists before central Grant Core readiness',
        'schema-v3 shadow Manifest',
        'current v2 investigation',
      ],
    },
    {
      path: 'packages/workflow-engine/spec.md',
      currentRequirements: [
        'Tracked Investigation Manifest Replays Deterministic Facts From Pinned Git',
        'strict replay contract',
        'materialized evidence view',
        'stable unsupported-schema contract',
        'Investigation v3 Is Manifest-First',
        'MUST NOT accept or first construct a schema-v1/v2 artifact',
        'Every v3 Failure Delegates Continuation to Central Grant Core',
        'publication/CAS, and recoverable crash-state classification',
      ],
      retiredPhrases: [
        'Tracked Investigation Evidence May Replay Deterministic Nodes From Pinned Git',
        'replay recipe',
        'replayed logical artifact',
        'complete node-set digest',
        'compact tracked projection',
        'During the v2 shadow interval',
        'Scenario: Legacy full artifact is loaded during v2 shadow',
        'Requirement: v2/v3 Shadow Is Independent and Non-Authoritative',
        'use v2 only as a parity oracle',
        'INVESTIGATION_V3_SHADOW_MISMATCH',
        'Engine-produced shadow failure enters central Grant Core',
        'private v3 shadow observation',
        'Central contract is not published for every v3 failure',
        'v2 authority, readers, and fallback remain in place',
      ],
    },
    {
      path: 'packages/workflow-engine/spec.md',
      currentRequirements: [
        'Whole-Change Documentation Closure',
        'For every managed change, the workflow engine SHALL require one authenticated',
        'TaskDiff review of the whole final change before final task completion',
        'commit recovery compares it with content-addressed report evidence',
        'CI and archive independently replay the closure from Git objects',
      ],
      retiredPhrases: [
        'documentation-closure activation marker',
        'activated final',
        'activated final candidate',
        'activated final review',
        'activated final task',
        'Scenario: Historical task predates activation',
        'predates activation',
        'valid without a documentation closure',
      ],
    },
  ] as const;

  for (const specification of specifications) {
    // Native test names can retain historical labels; metadata references do
    // not reinstate the retired normative behavior those tests now reject.
    const contents = fs
      .readFileSync(path.join(repositoryRoot, specification.path), 'utf8')
      .replace(/^(?:sources|covers|test):.*$/gmu, '');
    for (const currentRequirement of specification.currentRequirements) {
      assert.ok(
        contents.includes(currentRequirement),
        `${specification.path} must retain ${currentRequirement}`,
      );
    }
    for (const retiredPhrase of specification.retiredPhrases) {
      assert.equal(
        contents.includes(retiredPhrase),
        false,
        `${specification.path} must retire ${retiredPhrase}`,
      );
    }
  }
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
    'pnpm workflow task-preflight',
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
    'pnpm workflow task-preflight',
    'pnpm workflow open-task',
    'pnpm workflow finalize',
    'pnpm workflow status',
    'pnpm workflow check',
    'pnpm workflow ci',
    'pnpm workflow adapter evaluate',
    'pnpm workflow adapter availability-pilot',
    'pnpm workflow adapter verify-availability-pilot',
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
  assert.doesNotMatch(agents, /pnpm workflow issue\b/);
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
    assert.match(surface, /pnpm workflow task-preflight/);
    assert.match(surface, /pnpm workflow open-task/);
    assert.match(surface, /pnpm workflow finalize <session-id>/);
    assert.doesNotMatch(surface, /pnpm workflow finalize-task/);
  }
  assert.match(workflow, /propose → \[ open-task → finalize \]×N → archive/);
  assert.match(
    workflow,
    /task-preflight[\s\S]{0,240}read-only[\s\S]{0,240}(?:does not|doesn't|cannot)[\s\S]{0,120}(?:authorize|reserve|open)/i,
  );
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
    /compatible standalone completion lifecycle[\s\S]{0,240}check[\s\S]{0,120}complete-task[\s\S]{0,120}finish/i,
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
    'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
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
  const documentPolicySchema = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, 'workflow/schemas/document-policy.schema.json'),
      'utf8',
    ),
  ) as {
    properties: {
      documents: {
        additionalProperties: {
          properties: { enforcement: { enum: string[] } };
        };
      };
    };
  };

  assert.match(readme, /^# Jigwright Documentation$/m);
  assert.match(readme, /current-v3/i);
  assert.match(readme, /docs\/WORKFLOW\.md/);
  assert.match(readme, /SPEC_MAP\.md/);
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
  assert.ok(documentPolicy.documents['spec.md']);
  assert.ok(documentPolicy.documents['packages/workflow-engine/spec.md']);
  assert.ok(documentPolicy.documents['openspec/changes/**']);
  assert.equal(documentPolicy.documents['docs/REQUIREMENT_LOG.md'], undefined);
  assert.equal(documentPolicy.documents['docs/UPDATE_CHECKLIST.md'], undefined);
  assert.equal(
    documentPolicySchema.properties.documents.additionalProperties.properties.enforcement.enum.includes(
      'planned-supersession',
    ),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, 'docs/REQUIREMENT_LOG.md')),
    false,
  );
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, 'docs/UPDATE_CHECKLIST.md')),
    false,
  );
});
