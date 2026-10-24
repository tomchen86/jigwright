/** Pure mechanical transformation closure, projection and immutable evidence validation. */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import type {
  MechanicalTransformExecution,
  TransformationRetainedDisposition,
  TransformationTerm,
} from '../planning-provider/planning-artifact-types.ts';
import { type EvidenceNode } from '../../foundation/evidence-node/evidence-node.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  classifyMutationPath,
  type MutationClass,
} from '../source/mutation-class-policy.ts';
import {
  matchesAllowedPath,
  normalizeChangedPath,
} from '../../foundation/repository-path/repository-path.ts';
import type { deriveReviewedMutationClassPolicy } from '../source/reviewed-mutation-policy.ts';
import { type TrackedTreeEntry } from '../source/tracked-path.ts';
import type { SessionInspection } from './session-inspection.ts';

const DIGEST = /^[0-9a-f]{64}$/;

export const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const RETAINED_CLASSES = new Set<MutationClass>([
  'append-only',
  'immutable',
  'historical-reference',
]);

const LIVE_CLOSURE_CLASSES = new Set<MutationClass>([
  'live',
  'prohibited',
  'generated',
  'mirror',
]);

const MUTATION_CLASS_VALUES = new Set<MutationClass>([
  ...LIVE_CLOSURE_CLASSES,
  ...RETAINED_CLASSES,
]);

export const TASK_MECHANICAL_TRANSFORM_POLICY_DIGEST = sha256(
  canonicalJson({
    schemaVersion: 1,
    evaluator: 'workflow-task-mechanical-transform.v1',
    rule: 'Scan the full prospective tracked tree within reviewed scopes; reject every old-term occurrence in live closure classes, require exact reviewed dispositions for retained historical classes, and require every replacement term.',
  }),
);

type MechanicalTermHit = Readonly<{
  term: TransformationTerm;
  path: string;
  mutationClass: MutationClass;
  occurrenceCount: number;
  locationsDigest: string;
}>;

export type TaskMechanicalTransformationEvidenceRecord = Readonly<{
  schemaVersion: 1;
  kind: 'task-mechanical-transformation-evidence.v1';
  recordDigest: string;
  sessionId: string;
  changeId: string;
  taskId: string;
  baseline: Readonly<{ head: string; tree: string }>;
  candidateTree: string;
  candidateTreeDigest: string;
  changedPaths: readonly string[];
  taskContractDigest: string;
  transformationContractDigest: string;
  mutationPolicyDigest: string;
  evidenceNodeId: string;
  evidenceResultDigest: string;
}>;

export type MechanicalEvidenceOutput = Readonly<{
  schemaVersion: 1;
  kind: 'task-mechanical-transformation-closure.v1';
  candidateTree: string;
  candidateTreeDigest: string;
  changedPaths: readonly string[];
  scannedPathCount: number;
  scannedBlobBytes: number;
  oldTermHits: readonly MechanicalTermHit[];
  replacementTermHits: readonly MechanicalTermHit[];
  retainedDispositions: readonly TransformationRetainedDisposition[];
  projectionDigest: string;
  verdict: 'exact-byte-closure-satisfied';
}>;

