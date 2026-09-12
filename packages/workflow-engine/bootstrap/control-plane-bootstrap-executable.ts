import { WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT } from './workflow-bootstrap-host.ts';
/** Generate the pinned supervisor executable and verify its restart protocol. */
import childProcess from 'node:child_process';
import path from 'node:path';
import {
  isDigest,
  safeClosurePath,
  BUILT_IN_BOOTSTRAP_RUNTIME_PATHS,
  builtInClosureMismatch,
  BUILT_IN_PROTOCOL_VERSION,
  BUILT_IN_SESSION_SCHEMA,
  BUILT_IN_POLICY_SCHEMA_VERSION,
  MAX_CLOSURE_FILE_BYTES,
  PROCESS_TIMEOUT_MS,
  PROCESS_MAX_BUFFER_BYTES,
  processVerificationFailed,
  isRecord,
  hasExactKeys,
} from './control-plane-bootstrap-values.ts';
import type {
  Sha256Digest,
  BuiltInClosureManifest,
  VerifiedProtectedCapabilityManifest,
  BuiltInClosureManifestV2,
  BootstrapPaths,
  BootstrapControlPlaneSupervisorState,
} from './control-plane-bootstrap-types.ts';
import { assertConfinedExecutable } from './control-plane-bootstrap-files.ts';

export function builtInSupervisorExecutableSource(
  builtInClosureDigest: Sha256Digest,
  controlPlaneClosureDigest: Sha256Digest,
  manifest: BuiltInClosureManifest,
  bootstrapRuntimeFiles: VerifiedProtectedCapabilityManifest['bootstrapRuntimeFiles'],
): string {
  return builtInSupervisorExecutableSourceV2(
    builtInClosureDigest,
    controlPlaneClosureDigest,
    manifest,
    bootstrapRuntimeFiles,
  );
}

