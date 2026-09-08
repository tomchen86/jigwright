/** T3 inventory schema, pinned identity, and positive/negative coupling evidence validation. */
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import {
  assertPlainObject,
  assertExactKeys,
  compareText,
  listRegularFiles,
} from './boundary-contract-fixture.ts';

export const EXPECTED_T3_BOUNDARY_INVENTORY_DIGEST =
  'sha256:c370581ab1f37ae8c8053b8d1c8ada6b189c40a114dec949434372ca83d5780c';

export const T3_BOUNDARY_INVENTORY_FILE = 't3-boundary-inventory.json';

export const EXPECTED_T3_COUPLING_IDS = Object.freeze([
  'agent-provider-identity',
  'availability-pilot',
  'central-grant-shadow-authority',
  'collaboration-grant',
  'data-egress-authorization',
  'execution-substrate',
  'openspec-direct-dependency',
  'package-topology',
  'planning-provider-binding',
  'policy-path-literals',
  'provider-plane-separation',
  'provider-runner',
  'recovery-mirror',
  'role-assurance',
  'runtime-distribution',
  'schema-signature-namespace',
]);

const KNOWN_T3_COUPLING_STATES = new Set([
  'coupled',
  'landed',
  'missing',
  'partial',
  'unresolved',
]);

type T3BoundaryEvidence = {
  path: string;
  contains: string[];
};

type T3NegativeEvidence = {
  absentPaths: string[];
  absentSymbols: string[];
  searchRoots: string[];
};

type T3BoundaryCoupling = {
  id: string;
  plane: string;
  state: string;
  t3Disposition: string;
  evidence: T3BoundaryEvidence[];
  negativeEvidence: T3NegativeEvidence | null;
};

type T3BoundaryInventory = {
  kind: 'jigwright.workflow.t3-boundary-inventory.v1';
  schemaVersion: 1;
  observedAtCommit: string;
  architectureDocument: string;
  namespaceBaseline: {
    legacyPrefix: 'expense-app.workflow.';
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
    jsonSchemaIdHosts: Record<string, number>;
    jsonSchemaIdIdentityDigest: string;
  };
  workflowJsonReferenceBaseline: {
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
    uniqueLiterals: string[];
    splitPathJoinOccurrences: number;
    splitPathJoinFileCount: number;
    splitPathJoinIdentityDigest: string;
    dynamicDirectoryOccurrences: number;
    dynamicDirectoryFileCount: number;
    dynamicDirectoryIdentityDigest: string;
  };
  workflowArtifactPathBaseline: {
    packagePrefix: 'packages/workflow-engine';
    occurrences: number;
    fileCount: number;
    identityDigest: string;
  };
  couplings: T3BoundaryCoupling[];
};

