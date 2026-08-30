import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(import.meta.dirname, '..');
const runtimeManifestPath = fileURLToPath(
  new URL('./installed-runtime.json', import.meta.url),
);
export function runInstalledJigwrightRuntime(
  argv,
  repositoryRoot = process.cwd(),
) {
  const runtimeRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'jigwright-installed-runtime-')),
  );
  try {
    const manifest = readRuntimeManifest();
    const packages = materializePackages(runtimeRoot, manifest.packages);
    linkWorkspacePackages(packages);
    return childProcess.spawnSync(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          runtimeRoot,
          'packages',
          'workflow-engine',
          'bootstrap',
          'workflow-launcher.ts',
        ),
        ...argv,
      ],
      {
        cwd: repositoryRoot,
        env: process.env,
        stdio: 'inherit',
        windowsHide: true,
      },
    );
  } finally {
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

function readRuntimeManifest() {
  const value = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'));
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'jigwright-installed-runtime.v1' ||
    !Array.isArray(value.packages)
  ) {
    throw new Error('Installed Jigwright runtime manifest is invalid.');
  }
  return value;
}

function materializePackages(runtimeRoot, descriptors) {
  const packages = new Map();
  for (const descriptor of descriptors) {
    assertDescriptor(descriptor);
    const sourceRoot = runtimePackageSourceRoot(descriptor);
    const targetRoot = path.join(
      runtimeRoot,
      ...descriptor.sourceRoot.split('/'),
    );
    fs.mkdirSync(targetRoot, { recursive: true });
    copyDirectory(path.join(sourceRoot, 'src'), path.join(targetRoot, 'src'));
    if (descriptor.name === 'jigwright') {
      copyDirectory(
        path.join(sourceRoot, 'bootstrap'),
        path.join(targetRoot, 'bootstrap'),
      );
      copyDirectory(
        path.join(sourceRoot, 'native'),
        path.join(targetRoot, 'native'),
      );
    }
    fs.writeFileSync(
      path.join(targetRoot, 'package.json'),
      Buffer.from(descriptor.sourceManifestBase64, 'base64'),
      { mode: 0o644 },
    );
    packages.set(descriptor.name, targetRoot);
  }
  return packages;
}

function linkWorkspacePackages(packages) {
  const scoped = [...packages.entries()].filter(([name]) =>
    name.startsWith('@jigwright/'),
  );
  for (const packagePath of packages.values()) {
    const scopeRoot = path.join(packagePath, 'node_modules', '@jigwright');
    fs.mkdirSync(scopeRoot, { recursive: true });
    for (const [name, targetRoot] of scoped) {
      fs.symlinkSync(
        targetRoot,
        path.join(scopeRoot, name.slice('@jigwright/'.length)),
        'dir',
      );
    }
  }
}

function runtimePackageSourceRoot(descriptor) {
  if (descriptor.name === 'jigwright') {
    return packageRoot;
  }
  return path.join(packageRoot, descriptor.embeddedSourceRoot);
}

function copyDirectory(source, target) {
  const stats = fs.lstatSync(source, { throwIfNoEntry: false });
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Installed Jigwright runtime path is invalid: ${source}`);
  }
  fs.cpSync(source, target, {
    recursive: true,
    dereference: false,
    preserveTimestamps: true,
  });
}

function assertDescriptor(value) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !==
      ['embeddedSourceRoot', 'name', 'sourceManifestBase64', 'sourceRoot']
        .sort()
        .join('\0') ||
    typeof value.name !== 'string' ||
    typeof value.sourceRoot !== 'string' ||
    (value.name === 'jigwright'
      ? value.embeddedSourceRoot !== null
      : typeof value.embeddedSourceRoot !== 'string' ||
        !/^bootstrap\/installed-runtime-sources\/[a-z0-9-]+$/u.test(
          value.embeddedSourceRoot,
        )) ||
    typeof value.sourceManifestBase64 !== 'string' ||
    !/^packages\/[a-z0-9-]+$/u.test(value.sourceRoot)
  ) {
    throw new Error('Installed Jigwright runtime package is invalid.');
  }
}
