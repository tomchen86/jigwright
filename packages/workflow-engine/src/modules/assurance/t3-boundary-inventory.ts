/**
 * Compares observed namespace and schema boundaries with the recorded T3
 * inventory.
 *
 * Invariants:
 * - Check mode rejects drift between recorded boundaries and current
 *   source.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  createWorkflowNamespaceConfig,
  createWorkflowRecordIdentity,
} from '@jigwright/core/workflow-namespace';

import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  scanT3BoundarySource,
  type T3BoundaryFinding,
  type T3BoundarySourceFindings,
  type T3BoundaryTypeScriptApi,
} from './t3-boundary-scanner.ts';

const INVENTORY_PATH =
  'packages/workflow-engine/test/fixtures/t3-boundary-inventory.json';

type FindingSummary = Readonly<{
  occurrences: number;
  fileCount: number;
  identityDigest: `sha256:${string}`;
}>;

type NamespaceBaseline = Readonly<{
  legacyPrefix: string;
  sourceOccurrences: number;
  sourceFileCount: number;
  sourceIdentityDigest: string;
  bootstrapOccurrences: number;
  bootstrapFileCount: number;
  bootstrapIdentityDigest: string;
  recoveryOccurrences: number;
  recoveryFileCount: number;
  recoveryIdentityDigest: string;
  workflowJsonOccurrences: number;
  workflowJsonFileCount: number;
  workflowJsonIdentityDigest: string;
  jsonSchemaIdHosts: Readonly<Record<string, number>>;
  jsonSchemaIdIdentityDigest: string;
}>;

type WorkflowJsonReferenceBaseline = Readonly<{
  sourceOccurrences: number;
  sourceFileCount: number;
  sourceIdentityDigest: string;
  bootstrapOccurrences: number;
  bootstrapFileCount: number;
  bootstrapIdentityDigest: string;
  scriptsOccurrences: number;
  scriptsFileCount: number;
  scriptsIdentityDigest: string;
  recoveryOccurrences: number;
  recoveryFileCount: number;
  recoveryIdentityDigest: string;
  recoverySplitPathJoinOccurrences: number;
  recoverySplitPathJoinFileCount: number;
  recoverySplitPathJoinIdentityDigest: string;
  uniqueLiterals: readonly string[];
  splitPathJoinOccurrences: number;
  splitPathJoinFileCount: number;
  splitPathJoinIdentityDigest: string;
  dynamicDirectoryOccurrences: number;
  dynamicDirectoryFileCount: number;
  dynamicDirectoryIdentityDigest: string;
}>;

type BoundaryEvidence = Readonly<{
  path: string;
  contains: readonly string[];
}>;

type BoundaryNegativeEvidence = Readonly<{
  absentPaths: readonly string[];
  searchRoots: readonly string[];
  absentSymbols: readonly string[];
}>;

type BoundaryCoupling = Readonly<{
  id: string;
  state: 'coupled' | 'partial' | 'landed' | 'missing';
  evidence: readonly BoundaryEvidence[];
  negativeEvidence: BoundaryNegativeEvidence | null;
}>;

type BoundaryInventory = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright.workflow.t3-boundary-inventory.v1';
  architectureDocument: string;
  namespaceBaseline: NamespaceBaseline;
  workflowJsonReferenceBaseline: WorkflowJsonReferenceBaseline;
  workflowArtifactPathBaseline: FindingSummary & {
    packagePrefix: string;
  };
  couplings: readonly BoundaryCoupling[];
}>;

type JsonFinding = Readonly<{
  path: string;
  jsonPointer: string;
  normalizedValue: string;
}>;

export type T3BoundaryInventoryObservation = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright.boundary-inventory-check.v1';
  recordIdentity: Readonly<{
    schema: 'workflow.t3-boundary-inventory.v1';
    consumerNamespace: string;
  }>;
  status: 'current' | 'drift';
  inventoryPath: typeof INVENTORY_PATH;
  inventoryDigest: `sha256:${string}`;
  couplingCount: number;
  drift: readonly string[];
  observations: Readonly<{
    namespace: Readonly<{
      source: FindingSummary;
      bootstrap: FindingSummary;
      recovery: FindingSummary;
      workflowJson: FindingSummary;
      jsonSchemaIds: Readonly<{
        hosts: Readonly<Record<string, number>>;
        identityDigest: `sha256:${string}`;
      }>;
    }>;
    workflowJsonReferences: Readonly<{
      source: FindingSummary & { uniqueLiterals: readonly string[] };
      bootstrap: FindingSummary;
      scripts: FindingSummary;
      recovery: FindingSummary;
      recoverySplit: FindingSummary;
      sourceSplit: FindingSummary;
      sourceDynamic: FindingSummary;
    }>;
    workflowArtifactPaths: FindingSummary;
  }>;
}>;

/**
 * Inspect the exact current coupling surface without mutating the repository.
 * `check` converts any observed drift into verification exit 13.
 */
