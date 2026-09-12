/** Resolves current workspace sources through their declared exports and TypeScript aliases. */
import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import ts from 'typescript';
import {
  classifyLayerDependency,
  readModuleDependencies,
} from './dependency-graph.ts';

export type DependencyEdge = {
  from: string;
  to: string;
  specifier: string;
  line: number;
  typeOnly: boolean;
  loadsModule: boolean;
};
export type ArchitectureProblem = {
  from: string;
  to?: string;
  rule: string;
  line: number;
  via?: string[];
};

function sourceFiles(
  directory: string,
  generatedRecoveryRoot: string,
): string[] {
  if (directory === generatedRecoveryRoot) return [];
  if (!fs.existsSync(directory)) return [];
  if (fs.lstatSync(directory).isSymbolicLink())
    throw new Error(`Architecture source cannot be a symlink: ${directory}`);
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Architecture source cannot be a symlink: ${file}`);
    if (entry.isDirectory()) return sourceFiles(file, generatedRecoveryRoot);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}

export function dependencyOwner(file: string): string {
  const parts = file.split('/');
  if (parts[0] !== 'packages') return parts[0];
  if (parts[1] !== 'workflow-engine' || parts[2] !== 'src')
    return parts.slice(0, 3).join('/');
  const layer = parts[3];
  return parts
    .slice(
      0,
      ['modules', 'adapters', 'runtime', 'application'].includes(layer) ? 5 : 4,
    )
    .join('/');
}

/** The same ownership and resolution policy serves full-graph and feature-closure checks. */
export function readRepositoryDependencies(root: string) {
  root = fs.realpathSync(root);
  if (fs.lstatSync(path.join(root, 'packages')).isSymbolicLink())
    throw new Error('Architecture packages directory cannot be a symlink');
  // This exact generated tree is compared with its source by the bootstrap generator.
  const generatedRecoveryRoot = path.join(
    root,
    'packages/workflow-engine/bootstrap/recovery-runtime',
  );
  const relative = (file: string): string =>
    path.relative(root, file).split(path.sep).join('/');
  const packages = fs
    .readdirSync(path.join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => {
      if (entry.isSymbolicLink())
        throw new Error(
          `Architecture package cannot be a symlink: ${entry.name}`,
        );
      return entry.isDirectory();
    })
    .map((entry) => {
      const directory = path.join(root, 'packages', entry.name);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(directory, 'package.json'), 'utf8'),
      );
      const architecture = manifest.architecture;
      const role =
        architecture === undefined ? 'integration' : architecture?.role;
      if (
        (architecture !== undefined &&
          (architecture === null ||
            typeof architecture !== 'object' ||
            Array.isArray(architecture))) ||
        !['domain-library', 'integration'].includes(role)
      )
        throw new Error(`Invalid architecture role: ${manifest.name}`);
      if (manifest.name === '@jigwright/core' && role !== 'domain-library')
        throw new Error('Core must declare architecture role domain-library');
      return {
        directory,
        role,
        name: manifest.name as string,
        exports: manifest.exports as Record<string, unknown>,
      };
    });
  const names = new Set<string>();
  for (const pkg of packages) {
    if (typeof pkg.name !== 'string' || !pkg.name || names.has(pkg.name))
      throw new Error(
        `Invalid or duplicate workspace package name: ${pkg.name}`,
      );
    names.add(pkg.name);
  }
  const publicPaths: Record<string, string[]> = {};
  const publicFiles = new Map<string, Set<string>>();
  for (const pkg of packages) {
    publicFiles.set(pkg.directory, new Set());
    if (
      pkg.exports !== undefined &&
      pkg.exports !== null &&
      typeof pkg.exports !== 'string' &&
      (typeof pkg.exports !== 'object' || Array.isArray(pkg.exports))
    )
      throw new Error(`Unsupported workspace source export: ${pkg.name}`);
    const exports =
      typeof pkg.exports === 'string' ? { '.': pkg.exports } : pkg.exports;
    for (const [subpath, value] of Object.entries(exports ?? {})) {
      if (value === null) continue;
      // Workspace source exports currently name one exact source each. A new
      // export format must extend this resolver explicitly, not hide an edge.
      if (
        !(subpath === '.' || subpath.startsWith('./')) ||
        subpath.includes('*') ||
        typeof value !== 'string' ||
        !value.startsWith('./') ||
        value.includes('*') ||
        value.includes('%') ||
        value.includes('\\') ||
        value
          .slice(2)
          .split('/')
          .some((part) =>
            ['.', '..', 'node_modules'].includes(part.toLowerCase()),
          )
      )
        throw new Error(
          `Unsupported workspace source export: ${pkg.name} ${subpath}`,
        );
      const specifier =
        subpath === '.' ? pkg.name : pkg.name + subpath.slice(1);
      publicPaths[specifier] = [path.resolve(pkg.directory, value)];
      for (const target of publicPaths[specifier])
        publicFiles.get(pkg.directory)!.add(relative(target));
    }
  }
  const files = [
    ...packages.flatMap((pkg) =>
      [
        sourceFiles(path.join(pkg.directory, 'src'), generatedRecoveryRoot),
        sourceFiles(
          path.join(pkg.directory, 'bootstrap'),
          generatedRecoveryRoot,
        ),
      ].flat(),
    ),
    ...sourceFiles(path.join(root, 'scripts'), generatedRecoveryRoot),
  ].sort();
  const knownFiles = new Set(files);
  for (const pkg of packages.filter(
    (candidate) => candidate.role === 'domain-library',
  )) {
    for (const [specifier, targets] of Object.entries(publicPaths)) {
      if (specifier !== pkg.name && !specifier.startsWith(pkg.name + '/'))
        continue;
      for (const target of targets) {
        if (
          !target.startsWith(path.join(pkg.directory, 'src') + path.sep) ||
          !knownFiles.has(target) ||
          !fs.lstatSync(target).isFile() ||
          fs.realpathSync(target) !== target
        )
          throw new Error(
            `Invalid domain-library source export: ${specifier} -> ${target}`,
          );
      }
    }
  }
  const optionsByPackage = new Map<string, ts.CompilerOptions>();
  for (const pkg of packages) {
    const configPath = path.join(pkg.directory, 'tsconfig.json');
    let options: ts.CompilerOptions = {};
    if (fs.existsSync(configPath)) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile);
      if (config.error)
        throw new Error(
          ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
        );
      options = ts.parseJsonConfigFileContent(
        config.config,
        ts.sys,
        pkg.directory,
      ).options;
    }
    const configuredPaths = Object.fromEntries(
      Object.entries(options.paths ?? {}).map(([key, targets]) => [
        key,
        targets.map((target) =>
          path.resolve(options.baseUrl ?? pkg.directory, target),
        ),
      ]),
    );
    optionsByPackage.set(pkg.directory, {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      ...options,
      baseUrl: root,
      paths: { ...publicPaths, ...configuredPaths },
    });
  }
  function read(file: string, additionalSource = '') {
    file = fs.realpathSync(file);
    const effects: { specifier: string; line: number }[] = [];
    const edges: DependencyEdge[] = [];
    const problems: ArchitectureProblem[] = [];
    const from = relative(file);
    const pkg = packages.find((candidate) =>
      file.startsWith(candidate.directory + path.sep),
    );
    const options = optionsByPackage.get(pkg?.directory ?? '') ?? {
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      baseUrl: root,
      paths: publicPaths,
    };
    const isConfiguredAlias = (specifier: string): boolean =>
      Object.keys(options.paths ?? {}).some((alias) => {
        const star = alias.indexOf('*');
        return star < 0
          ? alias === specifier
          : specifier.startsWith(alias.slice(0, star)) &&
              specifier.endsWith(alias.slice(star + 1));
      });
    const isDomain =
      from.startsWith('packages/workflow-engine/src/modules/') ||
      (pkg?.role === 'domain-library' &&
        file.startsWith(path.join(pkg.directory, 'src') + path.sep));
    const isFoundation = from.startsWith(
      'packages/workflow-engine/src/foundation/',
    );
    for (const {
      specifier,
      line,
      typeOnly,
      loadsModule,
    } of readModuleDependencies(
      file,
      fs.readFileSync(file, 'utf8') + additionalSource,
    )) {
      if (specifier === null) {
        problems.push({ from, line, rule: 'unresolved-computed-dependency' });
        continue;
      }
      const dependency = packages.find(
        (candidate) =>
          specifier === candidate.name ||
          specifier.startsWith(candidate.name + '/'),
      );
      if (dependency && !Object.hasOwn(publicPaths, specifier))
        problems.push({
          from,
          to: specifier,
          line,
          rule: 'private-package-import',
        });
      if (isBuiltin(specifier)) {
        if (
          !['crypto', 'node:crypto', 'path', 'node:path'].includes(specifier)
        ) {
          if (loadsModule) effects.push({ specifier, line });
          if (isDomain || isFoundation)
            problems.push({
              from,
              to: specifier,
              line,
              rule: isFoundation
                ? 'foundation-external-effect'
                : 'domain-external-effect',
            });
        }
        continue;
      }
      const resolved = ts.resolveModuleName(specifier, file, options, ts.sys)
        .resolvedModule?.resolvedFileName;
      if (!resolved || !knownFiles.has(path.resolve(resolved))) {
        if (
          specifier.startsWith('.') ||
          specifier.startsWith('#') ||
          dependency ||
          isConfiguredAlias(specifier)
        )
          problems.push({
            from,
            to: specifier,
            line,
            rule: 'unresolved-workspace-dependency',
          });
        else {
          if (loadsModule) effects.push({ specifier, line });
          if (isDomain || isFoundation)
            problems.push({
              from,
              to: specifier,
              line,
              rule: isFoundation
                ? 'foundation-unresolved-external'
                : 'domain-unresolved-external',
            });
        }
        continue;
      }
      const to = relative(resolved);
      edges.push({ from, to, specifier, line, typeOnly, loadsModule });
      const rule = classifyLayerDependency(from, to);
      if (rule) problems.push({ from, to, line, rule });
      const targetPackage = packages.find((candidate) =>
        resolved.startsWith(candidate.directory + path.sep),
      );
      if (
        (isDomain || isFoundation) &&
        (!targetPackage ||
          !resolved.startsWith(
            path.join(targetPackage.directory, 'src') + path.sep,
          ) ||
          (targetPackage !== pkg &&
            (isFoundation
              ? targetPackage.name !== '@jigwright/core'
              : targetPackage.role !== 'domain-library')))
      )
        problems.push({
          from,
          to,
          line,
          rule: isFoundation
            ? 'foundation-integration-implementation'
            : 'domain-integration-implementation',
        });
      if (
        dependency &&
        publicPaths[specifier] &&
        !publicPaths[specifier].includes(path.resolve(resolved))
      )
        problems.push({
          from,
          to,
          line,
          rule: 'workspace-export-resolution-mismatch',
        });
      if (
        pkg &&
        targetPackage &&
        pkg !== targetPackage &&
        !publicFiles.get(targetPackage.directory)!.has(to)
      ) {
        problems.push({ from, to, line, rule: 'private-package-import' });
      }
      if (
        pkg?.name === '@jigwright/core' &&
        targetPackage &&
        targetPackage !== pkg
      ) {
        problems.push({ from, to, line, rule: 'core-outward-dependency' });
      }
    }
    return { edges, problems, effects, pure: isDomain || isFoundation };
  }
  return { files: files.map(relative), read };
}

export function readRepositoryDependencyGraph(root: string): {
  files: string[];
  edges: DependencyEdge[];
  problems: ArchitectureProblem[];
} {
  const reader = readRepositoryDependencies(root);
  const effectImports = new Map<
    string,
    { specifier: string; line: number }[]
  >();
  const pureOwners = new Set<string>();
  const edges: DependencyEdge[] = [];
  const problems: ArchitectureProblem[] = [];
  for (const file of reader.files) {
    const result = reader.read(path.join(root, file));
    edges.push(...result.edges);
    problems.push(...result.problems);
    if (result.effects.length) effectImports.set(file, result.effects);
    if (result.pure) pureOwners.add(file);
  }
  // Report a shortest loaded-effect witness using Node's actual erased source.
  // All type references still obey ownership rules; inline types can retain a load.
  const valueEdges = new Map<string, DependencyEdge[]>();
  for (const edge of edges) {
    if (!edge.loadsModule) continue;
    const outgoing = valueEdges.get(edge.from) ?? [];
    outgoing.push(edge);
    valueEdges.set(edge.from, outgoing);
  }
  for (const from of pureOwners) {
    if (effectImports.has(from)) continue; // Already reported at the actual import.
    const seen = new Set([from]);
    const pending = (valueEdges.get(from) ?? []).map((edge) => ({
      file: edge.to,
      line: edge.line,
      via: [from, edge.to],
    }));
    for (let index = 0; index < pending.length; index++) {
      const current = pending[index]!;
      if (seen.has(current.file)) continue;
      seen.add(current.file);
      const effect = effectImports.get(current.file)?.[0];
      if (effect) {
        problems.push({
          from,
          to: effect.specifier,
          line: current.line,
          rule: 'pure-transitive-external-effect',
          via: [...current.via, effect.specifier],
        });
        break;
      }
      for (const edge of valueEdges.get(current.file) ?? []) {
        if (!seen.has(edge.to))
          pending.push({
            file: edge.to,
            line: current.line,
            via: [...current.via, edge.to],
          });
      }
    }
  }
  return { files: reader.files, edges, problems };
}
