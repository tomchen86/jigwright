import assert from 'node:assert/strict';
import test from 'node:test';
import { createGovernanceSourceV1 } from '@jigwright/core/governance-source';
import { inspectSystemDocuments } from '../src/modules/source/system-documents.ts';
import { systemDocumentProjectionBindings } from '../src/modules/projection/system-document-projections.ts';
import { createProjectionService } from '../src/modules/projection/projection-service.ts';

const source = createGovernanceSourceV1({
  semanticAuthor: 'maintainer',
  capturedBy: 'jigwright',
  capturedAt: '2026-09-08T00:00:00.000Z',
  contextRef: 'direct-human:system-docs-test',
  text: 'Preserve the original wording.\n',
  supersedes: null,
});
const sourcePath = `workflow/source-ledger/objects/sha256/${source.id.slice(4, 6)}/${source.id.slice(4)}.json`;
const specPath = 'src/modules/intake/spec.md';
const spec = [
  '# Intake',
  '## Purpose',
  'Preserve original wording.',
  '## Requirements',
  '### Requirement: Preserve wording',
  `sources: [${source.id}]`,
  'The engine SHALL keep the text.',
  '#### Scenario: Exact text',
  'covers: intake.ts#Invariants[1]',
  'test: test/intake.test.ts#exact text',
  '- **WHEN** captured',
  '- **THEN** unchanged',
  '',
].join('\n');

function fixture() {
  const files = new Map([
    [specPath, spec],
    [sourcePath, JSON.stringify(source)],
    [
      'src/modules/intake/intake.ts',
      '/** Capture text.\n * Invariants:\n * - Preserve all input bytes.\n */\nexport const capture = (s: string) => s;',
    ],
    ['test/intake.test.ts', "test('exact text', () => {});"],
  ]);
  return {
    files,
    snapshot: {
      listPaths: () => [...files.keys()],
      readText: (p: string) => files.get(p),
    },
  };
}

test('documents join containing specs, Sources, file invariants and exact passing tests', () => {
  const { files, snapshot } = fixture();
  const observed: string[] = [];
  const report = inspectSystemDocuments(snapshot, (file, name) => {
    observed.push(`${file}#${name}`);
    return 'passed';
  });
  assert.deepEqual(report.issues, []);
  assert.deepEqual(observed, ['test/intake.test.ts#exact text']);
  assert.equal(report.scenarios[0]!.outcome, 'passed');
  files.set(
    specPath,
    spec.replace('intake.ts#Invariants[1]', '#Requirement: Preserve wording'),
  );
  assert.deepEqual(inspectSystemDocuments(snapshot, () => 'passed').issues, []);
});

test('documents reject dangling references, missing coverage, TBD purpose and non-passing evidence', () => {
  for (const [name, poison, expected] of [
    [
      'missing Source',
      (f: Map<string, string>) => f.delete(sourcePath),
      'source-missing',
    ],
    [
      'missing sources',
      (f: Map<string, string>) =>
        f.set(specPath, spec.replace(`sources: [${source.id}]`, '')),
      'sources-missing',
    ],
    [
      'missing test',
      (f: Map<string, string>) =>
        f.set(
          specPath,
          spec.replace('test: test/intake.test.ts#exact text', ''),
        ),
      'test-missing',
    ],
    [
      'missing file',
      (f: Map<string, string>) => f.delete('test/intake.test.ts'),
      'test-path-missing',
    ],
    [
      'missing invariant',
      (f: Map<string, string>) =>
        f.set(specPath, spec.replace('Invariants[1]', 'Invariants[2]')),
      'covers-invalid',
    ],
    [
      'missing shared requirement',
      (f: Map<string, string>) =>
        f.set(
          specPath,
          spec.replace('intake.ts#Invariants[1]', '#Requirement: Unknown'),
        ),
      'covers-invalid',
    ],
    [
      'TBD Purpose',
      (f: Map<string, string>) =>
        f.set(specPath, spec.replace('Preserve original wording.', 'TBD')),
      'purpose-missing',
    ],
    [
      'unowned module',
      (f: Map<string, string>) =>
        f.set('src/modules/other/a.ts', 'export const a = 1;'),
      'spec-missing',
    ],
  ] as const) {
    const { files, snapshot } = fixture();
    poison(files);
    assert.ok(
      inspectSystemDocuments(snapshot, () => 'passed').issues.some(
        (issue) => issue.code === expected,
      ),
      name,
    );
  }
  for (const outcome of [
    'missing',
    'stale',
    'not-passed',
    'skipped',
    'todo',
  ] as const) {
    const { snapshot } = fixture();
    assert.ok(
      inspectSystemDocuments(snapshot, () => outcome).issues.some(
        (issue) => issue.code === 'test-not-passed',
      ),
      outcome,
    );
  }
  assert.ok(
    inspectSystemDocuments(fixture().snapshot).issues.some(
      (issue) => issue.code === 'test-not-passed',
    ),
  );
});