export function inspectT3BoundaryInventory(request: {
  repositoryRoot: string;
  check: boolean;
  typescript: T3BoundaryTypeScriptApi;
}): T3BoundaryInventoryObservation {
  const repositoryRoot = fs.realpathSync(request.repositoryRoot);
  const inventoryFile = path.join(repositoryRoot, INVENTORY_PATH);
  const inventorySource = readPlainFile(inventoryFile, INVENTORY_PATH);
  const inventory = parseBoundaryInventory(inventorySource);
  const legacyPrefix = inventory.namespaceBaseline.legacyPrefix;
  const namespaceConfig = readConsumerNamespaceConfig(repositoryRoot);

  const source = scanSourceRoot(
    request.typescript,
    repositoryRoot,
    'packages/workflow-engine/src',
    '.ts',
    legacyPrefix,
  );
  const bootstrap = scanSourceRoot(
    request.typescript,
    repositoryRoot,
    'packages/workflow-engine/bootstrap',
    '.ts',
    legacyPrefix,
  );
  const recovery = scanSourceRoot(
    request.typescript,
    repositoryRoot,
    'packages/workflow-engine/bootstrap/recovery-runtime/src',
    '.js',
    legacyPrefix,
  );
  const scripts = scanSourceRoot(
    request.typescript,
    repositoryRoot,
    'scripts',
    '.ts',
    legacyPrefix,
  );
  const workflowJsonNamespaces = scanJsonLeaves(
    repositoryRoot,
    'workflow',
    (_file, _pointer, value) => value.includes(legacyPrefix),
  ).flatMap((finding) => namespaceJsonFindings(finding, legacyPrefix));
  const jsonSchemaIds = scanJsonSchemaIds(repositoryRoot);
  const workflowArtifactPaths = scanJsonLeaves(
    repositoryRoot,
    'workflow',
    (file, _pointer, value) =>
      path.posix.dirname(file) === 'workflow' &&
      (value === inventory.workflowArtifactPathBaseline.packagePrefix ||
        value.startsWith(
          `${inventory.workflowArtifactPathBaseline.packagePrefix}/`,
        )),
  );

  const observations = Object.freeze({
    namespace: Object.freeze({
      source: summarizeFindings(source.namespace),
      bootstrap: summarizeFindings(bootstrap.namespace),
      recovery: summarizeFindings(recovery.namespace),
      workflowJson: summarizeJsonFindings(workflowJsonNamespaces),
      jsonSchemaIds: Object.freeze({
        hosts: summarizeSchemaHosts(jsonSchemaIds),
        identityDigest: digestJsonFindings(jsonSchemaIds),
      }),
    }),
    workflowJsonReferences: Object.freeze({
      source: Object.freeze({
        ...summarizeFindings(source.workflowPaths),
        uniqueLiterals: Object.freeze(
          [
            ...new Set(
              source.workflowPaths.map((item) => item.normalizedValue),
            ),
          ].sort(compareText),
        ),
      }),
      bootstrap: summarizeFindings(bootstrap.workflowPaths),
      scripts: summarizeFindings(scripts.workflowPaths),
      recovery: summarizeFindings(recovery.workflowPaths),
      recoverySplit: summarizeFindings(recovery.splitWorkflowPaths),
      sourceSplit: summarizeFindings(source.splitWorkflowPaths),
      sourceDynamic: summarizeFindings(source.dynamicWorkflowDirectories),
    }),
    workflowArtifactPaths: summarizeJsonFindings(workflowArtifactPaths),
  });

  const drift = compareObservationToInventory(observations, inventory);
  verifyCouplingEvidence(repositoryRoot, inventory, drift);
  const result: T3BoundaryInventoryObservation = Object.freeze({
    schemaVersion: 1,
    kind: 'jigwright.boundary-inventory-check.v1',
    recordIdentity: createWorkflowRecordIdentity(
      namespaceConfig,
      't3-boundary-inventory',
      1,
    ) as T3BoundaryInventoryObservation['recordIdentity'],
    status: drift.length === 0 ? 'current' : 'drift',
    inventoryPath: INVENTORY_PATH,
    inventoryDigest: digestText(inventorySource),
    couplingCount: inventory.couplings.length,
    drift: Object.freeze([...drift]),
    observations,
  });
  if (request.check && result.status === 'drift') {
    throw workflowError(
      'T3_BOUNDARY_INVENTORY_DRIFT',
      'The machine-checked T3 boundary inventory does not match the current repository.',
      ExitCode.verification,
      { details: { drift: result.drift } },
    );
  }
  return result;
}

