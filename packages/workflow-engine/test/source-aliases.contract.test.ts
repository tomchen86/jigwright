import { parseGovernanceSourceAliases } from '../src/modules/governance-intake/source-aliases.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { captureGovernanceSource } from '../src/composition-root/governance-sources-production.ts';
import {
  readGovernanceSourceAliases,
  resolveGovernanceSourceAlias,
} from '../src/composition-root/governance-sources-production.ts';

test('Source aliases resolve canonical wording without copying it into the alias record', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-aliases-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(readGovernanceSourceAliases(root), {});
  const source = captureGovernanceSource(root, {
    semanticAuthor: 'maintainer',
    capturedBy: 'test',
    capturedAt: '2026-09-08T00:00:00.000Z',
    contextRef: 'direct-human:test',
    text: '  原話\r\n不改寫\n',
    supersedes: null,
  }).source;
  const target = path.join(root, 'workflow/source-ledger/aliases.json');
  const record = {
    schemaVersion: 1,
    aliases: { 'R-000': { title: 'Product purpose', sourceRefs: [source.id] } },
  };
  fs.writeFileSync(target, JSON.stringify(record));
  const snapshot = JSON.stringify(record);
  assert.deepEqual(parseGovernanceSourceAliases(undefined), {});
  assert.deepEqual(parseGovernanceSourceAliases(snapshot), record.aliases);
  assert.equal(
    resolveGovernanceSourceAlias(root, 'R-000')[0].text,
    source.text,
  );
  assert.equal(fs.readFileSync(target, 'utf8').includes('原話'), false);
  assert.throws(() => resolveGovernanceSourceAlias(root, 'R-999'), /unknown/i);
  fs.writeFileSync(target, JSON.stringify({ ...record, schemaVersion: 2 }));
  assert.throws(() => readGovernanceSourceAliases(root), /invalid/i);
  assert.deepEqual(parseGovernanceSourceAliases(snapshot), record.aliases);
  fs.writeFileSync(
    target,
    JSON.stringify({
      ...record,
      aliases: {
        'R-000': {
          title: 'Product purpose',
          sourceRefs: [`SRC-${'a'.repeat(64)}`],
        },
      },
    }),
  );
  assert.throws(() => resolveGovernanceSourceAlias(root, 'R-000'));
});
