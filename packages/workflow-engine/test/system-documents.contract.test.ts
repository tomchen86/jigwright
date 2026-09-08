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
