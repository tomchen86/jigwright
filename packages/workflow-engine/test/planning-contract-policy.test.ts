import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseChangeMetadataText } from '../src/modules/planning-provider/change-metadata-policy.ts';
import {
  parseGuardContract,
  validateTaskPolicy,
} from '../src/modules/planning-provider/guard-policy.ts';
import { readModuleReferences } from './support/dependency-graph.ts';

test('guard policy consumes required path facts without inventing paths or changing error precedence', () => {
  const checks = { schemaVersion: 1 as const, checks: {} };
  const policy = { allowedPaths: ['custom/**'], requiredChecks: ['BAD CHECK'] };
  assert.throws(
    () =>
      validateTaskPolicy(
        '1.1',
        policy,
        checks,
        ['custom/**'],
        ['custom/report.md'],
      ),
    { code: 'ENGINE_PROJECTION_PATH_IN_TASK_SCOPE' },
  );
  assert.throws(
    () =>
      validateTaskPolicy(
        '1.1',
        policy,
        checks,
        ['custom/**', 'custom/**'],
        ['custom/report.md'],
      ),
    { code: 'DUPLICATE_ALLOWED_PATH' },
  );
  assert.throws(
    () =>
      validateTaskPolicy(
        '1.1',
        policy,
        checks,
        ['docs/CURRENT_AND_NEXT_STEPS.md'],
        [],
      ),
    { code: 'INVALID_REQUIRED_CHECK_ID' },
  );
});

test('metadata admission follows the supplied consumer schema and exact date grammar without repository access', () => {
  const planning = {
    providerId: 'openspec',
    packageSchemaNames: ['package-schema'],
    requiredSchemaNames: ['package-schema'],
    supportedSchemaNames: ['package-schema', 'consumer-schema'],
    managedSchemaNames: ['consumer-schema'],
    currentSchemaName: 'consumer-schema',
  };
  assert.equal(
    parseChangeMetadataText('schema: package-schema\n', planning),
    'package-schema',
  );
  assert.equal(
    parseChangeMetadataText(
      'created: 2024-02-29\nschema: consumer-schema\n',
      planning,
    ),
    'consumer-schema',
  );
  for (const text of [
    'schema: consumer-schema\ncreated: 2023-02-29\n',
    'schema: consumer-schema\ncreated: 2024-02-29\ncreated: 2024-02-29\n',
    'schema: consumer-schema\r\ncreated: 2024-02-29\r\n',
    '\uFEFFschema: package-schema\n',
  ])
    assert.throws(() => parseChangeMetadataText(text, planning), {
      code: 'OPENSPEC_CHANGE_METADATA_INVALID',
    });
  assert.throws(
    () =>
      parseChangeMetadataText(
        'schema: consumer-schema\ncreated: 2024-02-29\n',
        {
          ...planning,
          supportedSchemaNames: ['package-schema'],
        },
      ),
    { code: 'OPENSPEC_MANAGED_SCHEMA_REQUIRED' },
  );
});

test('guard policy rejects projection claims and malformed checks using admitted path values', () => {
  const guard = parseGuardContract(
    {
      changeId: 'sample',
      schemaVersion: 1,
      tasks: {
        '1.1': { allowedPaths: ['src/**'], requiredChecks: ['BAD CHECK'] },
      },
    },
    'in-memory/guard.json',
    'sample',
  );
  const checks = { schemaVersion: 1 as const, checks: {} };
  const projectionPaths = ['docs/CURRENT_AND_NEXT_STEPS.md'];
  assert.throws(
    () =>
      validateTaskPolicy(
        '1.1',
        guard.tasks['1.1'],
        checks,
        ['src/**', 'src/**'],
        projectionPaths,
      ),
    { code: 'DUPLICATE_ALLOWED_PATH' },
  );
  assert.throws(
    () =>
      validateTaskPolicy(
        '1.1',
        guard.tasks['1.1'],
        checks,
        ['docs/CURRENT_AND_NEXT_STEPS.md'],
        projectionPaths,
      ),
    { code: 'ENGINE_PROJECTION_PATH_IN_TASK_SCOPE' },
  );
  assert.throws(
    () =>
      validateTaskPolicy(
        '1.1',
        guard.tasks['1.1'],
        checks,
        ['src/**'],
        projectionPaths,
      ),
    { code: 'INVALID_REQUIRED_CHECK_ID' },
  );
});

test('planning contract values and policy closures include types and cannot reach repository implementations', () => {
  const sourceRoot = path.resolve(import.meta.dirname, '../src');
  function inspect(entry: string, inject = false) {
    const seen = new Set<string>();
    function visit(file: string) {
      assert.ok(
        !/\/(runtime|adapters|composition-root|application|entrypoints)\//.test(
          file,
        ),
        `Outward policy dependency: ${file}`,
      );
      if (seen.has(file)) return;
      seen.add(file);
      let source = fs.readFileSync(file, 'utf8');
      if (inject && file.endsWith('/planning-artifact-types.ts'))
        source +=
          "\nimport type { ChangeContract } from '../../adapters/consumer/repository/work-registry/contracts.ts';";
      for (const { specifier } of readModuleReferences(file, source)) {
        assert.notEqual(
          specifier,
          null,
          `Unresolved policy dependency: ${file}`,
        );
        if (specifier === null) throw new Error('Unresolved policy dependency');
        if (specifier.startsWith('node:'))
          assert.ok(
            ['node:path', 'node:crypto'].includes(specifier),
            `Policy effect: ${specifier}`,
          );
        else if (specifier.startsWith('.'))
          visit(path.resolve(path.dirname(file), specifier));
        else {
          assert.ok(
            specifier.startsWith('@jigwright/core/'),
            `External policy implementation: ${specifier}`,
          );
          visit(fileURLToPath(import.meta.resolve(specifier)));
        }
      }
    }
    visit(path.join(sourceRoot, entry));
  }
  for (const entry of [
    'planning-artifact-parsers.ts',
    'guard-policy.ts',
    'change-metadata-policy.ts',
    'change-contract.ts',
  ])
    inspect(`modules/planning-provider/${entry}`);
  assert.throws(
    () => inspect('modules/planning-provider/guard-policy.ts', true),
    /Outward policy dependency/,
  );
});
