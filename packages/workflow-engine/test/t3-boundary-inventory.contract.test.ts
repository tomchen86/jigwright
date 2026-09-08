/** T3 boundary inventory, scanner behavior, and neutral workflow namespace contracts. */
import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE } from '../src/modules/authority/authority-application-receipt.ts';
import { AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE } from '../src/application/control-plane/maintainer-attestation.ts';
import { BLIND_SURVEY_OUTPUT_SCHEMA } from '../src/runtime/storage-journal/provider-invocation-store.ts';
import {
  COLLABORATION_GRANT_POLICY,
  DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
  TASK_DIFF_REVIEW_COLLABORATION_POLICY,
} from '../src/modules/authority/collaboration-grant.ts';
import { HUMAN_REVOCATION_SIGNATURE_NAMESPACE } from '../src/application/control-plane/human-revocation.ts';
import { MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE } from '../src/modules/authority/maintainer-grant-v2.ts';
import { ROLE_CONTEXT_SHARING_POLICY } from '../src/modules/authority/role-context-sharing-grant.ts';
import {
  TASK_DIFF_REVIEW_OUTPUT_SCHEMA,
  TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA,
} from '../src/modules/assurance/task-diff-review-artifact.ts';
import { TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE } from '../src/modules/authority/task-revision-approval.ts';
import { TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA } from '../src/modules/provider-orchestration/task-strategy-provider-contract.ts';
import {
  resolveAssetPath,
  digestText,
  repositoryRoot,
  compareText,
  ts,
  listRegularFiles,
} from './boundary-contract-fixture.ts';
import {
  T3_BOUNDARY_INVENTORY_FILE,
  EXPECTED_T3_BOUNDARY_INVENTORY_DIGEST,
  parseT3BoundaryInventory,
  EXPECTED_T3_COUPLING_IDS,
  assertBoundaryEvidence,
  assertNegativeEvidence,
  escapeRegex,
} from './t3-boundary-inventory-fixture.ts';
import {
  scanTypeScriptBoundaryLiterals,
  digestStaticFindings,
  scanWorkflowJsonNamespaces,
  summarizeJsonFindings,
  scanJsonSchemaIds,
  summarizeJsonSchemaIdHosts,
  digestJsonFindings,
  scanWorkflowArtifactPaths,
  scanT3BoundarySource,
} from './t3-boundary-scanner-fixture.ts';
import type { T3JsonStringFinding } from './t3-boundary-scanner-fixture.ts';

