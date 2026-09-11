/**
 * Builds canonical candidate bundles, supporting artifacts and check
 * freshness contracts.
 *
 * Invariants:
 * - `buildCandidateExternalEffectsManifest` requires an explicit array and
 *   rejects any non-empty external-effects declaration as
 *   not-yet-verifiable.
 * - The candidate bundle digest is recomputed from canonical content, and a
 *   supplied `candidateBundleDigest` must equal it.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import {
  canonicalPatchManifest,
  parsePatchManifest,
} from './maintainer-manifest-contracts.ts';
import type {
  CheckDependency,
  PatchManifest,
} from './maintainer-manifest-contracts.ts';
import type { TaskMandateBinding } from './task-mandate-contract.ts';

export const DIGEST = /^[0-9a-f]{64}$/;

export const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

const GRANT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CHECK_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const TARGET_REF = /^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export const CHANGE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const INVOCATION_ID = /^invocation-[A-Za-z0-9-]+$/;

const INVESTIGATION_ID = /^investigation-[A-Za-z0-9-]+$/;

/**
 * Freeze the caller's explicit external-effect declaration before any human
 * candidate signing. An explicit empty array is meaningful; omission is not.
 * Non-empty declarations remain fail-closed until Apply can verify the exact
 * separately issued External Effect Grant and production executor receipt.
 */
export function buildCandidateExternalEffectsManifest(input: {
  changeId: string;
  mandateBinding: TaskMandateBinding;
  externalEffects: unknown;
}): CandidateExternalEffectsManifest {
  if (!Array.isArray(input.externalEffects)) {
    throw candidateError(
      'APPLY_CANDIDATE_EFFECTS_DECLARATION_REQUIRED',
      'Approve-and-apply requires an explicit canonical external effects declaration; use an empty array only when no effects are declared.',
    );
  }
  const artifact = assertCandidateSupportingArtifact({
    schemaVersion: 1,
    kind: 'candidate-external-effects.v1',
    changeId: input.changeId,
    mandateBinding: input.mandateBinding,
    effects: input.externalEffects,
  });
  if (artifact.kind !== 'candidate-external-effects.v1') {
    throw candidateArtifactInvalid();
  }
  if (artifact.effects.length > 0) {
    throw candidateError(
      'APPLY_CANDIDATE_EXTERNAL_EFFECT_UNSUPPORTED',
      'Apply does not execute external effects, and this candidate declaration cannot yet be verified against a separate production External Effect Grant receipt.',
    );
  }
  return artifact;
}

export function buildImmutableCandidateBundleV2(
  input: ImmutableCandidateBundleV2Input,
): {
  bundle: ImmutableCandidateBundleV2;
  humanReadableSummary: string;
} {
  const mandateBinding = assertCandidateMandateBinding(input.mandateBinding);
  const manifest = parsePatchManifest(canonicalPatchManifest(input.manifest));
  const checksAttestation = assertCandidateChecksAttestationV3(
    input.checksAttestation,
  );
  const createdAt = exactTimestamp(input.createdAt, 'candidate creation time');
  if (
    !/^github:[A-Za-z0-9_.:-]+$/.test(input.repositoryId) ||
    !validRef(input.targetRef) ||
    !OBJECT_ID.test(input.expectedOldCommit) ||
    !Number.isSafeInteger(input.expectedRefGeneration) ||
    input.expectedRefGeneration < 0 ||
    !OBJECT_ID.test(input.candidateCommit) ||
    input.candidateCommit === input.expectedOldCommit ||
    !OBJECT_ID.test(input.resultTree) ||
    !validCommitMessage(input.commitMessage) ||
    !DIGEST.test(input.effectsManifestDigest) ||
    !DIGEST.test(input.providerInvocationsDigest) ||
    !['ordinary', 'root-one-shot', 'control-plane'].includes(
      input.classification,
    ) ||
    !DIGEST.test(input.recoveryPlanDigest) ||
    checksAttestation.candidateTree !== input.resultTree ||
    checksAttestation.patchDigest !== manifest.patchDigest ||
    checksAttestation.trustBaseCommit !== manifest.trustBaseCommit ||
    checksAttestation.dependencySnapshot.sourceTree !== input.resultTree ||
    checksAttestation.dependencySnapshot.baseCommit !==
      input.expectedOldCommit ||
    checksAttestation.dependencySnapshot.policyDigest !== manifest.policyDigest
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_INVALID',
      'Immutable candidate v2 bindings are malformed or inconsistent.',
    );
  }
  const summaryMaterial = {
    schemaVersion: 2 as const,
    mandateBinding,
    repositoryId: input.repositoryId,
    targetRef: input.targetRef,
    expectedOldCommit: input.expectedOldCommit,
    expectedRefGeneration: input.expectedRefGeneration,
    candidateCommit: input.candidateCommit,
    resultTree: input.resultTree,
    commitMessage: input.commitMessage,
    manifest,
    manifestDigest: digest(canonicalPatchManifest(manifest)),
    checksAttestation,
    checksAttestationDigest: digest(canonicalJson(checksAttestation)),
    effectsManifestDigest: input.effectsManifestDigest,
    providerInvocationsDigest: input.providerInvocationsDigest,
    classification: input.classification,
    recoveryPlanDigest: input.recoveryPlanDigest,
    createdAt,
  };
  const humanReadableSummary = candidateHumanReadableSummary(summaryMaterial);
  const humanReadableSummaryDigest = digest(humanReadableSummary);
  const bundleBody = { ...summaryMaterial, humanReadableSummaryDigest };
  const candidateBundleDigest = digest(canonicalJson(bundleBody));
  if (
    input.candidateBundleDigest !== undefined &&
    input.candidateBundleDigest !== candidateBundleDigest
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_DIGEST_MISMATCH',
      'Candidate v2 bundle digest differs from its canonical content.',
    );
  }
  return {
    bundle: { ...bundleBody, candidateBundleDigest },
    humanReadableSummary,
  };
}

