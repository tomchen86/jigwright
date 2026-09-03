/**
 * Regenerates the full-gate test topology: one wrapper per package test, the
 * generated import region of the contracts legacy family, the package-test
 * runner, and the shard manifest that assigns every physical test to a shard by
 * longest-processing-time over the previous run's telemetry.
 *
 * Invariants:
 * - Every physical test is owned exactly once, by a root, a family import or a
 *   wrapper; the inventory refuses to generate on any drift instead of guessing.
 * - Generation needs the telemetry and run id of a completed full gate, and
 *   every test present in that telemetry but retired since must be declared
 *   with --retired-test.
 * - The own-test counts pinned for the two roots in workflow-test-inventory.ts
 *   are bumped deliberately when tests are added, never inferred.
 *
 * Depends on: workflow-test-inventory.ts and the last full-gate telemetry.
 * Failure modes, one layer at a time: "wrapper inventory drifted", "absent from
 * the legacy families", "must retain N own tests", "telemetry names an unknown
 * physical test". Fix in that order, then update the counts asserted in
 * workflow-test-inventory.contract.test.ts.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  WORKFLOW_PACKAGE_TEST_FAMILY_LOADER_PATH,
  WORKFLOW_PACKAGE_TEST_PROJECTION_ROOT,
  WORKFLOW_PACKAGE_TEST_RUNNER_PATH,
  WORKFLOW_TEST_SHARD_ALGORITHM,
  WORKFLOW_TEST_SHARD_MANIFEST_KIND,
  WORKFLOW_TEST_SHARD_MANIFEST_PATH,
  assignWorkflowTestUnitsToShards,
  assertWorkflowPackageTestProjections,
  digestWorkflowTestManifest,
  discoverWorkflowPackageTestProjections,
  discoverWorkflowTestTopology,
  loadWorkflowTestShardManifest,
  projectWorkflowTestShardWrapper,
  projectWorkflowPackageTestFamilySource,
  projectWorkflowPackageTestRunner,
  projectWorkflowPackageTestWrapper,
  validateWorkflowTestShardManifest,
  type WorkflowTestExecutionUnit,
  type WorkflowTestShardManifest,
} from './workflow-test-inventory.ts';

const TELEMETRY_RECORD_KIND = 'workflow-full-gate-test-telemetry.v1';
const TELEMETRY_END_KIND = 'workflow-full-gate-test-telemetry-end.v1';

type TelemetryObservation = Readonly<{
  sequence: number;
  file: string;
  nesting: number;
  durationMicros: number;
}>;

export type GenerateWorkflowTestShardOptions = Readonly<{
  repositoryRoot: string;
  telemetryPath: string;
  sourceTelemetryRunId: string;
  retiredPhysicalFiles?: readonly string[];
}>;

export function buildWorkflowTestShardManifest(
  options: GenerateWorkflowTestShardOptions,
): WorkflowTestShardManifest {
  const repositoryRoot = fs.realpathSync(options.repositoryRoot);
  const telemetryPath = fs.realpathSync(options.telemetryPath);
  const telemetryBytes = readRegularFile(telemetryPath);
  const observations = parseTelemetry(telemetryBytes.toString('utf8'));
  const topology = discoverWorkflowTestTopology(repositoryRoot);
  const knownPhysicalFiles = new Set(topology.physicalFiles);
  const retiredPhysicalFiles = new Set(options.retiredPhysicalFiles ?? []);
  if (
    retiredPhysicalFiles.size !== (options.retiredPhysicalFiles ?? []).length ||
    [...retiredPhysicalFiles].some(
      (file) =>
        knownPhysicalFiles.has(file) ||
        !/^packages\/workflow-engine\/test\/.+\.test\.ts$/u.test(file),
    )
  ) {
    throw new Error('Retired workflow test paths are invalid or still active.');
  }
  const observedRetiredPhysicalFiles = new Set<string>();
  const timing = new Map<
    string,
    { durationMicros: number; firstSequence: number }
  >();
  for (const observation of observations) {
    if (
      observation.nesting !== WORKFLOW_TEST_SHARD_ALGORITHM.telemetryNesting
    ) {
      continue;
    }
    if (!knownPhysicalFiles.has(observation.file)) {
      if (retiredPhysicalFiles.has(observation.file)) {
        observedRetiredPhysicalFiles.add(observation.file);
        continue;
      }
      throw new Error(
        `Source telemetry names an unknown physical workflow test: ${observation.file}.`,
      );
    }
    const current = timing.get(observation.file) ?? {
      durationMicros: 0,
      firstSequence: observation.sequence,
    };
    current.durationMicros += observation.durationMicros;
    current.firstSequence = Math.min(
      current.firstSequence,
      observation.sequence,
    );
    timing.set(observation.file, current);
  }
  if (
    [...retiredPhysicalFiles].some(
      (file) => !observedRetiredPhysicalFiles.has(file),
    )
  ) {
    throw new Error(
      'A declared retired workflow test is absent from source telemetry.',
    );
  }

  const weighted = topology.units.map((unit) => {
    let durationMicros = 0;
    let firstSequence = Number.POSITIVE_INFINITY;
    for (const physicalFile of unit.ownedPhysicalFiles) {
      const observed = timing.get(physicalFile);
      if (observed === undefined) continue;
      durationMicros += observed.durationMicros;
      firstSequence = Math.min(firstSequence, observed.firstSequence);
    }
    return { ...unit, durationMicros, firstSequence };
  });
  const legacyOrder = [...weighted].sort((left, right) => {
    const leftObserved = Number.isFinite(left.firstSequence);
    const rightObserved = Number.isFinite(right.firstSequence);
    if (leftObserved !== rightObserved) return leftObserved ? -1 : 1;
    if (left.firstSequence !== right.firstSequence) {
      return left.firstSequence - right.firstSequence;
    }
    return compareText(left.entrypoint, right.entrypoint);
  });
  const legacyOrdinal = new Map(
    legacyOrder.map((unit, index) => [unit.entrypoint, index + 1]),
  );
  const units: WorkflowTestExecutionUnit[] = weighted.map((unit) => ({
    entrypoint: unit.entrypoint,
    ownedPhysicalFiles: unit.ownedPhysicalFiles,
    legacyOrdinal: legacyOrdinal.get(unit.entrypoint)!,
    estimatedDurationMs: unit.durationMicros / 1_000,
  }));
  const shards = assignWorkflowTestUnitsToShards(units);
  const payload = {
    schemaVersion: 1 as const,
    kind: WORKFLOW_TEST_SHARD_MANIFEST_KIND,
    algorithm: WORKFLOW_TEST_SHARD_ALGORITHM,
    sourceTelemetryRunId: options.sourceTelemetryRunId,
    sourceTelemetryDigest: sha256(telemetryBytes),
    physicalFileCount: topology.physicalFiles.length,
    executionUnitCount: topology.units.length,
    shards,
  };
  return validateWorkflowTestShardManifest({
    ...payload,
    inventoryDigest: digestWorkflowTestManifest(payload),
  });
}

export function writeWorkflowTestShardArtifacts(
  options: GenerateWorkflowTestShardOptions,
): WorkflowTestShardManifest {
  const repositoryRoot = fs.realpathSync(options.repositoryRoot);
  writeWorkflowPackageTestArtifacts(repositoryRoot);
  const manifest = buildWorkflowTestShardManifest({
    ...options,
    repositoryRoot,
  });
  const manifestPath = path.join(
    repositoryRoot,
    WORKFLOW_TEST_SHARD_MANIFEST_PATH,
  );
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const shard of manifest.shards) {
    const wrapperPath = path.join(repositoryRoot, shard.wrapper);
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(wrapperPath, projectWorkflowTestShardWrapper(shard));
  }
  return loadWorkflowTestShardManifest(repositoryRoot);
}

export function writeWorkflowPackageTestArtifacts(
  repositoryRoot: string,
): void {
  const root = fs.realpathSync(repositoryRoot);
  const projections = discoverWorkflowPackageTestProjections(root);
  const expectedWrappers = new Set(
    projections.map(({ wrapper }) => path.join(root, wrapper)),
  );
  const projectionRoot = path.join(root, WORKFLOW_PACKAGE_TEST_PROJECTION_ROOT);
  removeExtraPackageTestWrappers(projectionRoot, expectedWrappers);
  for (const projection of projections) {
    const wrapperPath = path.join(root, projection.wrapper);
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(
      wrapperPath,
      projectWorkflowPackageTestWrapper(projection),
    );
  }
  const runnerPath = path.join(root, WORKFLOW_PACKAGE_TEST_RUNNER_PATH);
  fs.mkdirSync(path.dirname(runnerPath), { recursive: true });
  fs.writeFileSync(runnerPath, projectWorkflowPackageTestRunner());

  const familyPath = path.join(root, WORKFLOW_PACKAGE_TEST_FAMILY_LOADER_PATH);
  const familyStats = fs.lstatSync(familyPath);
  if (!familyStats.isFile() || familyStats.isSymbolicLink()) {
    throw new Error(
      'Workflow package-test family loader must be a regular file.',
    );
  }
  const currentFamily = fs.readFileSync(familyPath, 'utf8');
  fs.writeFileSync(
    familyPath,
    projectWorkflowPackageTestFamilySource(currentFamily, projections),
  );
  assertWorkflowPackageTestProjections(root);
}

function removeExtraPackageTestWrappers(
  projectionRoot: string,
  expectedWrappers: ReadonlySet<string>,
): void {
  if (!fs.existsSync(projectionRoot)) return;
  const rootStats = fs.lstatSync(projectionRoot);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('Workflow package-test projection root is unsafe.');
  }
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          'Workflow package-test projection cannot contain symlinks.',
        );
      }
      if (entry.isDirectory()) visit(absolute);
      else if (
        entry.isFile() &&
        entry.name.endsWith('.test.ts') &&
        !expectedWrappers.has(absolute)
      ) {
        fs.unlinkSync(absolute);
      }
    }
    if (
      directory !== projectionRoot &&
      fs.readdirSync(directory).length === 0
    ) {
      fs.rmdirSync(directory);
    }
  };
  visit(projectionRoot);
}

function parseTelemetry(jsonl: string): readonly TelemetryObservation[] {
  if (!jsonl.endsWith('\n')) {
    throw new Error('Source telemetry must end with its complete footer.');
  }
  const lines = jsonl.slice(0, -1).split('\n');
  if (lines.length < 2) throw new Error('Source telemetry is empty.');
  const records: TelemetryObservation[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let candidate: unknown;
    try {
      candidate = JSON.parse(lines[index]!) as unknown;
    } catch {
      throw new Error(`Source telemetry line ${index + 1} is malformed.`);
    }
    if (index === lines.length - 1) {
      if (
        !isRecord(candidate) ||
        candidate.kind !== TELEMETRY_END_KIND ||
        candidate.recordCount !== records.length
      ) {
        throw new Error('Source telemetry footer is invalid.');
      }
      continue;
    }
    if (
      !isRecord(candidate) ||
      candidate.kind !== TELEMETRY_RECORD_KIND ||
      candidate.sequence !== records.length + 1 ||
      typeof candidate.file !== 'string' ||
      !Number.isSafeInteger(candidate.nesting) ||
      (candidate.nesting as number) < 0 ||
      typeof candidate.durationMs !== 'number' ||
      !Number.isFinite(candidate.durationMs) ||
      candidate.durationMs < 0
    ) {
      throw new Error(`Source telemetry line ${index + 1} is invalid.`);
    }
    records.push({
      sequence: candidate.sequence as number,
      file: candidate.file,
      nesting: candidate.nesting as number,
      durationMicros: Math.round(candidate.durationMs * 1_000),
    });
  }
  return records;
}

function readRegularFile(file: string): Buffer {
  const stats = fs.lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error('Source telemetry must be a regular file.');
  }
  return fs.readFileSync(file);
}

function sha256(value: Buffer): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseCli(argv: readonly string[]): Readonly<{
  check: boolean;
  telemetryPath: string | null;
  sourceTelemetryRunId: string | null;
  retiredPhysicalFiles: readonly string[];
}> {
  let check = false;
  let telemetryPath: string | null = null;
  let sourceTelemetryRunId: string | null = null;
  const retiredPhysicalFiles: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--check') check = true;
    else if (argument === '--telemetry') telemetryPath = argv[++index] ?? null;
    else if (argument === '--run-id') {
      sourceTelemetryRunId = argv[++index] ?? null;
    } else if (argument === '--retired-test') {
      retiredPhysicalFiles.push(argv[++index] ?? '');
    } else {
      throw new Error(
        `Unknown workflow test shard generator option: ${argument}.`,
      );
    }
  }
  return { check, telemetryPath, sourceTelemetryRunId, retiredPhysicalFiles };
}

if (import.meta.main) {
  const repositoryRoot = fs.realpathSync(
    path.resolve(import.meta.dirname, '..'),
  );
  const cli = parseCli(process.argv.slice(2));
  if (cli.check) {
    const manifest = loadWorkflowTestShardManifest(repositoryRoot);
    process.stdout.write(
      `${manifest.inventoryDigest} ${manifest.executionUnitCount} units ${manifest.physicalFileCount} files\n`,
    );
  } else {
    if (cli.telemetryPath === null || cli.sourceTelemetryRunId === null) {
      throw new Error(
        'Generation requires --telemetry <path> and --run-id <id>.',
      );
    }
    const manifest = writeWorkflowTestShardArtifacts({
      repositoryRoot,
      telemetryPath: path.resolve(cli.telemetryPath),
      sourceTelemetryRunId: cli.sourceTelemetryRunId,
      retiredPhysicalFiles: cli.retiredPhysicalFiles,
    });
    process.stdout.write(
      `${manifest.inventoryDigest} ${manifest.executionUnitCount} units ${manifest.physicalFileCount} files\n`,
    );
  }
}