function builtInSupervisorExecutableSourceV2(
  builtInClosureDigest: Sha256Digest,
  controlPlaneClosureDigest: Sha256Digest,
  manifest: BuiltInClosureManifestV2,
  bootstrapRuntimeFiles: VerifiedProtectedCapabilityManifest['bootstrapRuntimeFiles'],
): string {
  const runtimeDescriptors = bootstrapRuntimeFiles.map(
    ({ path: filePath, mode, digest }) => ({
      path: filePath,
      mode,
      digest,
    }),
  );
  if (
    !isDigest(builtInClosureDigest) ||
    !isDigest(controlPlaneClosureDigest) ||
    !safeClosurePath(manifest.entrypoint) ||
    runtimeDescriptors.length !== BUILT_IN_BOOTSTRAP_RUNTIME_PATHS.length ||
    runtimeDescriptors.some(
      (entry, index) =>
        entry.path !==
          BUILT_IN_BOOTSTRAP_RUNTIME_PATHS[index].slice(
            'packages/workflow-engine/'.length,
          ) ||
        (entry.mode !== '100644' && entry.mode !== '100755') ||
        !isDigest(entry.digest),
    ) ||
    /[\s\0\r\n]/.test(process.execPath)
  ) {
    throw builtInClosureMismatch();
  }
  return `#!${process.execPath}
'use strict';
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const BUILT_IN_CLOSURE_DIGEST = ${JSON.stringify(builtInClosureDigest)};
const CONTROL_PLANE_CLOSURE_DIGEST = ${JSON.stringify(controlPlaneClosureDigest)};
const ENTRYPOINT = ${JSON.stringify(manifest.entrypoint)};
const HOST_ENTRYPOINT = ${JSON.stringify(WORKFLOW_BOOTSTRAP_HOST_ENTRYPOINT)};
const PACKAGES = ${JSON.stringify(manifest.packages)};
const BOOTSTRAP_RUNTIME_FILES = ${JSON.stringify(runtimeDescriptors)};
const SOURCE_CHANGE_ID = 'repository-default-built-in';
const PROTOCOL_VERSION = ${BUILT_IN_PROTOCOL_VERSION};
const SESSION_SCHEMA = ${JSON.stringify(BUILT_IN_SESSION_SCHEMA)};
const POLICY_SCHEMA_VERSION = ${BUILT_IN_POLICY_SCHEMA_VERSION};
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_EXECUTABLE_MODE = 0o500;
const MAX_BYTES = ${MAX_CLOSURE_FILE_BYTES};

function digest(value) {
  return 'sha256:' + crypto.createHash('sha256').update(value).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
}

function exactKeys(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function assertDirectory(directory) {
  const stats = fs.lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink() ||
      (stats.mode & 0o777) !== PRIVATE_DIRECTORY_MODE ||
      fs.realpathSync(directory) !== directory) throw new Error('unsafe directory');
}

function readPrivateFile(filePath, mode) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 ||
      (stats.mode & 0o777) !== mode || stats.size < 1 || stats.size > MAX_BYTES ||
      fs.realpathSync(filePath) !== filePath) throw new Error('unsafe file');
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor);
    const bytes = fs.readFileSync(descriptor);
    if (opened.dev !== stats.dev || opened.ino !== stats.ino ||
        opened.size !== stats.size || bytes.length !== stats.size) throw new Error('changed file');
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function safePath(value) {
  return typeof value === 'string' && value.length > 0 && value === value.normalize('NFC') &&
    !path.isAbsolute(value) && !value.includes('\\\\') && !/[*?[\\]{}]/.test(value) &&
    value.split('/').every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function packageForPath(packages, artifactPath) {
  const matches = [];
  for (const descriptor of packages) {
    const relativePath = descriptor.closureRoot === '.'
      ? artifactPath
      : artifactPath.startsWith(descriptor.closureRoot + '/')
        ? artifactPath.slice(descriptor.closureRoot.length + 1)
        : null;
    if (relativePath !== null && (relativePath === 'package.json' ||
        (relativePath.startsWith('src/') && relativePath.endsWith('.ts')))) {
      matches.push({ descriptor, relativePath });
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

function listAllFiles(packageRoot, directory) {
  assertDirectory(directory);
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('indirect closure');
    if (entry.isDirectory()) files.push(...listAllFiles(packageRoot, absolute));
    else if (entry.isFile()) files.push(path.relative(packageRoot, absolute).split(path.sep).join('/'));
    else throw new Error('unsupported closure entry');
  }
  return files.sort();
}

function verifyPackages(packages) {
  if (!Array.isArray(packages) || packages.length === 0 || canonical(packages) !== canonical(PACKAGES)) {
    throw new Error('package descriptors');
  }
  const names = [];
  const roots = [];
  for (const descriptor of packages) {
    if (!exactKeys(descriptor, ['closureRoot', 'name', 'sourceRoot']) ||
        typeof descriptor.name !== 'string' || typeof descriptor.sourceRoot !== 'string' ||
        typeof descriptor.closureRoot !== 'string' || !safePath(descriptor.sourceRoot) ||
        !descriptor.sourceRoot.startsWith('packages/') || descriptor.sourceRoot.split('/').length !== 2 ||
        (descriptor.name === 'jigwright'
          ? descriptor.sourceRoot !== 'packages/workflow-engine' || descriptor.closureRoot !== '.'
          : !/^@jigwright\\/[a-z0-9][a-z0-9._-]*$/.test(descriptor.name) ||
            descriptor.closureRoot !== 'node_modules/' + descriptor.name ||
            !safePath(descriptor.closureRoot))) {
      throw new Error('package descriptor');
    }
    names.push(descriptor.name);
    roots.push(descriptor.closureRoot);
  }
  if (new Set(names).size !== names.length || new Set(roots).size !== roots.length ||
      JSON.stringify(roots) !== JSON.stringify([...roots].sort()) ||
      roots.filter((value) => value === '.').length !== 1) {
    throw new Error('package descriptor inventory');
  }
}

function verifyWorkspaceDependencies(closureRoot, packages) {
  const byName = new Map(packages.map((descriptor) => [descriptor.name, descriptor]));
  const dependencies = new Map();
  for (const descriptor of packages) {
    const packagePath = descriptor.closureRoot === '.'
      ? path.join(closureRoot, 'package.json')
      : path.join(closureRoot, ...descriptor.closureRoot.split('/'), 'package.json');
    const packageManifest = JSON.parse(readPrivateFile(packagePath, PRIVATE_FILE_MODE).toString('utf8'));
    if (packageManifest === null || typeof packageManifest !== 'object' || Array.isArray(packageManifest) ||
        packageManifest.name !== descriptor.name) throw new Error('package identity');
    const packageDependencies = new Set();
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      const declared = packageManifest[field];
      if (declared === undefined) continue;
      if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
        throw new Error('package dependencies');
      }
      for (const [dependencyName, specification] of Object.entries(declared)) {
        if (!dependencyName.startsWith('@jigwright/') || specification !== 'workspace:*' ||
            !byName.has(dependencyName) || packageDependencies.has(dependencyName)) {
          throw new Error('workspace dependency');
        }
        packageDependencies.add(dependencyName);
      }
    }
    dependencies.set(descriptor.name, [...packageDependencies]);
  }
  const reachable = new Set();
  const visiting = new Set();
  function visit(packageName) {
    if (visiting.has(packageName)) throw new Error('workspace dependency cycle');
    if (reachable.has(packageName)) return;
    visiting.add(packageName);
    for (const dependency of dependencies.get(packageName) || []) visit(dependency);
    visiting.delete(packageName);
    reachable.add(packageName);
  }
  visit('jigwright');
  if (reachable.size !== packages.length) throw new Error('workspace dependency inventory');
}

function verifyClosure() {
  const artifactRoot = fs.realpathSync(__dirname);
  if (artifactRoot !== __dirname) throw new Error('indirect artifact');
  assertDirectory(artifactRoot);
  const closureRoot = path.join(artifactRoot, 'closure');
  assertDirectory(closureRoot);
  const manifestBytes = readPrivateFile(
    path.join(artifactRoot, 'built-in-engine-closure.json'),
    PRIVATE_FILE_MODE,
  );
  if (digest(manifestBytes) !== BUILT_IN_CLOSURE_DIGEST) throw new Error('manifest digest');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (JSON.stringify(manifest, null, 2) + '\\n' !== manifestBytes.toString('utf8') ||
      !exactKeys(manifest, ['entrypoint', 'files', 'kind', 'packages', 'scope']) ||
      manifest.kind !== 'built-in-engine-closure-manifest.v2' ||
      manifest.entrypoint !== ENTRYPOINT || manifest.scope !== 'workspace-runtime-source-closure' ||
      !Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error('manifest shape');
  }
  verifyPackages(manifest.packages);
  const listed = [];
  for (const entry of manifest.files) {
    if (!exactKeys(entry, ['digest', 'mode', 'path']) || !safePath(entry.path) ||
        packageForPath(manifest.packages, entry.path) === null ||
        (entry.mode !== '100644' && entry.mode !== '100755') ||
        !/^sha256:[0-9a-f]{64}$/.test(entry.digest)) throw new Error('manifest entry');
    const target = path.join(closureRoot, ...entry.path.split('/'));
    if (path.resolve(target) !== target || !target.startsWith(closureRoot + path.sep)) {
      throw new Error('escaped closure');
    }
    if (digest(readPrivateFile(target, PRIVATE_FILE_MODE)) !== entry.digest) {
      throw new Error('closure digest');
    }
    listed.push(entry.path);
  }
  const sorted = [...new Set(listed)].sort();
  if (JSON.stringify(listed) !== JSON.stringify(sorted) || !listed.includes(ENTRYPOINT)) {
    throw new Error('closure inventory');
  }
  for (const descriptor of manifest.packages) {
    const packagePath = descriptor.closureRoot === '.'
      ? 'package.json'
      : descriptor.closureRoot + '/package.json';
    if (!listed.includes(packagePath)) throw new Error('package inventory');
  }
  verifyWorkspaceDependencies(closureRoot, manifest.packages);
  for (const entry of BOOTSTRAP_RUNTIME_FILES) {
    if (!exactKeys(entry, ['digest', 'mode', 'path']) || !safePath(entry.path) ||
        !entry.path.startsWith('bootstrap/') ||
        (entry.mode !== '100644' && entry.mode !== '100755') ||
        !/^sha256:[0-9a-f]{64}$/.test(entry.digest)) throw new Error('bootstrap runtime entry');
    const target = path.join(closureRoot, ...entry.path.split('/'));
    if (digest(readPrivateFile(target, PRIVATE_FILE_MODE)) !== entry.digest) {
      throw new Error('bootstrap runtime digest');
    }
  }
  const completeInventory = [...listed, ...BOOTSTRAP_RUNTIME_FILES.map((entry) => entry.path)].sort();
  if (JSON.stringify(listAllFiles(closureRoot, closureRoot)) !== JSON.stringify(completeInventory)) {
    throw new Error('complete closure inventory');
  }
  const selfBytes = readPrivateFile(__filename, PRIVATE_EXECUTABLE_MODE);
  const executableDigest = digest(selfBytes);
  const selfTest = {
    kind: 'control-plane-self-test.v1',
    healthy: true,
    closureDigest: CONTROL_PLANE_CLOSURE_DIGEST,
  };
  const artifactPayload = {
    kind: 'engine-artifact.v1',
    sourceChangeId: SOURCE_CHANGE_ID,
    sourceDigest: BUILT_IN_CLOSURE_DIGEST,
    executableDigest,
    protocolVersion: PROTOCOL_VERSION,
    canReadSessionSchemas: [SESSION_SCHEMA],
    writesSessionSchema: SESSION_SCHEMA,
    policySchemaVersion: POLICY_SCHEMA_VERSION,
    smokeReportDigest: digest(canonical(selfTest)),
  };
  const artifact = { ...artifactPayload, artifactId: digest(canonical(artifactPayload)) };
  const artifactBytes = readPrivateFile(
    path.join(artifactRoot, 'engine-artifact.json'),
    PRIVATE_FILE_MODE,
  );
  const observedArtifact = JSON.parse(artifactBytes.toString('utf8'));
  if (canonical(observedArtifact) + '\\n' !== artifactBytes.toString('utf8') ||
      canonical(observedArtifact) !== canonical(artifact)) throw new Error('artifact metadata');
  return { closureRoot, selfTest };
}

try {
  const verified = verifyClosure();
  if (process.argv.length === 3 && process.argv[2] === '--control-plane-restart-probe') {
    process.stdout.write(JSON.stringify({
      kind: 'control-plane-restart.v1',
      ready: true,
      closureDigest: CONTROL_PLANE_CLOSURE_DIGEST,
    }) + '\\n');
    process.exit(0);
  }
  if (process.argv.length === 3 && process.argv[2] === '--control-plane-self-test') {
    process.stdout.write(JSON.stringify(verified.selfTest) + '\\n');
    process.exit(0);
  }
  if (!BOOTSTRAP_RUNTIME_FILES.some((entry) => entry.path === HOST_ENTRYPOINT)) throw new Error('Workflow host is missing from the verified bootstrap inventory.');
  const entrypointPath = path.join(verified.closureRoot, ...HOST_ENTRYPOINT.split('/'));
  const closureUrl = require('node:url').pathToFileURL(verified.closureRoot + path.sep).href;
  const hookSource = [
    "import fs from 'node:fs';",
    "import { registerHooks, stripTypeScriptTypes } from 'node:module';",
    'const CLOSURE_URL = ' + JSON.stringify(closureUrl) + ';',
    'registerHooks({ load(url, context, nextLoad) {',
    "  if (url.startsWith('file:') && !url.startsWith(CLOSURE_URL)) throw new Error('module escaped closure');",
    "  if (url.startsWith(CLOSURE_URL) && url.endsWith('.ts')) {",
    "    const source = fs.readFileSync(new URL(url), 'utf8');",
    "    return { format: 'module', shortCircuit: true, source: stripTypeScriptTypes(source, { mode: 'strip' }) };",
    '  }',
    '  return nextLoad(url, context);',
    '} });',
  ].join('\\n');
  const hookUrl = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(hookSource);
  const result = childProcess.spawnSync(
    process.execPath,
    ['--import', hookUrl, entrypointPath, ...process.argv.slice(2)],
    { cwd: process.cwd(), env: process.env, stdio: 'inherit', windowsHide: true },
  );
  if (result.error !== undefined) throw result.error;
  if (result.signal !== null) {
    process.kill(process.pid, result.signal);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} catch (error) {
  process.stderr.write(JSON.stringify({
    kind: 'control-plane-bootstrap-artifact-error.v1',
    code: 'CONTROL_PLANE_BOOTSTRAP_ARTIFACT_MISMATCH',
    message: error instanceof Error ? error.message : String(error),
  }) + '\\n');
  process.exit(13);
}
`;
}

