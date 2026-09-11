import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from './fixture.ts';
import { moduleChangesSinceConfirmation } from '../src/runtime/managed-documents/validation/module-readme-changes.ts';
import { moduleHeaderHistory } from '../src/runtime/managed-documents/validation/module-header-history.ts';
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
    [`${directory}/work.ts`]: `/**\n * Captures exact request wording.\n *\n * Invariants:\n * - Wording is never trimmed.\n */\nexport type WorkKind =\n  | 'feature'\n  | 'bug';\nexport type WorkLane = 'next' | null;\n`,
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
      Object.keys(files)
        .filter((file) => file.endsWith('/spec.md'))
        .map((file) => parseSystemSpec(file, files[file]!)),
      () => ['work.ts'],
      () => 'Possibly stale',
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
  assert.match(files[readme]!, /Header history/);
  assert.match(files[readme]!, /Possibly stale/);
  const before = files[readme];
  service().project('documents.governance-intake-readme');
  assert.equal(files[readme], before);
  files[`${directory}/work.ts`] = files[`${directory}/work.ts`]!.replace(
    "| 'feature'\n  | 'bug'",
    "| 'feature'\n  | 'bug'\n  | 'chore'",
  );
  assert.equal(service().status()[0]?.state, 'drifted');
  service().project('documents.governance-intake-readme');
  assert.match(files[readme]!, /feature, bug, chore/);
  assert.deepEqual(
    readModuleReadmeWhy(files[readme]!),
    readModuleReadmeWhy(why),
  );

  const providerDirectory =
    'packages/workflow-engine/src/modules/provider-orchestration';
  const providerReadme = `${providerDirectory}/README.md`;
  files[providerReadme] = why.replace('Governance intake', 'Providers');
  files[`${providerDirectory}/spec.md`] =
    '# Providers\n\n## Purpose\nSelect host profiles.\n\n## Requirements\n### Requirement: Use host profiles\n\nThe engine SHALL select host profiles.\n';
  files['packages/workflow-engine/src/entrypoints/cli/cli-input.ts'] +=
    "    '  jigwright agent provider probe <profile-id> --config <absolute-host-path> [--json] — Inspect the selected host profile.',\n";
  service().project('documents.provider-orchestration-readme', {
    install: true,
  });
  assert.match(files[providerReadme]!, /Inspect the selected host profile\./);
  assert.match(files[providerReadme]!, /Use host profiles/);
  assert.doesNotMatch(
    files[providerReadme]!,
    /Start the supplied work\.|Inspect exact authority\./,
  );
  assert.deepEqual(
    readModuleReadmeWhy(files[providerReadme]!),
    readModuleReadmeWhy(why),
  );
});