export function canonicalCandidateHumanReadableSummary(
  candidate: ImmutableCandidateBundleV2,
): string {
  return candidateHumanReadableSummary(candidate);
}

function candidateHumanReadableSummary(
  candidate: Omit<
    ImmutableCandidateBundleV2,
    'humanReadableSummaryDigest' | 'candidateBundleDigest'
  >,
): string {
  const checks = candidate.checksAttestation.checks;
  const requiredChecks = checks.map(({ checkId }) => checkId);
  const changedPaths = candidate.manifest.files.map(
    (entry) =>
      `- ${JSON.stringify(entry.path)} — ${entry.operation}; ${entry.role}`,
  );
  const checkLines = checks.map(
    (check) =>
      `- ${JSON.stringify(check.checkId)} — completed ${check.completedAt}; depends on ${check.dependsOn.join(', ')}`,
  );
  return [
    '# Immutable Candidate Summary',
    '',
    `Change: \`${candidate.mandateBinding.changeId}\``,
    `Task: \`${candidate.mandateBinding.mandateTaskId}\``,
    `Repository: \`${candidate.repositoryId}\``,
    `Profile: \`${candidate.manifest.profile}@${candidate.manifest.profileVersion}\``,
    `Classification: \`${candidate.classification}\``,
    `Target ref: \`${candidate.targetRef}\``,
    `Expected old commit: \`${candidate.expectedOldCommit}\``,
    `Expected ref generation: \`${candidate.expectedRefGeneration}\``,
    `Candidate commit: \`${candidate.candidateCommit}\``,
    `Result tree: \`${candidate.resultTree}\``,
    `Patch digest: \`${candidate.manifest.patchDigest}\``,
    `Required checks: ${requiredChecks.map((value) => `\`${value}\``).join(', ')}`,
    `Changed paths: \`${candidate.manifest.files.length}\``,
    `Created at: \`${candidate.createdAt}\``,
    '',
    '## Changed paths',
    '',
    ...changedPaths,
    '',
    '## Checks',
    '',
    ...checkLines,
    '',
    '## Supporting artifacts',
    '',
    `- External effects: \`${candidate.effectsManifestDigest}\``,
    `- Provider invocations: \`${candidate.providerInvocationsDigest}\``,
    `- Recovery plan: \`${candidate.recoveryPlanDigest}\``,
    '',
  ].join('\n');
}

const CANDIDATE_COMMON_KEYS = [
  'schemaVersion',
  'mandateBinding',
  'repositoryId',
  'targetRef',
  'expectedOldCommit',
  'expectedRefGeneration',
  'candidateCommit',
  'resultTree',
  'commitMessage',
  'manifest',
  'manifestDigest',
  'checksAttestation',
  'checksAttestationDigest',
  'effectsManifestDigest',
  'providerInvocationsDigest',
  'classification',
  'recoveryPlanDigest',
  'createdAt',
  'candidateBundleDigest',
];