export function parseT3BoundaryInventory(text: string): T3BoundaryInventory {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error('T3 boundary inventory is malformed JSON.', {
      cause: error,
    });
  }
  assertPlainObject(value, 'T3 boundary inventory');
  assertExactKeys(value, [
    'architectureDocument',
    'workflowArtifactPathBaseline',
    'couplings',
    'kind',
    'namespaceBaseline',
    'observedAtCommit',
    'workflowJsonReferenceBaseline',
    'schemaVersion',
  ]);
  if (
    value.kind !== 'jigwright.workflow.t3-boundary-inventory.v1' ||
    value.schemaVersion !== 1 ||
    typeof value.observedAtCommit !== 'string' ||
    !/^[0-9a-f]{40}$/u.test(value.observedAtCommit) ||
    typeof value.architectureDocument !== 'string' ||
    !isSafeRepositoryRelativePath(value.architectureDocument) ||
    !Array.isArray(value.couplings)
  ) {
    throw new Error('T3 boundary inventory header is invalid.');
  }

  assertPlainObject(value.namespaceBaseline, 'T3 namespace baseline');
  assertExactKeys(value.namespaceBaseline, [
    'bootstrapFileCount',
    'bootstrapIdentityDigest',
    'bootstrapOccurrences',
    'jsonSchemaIdIdentityDigest',
    'jsonSchemaIdHosts',
    'legacyPrefix',
    'recoveryFileCount',
    'recoveryIdentityDigest',
    'recoveryOccurrences',
    'sourceFileCount',
    'sourceIdentityDigest',
    'sourceOccurrences',
    'workflowJsonFileCount',
    'workflowJsonIdentityDigest',
    'workflowJsonOccurrences',
  ]);
  assertPlainObject(
    value.namespaceBaseline.jsonSchemaIdHosts,
    'T3 JSON Schema host baseline',
  );
  if (
    value.namespaceBaseline.legacyPrefix !== 'expense-app.workflow.' ||
    !isNonNegativeInteger(value.namespaceBaseline.sourceOccurrences) ||
    !isNonNegativeInteger(value.namespaceBaseline.sourceFileCount) ||
    !isSha256Digest(value.namespaceBaseline.sourceIdentityDigest) ||
    !isNonNegativeInteger(value.namespaceBaseline.bootstrapOccurrences) ||
    !isNonNegativeInteger(value.namespaceBaseline.bootstrapFileCount) ||
    !isSha256Digest(value.namespaceBaseline.bootstrapIdentityDigest) ||
    !isNonNegativeInteger(value.namespaceBaseline.recoveryOccurrences) ||
    !isNonNegativeInteger(value.namespaceBaseline.recoveryFileCount) ||
    !isSha256Digest(value.namespaceBaseline.recoveryIdentityDigest) ||
    !isNonNegativeInteger(value.namespaceBaseline.workflowJsonOccurrences) ||
    !isNonNegativeInteger(value.namespaceBaseline.workflowJsonFileCount) ||
    !isSha256Digest(value.namespaceBaseline.workflowJsonIdentityDigest) ||
    !isSha256Digest(value.namespaceBaseline.jsonSchemaIdIdentityDigest)
  ) {
    throw new Error('T3 namespace baseline is invalid.');
  }
  const jsonSchemaIdHosts: Record<string, number> = {};
  for (const [host, count] of Object.entries(
    value.namespaceBaseline.jsonSchemaIdHosts,
  )) {
    if (!/^[a-z0-9.-]+$/u.test(host) || !isNonNegativeInteger(count)) {
      throw new Error('T3 JSON Schema host baseline is invalid.');
    }
    jsonSchemaIdHosts[host] = count;
  }

  assertPlainObject(
    value.workflowJsonReferenceBaseline,
    'T3 workflow JSON reference baseline',
  );
  assertExactKeys(value.workflowJsonReferenceBaseline, [
    'bootstrapFileCount',
    'bootstrapIdentityDigest',
    'bootstrapOccurrences',
    'dynamicDirectoryFileCount',
    'dynamicDirectoryIdentityDigest',
    'dynamicDirectoryOccurrences',
    'recoveryFileCount',
    'recoveryIdentityDigest',
    'recoveryOccurrences',
    'recoverySplitPathJoinFileCount',
    'recoverySplitPathJoinIdentityDigest',
    'recoverySplitPathJoinOccurrences',
    'scriptsFileCount',
    'scriptsIdentityDigest',
    'scriptsOccurrences',
    'sourceFileCount',
    'sourceIdentityDigest',
    'sourceOccurrences',
    'splitPathJoinFileCount',
    'splitPathJoinIdentityDigest',
    'splitPathJoinOccurrences',
    'uniqueLiterals',
  ]);
  if (
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.sourceOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.sourceFileCount,
    ) ||
    !isSha256Digest(value.workflowJsonReferenceBaseline.sourceIdentityDigest) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.bootstrapOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.bootstrapFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.bootstrapIdentityDigest,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.scriptsOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.scriptsFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.scriptsIdentityDigest,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.recoveryOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.recoveryFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.recoveryIdentityDigest,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.recoverySplitPathJoinOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.recoverySplitPathJoinFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.recoverySplitPathJoinIdentityDigest,
    ) ||
    !Array.isArray(value.workflowJsonReferenceBaseline.uniqueLiterals) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.splitPathJoinOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.splitPathJoinFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.splitPathJoinIdentityDigest,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.dynamicDirectoryOccurrences,
    ) ||
    !isNonNegativeInteger(
      value.workflowJsonReferenceBaseline.dynamicDirectoryFileCount,
    ) ||
    !isSha256Digest(
      value.workflowJsonReferenceBaseline.dynamicDirectoryIdentityDigest,
    )
  ) {
    throw new Error('T3 workflow JSON reference baseline is invalid.');
  }
  const uniqueLiterals = value.workflowJsonReferenceBaseline.uniqueLiterals.map(
    (literal) => {
      if (
        typeof literal !== 'string' ||
        !/^workflow\/[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(literal)
      ) {
        throw new Error('T3 policy literal baseline contains an invalid path.');
      }
      return literal;
    },
  );
  assert.deepEqual(
    uniqueLiterals,
    [...new Set(uniqueLiterals)].sort(compareText),
    'T3 policy literals must be sorted and unique.',
  );

  assertPlainObject(
    value.workflowArtifactPathBaseline,
    'T3 workflow artifact path baseline',
  );
  assertExactKeys(value.workflowArtifactPathBaseline, [
    'fileCount',
    'identityDigest',
    'occurrences',
    'packagePrefix',
  ]);
  if (
    value.workflowArtifactPathBaseline.packagePrefix !==
      'packages/workflow-engine' ||
    !isNonNegativeInteger(value.workflowArtifactPathBaseline.occurrences) ||
    !isNonNegativeInteger(value.workflowArtifactPathBaseline.fileCount) ||
    !isSha256Digest(value.workflowArtifactPathBaseline.identityDigest)
  ) {
    throw new Error('T3 workflow artifact path baseline is invalid.');
  }

  const couplings = value.couplings.map((candidate, index) => {
    assertPlainObject(candidate, `T3 coupling ${index + 1}`);
    assertExactKeys(candidate, [
      'evidence',
      'id',
      'negativeEvidence',
      'plane',
      'state',
      't3Disposition',
    ]);
    if (
      typeof candidate.id !== 'string' ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(candidate.id) ||
      typeof candidate.plane !== 'string' ||
      candidate.plane.length === 0 ||
      typeof candidate.state !== 'string' ||
      !KNOWN_T3_COUPLING_STATES.has(candidate.state) ||
      typeof candidate.t3Disposition !== 'string' ||
      candidate.t3Disposition.length === 0 ||
      !Array.isArray(candidate.evidence)
    ) {
      throw new Error(`T3 coupling ${index + 1} is invalid.`);
    }
    const evidence = candidate.evidence.map((entry, evidenceIndex) =>
      parseT3BoundaryEvidence(
        entry,
        `T3 coupling ${candidate.id} evidence ${evidenceIndex + 1}`,
      ),
    );
    let negativeEvidence: T3NegativeEvidence | null = null;
    if (candidate.negativeEvidence !== null) {
      assertPlainObject(
        candidate.negativeEvidence,
        `T3 coupling ${candidate.id} negative evidence`,
      );
      assertExactKeys(candidate.negativeEvidence, [
        'absentPaths',
        'absentSymbols',
        'searchRoots',
      ]);
      const absentPaths = parseStringList(
        candidate.negativeEvidence.absentPaths,
        'absent path',
      );
      const absentSymbols = parseStringList(
        candidate.negativeEvidence.absentSymbols,
        'absent symbol',
      );
      const searchRoots = parseStringList(
        candidate.negativeEvidence.searchRoots,
        'search root',
      );
      if (
        absentPaths.length === 0 ||
        absentSymbols.length === 0 ||
        searchRoots.length === 0 ||
        [...absentPaths, ...searchRoots].some(
          (entry) => !isSafeRepositoryRelativePath(entry),
        )
      ) {
        throw new Error(
          `T3 coupling ${candidate.id} lacks two-method negative evidence.`,
        );
      }
      negativeEvidence = { absentPaths, absentSymbols, searchRoots };
    }
    return {
      id: candidate.id,
      plane: candidate.plane,
      state: candidate.state,
      t3Disposition: candidate.t3Disposition,
      evidence,
      negativeEvidence,
    };
  });
  assert.deepEqual(
    couplings.map((coupling) => coupling.id),
    [...new Set(couplings.map((coupling) => coupling.id))].sort(compareText),
    'T3 coupling IDs must be sorted and unique.',
  );

  return {
    kind: 'jigwright.workflow.t3-boundary-inventory.v1',
    schemaVersion: 1,
    observedAtCommit: value.observedAtCommit,
    architectureDocument: value.architectureDocument,
    namespaceBaseline: {
      legacyPrefix: 'expense-app.workflow.',
      sourceOccurrences: value.namespaceBaseline.sourceOccurrences,
      sourceFileCount: value.namespaceBaseline.sourceFileCount,
      sourceIdentityDigest: value.namespaceBaseline.sourceIdentityDigest,
      bootstrapOccurrences: value.namespaceBaseline.bootstrapOccurrences,
      bootstrapFileCount: value.namespaceBaseline.bootstrapFileCount,
      bootstrapIdentityDigest: value.namespaceBaseline.bootstrapIdentityDigest,
      recoveryOccurrences: value.namespaceBaseline.recoveryOccurrences,
      recoveryFileCount: value.namespaceBaseline.recoveryFileCount,
      recoveryIdentityDigest: value.namespaceBaseline.recoveryIdentityDigest,
      workflowJsonOccurrences: value.namespaceBaseline.workflowJsonOccurrences,
      workflowJsonFileCount: value.namespaceBaseline.workflowJsonFileCount,
      workflowJsonIdentityDigest:
        value.namespaceBaseline.workflowJsonIdentityDigest,
      jsonSchemaIdHosts,
      jsonSchemaIdIdentityDigest:
        value.namespaceBaseline.jsonSchemaIdIdentityDigest,
    },
    workflowJsonReferenceBaseline: {
      sourceOccurrences: value.workflowJsonReferenceBaseline.sourceOccurrences,
      sourceFileCount: value.workflowJsonReferenceBaseline.sourceFileCount,
      sourceIdentityDigest:
        value.workflowJsonReferenceBaseline.sourceIdentityDigest,
      bootstrapOccurrences:
        value.workflowJsonReferenceBaseline.bootstrapOccurrences,
      bootstrapFileCount:
        value.workflowJsonReferenceBaseline.bootstrapFileCount,
      bootstrapIdentityDigest:
        value.workflowJsonReferenceBaseline.bootstrapIdentityDigest,
      scriptsOccurrences:
        value.workflowJsonReferenceBaseline.scriptsOccurrences,
      scriptsFileCount: value.workflowJsonReferenceBaseline.scriptsFileCount,
      scriptsIdentityDigest:
        value.workflowJsonReferenceBaseline.scriptsIdentityDigest,
      recoveryOccurrences:
        value.workflowJsonReferenceBaseline.recoveryOccurrences,
      recoveryFileCount: value.workflowJsonReferenceBaseline.recoveryFileCount,
      recoveryIdentityDigest:
        value.workflowJsonReferenceBaseline.recoveryIdentityDigest,
      recoverySplitPathJoinOccurrences:
        value.workflowJsonReferenceBaseline.recoverySplitPathJoinOccurrences,
      recoverySplitPathJoinFileCount:
        value.workflowJsonReferenceBaseline.recoverySplitPathJoinFileCount,
      recoverySplitPathJoinIdentityDigest:
        value.workflowJsonReferenceBaseline.recoverySplitPathJoinIdentityDigest,
      uniqueLiterals,
      splitPathJoinOccurrences:
        value.workflowJsonReferenceBaseline.splitPathJoinOccurrences,
      splitPathJoinFileCount:
        value.workflowJsonReferenceBaseline.splitPathJoinFileCount,
      splitPathJoinIdentityDigest:
        value.workflowJsonReferenceBaseline.splitPathJoinIdentityDigest,
      dynamicDirectoryOccurrences:
        value.workflowJsonReferenceBaseline.dynamicDirectoryOccurrences,
      dynamicDirectoryFileCount:
        value.workflowJsonReferenceBaseline.dynamicDirectoryFileCount,
      dynamicDirectoryIdentityDigest:
        value.workflowJsonReferenceBaseline.dynamicDirectoryIdentityDigest,
    },
    workflowArtifactPathBaseline: {
      packagePrefix: 'packages/workflow-engine',
      occurrences: value.workflowArtifactPathBaseline.occurrences,
      fileCount: value.workflowArtifactPathBaseline.fileCount,
      identityDigest: value.workflowArtifactPathBaseline.identityDigest,
    },
    couplings,
  };
}

