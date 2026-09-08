/**
 * Reads proposal artifacts and snapshots and reconciles authenticated planning files.
 *
 * Invariants:
 * - Caller JSON reads are bounded and reject changing files or symbolic links.
 * - Reconciliation accepts only authenticated old or next artifact bytes.
 * - Temporary reclamation verifies file identity and refuses live owners.
 * - Snapshot reads preserve the manifest's exact bytes, digests, and membership.
 *
 * Depends on: planning snapshots, plan-digest projection, repository paths, and the filesystem.
 * Failure modes: unsafe input, planning conflicts, or stale materialization errors.
 */
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  normalizeExactRepositoryPath,
  normalizePolicyPath,
} from '../../foundation/repository-path/repository-path.ts';
import {
  planReviewSnapshotLineCount,
  type PlanReviewTargetSnapshotArtifact,
} from '../../modules/assurance/plan-review.ts';
import {
  projectWorkflowPlanDigest,
  type WorkflowPlanDigest,
  type WorkflowPlanDigestTouchedFile,
} from '../../modules/guidance/renderers/plan-digest.ts';
import {
  isRecord,
  MAX_CALLER_JSON_BYTES,
  planningMaterializationStale,
  sha256,
} from './propose-common.ts';

const ATOMIC_TEXT_TEMP_SUFFIX =
  /^([1-9][0-9]*)\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.tmp$/;

export function reclaimReviewerReconciliationTemporaries(
  changeDirectory: string,
  oldArtifacts: Map<string, string>,
  nextArtifacts: Map<string, string>,
): void {
  const reclaimable: Array<{
    path: string;
    stats: fs.Stats;
    ownerPid: number;
  }> = [];
  for (const basename of ['design.md', 'investigation.json']) {
    const oldContent = oldArtifacts.get(basename);
    const nextContent = nextArtifacts.get(basename);
    if (oldContent === undefined || nextContent === undefined) {
      throw planningMaterializationStale(
        'Reviewer-term reconciliation lost authenticated temporary content.',
      );
    }
    const oldBytes = Buffer.from(oldContent, 'utf8');
    const nextBytes = Buffer.from(nextContent, 'utf8');
    const prefix = `${basename}.`;
    for (const name of fs.readdirSync(changeDirectory).sort()) {
      if (!name.startsWith(prefix)) {
        continue;
      }
      const match = ATOMIC_TEXT_TEMP_SUFFIX.exec(name.slice(prefix.length));
      if (!match) {
        continue;
      }
      const ownerPid = Number(match[1]);
      if (!Number.isSafeInteger(ownerPid) || ownerPid < 1) {
        throw planningMaterializationStale(
          'Reviewer-term reconciliation found an unsafe atomic replacement temporary.',
        );
      }
      const temporaryPath = path.join(changeDirectory, name);
      const before = fs.lstatSync(temporaryPath, {
        throwIfNoEntry: false,
      });
      if (
        !before ||
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o644
      ) {
        throw planningMaterializationStale(
          'Reviewer-term reconciliation found an unsafe atomic replacement temporary.',
        );
      }
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(
          temporaryPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        const opened = fs.fstatSync(descriptor);
        const content = fs.readFileSync(descriptor);
        const after = fs.lstatSync(temporaryPath, {
          throwIfNoEntry: false,
        });
        if (
          !after ||
          !after.isFile() ||
          after.isSymbolicLink() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          after.dev !== before.dev ||
          after.ino !== before.ino ||
          opened.nlink !== 1 ||
          after.nlink !== 1 ||
          (opened.mode & 0o777) !== 0o644 ||
          (after.mode & 0o777) !== 0o644 ||
          opened.size !== before.size ||
          after.size !== before.size ||
          opened.mtimeMs !== before.mtimeMs ||
          after.mtimeMs !== before.mtimeMs ||
          opened.ctimeMs !== before.ctimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          content.byteLength !== before.size ||
          reviewerReconciliationTemporaryOwnerIsAlive(ownerPid) ||
          !isReviewerReconciliationTemporaryPrefix(content, oldBytes, nextBytes)
        ) {
          throw planningMaterializationStale(
            'Reviewer-term reconciliation found an unsafe atomic replacement temporary.',
          );
        }
      } catch (error) {
        if (
          isRecord(error) &&
          error.code === 'PLANNING_MATERIALIZATION_STALE'
        ) {
          throw error;
        }
        throw planningMaterializationStale(
          'Reviewer-term reconciliation could not inspect an atomic replacement temporary.',
        );
      } finally {
        if (descriptor !== undefined) {
          fs.closeSync(descriptor);
        }
      }
      reclaimable.push({ path: temporaryPath, stats: before, ownerPid });
    }
  }
  let removed = false;
  for (const entry of reclaimable) {
    const current = fs.lstatSync(entry.path, { throwIfNoEntry: false });
    if (!current) {
      continue;
    }
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.nlink !== 1 ||
      (current.mode & 0o777) !== 0o644 ||
      current.dev !== entry.stats.dev ||
      current.ino !== entry.stats.ino ||
      reviewerReconciliationTemporaryOwnerIsAlive(entry.ownerPid)
    ) {
      throw planningMaterializationStale(
        'Reviewer-term reconciliation atomic replacement temporary changed before reclamation.',
      );
    }
    fs.unlinkSync(entry.path);
    removed = true;
  }
  if (removed) {
    fsyncReviewerReconciliationDirectory(changeDirectory);
  }
}

