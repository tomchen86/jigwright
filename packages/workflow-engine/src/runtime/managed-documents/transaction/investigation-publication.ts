import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import {
  discoverRepository,
  fingerprintRepositoryProjection,
  type GitState,
} from '../../repository-transaction/git.ts';
import {
  createInvestigationV3Blocker,
  parseInvestigationV3Blocker,
  validateForAuthority,
  type InvestigationManifestV3,
  type InvestigationV3Blocker,
  type InvestigationV3FailureCode,
} from '../../../modules/investigation/manifest/investigation-manifest.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Publication roles are engine-owned lowercase-ASCII POSIX paths.
const PUBLICATION_PATH = /^[a-z0-9._/-]+$/u;

export type InvestigationManifestPublicationPaths = {
  manifestPath: string;
  currentRefPath: string;
  journalPath: string;
};

export type InvestigationManifestPublicationSnapshot = {
  repositoryId: string;
  changeId: string;
  investigationId: string;
  sessionRevision: number;
  sessionSnapshotDigest: string;
  currentRefDigest: string;
};

export type InvestigationManifestPublicationLifecycleIdentity = Omit<
  InvestigationManifestPublicationSnapshot,
  'currentRefDigest'
>;

export type InvestigationManifestPublicationPhase =
  | 'candidate-written'
  | 'journal-prepared'
  | 'manifest-installed'
  | 'current-ref-published'
  | 'journal-committed';

export type InvestigationManifestPublicationObservationSource =
  | {
      operation: 'publish' | 'inspect' | 'resume';
      paths: InvestigationManifestPublicationPaths;
    }
  | { operation: 'read-ref'; currentRefPath: string };

export type InvestigationManifestPublicationStateObservation = Readonly<{
  schemaVersion: 1;
  kind: 'investigation-manifest-publication-state';
  source: InvestigationManifestPublicationObservationSource;
  recoveryKind: 'none' | 'pre-ref' | 'post-ref' | 'committed' | 'blocked';
  artifacts: readonly Readonly<{
    path: string;
    state: 'unsafe' | 'missing' | 'file' | 'symlink' | 'directory' | 'other';
    contentSha256: string | null;
  }>[];
}>;

export function investigationManifestPublicationNamespace(
  identity: Pick<
    InvestigationManifestPublicationLifecycleIdentity,
    'repositoryId' | 'changeId' | 'investigationId'
  >,
): string {
  return `investigation-v3-publication/${digest({
    schema: 'investigation-manifest-publication-namespace.v1',
    repositoryId: identity.repositoryId,
    changeId: identity.changeId,
    investigationId: identity.investigationId,
  })}`;
}

export function investigationManifestPublicationSourceMatchesLifecycle(
  source: InvestigationManifestPublicationObservationSource,
  lifecycle: InvestigationManifestPublicationLifecycleIdentity,
): boolean {
  const namespace = investigationManifestPublicationNamespace(lifecycle);
  const marker = `${namespace}/`;
  const namespaceRoot = (candidate: string): string | null => {
    if (!isCanonicalPublicationRelativePath(candidate)) {
      return null;
    }
    const offset = candidate.indexOf(marker);
    if (offset < 0 || (offset > 0 && candidate[offset - 1] !== '/')) {
      return null;
    }
    return candidate.slice(0, offset + namespace.length);
  };
  if (source.operation === 'read-ref') {
    return namespaceRoot(source.currentRefPath) !== null;
  }

  const privateRoots = [
    namespaceRoot(source.paths.currentRefPath),
    namespaceRoot(source.paths.journalPath),
  ];
  if (
    privateRoots[0] === null ||
    privateRoots.some((root) => root !== privateRoots[0])
  ) {
    return false;
  }
  const manifestNamespaceRoot = namespaceRoot(source.paths.manifestPath);
  return (
    manifestNamespaceRoot === privateRoots[0] ||
    (isCanonicalPublicationRelativePath(source.paths.manifestPath) &&
      source.paths.manifestPath ===
        `openspec/changes/${lifecycle.changeId}/investigation.json`)
  );
}

export type InvestigationManifestPublicationFailure = Readonly<{
  schemaVersion: 1;
  kind: 'investigation-manifest-publication-failure';
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
  blocker: InvestigationV3Blocker;
  source: Readonly<{
    schemaVersion: 1;
    observation: InvestigationManifestPublicationObservationSource;
    failureIdentity: string;
    emittedPublicationStateDigest: `sha256:${string}`;
    emittedGitStateDigest: `sha256:${string}`;
    recoveryPolicy: 'central-grant' | 'idempotent-post-ref';
    emissionDigest: `sha256:${string}`;
  }>;
}>;

export function assertInvestigationManifestPublicationFailure(
  value: unknown,
): InvestigationManifestPublicationFailure {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'kind',
      'lifecycle',
      'blocker',
      'source',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'investigation-manifest-publication-failure' ||
    !isRecord(value.lifecycle) ||
    !hasExactKeys(value.lifecycle, [
      'repositoryId',
      'changeId',
      'investigationId',
      'sessionRevision',
      'sessionSnapshotDigest',
    ]) ||
    !isRecord(value.source) ||
    !hasExactKeys(value.source, [
      'schemaVersion',
      'observation',
      'failureIdentity',
      'emittedPublicationStateDigest',
      'emittedGitStateDigest',
      'recoveryPolicy',
      'emissionDigest',
    ]) ||
    value.source.schemaVersion !== 1 ||
    typeof value.source.failureIdentity !== 'string' ||
    !DIGEST.test(value.source.failureIdentity) ||
    typeof value.source.emittedPublicationStateDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.source.emittedPublicationStateDigest) ||
    typeof value.source.emittedGitStateDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.source.emittedGitStateDigest) ||
    (value.source.recoveryPolicy !== 'central-grant' &&
      value.source.recoveryPolicy !== 'idempotent-post-ref') ||
    typeof value.source.emissionDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.source.emissionDigest)
  ) {
    throw publicationFailureSourceInvalid(
      'Investigation v3 publication failure is malformed.',
    );
  }
  const lifecycle = assertPublicationFailureLifecycle(value.lifecycle);
  const blocker = parseInvestigationV3Blocker(value.blocker);
  const observation = assertPublicationObservationSource(
    value.source.observation,
  );
  if (
    !investigationManifestPublicationSourceMatchesLifecycle(
      observation,
      lifecycle,
    )
  ) {
    throw publicationFailureSourceInvalid(
      'Investigation v3 publication source is outside its lifecycle namespace.',
    );
  }
  const sourceWithoutEmission = {
    schemaVersion: 1 as const,
    observation,
    failureIdentity: value.source.failureIdentity,
    emittedPublicationStateDigest: value.source
      .emittedPublicationStateDigest as `sha256:${string}`,
    emittedGitStateDigest: value.source
      .emittedGitStateDigest as `sha256:${string}`,
    recoveryPolicy: value.source.recoveryPolicy as
      'central-grant' | 'idempotent-post-ref',
  };
  const parsed = deepFreeze({
    schemaVersion: 1 as const,
    kind: 'investigation-manifest-publication-failure' as const,
    lifecycle,
    blocker,
    source: {
      ...sourceWithoutEmission,
      emissionDigest: value.source.emissionDigest as `sha256:${string}`,
    },
  });
  if (
    parsed.source.failureIdentity !== parsed.blocker.failureIdentity ||
    investigationManifestPublicationFailureEmissionDigest({
      schemaVersion: parsed.schemaVersion,
      kind: parsed.kind,
      lifecycle: parsed.lifecycle,
      blocker: parsed.blocker,
      source: sourceWithoutEmission,
    }) !== parsed.source.emissionDigest
  ) {
    throw publicationFailureSourceInvalid(
      'Investigation v3 publication blocker and source do not match.',
    );
  }
  return parsed;
}

function assertPublicationFailureLifecycle(
  value: Record<string, unknown>,
): InvestigationManifestPublicationLifecycleIdentity {
  if (
    typeof value.repositoryId !== 'string' ||
    value.repositoryId.length === 0 ||
    value.repositoryId.trim() !== value.repositoryId ||
    Buffer.byteLength(value.repositoryId) > 256 ||
    /[\0\r\n]/.test(value.repositoryId) ||
    typeof value.changeId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.changeId) ||
    typeof value.investigationId !== 'string' ||
    !/^investigation-[a-zA-Z0-9-]+$/.test(value.investigationId) ||
    typeof value.sessionRevision !== 'number' ||
    !Number.isSafeInteger(value.sessionRevision) ||
    value.sessionRevision < 0 ||
    typeof value.sessionSnapshotDigest !== 'string' ||
    !DIGEST.test(value.sessionSnapshotDigest)
  ) {
    throw publicationFailureSourceInvalid(
      'Investigation v3 publication lifecycle is malformed.',
    );
  }
  return deepFreeze({
    repositoryId: value.repositoryId,
    changeId: value.changeId,
    investigationId: value.investigationId,
    sessionRevision: value.sessionRevision,
    sessionSnapshotDigest: value.sessionSnapshotDigest,
  });
}

