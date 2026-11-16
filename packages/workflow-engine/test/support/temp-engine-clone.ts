import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const COPY_PATHS = Object.freeze([
  'packages/agent-runtime',
  'packages/core',
  'packages/grants',
  'packages/github-adapter',
  'packages/repository-runtime',
  'packages/openspec-adapter',
  'packages/workflow-engine',
] as const);
const PROTECTED_MANIFEST_PATH = 'workflow/protected-capabilities.json';
const COMMAND_TIMEOUT_MS = 30_000;

export type TempEngineClone = Readonly<{
  repositoryRoot: string;
  importModule<T>(repositoryPath: string): Promise<T>;
  git(args: readonly string[]): string;
  appendCompositionDrift(repositoryPath: string): void;
  dispose(): void;
}>;

export type TempEngineCloneOptions = Readonly<{
  maintainerPolicy?: Readonly<{
    repository: Readonly<{ origin: string }>;
    [key: string]: unknown;
  }>;
}>;

/**
 * Clone committed repository structure, overlay the current engine packages,
 * then regenerate the protected manifest with the clone's own generator.
 * Production modules are always imported from the clone, never from the test
 * process's source tree.
 */
export async function createTempEngineClone(
  sourceRepositoryRoot: string,
  options: TempEngineCloneOptions = {},
): Promise<TempEngineClone> {
  const sourceRoot = fs.realpathSync(sourceRepositoryRoot);
  const parent = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-engine-clone-')),
  );
  const repositoryRoot = path.join(parent, 'repository');
  const cloned = run('git', [
    'clone',
    '--quiet',
    '--no-hardlinks',
    sourceRoot,
    repositoryRoot,
  ]);
  try {
    assertSucceeded(cloned, 'Temporary engine clone failed.');
    for (const repositoryPath of COPY_PATHS) {
      const target = path.join(repositoryRoot, repositoryPath);
      fs.rmSync(target, { recursive: true, force: true });
      fs.cpSync(path.join(sourceRoot, repositoryPath), target, {
        recursive: true,
        force: true,
        verbatimSymlinks: true,
      });
    }
    fs.copyFileSync(
      path.join(sourceRoot, PROTECTED_MANIFEST_PATH),
      path.join(repositoryRoot, PROTECTED_MANIFEST_PATH),
    );
    if (options.maintainerPolicy !== undefined) {
      fs.writeFileSync(
        path.join(repositoryRoot, 'workflow/maintainer-policy.json'),
        `${JSON.stringify(options.maintainerPolicy, null, 2)}\n`,
        'utf8',
      );
      const remote = run('git', [
        '-C',
        repositoryRoot,
        'remote',
        'set-url',
        'origin',
        options.maintainerPolicy.repository.origin,
      ]);
      assertSucceeded(remote, 'Temporary clone origin setup failed.');
    }
    linkExternalDependencies(sourceRoot, repositoryRoot);
    // Every workspace import must resolve within this clone, including optional Grants.
    for (const repositoryPath of COPY_PATHS) {
      const packageRoot = path.join(repositoryRoot, repositoryPath);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'),
      );
      for (const dependency of Object.keys({
        ...manifest.dependencies,
        ...manifest.optionalDependencies,
      })) {
        if (!dependency.startsWith('@jigwright/')) continue;
        const link = path.join(packageRoot, 'node_modules', dependency);
        fs.rmSync(link, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(link), { recursive: true });
        fs.symlinkSync(
          path.join(
            repositoryRoot,
            'packages',
            dependency.slice('@jigwright/'.length),
          ),
          link,
          'dir',
        );
      }
    }
    supplementReviewedComposition(repositoryRoot);

    const generator = await importFromClone<{
      generateProtectedCapabilitiesManifest(
        root: string,
        mode: '--check' | '--write',
      ): Promise<unknown>;
    }>(
      repositoryRoot,
      'packages/workflow-engine/bootstrap/generate-protected-capabilities.ts',
    );
    await generator.generateProtectedCapabilitiesManifest(
      repositoryRoot,
      '--write',
    );
    await generator.generateProtectedCapabilitiesManifest(
      repositoryRoot,
      '--check',
    );
    commitCurrentClone(repositoryRoot);

    let disposed = false;
    return Object.freeze({
      repositoryRoot,
      importModule<T>(repositoryPath: string): Promise<T> {
        return importFromClone<T>(repositoryRoot, repositoryPath);
      },
      git(args: readonly string[]): string {
        const result = run('git', ['-C', repositoryRoot, ...args]);
        assertSucceeded(result, `Temporary clone Git ${args[0]} failed.`);
        return result.stdout.trim();
      },
      appendCompositionDrift(repositoryPath: string): void {
        const target = exactRepositoryFile(repositoryRoot, repositoryPath);
        fs.appendFileSync(target, '\n// test-only composition drift\n', 'utf8');
      },
      dispose(): void {
        if (disposed) return;
        disposed = true;
        fs.rmSync(parent, { recursive: true, force: true });
      },
    });
  } catch (error) {
    fs.rmSync(parent, { recursive: true, force: true });
    throw error;
  }
}

