#!/usr/bin/env node

import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  configuredJigwrightEnvironment,
  initializeJigwrightConsumer,
  renderHumanCommandResult,
} from './jigwright-init.mjs';

let invocation;
try {
  invocation = resolveRepositoryInvocation(process.argv.slice(2));
} catch (error) {
  printJigwrightFailure(error, 'JIGWRIGHT_REPOSITORY_ROOT_INVALID');
  process.exit(2);
}
const { argv, repositoryRoot } = invocation;
if (argv[0] === 'init') {
  try {
    const result = await initializeJigwrightConsumer(repositoryRoot, {
      argv: argv.slice(1),
    });
    process.stdout.write(
      argv.at(-1) === '--json'
        ? `${JSON.stringify({ ok: true, result })}\n`
        : renderHumanCommandResult({ command: 'init', ok: true, result }),
    );
    process.exit(0);
  } catch (error) {
    printJigwrightFailure(error, 'JIGWRIGHT_INIT_FAILED');
    process.exit(12);
  }
}
const helpInvocation =
  argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0]);
if (!helpInvocation) {
  try {
    const topLevel = childProcess.spawnSync(
      'git',
      ['-C', repositoryRoot, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      },
    );
    const setupRepositoryRoot =
      topLevel.status === 0 ? topLevel.stdout.trim() : repositoryRoot;
    const configuredEnvironment =
      configuredJigwrightEnvironment(setupRepositoryRoot);
    if (configuredEnvironment.JIGWRIGHT_AGENT_PROVIDER_CONFIG !== undefined) {
      process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG =
        configuredEnvironment.JIGWRIGHT_AGENT_PROVIDER_CONFIG;
    }
  } catch (error) {
    printJigwrightFailure(error, 'JIGWRIGHT_SETUP_CONFIG_INVALID');
    process.exit(12);
  }
}
const installedRuntimeManifest = fileURLToPath(
  new URL('./installed-runtime.json', import.meta.url),
);
const result = fs.existsSync(installedRuntimeManifest)
  ? (
      await import('./installed-runtime-launcher.mjs')
    ).runInstalledJigwrightRuntime(argv, repositoryRoot)
  : childProcess.spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(new URL('./workflow-launcher.ts', import.meta.url)),
        ...argv,
      ],
      {
        cwd: repositoryRoot,
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

function resolveRepositoryInvocation(requestedArgv) {
  if (requestedArgv[0] !== '--repository-root') {
    return Object.freeze({
      argv: Object.freeze([...requestedArgv]),
      repositoryRoot: process.cwd(),
    });
  }
  const requestedRoot = requestedArgv[1];
  if (
    typeof requestedRoot !== 'string' ||
    !path.isAbsolute(requestedRoot) ||
    requestedArgv.length < 3
  ) {
    throw repositoryRootInvalid();
  }
  let repositoryRoot;
  try {
    const stats = fs.statSync(requestedRoot, { throwIfNoEntry: false });
    if (!stats?.isDirectory()) throw repositoryRootInvalid();
    repositoryRoot = fs.realpathSync(requestedRoot);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'JIGWRIGHT_REPOSITORY_ROOT_INVALID'
    ) {
      throw error;
    }
    throw repositoryRootInvalid();
  }
  return Object.freeze({
    argv: Object.freeze(requestedArgv.slice(2)),
    repositoryRoot,
  });
}

function repositoryRootInvalid() {
  return Object.assign(
    new Error(
      'The Jigwright repository root must be an existing absolute directory.',
    ),
    { code: 'JIGWRIGHT_REPOSITORY_ROOT_INVALID' },
  );
}

function printJigwrightFailure(error, fallbackCode) {
  const result = {
    ok: false,
    error: {
      code:
        error && typeof error === 'object' && 'code' in error
          ? error.code
          : fallbackCode,
      message: error instanceof Error ? error.message : String(error),
    },
  };
  process.stderr.write(
    process.argv.at(-1) === '--json'
      ? `${JSON.stringify(result)}\n`
      : renderHumanCommandResult(result),
  );
}
