import assert from 'node:assert/strict';
import test from 'node:test';
import type { TrackedObjectSnapshotV1 } from '@jigwright/core/tracked-object-reader-port';
import { ExitCode, WorkflowError } from '../src/foundation/errors/errors.ts';
import {
  classifyMutationPath,
  type ReviewedGeneratedAssetInventory,
} from '../src/modules/source/mutation-class-policy.ts';
import { deriveReviewedMutationClassPolicy } from '../src/modules/source/reviewed-mutation-policy.ts';

const inventory: ReviewedGeneratedAssetInventory = Object.freeze({
  manifestPath: '.jigwright/assets.json',
  assets: Object.freeze([
    Object.freeze({
      destinationPath: '.jigwright/generated.md',
      mirrorOf: null,
    }),
    Object.freeze({
      destinationPath: 'AGENTS.md',
      mirrorOf: '.jigwright/generated.md',
    }),
  ]),
});
const documents = {
  '.jigwright/**': { mode: 'generated' },
  'generated/**': { mode: 'generated' },
  'CHANGELOG.md': { mode: 'append-only' },
  'archive/**': { mode: 'immutable' },
  'openspec/changes/**': { mode: 'change-artifact' },
  'reference/**': { mode: 'reference' },
  'docs/curated.md': { mode: 'curated' },
  'docs/spec.md': { mode: 'normative' },
};
const paths = [
  '.jigwright/generated.md',
  '.jigwright/assets.json',
  'AGENTS.md',
  'generated/a.md',
  'CHANGELOG.md',
  'archive/a.md',
  'openspec/changes/demo/tasks.md',
  'reference/a.md',
  'docs/curated.md',
  'docs/spec.md',
  'src/a.ts',
];
const emptyInventory: ReviewedGeneratedAssetInventory = {
  manifestPath: 'manifest.json',
  assets: [],
};

test('reviewed policy derives pinned classifications and golden identities without mutating core snapshot values', () => {
  const snapshot = snapshotFor(documents, paths);
  const before = structuredClone(snapshot);
  const assetsBefore = structuredClone(inventory);
  const policy = deriveReviewedMutationClassPolicy(inventory, snapshot);

  // Captured from d0f5e4c before relocating the runtime implementation.
  assert.equal(
    policy.policyDigest,
    '23c858ccf7da90f0d4dc762620b9631be79705d00711fde59382b93cad07c615',
  );
  assert.deepEqual(
    policy.rules.map((rule) => [
      rule.selector.kind === 'exact-path' ? rule.selector.path : null,
      rule.mutationClass,
      rule.ruleId,
    ]),
    [
      [
        'AGENTS.md',
        'mirror',
        '01c3aa55b9b2fc2ce3c3d90b7894bbc9dd63fa4caefce53b84ea2817da9aa7b5',
      ],
      [
        'openspec/changes/demo/tasks.md',
        'immutable',
        '38c8f4844b2d68dca90d37390d2c0fb03ebc64bacaac969533f207c1cf286cee',
      ],
      [
        'reference/a.md',
        'historical-reference',
        '68c085d0c913fd13df26d3c5df3a2479818f8275456e348622ed5d8a5af789bb',
      ],
      [
        'CHANGELOG.md',
        'append-only',
        '87c84a42a3365cc1d0e6a6fcc3d88da79fe8f6206427710a2a7f1e3047b43f7d',
      ],
      [
        'archive/a.md',
        'immutable',
        '8f4393a8f7416a2323bc8cd1ccf8d7f7749c746dea422b1f421a5b8c1c9f751f',
      ],
      [
        '.jigwright/assets.json',
        'generated',
        'a10c9cc0f39584494f448f90d98255c6e377b0c07cea43490d36abfb9cb4c481',
      ],
      [
        'generated/a.md',
        'generated',
        'abc3148f1155e24721453c50071d484856579872dec31640ffced2fc5cab9fba',
      ],
      [
        '.jigwright/generated.md',
        'generated',
        'fb7c87c43a7760d975423ad8263f260e01c49c45d1de3dc698997d6f0f07cdbb',
      ],
    ].map(([file, mode, digest]) => [
      file,
      mode,
      `reviewed-mutation:${digest}`,
    ]),
  );
  for (const file of ['docs/curated.md', 'docs/spec.md', 'src/a.ts']) {
    assert.equal(
      classifyMutationPath(policy, identity(file)).mutationClass,
      'live',
    );
  }
  assert.equal(
    classifyMutationPath(policy, { rawBase64: '/w==', utf8: null })
      .mutationClass,
    'live',
  );
  assert.deepEqual(snapshot, before);
  assert.deepEqual(inventory, assetsBefore);
});