function isReviewerReconciliationTemporaryPrefix(
  content: Buffer,
  oldContent: Buffer,
  nextContent: Buffer,
): boolean {
  return (
    (content.byteLength <= oldContent.byteLength &&
      oldContent.subarray(0, content.byteLength).equals(content)) ||
    (content.byteLength <= nextContent.byteLength &&
      nextContent.subarray(0, content.byteLength).equals(content))
  );
}

function reviewerReconciliationTemporaryOwnerIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !isRecord(error) || error.code !== 'ESRCH';
  }
}

export function fsyncReviewerReconciliationDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    if (!fs.fstatSync(descriptor).isDirectory()) {
      throw planningMaterializationStale(
        'Reviewer-term reconciliation change directory is unsafe.',
      );
    }
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function assertReviewerReconciliationLiveArtifacts(
  changeDirectory: string,
  oldArtifacts: Record<string, string>,
  nextArtifacts: Record<string, string>,
): Map<string, { digest: string; text: string }> {
  if (
    canonicalJson(Object.keys(oldArtifacts).sort()) !==
    canonicalJson(Object.keys(nextArtifacts).sort())
  ) {
    throw planningMaterializationStale(
      'Reviewer-term reconciliation artifact membership changed.',
    );
  }
  const observed = new Map<string, { digest: string; text: string }>();
  for (const relativePath of Object.keys(oldArtifacts).sort()) {
    const normalized = normalizePolicyPath(relativePath);
    if (normalized !== relativePath) {
      throw planningMaterializationStale(
        'Reviewer-term reconciliation found a non-canonical artifact path.',
      );
    }
    const target = path.join(changeDirectory, normalized);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o644
    ) {
      throw planningMaterializationStale(
        'Reviewer-term reconciliation found an unsafe planning artifact.',
      );
    }
    const content = fs.readFileSync(target);
    const text = content.toString('utf8');
    const digest = sha256(content);
    if (
      !Buffer.from(text, 'utf8').equals(content) ||
      (digest !== oldArtifacts[relativePath] &&
        digest !== nextArtifacts[relativePath])
    ) {
      throw planningMaterializationStale(
        'Planning bytes contain neither the authenticated old nor exact next materialization.',
      );
    }
    observed.set(relativePath, { digest, text });
  }
  return observed;
}

export function readCallerJson(cwd: string, requestedPath: string): unknown {
  const filePath = path.resolve(cwd, requestedPath);
  let descriptor: number | undefined;
  try {
    const before = fs.lstatSync(filePath);
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      before.size > MAX_CALLER_JSON_BYTES
    ) {
      throw new Error('unsafe caller input');
    }
    descriptor = fs.openSync(
      filePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      throw new Error('caller input changed');
    }
    const bytes = fs.readFileSync(descriptor);
    const verification = Buffer.alloc(bytes.length);
    const verificationBytes = fs.readSync(
      descriptor,
      verification,
      0,
      verification.length,
      0,
    );
    const after = fs.lstatSync(filePath);
    const finalOpened = fs.fstatSync(descriptor);
    if (
      verificationBytes !== bytes.length ||
      !verification.equals(bytes) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      finalOpened.size !== before.size
    ) {
      throw new Error('caller input changed');
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text);
  } catch {
    throw workflowError(
      'PROPOSE_INPUT_FILE_INVALID',
      'Unable to read a bounded canonical caller input file safely.',
      ExitCode.usage,
    );
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

export function listChangeFiles(changeDirectory: string): string[] {
  if (!fs.existsSync(changeDirectory)) {
    return [];
  }
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink()) {
        throw workflowError(
          'UNMANAGED_PLANNING_CONFLICT',
          'Planning materialization refuses symbolic links.',
          ExitCode.conflict,
        );
      }
      if (stats.isDirectory()) {
        visit(absolute);
      } else if (stats.isFile()) {
        result.push(
          path.relative(changeDirectory, absolute).split(path.sep).join('/'),
        );
      } else {
        throw workflowError(
          'UNMANAGED_PLANNING_CONFLICT',
          'Planning materialization found a non-regular path.',
          ExitCode.conflict,
        );
      }
    }
  };
  visit(changeDirectory);
  return result.sort();
}

