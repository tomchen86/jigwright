import fs from 'node:fs';
import path from 'node:path';

export const OPENSPEC_PACKAGE_NAME = '@fission-ai/openspec';
export const OPENSPEC_PACKAGE_VERSION = '1.6.0';
export const OPENSPEC_PACKAGE_INTEGRITY =
  'sha512-7yFTQ3hrrk11mQ2ACClNv2gtAN0o116vCgwoiQKmreoB6ambSnrZh7wf2FNFoSDBXHBi9iiCQ7G16fG71ZNppA==';

export type OpenSpecSupplyChainProvenance = {
  lockfileVersion: string;
  lockedVersion: string;
  integrity: string;
  buildScriptsAllowed: false;
};

type YamlLine = {
  indent: number;
  text: string;
};

type LineRange = { start: number; end: number };

export function verifyOpenSpecSupplyChain(
  repositoryRoot: string,
): OpenSpecSupplyChainProvenance {
  const configuration = supplyChainConfiguration(repositoryRoot);
  if (configuration.manager === 'npm')
    return verifyNpm(repositoryRoot, configuration.paths[0]!);
  if (configuration.manager === 'yarn')
    return verifyYarn(
      repositoryRoot,
      configuration.paths[1]!,
      configuration.manifest,
    );
  return verifyPnpm(repositoryRoot);
}

/** Selected package-manager inputs belong to the managed contract snapshot. */
export function openSpecSupplyChainPaths(repositoryRoot: string): string[] {
  return supplyChainConfiguration(repositoryRoot).paths;
}

function supplyChainConfiguration(repositoryRoot: string) {
  if (!fs.existsSync(path.join(repositoryRoot, 'package.json'))) {
    throw new Error(
      'Jigwright v1 supports JavaScript repositories with package.json; non-Node repositories are not supported.',
    );
  }
  const manifest = object(
    JSON.parse(readCanonicalTextFile(repositoryRoot, 'package.json')),
  );
  const declared =
    typeof manifest.packageManager === 'string'
      ? manifest.packageManager.split('@')[0]
      : undefined;
  const exists = (name: string) =>
    fs.existsSync(path.join(repositoryRoot, name));
  const npmLock = exists('npm-shrinkwrap.json')
    ? 'npm-shrinkwrap.json'
    : 'package-lock.json';
  const candidates = [
    ['pnpm', 'pnpm-lock.yaml'],
    ['npm', npmLock],
    ['yarn', 'yarn.lock'],
  ] as const;
  const selected =
    declared === undefined
      ? candidates.filter(([, lock]) => exists(lock))
      : candidates.filter(([manager]) => manager === declared);
  if (selected.length !== 1) {
    throw new Error(
      'Set package.json packageManager to npm, yarn, or pnpm and install its lockfile; the package manager is missing, ambiguous, or unsupported.',
    );
  }
  const [manager, lock] = selected[0]!;
  if (!exists(lock))
    throw new Error(
      `Install the declared ${manager} dependencies to create ${lock}.`,
    );
  const config =
    manager === 'pnpm'
      ? 'pnpm-workspace.yaml'
      : manager === 'npm'
        ? '.npmrc'
        : /^__metadata:\s*$/m.test(readCanonicalTextFile(repositoryRoot, lock))
          ? '.yarnrc.yml'
          : '.yarnrc';
  return { manager, paths: [lock, config], manifest };
}