test('nonoverlapping input order and duplicate assets do not change canonical policy identity', () => {
  const expected = deriveReviewedMutationClassPolicy(
    inventory,
    snapshotFor(documents, paths),
  );
  assert.deepEqual(
    deriveReviewedMutationClassPolicy(
      {
        ...inventory,
        assets: [...inventory.assets].reverse().concat(inventory.assets),
      },
      snapshotFor(
        Object.fromEntries(Object.entries(documents).reverse()),
        [...paths].reverse(),
      ),
    ),
    expected,
  );
});

test('overlapping document rules retain the first source for each class and path', () => {
  const broadFirst = {
    'docs/**': { mode: 'reference' },
    'docs/a.md': { mode: 'reference' },
  };
  for (const [entries, digest, ruleDigest] of [
    [
      broadFirst,
      'a8f13c035c7e859f49849d7a323288e1356bd8e0e968687104501e7c53b44a96',
      'fdde59271252521fd815fd673d289ef9cc43e8626ab6b9882647014be70c7555',
    ],
    [
      Object.fromEntries(Object.entries(broadFirst).reverse()),
      '33c2a6d0e189927c9a10cf5e9c9979e6f55c8f6a5959cf2d3485e6a13b655071',
      'ee0f8c4e4cdc9ef0975227e0105ca8e6c4fd7fcaf894fe486a576c4dd7e50ecc',
    ],
  ] as const) {
    const policy = deriveReviewedMutationClassPolicy(
      emptyInventory,
      snapshotFor(entries, ['docs/a.md']),
    );
    assert.equal(policy.policyDigest, digest);
    assert.equal(policy.rules.length, 2);
    assert.equal(
      policy.rules.find((rule) => rule.mutationClass === 'historical-reference')
        ?.ruleId,
      `reviewed-mutation:${ruleDigest}`,
    );
    assert.equal(
      classifyMutationPath(policy, identity('docs/a.md')).mutationClass,
      'historical-reference',
    );
  }
});

test('document selectors only classify tracked UTF-8 paths while provider asset rules remain explicit', () => {
  const policy = deriveReviewedMutationClassPolicy(
    inventory,
    snapshotFor(
      {
        'untracked.md': { mode: 'immutable' },
        'docs/*': { mode: 'reference', existingMetadata: 'permitted' },
      },
      ['docs/a.md', 'docs/deep/b.md'],
    ),
  );
  for (const [file, mode] of [
    ['untracked.md', 'live'],
    ['docs/a.md', 'historical-reference'],
    ['docs/deep/b.md', 'live'],
    ['.jigwright/generated.md', 'generated'],
    ['AGENTS.md', 'mirror'],
    ['.jigwright/assets.json', 'generated'],
  ] as const)
    assert.equal(
      classifyMutationPath(policy, identity(file)).mutationClass,
      mode,
    );
});

test('missing content, invalid UTF-8 and malformed policy values retain the investigation guard error', () => {
  const snapshot = snapshotFor({}, []);
  assert.throws(
    () =>
      deriveReviewedMutationClassPolicy(emptyInventory, {
        ...snapshot,
        entries: [],
      }),
    investigationError,
  );
  const valid = {
    schemaVersion: 1,
    enforcementMode: 'enforced',
    documents: {},
  };
  const invalidValues = [
    null,
    [],
    {},
    { ...valid, extra: true },
    { ...valid, schemaVersion: 2 },
    { ...valid, enforcementMode: 'advisory' },
    { ...valid, documents: null },
    { ...valid, documents: [] },
    { ...valid, documents: { 'a.md': null } },
    { ...valid, documents: { 'a.md': { mode: 'unknown' } } },
    { ...valid, documents: { 'a.md': { mode: 1 } } },
  ];
  for (const content of [
    undefined,
    Uint8Array.of(0xff),
    new TextEncoder().encode('{'),
    new Uint8Array(),
    ...invalidValues.map((value) =>
      new TextEncoder().encode(JSON.stringify(value)),
    ),
  ]) {
    assert.throws(
      () =>
        deriveReviewedMutationClassPolicy(emptyInventory, {
          ...snapshot,
          entries: snapshot.entries.map((entry) => ({ ...entry, content })),
        }),
      investigationError,
    );
  }
});