function assertPublicationObservationSource(
  value: unknown,
): InvestigationManifestPublicationObservationSource {
  if (!isRecord(value) || typeof value.operation !== 'string') {
    throw publicationFailureSourceInvalid(
      'Investigation v3 publication observer input is malformed.',
    );
  }
  if (value.operation === 'read-ref') {
    if (
      !hasExactKeys(value, ['operation', 'currentRefPath']) ||
      !isBoundedPublicationPath(value.currentRefPath)
    ) {
      throw publicationFailureSourceInvalid(
        'Investigation v3 current-ref source is malformed.',
      );
    }
    return deepFreeze({
      operation: 'read-ref' as const,
      currentRefPath: value.currentRefPath,
    });
  }
  if (!['publish', 'inspect', 'resume'].includes(value.operation)) {
    throw publicationFailureSourceInvalid(
      'Investigation v3 publication operation is unknown.',
    );
  }
  if (!hasExactKeys(value, ['operation', 'paths']) || !isRecord(value.paths)) {
    throw publicationFailureSourceInvalid(
      'Investigation v3 publication paths are malformed.',
    );
  }
  if (
    !hasExactKeys(value.paths, [
      'manifestPath',
      'currentRefPath',
      'journalPath',
    ]) ||
    !isBoundedPublicationPath(value.paths.manifestPath) ||
    !isBoundedPublicationPath(value.paths.currentRefPath) ||
    !isBoundedPublicationPath(value.paths.journalPath)
  ) {
    throw publicationFailureSourceInvalid(
      'Investigation v3 publication paths are malformed.',
    );
  }
  return deepFreeze({
    operation: value.operation as 'publish' | 'inspect' | 'resume',
    paths: {
      manifestPath: value.paths.manifestPath,
      currentRefPath: value.paths.currentRefPath,
      journalPath: value.paths.journalPath,
    },
  });
}

function isBoundedPublicationPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 4_096 &&
    !/[\0\r\n]/.test(value)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function publicationFailureSourceInvalid(message: string) {
  return workflowError(
    'INVESTIGATION_V3_FAILURE_SOURCE_INVALID',
    message,
    ExitCode.guard,
  );
}

type WithTransitionLock = <T>(
  operation: (snapshot: InvestigationManifestPublicationSnapshot) => T,
) => T;

type CurrentManifestRef = {
  schemaVersion: 1;
  kind: 'investigation-manifest-current';
  repositoryId: string;
  changeId: string;
  investigationId: string;
  manifestDigest: string;
  investigationTargetDigest: string;
  manifestPath: string;
};

type PublicationJournal = {
  schemaVersion: 1;
  kind: 'investigation-manifest-publication';
  state: 'prepared' | 'committed';
  transactionId: string;
  paths: InvestigationManifestPublicationPaths & { candidatePath: string };
  expected: InvestigationManifestPublicationSnapshot;
  manifestDigest: string;
  investigationTargetDigest: string;
  manifest: InvestigationManifestV3;
  currentRef: CurrentManifestRef;
};

type PublicationResult =
  | {
      outcome: 'published';
      manifestDigest: string;
      investigationTargetDigest: string;
      transactionId: string;
    }
  | {
      outcome: 'blocked';
      blocker: InvestigationV3Blocker;
      failure: InvestigationManifestPublicationFailure;
    };

/**
 * Low-level, lock-scoped Manifest publication transaction. It neither requests
 * nor consumes a human grant. Once the central transition registry exists, a
 * registered transition definition is the only authority surface that may
 * invoke this executor for a protected recovery choice.
 */
export function publishInvestigationManifestV3(input: {
  repositoryRoot: string;
  privateRoot?: string;
  paths: InvestigationManifestPublicationPaths;
  manifest: InvestigationManifestV3;
  expected: InvestigationManifestPublicationSnapshot;
  withTransitionLock: WithTransitionLock;
  observePhase?: (phase: InvestigationManifestPublicationPhase) => void;
}): PublicationResult {
  let mutationPhase: InvestigationManifestPublicationPhase | null = null;
  let failureCandidate: unknown = {
    paths: input.paths,
    expected: input.expected,
    manifestDigest: input.manifest.manifestDigest,
  };
  try {
    assertPublicationSourceLifecycleBinding(
      { operation: 'publish', paths: input.paths },
      lifecycleIdentity(input.expected),
    );
    const paths = normalizePaths(
      input.repositoryRoot,
      input.privateRoot,
      input.paths,
    );
    const validated = validateForAuthority({
      repositoryRoot: input.repositoryRoot,
      manifest: input.manifest,
      expected: authorityExpected(input.expected),
    });
    if (validated.outcome !== 'verified') {
      return publicationBlockedWithCode({
        repositoryRoot: input.repositoryRoot,
        privateRoot: input.privateRoot,
        lifecycle: lifecycleIdentity(input.expected),
        source: { operation: 'publish', paths: input.paths },
        candidate: {
          expected: input.expected,
          manifestDigest: input.manifest.manifestDigest,
          validationFailureIdentity: validated.blocker.failureIdentity,
        },
        failureCode: validated.blocker.failureCode,
        message: 'Manifest failed authority validation before publication.',
      });
    }

    const currentRef = currentRefFor(input.paths.manifestPath, input.manifest);
    const transactionId = digest({
      schema: 'investigation-manifest-publication-transaction.v1',
      expected: input.expected,
      currentRef,
    });
    const candidatePath = candidateRelativePath(input.paths, transactionId);
    const candidate = paths.repositoryAbsolute(candidatePath);
    assertPublicationRolePathsDistinct([
      paths.manifest,
      paths.currentRef,
      paths.journal,
      candidate,
    ]);
    const journal: PublicationJournal = {
      schemaVersion: 1,
      kind: 'investigation-manifest-publication',
      state: 'prepared',
      transactionId,
      paths: { ...input.paths, candidatePath },
      expected: structuredClone(input.expected),
      manifestDigest: input.manifest.manifestDigest,
      investigationTargetDigest:
        input.manifest.investigationApproval.investigationTargetDigest,
      manifest: structuredClone(input.manifest),
      currentRef,
    };
    failureCandidate = journal;
    return input.withTransitionLock((snapshot) => {
      assertSnapshot(snapshot, input.expected);
      if (
        publicationRefDigest(paths.privateRoot, input.paths.currentRefPath) !==
        input.expected.currentRefDigest
      ) {
        throw publicationFailure(
          'REVIEW_TARGET_STALE',
          'Current investigation authority ref changed before publication.',
        );
      }
      if (fs.existsSync(paths.journal)) {
        const prior = readJournal(
          paths.journal,
          input.paths,
          paths.privateRoot,
          paths.repositoryRoot,
        );
        if (prior.state === 'prepared') {
          throw publicationFailure(
            'PUBLICATION_RECOVERY_REQUIRED',
            'A prepared Manifest publication must resume before a replacement starts.',
          );
        }
        assertInstalledState(paths, prior);
      }
      assertManifestTargetPreservesCurrentAuthority(
        paths.currentRef,
        currentRef,
        paths.privateRoot,
      );
      mutationPhase = 'journal-prepared';
      writeCanonical(paths.journal, journal, paths.privateRoot);
      input.observePhase?.('journal-prepared');
      mutationPhase = 'candidate-written';
      writeCanonical(candidate, input.manifest, paths.repositoryRoot, 0o644);
      input.observePhase?.('candidate-written');
      mutationPhase = 'manifest-installed';
      installCandidate(candidate, paths.manifest, journal, paths);
      input.observePhase?.('manifest-installed');
      mutationPhase = 'current-ref-published';
      if (
        publicationRefDigest(paths.privateRoot, input.paths.currentRefPath) !==
        input.expected.currentRefDigest
      ) {
        throw publicationFailure(
          'REVIEW_TARGET_STALE',
          'Current investigation authority ref changed before CAS publication.',
        );
      }
      writeCanonical(paths.currentRef, currentRef, paths.privateRoot);
      input.observePhase?.('current-ref-published');
      mutationPhase = 'journal-committed';
      writeCanonical(
        paths.journal,
        { ...journal, state: 'committed' },
        paths.privateRoot,
      );
      input.observePhase?.('journal-committed');
      return publishedResult(journal);
    });
  } catch (error) {
    return publicationBlocked({
      repositoryRoot: input.repositoryRoot,
      privateRoot: input.privateRoot,
      lifecycle: lifecycleIdentity(input.expected),
      source: { operation: 'publish', paths: input.paths },
      candidate: failureCandidate,
      mutationPhase,
      error,
    });
  }
}

export function inspectInvestigationManifestPublication(input: {
  repositoryRoot: string;
  privateRoot?: string;
  paths: InvestigationManifestPublicationPaths;
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
}):
  | { outcome: 'none' }
  | {
      outcome: 'recoverable';
      transactionId: string;
      recoveryKind: 'pre-ref';
      manifestDigest: string;
      investigationTargetDigest: string;
      blocker: InvestigationV3Blocker;
      failure: InvestigationManifestPublicationFailure;
    }
  | {
      outcome: 'recoverable';
      transactionId: string;
      recoveryKind: 'post-ref';
      manifestDigest: string;
      investigationTargetDigest: string;
    }
  | {
      outcome: 'committed';
      transactionId: string;
      manifestDigest: string;
      investigationTargetDigest: string;
    }
  | {
      outcome: 'blocked';
      blocker: InvestigationV3Blocker;
      failure: InvestigationManifestPublicationFailure;
    } {
  try {
    assertPublicationSourceLifecycleBinding(
      { operation: 'inspect', paths: input.paths },
      input.lifecycle,
    );
    const paths = normalizePaths(
      input.repositoryRoot,
      input.privateRoot,
      input.paths,
    );
    if (!fs.existsSync(paths.journal)) {
      const candidate = validatedCandidateResidue(
        paths.repositoryRoot,
        paths.privateRoot,
        input.paths,
        input.lifecycle,
      );
      if (candidate === null) return { outcome: 'none' };
      return publicationBlockedWithCode({
        repositoryRoot: input.repositoryRoot,
        privateRoot: input.privateRoot,
        lifecycle: input.lifecycle,
        source: { operation: 'inspect', paths: input.paths },
        candidate: {
          paths: input.paths,
          candidatePath: candidate.candidatePath,
          transactionId: candidate.transactionId,
        },
        failureCode: 'PUBLICATION_RECOVERY_REQUIRED',
        message:
          'Manifest publication stopped after candidate creation and before its journal was durable.',
      });
    }
    const journal = readJournal(
      paths.journal,
      input.paths,
      paths.privateRoot,
      paths.repositoryRoot,
    );
    assertLifecycleIdentity(journal.expected, input.lifecycle);
    assertPublicationJournalRolePaths(paths, journal);
    if (journal.state === 'committed') {
      assertInstalledState(paths, journal);
      return {
        outcome: 'committed',
        transactionId: journal.transactionId,
        manifestDigest: journal.manifestDigest,
        investigationTargetDigest: journal.investigationTargetDigest,
      };
    }
    if (
      currentRefMatches(paths.currentRef, journal.currentRef, paths.privateRoot)
    ) {
      assertInstalledState(paths, journal);
      return {
        outcome: 'recoverable',
        transactionId: journal.transactionId,
        recoveryKind: 'post-ref',
        manifestDigest: journal.manifestDigest,
        investigationTargetDigest: journal.investigationTargetDigest,
      };
    }
    const failure = publicationBlockedWithCode({
      repositoryRoot: input.repositoryRoot,
      privateRoot: input.privateRoot,
      lifecycle: input.lifecycle,
      source: { operation: 'inspect', paths: input.paths },
      candidate: { journal, recoveryKind: 'pre-ref' },
      failureCode: 'PUBLICATION_RECOVERY_REQUIRED',
      message:
        'Manifest publication stopped before its current authority ref was installed.',
    });
    return {
      outcome: 'recoverable',
      transactionId: journal.transactionId,
      recoveryKind: 'pre-ref',
      manifestDigest: journal.manifestDigest,
      investigationTargetDigest: journal.investigationTargetDigest,
      blocker: failure.blocker,
      failure: failure.failure,
    };
  } catch (error) {
    return publicationBlocked({
      repositoryRoot: input.repositoryRoot,
      privateRoot: input.privateRoot,
      lifecycle: input.lifecycle,
      source: { operation: 'inspect', paths: input.paths },
      candidate: input.paths,
      error,
    });
  }
}