const CANDIDATE_V2_KEYS = [
  ...CANDIDATE_COMMON_KEYS,
  'humanReadableSummaryDigest',
];

export function canonicalImmutableCandidateBundle(
  bundle: ImmutableCandidateBundleV2,
): string {
  return `${canonicalJson(bundle)}\n`;
}

export function parseImmutableCandidateBundle(
  raw: string,
): ImmutableCandidateBundleV2 {
  try {
    if (
      typeof raw !== 'string' ||
      raw.length < 3 ||
      raw.length > 4_194_304 ||
      !raw.endsWith('\n')
    ) {
      throw new Error('invalid candidate bytes');
    }
    const value = JSON.parse(raw) as unknown;
    if (
      !isRecord(value) ||
      value.schemaVersion !== 2 ||
      !hasExactKeys(value, CANDIDATE_V2_KEYS) ||
      !isRecord(value.mandateBinding) ||
      typeof value.repositoryId !== 'string' ||
      typeof value.targetRef !== 'string' ||
      typeof value.expectedOldCommit !== 'string' ||
      typeof value.expectedRefGeneration !== 'number' ||
      typeof value.candidateCommit !== 'string' ||
      typeof value.resultTree !== 'string' ||
      typeof value.commitMessage !== 'string' ||
      !isRecord(value.manifest) ||
      typeof value.manifestDigest !== 'string' ||
      !isRecord(value.checksAttestation) ||
      typeof value.checksAttestationDigest !== 'string' ||
      typeof value.effectsManifestDigest !== 'string' ||
      typeof value.providerInvocationsDigest !== 'string' ||
      (value.classification !== 'ordinary' &&
        value.classification !== 'root-one-shot' &&
        value.classification !== 'control-plane') ||
      typeof value.recoveryPlanDigest !== 'string' ||
      typeof value.createdAt !== 'string' ||
      typeof value.candidateBundleDigest !== 'string' ||
      typeof value.humanReadableSummaryDigest !== 'string'
    ) {
      throw new Error('invalid candidate shape');
    }
    const manifest = parsePatchManifest(value.manifest);
    const common = {
      mandateBinding: value.mandateBinding as TaskMandateBinding,
      repositoryId: value.repositoryId,
      targetRef: value.targetRef,
      expectedOldCommit: value.expectedOldCommit,
      expectedRefGeneration: value.expectedRefGeneration as number,
      candidateCommit: value.candidateCommit,
      resultTree: value.resultTree,
      commitMessage: value.commitMessage,
      manifest,
      effectsManifestDigest: value.effectsManifestDigest,
      providerInvocationsDigest: value.providerInvocationsDigest,
      classification: value.classification as CandidateClassification,
      recoveryPlanDigest: value.recoveryPlanDigest,
      createdAt: value.createdAt,
      candidateBundleDigest: value.candidateBundleDigest,
    };
    const bundle = buildImmutableCandidateBundleV2({
      ...common,
      checksAttestation:
        value.checksAttestation as CandidateChecksAttestationV3,
    }).bundle;
    if (
      value.manifestDigest !== bundle.manifestDigest ||
      value.checksAttestationDigest !== bundle.checksAttestationDigest ||
      value.humanReadableSummaryDigest !== bundle.humanReadableSummaryDigest ||
      canonicalImmutableCandidateBundle(bundle) !== raw
    ) {
      throw new Error('candidate digest or canonical bytes differ');
    }
    return bundle;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('APPLY_CANDIDATE_')
    ) {
      throw error;
    }
    throw candidateError(
      'APPLY_CANDIDATE_INVALID',
      'Immutable candidate bundle is malformed or noncanonical.',
    );
  }
}

export function canonicalCandidateSupportingArtifact(
  artifact: CandidateSupportingArtifact,
): string {
  return `${canonicalJson(assertCandidateSupportingArtifact(artifact))}\n`;
}

