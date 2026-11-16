/** Publishes private, immutable candidate bundles and their supporting artifacts under the lifecycle lock. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { withRepositoryLifecycleOperation } from '../session-workspace/session-store.ts';
import {
  candidateSupportingArtifactsForPublication,
  canonicalCandidateSupportingArtifact,
  canonicalImmutableCandidateBundle,
  digest,
  parseImmutableCandidateBundle,
  assertCandidateHumanReadableSummary,
  candidateStoreError,
  type CandidateArtifactPublication,
} from '../../modules/authority/maintainer-candidate-contracts.ts';
import {
  readStoredCandidateSupportingArtifact,
  readStoredCandidateHumanReadableSummary,
  readStoredImmutableCandidateBundle,
  candidateRuntime,
  assertCandidateStoreDirectory,
  assertCandidateArtifactStoreDirectory,
  readPrivateCandidateArtifactFile,
} from './maintainer-candidate-reader.ts';

/**
 * Publish all candidate-supporting objects before the candidate bundle. An
 * interrupted publication can leave only unreachable content-addressed
 * objects; it can never expose a bundle whose claimed objects were skipped by
 * this transaction.
 */
export const storeCandidateSupportingArtifacts: CandidateArtifactPublication['storeCandidateSupportingArtifacts'] =
  (gitCommonDirectory, input) => {
    const artifacts = candidateSupportingArtifactsForPublication(input);
    const runtime = candidateRuntime(gitCommonDirectory);
    return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
      assertOwned();
      const directory = ensureCandidateArtifactStoreDirectory(runtime.root);
      const stored = artifacts.map((artifact) => {
        const canonical = canonicalCandidateSupportingArtifact(artifact);
        const artifactDigest = digest(canonicalJson(artifact));
        const target = path.join(directory, `${artifactDigest}.json`);
        publishCandidateContentAddressedFile(
          directory,
          target,
          canonical,
          assertOwned,
        );
        const observed = readStoredCandidateSupportingArtifact(
          gitCommonDirectory,
          artifactDigest,
        );
        if (canonicalCandidateSupportingArtifact(observed) !== canonical) {
          throw candidateStoreError(
            'Stored candidate supporting artifact differs from its canonical bytes.',
          );
        }
        return { artifact, artifactDigest, target };
      });
      const byKind = new Map(
        stored.map((entry) => [entry.artifact.kind, entry] as const),
      );
      return {
        effectsManifestDigest: byKind.get('candidate-external-effects.v1')!
          .artifactDigest,
        providerInvocationsDigest: byKind.get(
          'candidate-provider-invocations.v1',
        )!.artifactDigest,
        recoveryPlanDigest: byKind.get('candidate-recovery-plan.v1')!
          .artifactDigest,
        paths: stored.map(({ target }) => target).sort(),
      };
    });
  };

export const storeCandidateHumanReadableSummary: CandidateArtifactPublication['storeCandidateHumanReadableSummary'] =
  (gitCommonDirectory, summary) => {
    assertCandidateHumanReadableSummary(summary);
    const humanReadableSummaryDigest = digest(summary);
    const runtime = candidateRuntime(gitCommonDirectory);
    return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
      assertOwned();
      const directory = ensureCandidateArtifactStoreDirectory(runtime.root);
      const target = path.join(directory, `${humanReadableSummaryDigest}.md`);
      publishCandidateContentAddressedFile(
        directory,
        target,
        summary,
        assertOwned,
      );
      if (
        readStoredCandidateHumanReadableSummary(
          gitCommonDirectory,
          humanReadableSummaryDigest,
        ) !== summary
      ) {
        throw candidateStoreError(
          'Stored candidate summary differs from its canonical bytes.',
        );
      }
      return { humanReadableSummaryDigest, path: target };
    });
  };

export const storeImmutableCandidateBundle: CandidateArtifactPublication['storeImmutableCandidateBundle'] =
  (gitCommonDirectory, candidate) => {
    const bundle = parseImmutableCandidateBundle(
      canonicalImmutableCandidateBundle(candidate),
    );
    const runtime = candidateRuntime(gitCommonDirectory);
    return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
      assertOwned();
      const directory = ensureCandidateStoreDirectory(runtime.root);
      const target = path.join(
        directory,
        `${bundle.candidateBundleDigest}.json`,
      );
      const canonical = canonicalImmutableCandidateBundle(bundle);
      if (fs.existsSync(target)) {
        const existing = readStoredImmutableCandidateBundle(
          gitCommonDirectory,
          bundle.candidateBundleDigest,
        );
        if (canonicalImmutableCandidateBundle(existing) !== canonical) {
          throw candidateStoreError(
            'Candidate digest already exists with different canonical bytes.',
          );
        }
        return target;
      }

      const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(temporary, 'wx', 0o600);
        fs.writeFileSync(descriptor, canonical, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        assertOwned();
        fs.linkSync(temporary, target);
        fs.unlinkSync(temporary);
        fsyncCandidateDirectory(directory);
        assertOwned();
        return target;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          const existing = readStoredImmutableCandidateBundle(
            gitCommonDirectory,
            bundle.candidateBundleDigest,
          );
          if (canonicalImmutableCandidateBundle(existing) === canonical) {
            return target;
          }
        }
        throw error;
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
        fs.rmSync(temporary, { force: true });
      }
    });
  };

function ensureCandidateStoreDirectory(runtimeRoot: string): string {
  const directory = path.join(runtimeRoot, 'candidates');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertCandidateStoreDirectory(directory);
  fs.chmodSync(directory, 0o700);
  return directory;
}

function ensureCandidateArtifactStoreDirectory(runtimeRoot: string): string {
  const directory = path.join(runtimeRoot, 'candidate-artifacts');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertCandidateArtifactStoreDirectory(directory);
  fs.chmodSync(directory, 0o700);
  return directory;
}

function publishCandidateContentAddressedFile(
  directory: string,
  target: string,
  canonical: string,
  assertOwned: () => void,
): void {
  if (fs.existsSync(target)) {
    if (readPrivateCandidateArtifactFile(target) !== canonical) {
      throw candidateStoreError(
        'Candidate artifact digest already exists with different bytes.',
      );
    }
    return;
  }
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, canonical, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertOwned();
    fs.linkSync(temporary, target);
    fs.unlinkSync(temporary);
    fsyncCandidateDirectory(directory);
    assertOwned();
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'EEXIST' &&
      readPrivateCandidateArtifactFile(target) === canonical
    ) {
      return;
    }
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function fsyncCandidateDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