function readConsumerNamespaceConfig(repositoryRoot: string) {
  const configPath = 'workflow/config.json';
  let value: unknown;
  try {
    value = JSON.parse(
      readPlainFile(path.join(repositoryRoot, configPath), configPath),
    ) as unknown;
  } catch {
    throw inventoryInvalid('Workflow configuration must be valid JSON.');
  }
  if (
    !isRecord(value) ||
    typeof value.repositoryName !== 'string' ||
    (value.consumerNamespace !== undefined &&
      typeof value.consumerNamespace !== 'string') ||
    Object.hasOwn(value, 'acceptedLegacySchemaPrefixes')
  ) {
    throw inventoryInvalid('Workflow namespace configuration is invalid.');
  }
  return createWorkflowNamespaceConfig({
    consumerNamespace: value.consumerNamespace ?? value.repositoryName,
  });
}

function parseBoundaryInventory(source: string): BoundaryInventory {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw inventoryInvalid('Boundary inventory must be valid JSON.');
  }
  if (!isRecord(value)) {
    throw inventoryInvalid('Boundary inventory must be an object.');
  }
  if (
    value.schemaVersion !== 1 ||
    value.kind !== 'jigwright.workflow.t3-boundary-inventory.v1' ||
    typeof value.architectureDocument !== 'string' ||
    !isRecord(value.namespaceBaseline) ||
    typeof value.namespaceBaseline.legacyPrefix !== 'string' ||
    !value.namespaceBaseline.legacyPrefix.endsWith('.') ||
    !isRecord(value.workflowJsonReferenceBaseline) ||
    !isRecord(value.workflowArtifactPathBaseline) ||
    !Array.isArray(value.couplings)
  ) {
    throw inventoryInvalid('Boundary inventory has an unsupported shape.');
  }
  for (const coupling of value.couplings) {
    if (
      !isRecord(coupling) ||
      typeof coupling.id !== 'string' ||
      !['coupled', 'partial', 'landed', 'missing'].includes(
        String(coupling.state),
      ) ||
      !Array.isArray(coupling.evidence)
    ) {
      throw inventoryInvalid('Boundary inventory coupling is malformed.');
    }
  }
  return value as BoundaryInventory;
}

function scanSourceRoot(
  typescript: T3BoundaryTypeScriptApi,
  repositoryRoot: string,
  relativeRoot: string,
  extension: string,
  legacyPrefix: string,
): T3BoundarySourceFindings {
  const result: T3BoundarySourceFindings = {
    workflowPaths: [],
    splitWorkflowPaths: [],
    dynamicWorkflowDirectories: [],
    namespace: [],
  };
  for (const file of listRegularFiles(repositoryRoot, relativeRoot)) {
    if (!file.endsWith(extension)) continue;
    const source = readPlainFile(path.join(repositoryRoot, file), file);
    const finding = scanT3BoundarySource(
      typescript,
      file,
      source,
      extension,
      legacyPrefix,
    );
    result.workflowPaths.push(...finding.workflowPaths);
    result.splitWorkflowPaths.push(...finding.splitWorkflowPaths);
    result.dynamicWorkflowDirectories.push(
      ...finding.dynamicWorkflowDirectories,
    );
    result.namespace.push(...finding.namespace);
  }
  for (const entries of Object.values(result)) {
    entries.sort(compareFindings);
  }
  return result;
}

