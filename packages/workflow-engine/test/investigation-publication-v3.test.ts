import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import { sealInvestigationManifestDraft } from '../src/modules/investigation/manifest/investigation-manifest.ts';
import { buildInvestigationManifestDraft } from '../src/composition-root/investigation-production.ts';
import { type ExemptionInvestigationAuthoringState } from '../src/modules/investigation/manifest/investigation-manifest-types.ts';
import {
  inspectInvestigationManifestPublication,
  observeInvestigationManifestPublicationState,
  publishInvestigationManifestV3,
  readBoundInvestigationManifestPublicationRef,
  readInvestigationPublicationRefState,
  resumeInvestigationManifestPublication,
} from '../src/runtime/managed-documents/transaction/investigation-publication.ts';
import {
  investigationManifestPublicationNamespace,
  investigationManifestPublicationSourceMatchesLifecycle,
} from '../src/modules/investigation/manifest/investigation-publication-contracts.ts';
import { git } from './fixture.ts';

test('minimal durable publication installs its same-directory candidate by rename', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('same-directory-rename');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const phases: string[] = [];
    let candidateIdentity: { dev: bigint; ino: bigint } | null = null;
    let candidateAbsolute = '';

    const published = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        phases.push(phase);
        if (phase === 'candidate-written') {
          candidateAbsolute = path.join(
            repository,
            publicationCandidatePath(
              paths.manifestPath,
              expected,
              publicationCurrentRef(paths.manifestPath, manifest),
            ),
          );
          const candidate = fs.statSync(candidateAbsolute, { bigint: true });
          candidateIdentity = { dev: candidate.dev, ino: candidate.ino };
        }
        if (phase === 'manifest-installed') {
          const installed = fs.statSync(
            path.join(repository, paths.manifestPath),
            { bigint: true },
          );
          assert.deepEqual(
            { dev: installed.dev, ino: installed.ino },
            candidateIdentity,
          );
          assert.equal(fs.existsSync(candidateAbsolute), false);
        }
      },
    });

    assert.equal(published.outcome, 'published');
    assert.deepEqual(phases, [
      'journal-prepared',
      'candidate-written',
      'manifest-installed',
      'current-ref-published',
      'journal-committed',
    ]);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication compensates a parent relocation during the exact Manifest rename', () => {
  const repository = createRepository();
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'publication-relocated-'),
  );
  const movedDirectory = path.join(outside, 'moved');
  const originalRename = fs.renameSync;
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('relocated-parent');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const directory =
      fs.realpathSync(repository) + '/' + path.dirname(paths.manifestPath);
    let moved = false;
    let journalBytes: Buffer | undefined;
    fs.renameSync = (source, target) => {
      originalRename(source, target);
      if (
        !moved &&
        target === path.basename(paths.manifestPath) &&
        fs.realpathSync('.') === directory
      ) {
        moved = true;
        originalRename(directory, movedDirectory);
      }
    };
    const result = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase(phase) {
        if (phase === 'candidate-written')
          journalBytes = fs.readFileSync(
            path.join(repository, paths.journalPath),
          );
      },
    });
    assert.equal(moved, true);
    assert.equal(result.outcome, 'blocked');
    if (result.outcome === 'blocked')
      assert.equal(result.blocker.failureCode, 'PUBLICATION_RECOVERY_REQUIRED');
    assert.equal(
      fs.existsSync(
        path.join(movedDirectory, path.basename(paths.manifestPath)),
      ),
      false,
    );
    assert.equal(
      fs.existsSync(
        path.join(movedDirectory, path.basename(paths.currentRefPath)),
      ),
      false,
    );
    assert.deepEqual(
      fs.readFileSync(
        path.join(movedDirectory, path.basename(paths.journalPath)),
      ),
      journalBytes,
    );
    assert.deepEqual(JSON.parse(journalBytes!.toString()).manifest, manifest);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('minimal durable publication resumes from its self-contained journal alone', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('journal-only');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'journal-prepared') {
          throw new Error('simulated journal-only crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');

    const journal = readJsonAt<{
      paths: { candidatePath: string };
      manifest: { manifestDigest: string };
    }>(repository, paths.journalPath);
    assert.equal(journal.manifest.manifestDigest, manifest.manifestDigest);
    const candidate = path.join(repository, journal.paths.candidatePath);
    assert.equal(fs.existsSync(candidate), false);
    assert.equal(
      fs.existsSync(path.join(repository, paths.manifestPath)),
      false,
    );
    assert.equal(
      fs.existsSync(path.join(repository, paths.currentRefPath)),
      false,
    );

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(resumed.outcome, 'published');
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(repository, paths.manifestPath)
        .manifestDigest,
      manifest.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication resume removes only its transaction-owned abandoned candidate temporaries', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('abandoned-candidate-temporary');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'journal-prepared') {
          throw new Error('simulated writer crash before candidate rename');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');

    const journal = readJsonAt<{
      paths: { candidatePath: string };
    }>(repository, paths.journalPath);
    const candidate = path.join(repository, journal.paths.candidatePath);
    const abandonedTemporary = `${candidate}.424242.${crypto.randomUUID()}.tmp`;
    const malformedSamePrefix = `${candidate}.not-a-pid.${crypto.randomUUID()}.tmp`;
    const otherTransactionTemporary = path.join(
      repository,
      `${paths.manifestPath}.${'f'.repeat(64)}.candidate.424242.${crypto.randomUUID()}.tmp`,
    );
    fs.writeFileSync(abandonedTemporary, '{"partial":');
    fs.writeFileSync(malformedSamePrefix, 'unowned sentinel\n');
    fs.writeFileSync(otherTransactionTemporary, 'other transaction sentinel\n');

    const inspected = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspected.outcome, 'recoverable');
    if (inspected.outcome === 'recoverable') {
      assert.equal(inspected.recoveryKind, 'pre-ref');
    }
    assert.equal(fs.existsSync(abandonedTemporary), true);
    assert.equal(fs.existsSync(malformedSamePrefix), true);
    assert.equal(fs.existsSync(otherTransactionTemporary), true);

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(resumed.outcome, 'published');
    assert.equal(fs.existsSync(abandonedTemporary), false);
    assert.equal(fs.existsSync(malformedSamePrefix), true);
    assert.equal(fs.existsSync(otherTransactionTemporary), true);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('minimal durable publication never overwrites an unresolved prepared journal', () => {
  const repository = createRepository();
  try {
    const first = sealedExemption(repository, 3);
    const paths = publicationPaths('prepared-journal-owner');
    const firstExpected = publicationExpected(
      repository,
      paths.currentRefPath,
      first,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest: first,
      expected: firstExpected,
      withTransitionLock: (operation) => operation(firstExpected),
      observePhase: (phase) => {
        if (phase === 'journal-prepared') throw new Error('prepared stop');
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    const preparedBefore = fs.readFileSync(
      path.join(repository, paths.journalPath),
    );

    const second = sealedExemption(repository, 4);
    const secondExpected = publicationExpected(
      repository,
      paths.currentRefPath,
      second,
    );
    const replacement = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest: second,
      expected: secondExpected,
      withTransitionLock: (operation) => operation(secondExpected),
    });
    assert.equal(replacement.outcome, 'blocked');
    if (replacement.outcome === 'blocked') {
      assert.equal(
        replacement.blocker.failureCode,
        'PUBLICATION_RECOVERY_REQUIRED',
      );
    }
    assert.deepEqual(
      fs.readFileSync(path.join(repository, paths.journalPath)),
      preparedBefore,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

for (const crashPhase of [
  'journal-prepared',
  'candidate-written',
  'manifest-installed',
  'current-ref-published',
  'journal-committed',
] as const) {
  test(`minimal durable publication resumes after ${crashPhase} crash`, () => {
    const repository = createRepository();
    try {
      const manifest = sealedExemption(repository);
      const paths = publicationPaths(`phase-${crashPhase}`);
      const expected = publicationExpected(
        repository,
        paths.currentRefPath,
        manifest,
      );
      const interrupted = publishInvestigationManifestV3({
        repositoryRoot: repository,
        paths,
        manifest,
        expected,
        withTransitionLock: (operation) => operation(expected),
        observePhase: (phase) => {
          if (phase === crashPhase) throw new Error(`crash after ${phase}`);
        },
      });
      assert.equal(interrupted.outcome, 'blocked');

      const resumeExpected = publicationExpected(
        repository,
        paths.currentRefPath,
        manifest,
      );
      const resumed = resumeInvestigationManifestPublication({
        repositoryRoot: repository,
        paths,
        lifecycle: publicationLifecycle(manifest),
        withTransitionLock: (operation) => operation(resumeExpected),
      });
      assert.equal(resumed.outcome, 'published');
      assert.equal(
        inspectInvestigationManifestPublication({
          repositoryRoot: repository,
          paths,
          lifecycle: publicationLifecycle(manifest),
        }).outcome,
        'committed',
      );
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

test('v3 publication performs lock-scoped CAS and publishes Manifest before its current ref', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('ordinary');
    const expected = {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
      currentRefDigest: currentRefDigest(
        repository,
        paths.currentRefPath,
        manifest,
      ),
    };
    const phases: string[] = [];
    const published = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => phases.push(phase),
    });
    assert.equal(published.outcome, 'published');
    if (published.outcome !== 'published') assert.fail('publication blocked');
    assert.deepEqual(phases, [
      'journal-prepared',
      'candidate-written',
      'manifest-installed',
      'current-ref-published',
      'journal-committed',
    ]);
    const tracked = JSON.parse(
      fs.readFileSync(path.join(repository, paths.manifestPath), 'utf8'),
    ) as { manifestDigest: string };
    const current = JSON.parse(
      fs.readFileSync(path.join(repository, paths.currentRefPath), 'utf8'),
    ) as { manifestDigest: string };
    assert.equal(tracked.manifestDigest, manifest.manifestDigest);
    assert.equal(current.manifestDigest, manifest.manifestDigest);

    const stale = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected: { ...expected, currentRefDigest: '0'.repeat(64) },
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(stale.outcome, 'blocked');
    if (stale.outcome === 'blocked') {
      assert.equal(stale.blocker.failureCode, 'REVIEW_TARGET_STALE');
      assert.equal(
        stale.failure.kind,
        'investigation-manifest-publication-failure',
      );
      assert.deepEqual(stale.failure.blocker, stale.blocker);
      assert.deepEqual(stale.failure.lifecycle, {
        repositoryId: expected.repositoryId,
        changeId: expected.changeId,
        investigationId: expected.investigationId,
        sessionRevision: expected.sessionRevision,
        sessionSnapshotDigest: expected.sessionSnapshotDigest,
      });
      assert.equal(stale.failure.source.observation.operation, 'publish');
      assert.equal(
        stale.failure.source.failureIdentity,
        stale.blocker.failureIdentity,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('v3 publication renames a same-directory candidate into the tracked Manifest', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const namespace = publicationTestNamespace();
    const paths = {
      manifestPath:
        'openspec/changes/' + manifest.changeId + '/investigation.json',
      currentRefPath: namespace + '/tracked-current.json',
      journalPath: namespace + '/tracked-journal.json',
    };
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const candidatePath = publicationCandidatePath(
      paths.manifestPath,
      expected,
      publicationCurrentRef(paths.manifestPath, manifest),
    );
    let candidateIdentity: { dev: bigint; ino: bigint } | null = null;

    const published = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'candidate-written') {
          assert.equal(
            path.dirname(candidatePath),
            path.dirname(paths.manifestPath),
          );
          const candidate = fs.statSync(path.join(repository, candidatePath), {
            bigint: true,
          });
          candidateIdentity = { dev: candidate.dev, ino: candidate.ino };
        }
        if (phase === 'manifest-installed') {
          const installed = fs.statSync(
            path.join(repository, paths.manifestPath),
            { bigint: true },
          );
          assert.deepEqual(
            { dev: installed.dev, ino: installed.ino },
            candidateIdentity,
          );
          assert.equal(
            fs.existsSync(path.join(repository, candidatePath)),
            false,
          );
        }
      },
    });

    assert.equal(published.outcome, 'published');
    const journal = readJsonAt<{
      paths: { candidatePath: string };
      manifest: { manifestDigest: string };
    }>(repository, paths.journalPath);
    assert.equal(journal.paths.candidatePath, candidatePath);
    assert.equal(journal.manifest.manifestDigest, manifest.manifestDigest);
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(repository, paths.manifestPath)
        .manifestDigest,
      manifest.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('tracked Manifest revisions recover journal-first over prior governed bytes', () => {
  const repository = createRepository();
  try {
    const first = sealedExemption(repository, 3);
    const namespace = publicationTestNamespace();
    const paths = {
      manifestPath: `openspec/changes/${first.changeId}/investigation.json`,
      currentRefPath: `${namespace}/tracked-revision-current.json`,
      journalPath: `${namespace}/tracked-revision-journal.json`,
    };
    const firstExpected = publicationExpected(
      repository,
      paths.currentRefPath,
      first,
    );
    assert.equal(
      publishInvestigationManifestV3({
        repositoryRoot: repository,
        paths,
        manifest: first,
        expected: firstExpected,
        withTransitionLock: (operation) => operation(firstExpected),
      }).outcome,
      'published',
    );

    const second = sealedExemption(repository, 4);
    const secondExpected = publicationExpected(
      repository,
      paths.currentRefPath,
      second,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest: second,
      expected: secondExpected,
      withTransitionLock: (operation) => operation(secondExpected),
      observePhase: (phase) => {
        if (phase === 'journal-prepared') {
          throw new Error('simulated tracked revision crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    if (interrupted.outcome === 'blocked') {
      assert.equal(
        interrupted.blocker.failureCode,
        'PUBLICATION_RECOVERY_REQUIRED',
      );
    }
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(repository, paths.manifestPath)
        .manifestDigest,
      first.manifestDigest,
    );
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(repository, paths.currentRefPath)
        .manifestDigest,
      first.manifestDigest,
    );

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(second),
      withTransitionLock: (operation) => operation(secondExpected),
    });
    assert.equal(resumed.outcome, 'published');
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(repository, paths.currentRefPath)
        .manifestDigest,
      second.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('linked-worktree publication resolves recovery state from an explicit git-common private root', () => {
  const repository = createRepository();
  const privateStorage = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-publication-private-'),
  );
  try {
    const manifest = sealedExemption(repository);
    const privateRoot = path.join(privateStorage, 'git-common');
    fs.renameSync(path.join(repository, '.git'), privateRoot);
    fs.writeFileSync(path.join(repository, '.git'), `gitdir: ${privateRoot}\n`);
    const namespace = `workflow-engine/${investigationManifestPublicationNamespace(
      publicationLifecycle(manifest),
    )}`;
    const paths = {
      manifestPath: `openspec/changes/${manifest.changeId}/investigation.json`,
      currentRefPath: `${namespace}/linked-current.json`,
      journalPath: `${namespace}/linked-journal.json`,
    };
    const expected = publicationExpectedWithRefDigest(
      manifest,
      missingPublicationRefDigest(),
    );

    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      privateRoot,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'manifest-installed') {
          throw new Error('simulated linked-worktree publication crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    assert.equal(
      fs.existsSync(path.join(privateRoot, paths.journalPath)),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(repository, paths.journalPath)),
      false,
    );
    const observation = observeInvestigationManifestPublicationState({
      repositoryRoot: repository,
      privateRoot,
      source: { operation: 'inspect', paths },
    });
    assert.equal(observation.recoveryKind, 'pre-ref');
    assert.equal(
      observation.artifacts.find(
        ({ path: artifactPath }) => artifactPath === paths.manifestPath,
      )?.state,
      'file',
    );
    assert.equal(
      observation.artifacts.find(
        ({ path: artifactPath }) => artifactPath === paths.journalPath,
      )?.state,
      'file',
    );

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'recoverable');
    if (inspection.outcome === 'recoverable') {
      assert.equal(inspection.recoveryKind, 'pre-ref');
      assert.equal(inspection.manifestDigest, manifest.manifestDigest);
      assert.equal(
        inspection.investigationTargetDigest,
        manifest.investigationApproval.investigationTargetDigest,
      );
    }

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      privateRoot,
      paths,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(resumed.outcome, 'published');
    assert.equal(
      readJsonAt<{ manifestPath: string }>(privateRoot, paths.currentRefPath)
        .manifestPath,
      paths.manifestPath,
    );
    assert.equal(
      readInvestigationPublicationRefState({
        repositoryRoot: repository,
        privateRoot,
        currentRefPath: paths.currentRefPath,
        lifecycle: publicationLifecycle(manifest),
      }).outcome,
      'read',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(privateStorage, { recursive: true, force: true });
  }
});

test('a crash between Manifest install and ref publication is classified and resumable', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('crash');
    const expected = {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
      currentRefDigest: currentRefDigest(
        repository,
        paths.currentRefPath,
        manifest,
      ),
    };
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'manifest-installed') {
          throw new Error('simulated crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    assert.equal(
      fs.existsSync(path.join(repository, paths.currentRefPath)),
      false,
    );
    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'recoverable');
    if (inspection.outcome === 'recoverable') {
      assert.equal(inspection.recoveryKind, 'pre-ref');
      assert.equal(inspection.manifestDigest, manifest.manifestDigest);
      assert.equal(
        inspection.investigationTargetDigest,
        manifest.investigationApproval.investigationTargetDigest,
      );
      if (inspection.recoveryKind === 'pre-ref') {
        assert.equal(
          inspection.blocker.failureCode,
          'PUBLICATION_RECOVERY_REQUIRED',
        );
      }
    }

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(resumed.outcome, 'published');
    const after = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(after.outcome, 'committed');
    if (after.outcome === 'committed') {
      assert.equal(after.manifestDigest, manifest.manifestDigest);
      assert.equal(
        after.investigationTargetDigest,
        manifest.investigationApproval.investigationTargetDigest,
      );
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('recovery accepts the transaction-installed ref while preserving lifecycle identity', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('ref-installed-crash');
    const expected = {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
      currentRefDigest: currentRefDigest(
        repository,
        paths.currentRefPath,
        manifest,
      ),
    };
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'current-ref-published') {
          throw new Error('simulated crash after authority ref publication');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'recoverable');
    if (inspection.outcome === 'recoverable') {
      assert.equal(inspection.recoveryKind, 'post-ref');
      assert.equal(inspection.manifestDigest, manifest.manifestDigest);
      assert.equal(
        inspection.investigationTargetDigest,
        manifest.investigationApproval.investigationTargetDigest,
      );
      assert.equal('blocker' in inspection, false);
    }

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) =>
        operation({
          ...expected,
          currentRefDigest: currentRefDigest(
            repository,
            paths.currentRefPath,
            manifest,
          ),
        }),
    });
    assert.equal(resumed.outcome, 'published');
    assert.equal(
      inspectInvestigationManifestPublication({
        repositoryRoot: repository,
        paths,
        lifecycle: publicationLifecycle(manifest),
      }).outcome,
      'committed',
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('an unknown pre-mutation publication exception retains the generic mismatch code', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('generic-pre-mutation-error');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const blocked = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: () => {
        throw new Error('unexpected lock adapter failure');
      },
    });
    assert.equal(blocked.outcome, 'blocked');
    if (blocked.outcome === 'blocked') {
      assert.equal(blocked.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('replacement publication keeps the prior authority readable until a fresh Manifest path is switched', () => {
  const repository = createRepository();
  try {
    const first = sealedExemption(repository, 3);
    const namespace = publicationTestNamespace();
    const currentRefPath = `${namespace}/replacement-current.json`;
    const firstPaths = {
      manifestPath: `${namespace}/replacement-generation-1.json`,
      currentRefPath,
      journalPath: `${namespace}/replacement-generation-1-journal.json`,
    };
    const firstExpected = publicationExpected(
      repository,
      firstPaths.currentRefPath,
      first,
    );
    assert.equal(
      publishInvestigationManifestV3({
        repositoryRoot: repository,
        paths: firstPaths,
        manifest: first,
        expected: firstExpected,
        withTransitionLock: (operation) => operation(firstExpected),
      }).outcome,
      'published',
    );

    const second = sealedExemption(repository, 4);
    const secondPaths = {
      manifestPath: `${namespace}/replacement-generation-2.json`,
      currentRefPath,
      journalPath: `${namespace}/replacement-generation-2-journal.json`,
    };
    const secondExpected = publicationExpected(
      repository,
      secondPaths.currentRefPath,
      second,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: secondPaths,
      manifest: second,
      expected: secondExpected,
      withTransitionLock: (operation) => operation(secondExpected),
      observePhase: (phase) => {
        if (phase === 'manifest-installed') {
          throw new Error('simulated replacement crash before ref switch');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');

    const currentBeforeResume = readJsonAt<{
      manifestPath: string;
      manifestDigest: string;
    }>(repository, currentRefPath);
    assert.equal(currentBeforeResume.manifestPath, firstPaths.manifestPath);
    assert.equal(currentBeforeResume.manifestDigest, first.manifestDigest);
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(
        repository,
        firstPaths.manifestPath,
      ).manifestDigest,
      first.manifestDigest,
    );
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(
        repository,
        secondPaths.manifestPath,
      ).manifestDigest,
      second.manifestDigest,
    );

    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths: secondPaths,
      lifecycle: publicationLifecycle(second),
      withTransitionLock: (operation) => operation(secondExpected),
    });
    assert.equal(resumed.outcome, 'published');
    const currentAfterResume = readJsonAt<{
      manifestPath: string;
      manifestDigest: string;
    }>(repository, currentRefPath);
    assert.equal(currentAfterResume.manifestPath, secondPaths.manifestPath);
    assert.equal(currentAfterResume.manifestDigest, second.manifestDigest);

    const unsafeReplacementPaths = {
      manifestPath: secondPaths.manifestPath,
      currentRefPath,
      journalPath: `${namespace}/replacement-generation-3-journal.json`,
    };
    const third = sealedExemption(repository, 5);
    const thirdExpected = publicationExpected(
      repository,
      currentRefPath,
      third,
    );
    const unsafeReplacement = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: unsafeReplacementPaths,
      manifest: third,
      expected: thirdExpected,
      withTransitionLock: (operation) => operation(thirdExpected),
    });
    assert.equal(unsafeReplacement.outcome, 'blocked');
    if (unsafeReplacement.outcome === 'blocked') {
      assert.equal(
        unsafeReplacement.blocker.failureCode,
        'MANIFEST_UNREPRESENTABLE',
      );
    }
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(
        repository,
        secondPaths.manifestPath,
      ).manifestDigest,
      second.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('replacement publication rejects a raw Manifest path alias before it can overwrite the current target', () => {
  const repository = createRepository();
  try {
    const first = sealedExemption(repository, 3);
    const namespace = publicationTestNamespace();
    const currentRefPath = `${namespace}/alias-current.json`;
    const manifestPath = `${namespace}/alias-generation-1.json`;
    const firstPaths = {
      manifestPath,
      currentRefPath,
      journalPath: `${namespace}/alias-generation-1-journal.json`,
    };
    const firstExpected = publicationExpected(
      repository,
      currentRefPath,
      first,
    );
    assert.equal(
      publishInvestigationManifestV3({
        repositoryRoot: repository,
        paths: firstPaths,
        manifest: first,
        expected: firstExpected,
        withTransitionLock: (operation) => operation(firstExpected),
      }).outcome,
      'published',
    );

    const second = sealedExemption(repository, 4);
    const aliasedPaths = {
      manifestPath: `${path.posix.dirname(manifestPath)}/./${path.posix.basename(manifestPath)}`,
      currentRefPath,
      journalPath: `${namespace}/alias-generation-2-journal.json`,
    };
    const secondExpected = publicationExpected(
      repository,
      currentRefPath,
      second,
    );
    const replacement = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: aliasedPaths,
      manifest: second,
      expected: secondExpected,
      withTransitionLock: (operation) => operation(secondExpected),
    });

    assert.equal(replacement.outcome, 'blocked');
    if (replacement.outcome === 'blocked') {
      assert.equal(replacement.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
    }
    assert.deepEqual(
      readJsonAt<{ manifestPath: string; manifestDigest: string }>(
        repository,
        currentRefPath,
      ),
      {
        schemaVersion: 1,
        kind: 'investigation-manifest-current',
        repositoryId: first.repositoryId,
        changeId: first.changeId,
        investigationId: first.investigationId,
        manifestDigest: first.manifestDigest,
        investigationTargetDigest:
          first.investigationApproval.investigationTargetDigest,
        manifestPath,
      },
    );
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(repository, manifestPath)
        .manifestDigest,
      first.manifestDigest,
    );

    const persistedAlias = readJsonAt<Record<string, unknown>>(
      repository,
      currentRefPath,
    );
    persistedAlias.manifestPath = aliasedPaths.manifestPath;
    writeJson(path.join(repository, currentRefPath), persistedAlias);
    const persistedAliasExpected = publicationExpected(
      repository,
      currentRefPath,
      second,
    );
    const reverseAliasReplacement = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: {
        manifestPath,
        currentRefPath,
        journalPath: `${namespace}/alias-generation-3-journal.json`,
      },
      manifest: second,
      expected: persistedAliasExpected,
      withTransitionLock: (operation) => operation(persistedAliasExpected),
    });
    assert.equal(reverseAliasReplacement.outcome, 'blocked');
    if (reverseAliasReplacement.outcome === 'blocked') {
      assert.equal(
        reverseAliasReplacement.blocker.failureCode,
        'MANIFEST_UNREPRESENTABLE',
      );
    }
    assert.equal(
      readJsonAt<{ manifestDigest: string }>(repository, manifestPath)
        .manifestDigest,
      first.manifestDigest,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('lifecycle source matching admits only canonical lowercase-ASCII POSIX-relative publication paths', () => {
  const namespace = publicationTestNamespace();
  const lifecycle = {
    repositoryId: 'expense-app-publication-test',
    changeId: 'publication-v3',
    investigationId: 'publication-v3-test',
    sessionRevision: 1,
    sessionSnapshotDigest: 'a'.repeat(64),
  };
  const paths = publicationPaths('canonical-relative-path');
  assert.equal(
    investigationManifestPublicationSourceMatchesLifecycle(
      { operation: 'publish', paths },
      lifecycle,
    ),
    true,
  );

  const nonCanonicalManifestPaths = [
    `${namespace}//manifest.json`,
    `${namespace}/./manifest.json`,
    `${namespace}/nested/../manifest.json`,
    `${namespace}\\manifest.json`,
    `/${namespace}/manifest.json`,
    `${namespace}/manifest.json/`,
    `${namespace}/MANIFEST.json`,
  ];
  for (const manifestPath of nonCanonicalManifestPaths) {
    assert.equal(
      investigationManifestPublicationSourceMatchesLifecycle(
        { operation: 'publish', paths: { ...paths, manifestPath } },
        lifecycle,
      ),
      false,
      manifestPath,
    );
  }
});

test('publication rejects a derived candidate collision with the current ref before replacing old authority bytes', () => {
  const repository = createRepository();
  try {
    const first = sealedExemption(repository, 30);
    const second = sealedExemption(repository, 31);
    const namespace = publicationTestNamespace();
    const firstManifestPath = `${namespace}/candidate-current-first.json`;
    const secondManifestPath = `${namespace}/candidate-current-second.json`;
    const firstCurrentRef = publicationCurrentRef(firstManifestPath, first);
    const secondCurrentRef = publicationCurrentRef(secondManifestPath, second);
    const secondExpected = publicationExpectedWithRefDigest(
      second,
      publicationRefDigestForValue(firstCurrentRef),
    );
    const candidatePath = publicationCandidatePath(
      secondManifestPath,
      secondExpected,
      secondCurrentRef,
    );
    const firstExpected = publicationExpectedWithRefDigest(
      first,
      missingPublicationRefDigest(),
    );
    assert.equal(
      publishInvestigationManifestV3({
        repositoryRoot: repository,
        paths: {
          manifestPath: firstManifestPath,
          currentRefPath: candidatePath,
          journalPath: `${namespace}/candidate-current-first-journal.json`,
        },
        manifest: first,
        expected: firstExpected,
        withTransitionLock: (operation) => operation(firstExpected),
      }).outcome,
      'published',
    );
    const manifestBefore = fs.readFileSync(
      path.join(repository, firstManifestPath),
    );
    const currentRefBefore = fs.readFileSync(
      path.join(repository, candidatePath),
    );

    const phases: string[] = [];
    const result = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: {
        manifestPath: secondManifestPath,
        currentRefPath: candidatePath,
        journalPath: `${namespace}/candidate-current-second-journal.json`,
      },
      manifest: second,
      expected: secondExpected,
      withTransitionLock: (operation) => operation(secondExpected),
      observePhase: (phase) => phases.push(phase),
    });
    assert.equal(result.outcome, 'blocked');
    if (result.outcome === 'blocked') {
      assert.equal(result.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
    }
    assert.deepEqual(phases, []);
    assert.deepEqual(
      fs.readFileSync(path.join(repository, firstManifestPath)),
      manifestBefore,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(repository, candidatePath)),
      currentRefBefore,
    );
    assert.equal(
      fs.existsSync(path.join(repository, secondManifestPath)),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication rejects a derived candidate collision with the journal before leaving residue', () => {
  const repository = createRepository();
  try {
    const first = sealedExemption(repository, 32);
    const second = sealedExemption(repository, 33);
    const namespace = publicationTestNamespace();
    const firstManifestPath = `${namespace}/candidate-journal-first.json`;
    const secondManifestPath = `${namespace}/candidate-journal-second.json`;
    const currentRefPath = `${namespace}/candidate-journal-current.json`;
    const firstExpected = publicationExpectedWithRefDigest(
      first,
      missingPublicationRefDigest(),
    );
    assert.equal(
      publishInvestigationManifestV3({
        repositoryRoot: repository,
        paths: {
          manifestPath: firstManifestPath,
          currentRefPath,
          journalPath: `${namespace}/candidate-journal-first-journal.json`,
        },
        manifest: first,
        expected: firstExpected,
        withTransitionLock: (operation) => operation(firstExpected),
      }).outcome,
      'published',
    );
    const manifestBefore = fs.readFileSync(
      path.join(repository, firstManifestPath),
    );
    const currentRefBefore = fs.readFileSync(
      path.join(repository, currentRefPath),
    );

    const secondExpected = publicationExpected(
      repository,
      currentRefPath,
      second,
    );
    const candidatePath = publicationCandidatePath(
      secondManifestPath,
      secondExpected,
      publicationCurrentRef(secondManifestPath, second),
    );
    const phases: string[] = [];
    const result = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: {
        manifestPath: secondManifestPath,
        currentRefPath,
        journalPath: candidatePath,
      },
      manifest: second,
      expected: secondExpected,
      withTransitionLock: (operation) => operation(secondExpected),
      observePhase: (phase) => phases.push(phase),
    });
    assert.equal(result.outcome, 'blocked');
    if (result.outcome === 'blocked') {
      assert.equal(result.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
    }
    assert.deepEqual(phases, []);
    assert.deepEqual(
      fs.readFileSync(path.join(repository, firstManifestPath)),
      manifestBefore,
    );
    assert.deepEqual(
      fs.readFileSync(path.join(repository, currentRefPath)),
      currentRefBefore,
    );
    assert.equal(fs.existsSync(path.join(repository, candidatePath)), false);
    assert.equal(
      fs.existsSync(path.join(repository, secondManifestPath)),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication preflight rejects hardlinked roles and existing hardlinked candidates without residue', () => {
  const variants = ['manifest-journal', 'candidate-external'] as const;
  for (const [index, variant] of variants.entries()) {
    const repository = createRepository();
    try {
      const manifest = sealedExemption(repository, index + 40);
      const namespace = publicationTestNamespace();
      const paths = {
        manifestPath: `${namespace}/${variant}-manifest.json`,
        currentRefPath: `${namespace}/${variant}-current.json`,
        journalPath: `${namespace}/${variant}-journal.json`,
      };
      const expected = publicationExpectedWithRefDigest(
        manifest,
        missingPublicationRefDigest(),
      );
      const currentRef = publicationCurrentRef(paths.manifestPath, manifest);
      const candidatePath = publicationCandidatePath(
        paths.manifestPath,
        expected,
        currentRef,
      );
      const sentinelPath =
        variant === 'manifest-journal'
          ? paths.manifestPath
          : `${namespace}/candidate-external-sentinel.json`;
      const linkedPath =
        variant === 'manifest-journal' ? paths.journalPath : candidatePath;
      writeJson(path.join(repository, sentinelPath), {
        sentinel: variant,
      });
      fs.linkSync(
        path.join(repository, sentinelPath),
        path.join(repository, linkedPath),
      );
      const sentinelBefore = fs.readFileSync(
        path.join(repository, sentinelPath),
      );
      const linkedBefore = fs.readFileSync(path.join(repository, linkedPath));

      const phases: string[] = [];
      const result = publishInvestigationManifestV3({
        repositoryRoot: repository,
        paths,
        manifest,
        expected,
        withTransitionLock: (operation) => operation(expected),
        observePhase: (phase) => phases.push(phase),
      });
      assert.equal(result.outcome, 'blocked');
      if (result.outcome === 'blocked') {
        assert.equal(result.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
      }
      assert.deepEqual(phases, []);
      assert.deepEqual(
        fs.readFileSync(path.join(repository, sentinelPath)),
        sentinelBefore,
      );
      assert.deepEqual(
        fs.readFileSync(path.join(repository, linkedPath)),
        linkedBefore,
      );
      assert.equal(
        fs.existsSync(path.join(repository, paths.currentRefPath)),
        false,
      );
      if (variant === 'manifest-journal') {
        assert.equal(
          fs.existsSync(path.join(repository, candidatePath)),
          false,
        );
      } else {
        assert.equal(
          fs.existsSync(path.join(repository, paths.manifestPath)),
          false,
        );
        assert.equal(
          fs.existsSync(path.join(repository, paths.journalPath)),
          false,
        );
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('publication preflight rejects ancestor and descendant path roles without residue', () => {
  const variants = [
    {
      name: 'manifest-current',
      manifestPath(namespace: string) {
        return `${namespace}/manifest-current-role`;
      },
      paths(namespace: string, manifestPath: string, _candidatePath: string) {
        return {
          manifestPath,
          currentRefPath: `${manifestPath}/current.json`,
          journalPath: `${namespace}/manifest-current-journal.json`,
        };
      },
    },
    {
      name: 'current-manifest',
      manifestPath(namespace: string) {
        return `${namespace}/current-manifest-role/manifest.json`;
      },
      paths(namespace: string, manifestPath: string, _candidatePath: string) {
        return {
          manifestPath,
          currentRefPath: `${namespace}/current-manifest-role`,
          journalPath: `${namespace}/current-manifest-journal.json`,
        };
      },
    },
    {
      name: 'candidate-journal',
      manifestPath(namespace: string) {
        return `${namespace}/candidate-journal-manifest.json`;
      },
      paths(namespace: string, manifestPath: string, candidatePath: string) {
        return {
          manifestPath,
          currentRefPath: `${namespace}/candidate-journal-current.json`,
          journalPath: `${candidatePath}/journal.json`,
        };
      },
    },
    {
      name: 'candidate-current',
      manifestPath(namespace: string) {
        return `${namespace}/candidate-current-manifest.json`;
      },
      paths(namespace: string, manifestPath: string, candidatePath: string) {
        return {
          manifestPath,
          currentRefPath: `${candidatePath}/current.json`,
          journalPath: `${namespace}/candidate-current-journal.json`,
        };
      },
    },
  ];

  for (const [index, variant] of variants.entries()) {
    const repository = createRepository();
    try {
      const manifest = sealedExemption(repository, index + 60);
      const namespace = publicationTestNamespace();
      const manifestPath = variant.manifestPath(namespace);
      const expected = publicationExpectedWithRefDigest(
        manifest,
        missingPublicationRefDigest(),
      );
      const candidatePath = publicationCandidatePath(
        manifestPath,
        expected,
        publicationCurrentRef(manifestPath, manifest),
      );
      const paths = variant.paths(namespace, manifestPath, candidatePath);
      const phases: string[] = [];
      const result = publishInvestigationManifestV3({
        repositoryRoot: repository,
        paths,
        manifest,
        expected,
        withTransitionLock: (operation) => operation(expected),
        observePhase: (phase) => phases.push(phase),
      });
      assert.equal(result.outcome, 'blocked', variant.name);
      if (result.outcome === 'blocked') {
        assert.equal(
          result.blocker.failureCode,
          'MANIFEST_UNREPRESENTABLE',
          variant.name,
        );
      }
      assert.deepEqual(phases, [], variant.name);
      for (const relativePath of new Set([
        paths.manifestPath,
        paths.currentRefPath,
        paths.journalPath,
        candidatePath,
      ])) {
        assert.equal(
          fs.existsSync(path.join(repository, relativePath)),
          false,
          `${variant.name}: ${relativePath}`,
        );
      }
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  }
});

test('every public publication transition reduces unsafe paths to a structured v3 blocker', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const unsafe = {
      manifestPath: '../manifest.json',
      currentRefPath: '.git/workflow-engine/v3-test/unsafe-current.json',
      journalPath: '.git/workflow-engine/v3-test/unsafe-journal.json',
    };
    const expected = {
      repositoryId: manifest.repositoryId,
      changeId: manifest.changeId,
      investigationId: manifest.investigationId,
      sessionRevision: manifest.authoring.sessionRevision,
      sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
      currentRefDigest: '0'.repeat(64),
    };
    const publish = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths: unsafe,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    const inspect = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths: unsafe,
      lifecycle: publicationLifecycle(manifest),
    });
    const resume = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths: unsafe,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) => operation(expected),
    });
    const refState = readInvestigationPublicationRefState({
      repositoryRoot: repository,
      currentRefPath: '../unsafe-current.json',
      lifecycle: publicationLifecycle(manifest),
    });
    for (const result of [publish, inspect, resume, refState]) {
      assert.equal(result.outcome, 'blocked');
      if (result.outcome === 'blocked') {
        assert.equal(result.blocker.kind, 'investigation-v3-failure');
        assert.equal(result.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
      }
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('publication rejects a symlinked ancestor without writing through it', () => {
  const repository = createRepository();
  const outside = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-publication-outside-'),
  );
  try {
    const manifest = sealedExemption(repository);
    const root = `${publicationTestNamespace()}/symlink-ancestor`;
    const alias = path.join(repository, root, 'alias');
    const paths = {
      manifestPath: `${root}/alias/manifest.json`,
      currentRefPath: `${root}/alias/current.json`,
      journalPath: `${root}/alias/journal.json`,
    };
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    fs.mkdirSync(path.dirname(alias), { recursive: true });
    fs.symlinkSync(outside, alias);
    const result = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(result.outcome, 'blocked');
    if (result.outcome === 'blocked') {
      assert.equal(result.blocker.failureCode, 'MANIFEST_UNREPRESENTABLE');
    }
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('post-ref recovery rejects a semantically tampered Manifest that retains its old digest field', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('post-ref-semantic-tamper');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'current-ref-published') {
          throw new Error('simulated post-ref crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');

    const tampered = readJsonAt<Record<string, unknown>>(
      repository,
      paths.manifestPath,
    );
    tampered.changeId = 'cross-wired-change';
    writeJson(path.join(repository, paths.manifestPath), tampered);

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'blocked');
    if (inspection.outcome === 'blocked') {
      assert.equal(inspection.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

for (const prettyPrintedRole of [
  'current-ref',
  'journal',
  'manifest',
] as const) {
  test(`post-ref recovery rejects non-canonical ${prettyPrintedRole} bytes`, () => {
    const repository = createRepository();
    try {
      const manifest = sealedExemption(repository);
      const paths = publicationPaths(`post-ref-pretty-${prettyPrintedRole}`);
      const expected = publicationExpected(
        repository,
        paths.currentRefPath,
        manifest,
      );
      const interrupted = publishInvestigationManifestV3({
        repositoryRoot: repository,
        paths,
        manifest,
        expected,
        withTransitionLock: (operation) => operation(expected),
        observePhase: (phase) => {
          if (phase === 'current-ref-published') {
            throw new Error('simulated post-ref crash');
          }
        },
      });
      assert.equal(interrupted.outcome, 'blocked');

      const relativePath =
        prettyPrintedRole === 'current-ref'
          ? paths.currentRefPath
          : prettyPrintedRole === 'journal'
            ? paths.journalPath
            : paths.manifestPath;
      const artifactPath = path.join(repository, relativePath);
      const semanticValue = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
      fs.writeFileSync(
        artifactPath,
        `${JSON.stringify(semanticValue, null, 2)}\n`,
      );
      const nonCanonicalBytes = fs.readFileSync(artifactPath);

      const inspection = inspectInvestigationManifestPublication({
        repositoryRoot: repository,
        paths,
        lifecycle: publicationLifecycle(manifest),
      });
      assert.equal(inspection.outcome, 'blocked');

      if (prettyPrintedRole === 'current-ref') {
        assert.equal(
          readBoundInvestigationManifestPublicationRef({
            repositoryRoot: repository,
            currentRefPath: paths.currentRefPath,
            lifecycle: publicationLifecycle(manifest),
            expected: {
              manifestPath: paths.manifestPath,
              manifestDigest: manifest.manifestDigest,
              investigationTargetDigest:
                manifest.investigationApproval.investigationTargetDigest,
            },
          }).outcome,
          'blocked',
        );
      }

      const resumeExpected = publicationExpected(
        repository,
        paths.currentRefPath,
        manifest,
      );
      const resumed = resumeInvestigationManifestPublication({
        repositoryRoot: repository,
        paths,
        lifecycle: publicationLifecycle(manifest),
        withTransitionLock: (operation) => operation(resumeExpected),
      });
      assert.equal(resumed.outcome, 'blocked');
      assert.deepEqual(fs.readFileSync(artifactPath), nonCanonicalBytes);
    } finally {
      fs.rmSync(repository, { recursive: true, force: true });
    }
  });
}

test('post-ref recovery never reconstructs a missing authoritative Manifest', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('post-ref-missing-manifest');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'current-ref-published') {
          throw new Error('simulated post-ref crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');
    fs.unlinkSync(path.join(repository, paths.manifestPath));

    const resumeExpected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const resumed = resumeInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
      withTransitionLock: (operation) => operation(resumeExpected),
    });
    assert.equal(resumed.outcome, 'blocked');
    if (resumed.outcome === 'blocked') {
      assert.equal(resumed.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    }
    assert.equal(
      fs.existsSync(path.join(repository, paths.manifestPath)),
      false,
    );
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('committed recovery rejects a semantically tampered Manifest that retains its old digest field', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('committed-semantic-tamper');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const published = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
    });
    assert.equal(published.outcome, 'published');

    const tampered = readJsonAt<Record<string, unknown>>(
      repository,
      paths.manifestPath,
    );
    tampered.investigationId = 'cross-wired-investigation';
    writeJson(path.join(repository, paths.manifestPath), tampered);

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'blocked');
    if (inspection.outcome === 'blocked') {
      assert.equal(inspection.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test('post-ref recovery rejects a recomputed journal whose current-ref identity is cross-wired', () => {
  const repository = createRepository();
  try {
    const manifest = sealedExemption(repository);
    const paths = publicationPaths('post-ref-journal-cross-wire');
    const expected = publicationExpected(
      repository,
      paths.currentRefPath,
      manifest,
    );
    const interrupted = publishInvestigationManifestV3({
      repositoryRoot: repository,
      paths,
      manifest,
      expected,
      withTransitionLock: (operation) => operation(expected),
      observePhase: (phase) => {
        if (phase === 'current-ref-published') {
          throw new Error('simulated post-ref crash');
        }
      },
    });
    assert.equal(interrupted.outcome, 'blocked');

    const journal = readJsonAt<{
      transactionId: string;
      paths: {
        manifestPath: string;
        currentRefPath: string;
        journalPath: string;
        candidatePath: string;
      };
      expected: unknown;
      currentRef: Record<string, unknown>;
    }>(repository, paths.journalPath);
    const currentRef = {
      ...journal.currentRef,
      repositoryId: 'cross-wired-repository',
      manifestPath: 'readme.md',
    };
    const transactionId = canonicalDigest({
      schema: 'investigation-manifest-publication-transaction.v1',
      expected: journal.expected,
      currentRef,
    });
    writeJson(path.join(repository, paths.journalPath), {
      ...journal,
      transactionId,
      paths: {
        ...journal.paths,
        candidatePath: `${paths.manifestPath}.${transactionId}.candidate`,
      },
      currentRef,
    });
    writeJson(path.join(repository, paths.currentRefPath), currentRef);

    const inspection = inspectInvestigationManifestPublication({
      repositoryRoot: repository,
      paths,
      lifecycle: publicationLifecycle(manifest),
    });
    assert.equal(inspection.outcome, 'blocked');
    if (inspection.outcome === 'blocked') {
      assert.equal(inspection.blocker.failureCode, 'RECONSTRUCTION_MISMATCH');
    }
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function sealedExemption(repository: string, sessionRevision = 3) {
  const baseline = {
    commitOid: git(repository, ['rev-parse', 'HEAD']).trim(),
    treeOid: git(repository, ['rev-parse', 'HEAD^{tree}']).trim(),
  };
  const state: ExemptionInvestigationAuthoringState = {
    schemaVersion: 1,
    applicabilityKind: 'exemption',
    repositoryId: 'expense-app-publication-test',
    changeId: 'publication-v3',
    investigationId: 'publication-v3-test',
    normalizedIntent: {
      schemaVersion: 1,
      summary: 'Publish a documentation-only v3 fixture.',
      sourceRefs: [],
      explicitPaths: ['docs/example.md'],
      explicitSymbols: [],
      explicitConfigKeys: [],
      renamePairs: [],
    },
    authoring: {
      sessionRevision,
      sessionSnapshotDigest: digest(`publication-snapshot-${sessionRevision}`),
    },
    exemption: {
      category: 'documentation-only',
      baseline,
      declaredPaths: ['docs/example.md'],
      declaredChangeClasses: ['documentation-only'],
      rationale: 'The fixture changes documentation only.',
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:publication-exemption',
      },
      nonTrivialBehaviorReliance: 'none-declared',
      researchBudgetMinutes: null,
    },
  };
  const built = buildInvestigationManifestDraft({
    repositoryRoot: repository,
    state,
  });
  if (built.outcome !== 'built') assert.fail(built.blocker.failureCode);
  const sealed = sealInvestigationManifestDraft({
    draft: built.draft,
    approval: {
      semanticAuthor: {
        id: 'owner',
        provenance: 'checkpoint:publication-approval',
      },
      approvalProvenanceDigest: digest('publication-approval'),
    },
  });
  if (sealed.outcome !== 'sealed') assert.fail(sealed.blocker.failureCode);
  return sealed.manifest;
}

function publicationExpected(
  repository: string,
  currentRefPath: string,
  manifest: ReturnType<typeof sealedExemption>,
) {
  return publicationExpectedWithRefDigest(
    manifest,
    currentRefDigest(repository, currentRefPath, manifest),
  );
}

function publicationExpectedWithRefDigest(
  manifest: ReturnType<typeof sealedExemption>,
  currentRefDigest: string,
) {
  return {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    sessionRevision: manifest.authoring.sessionRevision,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
    currentRefDigest,
  };
}

function publicationCurrentRef(
  manifestPath: string,
  manifest: ReturnType<typeof sealedExemption>,
) {
  return {
    schemaVersion: 1 as const,
    kind: 'investigation-manifest-current' as const,
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    manifestDigest: manifest.manifestDigest,
    investigationTargetDigest:
      manifest.investigationApproval.investigationTargetDigest,
    manifestPath,
  };
}

function missingPublicationRefDigest(): string {
  return canonicalDigest({
    schema: 'investigation-publication-ref-state.v1',
    exists: false,
  });
}

function publicationRefDigestForValue(value: unknown): string {
  return canonicalDigest({
    schema: 'investigation-publication-ref-state.v1',
    exists: true,
    contentSha256: digest(`${canonicalJson(value)}\n`),
  });
}

function publicationCandidatePath(
  manifestPath: string,
  expected: ReturnType<typeof publicationExpectedWithRefDigest>,
  currentRef: ReturnType<typeof publicationCurrentRef>,
): string {
  const transactionId = canonicalDigest({
    schema: 'investigation-manifest-publication-transaction.v1',
    expected,
    currentRef,
  });
  return `${manifestPath}.${transactionId}.candidate`;
}

function readJsonAt<T>(repository: string, relativePath: string): T {
  return JSON.parse(
    fs.readFileSync(path.join(repository, relativePath), 'utf8'),
  ) as T;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function publicationPaths(prefix: string) {
  const namespace = publicationTestNamespace();
  return {
    manifestPath: `${namespace}/${prefix}-manifest.json`,
    currentRefPath: `${namespace}/${prefix}-current.json`,
    journalPath: `${namespace}/${prefix}-journal.json`,
  };
}

function publicationTestNamespace(): string {
  return `.git/workflow-engine/${investigationManifestPublicationNamespace({
    repositoryId: 'expense-app-publication-test',
    changeId: 'publication-v3',
    investigationId: 'publication-v3-test',
  })}`;
}

function publicationLifecycle(manifest: ReturnType<typeof sealedExemption>) {
  return {
    repositoryId: manifest.repositoryId,
    changeId: manifest.changeId,
    investigationId: manifest.investigationId,
    sessionRevision: manifest.authoring.sessionRevision,
    sessionSnapshotDigest: manifest.authoring.sessionSnapshotDigest,
  };
}

function currentRefDigest(
  repository: string,
  currentRefPath: string,
  manifest: ReturnType<typeof sealedExemption>,
): string {
  const state = readInvestigationPublicationRefState({
    repositoryRoot: repository,
    currentRefPath,
    lifecycle: publicationLifecycle(manifest),
  });
  if (state.outcome !== 'read') assert.fail(state.blocker.failureCode);
  return state.currentRefDigest;
}

function createRepository(): string {
  const repository = fs.mkdtempSync(
    path.join(os.tmpdir(), 'investigation-publication-v3-'),
  );
  git(repository, ['init', '-b', 'main']);
  git(repository, ['config', 'user.email', 'publication-v3@example.test']);
  git(repository, ['config', 'user.name', 'Publication V3 Test']);
  fs.writeFileSync(path.join(repository, 'README.md'), '# fixture\n');
  git(repository, ['add', '-A']);
  git(repository, ['commit', '-m', 'Create publication fixture']);
  return repository;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalDigest(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}
