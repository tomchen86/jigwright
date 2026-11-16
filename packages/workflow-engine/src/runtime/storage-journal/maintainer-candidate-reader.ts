/** Reads exact immutable candidate artifacts and validates their durable bytes. */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { runtimePaths } from '../session-workspace/session-store.ts';
import {
  digest,
  parseCandidateSupportingArtifact,
  parseImmutableCandidateBundle,
  assertCandidateHumanReadableSummary,
  assertCandidateBundleDigest,
  assertCandidateArtifactDigest,
  assertCandidateArtifactChangeId,
  assertCandidateSupportingArtifactsBinding,
  assertCandidateSummaryBinding,
  type CandidateSupportingArtifact,
  type CandidateSupportingArtifactSet,
  type ImmutableCandidateBundleV2,
} from '../../modules/authority/maintainer-candidate-contracts.ts';
export function readStoredCandidateSupportingArtifact(
  gitCommonDirectory: string,
  requestedDigest: string,
): CandidateSupportingArtifact {
  const digestValue = assertCandidateArtifactDigest(requestedDigest);
  const runtime = candidateRuntime(gitCommonDirectory);
  const directory = path.join(runtime.root, 'candidate-artifacts');
  assertCandidateArtifactStoreDirectory(directory);
  const target = path.join(directory, `${digestValue}.json`);
  try {
    const raw = readPrivateCandidateArtifactFile(target);
    const artifact = parseCandidateSupportingArtifact(raw);
    if (digest(canonicalJson(artifact)) !== digestValue) {
      throw new Error('supporting artifact identity mismatch');
    }
    return artifact;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'APPLY_CANDIDATE_STORE_INVALID'
    ) {
      throw error;
    }
    throw candidateStoreError(
      'Stored candidate supporting artifact is malformed or has different content.',
    );
  }
}

export function readStoredCandidateHumanReadableSummary(
  gitCommonDirectory: string,
  requestedDigest: string,
): string {
  const digestValue = assertCandidateArtifactDigest(requestedDigest);
  const runtime = candidateRuntime(gitCommonDirectory);
  const directory = path.join(runtime.root, 'candidate-artifacts');
  assertCandidateArtifactStoreDirectory(directory);
  const target = path.join(directory, `${digestValue}.md`);
  const summary = readPrivateCandidateArtifactFile(target);
  assertCandidateHumanReadableSummary(summary);
  if (digest(summary) !== digestValue) {
    throw candidateStoreError(
      'Stored candidate summary has different content from its identity.',
    );
  }
  return summary;
}

export const assertStoredCandidateSupportingArtifacts: CandidateArtifactObservations['assertStoredCandidateSupportingArtifacts'] =
  function assertStoredCandidateSupportingArtifacts(
    gitCommonDirectory,
    changeId,
    candidate,
  ) {
    assertCandidateArtifactChangeId(changeId);
    const effectsManifest = readStoredCandidateSupportingArtifact(
      gitCommonDirectory,
      candidate.effectsManifestDigest,
    );
    const providerInvocations = readStoredCandidateSupportingArtifact(
      gitCommonDirectory,
      candidate.providerInvocationsDigest,
    );
    const recoveryPlan = readStoredCandidateSupportingArtifact(
      gitCommonDirectory,
      candidate.recoveryPlanDigest,
    );
    const artifacts = assertCandidateSupportingArtifactsBinding(
      changeId,
      candidate,
      effectsManifest,
      providerInvocations,
      recoveryPlan,
    );
    const summary = readStoredCandidateHumanReadableSummary(
      gitCommonDirectory,
      candidate.humanReadableSummaryDigest,
    );
    assertCandidateSummaryBinding(summary, candidate);
    return artifacts;
  };

export const readStoredImmutableCandidateBundle: CandidateArtifactObservations['readStoredImmutableCandidateBundle'] =
  function readStoredImmutableCandidateBundle(
    gitCommonDirectory,
    requestedCandidateBundleDigest,
  ) {
    const digestValue = assertCandidateBundleDigest(
      requestedCandidateBundleDigest,
    );
    const runtime = candidateRuntime(gitCommonDirectory);
    const directory = path.join(runtime.root, 'candidates');
    assertCandidateStoreDirectory(directory);
    const target = path.join(directory, `${digestValue}.json`);
    const stats = fs.lstatSync(target, { throwIfNoEntry: false });
    if (
      !stats?.isFile() ||
      stats.isSymbolicLink() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600
    ) {
      throw candidateStoreError(
        'Stored immutable candidate is missing or has unsafe permissions.',
      );
    }
    try {
      const bundle = parseImmutableCandidateBundle(
        fs.readFileSync(target, 'utf8'),
      );
      if (bundle.candidateBundleDigest !== digestValue) {
        throw new Error('candidate identity mismatch');
      }
      return bundle;
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'APPLY_CANDIDATE_STORE_INVALID'
      ) {
        throw error;
      }
      throw candidateStoreError(
        'Stored immutable candidate is malformed or has different content.',
      );
    }
  };
export function candidateRuntime(gitCommonDirectory: string) {
  if (!path.isAbsolute(gitCommonDirectory)) {
    throw candidateStoreError(
      'Immutable candidate storage requires an absolute Git common directory.',
    );
  }
  return runtimePaths(gitCommonDirectory, 'workflow-engine');
}

export function assertCandidateStoreDirectory(directory: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(directory) !== path.resolve(directory) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw candidateStoreError(
      'Immutable candidate store is missing or has unsafe permissions.',
    );
  }
}

export function assertCandidateArtifactStoreDirectory(directory: string): void {
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (
    !stats?.isDirectory() ||
    stats.isSymbolicLink() ||
    fs.realpathSync(directory) !== path.resolve(directory) ||
    (stats.mode & 0o077) !== 0
  ) {
    throw candidateStoreError(
      'Candidate supporting artifact store is missing or has unsafe permissions.',
    );
  }
}

export function readPrivateCandidateArtifactFile(filePath: string): string {
  const flags =
    fs.constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW);
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, flags);
  } catch {
    throw candidateStoreError(
      'Stored candidate supporting artifact is missing or unsafe.',
    );
  }
  try {
    const stats = fs.fstatSync(descriptor);
    if (
      !stats.isFile() ||
      stats.nlink !== 1 ||
      (stats.mode & 0o777) !== 0o600 ||
      stats.size > 4_194_304
    ) {
      throw candidateStoreError(
        'Stored candidate supporting artifact has unsafe permissions or size.',
      );
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

import type { CandidateArtifactObservations } from '../../modules/authority/maintainer-candidate-contracts.ts';

import { candidateStoreError } from '../../modules/authority/maintainer-candidate-contracts.ts';