export function evaluateMechanicalClosure(
  entries: readonly TrackedTreeEntry[],
  candidateTree: string,
  treeDigest: string,
  changedPaths: readonly string[],
  task: MechanicalTransformExecution,
  mutationPolicy: ReturnType<typeof deriveReviewedMutationClassPolicy>,
): Omit<MechanicalEvidenceOutput, 'projectionDigest'> {
  // Exact closure is observational authority, not mutation authority. Scan
  // every tracked candidate entry; fileScopes and allowedPaths still bound the
  // deterministic projection and the bytes the task may change.
  const closureEntries = [...entries];
  assertScannableEntries(closureEntries);

  const oldTermHits = scanTerms(
    closureEntries,
    task.transformationContract.oldTerms,
    mutationPolicy,
  );
  const replacementTermHits = scanTerms(
    closureEntries,
    task.transformationContract.replacementTerms,
    mutationPolicy,
  );
  const retained = new Map(
    task.transformationContract.retainedDispositions.map((disposition) => [
      retainedDispositionKey(disposition),
      disposition,
    ]),
  );
  const consumedRetained = new Set<string>();
  for (const hit of oldTermHits) {
    if (LIVE_CLOSURE_CLASSES.has(hit.mutationClass)) {
      throw workflowError(
        'TASK_MECHANICAL_TRANSFORMATION_LIVE_TERM_REMAINS',
        'The prospective candidate tree still contains an old term in the governed live closure.',
        ExitCode.verification,
        {
          details: {
            term: hit.term,
            path: hit.path,
            mutationClass: hit.mutationClass,
            occurrenceCount: hit.occurrenceCount,
          },
        },
      );
    }
    if (!RETAINED_CLASSES.has(hit.mutationClass)) {
      throw evidenceCorrupt();
    }
    const key = retainedDispositionKey({
      term: hit.term,
      path: hit.path,
      mutationClass: hit.mutationClass,
      reason: 'ignored-for-key',
    } as TransformationRetainedDisposition);
    if (!retained.has(key)) {
      throw workflowError(
        'TASK_MECHANICAL_TRANSFORMATION_RETAINED_DISPOSITION_REQUIRED',
        'An old term remains in a retained mutation class without an exact reviewed disposition.',
        ExitCode.verification,
        {
          details: {
            term: hit.term,
            path: hit.path,
            mutationClass: hit.mutationClass,
          },
        },
      );
    }
    consumedRetained.add(key);
  }
  const unusedDispositions = [...retained.keys()].filter(
    (key) => !consumedRetained.has(key),
  );
  if (unusedDispositions.length > 0) {
    throw workflowError(
      'TASK_MECHANICAL_TRANSFORMATION_RETAINED_DISPOSITION_INVALID',
      'A reviewed retained-term disposition does not match an actual candidate-tree occurrence.',
      ExitCode.verification,
      { details: { unusedDispositionKeys: unusedDispositions.sort() } },
    );
  }
  for (const replacement of task.transformationContract.replacementTerms) {
    if (
      !replacementTermHits.some(
        (hit) =>
          canonicalJson(hit.term) === canonicalJson(replacement) &&
          LIVE_CLOSURE_CLASSES.has(hit.mutationClass),
      )
    ) {
      throw workflowError(
        'TASK_MECHANICAL_TRANSFORMATION_REPLACEMENT_TERM_MISSING',
        'The prospective candidate tree does not contain every reviewed replacement term.',
        ExitCode.verification,
        { details: { replacement } },
      );
    }
  }
  return {
    schemaVersion: 1,
    kind: 'task-mechanical-transformation-closure.v1',
    candidateTree,
    candidateTreeDigest: treeDigest,
    changedPaths: [...changedPaths],
    scannedPathCount: closureEntries.length,
    scannedBlobBytes: closureEntries.reduce(
      (sum, entry) => sum + (entry.byteSize ?? 0),
      0,
    ),
    oldTermHits,
    replacementTermHits,
    retainedDispositions: task.transformationContract.retainedDispositions,
    verdict: 'exact-byte-closure-satisfied',
  };
}

