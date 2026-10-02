import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  prepareTaskStrategyPatchRecord,
  parsePatchRecord,
  parseReservation,
  parseImportReceipt,
  parseCurrentBinding,
  sha256,
} from '../src/modules/assurance/task-strategy-patch-record.ts';

const NOW = '2026-10-02T00:00:00.000Z';
const corrupt = { code: 'TASK_STRATEGY_PATCH_STATE_CORRUPT' };
function recordInput() {
  return {
    sessionId: 'session-codec',
    changeId: 'codec-change',
    taskId: '1.1',
    strategy: 'cross-agent-tdd' as const,
    sourceTree: '1'.repeat(40),
    candidateTree: '2'.repeat(40),
    taskContractDigest: sha256('task'),
    patchDigest: sha256('patch'),
    patchBase64: Buffer.from('patch').toString('base64'),
    changedPaths: ['src/a.ts'],
    changes: [
      {
        path: 'src/a.ts',
        before: null,
        after: { mode: '100644' as const, objectId: '3'.repeat(40) },
      },
    ],
    implementer: {
      providerId: 'codex' as const,
      assurance: 'self-declared' as const,
    },
    createdAt: NOW,
  };
}
function redigest(value: Record<string, unknown>, key: string) {
  const body = { ...value };
  delete body[key];
  return { ...body, [key]: sha256(canonicalJson(body)) };
}
const record = prepareTaskStrategyPatchRecord(recordInput());
const reservation = redigest(
  {
    schemaVersion: 1,
    kind: 'task-strategy-patch-reservation.v1',
    sessionId: record.sessionId,
    patchDigest: record.patchDigest,
    recordDigest: record.recordDigest,
    sourceTree: record.sourceTree,
    candidateTree: record.candidateTree,
    createdAt: NOW,
  },
  'reservationDigest',
);
const receipt = redigest(
  {
    schemaVersion: 1,
    kind: 'task-strategy-patch-import-receipt.v1',
    recordDigest: record.recordDigest,
    sessionId: record.sessionId,
    patchDigest: record.patchDigest,
    candidateTree: record.candidateTree,
    importedAt: NOW,
  },
  'receiptDigest',
);
const binding = redigest(
  {
    schemaVersion: 1,
    kind: 'task-strategy-patch-current.v1',
    sessionId: record.sessionId,
    patchDigest: record.patchDigest,
    recordDigest: record.recordDigest,
    receiptDigest: receipt.receiptDigest,
    candidateTree: record.candidateTree,
    createdAt: NOW,
  },
  'bindingDigest',
);

for (const [name, parse, value, key] of [
  ['record', parsePatchRecord, record, 'recordDigest'],
  ['reservation', parseReservation, reservation, 'reservationDigest'],
  ['receipt', parseImportReceipt, receipt, 'receiptDigest'],
  ['binding', parseCurrentBinding, binding, 'bindingDigest'],
] as const) {
  test(`${name} codec keeps original reference, shallow freeze and canonical digest`, () => {
    const wire = structuredClone(value);
    assert.equal(parse(wire), wire);
    assert.ok(Object.isFrozen(wire));
    if ('changes' in wire) {
      assert.ok(!Object.isFrozen(wire.changes));
      assert.equal(wire.changes, parsePatchRecord(wire).changes);
    }
    const reversed = Object.fromEntries(Object.entries(value).reverse());
    assert.deepEqual(parse(reversed), value);
    assert.throws(() => parse({ ...value, [key]: '0'.repeat(64) }), corrupt);
    assert.throws(() => parse({ ...value, [key]: 'A'.repeat(64) }), corrupt);
    assert.throws(
      () => parse(redigest({ ...value, extra: true }, key)),
      corrupt,
    );
    for (const field of Object.keys(value)) {
      const missing: Record<string, unknown> = { ...value };
      delete missing[field];
      assert.throws(
        () => parse(field === key ? missing : redigest(missing, key)),
        corrupt,
        field,
      );
    }
    for (const field of ['schemaVersion', 'kind', 'sessionId', 'candidateTree'])
      assert.throws(
        () => parse(redigest({ ...value, [field]: null }, key)),
        corrupt,
        field,
      );
    const timestamp = 'importedAt' in value ? 'importedAt' : 'createdAt';
    assert.throws(
      () => parse(redigest({ ...value, [timestamp]: 'not-a-date' }, key)),
      corrupt,
    );
    assert.equal(
      (
        parse(
          redigest({ ...value, [timestamp]: '2026-10-02' }, key),
        ) as unknown as Record<string, unknown>
      )[timestamp],
      '2026-10-02',
    );
    for (const field of Object.keys(value).filter((f) => f.endsWith('Digest')))
      assert.throws(
        () =>
          parse(
            redigest(
              { ...value, [field]: 'x' },
              field === key ? 'not-the-digest' : key,
            ),
          ),
        corrupt,
        field,
      );
  });
}