export function listSpecFiles(changeDirectory: string): string[] {
  return listChangeFiles(changeDirectory).filter(
    (relativePath) =>
      relativePath.startsWith('specs/') && relativePath.endsWith('/spec.md'),
  );
}

export function assertPlanningTargetsCompatible(
  changeDirectory: string,
  entries: Map<string, string>,
  scaffoldOnly: boolean,
  allowAuthoredExisting = false,
  allowManagedPlanReview = false,
  baselineReplaceable: (
    relativePath: string,
    existing: string,
  ) => boolean = () => false,
): void {
  // An amendment's prior generation is committed at the session baseline, so
  // "these exact bytes exist at the baseline" is the authority to tolerate or
  // replace them. Anything uncommitted stays a conflict.
  const pristineAtBaseline = (relativePath: string): boolean => {
    const target = path.join(changeDirectory, relativePath);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stats || !stats.isFile() || stats.isSymbolicLink()) {
      return false;
    }
    return baselineReplaceable(relativePath, fs.readFileSync(target, 'utf8'));
  };
  const allowedExisting = new Set(entries.keys());
  const existing = listChangeFiles(changeDirectory);
  for (const relativePath of existing) {
    if (!allowedExisting.has(relativePath)) {
      if (scaffoldOnly) {
        if (relativePath === 'plan-review.json' && allowManagedPlanReview) {
          continue;
        }
        if (pristineAtBaseline(relativePath)) {
          continue;
        }
        if (
          allowAuthoredExisting &&
          ([
            'proposal.md',
            'design.md',
            'tasks.md',
            'guard.json',
            'execution.json',
          ].includes(relativePath) ||
            relativePath.startsWith('specs/'))
        ) {
          continue;
        }
        throw workflowError(
          'UNMANAGED_PLANNING_CONFLICT',
          'A new investigation-first change already contains unmanaged planning bytes.',
          ExitCode.conflict,
          { details: { relativePath } },
        );
      }
      if (relativePath === 'plan-review.json') {
        if (allowManagedPlanReview || pristineAtBaseline(relativePath)) {
          continue;
        }
        throw workflowError(
          'PLAN_REVIEW_ALREADY_PRESENT',
          'Task 5.2 cannot adopt or replace a plan review.',
          ExitCode.conflict,
        );
      }
      if (!relativePath.startsWith('specs/')) {
        throw workflowError(
          'UNMANAGED_PLANNING_CONFLICT',
          'Planning materialization found an unexpected existing path.',
          ExitCode.conflict,
          { details: { relativePath } },
        );
      }
    }
  }
  for (const [relativePath, expected] of entries) {
    const target = path.join(changeDirectory, relativePath);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!stats) {
      continue;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw workflowError(
        'UNMANAGED_PLANNING_CONFLICT',
        'Existing planning bytes differ from the managed projection.',
        ExitCode.conflict,
      );
    }
    const existing = fs.readFileSync(target, 'utf8');
    if (existing !== expected && !baselineReplaceable(relativePath, existing)) {
      throw workflowError(
        'UNMANAGED_PLANNING_CONFLICT',
        'Existing planning bytes differ from the managed projection.',
        ExitCode.conflict,
      );
    }
  }
}