export function assertDeterministicMechanicalProjection(
  baselineEntries: readonly TrackedTreeEntry[],
  candidateEntries: readonly TrackedTreeEntry[],
  task: MechanicalTransformExecution,
  mutationPolicy: ReturnType<typeof deriveReviewedMutationClassPolicy>,
): string {
  const scopedBaseline = scopedEntriesForTask(baselineEntries, task);
  const scopedCandidate = scopedEntriesForTask(candidateEntries, task);
  assertScannableEntries(scopedBaseline);
  assertScannableEntries(scopedCandidate);
  const candidateByPath = new Map(
    scopedCandidate.map((entry) => [entry.path.utf8!, entry]),
  );
  const expectedPaths = new Set<string>();
  const expectedProjection: Array<{
    path: string;
    mode: string;
    contentSha256: string;
  }> = [];

  for (const baseline of scopedBaseline) {
    const mutationClass = classifyMutationPath(
      mutationPolicy,
      baseline.path,
    ).mutationClass;
    const retained = RETAINED_CLASSES.has(mutationClass);
    const expectedPath = retained
      ? baseline.path.utf8!
      : transformedPath(
          baseline.path.utf8!,
          task.transformationContract.oldTerms,
          task.transformationContract.replacementTerms,
        );
    if (
      expectedPaths.has(expectedPath) ||
      !task.transformationContract.fileScopes.some((scope) =>
        matchesAllowedPath(expectedPath, scope),
      )
    ) {
      throw projectionMismatch(
        'The deterministic path mapping collides or escapes its reviewed scope.',
        { baselinePath: baseline.path.utf8, expectedPath },
      );
    }
    expectedPaths.add(expectedPath);
    const expectedContent = retained
      ? baseline.content!
      : simultaneousReplace(
          baseline.content!,
          contentReplacements(
            task.transformationContract.oldTerms,
            task.transformationContract.replacementTerms,
          ),
        );
    const candidate = candidateByPath.get(expectedPath);
    if (
      candidate === undefined ||
      candidate.mode !== baseline.mode ||
      !candidate.content!.equals(expectedContent)
    ) {
      throw projectionMismatch(
        'The prospective candidate is not the exact deterministic projection of the baseline scoped bytes.',
        {
          baselinePath: baseline.path.utf8,
          expectedPath,
          candidatePresent: candidate !== undefined,
        },
      );
    }
    expectedProjection.push({
      path: expectedPath,
      mode: baseline.mode,
      contentSha256: sha256(expectedContent),
    });
  }
  const extraCandidatePaths = [...candidateByPath.keys()].filter(
    (candidatePath) => !expectedPaths.has(candidatePath),
  );
  if (extraCandidatePaths.length > 0) {
    throw projectionMismatch(
      'The prospective candidate introduces files that are not produced by the deterministic transformation.',
      { extraCandidatePaths: extraCandidatePaths.sort() },
    );
  }
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      entries: expectedProjection.sort((left, right) =>
        left.path.localeCompare(right.path),
      ),
    }),
  );
}

function scopedEntriesForTask(
  entries: readonly TrackedTreeEntry[],
  task: MechanicalTransformExecution,
): TrackedTreeEntry[] {
  return entries.filter(
    (entry) =>
      entry.path.utf8 !== null &&
      task.transformationContract.fileScopes.some((scope) =>
        matchesAllowedPath(entry.path.utf8!, scope),
      ),
  );
}

function assertScannableEntries(entries: readonly TrackedTreeEntry[]): void {
  for (const entry of entries) {
    if (entry.skipReason !== undefined || entry.content === undefined) {
      throw workflowError(
        'TASK_MECHANICAL_TRANSFORMATION_SCAN_INCOMPLETE',
        'Mechanical transformation closure cannot skip a governed candidate-tree entry.',
        ExitCode.verification,
        {
          details: {
            path: entry.path.utf8,
            skipReason: entry.skipReason ?? 'missing-content',
          },
        },
      );
    }
  }
}

function transformedPath(
  baselinePath: string,
  oldTerms: readonly TransformationTerm[],
  replacementTerms: readonly TransformationTerm[],
): string {
  const transformed = simultaneousReplace(
    Buffer.from(baselinePath),
    oldTerms.flatMap((term, index) =>
      term.kind === 'path'
        ? [
            {
              before: Buffer.from(term.value),
              after: Buffer.from(replacementTerms[index]!.value),
            },
          ]
        : [],
    ),
  ).toString('utf8');
  try {
    return normalizeChangedPath(transformed);
  } catch {
    throw projectionMismatch(
      'The deterministic path transformation produced an unsafe repository path.',
      { baselinePath, transformedPath: transformed },
    );
  }
}

function contentReplacements(
  oldTerms: readonly TransformationTerm[],
  replacementTerms: readonly TransformationTerm[],
): Array<{ before: Buffer; after: Buffer }> {
  return oldTerms.flatMap((term, index) =>
    term.kind === 'path'
      ? []
      : [
          {
            before: Buffer.from(term.value),
            after: Buffer.from(replacementTerms[index]!.value),
          },
        ],
  );
}