function verifyNpm(
  repositoryRoot: string,
  lockPath: string,
): OpenSpecSupplyChainProvenance {
  requireSetting(
    readCanonicalTextFile(repositoryRoot, '.npmrc'),
    /^\s*ignore-scripts\s*=\s*([^;#\r\n]+)(?:[;#].*)?$/gm,
    'true',
    'npm ignore-scripts',
  );
  const lock = object(
    JSON.parse(readCanonicalTextFile(repositoryRoot, lockPath)),
  );
  if (lock.lockfileVersion !== 2 && lock.lockfileVersion !== 3) {
    throw new Error(
      'OpenSpec requires an npm lockfileVersion 2 or 3; refresh the lock with the selected npm version.',
    );
  }
  const packages = object(lock.packages);
  if (
    object(object(packages['']).devDependencies)[OPENSPEC_PACKAGE_NAME] !==
    OPENSPEC_PACKAGE_VERSION
  ) {
    throw new Error(
      'OpenSpec npm root dependency version is not pinned exactly.',
    );
  }
  const dependency = object(packages[`node_modules/${OPENSPEC_PACKAGE_NAME}`]);
  if (
    dependency.version !== OPENSPEC_PACKAGE_VERSION ||
    dependency.link === true
  ) {
    throw new Error(
      'OpenSpec npm locked version is not the pinned registry package.',
    );
  }
  if (dependency.integrity !== OPENSPEC_PACKAGE_INTEGRITY)
    throw new Error(
      'OpenSpec npm integrity differs from its exact package pin.',
    );
  return {
    lockfileVersion: String(lock.lockfileVersion),
    lockedVersion: OPENSPEC_PACKAGE_VERSION,
    integrity: OPENSPEC_PACKAGE_INTEGRITY,
    buildScriptsAllowed: false,
  };
}

function verifyYarn(
  repositoryRoot: string,
  configPath: string,
  manifest: Record<string, unknown>,
): OpenSpecSupplyChainProvenance {
  const modern = configPath === '.yarnrc.yml';
  const config = readCanonicalTextFile(repositoryRoot, configPath);
  if (modern) {
    requireSetting(
      config,
      /^enableScripts:\s*(.*?)\s*(?:#.*)?$/gm,
      'false',
      'Yarn enableScripts',
    );
    requireSetting(
      config,
      /^nodeLinker:\s*(.*?)\s*(?:#.*)?$/gm,
      'node-modules',
      'Yarn nodeLinker',
    );
    const metadata = manifest.dependenciesMeta;
    if (
      metadata !== undefined &&
      Object.entries(object(metadata)).some(
        ([name, value]) =>
          (name === OPENSPEC_PACKAGE_NAME ||
            name.startsWith(`${OPENSPEC_PACKAGE_NAME}@`)) &&
          object(value).built === true,
      )
    ) {
      throw new Error(
        'OpenSpec scripts must remain disabled in Yarn dependenciesMeta.',
      );
    }
  } else
    requireSetting(
      config,
      /^\s*(?:--install\.)?ignore-scripts\s+([^#\r\n]+)(?:#.*)?$/gm,
      'true',
      'Yarn ignore-scripts',
    );
  const lock = significantYamlLines(
    readCanonicalTextFile(repositoryRoot, 'yarn.lock'),
  );
  const descriptor = `${OPENSPEC_PACKAGE_NAME}@${modern ? 'npm:' : ''}${OPENSPEC_PACKAGE_VERSION}`;
  const dependency = uniqueLine(
    lock,
    wholeFile(lock),
    0,
    (line) =>
      line.text.endsWith(':') &&
      unquote(line.text.slice(0, -1))
        .split(/,\s*/)
        .map(unquote)
        .includes(descriptor),
  );
  const range = linesInBlock(lock, dependency);
  const field = (name: string) =>
    unquote(
      uniqueLine(lock, range, 2, (line) =>
        line.text.startsWith(`${name}${modern ? ':' : ''} `),
      )
        .text.slice(name.length + (modern ? 1 : 0))
        .trim(),
    );
  const lockedVersion = field('version');
  if (lockedVersion !== OPENSPEC_PACKAGE_VERSION)
    throw new Error('OpenSpec Yarn locked version is not pinned exactly.');
  if (!modern) {
    if (field('integrity') !== OPENSPEC_PACKAGE_INTEGRITY)
      throw new Error(
        'OpenSpec Yarn integrity differs from its exact package pin.',
      );
    return {
      lockfileVersion: 'yarn-v1',
      lockedVersion,
      integrity: OPENSPEC_PACKAGE_INTEGRITY,
      buildScriptsAllowed: false,
    };
  }
  if (field('resolution') !== descriptor)
    throw new Error(
      'OpenSpec Yarn resolution is not the pinned registry package.',
    );
  const checksum = field('checksum');
  if (!/^(?:[a-f0-9]+\/)?[a-f0-9]{128}$/u.test(checksum))
    throw new Error('OpenSpec Yarn checksum is missing or invalid.');
  const metadata = uniqueLine(
    lock,
    wholeFile(lock),
    0,
    (line) => line.text === '__metadata:',
  );
  const version = uniqueLine(lock, linesInBlock(lock, metadata), 2, (line) =>
    /^version: \d+$/.test(line.text),
  ).text.slice('version: '.length);
  // Yarn's archive checksum is not the npm tarball SRI; preserve that distinction.
  return {
    lockfileVersion: `yarn-${version}`,
    lockedVersion,
    integrity: `yarn-checksum:${checksum}`,
    buildScriptsAllowed: false,
  };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('OpenSpec package-manager record is invalid.');
  return value as Record<string, unknown>;
}

function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, '');
}

function requireSetting(
  text: string,
  pattern: RegExp,
  expected: string,
  name: string,
): void {
  const matches = [...text.matchAll(pattern)];
  if (matches.length !== 1 || unquote(matches[0]![1]!.trim()) !== expected) {
    throw new Error(
      `Set project ${name} to ${expected} before using OpenSpec.`,
    );
  }
}

function verifyPnpm(repositoryRoot: string): OpenSpecSupplyChainProvenance {
  const workspace = significantYamlLines(
    readCanonicalTextFile(repositoryRoot, 'pnpm-workspace.yaml'),
  );
  const allowBuilds = uniqueLine(
    workspace,
    wholeFile(workspace),
    0,
    (line) => line.text === 'allowBuilds:',
  );
  const buildPolicy = linesInBlock(workspace, allowBuilds);
  uniqueLine(
    workspace,
    buildPolicy,
    2,
    (line) => line.text === `'${OPENSPEC_PACKAGE_NAME}': false`,
  );
  if (
    matchingLines(workspace, buildPolicy, 2, (line) =>
      line.text.startsWith(`'${OPENSPEC_PACKAGE_NAME}':`),
    ).length !== 1
  ) {
    throw new Error('OpenSpec build policy is ambiguous');
  }

  const lock = significantYamlLines(
    readCanonicalTextFile(repositoryRoot, 'pnpm-lock.yaml'),
  );
  uniqueLine(
    lock,
    wholeFile(lock),
    0,
    (line) => line.text === "lockfileVersion: '9.0'",
  );

  const importers = uniqueLine(
    lock,
    wholeFile(lock),
    0,
    (line) => line.text === 'importers:',
  );
  const rootImporter = uniqueLine(
    lock,
    linesInBlock(lock, importers),
    2,
    (line) => line.text === '.:',
  );
  const developmentDependencies = uniqueLine(
    lock,
    linesInBlock(lock, rootImporter),
    4,
    (line) => line.text === 'devDependencies:',
  );
  const dependency = uniqueLine(
    lock,
    linesInBlock(lock, developmentDependencies),
    6,
    (line) => line.text === `'${OPENSPEC_PACKAGE_NAME}':`,
  );
  const dependencyBlock = linesInBlock(lock, dependency);
  uniqueLine(
    lock,
    dependencyBlock,
    8,
    (line) => line.text === `specifier: ${OPENSPEC_PACKAGE_VERSION}`,
  );
  const versionLine = uniqueLine(lock, dependencyBlock, 8, (line) =>
    line.text.startsWith('version: '),
  );
  const lockedVersion = versionLine.text.slice('version: '.length);
  if (!isPinnedSnapshotVersion(lockedVersion)) {
    throw new Error('OpenSpec lock importer version is not pinned');
  }

  const packages = uniqueLine(
    lock,
    wholeFile(lock),
    0,
    (line) => line.text === 'packages:',
  );
  const packageRange = linesInBlock(lock, packages);
  const packageEntry = uniqueLine(
    lock,
    packageRange,
    2,
    (line) => line.text === `'${OPENSPEC_PACKAGE_NAME}@1.6.0':`,
  );
  if (
    matchingLines(lock, packageRange, 2, (line) =>
      line.text.startsWith(`'${OPENSPEC_PACKAGE_NAME}@`),
    ).length !== 1
  ) {
    throw new Error('OpenSpec lock package entry is ambiguous');
  }
  const packageBlock = linesInBlock(lock, packageEntry);
  uniqueLine(
    lock,
    packageBlock,
    4,
    (line) =>
      line.text === `resolution: {integrity: ${OPENSPEC_PACKAGE_INTEGRITY}}`,
  );
  uniqueLine(lock, packageBlock, 4, (line) => line.text === 'hasBin: true');

  const snapshots = uniqueLine(
    lock,
    wholeFile(lock),
    0,
    (line) => line.text === 'snapshots:',
  );
  const snapshotRange = linesInBlock(lock, snapshots);
  uniqueLine(
    lock,
    snapshotRange,
    2,
    (line) =>
      line.text === `'${OPENSPEC_PACKAGE_NAME}@${lockedVersion}':` ||
      line.text === `'${OPENSPEC_PACKAGE_NAME}@${lockedVersion}': {}`,
  );
  if (
    matchingLines(lock, snapshotRange, 2, (line) =>
      line.text.startsWith(`'${OPENSPEC_PACKAGE_NAME}@`),
    ).length !== 1
  ) {
    throw new Error('OpenSpec lock snapshot is ambiguous');
  }

  return {
    lockfileVersion: '9.0',
    lockedVersion,
    integrity: OPENSPEC_PACKAGE_INTEGRITY,
    buildScriptsAllowed: false,
  };
}

function readCanonicalTextFile(
  repositoryRoot: string,
  relativePath: string,
): string {
  const filePath = path.join(repositoryRoot, relativePath);
  const stats = fs.lstatSync(filePath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(filePath) !== filePath ||
    stats.size > 16 * 1024 * 1024
  ) {
    throw new Error('OpenSpec provenance file is unsafe');
  }
  const bytes = fs.readFileSync(filePath);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff || text.includes('\0')) {
    throw new Error('OpenSpec provenance file is malformed');
  }
  return text;
}

function significantYamlLines(source: string): YamlLine[] {
  const lines: YamlLine[] = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.includes('\t')) {
      throw new Error('OpenSpec provenance YAML contains a tab');
    }
    const text = line.trim();
    if (!text || text.startsWith('#')) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (indent % 2 !== 0) {
      throw new Error('OpenSpec provenance YAML indentation is unsupported');
    }
    lines.push({ indent, text });
  }
  return lines;
}

function wholeFile(lines: YamlLine[]): LineRange {
  return { start: 0, end: lines.length };
}

function linesInBlock(lines: YamlLine[], parent: YamlLine): LineRange {
  const parentIndex = lines.indexOf(parent);
  let end = parentIndex + 1;
  while (end < lines.length && lines[end]!.indent > parent.indent) {
    end += 1;
  }
  return { start: parentIndex + 1, end };
}

function uniqueLine(
  lines: YamlLine[],
  range: LineRange,
  indent: number,
  predicate: (line: YamlLine) => boolean,
): YamlLine {
  const matches = matchingLines(lines, range, indent, predicate);
  if (matches.length !== 1) {
    throw new Error('OpenSpec provenance YAML shape differs from policy');
  }
  return matches[0]!;
}

function matchingLines(
  lines: YamlLine[],
  range: LineRange,
  indent: number,
  predicate: (line: YamlLine) => boolean,
): YamlLine[] {
  return lines
    .slice(range.start, range.end)
    .filter((line) => line.indent === indent && predicate(line));
}

function isPinnedSnapshotVersion(value: string): boolean {
  return /^1\.6\.0(?:\([a-zA-Z0-9@+._/-]+\))*$/.test(value);
}
