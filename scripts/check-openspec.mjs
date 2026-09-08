import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOpenSpecAdapter } from '../packages/workflow-engine/src/adapters/planning/openspec/documents/openspec-adapter.ts';
import { validateSystemDocumentStructure } from '../packages/workflow-engine/src/runtime/managed-documents/validation/system-documents.ts';
import { readSystemDescriptionSnapshot } from '../packages/workflow-engine/src/runtime/repository-transaction/system-description-snapshot.ts';
import { systemSpecPaths } from '../packages/workflow-engine/src/modules/source/system-documents.ts';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const openspecCli = path.join(
  repositoryRoot,
  'node_modules',
  '@fission-ai',
  'openspec',
  'bin',
  'openspec.js',
);

if (!existsSync(openspecCli)) {
  console.error(
    'Pinned OpenSpec CLI is unavailable; run pnpm install before validation.',
  );
  process.exit(1);
}

try {
  const validation = createOpenSpecAdapter(repositoryRoot).validateAllSpecs();
  if (!validation.valid) {
    for (const item of validation.items.filter((item) => !item.valid)) {
      for (const issue of item.issues)
        console.error(`${item.id}: ${issue.message}`);
    }
    process.exit(1);
  }
  const snapshot = readSystemDescriptionSnapshot(repositoryRoot);
  if (systemSpecPaths(snapshot.listPaths()).length > 0)
    validateSystemDocumentStructure(repositoryRoot, snapshot);
  console.log(
    `Strict base validation passed for ${validation.items.length} canonical specifications.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [openspecCli, 'validate', '--changes', '--strict', '--no-interactive'],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      DO_NOT_TRACK: '1',
      OPENSPEC_TELEMETRY: '0',
    },
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(
    `Failed to launch pinned OpenSpec CLI: ${result.error.message}`,
  );
  process.exit(1);
}

if (result.signal) {
  console.error(`Pinned OpenSpec CLI terminated by signal ${result.signal}.`);
  process.exit(1);
}

process.exit(result.status ?? 1);