export function parseCandidateSupportingArtifact(
  raw: string,
): CandidateSupportingArtifact {
  try {
    if (
      typeof raw !== 'string' ||
      raw.length < 3 ||
      raw.length > 4_194_304 ||
      !raw.endsWith('\n')
    ) {
      throw new Error('invalid supporting artifact bytes');
    }
    const artifact = assertCandidateSupportingArtifact(JSON.parse(raw));
    if (canonicalCandidateSupportingArtifact(artifact) !== raw) {
      throw new Error('noncanonical supporting artifact');
    }
    return artifact;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'APPLY_CANDIDATE_ARTIFACT_INVALID'
    ) {
      throw error;
    }
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_INVALID',
      'Candidate supporting artifact is malformed or noncanonical.',
    );
  }
}

export function assertCandidateSupportingArtifact(
  value: unknown,
): CandidateSupportingArtifact {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.kind !== 'string' ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    !isRecord(value.mandateBinding)
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_ARTIFACT_INVALID',
      'Candidate supporting artifact has an invalid identity.',
    );
  }
  const mandateBinding = assertCandidateMandateBinding(value.mandateBinding);
  if (mandateBinding.changeId !== value.changeId) {
    throw candidateArtifactInvalid();
  }
  if (value.kind === 'candidate-external-effects.v1') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'changeId',
        'mandateBinding',
        'effects',
      ]) ||
      !Array.isArray(value.effects)
    ) {
      throw candidateArtifactInvalid();
    }
    const effects = value.effects.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, [
          'effectType',
          'targetDigest',
          'authorizationDigest',
          'resultDigest',
        ]) ||
        !validArtifactLabel(entry.effectType) ||
        typeof entry.targetDigest !== 'string' ||
        !DIGEST.test(entry.targetDigest) ||
        (entry.authorizationDigest !== null &&
          (typeof entry.authorizationDigest !== 'string' ||
            !DIGEST.test(entry.authorizationDigest))) ||
        (entry.resultDigest !== null &&
          (typeof entry.resultDigest !== 'string' ||
            !DIGEST.test(entry.resultDigest)))
      ) {
        throw candidateArtifactInvalid();
      }
      return {
        effectType: entry.effectType,
        targetDigest: entry.targetDigest,
        authorizationDigest: entry.authorizationDigest,
        resultDigest: entry.resultDigest,
      } as CandidateExternalEffect;
    });
    assertCanonicalArtifactEntries(effects);
    return {
      schemaVersion: 1,
      kind: value.kind,
      changeId: value.changeId,
      mandateBinding,
      effects,
    };
  }
  if (value.kind === 'candidate-provider-invocations.v1') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'changeId',
        'mandateBinding',
        'invocations',
      ]) ||
      !Array.isArray(value.invocations)
    ) {
      throw candidateArtifactInvalid();
    }
    const invocations = value.invocations.map((entry) => {
      if (
        !isRecord(entry) ||
        !hasExactKeys(entry, [
          'invocationId',
          'investigationId',
          'purpose',
          'attempt',
          'state',
          'requestDigest',
          'manifestDigest',
          'outputDigest',
          'failureDigest',
        ]) ||
        typeof entry.invocationId !== 'string' ||
        !INVOCATION_ID.test(entry.invocationId) ||
        typeof entry.investigationId !== 'string' ||
        !INVESTIGATION_ID.test(entry.investigationId) ||
        (entry.purpose !== 'survey' &&
          entry.purpose !== 'plan-review' &&
          entry.purpose !== 'task-diff-review' &&
          entry.purpose !== 'task-implementation') ||
        !Number.isSafeInteger(entry.attempt) ||
        (entry.attempt as number) < 1 ||
        !['prepared', 'leased', 'succeeded', 'failed'].includes(
          String(entry.state),
        ) ||
        typeof entry.requestDigest !== 'string' ||
        !DIGEST.test(entry.requestDigest) ||
        typeof entry.manifestDigest !== 'string' ||
        !DIGEST.test(entry.manifestDigest) ||
        (entry.outputDigest !== null &&
          (typeof entry.outputDigest !== 'string' ||
            !DIGEST.test(entry.outputDigest))) ||
        (entry.failureDigest !== null &&
          (typeof entry.failureDigest !== 'string' ||
            !DIGEST.test(entry.failureDigest))) ||
        (entry.state === 'succeeded') !== (entry.outputDigest !== null) ||
        (entry.state === 'failed') !== (entry.failureDigest !== null)
      ) {
        throw candidateArtifactInvalid();
      }
      return {
        invocationId: entry.invocationId,
        investigationId: entry.investigationId,
        purpose: entry.purpose,
        attempt: entry.attempt,
        state: entry.state,
        requestDigest: entry.requestDigest,
        manifestDigest: entry.manifestDigest,
        outputDigest: entry.outputDigest,
        failureDigest: entry.failureDigest,
      } as CandidateProviderInvocation;
    });
    assertCanonicalArtifactEntries(invocations);
    const invocationIds = new Set(
      invocations.map(({ invocationId }) => invocationId),
    );
    if (invocationIds.size !== invocations.length) {
      throw candidateArtifactInvalid();
    }
    return {
      schemaVersion: 1,
      kind: value.kind,
      changeId: value.changeId,
      mandateBinding,
      invocations,
    };
  }
  if (value.kind === 'candidate-recovery-plan.v1') {
    if (
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'changeId',
        'mandateBinding',
        'targetRef',
        'expectedOldCommit',
        'expectedRefGeneration',
        'candidateCommit',
        'rollbackTarget',
      ]) ||
      typeof value.targetRef !== 'string' ||
      !validRef(value.targetRef) ||
      typeof value.expectedOldCommit !== 'string' ||
      !OBJECT_ID.test(value.expectedOldCommit) ||
      !Number.isSafeInteger(value.expectedRefGeneration) ||
      (value.expectedRefGeneration as number) < 0 ||
      typeof value.candidateCommit !== 'string' ||
      !OBJECT_ID.test(value.candidateCommit) ||
      value.candidateCommit === value.expectedOldCommit ||
      typeof value.rollbackTarget !== 'string' ||
      value.rollbackTarget !== value.expectedOldCommit
    ) {
      throw candidateArtifactInvalid();
    }
    return {
      schemaVersion: 1,
      kind: value.kind,
      changeId: value.changeId,
      mandateBinding,
      targetRef: value.targetRef,
      expectedOldCommit: value.expectedOldCommit,
      expectedRefGeneration: value.expectedRefGeneration as number,
      candidateCommit: value.candidateCommit,
      rollbackTarget: value.rollbackTarget,
    };
  }
  throw candidateArtifactInvalid();
}