function simultaneousReplace(
  source: Buffer,
  replacements: readonly { before: Buffer; after: Buffer }[],
): Buffer {
  if (replacements.length === 0) return Buffer.from(source);
  const ordered = [...replacements].sort(
    (left, right) =>
      right.before.length - left.before.length ||
      Buffer.compare(left.before, right.before),
  );
  const chunks: Buffer[] = [];
  let literalStart = 0;
  let cursor = 0;
  while (cursor < source.length) {
    const match = ordered.find(
      ({ before }) =>
        cursor + before.length <= source.length &&
        source.subarray(cursor, cursor + before.length).equals(before),
    );
    if (match === undefined) {
      cursor += 1;
      continue;
    }
    chunks.push(source.subarray(literalStart, cursor), match.after);
    cursor += match.before.length;
    literalStart = cursor;
  }
  chunks.push(source.subarray(literalStart));
  return Buffer.concat(chunks);
}

function scanTerms(
  entries: readonly TrackedTreeEntry[],
  terms: readonly TransformationTerm[],
  mutationPolicy: ReturnType<typeof deriveReviewedMutationClassPolicy>,
): MechanicalTermHit[] {
  const hits: MechanicalTermHit[] = [];
  for (const entry of entries) {
    const pathValue = entry.path.utf8!;
    const mutationClass = classifyMutationPath(
      mutationPolicy,
      entry.path,
    ).mutationClass;
    for (const term of terms) {
      const haystack =
        term.kind === 'path'
          ? Buffer.from(entry.path.rawBase64, 'base64')
          : entry.content!;
      const occurrence = exactByteOccurrenceSummary(
        haystack,
        Buffer.from(term.value),
        term.kind === 'path' ? 'path' : 'content',
      );
      if (occurrence.count === 0) continue;
      hits.push({
        term,
        path: pathValue,
        mutationClass,
        occurrenceCount: occurrence.count,
        locationsDigest: occurrence.locationsDigest,
      });
    }
  }
  return hits.sort((left, right) =>
    canonicalJson(left).localeCompare(canonicalJson(right)),
  );
}

function exactByteOccurrenceSummary(
  haystack: Buffer,
  needle: Buffer,
  surface: 'path' | 'content',
): { count: number; locationsDigest: string } {
  const digest = crypto.createHash('sha256');
  digest.update(`task-mechanical-transform-locations.v1\0${surface}\0`);
  let count = 0;
  for (let cursor = 0; cursor <= haystack.length - needle.length;) {
    const offset = haystack.indexOf(needle, cursor);
    if (offset < 0) break;
    const encoded = Buffer.allocUnsafe(8);
    encoded.writeBigUInt64BE(BigInt(offset));
    digest.update(encoded);
    count += 1;
    cursor = offset + 1;
  }
  return { count, locationsDigest: digest.digest('hex') };
}

export function assertChangedPathsInMechanicalScope(
  inspection: SessionInspection,
  task: MechanicalTransformExecution,
): void {
  const outside = inspection.changedPaths.filter(
    (changedPath) =>
      !task.transformationContract.fileScopes.some((scope) =>
        matchesAllowedPath(changedPath, scope),
      ),
  );
  if (outside.length > 0) {
    throw workflowError(
      'TASK_MECHANICAL_TRANSFORMATION_SCOPE_INVALID',
      'Mechanical-transform candidate paths exceed the reviewed transformation scope.',
      ExitCode.verification,
      { details: { outsidePaths: outside } },
    );
  }
}

