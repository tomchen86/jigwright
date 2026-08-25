import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const result = spawnSync(
  process.execPath,
  [openspecCli, 'validate', '--all', '--strict', '--no-interactive'],
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