function assertCanonicalArtifactEntries(values: unknown[]): void {
  const serialized = values.map((value) => canonicalJson(value));
  const sorted = [...serialized].sort();
  if (
    serialized.some((value, index) => value !== sorted[index]) ||
    new Set(serialized).size !== serialized.length
  ) {
    throw candidateArtifactInvalid();
  }
}

function assertCandidateMandateBinding(value: unknown): TaskMandateBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'mandateTaskId',
      'mandateId',
      'mandateDigest',
      'changeId',
      'externalAuditRoot',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.mandateTaskId !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value.mandateTaskId) ||
    value.mandateTaskId.length > 128 ||
    typeof value.mandateId !== 'string' ||
    !GRANT_ID.test(value.mandateId) ||
    typeof value.mandateDigest !== 'string' ||
    !DIGEST.test(value.mandateDigest) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    typeof value.externalAuditRoot !== 'string' ||
    !path.isAbsolute(value.externalAuditRoot) ||
    path.normalize(value.externalAuditRoot) !== value.externalAuditRoot
  ) {
    throw candidateError(
      'APPLY_CANDIDATE_MANDATE_BINDING_INVALID',
      'Candidate task mandate binding is malformed or incomplete.',
    );
  }
  return {
    schemaVersion: 1,
    mandateTaskId: value.mandateTaskId,
    mandateId: value.mandateId,
    mandateDigest: value.mandateDigest,
    changeId: value.changeId,
    externalAuditRoot: value.externalAuditRoot,
  };
}

function validArtifactLabel(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[a-z][a-z0-9.-]{0,127}$/.test(value) &&
    Buffer.byteLength(value, 'utf8') <= 128
  );
}

function candidateArtifactInvalid() {
  return candidateError(
    'APPLY_CANDIDATE_ARTIFACT_INVALID',
    'Candidate supporting artifact has an invalid canonical shape.',
  );
}