export function resumeInvestigationManifestPublication(input: {
  repositoryRoot: string;
  privateRoot?: string;
  paths: InvestigationManifestPublicationPaths;
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
  withTransitionLock: WithTransitionLock;
  observePhase?: (phase: InvestigationManifestPublicationPhase) => void;
}): PublicationResult {
  let paths: ReturnType<typeof normalizePaths>;
  let journal: PublicationJournal;
  let mutationPhase: InvestigationManifestPublicationPhase | null = null;
  try {
    assertPublicationSourceLifecycleBinding(
      { operation: 'resume', paths: input.paths },
      input.lifecycle,
    );
    paths = normalizePaths(
      input.repositoryRoot,
      input.privateRoot,
      input.paths,
    );
    journal = readJournal(
      paths.journal,
      input.paths,
      paths.privateRoot,
      paths.repositoryRoot,
    );
    assertLifecycleIdentity(journal.expected, input.lifecycle);
    assertPublicationJournalRolePaths(paths, journal);
    if (journal.state === 'committed') {
      assertInstalledState(paths, journal);
      return publishedResult(journal);
    }
  } catch (error) {
    return publicationBlocked({
      repositoryRoot: input.repositoryRoot,
      privateRoot: input.privateRoot,
      lifecycle: input.lifecycle,
      source: { operation: 'resume', paths: input.paths },
      candidate: input.paths,
      error,
    });
  }

  try {
    return input.withTransitionLock((snapshot) => {
      assertSnapshotIdentity(snapshot, journal.expected);
      const desiredRefInstalled = currentRefMatches(
        paths.currentRef,
        journal.currentRef,
        paths.privateRoot,
      );
      const currentRefDigest = publicationRefDigest(
        paths.privateRoot,
        input.paths.currentRefPath,
      );
      if (
        currentRefDigest !== journal.expected.currentRefDigest &&
        !desiredRefInstalled
      ) {
        throw publicationFailure(
          'REVIEW_TARGET_STALE',
          'Current investigation authority ref changed during recovery.',
        );
      }

      const candidate = paths.repositoryAbsolute(journal.paths.candidatePath);
      removeAbandonedCandidateTemporaries(paths.repositoryRoot, candidate);
      let source: string | null = fs.existsSync(candidate) ? candidate : null;
      if (source === null && fs.existsSync(paths.manifest)) {
        try {
          assertManifestMatchesJournal(
            paths.manifest,
            journal,
            paths.repositoryRoot,
          );
          source = paths.manifest;
        } catch (error) {
          if (desiredRefInstalled) throw error;
          // Before the ref switches, a revision-stable tracked path may still
          // contain the prior authoritative Manifest. The journal owns the
          // exact replacement bytes used to rebuild its candidate.
        }
      }
      if (desiredRefInstalled && source !== paths.manifest) {
        throw publicationFailure(
          'RECONSTRUCTION_MISMATCH',
          'Published authority cannot be reconstructed from pre-ref recovery bytes.',
        );
      }
      const rawManifest =
        source === null
          ? journal.manifest
          : readJson(source, paths.repositoryRoot);
      const validated = validateForAuthority({
        repositoryRoot: input.repositoryRoot,
        manifest: rawManifest,
        expected: authorityExpected(journal.expected),
      });
      if (
        validated.outcome !== 'verified' ||
        validated.manifestDigest !== journal.manifestDigest ||
        validated.investigationTargetDigest !==
          journal.investigationTargetDigest
      ) {
        throw publicationFailure(
          'RECONSTRUCTION_MISMATCH',
          'Prepared publication Manifest no longer matches its journal.',
        );
      }
      if (!desiredRefInstalled) {
        assertManifestTargetPreservesCurrentAuthority(
          paths.currentRef,
          journal.currentRef,
          paths.privateRoot,
        );
      }
      if (source === null) {
        mutationPhase = 'candidate-written';
        writeCanonical(
          candidate,
          validated.manifest,
          paths.repositoryRoot,
          0o644,
        );
        input.observePhase?.('candidate-written');
      }
      if (source === candidate || source === null) {
        mutationPhase = 'manifest-installed';
        installCandidate(candidate, paths.manifest, journal, paths);
        input.observePhase?.('manifest-installed');
      } else {
        assertManifestMatchesJournal(
          paths.manifest,
          journal,
          paths.repositoryRoot,
        );
      }
      if (desiredRefInstalled) mutationPhase = 'current-ref-published';
      if (!desiredRefInstalled) {
        mutationPhase = 'current-ref-published';
        if (
          publicationRefDigest(
            paths.privateRoot,
            input.paths.currentRefPath,
          ) !== journal.expected.currentRefDigest
        ) {
          throw publicationFailure(
            'REVIEW_TARGET_STALE',
            'Current investigation authority ref changed before recovery CAS publication.',
          );
        }
        writeCanonical(paths.currentRef, journal.currentRef, paths.privateRoot);
        input.observePhase?.('current-ref-published');
      }
      mutationPhase = 'journal-committed';
      writeCanonical(
        paths.journal,
        { ...journal, state: 'committed' },
        paths.privateRoot,
      );
      input.observePhase?.('journal-committed');
      return publishedResult(journal);
    });
  } catch (error) {
    return publicationBlocked({
      repositoryRoot: input.repositoryRoot,
      privateRoot: input.privateRoot,
      lifecycle: input.lifecycle,
      source: { operation: 'resume', paths: input.paths },
      candidate: journal,
      mutationPhase,
      error,
    });
  }
}

export function readInvestigationPublicationRefState(input: {
  repositoryRoot: string;
  privateRoot?: string;
  currentRefPath: string;
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
}):
  | { outcome: 'read'; currentRefDigest: string }
  | {
      outcome: 'blocked';
      blocker: InvestigationV3Blocker;
      failure: InvestigationManifestPublicationFailure;
    } {
  try {
    assertPublicationSourceLifecycleBinding(
      { operation: 'read-ref', currentRefPath: input.currentRefPath },
      input.lifecycle,
    );
    return {
      outcome: 'read',
      currentRefDigest: publicationRefDigest(
        input.privateRoot ?? input.repositoryRoot,
        input.currentRefPath,
      ),
    };
  } catch (error) {
    return publicationBlocked({
      repositoryRoot: input.repositoryRoot,
      privateRoot: input.privateRoot,
      lifecycle: input.lifecycle,
      source: { operation: 'read-ref', currentRefPath: input.currentRefPath },
      candidate: { currentRefPath: input.currentRefPath },
      error,
    });
  }
}

/**
 * Read the private current ref that authorizes one exact tracked Manifest.
 * Unlike the CAS snapshot reader above, this boundary rejects a missing,
 * malformed, or merely prior ref instead of returning a digest for it.
 */
export function readBoundInvestigationManifestPublicationRef(input: {
  repositoryRoot: string;
  privateRoot?: string;
  currentRefPath: string;
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
  expected: {
    manifestPath: string;
    manifestDigest: string;
    investigationTargetDigest: string;
  };
}):
  | { outcome: 'read'; currentRefDigest: string }
  | {
      outcome: 'blocked';
      blocker: InvestigationV3Blocker;
      failure: InvestigationManifestPublicationFailure;
    } {
  try {
    const source = {
      operation: 'read-ref' as const,
      currentRefPath: input.currentRefPath,
    };
    assertPublicationSourceLifecycleBinding(source, input.lifecycle);
    const privateRoot = fs.realpathSync(
      path.resolve(input.privateRoot ?? input.repositoryRoot),
    );
    const observed = readStablePublicationFile(
      privateRoot,
      input.currentRefPath,
    );
    if (observed === null) {
      throw publicationFailure(
        'REVIEW_TARGET_STALE',
        'Current investigation Manifest has no published private authority ref.',
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(observed.toString('utf8'));
    } catch {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Investigation current ref is not JSON.',
      );
    }
    if (observed.toString('utf8') !== `${canonicalJson(raw)}\n`) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Investigation current ref is not canonical JSON.',
      );
    }
    const current = parseCurrentManifestRef(raw);
    const expected: CurrentManifestRef = {
      schemaVersion: 1,
      kind: 'investigation-manifest-current',
      repositoryId: input.lifecycle.repositoryId,
      changeId: input.lifecycle.changeId,
      investigationId: input.lifecycle.investigationId,
      manifestDigest: input.expected.manifestDigest,
      investigationTargetDigest: input.expected.investigationTargetDigest,
      manifestPath: input.expected.manifestPath,
    };
    if (canonicalJson(current) !== canonicalJson(expected)) {
      throw publicationFailure(
        'REVIEW_TARGET_STALE',
        'Private investigation current ref does not bind the tracked Manifest bytes.',
      );
    }
    return {
      outcome: 'read',
      currentRefDigest: digest({
        schema: 'investigation-publication-ref-state.v1',
        exists: true,
        contentSha256: crypto
          .createHash('sha256')
          .update(observed)
          .digest('hex'),
      }),
    };
  } catch (error) {
    return publicationBlocked({
      repositoryRoot: input.repositoryRoot,
      privateRoot: input.privateRoot,
      lifecycle: input.lifecycle,
      source: {
        operation: 'read-ref',
        currentRefPath: input.currentRefPath,
      },
      candidate: {
        currentRefPath: input.currentRefPath,
        expected: input.expected,
      },
      error,
    });
  }
}