function commitCurrentClone(repositoryRoot: string): void {
  for (const args of [
    ['config', 'user.name', 'Workflow Test'],
    ['config', 'user.email', 'workflow@example.test'],
    ['add', '--all'],
    [
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--allow-empty',
      '-m',
      'Prepare temporary engine clone',
    ],
  ] as const) {
    const result = run('git', ['-C', repositoryRoot, ...args]);
    assertSucceeded(result, `Temporary clone Git ${args[0]} failed.`);
  }
}

async function importFromClone<T>(
  repositoryRoot: string,
  repositoryPath: string,
): Promise<T> {
  const target = exactRepositoryFile(repositoryRoot, repositoryPath);
  const moduleUrl = pathToFileURL(target);
  moduleUrl.searchParams.set('clone', crypto.randomUUID());
  return (await import(moduleUrl.href)) as T;
}

function exactRepositoryFile(
  repositoryRoot: string,
  repositoryPath: string,
): string {
  if (
    path.isAbsolute(repositoryPath) ||
    repositoryPath.includes('\\') ||
    repositoryPath.split('/').some((part) => part === '' || part === '..')
  ) {
    throw new TypeError('Temporary clone path is invalid.');
  }
  const target = path.join(repositoryRoot, repositoryPath);
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile() || stats.isSymbolicLink()) {
    throw new TypeError('Temporary clone path is not a regular file.');
  }
  return target;
}

function linkExternalDependencies(
  sourceRepositoryRoot: string,
  repositoryRoot: string,
): void {
  const source = path.join(sourceRepositoryRoot, 'node_modules');
  const target = path.join(repositoryRoot, 'node_modules');
  if (!fs.existsSync(source) || fs.existsSync(target)) return;
  fs.symlinkSync(source, target, 'dir');
}

function supplementReviewedComposition(repositoryRoot: string): void {
  const manifestPath = path.join(repositoryRoot, PROTECTED_MANIFEST_PATH);
  const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
    grantVerifierComposition?: Record<string, unknown>;
  };
  const composition = parsed.grantVerifierComposition;
  if (composition === undefined) {
    throw new Error(
      'Temporary clone requires the reviewed grant verifier composition.',
    );
  }
  composition.packageVersion = '0.1.0';
  composition.verifierImplementation = 'ssh-maintainer-policy.v1';
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(parsed, null, 2)}\n`,
    'utf8',
  );
}

function run(
  command: string,
  args: readonly string[],
): SpawnSyncReturns<string> {
  return spawnSync(command, [...args], {
    encoding: 'utf8',
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
  });
}

function assertSucceeded(
  result: SpawnSyncReturns<string>,
  message: string,
): void {
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(message, {
      cause:
        result.error ??
        new Error(result.stderr.trim() || `exit status ${result.status}`),
    });
  }
}
