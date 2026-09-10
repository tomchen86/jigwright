/**
 * Stores and reads immutable candidate bundles, their supporting artifacts
 * and readable summaries.
 *
 * Invariants:
 * - The three candidate supporting artifacts must share one changeId and
 *   one task-mandate binding.
 * - A stored candidate bundle file must be a regular, non-symlink,
 *   single-hardlink file with mode 0600.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  type CheckDependency,
  type PatchManifest,
} from './maintainer-manifest.ts';
import {
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../../runtime/session-workspace/session-store.ts';
import type { TaskMandateBinding } from './task-mandate.ts';
import {
  CHANGE_ID,
  DIGEST,
  assertCandidateSupportingArtifact,
  candidateError,
  canonicalCandidateHumanReadableSummary,
  canonicalCandidateSupportingArtifact,
  canonicalImmutableCandidateBundle,
  digest,
  parseCandidateSupportingArtifact,
  parseImmutableCandidateBundle,
} from './maintainer-candidate-contracts.ts';
import { createCandidateRefLedger } from './maintainer-candidate-ref-ledger.ts';

export {
  buildCandidateExternalEffectsManifest,
  buildImmutableCandidateBundleV2,
  canonicalCandidateHumanReadableSummary,
  canonicalImmutableCandidateBundle,
  parseImmutableCandidateBundle,
  canonicalCandidateSupportingArtifact,
  parseCandidateSupportingArtifact,
  assertCandidateV2ChecksFresh,
} from './maintainer-candidate-contracts.ts';

export type { CandidateChecksFields };

export type CheckReuseClass =
  'content-pure' | 'toolchain-dependent' | 'external-state';

export type { CheckDependency } from './maintainer-manifest.ts';

export type CandidateCheckAttestation = {
  checkId: string;
  definitionDigest: string;
  commandDigest: string;
  runnerDigest: string;
  environmentDigest: string;
  resultDigest: string;
  outcome: 'passed';
  startedAt: string;
  completedAt: string;
  reuseClass: CheckReuseClass;
  maxAgeMs: number | null;
  externalSnapshotDigest: string | null;
  dependsOn: CheckDependency[];
};

export type CandidateDependencySnapshot = {
  schemaVersion: 1;
  sourceTree: string;
  baseCommit: string;
  harnessEngineDigest: string;
  policyDigest: string;
  runnerDigests: Record<string, string>;
  externalStateDigests: Record<string, string | null>;
};

export type CandidateChecksAttestationV3 = {
  schemaVersion: 3;
  candidateTree: string;
  patchDigest: string;
  trustBaseCommit: string;
  dependencySnapshot: CandidateDependencySnapshot;
  checks: CandidateCheckAttestation[];
};

export type CandidateClassification =
  'ordinary' | 'root-one-shot' | 'control-plane';

type ImmutableCandidateBundleCommon = {
  mandateBinding: TaskMandateBinding;
  repositoryId: string;
  targetRef: string;
  expectedOldCommit: string;
  expectedRefGeneration: number;
  candidateCommit: string;
  resultTree: string;
  commitMessage: string;
  manifest: PatchManifest;
  manifestDigest: string;
  checksAttestationDigest: string;
  effectsManifestDigest: string;
  providerInvocationsDigest: string;
  classification: CandidateClassification;
  recoveryPlanDigest: string;
  createdAt: string;
  candidateBundleDigest: string;
};

export type ImmutableCandidateBundleV2 = ImmutableCandidateBundleCommon & {
  schemaVersion: 2;
  checksAttestation: CandidateChecksAttestationV3;
  humanReadableSummaryDigest: string;
};

export type ImmutableCandidateBundleV2Input = Omit<
  ImmutableCandidateBundleV2,
  | 'schemaVersion'
  | 'manifestDigest'
  | 'checksAttestationDigest'
  | 'humanReadableSummaryDigest'
  | 'candidateBundleDigest'
> & {
  candidateBundleDigest?: string;
};

export type CandidateExternalEffect = {
  effectType: string;
  targetDigest: string;
  authorizationDigest: string | null;
  resultDigest: string | null;
};

export type CandidateExternalEffectsManifest = {
  schemaVersion: 1;
  kind: 'candidate-external-effects.v1';
  changeId: string;
  mandateBinding: TaskMandateBinding;
  effects: CandidateExternalEffect[];
};

export type CandidateProviderInvocation = {
  invocationId: string;
  investigationId: string;
  purpose: 'survey' | 'plan-review' | 'task-diff-review';
  attempt: number;
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  requestDigest: string;
  manifestDigest: string;
  outputDigest: string | null;
  failureDigest: string | null;
};

export type CandidateProviderInvocationsManifest = {
  schemaVersion: 1;
  kind: 'candidate-provider-invocations.v1';
  changeId: string;
  mandateBinding: TaskMandateBinding;
  invocations: CandidateProviderInvocation[];
};

export type CandidateRecoveryPlan = {
  schemaVersion: 1;
  kind: 'candidate-recovery-plan.v1';
  changeId: string;
  mandateBinding: TaskMandateBinding;
  targetRef: string;
  expectedOldCommit: string;
  expectedRefGeneration: number;
  candidateCommit: string;
  rollbackTarget: string;
};

export type CandidateSupportingArtifact =
  | CandidateExternalEffectsManifest
  | CandidateProviderInvocationsManifest
  | CandidateRecoveryPlan;

export type CandidateSupportingArtifactSet = {
  effectsManifest: CandidateExternalEffectsManifest;
  providerInvocations: CandidateProviderInvocationsManifest;
  recoveryPlan: CandidateRecoveryPlan;
};

export type StoredCandidateSupportingArtifacts = {
  effectsManifestDigest: string;
  providerInvocationsDigest: string;
  recoveryPlanDigest: string;
  paths: string[];
};

/**
 * Publish all candidate-supporting objects before the candidate bundle. An
 * interrupted publication can leave only unreachable content-addressed
 * objects; it can never expose a bundle whose claimed objects were skipped by
 * this transaction.
 */
