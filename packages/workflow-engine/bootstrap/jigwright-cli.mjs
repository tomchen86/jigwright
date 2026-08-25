#!/usr/bin/env node

import childProcess from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { initializeJigwrightConsumer } from './jigwright-init.mjs';

const argv = process.argv.slice(2);
if (argv[0] === 'init') {
  try {
    const result = initializeJigwrightConsumer(process.cwd());
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        error: {
          code:
            error && typeof error === 'object' && 'code' in error
              ? error.code
              : 'JIGWRIGHT_INIT_FAILED',
          message: error instanceof Error ? error.message : String(error),
        },
      })}\n`,
    );
    process.exit(12);
  }
}
const installedRuntimeManifest = fileURLToPath(
  new URL('./installed-runtime.json', import.meta.url),
);
const result = fs.existsSync(installedRuntimeManifest)
  ? (
      await import('./installed-runtime-launcher.mjs')
    ).runInstalledJigwrightRuntime(argv)
  : childProcess.spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(new URL('./workflow-launcher.ts', import.meta.url)),
        ...argv,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
      },
    );

if (result.error !== undefined) throw result.error;
if (result.signal !== null) {
  process.kill(process.pid, result.signal);
  process.exit(1);
}
process.exit(result.status ?? 1);