export function runRestartProbe(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
): void {
  assertConfinedExecutable(paths, supervisor);
  const executablePath = supervisor.activeArtifact.executablePath;
  const cwd = path.dirname(executablePath);
  const result = childProcess.spawnSync(
    executablePath,
    ['--control-plane-restart-probe'],
    {
      cwd,
      env: {
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LANG: 'C',
        LC_ALL: 'C',
        TMPDIR: cwd,
      },
      encoding: 'utf8',
      timeout: PROCESS_TIMEOUT_MS,
      maxBuffer: PROCESS_MAX_BUFFER_BYTES,
      windowsHide: true,
    },
  );
  if (
    result.error !== undefined ||
    result.signal !== null ||
    result.status !== 0 ||
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout) > PROCESS_MAX_BUFFER_BYTES
  ) {
    throw processVerificationFailed(
      'Control-plane restart probe did not exit cleanly.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout.trim());
  } catch {
    throw processVerificationFailed(
      'Control-plane restart probe returned invalid JSON.',
    );
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['closureDigest', 'kind', 'ready']) ||
    value.kind !== 'control-plane-restart.v1' ||
    value.ready !== true ||
    value.closureDigest !== supervisor.activeArtifact.closureDigest
  ) {
    throw processVerificationFailed(
      'Control-plane restart probe response is invalid.',
    );
  }
}
