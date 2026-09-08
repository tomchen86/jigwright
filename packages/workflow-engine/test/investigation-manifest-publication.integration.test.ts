import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectInvestigationManifestPublication,
  resumeInvestigationManifestPublication,
  readInvestigationPublicationRefState,
  investigationManifestPublicationNamespace,
  type InvestigationManifestPublicationPaths,
  type InvestigationManifestPublicationLifecycleIdentity,
  type InvestigationManifestPublicationSnapshot,
  type InvestigationManifestPublicationPhase,
  publishInvestigationManifestV3,
} from '../src/runtime/managed-documents/transaction/investigation-publication.ts';
import fs from 'node:fs';
import { WorkflowError } from '../src/foundation/errors/errors.ts';
import path from 'node:path';
import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  writeInvestigationV3FailureObservation,
  investigationV3FailureObservationPath,
} from '../src/runtime/storage-journal/investigation-v3-failure-store.ts';
import {
  createInvestigationV3Blocker,
  type InvestigationManifestV3,
} from '../src/modules/investigation/manifest/investigation-manifest.ts';
import { createFixtureRepository, git } from './fixture.ts';
import { buildInvestigationManifestV3 } from '../src/modules/investigation/manifest/investigation-manifest-builder.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import { publishTrackedInvestigationManifestV3 } from '../src/application/propose/propose-orchestrator.ts';
import {
  digest,
  directBuilderInput,
} from './investigation-manifest-fixture.ts';

