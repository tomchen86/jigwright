/**
 * Observes named tests with the existing native telemetry and reuses source-bound results.
 *
 * Invariants:
 * - Missing, skipped, failed and stale observations never become passing evidence.
 * - The producer does not depend on document validation or a prior successful gate.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { normalizeExactRepositoryPath } from '@jigwright/core/repository-path';
import { runGit } from '../../repository-transaction/git.ts';
import type { SystemDescriptionSnapshot } from '../../../modules/source/spec-ownership.ts';
import type { SystemTestOutcomeReader } from '../../../modules/source/system-documents.ts';
import {
  createFullGateTelemetryProjector,
  FULL_GATE_TELEMETRY_END_KIND,
  FULL_GATE_TELEMETRY_KIND,
  serializeFullGateTelemetryRecord,
  type FullGateTestTelemetryRecord,
} from './test-telemetry-reporter.ts';
import {
  committedSystemTestSourceBindings,
  systemTestSourceBindings,
  workingSystemDescriptionSnapshot,
} from './system-document-snapshot.ts';

type TestObservation = {
  kind: 'document-test-observation.v1';
  authority: 'observational-only';
  completedAt: string;
  sourceBindings: Record<string, string>;
  sourceStable: boolean;
  requestedTests: readonly { file: string; name: string }[];
  tests: readonly FullGateTestTelemetryRecord[];
  digest: string;
};

const observationEntry =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

export async function observeSystemDocumentTests(
  repositoryRoot: string,
  selected: readonly { file: string; name: string }[],
): Promise<TestObservation> {
  // A rooted child also works on Node 22, without mutating the caller's cwd or
  // inheriting an outer test runner's execution context or eval arguments.
  if (!observationEntry) {
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        '--experimental-strip-types',
        fileURLToPath(import.meta.url),
        repositoryRoot,
        JSON.stringify(selected),
      ],
      { cwd: repositoryRoot, env: environment, maxBuffer: 16 * 1024 * 1024 },
    );
    return JSON.parse(stdout) as TestObservation;
  }
  const before = systemTestSourceBindings(
    workingSystemDescriptionSnapshot(repositoryRoot),
    objectFormat(repositoryRoot),
  );
  const projector = createFullGateTelemetryProjector({ repositoryRoot });
  const { run } = await import('node:test');
  const selection = new Set(
    selected.map(({ file, name }) => `${file}#${name}`),
  );
  let sourceStable = true;
  for (const file of [...new Set(selected.map(({ file }) => file))]) {
    const options = {
      execArgv: ['--experimental-strip-types'],
      files: [path.join(repositoryRoot, normalizeExactRepositoryPath(file))],
    };
    const names = [
      ...new Set(
        selected.filter((entry) => entry.file === file).map(({ name }) => name),
      ),
    ];
    const firstRecord = projector.recordCount;
    const stream = run({
      ...options,
      testNamePatterns: names.map(
        (name) =>
          new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      ),
    });
    for await (const event of stream) projector.observe(event);
    const observed = projector.records.slice(firstRecord);
    if (
      names.some(
        (name) =>
          !observed.some((test) => test.file === file && test.name === name),
      ) &&
      !observed.some((test) => fileFailed(repositoryRoot, test))
    ) {
      sourceStable &&=
        canonicalJson(before) ===
        canonicalJson(
          systemTestSourceBindings(
            workingSystemDescriptionSnapshot(repositoryRoot),
            objectFormat(repositoryRoot),
          ),
        );
      // A t.test child is registered only when its parent body runs. Retry
      // this file once, retaining both attempts so fail/skip cannot become pass.
      if (sourceStable) {
        for await (const event of run(options)) projector.observe(event);
      }
    }
  }
  const body = {
    kind: 'document-test-observation.v1' as const,
    authority: 'observational-only' as const,
    completedAt: new Date().toISOString(),
    sourceBindings: before,
    sourceStable:
      sourceStable &&
      canonicalJson(before) ===
        canonicalJson(
          systemTestSourceBindings(
            workingSystemDescriptionSnapshot(repositoryRoot),
            objectFormat(repositoryRoot),
          ),
        ),
    requestedTests: selected,
    tests: projector.records.filter(
      (test) =>
        test.file !== null &&
        (selection.has(`${test.file}#${test.name}`) ||
          fileFailed(repositoryRoot, test)),
    ),
  };
  const observation = { ...body, digest: digest(canonicalJson(body)) };
  const directory = path.join(stateRoot(repositoryRoot), 'test-observations');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, `${observation.digest}.json`),
    `${canonicalJson(observation)}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return observation;
}

export function systemDocumentTestOutcomes(
  repositoryRoot: string,
  snapshot: SystemDescriptionSnapshot,
): SystemTestOutcomeReader {
  const current = systemTestSourceBindings(
    snapshot,
    objectFormat(repositoryRoot),
  );
  const observations: {
    completedAt: string;
    current: boolean;
    tests: readonly FullGateTestTelemetryRecord[];
    requestedTests: readonly { file: string; name: string }[];
  }[] = [];
  const state = stateRoot(repositoryRoot);
  const bounded = path.join(state, 'test-observations');
  for (const file of jsonFiles(bounded)) {
    try {
      const { digest: recordedDigest, ...body } = JSON.parse(
        fs.readFileSync(file, 'utf8'),
      ) as TestObservation;
      if (
        body.kind !== 'document-test-observation.v1' ||
        body.authority !== 'observational-only' ||
        typeof body.completedAt !== 'string' ||
        !Array.isArray(body.tests) ||
        !Array.isArray(body.requestedTests) ||
        !body.requestedTests.every(
          (test) =>
            typeof test?.file === 'string' &&
            normalizeExactRepositoryPath(test.file) === test.file &&
            typeof test.name === 'string',
        ) ||
        recordedDigest !== digest(canonicalJson(body))
      )
        continue;
      body.tests.forEach(serializeFullGateTelemetryRecord);
      observations.push({
        completedAt: body.completedAt,
        current:
          body.sourceStable === true &&
          canonicalJson(body.sourceBindings) === canonicalJson(current),
        tests: body.tests,
        requestedTests: body.requestedTests,
      });
    } catch {
      /* Incomplete local observations cannot supply proof. */
    }
  }
  const gate = path.join(state, 'full-gate');
  for (const file of jsonFiles(path.join(gate, 'receipts'))) {
    try {
      const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { receiptDigest, ...body } = receipt;
      if (
        body.kind !== 'full-gate-run-receipt.v2' ||
        body.authority !== 'observational-only' ||
        receiptDigest !== `sha256:${digest(canonicalJson(body))}` ||
        !/^run-\d{17}-[0-9a-f-]{36}$/.test(body.runId)
      )
        continue;
      const runRoot = path.join(gate, 'runs', body.runId);
      const telemetry = fs.readFileSync(
        path.join(runRoot, 'test-telemetry.jsonl'),
      );
      const stdout = fs.readFileSync(path.join(runRoot, 'stdout.log'));
      const stderr = fs.readFileSync(path.join(runRoot, 'stderr.log'));
      if (
        body.coverage?.telemetryDigest !== `sha256:${digest(telemetry)}` ||
        body.coverage.telemetryBytes !== telemetry.length ||
        body.rawLogDigest !== `sha256:${digest(stdout)}` ||
        body.standardErrorDigest !== `sha256:${digest(stderr)}`
      )
        continue;
      const records = telemetry
        .toString()
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line));
      const footer = records.pop();
      if (
        footer?.kind !== FULL_GATE_TELEMETRY_END_KIND ||
        footer.recordCount !== records.length ||
        records.some(
          (record, index) =>
            record.kind !== FULL_GATE_TELEMETRY_KIND ||
            record.sequence !== index + 1,
        )
      )
        continue;
      records.forEach(serializeFullGateTelemetryRecord);
      const bindings = committedSystemTestSourceBindings(
        repositoryRoot,
        body.identity.bindings.projectedTreeOid,
      );
      observations.push({
        completedAt: body.completedAt,
        current:
          body.identityStable === true &&
          canonicalJson(bindings) === canonicalJson(current),
        tests: records,
        requestedTests: [],
      });
    } catch {
      /* A missing or incomplete gate is not a passing observation. */
    }
  }
  const results = new Map<string, ReturnType<SystemTestOutcomeReader>>();
  const failedFiles = new Map<string, ReturnType<SystemTestOutcomeReader>>();
  observations.sort(
    (left, right) =>
      Number(right.current) - Number(left.current) ||
      right.completedAt.localeCompare(left.completedAt),
  );
  for (const observation of observations) {
    const outcomes = new Map<string, ReturnType<SystemTestOutcomeReader>>(
      observation.requestedTests.map((test) => [
        `${test.file}#${test.name}`,
        'missing',
      ]),
    );
    const failures = new Set(
      observation.tests
        .filter((test) => fileFailed(repositoryRoot, test))
        .map((test) => test.file!),
    );
    for (const file of failures) {
      if (!failedFiles.has(file))
        failedFiles.set(file, observation.current ? 'not-passed' : 'stale');
    }
    for (const test of observation.tests) {
      if (
        test.file === null ||
        !['passed', 'not-passed', 'skipped', 'todo'].includes(test.outcome)
      )
        continue;
      const key = `${test.file}#${test.name}`;
      const previous = outcomes.get(key);
      if (
        previous === undefined ||
        previous === 'missing' ||
        severity(test.outcome) > severity(previous)
      )
        outcomes.set(key, test.outcome);
    }
    for (const [key, outcome] of outcomes) {
      const file = key.slice(0, key.indexOf('#'));
      if (!results.has(key))
        results.set(
          key,
          observation.current
            ? failures.has(file)
              ? 'not-passed'
              : (failedFiles.get(file) ?? outcome)
            : 'stale',
        );
    }
  }
  return (file, name) =>
    results.get(`${file}#${name}`) ?? failedFiles.get(file) ?? 'missing';
}