function compareObservationToInventory(
  observed: T3BoundaryInventoryObservation['observations'],
  inventory: BoundaryInventory,
): string[] {
  const expected = {
    namespace: {
      source: baselineSummary(inventory.namespaceBaseline, 'source'),
      bootstrap: baselineSummary(inventory.namespaceBaseline, 'bootstrap'),
      recovery: baselineSummary(inventory.namespaceBaseline, 'recovery'),
      workflowJson: baselineSummary(
        inventory.namespaceBaseline,
        'workflowJson',
      ),
      jsonSchemaIds: {
        hosts: inventory.namespaceBaseline.jsonSchemaIdHosts,
        identityDigest: inventory.namespaceBaseline.jsonSchemaIdIdentityDigest,
      },
    },
    workflowJsonReferences: {
      source: {
        ...referenceSummary(inventory.workflowJsonReferenceBaseline, 'source'),
        uniqueLiterals: inventory.workflowJsonReferenceBaseline.uniqueLiterals,
      },
      bootstrap: referenceSummary(
        inventory.workflowJsonReferenceBaseline,
        'bootstrap',
      ),
      scripts: referenceSummary(
        inventory.workflowJsonReferenceBaseline,
        'scripts',
      ),
      recovery: referenceSummary(
        inventory.workflowJsonReferenceBaseline,
        'recovery',
      ),
      recoverySplit: {
        occurrences:
          inventory.workflowJsonReferenceBaseline
            .recoverySplitPathJoinOccurrences,
        fileCount:
          inventory.workflowJsonReferenceBaseline
            .recoverySplitPathJoinFileCount,
        identityDigest:
          inventory.workflowJsonReferenceBaseline
            .recoverySplitPathJoinIdentityDigest,
      },
      sourceSplit: {
        occurrences:
          inventory.workflowJsonReferenceBaseline.splitPathJoinOccurrences,
        fileCount:
          inventory.workflowJsonReferenceBaseline.splitPathJoinFileCount,
        identityDigest:
          inventory.workflowJsonReferenceBaseline.splitPathJoinIdentityDigest,
      },
      sourceDynamic: {
        occurrences:
          inventory.workflowJsonReferenceBaseline.dynamicDirectoryOccurrences,
        fileCount:
          inventory.workflowJsonReferenceBaseline.dynamicDirectoryFileCount,
        identityDigest:
          inventory.workflowJsonReferenceBaseline
            .dynamicDirectoryIdentityDigest,
      },
    },
    workflowArtifactPaths: {
      occurrences: inventory.workflowArtifactPathBaseline.occurrences,
      fileCount: inventory.workflowArtifactPathBaseline.fileCount,
      identityDigest: inventory.workflowArtifactPathBaseline.identityDigest,
    },
  };
  const drift: string[] = [];
  compareLeaves(expected, observed, '', drift);
  return drift;
}

function baselineSummary(
  baseline: NamespaceBaseline,
  prefix: 'source' | 'bootstrap' | 'recovery' | 'workflowJson',
): FindingSummary {
  return {
    occurrences: baseline[`${prefix}Occurrences`],
    fileCount: baseline[`${prefix}FileCount`],
    identityDigest: baseline[`${prefix}IdentityDigest`] as `sha256:${string}`,
  };
}

function referenceSummary(
  baseline: WorkflowJsonReferenceBaseline,
  prefix: 'source' | 'bootstrap' | 'scripts' | 'recovery',
): FindingSummary {
  return {
    occurrences: baseline[`${prefix}Occurrences`],
    fileCount: baseline[`${prefix}FileCount`],
    identityDigest: baseline[`${prefix}IdentityDigest`] as `sha256:${string}`,
  };
}

