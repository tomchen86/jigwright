import assert from 'node:assert/strict';
import test from 'node:test';
import { readModuleReadmeWhy } from '../src/modules/source/module-readme.ts';
import { resolveCanonicalSystemSpec } from '../src/modules/source/system-spec-catalog.ts';

test('README review compares only handwritten reasoning and separately records its confirmation commit', () => {
  const why =
    'Keep intake wording intact because the owner must be able to trace a decision.';
  const readme = `# Intake\n\n<!-- jigwright:module-why -->\n${why}\n\nConfirmed at commit: \`${'a'.repeat(40)}\`\n<!-- /jigwright:module-why -->\n\n## Commands\nGenerated content.\n`;
  assert.deepEqual(readModuleReadmeWhy(readme), {
    text: why,
    confirmedAtCommit: 'a'.repeat(40),
  });
  assert.equal(
    readModuleReadmeWhy(readme.replace('Generated content.', 'New commands.'))
      ?.text,
    why,
  );
  assert.equal(
    readModuleReadmeWhy(readme.replace('a'.repeat(40), 'b'.repeat(40)))?.text,
    why,
  );
  assert.equal(readModuleReadmeWhy(`\`\`\`markdown\n${readme}\`\`\`\n`), null);
  assert.throws(() => readModuleReadmeWhy(readme + readme), /Duplicate/);
  assert.throws(
    () => readModuleReadmeWhy(readme.replace('a'.repeat(40), 'HEAD')),
    /commit/,
  );
  assert.throws(
    () =>
      readModuleReadmeWhy(
        readme.replace(why, 'First decision.\n\nSecond decision.'),
      ),
    /paragraph/,
  );
  assert.throws(
    () =>
      readModuleReadmeWhy(readme.replace('<!-- /jigwright:module-why -->', '')),
    /closing/,
  );
});

test('capability aliases resolve to one canonical spec while directory containment remains ownership', () => {
  const files: Record<string, string> = {
    'spec.md':
      '# Repository\ncapabilities: [repository-governance, workflow-assurance]\n\n## Purpose\nCoordinate the repository.\n',
    'packages/engine/src/modules/intake/spec.md':
      '# Intake\ncapabilities: [governance-intake]\n\n## Purpose\nCapture requests.\n',
    'packages/engine/test/fixtures/spec.md':
      '# Fixture\ncapabilities: [fake]\n',
  };
  const snapshot = {
    listPaths: () => Object.keys(files),
    readText: (p: string) => files[p],
  };
  assert.equal(
    resolveCanonicalSystemSpec(snapshot, 'governance-intake'),
    'packages/engine/src/modules/intake/spec.md',
  );
  assert.equal(
    resolveCanonicalSystemSpec(snapshot, 'intake'),
    'packages/engine/src/modules/intake/spec.md',
  );
  assert.equal(
    resolveCanonicalSystemSpec(snapshot, 'workflow-assurance'),
    'spec.md',
  );
  assert.equal(resolveCanonicalSystemSpec(snapshot, 'fake'), null);
  assert.equal(resolveCanonicalSystemSpec(snapshot, 'missing'), null);
  files['packages/other/spec.md'] =
    '# Other\ncapabilities: [governance-intake]\n';
  assert.throws(
    () => resolveCanonicalSystemSpec(snapshot, 'governance-intake'),
    /ambiguous/,
  );
});