function assertCurrentCandidateChecksFreshness(
  attestation: CandidateChecksAttestationV3,
  options: CandidateV2CheckFreshnessOptions,
): void {
  const now = exactDate(options.now, 'attestation evaluation time').getTime();
  const requiredChecks = assertSortedUnique(
    options.requiredChecks,
    CHECK_ID,
    'required check IDs',
  );
  const waivedFreshnessCheckIds = assertSortedUnique(
    options.waivedFreshnessCheckIds ?? [],
    CHECK_ID,
    'waived freshness check IDs',
  );
  if (
    waivedFreshnessCheckIds.some((checkId) => !requiredChecks.includes(checkId))
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_BINDING_MISMATCH',
      'Named freshness waivers must reference exact required check IDs.',
    );
  }
  const waivedFreshness = new Set(waivedFreshnessCheckIds);
  if (
    attestation.candidateTree !== options.candidateTree ||
    attestation.patchDigest !== options.patchDigest ||
    attestation.trustBaseCommit !== options.trustBaseCommit ||
    !DIGEST.test(options.environmentDigest) ||
    !sameStrings(
      attestation.checks.map(({ checkId }) => checkId),
      requiredChecks,
    )
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_BINDING_MISMATCH',
      'Checks attestation does not bind the exact candidate and trust base.',
    );
  }
  for (const check of attestation.checks) {
    if (
      check.reuseClass === 'toolchain-dependent' &&
      check.environmentDigest !== options.environmentDigest
    ) {
      throw candidateError(
        'APPLY_ATTESTATION_ENVIRONMENT_MISMATCH',
        `Check ${check.checkId} was produced in another toolchain environment.`,
      );
    }
    const completedAt = Date.parse(check.completedAt);
    if (
      check.maxAgeMs !== null &&
      now - completedAt > check.maxAgeMs &&
      !waivedFreshness.has(check.checkId)
    ) {
      throw candidateError(
        'APPLY_ATTESTATION_STALE',
        `Check ${check.checkId} exceeded its original evidence validity window.`,
      );
    }
  }
}

export function assertCandidateV2ChecksFresh(
  raw: CandidateChecksAttestationV3,
  options: CandidateV2CheckFreshnessOptions,
): CandidateChecksAttestationV3 {
  const attestation = assertCandidateChecksAttestationV3(raw);
  const current = assertCandidateDependencySnapshot(
    options.currentDependencySnapshot,
    attestation.checks,
    false,
  );
  assertCurrentCandidateChecksFreshness(attestation, options);
  const sealed = attestation.dependencySnapshot;
  for (const check of attestation.checks) {
    const invalidated = check.dependsOn.some((dependency) => {
      switch (dependency) {
        case 'source-tree':
          return sealed.sourceTree !== current.sourceTree;
        case 'base-commit':
          return sealed.baseCommit !== current.baseCommit;
        case 'harness-engine':
          return sealed.harnessEngineDigest !== current.harnessEngineDigest;
        case 'policy':
          return sealed.policyDigest !== current.policyDigest;
        case 'runner':
          return (
            sealed.runnerDigests[check.checkId] !==
            current.runnerDigests[check.checkId]
          );
        case 'external-state':
          return (
            sealed.externalStateDigests[check.checkId] !==
            current.externalStateDigests[check.checkId]
          );
      }
    });
    if (invalidated) {
      throw candidateError(
        'APPLY_ATTESTATION_INVALIDATED',
        `Check ${check.checkId} depends on state that changed.`,
      );
    }
  }
  return attestation;
}