test('system document projections share the registry and print wording without opaque identities', () => {
  const { snapshot, files } = fixture();
  const report = inspectSystemDocuments(snapshot, () => 'passed');
  const output = new Map<string, string>();
  const service = createProjectionService(
    systemDocumentProjectionBindings(report, {
      'R-001': { title: 'Original wording', sourceRefs: [source.id] },
    }),
    {
      read: (file) => output.get(file) ?? null,
      write: (file, content) => {
        output.set(file, content);
      },
    },
  );
  for (const id of [
    'documents.spec-map',
    'documents.coverage',
    'documents.requirements',
  ] as const)
    service.project(id);
  assert.ok(
    output.get('docs/SPEC_MAP.md')!.includes('src/modules/intake/spec.md'),
  );
  assert.ok(output.get('docs/COVERAGE.md')!.includes('exact text'));
  assert.ok(output.get('docs/COVERAGE.md')!.includes('passed'));
  assert.ok(
    output
      .get('docs/REQUIREMENTS.md')!
      .includes('> Preserve the original wording.'),
  );
  for (const content of output.values())
    assert.doesNotMatch(content, /(?:SRC|WORK|FND)-[A-Za-z0-9]+/);
  assert.ok(service.status().every((row) => row.state === 'current'));
  output.set('docs/COVERAGE.md', 'incorrect');
  assert.equal(
    service.status().find((row) => row.id === 'documents.coverage')!.state,
    'drifted',
  );
});

test('coverage exposes unlinked wording, unowned source directories and requirements without Sources', () => {
  const { files, snapshot } = fixture();
  const orphan = createGovernanceSourceV1({
    ...source,
    text: 'Keep <original> | wording.\nIncluding the next line.',
  });
  const scenarioOnly = createGovernanceSourceV1({
    ...source,
    text: 'This wording is linked by a scenario.',
  });
  for (const record of [orphan, scenarioOnly])
    files.set(
      `workflow/source-ledger/objects/sha256/${record.id.slice(4, 6)}/${record.id.slice(4)}.json`,
      JSON.stringify(record),
    );
  files.set(
    specPath,
    spec.replace(
      '#### Scenario: Exact text',
      `#### Scenario: Exact text\nsources: [${scenarioOnly.id}]`,
    ) +
      '\n### Requirement: Missing provenance\nThe engine SHALL explain its provenance.\n',
  );
  files.set('src/adapters/unowned/client.ts', 'export const client = 1;');
  files.set('packages/core/src/value.ts', 'export const value = 1;');
  files.set('test/unowned/helper.ts', 'export const helper = 1;');
  files.set('dist/unowned/index.js', 'export const generated = 1;');
  const render = () => {
    const report = inspectSystemDocuments(snapshot, () => 'passed');
    const output = new Map<string, string>();
    createProjectionService(systemDocumentProjectionBindings(report), {
      read: (file) => output.get(file) ?? null,
      write: (file, content) => {
        output.set(file, content);
      },
    }).project('documents.coverage');
    return { report, content: output.get('docs/COVERAGE.md')! };
  };
  const { report, content } = render();
  assert.equal(report.sources.get(orphan.id)?.text, orphan.text);
  assert.deepEqual(
    report.documentation?.find(({ path }) => path === 'src/modules/intake'),
    {
      path: 'src/modules/intake',
      kind: 'module',
      specPath,
      readmePath: null,
      files: 1,
      headers: 1,
      invariantHeaders: 1,
    },
  );
  assert.deepEqual(
    report.documentation?.find(({ path }) => path === 'packages/core'),
    {
      path: 'packages/core',
      kind: 'package',
      specPath: null,
      readmePath: null,
      files: 1,
      headers: 0,
      invariantHeaders: 0,
    },
  );
  for (const heading of [
    'Sources without a linked contract',
    'Directories without a governing contract',
    'Requirements without Sources',
    'Scenario coverage',
  ])
    assert.ok(content.includes(`## ${heading}`), heading);
  assert.match(
    content,
    /Keep &lt;original&gt; \\\| wording\.<br>Including the next line\./,
  );
  assert.doesNotMatch(content, /This wording is linked by a scenario/);
  assert.match(content, /src\/adapters\/unowned/);
  assert.match(content, /packages\/core\/src/);
  assert.doesNotMatch(content, /test\/unowned|dist\/unowned/);
  assert.match(content, /Missing provenance/);
  assert.match(content, /exact text/);
  assert.doesNotMatch(
    content,
    /(?:SRC|WORK|FND)-[A-Za-z0-9]+|sha256:[0-9a-f]+/,
  );

  files.set(
    'spec.md',
    spec.replace('intake.ts#Invariants[1]', '#Requirement: Preserve wording'),
  );
  const inherited = render().content;
  const ownership = inherited
    .split('## Directories without a governing contract')[1]!
    .split('## ')[0]!;
  assert.match(ownership, /None\./);
  assert.doesNotMatch(ownership, /src\/adapters\/unowned|packages\/core\/src/);

  files.set(
    specPath,
    files
      .get(specPath)!
      .replace(
        '### Requirement: Missing provenance',
        `### Requirement: Missing provenance\nsources: [${orphan.id}]`,
      ),
  );
  const resolved = render().content;
  for (const heading of [
    'Sources without a linked contract',
    'Requirements without Sources',
  ])
    assert.match(
      resolved.split(`## ${heading}`)[1]!.split('## ')[0]!,
      /None\./,
    );
});
