/**
 * Connects system document inspection, projection rendering and exact
 * referenced-test execution to repository storage.
 *
 * Invariants:
 * - Document validation rejects projection drift and requires regeneration
 *   of the affected outputs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import {
  parseGovernanceSourceAliases,
  GOVERNANCE_SOURCE_ALIASES_PATH,
} from '../../../modules/governance-intake/source-aliases.ts';
import {
  inspectSystemDocuments,
  readSystemSource,
} from '../../../modules/source/system-documents.ts';
import type { SystemDescriptionSnapshot } from '../../../modules/source/spec-ownership.ts';
import { createProjectionService } from '../../../modules/projection/projection-service.ts';
import { systemDocumentProjectionBindings } from '../../../modules/projection/system-document-projections.ts';
import { moduleReadmeProjectionBindings } from '../../../modules/projection/module-readme-projection.ts';
import { moduleChangesSinceConfirmation } from './module-readme-changes.ts';
import { moduleHeaderHistory } from './module-header-history.ts';
import { replaceTextAtomic } from '../../repository-transaction/atomic-text.ts';
import { workingSystemDescriptionSnapshot } from './system-document-snapshot.ts';
import {
  observeSystemDocumentTests,
  systemDocumentTestOutcomes,
} from './system-test-evidence.ts';

export function inspectRepositorySystemDocuments(
  repositoryRoot: string,
  providedSnapshot?: SystemDescriptionSnapshot,
  proof = true,
) {
  const snapshot =
    providedSnapshot ?? workingSystemDescriptionSnapshot(repositoryRoot);
  const aliases = parseGovernanceSourceAliases(
    snapshot.readText(GOVERNANCE_SOURCE_ALIASES_PATH),
  );
  const report = inspectSystemDocuments(
    snapshot,
    proof ? systemDocumentTestOutcomes(repositoryRoot, snapshot) : undefined,
  );
  for (const alias of Object.values(aliases)) {
    for (const ref of alias.sourceRefs) {
      if (report.sources.has(ref)) continue;
      try {
        report.sources.set(ref, readSystemSource(snapshot, ref));
      } catch {
        report.issues.push({
          code: 'source-missing',
          path: GOVERNANCE_SOURCE_ALIASES_PATH,
          message: `Resolve the Source wording for ${alias.title}.`,
        });
      }
    }
  }
  const service = createProjectionService(
    [
      ...systemDocumentProjectionBindings(report, aliases),
      ...moduleReadmeProjectionBindings(
        snapshot,
        report.specs,
        moduleChangesSinceConfirmation(repositoryRoot, snapshot),
        moduleHeaderHistory(repositoryRoot, snapshot),
      ),
    ],
    {
      read: (file) => {
        if (providedSnapshot) return snapshot.readText(file) ?? null;
        const target = path.join(repositoryRoot, file);
        const stat = fs.lstatSync(target, { throwIfNoEntry: false });
        if (!stat) return null;
        if (!stat.isFile() || stat.isSymbolicLink())
          throw new Error(`Unsafe projection target: ${file}.`);
        return fs.readFileSync(target, 'utf8');
      },
      write(file, content) {
        const target = path.join(repositoryRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        replaceTextAtomic(target, content, { allowCreate: true });
      },
    },
  );
  return { report, service };
}

export function validateSystemDocuments(
  repositoryRoot: string,
  snapshot?: SystemDescriptionSnapshot,
): string[] {
  const { report, service } = inspectRepositorySystemDocuments(
    repositoryRoot,
    snapshot,
  );
  assertIssues(report.issues);
  const drift = service.status().filter((row) => row.state !== 'current');
  if (drift.length > 0)
    throw workflowError(
      'SYSTEM_DOCUMENT_PROJECTION_DRIFT',
      'Run documents render to refresh the system document projections.',
      ExitCode.verification,
      {
        details: { paths: drift.map((row) => row.path) },
        recovery: 'jigwright documents render',
      },
    );
  return [
    ...report.specs.map((spec) => spec.path),
    ...service.status().map((row) => row.path),
  ];
}

export function validateSystemDocumentStructure(
  repositoryRoot: string,
  snapshot?: SystemDescriptionSnapshot,
): string[] {
  const { report } = inspectRepositorySystemDocuments(
    repositoryRoot,
    snapshot,
    false,
  );
  assertIssues(
    report.issues.filter((issue) => issue.code !== 'test-not-passed'),
  );
  return report.specs.map((spec) => spec.path);
}

export function renderSystemDocuments(repositoryRoot: string): string[] {
  const { service } = inspectRepositorySystemDocuments(repositoryRoot);
  return [...new Set(service.status().map(({ id }) => id))].flatMap((id) =>
    service.project(id, { install: true }).map((row) => row.path),
  );
}

export async function testSystemDocuments(
  repositoryRoot: string,
  specPath?: string,
) {
  const snapshot = workingSystemDescriptionSnapshot(repositoryRoot);
  const { report } = inspectRepositorySystemDocuments(
    repositoryRoot,
    snapshot,
    false,
  );
  assertIssues(
    report.issues.filter((issue) => issue.code !== 'test-not-passed'),
  );
  if (
    specPath !== undefined &&
    !report.specs.some((spec) => spec.path === specPath)
  )
    throw workflowError(
      'SYSTEM_SPEC_UNKNOWN',
      'Select an existing colocated spec.md.',
      ExitCode.usage,
    );
  const selected = report.scenarios
    .filter(
      (scenario) => specPath === undefined || scenario.specPath === specPath,
    )
    .map((scenario) => ({
      file: scenario.testPath!,
      name: scenario.testName!,
    }));
  const observed = await observeSystemDocumentTests(repositoryRoot, selected);
  const read = systemDocumentTestOutcomes(
    repositoryRoot,
    workingSystemDescriptionSnapshot(repositoryRoot),
  );
  const tests = selected.map(({ file, name }) => ({
    file,
    name,
    outcome: read(file, name),
  }));
  if (tests.some((test) => test.outcome !== 'passed'))
    throw workflowError(
      'SYSTEM_DOCUMENT_TESTS_FAILED',
      'Referenced tests did not all pass; inspect their exact outcomes.',
      ExitCode.verification,
      { details: { tests } },
    );
  return { tests, sourceStable: observed.sourceStable };
}

function assertIssues(
  issues: readonly { code: string; path: string; message: string }[],
): void {
  if (issues.length > 0)
    throw workflowError(
      'SYSTEM_DOCUMENTS_INVALID',
      `${issues.length} system document issue(s): ${issues[0]!.message}`,
      ExitCode.verification,
      {
        details: { issues },
        recovery:
          'Repair the named bindings; run jigwright documents test, documents render, then documents validate.',
      },
    );
}