function assertCandidateChecksFields(
  value: CandidateChecksFields,
): CandidateChecksFields {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'candidateTree',
      'patchDigest',
      'trustBaseCommit',
      'checks',
    ]) ||
    !OBJECT_ID.test(value.candidateTree) ||
    !DIGEST.test(value.patchDigest) ||
    !OBJECT_ID.test(value.trustBaseCommit) ||
    !Array.isArray(value.checks) ||
    value.checks.length === 0
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_INVALID',
      'Candidate checks attestation is malformed.',
    );
  }
  const checks = value.checks.map((check) => {
    if (
      !isRecord(check) ||
      !hasExactKeys(check, [
        'checkId',
        'definitionDigest',
        'commandDigest',
        'runnerDigest',
        'environmentDigest',
        'resultDigest',
        'outcome',
        'startedAt',
        'completedAt',
        'reuseClass',
        'maxAgeMs',
        'externalSnapshotDigest',
        'dependsOn',
      ])
    ) {
      throw candidateError(
        'APPLY_ATTESTATION_INVALID',
        'Candidate check attestation contains unknown or missing fields.',
      );
    }
    const startedAt = exactTimestamp(check.startedAt, 'check start time');
    const completedAt = exactTimestamp(
      check.completedAt,
      'check completion time',
    );
    const dependsOn = assertSortedUnique(
      check.dependsOn,
      /^(?:source-tree|base-commit|harness-engine|policy|runner|external-state)$/,
      'check dependencies',
    ) as CheckDependency[];
    if (
      !CHECK_ID.test(check.checkId) ||
      !DIGEST.test(check.definitionDigest) ||
      !DIGEST.test(check.commandDigest) ||
      !DIGEST.test(check.runnerDigest) ||
      !DIGEST.test(check.environmentDigest) ||
      !DIGEST.test(check.resultDigest) ||
      check.outcome !== 'passed' ||
      Date.parse(startedAt) > Date.parse(completedAt) ||
      !['content-pure', 'toolchain-dependent', 'external-state'].includes(
        check.reuseClass,
      ) ||
      (check.maxAgeMs !== null &&
        (!Number.isSafeInteger(check.maxAgeMs) || check.maxAgeMs < 1)) ||
      (check.reuseClass !== 'content-pure' && check.maxAgeMs === null) ||
      (check.externalSnapshotDigest !== null &&
        !DIGEST.test(check.externalSnapshotDigest)) ||
      (check.reuseClass === 'external-state' &&
        check.externalSnapshotDigest === null)
    ) {
      throw candidateError(
        'APPLY_ATTESTATION_INVALID',
        `Candidate check ${check.checkId || '<unknown>'} is malformed.`,
      );
    }
    return { ...check, startedAt, completedAt, dependsOn };
  });
  const ids = checks.map(({ checkId }) => checkId);
  if (!sameStrings(ids, [...new Set(ids)].sort())) {
    throw candidateError(
      'APPLY_ATTESTATION_INVALID',
      'Candidate checks must be sorted and unique.',
    );
  }
  return {
    candidateTree: value.candidateTree,
    patchDigest: value.patchDigest,
    trustBaseCommit: value.trustBaseCommit,
    checks,
  };
}

function assertCandidateChecksAttestationV3(
  value: CandidateChecksAttestationV3,
): CandidateChecksAttestationV3 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'candidateTree',
      'patchDigest',
      'trustBaseCommit',
      'dependencySnapshot',
      'checks',
    ]) ||
    value.schemaVersion !== 3 ||
    !isRecord(value.dependencySnapshot)
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_INVALID',
      'Candidate v2 checks attestation is malformed.',
    );
  }
  const fields = assertCandidateChecksFields({
    candidateTree: value.candidateTree,
    patchDigest: value.patchDigest,
    trustBaseCommit: value.trustBaseCommit,
    checks: value.checks,
  });
  const dependencySnapshot = assertCandidateDependencySnapshot(
    value.dependencySnapshot,
    fields.checks,
  );
  if (
    dependencySnapshot.sourceTree !== fields.candidateTree ||
    dependencySnapshot.baseCommit !== fields.trustBaseCommit
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_BINDING_MISMATCH',
      'Candidate dependency snapshot differs from its candidate tree or trust base.',
    );
  }
  return {
    schemaVersion: 3,
    candidateTree: fields.candidateTree,
    patchDigest: fields.patchDigest,
    trustBaseCommit: fields.trustBaseCommit,
    dependencySnapshot,
    checks: fields.checks,
  };
}