test('T3 boundary coupling inventory is tracked beside the frozen module map', () => {
  const inventoryPath = resolveAssetPath(
    process.env.WORKFLOW_ENGINE_T3_BOUNDARY_INVENTORY,
    T3_BOUNDARY_INVENTORY_FILE,
  );
  const inventorySource = fs.readFileSync(inventoryPath, 'utf8');
  assert.equal(
    digestText(inventorySource),
    EXPECTED_T3_BOUNDARY_INVENTORY_DIGEST,
  );
  const inventory = parseT3BoundaryInventory(inventorySource);
  assert.deepEqual(
    inventory.couplings.map((coupling) => coupling.id),
    EXPECTED_T3_COUPLING_IDS,
  );

  const sourceLiterals = scanTypeScriptBoundaryLiterals(
    repositoryRoot,
    'packages/workflow-engine/src',
    '.ts',
  );
  assert.deepEqual(
    {
      occurrences: sourceLiterals.namespace.length,
      fileCount: new Set(sourceLiterals.namespace.map((entry) => entry.path))
        .size,
      identityDigest: digestStaticFindings(sourceLiterals.namespace),
    },
    {
      occurrences: inventory.namespaceBaseline.sourceOccurrences,
      fileCount: inventory.namespaceBaseline.sourceFileCount,
      identityDigest: inventory.namespaceBaseline.sourceIdentityDigest,
    },
  );

  const scriptLiterals = scanTypeScriptBoundaryLiterals(
    repositoryRoot,
    'scripts',
    '.ts',
  );
  assert.deepEqual(
    {
      occurrences: scriptLiterals.workflowPaths.length,
      fileCount: new Set(
        scriptLiterals.workflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(scriptLiterals.workflowPaths),
    },
    {
      occurrences: inventory.workflowJsonReferenceBaseline.scriptsOccurrences,
      fileCount: inventory.workflowJsonReferenceBaseline.scriptsFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.scriptsIdentityDigest,
    },
  );
  assert.equal(
    scriptLiterals.namespace.length,
    0,
    'root scripts must not add a legacy workflow namespace',
  );
  assert.equal(
    scriptLiterals.splitWorkflowPaths.length,
    0,
    'root scripts must not add split workflow JSON paths',
  );
  assert.equal(
    scriptLiterals.dynamicWorkflowDirectories.length,
    0,
    'root scripts must not enumerate the workflow root dynamically',
  );

  const bootstrapLiterals = scanTypeScriptBoundaryLiterals(
    repositoryRoot,
    'packages/workflow-engine/bootstrap',
    '.ts',
  );
  assert.deepEqual(
    {
      occurrences: bootstrapLiterals.namespace.length,
      fileCount: new Set(bootstrapLiterals.namespace.map((entry) => entry.path))
        .size,
      identityDigest: digestStaticFindings(bootstrapLiterals.namespace),
    },
    {
      occurrences: inventory.namespaceBaseline.bootstrapOccurrences,
      fileCount: inventory.namespaceBaseline.bootstrapFileCount,
      identityDigest: inventory.namespaceBaseline.bootstrapIdentityDigest,
    },
  );

  const recoveryLiterals = scanTypeScriptBoundaryLiterals(
    repositoryRoot,
    'packages/workflow-engine/bootstrap/recovery-runtime/src',
    '.js',
  );
  assert.deepEqual(
    {
      occurrences: recoveryLiterals.namespace.length,
      fileCount: new Set(recoveryLiterals.namespace.map((entry) => entry.path))
        .size,
      identityDigest: digestStaticFindings(recoveryLiterals.namespace),
    },
    {
      occurrences: inventory.namespaceBaseline.recoveryOccurrences,
      fileCount: inventory.namespaceBaseline.recoveryFileCount,
      identityDigest: inventory.namespaceBaseline.recoveryIdentityDigest,
    },
  );
  assert.deepEqual(
    {
      occurrences: recoveryLiterals.workflowPaths.length,
      fileCount: new Set(
        recoveryLiterals.workflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(recoveryLiterals.workflowPaths),
    },
    {
      occurrences: inventory.workflowJsonReferenceBaseline.recoveryOccurrences,
      fileCount: inventory.workflowJsonReferenceBaseline.recoveryFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.recoveryIdentityDigest,
    },
  );
  assert.deepEqual(
    {
      occurrences: recoveryLiterals.splitWorkflowPaths.length,
      fileCount: new Set(
        recoveryLiterals.splitWorkflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(recoveryLiterals.splitWorkflowPaths),
    },
    {
      occurrences:
        inventory.workflowJsonReferenceBaseline
          .recoverySplitPathJoinOccurrences,
      fileCount:
        inventory.workflowJsonReferenceBaseline.recoverySplitPathJoinFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline
          .recoverySplitPathJoinIdentityDigest,
    },
  );
  assert.equal(
    recoveryLiterals.dynamicWorkflowDirectories.length,
    0,
    'generated recovery runtime must not enumerate the workflow root dynamically',
  );

  const workflowJsonNamespaces = scanWorkflowJsonNamespaces(repositoryRoot);
  assert.deepEqual(summarizeJsonFindings(workflowJsonNamespaces), {
    occurrences: inventory.namespaceBaseline.workflowJsonOccurrences,
    fileCount: inventory.namespaceBaseline.workflowJsonFileCount,
    identityDigest: inventory.namespaceBaseline.workflowJsonIdentityDigest,
  });
  const jsonSchemaIds = scanJsonSchemaIds(repositoryRoot);
  assert.deepEqual(
    {
      hosts: summarizeJsonSchemaIdHosts(jsonSchemaIds),
      identityDigest: digestJsonFindings(jsonSchemaIds),
    },
    {
      hosts: inventory.namespaceBaseline.jsonSchemaIdHosts,
      identityDigest: inventory.namespaceBaseline.jsonSchemaIdIdentityDigest,
    },
  );

  assert.deepEqual(
    {
      occurrences: sourceLiterals.workflowPaths.length,
      fileCount: new Set(
        sourceLiterals.workflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(sourceLiterals.workflowPaths),
      uniqueLiterals: [
        ...new Set(
          sourceLiterals.workflowPaths.map((entry) => entry.normalizedValue),
        ),
      ].sort(compareText),
    },
    {
      occurrences: inventory.workflowJsonReferenceBaseline.sourceOccurrences,
      fileCount: inventory.workflowJsonReferenceBaseline.sourceFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.sourceIdentityDigest,
      uniqueLiterals: inventory.workflowJsonReferenceBaseline.uniqueLiterals,
    },
  );

  assert.deepEqual(
    {
      occurrences: bootstrapLiterals.workflowPaths.length,
      fileCount: new Set(
        bootstrapLiterals.workflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(bootstrapLiterals.workflowPaths),
    },
    {
      occurrences: inventory.workflowJsonReferenceBaseline.bootstrapOccurrences,
      fileCount: inventory.workflowJsonReferenceBaseline.bootstrapFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.bootstrapIdentityDigest,
    },
  );
  assert.equal(
    bootstrapLiterals.splitWorkflowPaths.length,
    0,
    'bootstrap TypeScript must not add split workflow JSON paths',
  );
  assert.equal(
    bootstrapLiterals.dynamicWorkflowDirectories.length,
    0,
    'bootstrap TypeScript must not enumerate the workflow root dynamically',
  );

  assert.deepEqual(
    {
      occurrences: sourceLiterals.splitWorkflowPaths.length,
      fileCount: new Set(
        sourceLiterals.splitWorkflowPaths.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(sourceLiterals.splitWorkflowPaths),
    },
    {
      occurrences:
        inventory.workflowJsonReferenceBaseline.splitPathJoinOccurrences,
      fileCount: inventory.workflowJsonReferenceBaseline.splitPathJoinFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.splitPathJoinIdentityDigest,
    },
  );

  const workflowArtifactPaths = scanWorkflowArtifactPaths(repositoryRoot);
  assert.deepEqual(summarizeJsonFindings(workflowArtifactPaths), {
    occurrences: inventory.workflowArtifactPathBaseline.occurrences,
    fileCount: inventory.workflowArtifactPathBaseline.fileCount,
    identityDigest: inventory.workflowArtifactPathBaseline.identityDigest,
  });
  assert.deepEqual(
    {
      occurrences: sourceLiterals.dynamicWorkflowDirectories.length,
      fileCount: new Set(
        sourceLiterals.dynamicWorkflowDirectories.map((entry) => entry.path),
      ).size,
      identityDigest: digestStaticFindings(
        sourceLiterals.dynamicWorkflowDirectories,
      ),
    },
    {
      occurrences:
        inventory.workflowJsonReferenceBaseline.dynamicDirectoryOccurrences,
      fileCount:
        inventory.workflowJsonReferenceBaseline.dynamicDirectoryFileCount,
      identityDigest:
        inventory.workflowJsonReferenceBaseline.dynamicDirectoryIdentityDigest,
    },
  );

  for (const coupling of inventory.couplings) {
    for (const evidence of coupling.evidence) {
      assertBoundaryEvidence(repositoryRoot, coupling.id, evidence);
    }
    if (coupling.state === 'missing') {
      assert.ok(
        coupling.negativeEvidence,
        `${coupling.id} needs two-method negative evidence`,
      );
    }
    if (coupling.negativeEvidence !== null) {
      assert.ok(
        coupling.state === 'missing' || coupling.state === 'partial',
        `${coupling.id} negative evidence is only valid for a missing or partial surface`,
      );
      assertNegativeEvidence(
        repositoryRoot,
        coupling.id,
        coupling.negativeEvidence,
      );
    }
  }

  const architectureDocument = path.join(
    repositoryRoot,
    inventory.architectureDocument,
  );
  const architectureSource = fs.readFileSync(architectureDocument, 'utf8');
  for (const couplingId of EXPECTED_T3_COUPLING_IDS) {
    assert.match(
      architectureSource,
      new RegExp(`<!-- coupling:${escapeRegex(couplingId)} -->`, 'u'),
    );
  }
});

test('T3 scanner finds syntax-bound direct, split, and dynamic workflow paths', () => {
  const source = [
    "import nodePath from 'node:path';",
    "import { readdirSync as listDirectory } from 'node:fs';",
    "const exact = 'workflow/exact.json';",
    "const embedded = 'HEAD:workflow/embedded.json';",
    'const suffix = getSuffix();',
    'const template = `prefix:workflow/template.json:${suffix}`;',
    "const folded = 'workflow/' + 'folded.json';",
    "const sentence = 'Unable to read workflow/sentence.json.';",
    "const workflowRoot = nodePath.join(repositoryRoot, 'workflow');",
    "const joined = nodePath.join(workflowRoot, 'joined.json');",
    "const sameCall = nodePath.resolve(repositoryRoot, 'workflow', 'same.json');",
    'const entries = listDirectory(workflowRoot);',
    "const nearPrefix = 'myworkflow/not-a-match.json';",
    "const nearSuffix = 'workflow/not-a-match.json.bak';",
    "const nested = 'workflow/nested/not-a-match.json';",
    "// nodePath.join(repositoryRoot, 'workflow', 'comment.json');",
    "// listDirectory(nodePath.join(repositoryRoot, 'workflow'));",
  ].join('\n');

  const findings = scanT3BoundarySource(
    ts,
    'synthetic/t3-scanner.ts',
    source,
    '.ts',
  );

  assert.deepEqual(
    findings.workflowPaths.map((finding) => finding.normalizedValue).sort(),
    [
      'workflow/embedded.json',
      'workflow/exact.json',
      'workflow/folded.json',
      'workflow/sentence.json',
      'workflow/template.json',
    ],
  );
  assert.deepEqual(
    findings.splitWorkflowPaths
      .map((finding) => finding.normalizedValue)
      .sort(),
    ['workflow/joined.json', 'workflow/same.json'],
  );
  assert.deepEqual(
    findings.dynamicWorkflowDirectories.map(
      (finding) => finding.normalizedValue,
    ),
    ['workflow/'],
  );

  const sameCountReplacement = scanT3BoundarySource(
    ts,
    'synthetic/t3-scanner.ts',
    source.replace('workflow/exact.json', 'workflow/other.json'),
    '.ts',
  );
  assert.equal(
    sameCountReplacement.workflowPaths.length,
    findings.workflowPaths.length,
  );
  assert.notEqual(
    digestStaticFindings(sameCountReplacement.workflowPaths),
    digestStaticFindings(findings.workflowPaths),
  );
});

test('T3 scanner follows imported aliases and rejects shadowed lookalikes', () => {
  const first = scanT3BoundarySource(
    ts,
    'synthetic/alias.ts',
    [
      "import nodePath from 'node:path';",
      "import nodeFs from 'node:fs';",
      "const workflowRoot = nodePath.join(input.repositoryRoot, 'workflow');",
      "const policy = nodePath.join(workflowRoot, 'config.json');",
      'const entries = nodeFs.readdirSync(workflowRoot);',
    ].join('\n'),
    '.ts',
  );
  const renamed = scanT3BoundarySource(
    ts,
    'synthetic/alias.ts',
    [
      "import p from 'node:path';",
      "import fsApi from 'node:fs';",
      "const root = p.join(input.repositoryRoot, 'workflow');",
      "const policy = p.join(root, 'config.json');",
      'const entries = fsApi.readdirSync(root);',
    ].join('\n'),
    '.ts',
  );
  assert.equal(
    digestStaticFindings(first.splitWorkflowPaths),
    digestStaticFindings(renamed.splitWorkflowPaths),
  );
  assert.equal(
    digestStaticFindings(first.dynamicWorkflowDirectories),
    digestStaticFindings(renamed.dynamicWorkflowDirectories),
  );

  const shadowed = scanT3BoundarySource(
    ts,
    'synthetic/shadowed.ts',
    [
      "import p from 'node:path';",
      'function run(p: FakePath) {',
      "  return p.join(repositoryRoot, 'workflow', 'fake.json');",
      '}',
    ].join('\n'),
    '.ts',
  );
  assert.equal(shadowed.splitWorkflowPaths.length, 0);

  const destructuredShadow = scanT3BoundarySource(
    ts,
    'synthetic/destructured-shadow.ts',
    [
      "import p from 'node:path';",
      'function run() {',
      '  const { p } = fakePathApi;',
      "  return p.join(repositoryRoot, 'workflow', 'fake.json');",
      '}',
    ].join('\n'),
    '.ts',
  );
  assert.equal(destructuredShadow.splitWorkflowPaths.length, 0);

  const functionScopedVar = scanT3BoundarySource(
    ts,
    'synthetic/var-shadow.ts',
    [
      "import p from 'node:path';",
      'function run() {',
      '  if (condition) { var p = fakePathApi; }',
      "  return p.join(repositoryRoot, 'workflow', 'fake.json');",
      '}',
    ].join('\n'),
    '.ts',
  );
  assert.equal(functionScopedVar.splitWorkflowPaths.length, 0);

  const fakeRepositoryRoot = scanT3BoundarySource(
    ts,
    'synthetic/fake-root.ts',
    [
      "import p from 'node:path';",
      "const repositoryRoot = '/tmp/not-the-repository';",
      "const policy = p.join(repositoryRoot, 'workflow', 'fake.json');",
    ].join('\n'),
    '.ts',
  );
  assert.equal(fakeRepositoryRoot.splitWorkflowPaths.length, 0);

  const inlineDynamic = scanT3BoundarySource(
    ts,
    'synthetic/inline.ts',
    [
      "import p from 'node:path';",
      "import fsApi from 'node:fs';",
      "const entries = fsApi.promises.readdir(p.resolve(repositoryRoot, 'workflow'));",
    ].join('\n'),
    '.ts',
  );
  assert.deepEqual(
    inlineDynamic.dynamicWorkflowDirectories.map(
      (finding) => finding.syntaxForm,
    ),
    ['fs-readdir'],
  );

  const promisesImport = scanT3BoundarySource(
    ts,
    'synthetic/promises.ts',
    [
      "import p from 'node:path';",
      "import fsPromises from 'node:fs/promises';",
      "const entries = fsPromises.readdir(p.join(repositoryRoot, 'workflow'));",
    ].join('\n'),
    '.ts',
  );
  assert.equal(promisesImport.dynamicWorkflowDirectories.length, 1);

  const invalidPromisesSync = scanT3BoundarySource(
    ts,
    'synthetic/promises-sync.ts',
    [
      "import p from 'node:path';",
      "import fsPromises from 'node:fs/promises';",
      "const entries = fsPromises.readdirSync(p.join(repositoryRoot, 'workflow'));",
    ].join('\n'),
    '.ts',
  );
  assert.equal(invalidPromisesSync.dynamicWorkflowDirectories.length, 0);

  const propertyAliases = scanT3BoundarySource(
    ts,
    'synthetic/property-aliases.ts',
    [
      "import p from 'node:path';",
      "import fsApi from 'node:fs';",
      'const fsPromises = fsApi.promises;',
      "const entries = fsPromises.readdir(p.posix.join(repositoryRoot, 'workflow'));",
    ].join('\n'),
    '.ts',
  );
  assert.equal(propertyAliases.dynamicWorkflowDirectories.length, 1);

  const namedPropertyImports = scanT3BoundarySource(
    ts,
    'synthetic/named-property-imports.ts',
    [
      "import { posix as pathApi } from 'node:path';",
      "import { promises as fsPromises } from 'node:fs';",
      "const entries = fsPromises.readdir(pathApi.join(repositoryRoot, 'workflow'));",
    ].join('\n'),
    '.ts',
  );
  assert.equal(namedPropertyImports.dynamicWorkflowDirectories.length, 1);

  const destructuredRoot = scanT3BoundarySource(
    ts,
    'synthetic/destructured-root.ts',
    [
      "import p from 'node:path';",
      'const { repositoryRoot } = input;',
      "const policy = p.join(repositoryRoot, 'workflow', 'config.json');",
    ].join('\n'),
    '.ts',
  );
  assert.equal(destructuredRoot.splitWorkflowPaths.length, 1);
});

test('T3 scanner records folded namespaces and dynamic fragments', () => {
  const findings = scanT3BoundarySource(
    ts,
    'synthetic/namespaces.ts',
    [
      "const exact = 'expense-app.workflow.exact.v1';",
      "const folded = 'expense-app.workflow.' + 'folded.v1';",
      "const wrapped = ('expense-app.workflow.' as const) + 'wrapped.v1';",
      "const suffix = 'template.v1';",
      'const staticTemplate = `expense-app.workflow.${suffix}`;',
      'const dynamic = `expense-app.workflow.${kind}`;',
      "// const ignored = 'expense-app.workflow.comment.v1';",
    ].join('\n'),
    '.ts',
  );
  assert.deepEqual(
    findings.namespace.map((finding) => finding.normalizedValue).sort(),
    [
      'expense-app.workflow.',
      'expense-app.workflow.exact.v1',
      'expense-app.workflow.folded.v1',
      'expense-app.workflow.template.v1',
      'expense-app.workflow.wrapped.v1',
    ],
  );
});

test('T3 JSON identity catches same-host replacements and canonicalizes finding order', () => {
  const schemaIds: T3JsonStringFinding[] = [
    {
      path: 'workflow/schemas/first.schema.json',
      jsonPointer: '/$id',
      normalizedValue: 'https://expense-app.local/workflow/first.schema.json',
    },
    {
      path: 'workflow/schemas/second.schema.json',
      jsonPointer: '/$id',
      normalizedValue: 'https://expense-app.local/workflow/second.schema.json',
    },
  ];
  const replacement = schemaIds.map((finding, index) =>
    index === 0
      ? {
          ...finding,
          normalizedValue:
            'http://expense-app.local/workflow/replaced.schema.json',
        }
      : finding,
  );
  assert.deepEqual(
    summarizeJsonSchemaIdHosts(replacement),
    summarizeJsonSchemaIdHosts(schemaIds),
  );
  assert.notEqual(
    digestJsonFindings(replacement),
    digestJsonFindings(schemaIds),
  );
  assert.equal(
    digestJsonFindings([...schemaIds].reverse()),
    digestJsonFindings(schemaIds),
  );
});

test('every live workflow identity writer emits the neutral versioned namespace', () => {
  assert.deepEqual(
    {
      authorityApplicationReceipt:
        AUTHORITY_APPLICATION_RECEIPT_SIGNATURE_NAMESPACE,
      authorityAttestation: AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE,
      blindSurvey: BLIND_SURVEY_OUTPUT_SCHEMA.id,
      collaborationPolicy: COLLABORATION_GRANT_POLICY.policyId,
      directHumanReview: DIRECT_HUMAN_REVIEW_SIGNATURE_NAMESPACE,
      humanRevocation: HUMAN_REVOCATION_SIGNATURE_NAMESPACE,
      maintainerGrant: MAINTAINER_GRANT_V2_SIGNATURE_NAMESPACE,
      roleContextSharingPolicy: ROLE_CONTEXT_SHARING_POLICY.policyId,
      taskDiffReview: TASK_DIFF_REVIEW_OUTPUT_SCHEMA.id,
      taskDiffReviewContinuation:
        TASK_DIFF_REVIEW_CONTINUATION_OUTPUT_SCHEMA.id,
      taskDiffReviewPolicy: TASK_DIFF_REVIEW_COLLABORATION_POLICY.policyId,
      taskRevisionApproval: TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
      taskStrategyImplementation: TASK_STRATEGY_IMPLEMENTATION_OUTPUT_SCHEMA.id,
    },
    {
      authorityApplicationReceipt: 'workflow.authority-application-receipt.v1',
      authorityAttestation: 'workflow.authority-attestation.v1',
      blindSurvey: 'workflow.blind-survey-output.v1',
      collaborationPolicy: 'workflow.collaboration-policy.v1',
      directHumanReview: 'workflow.direct-human-review.v1',
      humanRevocation: 'workflow.human-revocation.v1',
      maintainerGrant: 'workflow.maintainer-grant.v2',
      roleContextSharingPolicy: 'workflow.role-context-sharing-policy.v1',
      taskDiffReview: 'workflow.task-diff-review-output.v1',
      taskDiffReviewContinuation:
        'workflow.task-diff-review-continuation-output.v1',
      taskDiffReviewPolicy: 'workflow.collaboration-policy.task-diff-review.v1',
      taskRevisionApproval: 'workflow.task-revision-approval.v1',
      taskStrategyImplementation:
        'workflow.task-strategy-implementation-output.v1',
    },
  );
});

test('consumer-branded workflow identities are absent from package source', () => {
  const observed = new Map<string, string[]>();
  for (const packageEntry of fs.readdirSync(
    path.join(repositoryRoot, 'packages'),
    { withFileTypes: true },
  )) {
    if (!packageEntry.isDirectory()) continue;
    const sourceRoot = `packages/${packageEntry.name}/src`;
    if (
      !fs
        .statSync(path.join(repositoryRoot, sourceRoot), {
          throwIfNoEntry: false,
        })
        ?.isDirectory()
    ) {
      continue;
    }
    for (const file of listRegularFiles(repositoryRoot, sourceRoot)) {
      if (!/\.[cm]?[jt]s$/u.test(file)) continue;
      const findings = scanT3BoundarySource(
        ts,
        file,
        fs.readFileSync(path.join(repositoryRoot, file), 'utf8'),
        path.extname(file),
      ).namespace;
      if (findings.length > 0) {
        observed.set(
          file,
          findings.map(({ normalizedValue }) => normalizedValue).sort(),
        );
      }
    }
  }

  assert.deepEqual(
    Object.fromEntries(
      [...observed].sort(([left], [right]) => left.localeCompare(right)),
    ),
    {},
  );
});