export function storeCandidateSupportingArtifacts(
  gitCommonDirectory: string,
  input: CandidateSupportingArtifactSet,
): StoredCandidateSupportingArtifacts {
  const artifacts = [
    assertCandidateSupportingArtifact(input.effectsManifest),
    assertCandidateSupportingArtifact(input.providerInvocations),
    assertCandidateSupportingArtifact(input.recoveryPlan),
  ];
  const changeIds = new Set(artifacts.map(({ changeId }) => changeId));
  const mandateBindings = new Set(
    artifacts.map(({ mandateBinding }) => canonicalJson(mandateBinding)),
  );
  if (changeIds.size !== 1 || mandateBindings.size !== 1) {
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_INVALID',
      'Candidate supporting artifacts belong to different changes or task mandates.',
    );
  }
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
}

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

export function storeCandidateHumanReadableSummary(
  gitCommonDirectory: string,
  summary: string,
): { humanReadableSummaryDigest: string; path: string } {
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

export function assertStoredCandidateSupportingArtifacts(
  gitCommonDirectory: string,
  changeId: string,
  candidate: ImmutableCandidateBundleV2,
): CandidateSupportingArtifactSet {
  if (!CHANGE_ID.test(changeId)) {
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_INVALID',
      'Candidate supporting artifact change binding is invalid.',
    );
  }
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
  if (
    effectsManifest.kind !== 'candidate-external-effects.v1' ||
    providerInvocations.kind !== 'candidate-provider-invocations.v1' ||
    recoveryPlan.kind !== 'candidate-recovery-plan.v1' ||
    effectsManifest.changeId !== changeId ||
    providerInvocations.changeId !== changeId ||
    recoveryPlan.changeId !== changeId ||
    canonicalJson(effectsManifest.mandateBinding) !==
      canonicalJson(candidate.mandateBinding) ||
    canonicalJson(providerInvocations.mandateBinding) !==
      canonicalJson(candidate.mandateBinding) ||
    canonicalJson(recoveryPlan.mandateBinding) !==
      canonicalJson(candidate.mandateBinding) ||
    candidate.mandateBinding.changeId !== changeId ||
    recoveryPlan.targetRef !== candidate.targetRef ||
    recoveryPlan.expectedOldCommit !== candidate.expectedOldCommit ||
    recoveryPlan.expectedRefGeneration !== candidate.expectedRefGeneration ||
    recoveryPlan.candidateCommit !== candidate.candidateCommit ||
    recoveryPlan.rollbackTarget !== candidate.expectedOldCommit
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_BINDING_INVALID',
      'Stored candidate supporting artifacts do not bind the immutable candidate.',
    );
  }
  const summary = readStoredCandidateHumanReadableSummary(
    gitCommonDirectory,
    candidate.humanReadableSummaryDigest,
  );
  if (summary !== canonicalCandidateHumanReadableSummary(candidate)) {
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_BINDING_INVALID',
      'Stored candidate summary does not describe the immutable candidate.',
    );
  }
  return { effectsManifest, providerInvocations, recoveryPlan };
}