function compareLeaves(
  expected: unknown,
  observed: unknown,
  pointer: string,
  drift: string[],
): void {
  if (Array.isArray(expected) || Array.isArray(observed)) {
    if (JSON.stringify(expected) !== JSON.stringify(observed)) {
      drift.push(pointer || '/');
    }
    return;
  }
  if (isRecord(expected) && isRecord(observed)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(observed)]);
    for (const key of [...keys].sort(compareText)) {
      compareLeaves(
        expected[key],
        observed[key],
        `${pointer}/${escapeJsonPointerSegment(key)}`,
        drift,
      );
    }
    return;
  }
  if (expected !== observed) drift.push(pointer || '/');
}

function verifyCouplingEvidence(
  repositoryRoot: string,
  inventory: BoundaryInventory,
  drift: string[],
): void {
  const ids = new Set<string>();
  for (const coupling of inventory.couplings) {
    if (ids.has(coupling.id)) {
      drift.push(`/couplings/${coupling.id}/duplicate`);
    }
    ids.add(coupling.id);
    for (const evidence of coupling.evidence) {
      const source = tryReadPlainFile(repositoryRoot, evidence.path);
      if (
        source === null ||
        evidence.contains.some((fragment) => !source.includes(fragment))
      ) {
        drift.push(`/couplings/${coupling.id}/evidence/${evidence.path}`);
      }
    }
    const negative = coupling.negativeEvidence;
    if (negative !== null) {
      for (const absentPath of negative.absentPaths) {
        if (
          fs.lstatSync(path.join(repositoryRoot, absentPath), {
            throwIfNoEntry: false,
          }) !== undefined
        ) {
          drift.push(`/couplings/${coupling.id}/negative/${absentPath}`);
        }
      }
      const searchable = negative.searchRoots
        .flatMap((root) => listRegularFiles(repositoryRoot, root))
        .filter((file) => /\.(?:ts|js|json|md)$/u.test(file))
        .map((file) => readPlainFile(path.join(repositoryRoot, file), file))
        .join('\n');
      for (const symbol of negative.absentSymbols) {
        if (searchable.includes(symbol)) {
          drift.push(`/couplings/${coupling.id}/negative-symbol/${symbol}`);
        }
      }
    }
  }
  const architecture = tryReadPlainFile(
    repositoryRoot,
    inventory.architectureDocument,
  );
  for (const id of ids) {
    if (architecture?.includes(`<!-- coupling:${id} -->`) !== true) {
      drift.push(`/architecture/${id}`);
    }
  }
}

function scanJsonSchemaIds(repositoryRoot: string): JsonFinding[] {
  const result: JsonFinding[] = [];
  for (const file of listRegularFiles(repositoryRoot, 'workflow/schemas')) {
    if (!file.endsWith('.json')) continue;
    const value = JSON.parse(
      readPlainFile(path.join(repositoryRoot, file), file),
    ) as unknown;
    if (!isRecord(value) || typeof value.$id !== 'string') {
      throw inventoryInvalid(`JSON Schema ${file} must define a string $id.`);
    }
    try {
      new URL(value.$id);
    } catch {
      throw inventoryInvalid(`JSON Schema ${file} has an invalid $id.`);
    }
    result.push({
      path: file,
      jsonPointer: '/$id',
      normalizedValue: value.$id,
    });
  }
  return result.sort(compareJsonFinding);
}

function scanJsonLeaves(
  repositoryRoot: string,
  relativeRoot: string,
  include: (file: string, pointer: string, value: string) => boolean,
): JsonFinding[] {
  const findings: JsonFinding[] = [];
  for (const file of listRegularFiles(repositoryRoot, relativeRoot)) {
    if (!file.endsWith('.json')) continue;
    const value = JSON.parse(
      readPlainFile(path.join(repositoryRoot, file), file),
    ) as unknown;
    visitJsonStrings(value, '', (pointer, leaf) => {
      if (include(file, pointer, leaf)) {
        findings.push({
          path: file,
          jsonPointer: pointer,
          normalizedValue: leaf,
        });
      }
    });
  }
  return findings.sort(compareJsonFinding);
}