test('unsafe document patterns retain the existing investigation guard error', () => {
  for (const pattern of [
    '',
    '/abs.md',
    '../a.md',
    'docs/../a.md',
    'docs//a.md',
    'docs\\a.md',
    'docs/\0a.md',
    'docs/[a].md',
  ]) {
    assert.throws(
      () =>
        deriveReviewedMutationClassPolicy(
          emptyInventory,
          snapshotFor({ [pattern]: { mode: 'reference' } }, []),
        ),
      investigationError,
    );
  }
});

test('conflicting mutation classes remain a classification error rather than a new derivation rejection', () => {
  const policy = deriveReviewedMutationClassPolicy(
    inventory,
    snapshotFor(
      {
        'AGENTS.md': { mode: 'immutable' },
      },
      ['AGENTS.md'],
    ),
  );
  assert.equal(
    policy.rules.filter(
      (rule) =>
        rule.selector.kind === 'exact-path' &&
        rule.selector.path === 'AGENTS.md',
    ).length,
    2,
  );
  assert.throws(
    () => classifyMutationPath(policy, identity('AGENTS.md')),
    (error) =>
      error instanceof WorkflowError &&
      error.code === 'MUTATION_CLASS_POLICY_INVALID' &&
      error.exitCode === ExitCode.usage,
  );
});

test('path normalization errors propagate without an investigation error wrapper', () => {
  const pathError = (error: unknown) =>
    error instanceof WorkflowError &&
    error.code === 'INVALID_POLICY_PATH' &&
    error.exitCode === ExitCode.guard;
  for (const invalidInventory of [
    { ...emptyInventory, manifestPath: '../manifest.json' },
    {
      ...emptyInventory,
      assets: [{ destinationPath: '../generated.md', mirrorOf: null }],
    },
  ])
    assert.throws(
      () =>
        deriveReviewedMutationClassPolicy(
          invalidInventory,
          snapshotFor({}, []),
        ),
      pathError,
    );
  for (const pattern of ['.', 'docs/./a.md', '.git/config']) {
    assert.throws(
      () =>
        deriveReviewedMutationClassPolicy(
          emptyInventory,
          snapshotFor({ [pattern]: { mode: 'reference' } }, []),
        ),
      pathError,
    );
  }
});

function identity(utf8: string) {
  return Object.freeze({
    utf8,
    rawBase64: Buffer.from(utf8).toString('base64'),
  });
}

function snapshotFor(
  documents: unknown,
  paths: readonly string[],
): TrackedObjectSnapshotV1 {
  const content = new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      enforcementMode: 'enforced',
      documents,
    }),
  );
  const entries = ['workflow/document-policy.json', ...paths].map((file) =>
    Object.freeze({
      path: identity(file),
      objectId: '3'.repeat(40),
      objectType: 'blob',
      mode: '100644',
      byteSize: file === 'workflow/document-policy.json' ? content.length : 0,
      ...(file === 'workflow/document-policy.json' ? { content } : {}),
    }),
  );
  return Object.freeze({
    treeOid: '1'.repeat(40),
    treeDigest: '2'.repeat(64),
    totalScannedBlobBytes: content.length,
    budgetExceeded: false,
    entries: Object.freeze([
      ...entries,
      Object.freeze({
        path: Object.freeze({ rawBase64: '/w==', utf8: null }),
        objectId: '4'.repeat(40),
        objectType: 'blob',
        mode: '100644',
        byteSize: 0,
      }),
    ]),
  });
}

function investigationError(error: unknown): boolean {
  return (
    error instanceof WorkflowError &&
    error.code === 'INVESTIGATION_POLICY_INVALID' &&
    error.exitCode === ExitCode.guard
  );
}