export function storeImmutableCandidateBundle(
  gitCommonDirectory: string,
  candidate: ImmutableCandidateBundleV2,
): string {
  const bundle = parseImmutableCandidateBundle(
    canonicalImmutableCandidateBundle(candidate),
  );
  const runtime = candidateRuntime(gitCommonDirectory);
  return withRepositoryLifecycleOperation(runtime, (assertOwned) => {
    assertOwned();
    const directory = ensureCandidateStoreDirectory(runtime.root);
    const target = path.join(directory, `${bundle.candidateBundleDigest}.json`);
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
}

export function readStoredImmutableCandidateBundle(
  gitCommonDirectory: string,
  requestedCandidateBundleDigest: string,
): ImmutableCandidateBundleV2 {
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
}

function candidateRuntime(gitCommonDirectory: string) {
  if (!path.isAbsolute(gitCommonDirectory)) {
    throw candidateStoreError(
      'Immutable candidate storage requires an absolute Git common directory.',
    );
  }
  return runtimePaths(gitCommonDirectory, 'workflow-engine');
}

function assertCandidateHumanReadableSummary(value: string): void {
  if (
    typeof value !== 'string' ||
    !value.startsWith('# Immutable Candidate Summary\n') ||
    !value.endsWith('\n') ||
    value.includes('\0') ||
    value.includes('\r') ||
    Buffer.byteLength(value, 'utf8') > 1_048_576
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_INVALID',
      'Candidate human-readable summary is malformed or noncanonical.',
    );
  }
}

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

function assertCandidateStoreDirectory(directory: string): void {
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

function assertCandidateArtifactStoreDirectory(directory: string): void {
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

function readPrivateCandidateArtifactFile(filePath: string): string {
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

function assertCandidateBundleDigest(value: string): string {
  if (!DIGEST.test(value)) {
    throw candidateStoreError('Immutable candidate digest is invalid.');
  }
  return value;
}

function assertCandidateArtifactDigest(value: string): string {
  if (!DIGEST.test(value)) {
    throw candidateStoreError(
      'Candidate supporting artifact digest is invalid.',
    );
  }
  return value;
}

function fsyncCandidateDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function candidateStoreError(message: string) {
  return workflowError(
    'APPLY_CANDIDATE_STORE_INVALID',
    message,
    ExitCode.guard,
  );
}

export type CandidateV2CheckFreshnessOptions = {
  now: Date;
  candidateTree: string;
  patchDigest: string;
  trustBaseCommit: string;
  requiredChecks: string[];
  waivedFreshnessCheckIds?: string[];
  environmentDigest: string;
  currentDependencySnapshot: CandidateDependencySnapshot;
};

type CandidateChecksFields = {
  candidateTree: string;
  patchDigest: string;
  trustBaseCommit: string;
  checks: CandidateCheckAttestation[];
};

export type RefGenerationTransition = {
  fromOid: string;
  toOid: string;
  fromGeneration: number;
  toGeneration: number;
  reason:
    'apply' | 'rollback' | 'external-sync' | 'promotion' | 'uncertain-cas';
  at: string;
};

export type RefGenerationLedger = {
  schemaVersion: 1;
  ref: string;
  currentOid: string;
  generation: number;
  transitions: RefGenerationTransition[];
};

export type CreateCandidateRefLedgerBindings = Readonly<{
  runtimePaths: typeof runtimePaths;
  withRepositoryLifecycleOperation: typeof withRepositoryLifecycleOperation;
}>;
const candidateRefLedger = createCandidateRefLedger({
  runtimePaths,
  withRepositoryLifecycleOperation,
});
export const {
  createRefGenerationLedger,
  acceptApplyPrestate,
  recordRefGenerationTransition,
  ensureDurableRefGenerationLedger,
  readDurableRefGenerationLedger,
  recordDurableRefGenerationTransitionUnderLifecycleLock,
} = candidateRefLedger;