test('ordinary application publication inspects a prepared journal before safe pre-ref recovery', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const manifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'prepared-current',
    });
    const interrupted = interruptOrdinaryPublication(
      repository,
      manifest,
      'journal-prepared',
    );
    assert.equal(interrupted.result.outcome, 'blocked');

    publishOrdinaryThroughApplication(repository, manifest);

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot: interrupted.context.git.gitCommonDirectory,
      paths: interrupted.paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'committed');
    assert.equal(
      readStoredPublicationOutcome(repository, manifest.investigationId).kind,
      'investigation-v3-failure-cleared',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication refuses a prepared journal for a different direct Manifest identity', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const preparedManifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'prepared-prior',
    });
    const directManifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'prepared-direct',
    });
    assert.notEqual(
      preparedManifest.manifestDigest,
      directManifest.manifestDigest,
    );
    const interrupted = interruptOrdinaryPublication(
      repository,
      preparedManifest,
      'journal-prepared',
    );
    const expectedInspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot: interrupted.context.git.gitCommonDirectory,
      paths: interrupted.paths,
      lifecycle: publicationLifecycle(directManifest),
    });
    assert.equal(expectedInspection.outcome, 'recoverable');
    if (
      expectedInspection.outcome !== 'recoverable' ||
      expectedInspection.recoveryKind !== 'pre-ref'
    ) {
      assert.fail('expected a pre-ref recovery inspection');
    }

    let thrown: WorkflowError | null = null;
    try {
      publishOrdinaryThroughApplication(repository, directManifest);
      assert.fail('identity mismatch publication unexpectedly succeeded');
    } catch (error) {
      assert.ok(error instanceof WorkflowError);
      thrown = error;
    }
    assert.equal(thrown.code, 'RECONSTRUCTION_MISMATCH');
    assert.equal(
      fs.existsSync(
        path.join(
          interrupted.context.git.gitCommonDirectory,
          interrupted.paths.currentRefPath,
        ),
      ),
      false,
    );
    const storedBytes = readStoredPublicationBytes(
      repository,
      directManifest.investigationId,
    );
    const stored = JSON.parse(storedBytes) as {
      failure: {
        blocker: { failureCode: string; failureIdentity: string };
        source: {
          observation: { operation: string };
          failureIdentity: string;
        };
      };
    };
    assert.equal(storedBytes, `${canonicalJson(stored)}\n`);
    assert.equal(stored.failure.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    assert.equal(
      stored.failure.blocker.failureIdentity,
      thrown.details?.failureIdentity,
    );
    assert.equal(
      stored.failure.source.failureIdentity,
      stored.failure.blocker.failureIdentity,
    );
    assert.equal(stored.failure.source.observation.operation, 'inspect');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication persists the exact resume failure after current-ref CAS drift', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const manifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'cas-current',
    });
    const driftManifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'cas-drift',
    });
    const interrupted = interruptOrdinaryPublication(
      repository,
      manifest,
      'journal-prepared',
    );
    const currentRefPath = path.join(
      interrupted.context.git.gitCommonDirectory,
      interrupted.paths.currentRefPath,
    );
    writeCanonicalTestJson(
      currentRefPath,
      publicationCurrentRef(interrupted.paths.manifestPath, driftManifest),
    );
    const driftBytes = fs.readFileSync(currentRefPath);
    const expectedResume = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot: interrupted.context.git.gitCommonDirectory,
      paths: interrupted.paths,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) =>
        operation(publicationSnapshot(repository, interrupted.paths, manifest)),
    });
    assert.equal(expectedResume.outcome, 'blocked');
    if (expectedResume.outcome !== 'blocked') {
      assert.fail('expected current-ref drift to block recovery');
    }
    assert.equal(expectedResume.blocker.failureCode, 'REVIEW_TARGET_STALE');

    assert.throws(
      () => publishOrdinaryThroughApplication(repository, manifest),
      (error: unknown) =>
        error instanceof WorkflowError && error.code === 'REVIEW_TARGET_STALE',
    );
    assert.deepEqual(fs.readFileSync(currentRefPath), driftBytes);
    assert.equal(
      readStoredPublicationBytes(repository, manifest.investigationId),
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'investigation-v3-publication-failure-observation',
        authorityEligible: false,
        failure: expectedResume.failure,
      })}\n`,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication commits an exact post-ref recovery without replacing Manifest bytes', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const manifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'post-ref-current',
    });
    const interrupted = interruptOrdinaryPublication(
      repository,
      manifest,
      'current-ref-published',
    );
    const manifestPath = path.join(repository, interrupted.paths.manifestPath);
    const installed = fs.statSync(manifestPath, { bigint: true });

    publishOrdinaryThroughApplication(repository, manifest);

    const recovered = fs.statSync(manifestPath, { bigint: true });
    assert.deepEqual(
      { dev: recovered.dev, ino: recovered.ino },
      { dev: installed.dev, ino: installed.ino },
    );
    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot: interrupted.context.git.gitCommonDirectory,
      paths: interrupted.paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'committed');
    assert.equal(
      readStoredPublicationOutcome(repository, manifest.investigationId).kind,
      'investigation-v3-failure-cleared',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication accepts a fresh revision after a committed same-path Manifest', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const revisionN = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'revision-n',
    });
    const revisionNPlusOne = ordinaryPublicationManifest(repository, {
      revision: 8,
      variant: 'revision-n-plus-one',
    });

    publishOrdinaryThroughApplication(repository, revisionN);
    publishOrdinaryThroughApplication(repository, revisionNPlusOne);

    const { context, paths } = ordinaryPublicationState(
      repository,
      revisionNPlusOne,
    );
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(
          path.join(context.git.gitCommonDirectory, paths.currentRefPath),
          'utf8',
        ),
      ),
      publicationCurrentRef(paths.manifestPath, revisionNPlusOne),
    );
    assert.equal(
      JSON.parse(
        fs.readFileSync(path.join(repository, paths.manifestPath), 'utf8'),
      ).manifestDigest,
      revisionNPlusOne.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication persists an unsafe current-ref read failure byte-for-byte', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const manifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'unsafe-ref',
    });
    const { context, paths } = ordinaryPublicationState(repository, manifest);
    const currentRefPath = path.join(
      context.git.gitCommonDirectory,
      paths.currentRefPath,
    );
    const symlinkTarget = path.join(
      context.git.gitCommonDirectory,
      'unsafe-current-ref-target.json',
    );
    fs.mkdirSync(path.dirname(currentRefPath), { recursive: true });
    fs.writeFileSync(symlinkTarget, '{}\n');
    fs.symlinkSync(symlinkTarget, currentRefPath);
    const expectedRead = readInvestigationPublicationRefState({
      repositoryRoot: repository,
      privateRoot: context.git.gitCommonDirectory,
      currentRefPath: paths.currentRefPath,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(expectedRead.outcome, 'blocked');
    if (expectedRead.outcome !== 'blocked') {
      assert.fail('expected unsafe current-ref read to block');
    }

    assert.throws(
      () => publishOrdinaryThroughApplication(repository, manifest),
      (error: unknown) =>
        error instanceof WorkflowError &&
        error.code === expectedRead.blocker.failureCode,
    );
    assert.equal(
      readStoredPublicationBytes(repository, manifest.investigationId),
      `${canonicalJson({
        schemaVersion: 1,
        kind: 'investigation-v3-publication-failure-observation',
        authorityEligible: false,
        failure: expectedRead.failure,
      })}\n`,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('ordinary application publication success clears a prior generic failure into a tombstone', () => {
  const repository = createOrdinaryPublicationRepository();
  try {
    const manifest = ordinaryPublicationManifest(repository, {
      revision: 7,
      variant: 'success-clear',
    });
    const { context } = ordinaryPublicationState(repository, manifest);
    writeInvestigationV3FailureObservation({
      runtime: context.runtime,
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
      emission: {
        schemaVersion: 1,
        sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
        currentRefDigest: `sha256:${digest('prior-current-ref')}`,
        effectiveState: 'investigation-sealed',
        lifecycleStateDigest: `sha256:${digest('prior-lifecycle-state')}`,
        gitStateDigest: `sha256:${digest('prior-git-state')}`,
      },
      blocker: createInvestigationV3Blocker({
        attemptedTransition: 'build-draft',
        candidate: { variant: 'prior-generic-failure' },
        failureCode: 'RECONSTRUCTION_MISMATCH',
        message: 'Seed a prior generic failure for success clearance.',
      }),
    });

    publishOrdinaryThroughApplication(repository, manifest);

    assert.deepEqual(
      readStoredPublicationOutcome(repository, manifest.investigationId),
      {
        schemaVersion: 1,
        kind: 'investigation-v3-failure-cleared',
        authorityEligible: false,
        repositoryId: manifest.repositoryId,
        changeId: manifest.changeId,
        investigationId: manifest.investigationId,
        sessionRevision: manifest.authoring.sessionRevision,
        sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
        manifestDigest: manifest.manifestDigest,
      },
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function createOrdinaryPublicationRepository(): string {
  const repository = createFixtureRepository();
  fs.writeFileSync(
    path.join(repository, 'src/domain.ts'),
    'export const ManifestFirst = "manifest-first";\n',
  );
  git(repository, ['add', '--', 'src/domain.ts']);
  git(repository, ['commit', '-m', 'Add ordinary publication fixture']);
  fs.mkdirSync(path.join(repository, 'openspec/changes/manifest-first-v3'), {
    recursive: true,
  });
  return repository;
}

function ordinaryPublicationManifest(
  repository: string,
  input: { revision: number; variant: string },
): InvestigationManifestV3 {
  const base = directBuilderInput(repository);
  const sessionSnapshotDigest = digest(
    `publication-session-snapshot:${input.revision}`,
  );
  const built = buildInvestigationManifestV3({
    ...base,
    repositoryId: 'fixture',
    authoring: {
      sessionRevision: input.revision,
      sessionSnapshotDigest,
    },
    approval: {
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:investigation-approval',
      },
      approvalProvenanceDigest: digest(`publication-approval:${input.variant}`),
    },
    expected: {
      repositoryId: 'fixture',
      changeId: base.changeId,
      investigationId: base.investigationId,
      sessionRevision: input.revision,
      sessionSnapshotDigest,
    },
  });
  if (built.outcome !== 'built') {
    assert.fail(canonicalJson(built.blocker));
  }
  return built.manifest;
}

function ordinaryPublicationState(
  repository: string,
  manifest: InvestigationManifestV3,
) {
  const context = loadInvestigationRuntimeContext(repository);
  const lifecycle = publicationLifecycle(manifest);
  const namespace = investigationManifestPublicationNamespace(lifecycle);
  const paths: InvestigationManifestPublicationPaths = {
    manifestPath: `${context.config.changeRoot}/${manifest.changeId}/investigation.json`,
    currentRefPath: `${context.config.runtimeDirectory}/${namespace}/current.json`,
    journalPath: `${context.config.runtimeDirectory}/${namespace}/journal.json`,
  };
  return { context, lifecycle, paths };
}

function publicationLifecycle(
  manifest: InvestigationManifestV3,
): InvestigationManifestPublicationLifecycleIdentity {
  return {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    sessionRevision: manifest.authoring.sessionRevision,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
  };
}

function publicationSnapshot(
  repository: string,
  paths: InvestigationManifestPublicationPaths,
  manifest: InvestigationManifestV3,
): InvestigationManifestPublicationSnapshot {
  const context = loadInvestigationRuntimeContext(repository);
  const lifecycle = publicationLifecycle(manifest);
  const observed = readInvestigationPublicationRefState({
    repositoryRoot: repository,
    privateRoot: context.git.gitCommonDirectory,
    currentRefPath: paths.currentRefPath,
    lifecycle,
  });
  if (observed.outcome !== 'read') {
    assert.fail(canonicalJson(observed.blocker));
  }
  return { ...lifecycle, currentRefDigest: observed.currentRefDigest };
}

function interruptOrdinaryPublication(
  repository: string,
  manifest: InvestigationManifestV3,
  phase: InvestigationManifestPublicationPhase,
) {
  const { context, lifecycle, paths } = ordinaryPublicationState(
    repository,
    manifest,
  );
  const expected = publicationSnapshot(repository, paths, manifest);
  const result = publishInvestigationManifestV3({
    repositoryRoot: repository,
    privateRoot: context.git.gitCommonDirectory,
    paths,
    manifest,
    expected,
    withTransitionLock: (operation) =>
      operation(publicationSnapshot(repository, paths, manifest)),
    observePhase: (observed) => {
      if (observed === phase) throw new Error(`interrupt after ${observed}`);
    },
  });
  return { context, lifecycle, paths, expected, result };
}

function publishOrdinaryThroughApplication(
  repository: string,
  manifest: InvestigationManifestV3,
): void {
  const context = loadInvestigationRuntimeContext(repository);
  publishTrackedInvestigationManifestV3({
    context,
    manifest,
    assertOwned() {},
    assertCurrent() {},
  });
}

function publicationCurrentRef(
  manifestPath: string,
  manifest: InvestigationManifestV3,
) {
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

function readStoredPublicationBytes(
  repository: string,
  investigationId: string,
): string {
  const context = loadInvestigationRuntimeContext(repository);
  return fs.readFileSync(
    investigationV3FailureObservationPath(context.runtime, investigationId),
    'utf8',
  );
}

function readStoredPublicationOutcome(
  repository: string,
  investigationId: string,
): Record<string, unknown> {
  return JSON.parse(
    readStoredPublicationBytes(repository, investigationId),
  ) as Record<string, unknown>;
}

function writeCanonicalTestJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${canonicalJson(value)}\n`);
}