function fileFailed(root: string, test: FullGateTestTelemetryRecord): boolean {
  return (
    test.file !== null &&
    test.outcome === 'not-passed' &&
    [test.file, path.join(root, test.file)].includes(test.name)
  );
}
function severity(outcome: ReturnType<SystemTestOutcomeReader>): number {
  return ['passed', 'todo', 'skipped', 'not-passed'].indexOf(outcome);
}
function objectFormat(root: string): 'sha1' | 'sha256' {
  return runGit(root, ['rev-parse', '--show-object-format']).trim() === 'sha256'
    ? 'sha256'
    : 'sha1';
}

function stateRoot(root: string): string {
  const common = runGit(root, ['rev-parse', '--git-common-dir']).trim();
  return path.join(path.resolve(root, common), 'workflow-engine');
}
function jsonFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? jsonFiles(path.join(root, entry.name))
        : entry.isFile() && entry.name.endsWith('.json')
          ? [path.join(root, entry.name)]
          : [],
    );
}
function digest(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

if (observationEntry) {
  const root = process.argv[2];
  const selected: unknown = JSON.parse(process.argv[3] ?? 'null');
  if (
    !root ||
    !Array.isArray(selected) ||
    !selected.every(
      (test) => typeof test?.file === 'string' && typeof test.name === 'string',
    )
  )
    throw new Error('Invalid document test observation request.');
  void observeSystemDocumentTests(root, selected).then((result) =>
    process.stdout.write(JSON.stringify(result)),
  );
}