function namespaceJsonFindings(
  finding: JsonFinding,
  prefix: string,
): JsonFinding[] {
  const pattern = new RegExp(`${escapeRegex(prefix)}[A-Za-z0-9._-]+`, 'gu');
  const matches = [...finding.normalizedValue.matchAll(pattern)].map(
    (match) => ({ ...finding, normalizedValue: match[0] }),
  );
  return matches.length > 0
    ? matches
    : [{ ...finding, normalizedValue: prefix }];
}

function visitJsonStrings(
  value: unknown,
  pointer: string,
  visit: (pointer: string, value: string) => void,
): void {
  if (typeof value === 'string') {
    visit(pointer, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitJsonStrings(entry, `${pointer}/${index}`, visit),
    );
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    visitJsonStrings(
      entry,
      `${pointer}/${escapeJsonPointerSegment(key)}`,
      visit,
    );
  }
}

function summarizeFindings(
  findings: readonly T3BoundaryFinding[],
): FindingSummary {
  return {
    occurrences: findings.length,
    fileCount: new Set(findings.map((finding) => finding.path)).size,
    identityDigest: digestText(
      findings
        .map((finding) =>
          [finding.path, finding.normalizedValue, finding.syntaxForm].join(
            '\0',
          ),
        )
        .sort(compareText)
        .join('\n'),
    ),
  };
}

function summarizeJsonFindings(
  findings: readonly JsonFinding[],
): FindingSummary {
  return {
    occurrences: findings.length,
    fileCount: new Set(findings.map((finding) => finding.path)).size,
    identityDigest: digestJsonFindings(findings),
  };
}

function summarizeSchemaHosts(
  findings: readonly JsonFinding[],
): Readonly<Record<string, number>> {
  const hosts: Record<string, number> = {};
  for (const finding of findings) {
    const host = new URL(finding.normalizedValue).host;
    hosts[host] = (hosts[host] ?? 0) + 1;
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(hosts).sort(([left], [right]) => compareText(left, right)),
    ),
  );
}

function digestJsonFindings(
  findings: readonly JsonFinding[],
): `sha256:${string}` {
  return digestText(
    findings
      .map((finding) =>
        [finding.path, finding.jsonPointer, finding.normalizedValue].join('\0'),
      )
      .sort(compareText)
      .join('\n'),
  );
}

function listRegularFiles(
  repositoryRoot: string,
  relativeRoot: string,
): string[] {
  const absoluteRoot = path.join(repositoryRoot, relativeRoot);
  const rootStats = fs.lstatSync(absoluteRoot, { throwIfNoEntry: false });
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw inventoryInvalid(
      `Inventory scan root is unavailable: ${relativeRoot}`,
    );
  }
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw inventoryInvalid(`Inventory scan refuses symlink: ${absolute}`);
      }
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) {
        result.push(
          path.relative(repositoryRoot, absolute).split(path.sep).join('/'),
        );
      }
    }
  };
  visit(absoluteRoot);
  return result.sort(compareText);
}

function readPlainFile(absolutePath: string, label: string): string {
  const stats = fs.lstatSync(absolutePath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw inventoryInvalid(`Inventory input must be a plain file: ${label}`);
  }
  return fs.readFileSync(absolutePath, 'utf8');
}

function tryReadPlainFile(
  repositoryRoot: string,
  relativePath: string,
): string | null {
  const absolute = path.join(repositoryRoot, relativePath);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink()) return null;
  return fs.readFileSync(absolute, 'utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareFindings(
  left: T3BoundaryFinding,
  right: T3BoundaryFinding,
): number {
  return (
    compareText(left.path, right.path) ||
    left.start - right.start ||
    compareText(left.normalizedValue, right.normalizedValue) ||
    compareText(left.syntaxForm, right.syntaxForm)
  );
}

function compareJsonFinding(left: JsonFinding, right: JsonFinding): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.jsonPointer, right.jsonPointer) ||
    compareText(left.normalizedValue, right.normalizedValue)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

function digestText(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function inventoryInvalid(message: string): Error {
  return workflowError(
    'T3_BOUNDARY_INVENTORY_INVALID',
    message,
    ExitCode.verification,
  );
}