test('every existing engine module can render its own README region without claiming transition authority', () => {
  const modules = [
    'adoption',
    'assurance',
    'authority',
    'governance-intake',
    'guidance',
    'investigation',
    'lifecycle',
    'planning-provider',
    'projection',
    'provider-orchestration',
    'repository-consumer',
    'source',
    'why-knowledge',
  ];
  const files = new Map<string, string>();
  for (const module of modules) {
    const directory = `packages/workflow-engine/src/modules/${module}`;
    files.set(
      `${directory}/README.md`,
      `# ${module}\n\n<!-- jigwright:module-why confirmed=${'a'.repeat(40)} -->\nKeep the ${module} boundary explicit.\n<!-- /jigwright:module-why -->\n`,
    );
    files.set(
      `${directory}/entry.ts`,
      `/** Describe ${module}.\n * Invariants:\n * - Preserve the ${module} boundary.\n */\nexport const value = 1;\n`,
    );
  }
  files.set(
    'packages/workflow-engine/src/modules/guidance/catalog/managed-workflow-command-registry.ts',
    `
const FINALIZE_USAGE = 'pnpm workflow finalize <session-id> --message <subject> [--json]';
const definitions = [
  {
    usage: [FINALIZE_USAGE],
    status: 'preferred',
    purpose: 'Finalize the selected task.',
  },
  {
    usage: ['pnpm workflow guide [--json]'],
    status: 'read-only',
    purpose: 'Inspect the command guide.',
  },
];
`,
  );
  const snapshot = {
    listPaths: () => [...files.keys()],
    readText: (file: string) => files.get(file),
  };
  const bindings = moduleReadmeProjectionBindings(snapshot, [], () => []);
  assert.equal(bindings.length, modules.length);
  const service = createProjectionService(bindings, {
    read: (file) => files.get(file) ?? null,
    write: (file, content) => {
      files.set(file, content);
    },
  });
  for (const binding of bindings) {
    service.project(binding.id, { install: true });
  }
  for (const module of modules) {
    const content = files.get(
      `packages/workflow-engine/src/modules/${module}/README.md`,
    )!;
    assert.match(content, /## Commands/);
    assert.match(content, /## Data/);
    assert.match(content, /## Contracts/);
    assert.match(content, /## Files/);
    assert.ok(content.includes(`Keep the ${module} boundary explicit.`));
    assert.ok(content.includes(`Describe ${module}. | 1`));
  }
  assert.ok(service.status().every(({ state }) => state === 'current'));
  assert.match(
    files.get('packages/workflow-engine/src/modules/lifecycle/README.md')!,
    /finalize &lt;session-id&gt;.*Finalize the selected task\./,
  );
  assert.match(
    files.get('packages/workflow-engine/src/modules/guidance/README.md')!,
    /guide \[--json\].*Inspect the command guide\./,
  );
});

test('README header age uses Git history and fixed snapshot bytes without treating prose as verified', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'module-header-history-'));
  try {
    git(root, ['init', '-b', 'main']);
    git(root, ['config', 'user.name', 'Document test']);
    git(root, ['config', 'user.email', 'documents@example.test']);
    const file = 'source.ts';
    const original = '/** Describes the source. */\nexport const value = 1;\n';
    fs.writeFileSync(path.join(root, file), original);
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'Document source']);
    const first = git(root, ['rev-parse', 'HEAD']).trim();
    const fixed = readSystemDescriptionSnapshot(root, first);
    const initial = moduleHeaderHistory(root, fixed);
    assert.equal(initial(file, first), 'No newer code observed');

    fs.writeFileSync(path.join(root, file), original.replace('= 1', '= 2'));
    const changed = readSystemDescriptionSnapshot(root);
    assert.equal(
      moduleHeaderHistory(root, changed)(file, first),
      'Possibly stale',
    );
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'Change code without its header']);
    const second = git(root, ['rev-parse', 'HEAD']).trim();
    const newer = readSystemDescriptionSnapshot(root, second);
    assert.equal(
      moduleHeaderHistory(root, newer)(file, second),
      'Possibly stale',
    );
    assert.equal(initial(file, first), 'No newer code observed');

    const updated = original
      .replace('Describes the source', 'Describes the changed source')
      .replace('= 1', '= 2');
    fs.writeFileSync(path.join(root, file), updated);
    const working = readSystemDescriptionSnapshot(root);
    assert.equal(
      moduleHeaderHistory(root, working)(file, second),
      'Header changed since confirmation',
    );
    git(root, ['add', '-A']);
    git(root, ['commit', '-m', 'Update header']);
    const third = git(root, ['rev-parse', 'HEAD']).trim();
    assert.equal(
      moduleHeaderHistory(root, readSystemDescriptionSnapshot(root))(
        file,
        third,
      ),
      'No newer code observed',
    );
    assert.equal(
      moduleHeaderHistory(root, working)(file, second),
      'Header changed since confirmation',
    );
    assert.equal(
      moduleHeaderHistory(root, newer)(file, second),
      'Possibly stale',
    );
    assert.equal(
      moduleHeaderHistory(root, fixed)('missing.ts', first),
      'History unavailable',
    );
    assert.equal(
      moduleHeaderHistory(root, fixed)(file, 'f'.repeat(40)),
      'History unavailable',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