function parseT3BoundaryEvidence(
  value: unknown,
  label: string,
): T3BoundaryEvidence {
  assertPlainObject(value, label);
  assertExactKeys(value, ['contains', 'path']);
  if (
    typeof value.path !== 'string' ||
    !isSafeRepositoryRelativePath(value.path)
  ) {
    throw new Error(`${label} has an invalid path.`);
  }
  const contains = parseStringList(value.contains, `${label} substring`);
  if (contains.length === 0) {
    throw new Error(`${label} must name at least one substring.`);
  }
  return { path: value.path, contains };
}

function parseStringList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        typeof entry !== 'string' || entry.length === 0 || entry.includes('\0'),
    )
  ) {
    throw new Error(`T3 ${label} list is invalid.`);
  }
  return value as string[];
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSha256Digest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function isSafeRepositoryRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.posix.isAbsolute(value) &&
    !value.includes('\\') &&
    path.posix.normalize(value) === value &&
    value
      .split('/')
      .every((part) => part.length > 0 && part !== '.' && part !== '..')
  );
}

export function assertBoundaryEvidence(
  root: string,
  couplingId: string,
  evidence: T3BoundaryEvidence,
): void {
  const absolute = path.join(root, evidence.path);
  const stats = fs.lstatSync(absolute, { throwIfNoEntry: false });
  assert.ok(
    stats?.isFile() && !stats.isSymbolicLink(),
    `${couplingId} evidence must be a plain file: ${evidence.path}`,
  );
  const source = fs.readFileSync(absolute, 'utf8');
  for (const expected of evidence.contains) {
    assert.ok(
      source.includes(expected),
      `${couplingId} evidence drifted: ${evidence.path} lacks ${JSON.stringify(expected)}`,
    );
  }
}

export function assertNegativeEvidence(
  root: string,
  couplingId: string,
  evidence: T3NegativeEvidence,
): void {
  for (const absentPath of evidence.absentPaths) {
    assert.equal(
      fs.lstatSync(path.join(root, absentPath), { throwIfNoEntry: false }),
      undefined,
      `${couplingId} path absence changed: ${absentPath}`,
    );
  }

  const searchable = evidence.searchRoots
    .flatMap((searchRoot) => listRegularFiles(root, searchRoot))
    .filter((file) => /\.(?:ts|js|json|md)$/u.test(file))
    .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
    .join('\n');
  for (const absentSymbol of evidence.absentSymbols) {
    assert.equal(
      searchable.includes(absentSymbol),
      false,
      `${couplingId} symbol absence changed: ${absentSymbol}`,
    );
  }
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