export function artifactDigests(
  entries: Map<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    [...entries.entries()]
      .map(([relativePath, content]) => [relativePath, sha256(content)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

export function readPlanReviewSnapshotContents(
  repositoryRoot: string,
  changePrefix: string,
  artifacts: Record<string, string>,
): Map<string, Buffer> {
  const snapshotContents = new Map<string, Buffer>();
  for (const [relativePath, expectedDigest] of Object.entries(artifacts).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    let normalizedRelativePath: string;
    try {
      normalizedRelativePath = normalizeExactRepositoryPath(relativePath);
    } catch {
      throw workflowError(
        'PLANNING_MATERIALIZATION_STALE',
        'Plan review materialization contains an unsafe artifact path.',
        ExitCode.staleState,
      );
    }
    if (normalizedRelativePath !== relativePath) {
      throw workflowError(
        'PLANNING_MATERIALIZATION_STALE',
        'Plan review materialization contains a non-canonical artifact path.',
        ExitCode.staleState,
      );
    }
    const target = path.join(
      repositoryRoot,
      changePrefix,
      normalizedRelativePath,
    );
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o644
    ) {
      throw workflowError(
        'PLANNING_MATERIALIZATION_STALE',
        `Plan review target ${relativePath} is not a plain 0644 planning artifact.`,
        ExitCode.staleState,
      );
    }
    const content = fs.readFileSync(target);
    if (sha256(content) !== expectedDigest) {
      throw workflowError(
        'PLANNING_MATERIALIZATION_STALE',
        'Plan review target bytes differ from materialization evidence.',
        ExitCode.staleState,
      );
    }
    snapshotContents.set(normalizedRelativePath, content);
  }
  return snapshotContents;
}

export function readPriorPlanReviewSnapshotContents(
  snapshotRoot: string,
  artifacts: readonly PlanReviewTargetSnapshotArtifact[],
): Array<{ snapshotFile: string; content: Buffer }> {
  return artifacts.map((artifact) => {
    const snapshotPath = path.join(snapshotRoot, artifact.snapshotFile);
    const stats = fs.lstatSync(snapshotPath, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw workflowError(
        'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
        'Failed PlanReview invocation has an unsafe target snapshot.',
        ExitCode.staleState,
      );
    }
    const content = fs.readFileSync(snapshotPath);
    if (
      content.byteLength !== artifact.byteLength ||
      sha256(content) !== artifact.sha256 ||
      planReviewSnapshotLineCount(content) !== artifact.lineCount
    ) {
      throw workflowError(
        'PLAN_REVIEW_TARGET_SNAPSHOT_INVALID',
        'Failed PlanReview invocation target snapshot no longer matches its manifest.',
        ExitCode.staleState,
      );
    }
    return {
      snapshotFile: artifact.snapshotFile,
      content,
    };
  });
}

export function readReviewerReconciliationSnapshotContents(
  snapshotRoot: string,
  changePrefix: string,
  snapshotArtifacts: readonly PlanReviewTargetSnapshotArtifact[],
  materializedArtifacts: Record<string, string>,
): Map<string, string> {
  const artifacts = new Map<string, string>();
  for (const artifact of snapshotArtifacts) {
    if (!artifact.path.startsWith(changePrefix)) {
      throw planningMaterializationStale(
        'Prior PlanReview snapshot contains an unrelated planning path.',
      );
    }
    const relativePath = artifact.path.slice(changePrefix.length);
    if (
      normalizeExactRepositoryPath(relativePath) !== relativePath ||
      artifacts.has(relativePath) ||
      materializedArtifacts[relativePath] !== artifact.sha256
    ) {
      throw planningMaterializationStale(
        'Prior PlanReview snapshot does not exactly cover the old materialization.',
      );
    }
    const content = fs.readFileSync(
      path.join(snapshotRoot, artifact.snapshotFile),
    );
    const text = content.toString('utf8');
    if (
      !Buffer.from(text, 'utf8').equals(content) ||
      content.byteLength !== artifact.byteLength ||
      sha256(content) !== artifact.sha256
    ) {
      throw planningMaterializationStale(
        'Prior PlanReview snapshot bytes are invalid or stale.',
      );
    }
    artifacts.set(relativePath, text);
  }
  if (
    canonicalJson([...artifacts.keys()].sort()) !==
    canonicalJson(Object.keys(materializedArtifacts).sort())
  ) {
    throw planningMaterializationStale(
      'Prior PlanReview snapshot membership differs from the old materialization.',
    );
  }
  return artifacts;
}

export function requiredPlanningArtifactPaths(hasSources: boolean): string[] {
  return [
    '.openspec.yaml',
    'investigation.json',
    'proposal.md',
    'design.md',
    'tasks.md',
    'guard.json',
    'execution.json',
    ...(hasSources ? ['origin.json'] : []),
  ];
}

export function assertRequiredPlanningArtifacts(
  changeDirectory: string,
  required: readonly string[],
  missingMessage: string,
): void {
  if (
    required.some(
      (relativePath) =>
        !fs
          .statSync(path.join(changeDirectory, relativePath), {
            throwIfNoEntry: false,
          })
          ?.isFile(),
    )
  ) {
    throw planningMaterializationStale(missingMessage);
  }
}

export function readMaterializedPlanningArtifactDigests(
  changeDirectory: string,
  required: readonly string[],
): Record<string, string> {
  const entries = new Map<string, string>();
  for (const relativePath of required) {
    entries.set(
      relativePath,
      fs.readFileSync(path.join(changeDirectory, relativePath), 'utf8'),
    );
  }
  for (const specPath of listSpecFiles(changeDirectory)) {
    entries.set(
      specPath,
      fs.readFileSync(path.join(changeDirectory, specPath), 'utf8'),
    );
  }
  assertPlanningTargetsCompatible(changeDirectory, entries, false, false, true);
  return artifactDigests(entries);
}

export function readPlanDigestFromArtifacts(
  changeDirectory: string,
  touchedFilesAndWhy: readonly WorkflowPlanDigestTouchedFile[],
): WorkflowPlanDigest {
  return projectWorkflowPlanDigest({
    proposal: fs.readFileSync(
      path.join(changeDirectory, 'proposal.md'),
      'utf8',
    ),
    design: fs.readFileSync(path.join(changeDirectory, 'design.md'), 'utf8'),
    touchedFilesAndWhy,
  });
}
