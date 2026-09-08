import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './fixture.ts';
import { moduleChangesSinceConfirmation } from '../src/runtime/managed-documents/validation/module-readme-changes.ts';
import { readSystemDescriptionSnapshot } from '../src/runtime/repository-transaction/system-description-snapshot.ts';
import { moduleReadmeProjectionBindings } from '../src/modules/projection/module-readme-projection.ts';
import { createProjectionService } from '../src/modules/projection/projection-service.ts';
import { readModuleReadmeWhy } from '../src/modules/source/module-readme.ts';
import { parseSystemSpec } from '../src/modules/source/spec-ownership.ts';

test('module README derives commands, union data, contracts and header facts while retaining the handwritten why', () => {
  const directory = 'packages/workflow-engine/src/modules/governance-intake';
  const readme = `${directory}/README.md`;
  const why = `# Governance intake\n\n## Why this design\n\n<!-- jigwright:module-why -->\nPreserve the request while work changes.\n\nConfirmed at commit: \`${'a'.repeat(40)}\`\n<!-- /jigwright:module-why -->\n`;
  const specPath = `${directory}/spec.md`;
  const files: Record<string, string> = {
    [readme]: why,
    [specPath]:
      '# Intake\n\n## Purpose\nPreserve requests.\n\n## Requirements\n### Requirement: Keep wording\n\nThe engine SHALL keep wording.\n',
    [`${directory}/work.ts`]: `/**\n * Captures exact request wording.\n *\n * Invariants:\n * - Wording is never trimmed.\n */\nexport type WorkKind = 'feature' | 'bug';\nexport type WorkLane = 'next' | null;\n`,
    'packages/workflow-engine/src/entrypoints/cli/cli-input.ts':
      "    '  pnpm workflow now <original-text> [--json] — Start the supplied work.',\n    '  pnpm workflow grant inspect <id> — Inspect exact authority.',\n",
  };
  const snapshot = {
    listPaths: () => Object.keys(files),
    readText: (file: string) => files[file],
  };
  const bindings = () =>
    moduleReadmeProjectionBindings(
      snapshot,
      [parseSystemSpec(specPath, files[specPath]!)],
      () => ['work.ts'],
    );
  const service = () =>
    createProjectionService(bindings(), {
      read: (file) => files[file] ?? null,
      write: (file, text) => {
        files[file] = text;
      },
    });
  service().project('documents.governance-intake-readme', { install: true });
  assert.deepEqual(
    readModuleReadmeWhy(files[readme]!),
    readModuleReadmeWhy(why),
  );
  assert.match(
    files[readme]!,
    /1 file changed in this module since confirmation/,
  );
  for (const heading of ['Commands', 'Data', 'Contracts', 'Files'])
    assert.match(files[readme]!, new RegExp(`## ${heading}`));
  assert.match(files[readme]!, /Start the supplied work\./);
  assert.doesNotMatch(files[readme]!, /Inspect exact authority\./);
  assert.match(files[readme]!, /feature, bug/);
  assert.match(files[readme]!, /next, null/);
  assert.match(files[readme]!, /Keep wording/);
  assert.match(files[readme]!, /Captures exact request wording\. \| 1/);
  const before = files[readme];
  service().project('documents.governance-intake-readme');
  assert.equal(files[readme], before);
  files[`${directory}/work.ts`] = files[`${directory}/work.ts`]!.replace(
    "'feature' | 'bug'",
    "'feature' | 'bug' | 'chore'",
  );
  assert.equal(service().status()[0]?.state, 'drifted');
  service().project('documents.governance-intake-readme');
  assert.match(files[readme]!, /feature, bug, chore/);
  assert.deepEqual(
    readModuleReadmeWhy(files[readme]!),
    readModuleReadmeWhy(why),
  );
});

test('README change counts use the pinned source and ignore generated or confirmation-only edits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'module-readme-count-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'Document test']);
    git(root, ['config', 'user.email', 'documents@example.test']);
    const directory = 'src/modules/intake';
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    const readmePath = path.join(root, directory, 'README.md');
    const codePath = path.join(root, directory, 'intake.ts');
    const why = `<!-- jigwright:module-why -->\nPreserve original wording.\n\nConfirmed at commit: \`${'a'.repeat(40)}\`\n<!-- /jigwright:module-why -->\n`;
    fs.writeFileSync(readmePath, why);
    fs.writeFileSync(codePath, 'export const value = 1;\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'Confirmed module design']);
    const confirmation = git(root, ['rev-parse', 'HEAD']).trim();
    fs.writeFileSync(
      readmePath,
      why.replace('a'.repeat(40), confirmation) +
        '\n## Commands\nGenerated text.\n',
    );
    assert.deepEqual(
      moduleChangesSinceConfirmation(root, readSystemDescriptionSnapshot(root))(
        directory,
        confirmation,
      ),
      [],
    );
    fs.writeFileSync(codePath, 'export const value = 2;\n');
    git(root, ['add', '-A']);
    const tree = git(root, ['write-tree']).trim();
    const pinned = readSystemDescriptionSnapshot(root, tree);
    fs.writeFileSync(codePath, 'export const value = 1;\n');
    fs.writeFileSync(
      readmePath,
      why.replace('original wording', 'all wording'),
    );
    assert.deepEqual(
      moduleChangesSinceConfirmation(root, pinned)(directory, confirmation),
      [`${directory}/intake.ts`],
    );
    assert.deepEqual(
      moduleChangesSinceConfirmation(root, readSystemDescriptionSnapshot(root))(
        directory,
        confirmation,
      ),
      [`${directory}/README.md`],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