export function assertEvidenceNodeCurrent(
  node: EvidenceNode,
  record: TaskMechanicalTransformationEvidenceRecord,
  task: MechanicalTransformExecution,
): void {
  const output = parseEvidenceOutput(node.output);
  const oldTermSet = new Set(
    task.transformationContract.oldTerms.map((term) => canonicalJson(term)),
  );
  const replacementTermSet = new Set(
    task.transformationContract.replacementTerms.map((term) =>
      canonicalJson(term),
    ),
  );
  if (
    node.type !== 'task-mechanical-transformation-closure' ||
    node.nodeSchema !== 'workflow.task-mechanical-transformation-closure.v1' ||
    node.evaluator !== 'workflow-task-mechanical-transform.v1' ||
    node.policyDigest !== TASK_MECHANICAL_TRANSFORM_POLICY_DIGEST ||
    node.outputSchema !== 'workflow.task-mechanical-transformation-output.v1' ||
    node.nodeId !== record.evidenceNodeId ||
    node.resultDigest !== record.evidenceResultDigest ||
    node.exactInputDigests.baseline !==
      sha256(canonicalJson(record.baseline)) ||
    node.exactInputDigests.candidateTree !== sha256(record.candidateTree) ||
    node.exactInputDigests.candidateTreeDigest !== record.candidateTreeDigest ||
    node.exactInputDigests.changedPaths !==
      sha256(canonicalJson(record.changedPaths)) ||
    node.exactInputDigests.taskContract !== record.taskContractDigest ||
    node.exactInputDigests.transformationContract !==
      record.transformationContractDigest ||
    node.exactInputDigests.mutationPolicy !== record.mutationPolicyDigest ||
    !hasExactKeys(node.exactInputDigests, [
      'baseline',
      'candidateTree',
      'candidateTreeDigest',
      'changedPaths',
      'mutationPolicy',
      'taskContract',
      'transformationContract',
    ]) ||
    Object.keys(node.semanticParentResultDigests).length !== 0 ||
    Object.keys(node.provenanceParentNodeIds).length !== 0 ||
    Object.keys(node.runtimeMetadata).length !== 0 ||
    output.candidateTree !== record.candidateTree ||
    output.candidateTreeDigest !== record.candidateTreeDigest ||
    canonicalJson(output.changedPaths) !== canonicalJson(record.changedPaths) ||
    canonicalJson(output.retainedDispositions) !==
      canonicalJson(task.transformationContract.retainedDispositions) ||
    output.oldTermHits.some(
      (hit) =>
        !oldTermSet.has(canonicalJson(hit.term)) ||
        !RETAINED_CLASSES.has(hit.mutationClass),
    ) ||
    output.replacementTermHits.some(
      (hit) => !replacementTermSet.has(canonicalJson(hit.term)),
    )
  ) {
    throw evidenceStale();
  }
}

function parseEvidenceOutput(value: unknown): MechanicalEvidenceOutput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'candidateTree',
      'candidateTreeDigest',
      'changedPaths',
      'kind',
      'oldTermHits',
      'projectionDigest',
      'replacementTermHits',
      'retainedDispositions',
      'scannedBlobBytes',
      'scannedPathCount',
      'schemaVersion',
      'verdict',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-mechanical-transformation-closure.v1' ||
    !GIT_OBJECT.test(String(value.candidateTree)) ||
    !DIGEST.test(String(value.candidateTreeDigest)) ||
    !isSortedStringArray(value.changedPaths) ||
    !Number.isSafeInteger(value.scannedPathCount) ||
    Number(value.scannedPathCount) < 0 ||
    !Number.isSafeInteger(value.scannedBlobBytes) ||
    Number(value.scannedBlobBytes) < 0 ||
    !isCanonicalHitArray(value.oldTermHits) ||
    !isCanonicalHitArray(value.replacementTermHits) ||
    !Array.isArray(value.retainedDispositions) ||
    !DIGEST.test(String(value.projectionDigest)) ||
    value.verdict !== 'exact-byte-closure-satisfied'
  ) {
    throw evidenceCorrupt();
  }
  return value as unknown as MechanicalEvidenceOutput;
}

function isCanonicalHitArray(value: unknown): value is MechanicalTermHit[] {
  if (!Array.isArray(value)) return false;
  const canonical: string[] = [];
  for (const hit of value) {
    if (
      !isRecord(hit) ||
      !hasExactKeys(hit, [
        'locationsDigest',
        'mutationClass',
        'occurrenceCount',
        'path',
        'term',
      ]) ||
      !isTransformationTerm(hit.term) ||
      typeof hit.path !== 'string' ||
      !isExactRepositoryPath(hit.path) ||
      !MUTATION_CLASS_VALUES.has(hit.mutationClass as MutationClass) ||
      !Number.isSafeInteger(hit.occurrenceCount) ||
      Number(hit.occurrenceCount) <= 0 ||
      !DIGEST.test(String(hit.locationsDigest))
    ) {
      return false;
    }
    canonical.push(canonicalJson(hit));
  }
  return canonical.every(
    (entry, index) => index === 0 || canonical[index - 1]! < entry,
  );
}

function isTransformationTerm(value: unknown): value is TransformationTerm {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['kind', 'value']) &&
    ['path', 'content', 'symbol', 'config'].includes(String(value.kind)) &&
    typeof value.value === 'string' &&
    value.value.length > 0
  );
}

