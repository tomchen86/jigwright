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
  tests: readonly FullGateTestTelemetryRecord[];
  digest: string;
};

export async function observeSystemDocumentTests(
  repositoryRoot: string,
  selected: readonly { file: string; name: string }[],
): Promise<TestObservation> {
  const before = systemTestSourceBindings(
    workingSystemDescriptionSnapshot(repositoryRoot),
  );
  const projector = createFullGateTelemetryProjector({ repositoryRoot });
  const { run } = await import('node:test');
  const selection = new Set(
    selected.map(({ file, name }) => `${file}#${name}`),
  );
  for (const file of [...new Set(selected.map(({ file }) => file))]) {
    const stream = run({
      execArgv: ['--experimental-strip-types'],
      files: [path.join(repositoryRoot, normalizeExactRepositoryPath(file))],
      testNamePatterns: [
        ...new Set(
          selected
            .filter((entry) => entry.file === file)
            .map(({ name }) => name),
        ),
      ].map(
        (name) =>
          new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
      ),
    });
    for await (const event of stream) projector.observe(event);
  }
  const body = {
    kind: 'document-test-observation.v1' as const,
    authority: 'observational-only' as const,
    completedAt: new Date().toISOString(),
    sourceBindings: before,
    sourceStable:
      canonicalJson(before) ===
      canonicalJson(
        systemTestSourceBindings(
          workingSystemDescriptionSnapshot(repositoryRoot),
        ),
      ),
    tests: projector.records.filter(
      (test) =>
        test.file !== null && selection.has(`${test.file}#${test.name}`),
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
  const current = systemTestSourceBindings(snapshot);
  const observations: {
    completedAt: string;
    current: boolean;
    tests: readonly FullGateTestTelemetryRecord[];
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
        recordedDigest !== digest(canonicalJson(body))
      )
        continue;
      body.tests.forEach(serializeFullGateTelemetryRecord);
      observations.push({
        completedAt: body.completedAt,
        current:
          body.sourceStable &&
          canonicalJson(body.sourceBindings) === canonicalJson(current),
        tests: body.tests,
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
          canonicalJson(bindings) ===
            canonicalJson(
              body.identity.bindings.projectedTreeOid.length === 64
                ? systemTestSourceBindings(snapshot, 'sha256')
                : current,
            ),
        tests: records,
      });
    } catch {
      /* A missing or incomplete gate is not a passing observation. */
    }
  }
  const results = new Map<string, ReturnType<SystemTestOutcomeReader>>();
  observations.sort(
    (left, right) =>
      Number(right.current) - Number(left.current) ||
      right.completedAt.localeCompare(left.completedAt),
  );
  for (const observation of observations) {
    for (const test of observation.tests) {
      if (
        test.file === null ||
        !['passed', 'not-passed', 'skipped', 'todo'].includes(test.outcome)
      )
        continue;
      const key = `${test.file}#${test.name}`;
      if (!results.has(key))
        results.set(key, observation.current ? test.outcome : 'stale');
    }
  }
  return (file, name) => results.get(`${file}#${name}`) ?? 'missing';
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