function assertPublicationSourceLifecycleBinding(
  source: InvestigationManifestPublicationObservationSource,
  lifecycle: InvestigationManifestPublicationLifecycleIdentity,
): void {
  if (
    !investigationManifestPublicationSourceMatchesLifecycle(source, lifecycle)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication paths are outside the lifecycle-owned namespace.',
    );
  }
}

/**
 * Read-only, source-owned observation used by the central Grant adapter. It
 * contains no Grant state and never follows a symlink or trusts journal bytes.
 */
export function observeInvestigationManifestPublicationState(input: {
  repositoryRoot: string;
  privateRoot?: string;
  source: InvestigationManifestPublicationObservationSource;
}): InvestigationManifestPublicationStateObservation {
  let artifacts: InvestigationManifestPublicationStateObservation['artifacts'];
  let recoveryKind: InvestigationManifestPublicationStateObservation['recoveryKind'];
  try {
    artifacts =
      input.source.operation === 'read-ref'
        ? [
            observePublicationArtifact(
              input.privateRoot ?? input.repositoryRoot,
              input.source.currentRefPath,
            ),
          ]
        : observePublicationArtifacts(
            input.repositoryRoot,
            input.privateRoot ?? input.repositoryRoot,
            input.source.paths,
          );
    recoveryKind = publicationRecoveryKind(
      input.repositoryRoot,
      input.privateRoot ?? input.repositoryRoot,
      input.source,
    );
  } catch {
    const declared =
      input.source.operation === 'read-ref'
        ? [input.source.currentRefPath]
        : [
            input.source.paths.manifestPath,
            input.source.paths.currentRefPath,
            input.source.paths.journalPath,
          ];
    artifacts = Object.freeze(
      [...new Set(declared)].sort().map((artifactPath) =>
        Object.freeze({
          path: artifactPath,
          state: 'unsafe' as const,
          contentSha256: null,
        }),
      ),
    );
    recoveryKind = 'blocked';
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'investigation-manifest-publication-state' as const,
    source: structuredClone(input.source),
    recoveryKind,
    artifacts: Object.freeze(artifacts),
  });
}

function publicationRefDigest(
  repositoryRoot: string,
  relativePath: string,
): string {
  const observed = readStablePublicationFile(repositoryRoot, relativePath);
  if (observed === null) {
    return digest({
      schema: 'investigation-publication-ref-state.v1',
      exists: false,
    });
  }
  return digest({
    schema: 'investigation-publication-ref-state.v1',
    exists: true,
    contentSha256: crypto.createHash('sha256').update(observed).digest('hex'),
  });
}

function normalizePaths(
  repositoryRoot: string,
  privateRoot: string | undefined,
  paths: InvestigationManifestPublicationPaths,
): {
  repositoryRoot: string;
  privateRoot: string;
  manifest: string;
  currentRef: string;
  journal: string;
  repositoryAbsolute: (relativePath: string) => string;
} {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const privateStorageRoot = fs.realpathSync(
    path.resolve(privateRoot ?? repositoryRoot),
  );
  const manifest = resolveRelative(root, paths.manifestPath);
  const currentRef = resolveRelative(privateStorageRoot, paths.currentRefPath);
  const journal = resolveRelative(privateStorageRoot, paths.journalPath);
  assertPublicationRolePathsDistinct([manifest, currentRef, journal]);
  return {
    repositoryRoot: root,
    privateRoot: privateStorageRoot,
    manifest,
    currentRef,
    journal,
    repositoryAbsolute: (relativePath) => resolveRelative(root, relativePath),
  };
}

function resolveRelative(repositoryRoot: string, relativePath: string): string {
  if (!isCanonicalPublicationRelativePath(relativePath)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication path must be repository-relative.',
    );
  }
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const absolute = path.resolve(root, relativePath);
  if (absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication path escapes the repository.',
    );
  }
  assertPlainPublicationDirectoryChain(root, path.dirname(absolute), true);
  return absolute;
}

function isCanonicalPublicationRelativePath(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !PUBLICATION_PATH.test(value) ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value
  ) {
    return false;
  }
  return !value
    .split('/')
    .some(
      (segment) => segment.length === 0 || segment === '.' || segment === '..',
    );
}

function assertPublicationRolePathsDistinct(
  absolutePaths: readonly string[],
): void {
  if (new Set(absolutePaths).size !== absolutePaths.length) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication path roles must be distinct.',
    );
  }
  for (let left = 0; left < absolutePaths.length; left += 1) {
    for (let right = left + 1; right < absolutePaths.length; right += 1) {
      const leftPath = absolutePaths[left]!;
      const rightPath = absolutePaths[right]!;
      if (
        leftPath.startsWith(rightPath + path.sep) ||
        rightPath.startsWith(leftPath + path.sep)
      ) {
        throw publicationFailure(
          'MANIFEST_UNREPRESENTABLE',
          'Publication path roles must not contain one another.',
        );
      }
    }
  }
  for (const absolute of absolutePaths) {
    const observed = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (
      observed !== undefined &&
      (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1)
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication path role is not a plain single-link file.',
      );
    }
  }
}

function assertPublicationJournalRolePaths(
  paths: ReturnType<typeof normalizePaths>,
  journal: PublicationJournal,
): string {
  const candidate = paths.repositoryAbsolute(journal.paths.candidatePath);
  assertPublicationRolePathsDistinct([
    paths.manifest,
    paths.currentRef,
    paths.journal,
    candidate,
  ]);
  return candidate;
}

function candidateRelativePath(
  paths: InvestigationManifestPublicationPaths,
  transactionId: string,
): string {
  return `${paths.manifestPath}.${transactionId}.candidate`;
}

function removeAbandonedCandidateTemporaries(
  repositoryRoot: string,
  candidatePath: string,
): void {
  const directory = path.dirname(candidatePath);
  assertPlainPublicationDirectoryChain(repositoryRoot, directory, false);
  const prefix = `${path.basename(candidatePath)}.`;
  let removed = false;
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    const segments = suffix.split('.');
    if (
      segments.length !== 3 ||
      !/^[1-9][0-9]*$/.test(segments[0]!) ||
      !UUID_V4.test(segments[1]!) ||
      segments[2] !== 'tmp'
    ) {
      continue;
    }
    const temporary = path.join(directory, name);
    const observed = fs.lstatSync(temporary, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (observed === undefined) continue;
    if (
      !observed.isFile() ||
      observed.isSymbolicLink() ||
      observed.nlink !== 1n
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Abandoned publication temporary is not a plain single-link file.',
      );
    }
    fs.unlinkSync(temporary);
    removed = true;
  }
  if (removed) fsyncDirectory(directory);
}

function candidateResidue(
  repositoryRoot: string,
  paths: InvestigationManifestPublicationPaths,
): string[] {
  const manifest = resolveRelative(repositoryRoot, paths.manifestPath);
  const directory = path.dirname(manifest);
  const prefix = `${path.basename(manifest)}.`;
  const suffix = '.candidate';
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stats) return [];
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Manifest publication directory is unsafe.',
    );
  }
  return fs
    .readdirSync(directory)
    .filter((name) => {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) return false;
      return DIGEST.test(name.slice(prefix.length, -suffix.length));
    })
    .map((name) =>
      path.posix.join(path.posix.dirname(paths.manifestPath), name),
    )
    .sort();
}

function validatedCandidateResidue(
  repositoryRoot: string,
  privateRoot: string,
  paths: InvestigationManifestPublicationPaths,
  lifecycle: InvestigationManifestPublicationLifecycleIdentity,
): { candidatePath: string; transactionId: string } | null {
  const candidates = candidateResidue(repositoryRoot, paths);
  if (candidates.length === 0) return null;
  if (candidates.length !== 1) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Candidate-only publication residue is ambiguous.',
    );
  }
  const candidatePath = candidates[0]!;
  const candidate = readJson(resolveRelative(repositoryRoot, candidatePath));
  const expected: InvestigationManifestPublicationSnapshot = {
    ...lifecycle,
    currentRefDigest: publicationRefDigest(privateRoot, paths.currentRefPath),
  };
  const validated = validateForAuthority({
    repositoryRoot,
    manifest: candidate,
    expected: authorityExpected(expected),
  });
  if (validated.outcome !== 'verified') {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Candidate-only publication residue is not a valid Manifest for the current lifecycle.',
    );
  }
  const currentRef = currentRefFor(paths.manifestPath, validated.manifest);
  const transactionId = digest({
    schema: 'investigation-manifest-publication-transaction.v1',
    expected,
    currentRef,
  });
  if (candidatePath !== candidateRelativePath(paths, transactionId)) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Candidate-only publication residue does not match its lifecycle transaction.',
    );
  }
  return { candidatePath, transactionId };
}