function isExactRepositoryPath(value: string): boolean {
  try {
    return normalizeChangedPath(value) === value;
  } catch {
    return false;
  }
}

export function parseEvidenceRecord(
  value: unknown,
): TaskMechanicalTransformationEvidenceRecord {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'baseline',
      'candidateTree',
      'candidateTreeDigest',
      'changeId',
      'changedPaths',
      'evidenceNodeId',
      'evidenceResultDigest',
      'kind',
      'mutationPolicyDigest',
      'recordDigest',
      'schemaVersion',
      'sessionId',
      'taskContractDigest',
      'taskId',
      'transformationContractDigest',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'task-mechanical-transformation-evidence.v1' ||
    typeof value.sessionId !== 'string' ||
    typeof value.changeId !== 'string' ||
    typeof value.taskId !== 'string' ||
    !isBaseline(value.baseline) ||
    !GIT_OBJECT.test(String(value.candidateTree)) ||
    !DIGEST.test(String(value.candidateTreeDigest)) ||
    !isSortedStringArray(value.changedPaths) ||
    !DIGEST.test(String(value.taskContractDigest)) ||
    !DIGEST.test(String(value.transformationContractDigest)) ||
    !DIGEST.test(String(value.mutationPolicyDigest)) ||
    !DIGEST.test(String(value.evidenceNodeId)) ||
    !DIGEST.test(String(value.evidenceResultDigest)) ||
    !DIGEST.test(String(value.recordDigest))
  ) {
    throw evidenceCorrupt();
  }
  const record = value as unknown as TaskMechanicalTransformationEvidenceRecord;
  if (
    record.recordDigest !==
    sha256(
      canonicalJson({
        schemaVersion: record.schemaVersion,
        kind: record.kind,
        sessionId: record.sessionId,
        changeId: record.changeId,
        taskId: record.taskId,
        baseline: record.baseline,
        candidateTree: record.candidateTree,
        candidateTreeDigest: record.candidateTreeDigest,
        changedPaths: record.changedPaths,
        taskContractDigest: record.taskContractDigest,
        transformationContractDigest: record.transformationContractDigest,
        mutationPolicyDigest: record.mutationPolicyDigest,
        evidenceNodeId: record.evidenceNodeId,
        evidenceResultDigest: record.evidenceResultDigest,
      }),
    )
  ) {
    throw evidenceCorrupt();
  }
  return record;
}

export function mechanicalTask(
  inspection: SessionInspection,
): MechanicalTransformExecution | null {
  const task = inspection.contract.execution?.tasks[inspection.session.taskId];
  return task?.strategy === 'mechanical-transform' ? task : null;
}

function retainedDispositionKey(
  disposition: TransformationRetainedDisposition,
): string {
  return canonicalJson({
    term: disposition.term,
    path: disposition.path,
    mutationClass: disposition.mutationClass,
  });
}

function isBaseline(value: unknown): value is { head: string; tree: string } {
  return (
    isRecord(value) &&
    hasExactKeys(value, ['head', 'tree']) &&
    GIT_OBJECT.test(String(value.head)) &&
    GIT_OBJECT.test(String(value.tree))
  );
}

function isSortedStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === 'string') &&
    value.every((entry, index) => index === 0 || value[index - 1]! < entry)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  return (
    actual.length === required.length &&
    actual.every((key, index) => key === required[index])
  );
}

export function sha256(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function evidenceCorrupt() {
  return workflowError(
    'TASK_MECHANICAL_TRANSFORMATION_EVIDENCE_CORRUPT',
    'Mechanical-transform evidence is malformed or does not match its immutable engine node.',
    ExitCode.guard,
  );
}

export function evidenceStale() {
  return workflowError(
    'TASK_MECHANICAL_TRANSFORMATION_EVIDENCE_STALE',
    'Mechanical-transform evidence does not cover the exact current candidate tree and task contract.',
    ExitCode.staleState,
  );
}

function projectionMismatch(message: string, details: Record<string, unknown>) {
  return workflowError(
    'TASK_MECHANICAL_TRANSFORMATION_PROJECTION_MISMATCH',
    message,
    ExitCode.verification,
    { details },
  );
}
