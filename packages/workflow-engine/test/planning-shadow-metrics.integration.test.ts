import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SOURCE_ROOT = path.resolve(import.meta.dirname, '../src');
const LEGACY_MODULE = path.join(
  SOURCE_ROOT,
  'modules/assurance/planning-shadow-metrics.ts',
);

test('live assurance inspection has retired v2 planning shadow metrics', () => {
  const source = fs.readFileSync(
    path.join(
      SOURCE_ROOT,
      'runtime/repository-transaction/assurance-inspection.ts',
    ),
    'utf8',
  );
  assert.equal(source.includes('planning-shadow-metrics'), false);
  assert.equal(source.includes('shadowMetrics'), false);
});

test('the retired v2 metrics module is absent from the production tree', () => {
  assert.equal(fs.existsSync(LEGACY_MODULE), false);

  const callers = typescriptFiles(SOURCE_ROOT)
    .filter((candidate) =>
      fs.readFileSync(candidate, 'utf8').includes('planning-shadow-metrics.ts'),
    )
    .map((candidate) => path.relative(SOURCE_ROOT, candidate))
    .sort();

  assert.deepEqual(callers, []);
});

function typescriptFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return typescriptFiles(candidate);
    return entry.isFile() && entry.name.endsWith('.ts') ? [candidate] : [];
  });
}