const malformed: Record<string, unknown>[] = [
  { sessionId: '../escape' },
  { changeId: 'Upper Case' },
  { taskId: '1' },
  { strategy: 'other' },
  { sourceTree: '1'.repeat(39) },
  { candidateTree: record.sourceTree },
  { taskContractDigest: 'a' },
  { patchBase64: '' },
  { patchBase64: record.patchBase64 + '\n' },
  { patchBase64: 'cA==' },
  { patchDigest: sha256('different') },
  { changedPaths: [] },
  { changedPaths: ['../escape'] },
  { changedPaths: ['src//a.ts'] },
  { changedPaths: ['src/b.ts', 'src/a.ts'] },
  { changedPaths: ['src/a.ts', 'src/a.ts'] },
  { changes: [] },
  { changes: [{ ...record.changes[0], path: 'src/b.ts' }] },
  { changes: [{ path: 'src/a.ts', before: null, after: null }] },
  { changes: [{ ...record.changes[0], extra: 1 }] },
  ...['120000', '160000', '100600'].map((mode) => ({
    changes: [
      { ...record.changes[0], after: { mode, objectId: '3'.repeat(40) } },
    ],
  })),
  {
    changes: [
      {
        ...record.changes[0],
        after: { mode: '100644', objectId: '3'.repeat(41) },
      },
    ],
  },
  {
    changes: [
      {
        ...record.changes[0],
        after: { mode: '100644', objectId: '3'.repeat(40), extra: 1 },
      },
    ],
  },
  { implementer: { providerId: 'unknown', assurance: 'self-declared' } },
  { implementer: { providerId: 'codex', assurance: 'maintainer-signed' } },
  {
    implementer: { providerId: 'codex', assurance: 'self-declared', extra: 1 },
  },
];
for (const [index, fields] of malformed.entries())
  test(`record rejects re-digested malformed predicate ${index + 1}`, () =>
    assert.throws(
      () =>
        parsePatchRecord(redigest({ ...record, ...fields }, 'recordDigest')),
      corrupt,
    ));

test('canonical patch bytes and path counts accept exact bounds and reject one over', () => {
  for (const bytes of [
    Buffer.from([0, 255, 128]),
    Buffer.alloc(8 * 1024 * 1024, 42),
  ]) {
    assert.equal(
      prepareTaskStrategyPatchRecord({
        ...recordInput(),
        patchBase64: bytes.toString('base64'),
        patchDigest: sha256(bytes),
      }).patchDigest,
      sha256(bytes),
    );
  }
  const oversized = Buffer.alloc(8 * 1024 * 1024 + 1);
  assert.throws(
    () =>
      prepareTaskStrategyPatchRecord({
        ...recordInput(),
        patchBase64: oversized.toString('base64'),
        patchDigest: sha256(oversized),
      }),
    corrupt,
  );
  const paths = Array.from(
    { length: 1024 },
    (_, n) => `src/${String(n).padStart(4, '0')}.ts`,
  );
  const input = {
    ...recordInput(),
    changedPaths: paths,
    changes: paths.map((path) => ({ ...record.changes[0]!, path })),
  };
  assert.equal(prepareTaskStrategyPatchRecord(input).changedPaths, paths);
  assert.throws(
    () =>
      prepareTaskStrategyPatchRecord({
        ...input,
        changedPaths: [...paths, 'src/1024.ts'],
        changes: [
          ...input.changes,
          { ...record.changes[0]!, path: 'src/1024.ts' },
        ],
      }),
    corrupt,
  );
});

test('record accepts both OID lengths, add/delete/mode entries and all existing actor assurances', () => {
  for (const width of [40, 64])
    for (const assurance of [
      'self-declared',
      'runtime-hint',
      'adapter-assigned',
    ] as const) {
      const input = {
        ...recordInput(),
        sourceTree: 'a'.repeat(width),
        candidateTree: 'b'.repeat(width),
        implementer: { providerId: 'claude' as const, assurance },
      };
      for (const change of [
        {
          path: 'src/a.ts',
          before: null,
          after: { mode: '100755' as const, objectId: 'c'.repeat(width) },
        },
        {
          path: 'src/a.ts',
          before: { mode: '100644' as const, objectId: 'c'.repeat(width) },
          after: null,
        },
        {
          path: 'src/a.ts',
          before: { mode: '100644' as const, objectId: 'c'.repeat(width) },
          after: { mode: '100755' as const, objectId: 'c'.repeat(width) },
        },
      ])
        assert.deepEqual(
          prepareTaskStrategyPatchRecord({ ...input, changes: [change] })
            .changes,
          [change],
        );
    }
});

test('caller identity retains exact principal and UUID v4 constraints', () => {
  const implementer = {
    providerId: null,
    principalId: 'person:demo/1',
    assurance: 'runtime-hint' as const,
    degradedForm: 'caller-supplied' as const,
    grantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  };
  assert.equal(
    prepareTaskStrategyPatchRecord({ ...recordInput(), implementer })
      .implementer,
    implementer,
  );
  for (const fields of [
    { principalId: '' },
    { principalId: 'a'.repeat(513) },
    { principalId: 'bad space' },
    { degradedForm: 'other' },
    { grantId: 'aaaaaaaa-aaaa-3aaa-8aaa-aaaaaaaaaaaa' },
    { grantId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { grantId: 'aaaaaaaa-aaaa-4aaa-7aaa-aaaaaaaaaaaa' },
    { extra: true },
  ])
    assert.throws(
      () =>
        parsePatchRecord(
          redigest(
            { ...record, implementer: { ...implementer, ...fields } },
            'recordDigest',
          ),
        ),
      corrupt,
    );
});
