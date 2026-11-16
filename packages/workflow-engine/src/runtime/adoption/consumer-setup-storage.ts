/** Repository and host setup observations and safe writes; never launches a provider. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseAgentProviderConfigToml } from '@jigwright/core/agent-provider-config';
import { resolveBuiltInProviderDefinitionSnapshot } from '@jigwright/core/built-in-provider-definition';
import { listBuiltInProviderFamilies } from '@jigwright/core/built-in-provider-catalog';
import {
  PROFILE_PATH,
  isObject,
  initError,
  type Answers,
  type SetupProviderDefinition,
} from '../../modules/adoption/setup-questions.ts';

export function createConsumerSetupStorage(repositoryRoot: string) {
  const root = fs.realpathSync(repositoryRoot);
  return {
    repository: {
      root,
      read: (relativePath: string) => readConfig(root, relativePath),
      exists: (relativePath: string) =>
        fs.existsSync(path.join(root, relativePath)),
      assertPath: (relativePath: string) =>
        assertSafePath(root, path.join(root, relativePath)),
      write(relativePath: string, value: Answers) {
        const target = path.join(root, relativePath);
        assertSafePath(root, target);
        writeJson(target, value, 0o644);
      },
      profileDigest: () =>
        `sha256:${crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(root, PROFILE_PATH)))
          .digest('hex')}`,
    },
    host: {
      readState() {
        const hostPath = setupHostPath(root);
        return { path: hostPath, value: readObject(hostPath) };
      },
      defaultProviderPath: () =>
        process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG ?? null,
      exists: (absolutePath: string) => fs.existsSync(absolutePath),
      validateProviderPath: (absolutePath: string) =>
        validateProviderPath(root, absolutePath),
      canonicalPath: canonicalProspectivePath,
      providerDefaults() {
        const providers: SetupProviderDefinition[] =
          listBuiltInProviderFamilies().flatMap((family) => {
            const definition = resolveBuiltInProviderDefinitionSnapshot(
              family,
              process.platform,
            );
            return definition === null ? [] : [definition];
          });
        return {
          providers,
          existingExecutables: providers.flatMap((definition) =>
            definition.executableCandidates.filter((candidate) =>
              fs.existsSync(candidate),
            ),
          ),
        };
      },
      validateProviderDocument: (document: string) => {
        parseAgentProviderConfigToml(document, { platform: process.platform });
      },
      createProviderConfig(absolutePath: string, document: string) {
        fs.mkdirSync(path.dirname(absolutePath), {
          recursive: true,
          mode: 0o700,
        });
        fs.writeFileSync(absolutePath, document, { flag: 'wx', mode: 0o600 });
      },
      writeState: (absolutePath: string, value: Answers) =>
        writeJson(absolutePath, value, 0o600),
    },
  };
}
export function readSetupAnswers(requestedPath: string): Answers {
  if (!fs.existsSync(path.resolve(requestedPath)))
    throw initError(
      'JIGWRIGHT_INIT_ANSWER_INVALID',
      'Setup answers file does not exist.',
    );
  return readObject(path.resolve(requestedPath));
}
function validateProviderPath(root: string, answer: string): string {
  const providerPath = canonicalProspectivePath(answer);
  if (providerPath === root || providerPath.startsWith(`${root}${path.sep}`))
    throw initError(
      'JIGWRIGHT_INIT_ANSWER_INVALID',
      'Provider configuration must remain outside the repository.',
    );
  if (fs.existsSync(providerPath))
    parseAgentProviderConfigToml(fs.readFileSync(providerPath, 'utf8'), {
      platform: process.platform,
    });
  return providerPath;
}
export function configuredJigwrightEnvironment(
  repositoryRoot: string,
): NodeJS.ProcessEnv {
  if (process.env.JIGWRIGHT_AGENT_PROVIDER_CONFIG !== undefined)
    return process.env;
  const configured = readObject(
    setupHostPath(fs.realpathSync(repositoryRoot)),
  ).providerConfig;
  return typeof configured === 'string'
    ? { ...process.env, JIGWRIGHT_AGENT_PROVIDER_CONFIG: configured }
    : process.env;
}

function canonicalProspectivePath(requestedPath: string): string {
  const resolvedPath = path.resolve(requestedPath);
  let existingParent = resolvedPath;
  while (true) {
    const stats = fs.lstatSync(existingParent, { throwIfNoEntry: false });
    if (stats) {
      if (stats.isSymbolicLink() && !fs.existsSync(existingParent))
        throw initError(
          'JIGWRIGHT_INIT_PATH_UNSAFE',
          'Host configuration path contains a dangling symbolic link.',
        );
      break;
    }
    existingParent = path.dirname(existingParent);
  }
  if (
    existingParent !== resolvedPath &&
    !fs.statSync(existingParent).isDirectory()
  )
    throw initError(
      'JIGWRIGHT_INIT_PATH_UNSAFE',
      'Host configuration parent must be a directory.',
    );
  return path.resolve(
    fs.realpathSync(existingParent),
    path.relative(existingParent, resolvedPath),
  );
}

function setupHostPath(root: string): string {
  const requestedDirectory = path.resolve(
    process.env.JIGWRIGHT_SETUP_HOME ??
      path.join(os.homedir(), '.config', 'jigwright', 'setup'),
  );
  const directory = canonicalProspectivePath(requestedDirectory);
  if (directory === root || directory.startsWith(`${root}${path.sep}`))
    throw initError(
      'JIGWRIGHT_INIT_PATH_UNSAFE',
      'Setup host state must remain outside the repository.',
    );
  return path.join(
    directory,
    `${crypto.createHash('sha256').update(root).digest('hex')}.json`,
  );
}

function readConfig(root: string, relativePath: string): Answers {
  const target = path.join(root, relativePath);
  assertSafePath(root, target);
  return readObject(target);
}
function readObject(target: string): Answers {
  const stats = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!stats) return {};
  if (!stats.isFile() || stats.isSymbolicLink())
    throw initError(
      'JIGWRIGHT_INIT_PATH_UNSAFE',
      'Setup configuration must be a regular file.',
    );
  const value: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
  if (!isObject(value))
    throw initError(
      'JIGWRIGHT_INIT_ANSWER_INVALID',
      'Setup configuration must be a JSON object.',
    );
  return value;
}
function writeJson(target: string, value: Answers, mode: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode,
    });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function assertSafePath(root: string, target: string): void {
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (
      stats?.isSymbolicLink() ||
      (stats && current !== target && !stats.isDirectory())
    )
      throw initError(
        'JIGWRIGHT_INIT_PATH_UNSAFE',
        'Setup configuration path is unsafe.',
      );
  }
}