function assertCandidateDependencySnapshot(
  value: Record<string, unknown> | CandidateDependencySnapshot,
  checks: CandidateCheckAttestation[],
  bindToAttestation = true,
): CandidateDependencySnapshot {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'sourceTree',
      'baseCommit',
      'harnessEngineDigest',
      'policyDigest',
      'runnerDigests',
      'externalStateDigests',
    ]) ||
    value.schemaVersion !== 1 ||
    typeof value.sourceTree !== 'string' ||
    !OBJECT_ID.test(value.sourceTree) ||
    typeof value.baseCommit !== 'string' ||
    !OBJECT_ID.test(value.baseCommit) ||
    typeof value.harnessEngineDigest !== 'string' ||
    !DIGEST.test(value.harnessEngineDigest) ||
    typeof value.policyDigest !== 'string' ||
    !DIGEST.test(value.policyDigest) ||
    !isRecord(value.runnerDigests) ||
    !isRecord(value.externalStateDigests)
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_INVALID',
      'Candidate dependency snapshot is malformed.',
    );
  }
  const checkIds = checks.map(({ checkId }) => checkId);
  if (
    !sameStrings(Object.keys(value.runnerDigests).sort(), checkIds) ||
    !sameStrings(Object.keys(value.externalStateDigests).sort(), checkIds)
  ) {
    throw candidateError(
      'APPLY_ATTESTATION_INVALID',
      'Candidate dependency snapshot must exactly cover every required check.',
    );
  }
  const runnerDigests: Record<string, string> = {};
  const externalStateDigests: Record<string, string | null> = {};
  for (const check of checks) {
    const runnerDigest = value.runnerDigests[check.checkId];
    const externalStateDigest = value.externalStateDigests[check.checkId];
    if (
      typeof runnerDigest !== 'string' ||
      !DIGEST.test(runnerDigest) ||
      (bindToAttestation && runnerDigest !== check.runnerDigest) ||
      (externalStateDigest !== null &&
        (typeof externalStateDigest !== 'string' ||
          !DIGEST.test(externalStateDigest))) ||
      (check.dependsOn.includes('external-state') &&
        (externalStateDigest === null ||
          (bindToAttestation &&
            externalStateDigest !== check.externalSnapshotDigest))) ||
      (!check.dependsOn.includes('external-state') &&
        externalStateDigest !== null)
    ) {
      throw candidateError(
        'APPLY_ATTESTATION_INVALID',
        `Candidate dependency snapshot for ${check.checkId} is malformed.`,
      );
    }
    runnerDigests[check.checkId] = runnerDigest;
    externalStateDigests[check.checkId] = externalStateDigest;
  }
  return {
    schemaVersion: 1,
    sourceTree: value.sourceTree,
    baseCommit: value.baseCommit,
    harnessEngineDigest: value.harnessEngineDigest,
    policyDigest: value.policyDigest,
    runnerDigests,
    externalStateDigests,
  };
}

// The apply crash journal for production commits is AuthorityCommitJournal in
// maintainer-recovery.ts — the normative implementation of the plan's apply
// write-ahead model. A second journal lived here with tests and no callers;
// a normative table proven only on an unused module proves nothing about the
// recovery path that runs, so the copy is gone rather than kept aligned.

function assertSortedUnique(
  values: readonly string[],
  pattern: RegExp,
  label: string,
): string[] {
  if (!Array.isArray(values)) {
    throw candidateError(
      'APPLY_CONTRACT_INVALID',
      `${label} must be an array.`,
    );
  }
  const result = [...values];
  const sorted = [...new Set(result)].sort();
  if (
    !sameStrings(result, sorted) ||
    result.some((value) => typeof value !== 'string' || !pattern.test(value))
  ) {
    throw candidateError(
      'APPLY_CONTRACT_INVALID',
      `${label} must be valid, sorted, and unique.`,
    );
  }
  return result;
}

export function validRef(value: string): boolean {
  return (
    typeof value === 'string' &&
    TARGET_REF.test(value) &&
    !value.includes('..') &&
    !value.includes('//') &&
    !value.endsWith('.') &&
    !value.endsWith('/')
  );
}

function validCommitMessage(value: string): boolean {
  return (
    typeof value === 'string' &&
    value.length >= 2 &&
    value.length <= 16_384 &&
    value.endsWith('\n') &&
    !value.endsWith('\n\n') &&
    !value.includes('\r') &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint === 0 || (codePoint < 32 && character !== '\n');
    })
  );
}

export function exactTimestamp(value: string, label: string): string {
  if (typeof value !== 'string') {
    throw candidateError('APPLY_TIME_INVALID', `${label} is invalid.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) {
    throw candidateError('APPLY_TIME_INVALID', `${label} is invalid.`);
  }
  return value;
}

function exactDate(value: Date, label: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw candidateError('APPLY_TIME_INVALID', `${label} is invalid.`);
  }
  return date;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    actual.length === sorted.length &&
    actual.every((key, index) => key === sorted[index])
  );
}

export function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function candidateError(code: string, message: string) {
  return workflowError(code, message, ExitCode.guard);
}

export type CheckReuseClass =
  'content-pure' | 'toolchain-dependent' | 'external-state';

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

export type CandidateChecksFields = {
  candidateTree: string;
  patchDigest: string;
  trustBaseCommit: string;
  checks: CandidateCheckAttestation[];
};
