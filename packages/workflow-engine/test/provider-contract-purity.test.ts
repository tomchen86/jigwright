import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { assertPureDependencyClosure } from './support/pure-dependency-closure.ts';

const sourceRoot = path.resolve(import.meta.dirname, '../src');
const contracts = [
  'modules/provider-orchestration/agent-runtime-port.ts',
  'modules/provider-orchestration/provider-contracts.ts',
  'modules/provider-orchestration/role-assignment.ts',
  'modules/provider-orchestration/agent-runtime-protocol.ts',
];

test('provider contracts, role selection and receipt validation have complete pure value and type closures', () => {
  for (const entry of contracts)
    assert.ok(
      assertPureDependencyClosure(path.join(sourceRoot, entry)).size > 1,
    );
});

test('provider contract closure rejects runtime barrels, type-only effects and computed module loading', () => {
  const entry = path.join(sourceRoot, contracts[0]!);
  assert.throws(
    () =>
      assertPureDependencyClosure(
        entry,
        "\nimport type { AgentProviderConfigSnapshot } from '@jigwright/agent-runtime';",
      ),
    /Implementation dependency/,
  );
  assert.throws(
    () =>
      assertPureDependencyClosure(
        entry,
        "\nimport type { Stats } from 'node:fs';",
      ),
    /Effect import/,
  );
  assert.throws(
    () => assertPureDependencyClosure(entry, '\nimport(receiptModule);'),
    /Unresolved computed dependency/,
  );
  assert.throws(
    () =>
      assertPureDependencyClosure(
        entry,
        "\nconst load = require; load('node:child_process');",
      ),
    /Effect import/,
  );
});