function observePublicationArtifacts(
  repositoryRoot: string,
  privateRoot: string,
  paths: InvestigationManifestPublicationPaths,
): InvestigationManifestPublicationStateObservation['artifacts'] {
  const declared: { root: string; relativePath: string }[] = [
    { root: repositoryRoot, relativePath: paths.manifestPath },
    { root: privateRoot, relativePath: paths.currentRefPath },
    { root: privateRoot, relativePath: paths.journalPath },
  ];
  let candidates: string[] = [];
  try {
    candidates = candidateResidue(repositoryRoot, paths);
  } catch {
    // The declared artifact observations below retain the unsafe state.
  }
  const journalCandidate = observedJournalCandidatePath(
    repositoryRoot,
    privateRoot,
    paths,
  );
  if (journalCandidate !== null) candidates.push(journalCandidate);
  for (const candidatePath of candidates) {
    declared.push({ root: repositoryRoot, relativePath: candidatePath });
  }
  return declared
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
    .map(({ root, relativePath }) =>
      observePublicationArtifact(root, relativePath),
    );
}

function observePublicationArtifact(
  repositoryRoot: string,
  relativePath: string,
): InvestigationManifestPublicationStateObservation['artifacts'][number] {
  let absolute: string;
  try {
    absolute = resolveRelative(repositoryRoot, relativePath);
  } catch {
    return Object.freeze({
      path: relativePath,
      state: 'unsafe' as const,
      contentSha256: null,
    });
  }
  const stats = fs.lstatSync(absolute, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (!stats) {
    return Object.freeze({
      path: relativePath,
      state: 'missing' as const,
      contentSha256: null,
    });
  }
  if (stats.isSymbolicLink()) {
    return Object.freeze({
      path: relativePath,
      state: 'symlink' as const,
      contentSha256: null,
    });
  }
  if (stats.isDirectory()) {
    return Object.freeze({
      path: relativePath,
      state: 'directory' as const,
      contentSha256: null,
    });
  }
  if (!stats.isFile()) {
    return Object.freeze({
      path: relativePath,
      state: 'other' as const,
      contentSha256: null,
    });
  }
  let bytes: Buffer;
  try {
    bytes =
      readStablePublicationFile(repositoryRoot, relativePath) ??
      Buffer.alloc(0);
  } catch {
    return Object.freeze({
      path: relativePath,
      state: 'unsafe' as const,
      contentSha256: null,
    });
  }
  return Object.freeze({
    path: relativePath,
    state: 'file' as const,
    contentSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
}

function publicationRecoveryKind(
  repositoryRoot: string,
  privateRoot: string,
  source: InvestigationManifestPublicationObservationSource,
): InvestigationManifestPublicationStateObservation['recoveryKind'] {
  if (source.operation === 'read-ref') {
    const state = observePublicationArtifact(
      privateRoot,
      source.currentRefPath,
    ).state;
    return state === 'missing' || state === 'file' ? 'none' : 'blocked';
  }
  try {
    const paths = normalizePaths(repositoryRoot, privateRoot, source.paths);
    if (!fs.existsSync(paths.journal)) {
      return candidateResidue(repositoryRoot, source.paths).length > 0
        ? 'blocked'
        : 'none';
    }
    const journal = readJournal(
      paths.journal,
      source.paths,
      paths.privateRoot,
      paths.repositoryRoot,
    );
    if (journal.state === 'committed') {
      assertInstalledState(paths, journal);
      return 'committed';
    }
    if (
      currentRefMatches(paths.currentRef, journal.currentRef, paths.privateRoot)
    ) {
      assertInstalledState(paths, journal);
      return 'post-ref';
    }
    return 'pre-ref';
  } catch {
    return 'blocked';
  }
}

function observedJournalCandidatePath(
  repositoryRoot: string,
  privateRoot: string,
  paths: InvestigationManifestPublicationPaths,
): string | null {
  let journalPath: string;
  try {
    journalPath = resolveRelative(privateRoot, paths.journalPath);
  } catch {
    return null;
  }
  try {
    return readJournal(journalPath, paths, privateRoot, repositoryRoot).paths
      .candidatePath;
  } catch {
    return null;
  }
}

function currentRefFor(
  manifestPath: string,
  manifest: InvestigationManifestV3,
): CurrentManifestRef {
  return {
    schemaVersion: 1,
    kind: 'investigation-manifest-current',
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    manifestDigest: manifest.manifestDigest,
    investigationTargetDigest:
      manifest.investigationApproval.investigationTargetDigest,
    manifestPath,
  };
}

function authorityExpected(snapshot: InvestigationManifestPublicationSnapshot) {
  return {
    repositoryId: snapshot.repositoryId,
    changeId: snapshot.changeId,
    investigationId: snapshot.investigationId,
    sessionRevision: snapshot.sessionRevision,
    sessionSnapshotDigest: snapshot.sessionSnapshotDigest,
  };
}

function assertSnapshot(
  actual: InvestigationManifestPublicationSnapshot,
  expected: InvestigationManifestPublicationSnapshot,
): void {
  assertSnapshotIdentity(actual, expected);
  if (actual.currentRefDigest !== expected.currentRefDigest) {
    throw publicationFailure(
      'REVIEW_TARGET_STALE',
      'Lifecycle snapshot current-ref digest changed before publication.',
    );
  }
}

function assertSnapshotIdentity(
  actual: InvestigationManifestPublicationSnapshot,
  expected: InvestigationManifestPublicationSnapshot,
): void {
  const identity = (snapshot: InvestigationManifestPublicationSnapshot) => ({
    repositoryId: snapshot.repositoryId,
    changeId: snapshot.changeId,
    investigationId: snapshot.investigationId,
    sessionRevision: snapshot.sessionRevision,
    sessionSnapshotDigest: snapshot.sessionSnapshotDigest,
  });
  if (canonicalJson(identity(actual)) !== canonicalJson(identity(expected))) {
    throw publicationFailure(
      'REVIEW_TARGET_STALE',
      'Lifecycle authority snapshot changed before publication.',
    );
  }
}

function lifecycleIdentity(
  snapshot: InvestigationManifestPublicationSnapshot,
): InvestigationManifestPublicationLifecycleIdentity {
  return {
    repositoryId: snapshot.repositoryId,
    changeId: snapshot.changeId,
    investigationId: snapshot.investigationId,
    sessionRevision: snapshot.sessionRevision,
    sessionSnapshotDigest: snapshot.sessionSnapshotDigest,
  };
}

function assertLifecycleIdentity(
  actual: InvestigationManifestPublicationSnapshot,
  expected: InvestigationManifestPublicationLifecycleIdentity,
): void {
  if (canonicalJson(lifecycleIdentity(actual)) !== canonicalJson(expected)) {
    throw publicationFailure(
      'REVIEW_TARGET_STALE',
      'Publication journal lifecycle identity changed before recovery.',
    );
  }
}

function writeCanonical(
  filePath: string,
  value: unknown,
  storageRoot: string = publicationRepositoryRoot(filePath),
  mode = 0o600,
): void {
  const repositoryRoot = fs.realpathSync(path.resolve(storageRoot));
  const directory = path.dirname(filePath);
  ensurePlainPublicationDirectoryChain(repositoryRoot, directory);
  const parentIdentity = assertPlainPublicationDirectoryChain(
    repositoryRoot,
    directory,
    false,
  );
  const targetName = path.basename(filePath);
  const temporaryName = `${targetName}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let installedIdentity: fs.BigIntStats | null = null;
  try {
    withAnchoredPublicationDirectory(
      repositoryRoot,
      directory,
      parentIdentity,
      () => {
        let descriptor: number | null = null;
        let temporaryIdentity: fs.BigIntStats | null = null;
        let replacementIdentity: fs.BigIntStats | null = null;
        let replacementInstalled = false;
        let previous: PublicationFilePreimage | null = null;
        try {
          descriptor = fs.openSync(
            temporaryName,
            fs.constants.O_CREAT |
              fs.constants.O_EXCL |
              fs.constants.O_RDWR |
              (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
            mode,
          );
          temporaryIdentity = fs.fstatSync(descriptor, { bigint: true });
          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);

          const bytes = Buffer.from(`${canonicalJson(value)}\n`);
          fs.writeFileSync(descriptor, bytes);
          fs.fsyncSync(descriptor);
          const afterWrite = fs.fstatSync(descriptor, { bigint: true });
          if (
            temporaryIdentity.dev !== afterWrite.dev ||
            temporaryIdentity.ino !== afterWrite.ino ||
            !afterWrite.isFile() ||
            afterWrite.nlink !== 1n ||
            afterWrite.size !== BigInt(bytes.length) ||
            Number(afterWrite.mode & 0o777n) !== mode
          ) {
            throw publicationFailure(
              'MANIFEST_UNREPRESENTABLE',
              'Publication temporary file changed while it was written.',
            );
          }
          const existing = fs.lstatSync(targetName, {
            bigint: true,
            throwIfNoEntry: false,
          });
          if (
            existing !== undefined &&
            (!existing.isFile() ||
              existing.isSymbolicLink() ||
              existing.nlink !== 1n)
          ) {
            throw publicationFailure(
              'MANIFEST_UNREPRESENTABLE',
              'Publication target is not a plain file.',
            );
          }
          previous =
            existing === undefined
              ? null
              : readAnchoredPublicationPreimage(targetName, existing);

          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
          fs.renameSync(temporaryName, targetName);
          replacementInstalled = true;
          replacementIdentity = afterWrite;
          const installed = fs.lstatSync(targetName, {
            bigint: true,
            throwIfNoEntry: false,
          });
          if (
            installed === undefined ||
            installed.dev !== afterWrite.dev ||
            installed.ino !== afterWrite.ino
          ) {
            throw publicationFailure(
              'MANIFEST_UNREPRESENTABLE',
              'Publication target changed during atomic replacement.',
            );
          }
          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
          fsyncDirectory('.');
          assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
          installedIdentity = installed;
        } catch (error) {
          if (descriptor !== null) {
            fs.closeSync(descriptor);
            descriptor = null;
          }
          if (replacementInstalled && replacementIdentity !== null) {
            compensateAnchoredPublicationReplacement(
              targetName,
              replacementIdentity,
              previous,
            );
          } else if (temporaryIdentity !== null) {
            unlinkAnchoredPublicationFile(temporaryName, temporaryIdentity);
          }
          throw error;
        } finally {
          if (descriptor !== null) fs.closeSync(descriptor);
        }
      },
    );
    const installed = fs.lstatSync(filePath, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const afterRename = assertPlainPublicationDirectoryChain(
      repositoryRoot,
      directory,
      false,
    );
    if (
      installedIdentity === null ||
      installed === undefined ||
      !samePublicationFileIdentity(installedIdentity, installed) ||
      !samePublicationDirectoryChain(parentIdentity, afterRename)
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication target or parent changed during atomic replacement.',
      );
    }
  } catch (error) {
    if (error instanceof PublicationFailure) throw error;
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      error instanceof Error
        ? `Publication write failed safely: ${error.message}`
        : 'Publication write failed safely.',
    );
  }
}

function ensurePlainPublicationDirectoryChain(
  repositoryRoot: string,
  directory: string,
): void {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication directory escapes the repository.',
    );
  }
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const existing = fs.lstatSync(current, { throwIfNoEntry: false });
    if (existing === undefined) {
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    const observed = fs.lstatSync(current, { throwIfNoEntry: false });
    if (
      observed === undefined ||
      !observed.isDirectory() ||
      observed.isSymbolicLink() ||
      fs.realpathSync(current) !== current
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication path has a non-plain ancestor directory.',
      );
    }
  }
}

function unlinkAnchoredPublicationFile(
  name: string,
  expected: fs.BigIntStats,
): void {
  try {
    const observed = fs.lstatSync(name, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      observed !== undefined &&
      observed.isFile() &&
      !observed.isSymbolicLink() &&
      observed.dev === expected.dev &&
      observed.ino === expected.ino
    ) {
      fs.unlinkSync(name);
    }
  } catch {
    // A changed pathname is never followed or removed.
  }
}

type PublicationFilePreimage = Readonly<{
  bytes: Buffer;
  mode: number;
}>;

function readAnchoredPublicationPreimage(
  name: string,
  expected: fs.BigIntStats,
): PublicationFilePreimage {
  const descriptor = fs.openSync(
    name,
    fs.constants.O_RDONLY |
      (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
  );
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      !samePublicationFileIdentity(expected, before) ||
      !samePublicationFileIdentity(before, after)
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication target changed while its recovery preimage was read.',
      );
    }
    return {
      bytes,
      mode: Number(expected.mode & 0o777n),
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function compensateAnchoredPublicationReplacement(
  targetName: string,
  installed: fs.BigIntStats,
  previous: PublicationFilePreimage | null,
): void {
  const observed = fs.lstatSync(targetName, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    observed === undefined ||
    !observed.isFile() ||
    observed.isSymbolicLink() ||
    observed.dev !== installed.dev ||
    observed.ino !== installed.ino
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication replacement could not be identified for compensation.',
    );
  }
  if (previous === null) {
    fs.unlinkSync(targetName);
    fsyncDirectory('.');
    return;
  }

  const recoveryName = `${targetName}.${process.pid}.${crypto.randomUUID()}.restore`;
  let descriptor: number | null = null;
  let recoveryIdentity: fs.BigIntStats | null = null;
  try {
    descriptor = fs.openSync(
      recoveryName,
      fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_RDWR |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
      previous.mode,
    );
    fs.fchmodSync(descriptor, previous.mode);
    fs.writeFileSync(descriptor, previous.bytes);
    fs.fsyncSync(descriptor);
    recoveryIdentity = fs.fstatSync(descriptor, { bigint: true });
    if (
      !recoveryIdentity.isFile() ||
      recoveryIdentity.nlink !== 1n ||
      recoveryIdentity.size !== BigInt(previous.bytes.length) ||
      Number(recoveryIdentity.mode & 0o777n) !== previous.mode
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication recovery preimage could not be materialized safely.',
      );
    }
    fs.renameSync(recoveryName, targetName);
    const restoredStats = fs.lstatSync(targetName, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (
      restoredStats === undefined ||
      !restoredStats.isFile() ||
      restoredStats.isSymbolicLink() ||
      Number(restoredStats.mode & 0o777n) !== previous.mode
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication recovery preimage mode was not restored exactly.',
      );
    }
    const restored = readAnchoredPublicationPreimage(targetName, restoredStats);
    if (!restored.bytes.equals(previous.bytes)) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication recovery preimage was not restored exactly.',
      );
    }
    recoveryIdentity = null;
    fsyncDirectory('.');
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (recoveryIdentity !== null) {
      unlinkAnchoredPublicationFile(recoveryName, recoveryIdentity);
    }
  }
}

function withAnchoredPublicationDirectory<T>(
  repositoryRoot: string,
  directory: string,
  expected: readonly PublicationDirectoryIdentity[],
  operation: () => T,
): T {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    const anchored = fs.lstatSync('.', { bigint: true });
    const parent = expected.at(-1);
    if (
      parent === undefined ||
      !anchored.isDirectory() ||
      anchored.isSymbolicLink() ||
      anchored.dev !== parent.dev ||
      anchored.ino !== parent.ino ||
      anchored.mode !== parent.mode
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication parent directory could not be anchored safely.',
      );
    }
    assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
    const result = operation();
    assertAnchoredPublicationDirectoryInsideRepository(repositoryRoot);
    return result;
  } finally {
    process.chdir(previous);
  }
}

function assertAnchoredPublicationDirectoryInsideRepository(
  repositoryRoot: string,
): void {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const anchored = fs.realpathSync('.');
  if (anchored !== root && !anchored.startsWith(`${root}${path.sep}`)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication parent directory moved outside the repository.',
    );
  }
}

function installCandidate(
  candidatePath: string,
  manifestPath: string,
  journal: PublicationJournal,
  paths: ReturnType<typeof normalizePaths>,
): void {
  if (
    path.dirname(candidatePath) !== path.dirname(manifestPath) ||
    path.dirname(manifestPath) !== path.dirname(paths.manifest)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Manifest candidate and target must share one anchored directory.',
    );
  }
  const directory = path.dirname(manifestPath);
  const parentIdentity = assertPlainPublicationDirectoryChain(
    paths.repositoryRoot,
    directory,
    false,
  );
  const candidateIdentity = fs.lstatSync(candidatePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (
    candidateIdentity === undefined ||
    !candidateIdentity.isFile() ||
    candidateIdentity.isSymbolicLink() ||
    candidateIdentity.nlink !== 1n
  ) {
    throw publicationFailure(
      'REPLAY_INPUT_MISSING',
      'Manifest publication candidate is absent or unsafe.',
    );
  }
  assertManifestMatchesJournal(candidatePath, journal, paths.repositoryRoot);
  const candidateName = path.basename(candidatePath);
  const manifestName = path.basename(manifestPath);
  let installedIdentity: fs.BigIntStats | null = null;
  withAnchoredPublicationDirectory(
    paths.repositoryRoot,
    directory,
    parentIdentity,
    () => {
      const anchoredCandidate = fs.lstatSync(candidateName, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (
        anchoredCandidate === undefined ||
        !samePublicationFileIdentity(candidateIdentity, anchoredCandidate)
      ) {
        throw publicationFailure(
          'RECONSTRUCTION_MISMATCH',
          'Manifest publication candidate changed before installation.',
        );
      }
      const existing = fs.lstatSync(manifestName, {
        bigint: true,
        throwIfNoEntry: false,
      });
      if (
        existing !== undefined &&
        (!existing.isFile() ||
          existing.isSymbolicLink() ||
          existing.nlink !== 1n)
      ) {
        throw publicationFailure(
          'MANIFEST_UNREPRESENTABLE',
          'Manifest publication target is unsafe.',
        );
      }
      const previous =
        existing === undefined
          ? null
          : readAnchoredPublicationPreimage(manifestName, existing);
      let replacementInstalled = false;
      try {
        assertAnchoredPublicationDirectoryInsideRepository(
          paths.repositoryRoot,
        );
        fs.renameSync(candidateName, manifestName);
        replacementInstalled = true;
        const installed = fs.lstatSync(manifestName, {
          bigint: true,
          throwIfNoEntry: false,
        });
        const candidateAfter = fs.lstatSync(candidateName, {
          bigint: true,
          throwIfNoEntry: false,
        });
        if (
          installed === undefined ||
          !installed.isFile() ||
          installed.isSymbolicLink() ||
          installed.nlink !== 1n ||
          installed.dev !== candidateIdentity.dev ||
          installed.ino !== candidateIdentity.ino ||
          installed.mode !== candidateIdentity.mode ||
          installed.size !== candidateIdentity.size ||
          candidateAfter !== undefined
        ) {
          throw publicationFailure(
            'RECONSTRUCTION_MISMATCH',
            'Manifest candidate was not atomically installed.',
          );
        }
        fsyncDirectory('.');
        assertAnchoredPublicationDirectoryInsideRepository(
          paths.repositoryRoot,
        );
        installedIdentity = installed;
      } catch (error) {
        if (replacementInstalled) {
          compensateAnchoredPublicationReplacement(
            manifestName,
            candidateIdentity,
            previous,
          );
        }
        throw error;
      }
    },
  );
  const installed = fs.lstatSync(manifestPath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  const candidateAfter = fs.lstatSync(candidatePath, {
    bigint: true,
    throwIfNoEntry: false,
  });
  const parentAfter = assertPlainPublicationDirectoryChain(
    paths.repositoryRoot,
    directory,
    false,
  );
  if (
    installedIdentity === null ||
    installed === undefined ||
    !samePublicationFileIdentity(installedIdentity, installed) ||
    candidateAfter !== undefined ||
    !samePublicationDirectoryChain(parentIdentity, parentAfter)
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Manifest publication target changed after atomic installation.',
    );
  }
  assertManifestMatchesJournal(manifestPath, journal, paths.repositoryRoot);
}

function assertManifestMatchesJournal(
  filePath: string,
  journal: PublicationJournal,
  repositoryRoot: string = publicationRepositoryRoot(filePath),
): InvestigationManifestV3 {
  const parsed = readJson(filePath);
  const validated = validateForAuthority({
    repositoryRoot,
    manifest: parsed,
    expected: authorityExpected(journal.expected),
  });
  if (
    validated.outcome !== 'verified' ||
    validated.manifestDigest !== journal.manifestDigest ||
    validated.investigationTargetDigest !== journal.investigationTargetDigest
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication Manifest does not match the journalled authority state.',
    );
  }
  return validated.manifest;
}

function currentRefMatches(
  filePath: string,
  expected: CurrentManifestRef,
  privateRoot: string,
): boolean {
  if (!fs.existsSync(filePath)) return false;
  return (
    canonicalJson(parseCurrentManifestRef(readJson(filePath, privateRoot))) ===
    canonicalJson(expected)
  );
}

/**
 * Private legacy-namespace Manifests remain immutable and therefore require a
 * fresh path for each changed digest. The one governed tracked Manifest path
 * is revision-stable instead: a pre-ref crash is made non-authoritative by the
 * exact private current-ref check at every active read boundary.
 */
function assertManifestTargetPreservesCurrentAuthority(
  currentRefPath: string,
  next: CurrentManifestRef,
  privateRoot: string,
): void {
  if (!fs.existsSync(currentRefPath)) return;
  const current = parseCurrentManifestRef(
    readJson(currentRefPath, privateRoot),
  );
  if (
    current.manifestPath === next.manifestPath &&
    current.manifestDigest !== next.manifestDigest &&
    !isSameTrackedInvestigationLifecycle(current, next)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'A changed Manifest must use a fresh path before the authority ref is switched.',
    );
  }
}

function isSameTrackedInvestigationLifecycle(
  current: CurrentManifestRef,
  next: CurrentManifestRef,
): boolean {
  return (
    current.repositoryId === next.repositoryId &&
    current.changeId === next.changeId &&
    current.investigationId === next.investigationId &&
    current.manifestPath ===
      `openspec/changes/${current.changeId}/investigation.json` &&
    next.manifestPath === current.manifestPath
  );
}

function parseCurrentManifestRef(value: unknown): CurrentManifestRef {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Investigation current ref is malformed.',
    );
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    'schemaVersion',
    'kind',
    'repositoryId',
    'changeId',
    'investigationId',
    'manifestDigest',
    'investigationTargetDigest',
    'manifestPath',
  ];
  if (
    Object.keys(record).length !== expectedKeys.length ||
    !Object.keys(record).every((key) => expectedKeys.includes(key)) ||
    record.schemaVersion !== 1 ||
    record.kind !== 'investigation-manifest-current' ||
    typeof record.repositoryId !== 'string' ||
    typeof record.changeId !== 'string' ||
    typeof record.investigationId !== 'string' ||
    typeof record.manifestDigest !== 'string' ||
    !DIGEST.test(record.manifestDigest) ||
    typeof record.investigationTargetDigest !== 'string' ||
    !DIGEST.test(record.investigationTargetDigest) ||
    !isCanonicalPublicationRelativePath(record.manifestPath)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Investigation current ref is malformed.',
    );
  }
  return record as CurrentManifestRef;
}

function assertInstalledState(
  paths: ReturnType<typeof normalizePaths>,
  journal: PublicationJournal,
): void {
  assertManifestMatchesJournal(paths.manifest, journal, paths.repositoryRoot);
  if (
    !currentRefMatches(paths.currentRef, journal.currentRef, paths.privateRoot)
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Committed publication current ref is missing or stale.',
    );
  }
}

function readJournal(
  journalPath: string,
  expectedPaths: InvestigationManifestPublicationPaths,
  privateRoot = publicationRepositoryRoot(journalPath),
  repositoryRoot = publicationRepositoryRoot(journalPath),
): PublicationJournal {
  const value = readJson(journalPath, privateRoot);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication journal is malformed.',
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  const expectedKeys = [
    'schemaVersion',
    'kind',
    'state',
    'transactionId',
    'paths',
    'expected',
    'manifestDigest',
    'investigationTargetDigest',
    'manifest',
    'currentRef',
  ];
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key) => expectedKeys.includes(key)) ||
    record.schemaVersion !== 1 ||
    record.kind !== 'investigation-manifest-publication' ||
    (record.state !== 'prepared' && record.state !== 'committed') ||
    typeof record.transactionId !== 'string' ||
    !DIGEST.test(record.transactionId) ||
    typeof record.manifestDigest !== 'string' ||
    !DIGEST.test(record.manifestDigest) ||
    typeof record.investigationTargetDigest !== 'string' ||
    !DIGEST.test(record.investigationTargetDigest)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication journal identity is malformed.',
    );
  }
  const paths = record.paths as PublicationJournal['paths'];
  if (
    typeof paths !== 'object' ||
    paths === null ||
    canonicalJson({
      manifestPath: paths.manifestPath,
      currentRefPath: paths.currentRefPath,
      journalPath: paths.journalPath,
    }) !== canonicalJson(expectedPaths) ||
    typeof paths.candidatePath !== 'string'
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication journal paths do not match the requested transaction.',
    );
  }
  const journal = record as unknown as PublicationJournal;
  const currentRef = parseCurrentManifestRef(journal.currentRef);
  assertPublicationSnapshot(journal.expected);
  const validated = validateForAuthority({
    repositoryRoot,
    manifest: journal.manifest,
    expected: authorityExpected(journal.expected),
  });
  const expectedTransaction = digest({
    schema: 'investigation-manifest-publication-transaction.v1',
    expected: journal.expected,
    currentRef: journal.currentRef,
  });
  if (
    expectedTransaction !== journal.transactionId ||
    currentRef.manifestDigest !== journal.manifestDigest ||
    currentRef.investigationTargetDigest !==
      journal.investigationTargetDigest ||
    currentRef.repositoryId !== journal.expected.repositoryId ||
    currentRef.changeId !== journal.expected.changeId ||
    currentRef.investigationId !== journal.expected.investigationId ||
    currentRef.manifestPath !== journal.paths.manifestPath ||
    validated.outcome !== 'verified' ||
    validated.manifestDigest !== journal.manifestDigest ||
    validated.investigationTargetDigest !== journal.investigationTargetDigest
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication journal binding does not match recomputation.',
    );
  }
  if (
    journal.paths.candidatePath !==
    candidateRelativePath(journal.paths, journal.transactionId)
  ) {
    throw publicationFailure(
      'RECONSTRUCTION_MISMATCH',
      'Publication journal candidate path does not match its transaction.',
    );
  }
  return journal;
}

function assertPublicationSnapshot(
  value: unknown,
): asserts value is InvestigationManifestPublicationSnapshot {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 6
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication journal lifecycle snapshot is malformed.',
    );
  }
  const snapshot = value as Record<string, unknown>;
  if (
    typeof snapshot.repositoryId !== 'string' ||
    typeof snapshot.changeId !== 'string' ||
    typeof snapshot.investigationId !== 'string' ||
    typeof snapshot.sessionRevision !== 'number' ||
    !Number.isSafeInteger(snapshot.sessionRevision) ||
    snapshot.sessionRevision < 0 ||
    typeof snapshot.sessionSnapshotDigest !== 'string' ||
    !DIGEST.test(snapshot.sessionSnapshotDigest) ||
    typeof snapshot.currentRefDigest !== 'string' ||
    !DIGEST.test(snapshot.currentRefDigest)
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication journal lifecycle snapshot is malformed.',
    );
  }
}

function readJson(
  filePath: string,
  storageRoot = publicationRepositoryRoot(filePath),
): unknown {
  const repositoryRoot = fs.realpathSync(path.resolve(storageRoot));
  const relativePath = path.relative(repositoryRoot, filePath);
  let bytes: Buffer | null;
  try {
    bytes = readStablePublicationFile(repositoryRoot, relativePath);
  } catch {
    throw publicationFailure(
      'REPLAY_INPUT_MISSING',
      'Publication artifact is absent or unsafe.',
    );
  }
  if (bytes === null) {
    throw publicationFailure(
      'REPLAY_INPUT_MISSING',
      'Publication artifact is absent or unsafe.',
    );
  }
  const text = bytes.toString('utf8');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact is not JSON.',
    );
  }
  if (text !== `${canonicalJson(value)}\n`) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact is not canonical JSON.',
    );
  }
  return value;
}

type PublicationDirectoryIdentity = Readonly<{
  path: string;
  dev: bigint;
  ino: bigint;
  mode: bigint;
}>;

function readStablePublicationFile(
  repositoryRoot: string,
  relativePath: string,
): Buffer | null {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const absolute = resolveRelative(root, relativePath);
  const pathBefore = fs.lstatSync(absolute, {
    bigint: true,
    throwIfNoEntry: false,
  });
  if (pathBefore === undefined) return null;
  const parentBefore = assertPlainPublicationDirectoryChain(
    root,
    path.dirname(absolute),
    false,
  );
  if (
    !pathBefore.isFile() ||
    pathBefore.isSymbolicLink() ||
    pathBefore.nlink !== 1n
  ) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact path is unsafe.',
    );
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      absolute,
      fs.constants.O_RDONLY |
        (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW),
    );
  } catch {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication artifact could not be opened safely.',
    );
  }
  try {
    const before = fs.fstatSync(descriptor, { bigint: true });
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(absolute, {
      bigint: true,
      throwIfNoEntry: false,
    });
    const parentAfter = assertPlainPublicationDirectoryChain(
      root,
      path.dirname(absolute),
      false,
    );
    if (
      pathAfter === undefined ||
      !samePublicationFileIdentity(pathBefore, before) ||
      !samePublicationFileIdentity(before, after) ||
      !samePublicationFileIdentity(after, pathAfter) ||
      !samePublicationDirectoryChain(parentBefore, parentAfter)
    ) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication artifact changed while it was observed.',
      );
    }
    return bytes;
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertPlainPublicationDirectoryChain(
  repositoryRoot: string,
  directory: string,
  allowMissing: boolean,
): readonly PublicationDirectoryIdentity[] {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  if (root !== path.resolve(repositoryRoot)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication repository root is not canonical.',
    );
  }
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw publicationFailure(
      'MANIFEST_UNREPRESENTABLE',
      'Publication directory escapes the repository.',
    );
  }
  const identities: PublicationDirectoryIdentity[] = [];
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, {
      bigint: true,
      throwIfNoEntry: false,
    });
    if (stats === undefined) {
      if (allowMissing) break;
      throw publicationFailure(
        'REPLAY_INPUT_MISSING',
        'Publication artifact directory is absent.',
      );
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication path has a non-plain ancestor directory.',
      );
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync(current);
    } catch {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication directory could not be resolved safely.',
      );
    }
    if (canonical !== current) {
      throw publicationFailure(
        'MANIFEST_UNREPRESENTABLE',
        'Publication path has a non-canonical ancestor directory.',
      );
    }
    identities.push({
      path: current,
      dev: stats.dev,
      ino: stats.ino,
      mode: stats.mode,
    });
  }
  return identities;
}

function samePublicationFileIdentity(
  expected: fs.BigIntStats,
  observed: fs.BigIntStats,
): boolean {
  return (
    expected.isFile() &&
    observed.isFile() &&
    !observed.isSymbolicLink() &&
    expected.dev === observed.dev &&
    expected.ino === observed.ino &&
    expected.mode === observed.mode &&
    expected.nlink === observed.nlink &&
    expected.size === observed.size &&
    expected.mtimeNs === observed.mtimeNs &&
    expected.ctimeNs === observed.ctimeNs
  );
}

function samePublicationDirectoryChain(
  expected: readonly PublicationDirectoryIdentity[],
  observed: readonly PublicationDirectoryIdentity[],
): boolean {
  return (
    expected.length === observed.length &&
    expected.every((entry, index) => {
      const current = observed[index];
      return (
        current !== undefined &&
        entry.path === current.path &&
        entry.dev === current.dev &&
        entry.ino === current.ino &&
        entry.mode === current.mode
      );
    })
  );
}

function publicationRepositoryRoot(filePath: string): string {
  let current = path.resolve(path.dirname(filePath));
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    current = path.dirname(current);
  }
  throw publicationFailure(
    'MANIFEST_UNREPRESENTABLE',
    'Publication artifact is not inside a repository.',
  );
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishedResult(journal: PublicationJournal): PublicationResult {
  return {
    outcome: 'published',
    manifestDigest: journal.manifestDigest,
    investigationTargetDigest: journal.investigationTargetDigest,
    transactionId: journal.transactionId,
  };
}

class PublicationFailure extends Error {
  readonly code: InvestigationV3FailureCode;

  constructor(code: InvestigationV3FailureCode, message: string) {
    super(message);
    this.name = 'PublicationFailure';
    this.code = code;
  }
}

function publicationFailure(
  code: InvestigationV3FailureCode,
  message: string,
): PublicationFailure {
  return new PublicationFailure(code, message);
}

function publicationBlocked(input: {
  repositoryRoot: string;
  privateRoot?: string;
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
  source: InvestigationManifestPublicationObservationSource;
  candidate: unknown;
  mutationPhase?: InvestigationManifestPublicationPhase | null;
  error: unknown;
}): Extract<PublicationResult, { outcome: 'blocked' }> {
  const recoveryRequired =
    input.mutationPhase === 'candidate-written' ||
    input.mutationPhase === 'journal-prepared' ||
    input.mutationPhase === 'manifest-installed' ||
    input.mutationPhase === 'current-ref-published' ||
    input.mutationPhase === 'journal-committed';
  const recoveryPolicy =
    input.mutationPhase === 'current-ref-published' ||
    input.mutationPhase === 'journal-committed'
      ? 'idempotent-post-ref'
      : 'central-grant';
  return publicationBlockedWithCode({
    ...input,
    failureCode:
      input.error instanceof PublicationFailure
        ? input.error.code
        : recoveryRequired
          ? 'PUBLICATION_RECOVERY_REQUIRED'
          : 'RECONSTRUCTION_MISMATCH',
    recoveryPolicy,
    message:
      input.error instanceof Error
        ? input.error.message
        : 'Unknown Manifest publication failure.',
  });
}

function publicationBlockedWithCode(input: {
  repositoryRoot: string;
  privateRoot?: string;
  lifecycle: InvestigationManifestPublicationLifecycleIdentity;
  source: InvestigationManifestPublicationObservationSource;
  candidate: unknown;
  failureCode: InvestigationV3FailureCode;
  message: string;
  recoveryPolicy?: 'central-grant' | 'idempotent-post-ref';
}): Extract<PublicationResult, { outcome: 'blocked' }> {
  const blocker = createInvestigationV3Blocker({
    attemptedTransition: 'publication',
    candidate: input.candidate,
    failureCode: input.failureCode,
    message: input.message,
  });
  const publication = observeInvestigationManifestPublicationState({
    repositoryRoot: input.repositoryRoot,
    privateRoot: input.privateRoot,
    source: input.source,
  });
  const emittedPublicationStateDigest = prefixedDigest(
    canonicalJson({
      schema: 'investigation-v3-publication-emitted-state.v1',
      publication,
    }),
  );
  const sourceWithoutEmission = {
    schemaVersion: 1 as const,
    observation: structuredClone(input.source),
    failureIdentity: blocker.failureIdentity,
    emittedPublicationStateDigest,
    emittedGitStateDigest: safePublicationGitStateDigest(input.repositoryRoot),
    recoveryPolicy: input.recoveryPolicy ?? 'central-grant',
  };
  const failure: InvestigationManifestPublicationFailure = deepFreeze({
    schemaVersion: 1,
    kind: 'investigation-manifest-publication-failure',
    lifecycle: structuredClone(input.lifecycle),
    blocker,
    source: {
      ...sourceWithoutEmission,
      emissionDigest: prefixedDigest(
        canonicalJson({
          schema: 'investigation-v3-publication-failure-emission.v1',
          lifecycle: input.lifecycle,
          blocker,
          source: sourceWithoutEmission,
        }),
      ),
    },
  });
  return deepFreeze({ outcome: 'blocked', blocker, failure });
}

export function investigationManifestPublicationFailureEmissionDigest(
  failure: Omit<InvestigationManifestPublicationFailure, 'source'> & {
    source: Omit<
      InvestigationManifestPublicationFailure['source'],
      'emissionDigest'
    >;
  },
): `sha256:${string}` {
  return prefixedDigest(
    canonicalJson({
      schema: 'investigation-v3-publication-failure-emission.v1',
      lifecycle: failure.lifecycle,
      blocker: failure.blocker,
      source: failure.source,
    }),
  );
}

export function investigationManifestPublicationStateDigest(
  publication: InvestigationManifestPublicationStateObservation,
): `sha256:${string}` {
  return prefixedDigest(
    canonicalJson({
      schema: 'investigation-v3-publication-emitted-state.v1',
      publication,
    }),
  );
}

export function investigationManifestPublicationGitStateDigest(
  git: GitState,
): `sha256:${string}` {
  let worktreeFingerprint: string;
  try {
    worktreeFingerprint = fingerprintRepositoryProjection(
      git.repositoryRoot,
      git.head,
      git.statusEntries,
    );
  } catch (error) {
    return prefixedDigest(
      canonicalJson({
        schema: 'investigation-v3-publication-git-state-unavailable.v1',
        repositoryRealPath: git.repositoryRealPath,
        gitCommonDirectory: git.gitCommonDirectory,
        branch: git.branch,
        head: git.head,
        tree: git.tree,
        statusEntries: [...git.statusEntries].sort(),
        errorCode: boundedObservationErrorCode(error),
      }),
    );
  }
  return prefixedDigest(
    canonicalJson({
      schema: 'investigation-v3-publication-git-state.v2',
      repositoryRealPath: git.repositoryRealPath,
      gitCommonDirectory: git.gitCommonDirectory,
      branch: git.branch,
      head: git.head,
      tree: git.tree,
      statusEntries: [...git.statusEntries].sort(),
      worktreeFingerprint,
    }),
  );
}

function safePublicationGitStateDigest(
  repositoryRoot: string,
): `sha256:${string}` {
  try {
    return investigationManifestPublicationGitStateDigest(
      discoverRepository(repositoryRoot),
    );
  } catch (error) {
    return prefixedDigest(
      canonicalJson({
        schema: 'investigation-v3-publication-git-discovery-unavailable.v1',
        repositoryRoot: path.resolve(repositoryRoot),
        errorCode: boundedObservationErrorCode(error),
      }),
    );
  }
}

function boundedObservationErrorCode(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z][A-Z0-9_]{0,255}$/.test(error.code)
  ) {
    return error.code;
  }
  return 'OBSERVATION_UNAVAILABLE';
}

function prefixedDigest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function digest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return value;
}
