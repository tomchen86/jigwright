import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildLocalJigwrightRelease,
  type LocalJigwrightReleaseMatrixV1,
} from './build-local-jigwright-release.ts';
import { runLocalJigwrightAdoption } from './run-local-jigwright-adoption.ts';
import { canonicalJson } from '../packages/core/src/canonical-json.ts';
import { verifySshDataSignature } from '../packages/workflow-engine/src/adapters/signing/ssh/ci-signature.ts';
import {
  loadMaintainerPolicy,
  type TrustedMaintainerSigner,
} from '../packages/workflow-engine/src/modules/authority/maintainer-policy.ts';
import { verifyProviderAvailabilityPilot } from '../packages/workflow-engine/src/runtime/provider-execution/provider-availability-pilot.ts';

type CandidateStatus =
  'complete' | 'implementation-ready' | 'operational-gate-pending';
type Sha256Digest = `sha256:${string}`;
type ReleaseEvidenceClaimKind =
  | 'full-gate'
  | 'real-pilot'
  | 'self-hosting-independent-review'
  | 'signed-provenance';

export const JIGWRIGHT_V1_RELEASE_EVIDENCE_SIGNATURE_NAMESPACE =
  'jigwright.release-readiness-evidence.v1' as const;

export type JigwrightV1ReleaseEvidenceSubject = Readonly<{
  kind: 'jigwright-v1-release-subject.v1';
  sourceCommit: string;
  sourceTree: string;
  packageSetDigest: Sha256Digest;
  releaseMatrix: Readonly<{
    schemaVersion: 1;
    kind: 'jigwright-release-compatibility-matrix.v1';
    releaseChannel: LocalJigwrightReleaseMatrixV1['releaseChannel'];
    digest: Sha256Digest;
  }>;
}>;

export type VerifiedJigwrightV1ReleaseEvidence = Readonly<{
  kind: 'verified-jigwright-v1-release-evidence.v1';
  subject: JigwrightV1ReleaseEvidenceSubject;
  objectDigest: Sha256Digest;
  signerIdentity: string;
  claims: Readonly<{
    fullGate: boolean;
    realPilot: boolean;
    selfHostingIndependentReview: boolean;
    signedProvenance: boolean;
  }>;
}>;

export type JigwrightV1ReleaseCandidateDossier = Readonly<{
  schemaVersion: 1;
  kind: 'jigwright-v1-release-candidate-dossier.v1';
  status: 'implementation-ready';
  release: LocalJigwrightReleaseMatrixV1;
  reproducibleBuild: true;
  selfHosting: Readonly<{
    rule: 'n-plus-one-uses-n';
    firstReleaseBootstrap: 'narrow-one-time-embedded-baseline';
    authorityCommit: 'b149246ee02872cac517880f9bf9ba3a01d7c467';
    appliesOnlyToVersion: '0.1.0';
    nextRequiredAuthorityVersion: '0.1.0';
    independentReview: 'pending' | 'complete';
  }>;
  installAssurance: Readonly<{
    packageManager: 'pnpm@11.12.0';
    offline: true;
    lifecycleScriptsDenied: true;
    frozenLockfile: true;
    exactVersions: true;
    omittedOptionalPackages: readonly string[];
    exactDowngradeRehearsed: true;
    downgradeArtifactPath: 'adoption/downgrade';
  }>;
  governanceBudget: Readonly<{
    contract: 'jigwright-governance-budget.v1';
    defaultOrdinaryFloor: 'session-independent';
    requiredPerChangeAgentPlans: 0;
    signedGrants: 0;
    forcedDiversityCalls: 0;
    quietTriggeredDuplicateAttempts: 0;
    repeatedDataAuthorizationPrompts: 0;
    customProviderSourceChanges: 0;
  }>;
  genericBoundary: Readonly<{
    status: 'clear' | 'extraction-pending';
    consumerOwnedAdapterSourceFiles: number;
    findingDigest: `sha256:${string}`;
  }>;
  historicalAssurance: Readonly<{
    managedTrailers: 'replayed';
    reports: 'read-only-dual-run';
    ci: 'read-only-dual-run';
    unknownSchemas: 'fail-closed';
    planningBindingMigration: 'mixed-bindings-refused';
    agentExecutionMigration: 'exact-version-read-only-dual-run';
    providerAvailability: Readonly<{
      authority: 'empirical-observation-only';
      accepted: true;
      decision: 'healthy-two-provider-observed';
      recordDigest: string;
      futureSla: false;
    }>;
  }>;
  extraction: Readonly<{
    schemaVersion: 1;
    steps: readonly Readonly<{
      step: number;
      name: string;
      state: CandidateStatus;
      evidence: string;
    }>[];
  }>;
  operationalGates: Readonly<{
    realPilot: 'real-pilot-pending' | 'complete';
    fullGate: 'full-gate-pending' | 'complete';
    registryPublish: 'not-requested';
  }>;
  evidence: Readonly<{
    releaseRoot: 'release';
    adoptionReportDigest: `sha256:${string}`;
    dossierPath: 'release-dossier.json';
    releaseReadiness: Readonly<{
      contract: 'jigwright-v1-release-readiness-evidence.v1';
      input: 'not-supplied' | 'verified';
      objectDigest: Sha256Digest | null;
      signedProvenance: 'signed-provenance-pending' | 'complete';
    }>;
  }>;
}>;

export type JigwrightV1PublishReadiness = Readonly<{
  status: 'implementation-ready';
  publishable: boolean;
  blockers: readonly string[];
}>;

const BOOTSTRAP_AUTHORITY_COMMIT =
  'b149246ee02872cac517880f9bf9ba3a01d7c467' as const;
const RELEASE_EVIDENCE_OBJECT_BYTES_MAX = 1_048_576;
const RELEASE_EVIDENCE_SIGNATURE_BYTES_MAX = 16_384;
const RELEASE_EVIDENCE_CLAIM_KINDS = [
  'full-gate',
  'real-pilot',
  'self-hosting-independent-review',
  'signed-provenance',
] as const satisfies readonly ReleaseEvidenceClaimKind[];
const verifiedReleaseEvidence = new WeakSet<object>();

export function prepareJigwrightV1ReleaseCandidate(
  requestedRepositoryRoot: string,
  requestedOutputRoot: string,
  options: Readonly<{
    allowDirty?: boolean;
    releaseEvidenceObjectPath?: string;
  }> = {},
): JigwrightV1ReleaseCandidateDossier {
  const repositoryRoot = fs.realpathSync(requestedRepositoryRoot);
  const outputRoot = path.resolve(requestedOutputRoot);
  const releaseRoot = path.join(outputRoot, 'release');
  const comparisonRoot = path.join(outputRoot, 'reproducibility-second');
  const adoptionRoot = path.join(outputRoot, 'adoption');
  fs.mkdirSync(outputRoot, { recursive: true });
  assertBootstrapAuthority(repositoryRoot);

  const release = buildLocalJigwrightRelease(repositoryRoot, releaseRoot, {
    allowDirty: options.allowDirty,
    releaseChannel: 'local-candidate',
  });
  const comparison = buildLocalJigwrightRelease(
    repositoryRoot,
    comparisonRoot,
    { allowDirty: options.allowDirty, releaseChannel: 'local-candidate' },
  );
  assertReproducible(releaseRoot, comparisonRoot, release, comparison);

  const adoption = runLocalJigwrightAdoption(repositoryRoot, adoptionRoot, {
    allowDirty: options.allowDirty,
  });
  if (
    adoption.install.networkPolicy !== 'offline-local-tarballs' ||
    adoption.install.packageManager !== 'pnpm@11.12.0' ||
    adoption.install.frozenLockfileVerified !== true ||
    adoption.install.lifecycleScriptsDenied !== true ||
    adoption.downgrade.exactDependencyRemoved !== true ||
    adoption.parity.equal !== true
  ) {
    throw new Error('Jigwright v1 install or downgrade assurance failed.');
  }
  const genericBoundary = inspectGenericReleaseBoundary(repositoryRoot);
  const releaseBindings = readReleaseBindings(repositoryRoot);
  const availability = verifyProviderAvailabilityPilot(
    repositoryRoot,
    releaseBindings.providerAvailabilityRecordPath,
  );
  if (
    availability.authority !== 'empirical-observation-only' ||
    availability.accepted !== true ||
    availability.decision !== 'healthy-two-provider-observed'
  ) {
    throw new Error('Historical C-AVAILABILITY verification failed.');
  }
  const suppliedReleaseEvidence =
    options.releaseEvidenceObjectPath === undefined
      ? null
      : verifyJigwrightV1ReleaseEvidenceObject(
          options.releaseEvidenceObjectPath,
          release,
          loadMaintainerPolicy(repositoryRoot).trustedSigners,
        );
  const releaseEvidenceProjection = evidenceProjection(suppliedReleaseEvidence);

  const pendingDossier: JigwrightV1ReleaseCandidateDossier = {
    schemaVersion: 1,
    kind: 'jigwright-v1-release-candidate-dossier.v1',
    status: 'implementation-ready',
    release,
    reproducibleBuild: true,
    selfHosting: {
      rule: 'n-plus-one-uses-n',
      firstReleaseBootstrap: 'narrow-one-time-embedded-baseline',
      authorityCommit: BOOTSTRAP_AUTHORITY_COMMIT,
      appliesOnlyToVersion: '0.1.0',
      nextRequiredAuthorityVersion: '0.1.0',
      independentReview: releaseEvidenceProjection.selfHostingIndependentReview
        ? 'complete'
        : 'pending',
    },
    installAssurance: {
      packageManager: 'pnpm@11.12.0',
      offline: true,
      lifecycleScriptsDenied: true,
      frozenLockfile: true,
      exactVersions: true,
      omittedOptionalPackages: adoption.install.omittedOptionalPackages,
      exactDowngradeRehearsed: true,
      downgradeArtifactPath: 'adoption/downgrade',
    },
    governanceBudget: {
      contract: 'jigwright-governance-budget.v1',
      defaultOrdinaryFloor: 'session-independent',
      requiredPerChangeAgentPlans: 0,
      signedGrants: 0,
      forcedDiversityCalls: 0,
      quietTriggeredDuplicateAttempts: 0,
      repeatedDataAuthorizationPrompts: 0,
      customProviderSourceChanges: 0,
    },
    genericBoundary,
    historicalAssurance: {
      managedTrailers: 'replayed',
      reports: 'read-only-dual-run',
      ci: 'read-only-dual-run',
      unknownSchemas: 'fail-closed',
      planningBindingMigration: 'mixed-bindings-refused',
      agentExecutionMigration: 'exact-version-read-only-dual-run',
      providerAvailability: {
        authority: 'empirical-observation-only',
        accepted: true,
        decision: 'healthy-two-provider-observed',
        recordDigest: availability.recordDigest,
        futureSla: false,
      },
    },
    extraction: {
      schemaVersion: 1,
      steps: candidateExtractionSteps(release, releaseEvidenceProjection),
    },
    operationalGates: {
      realPilot: releaseEvidenceProjection.realPilot
        ? 'complete'
        : 'real-pilot-pending',
      fullGate: releaseEvidenceProjection.fullGate
        ? 'complete'
        : 'full-gate-pending',
      registryPublish: 'not-requested',
    },
    evidence: {
      releaseRoot: 'release',
      adoptionReportDigest: digestCanonical(adoption),
      dossierPath: 'release-dossier.json',
      releaseReadiness: {
        contract: 'jigwright-v1-release-readiness-evidence.v1',
        input: suppliedReleaseEvidence === null ? 'not-supplied' : 'verified',
        objectDigest: suppliedReleaseEvidence?.objectDigest ?? null,
        signedProvenance: releaseEvidenceProjection.signedProvenance
          ? 'complete'
          : 'signed-provenance-pending',
      },
    },
  };
  const dossier = Object.freeze(pendingDossier);
  writeJson(path.join(outputRoot, dossier.evidence.dossierPath), dossier);
  return dossier;
}

export function jigwrightV1ReleaseEvidenceSubject(
  release: LocalJigwrightReleaseMatrixV1,
): JigwrightV1ReleaseEvidenceSubject {
  return Object.freeze({
    kind: 'jigwright-v1-release-subject.v1' as const,
    sourceCommit: release.source.commit,
    sourceTree: release.source.tree,
    packageSetDigest: release.packageSetDigest,
    releaseMatrix: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'jigwright-release-compatibility-matrix.v1' as const,
      releaseChannel: release.releaseChannel,
      digest: digestCanonical(release),
    }),
  });
}

export function verifyJigwrightV1ReleaseEvidenceObject(
  requestedObjectPath: string,
  release: LocalJigwrightReleaseMatrixV1,
  trustedSigners: readonly TrustedMaintainerSigner[],
): VerifiedJigwrightV1ReleaseEvidence {
  if (release.source.dirty) {
    throw new Error(
      'Jigwright release evidence requires a clean source release matrix.',
    );
  }
  const objectPath = path.resolve(requestedObjectPath);
  const stats = fs.lstatSync(objectPath, { throwIfNoEntry: false });
  if (
    stats === undefined ||
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size > RELEASE_EVIDENCE_OBJECT_BYTES_MAX
  ) {
    throw new Error('Jigwright release evidence object is missing or unsafe.');
  }
  const address = path
    .basename(objectPath)
    .match(/^([0-9a-f]{64})\.json$/u)?.[1];
  if (
    path.basename(path.dirname(objectPath)) !== 'sha256' ||
    address === undefined
  ) {
    throw new Error(
      'Jigwright release evidence must use a sha256 content address.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(objectPath, 'utf8'));
  } catch {
    throw new Error('Jigwright release evidence object is invalid JSON.');
  }
  const envelope = parseReleaseEvidenceEnvelope(value);
  const observedObjectDigest = digestCanonical(envelope);
  if (observedObjectDigest !== `sha256:${address}`) {
    throw new Error('Jigwright release evidence content address is invalid.');
  }
  const expectedSubject = jigwrightV1ReleaseEvidenceSubject(release);
  if (
    canonicalJson(envelope.payload.subject) !== canonicalJson(expectedSubject)
  ) {
    throw new Error(
      'Jigwright release evidence subject does not match the exact release matrix.',
    );
  }
  const signer = trustedSigners.find(
    ({ identity }) => identity === envelope.payload.signerIdentity,
  );
  if (signer === undefined) {
    throw new Error('Jigwright release evidence signer is untrusted.');
  }
  verifySshDataSignature(
    canonicalJson(envelope.payload),
    envelope.signature,
    signer,
    JIGWRIGHT_V1_RELEASE_EVIDENCE_SIGNATURE_NAMESPACE,
    'JIGWRIGHT_RELEASE_EVIDENCE_INVALID',
  );
  const claimKinds = new Set(envelope.payload.claims.map(({ kind }) => kind));
  const verified = Object.freeze({
    kind: 'verified-jigwright-v1-release-evidence.v1' as const,
    subject: expectedSubject,
    objectDigest: observedObjectDigest,
    signerIdentity: signer.identity,
    claims: Object.freeze({
      fullGate: claimKinds.has('full-gate'),
      realPilot: claimKinds.has('real-pilot'),
      selfHostingIndependentReview: claimKinds.has(
        'self-hosting-independent-review',
      ),
      signedProvenance: claimKinds.has('signed-provenance'),
    }),
  });
  verifiedReleaseEvidence.add(verified);
  return verified;
}

export function applyVerifiedJigwrightV1ReleaseEvidence(
  dossier: JigwrightV1ReleaseCandidateDossier,
  evidence: VerifiedJigwrightV1ReleaseEvidence,
): JigwrightV1ReleaseCandidateDossier {
  if (
    !verifiedReleaseEvidence.has(evidence) ||
    dossier.release.source.dirty ||
    canonicalJson(evidence.subject) !==
      canonicalJson(jigwrightV1ReleaseEvidenceSubject(dossier.release))
  ) {
    throw new Error(
      'Jigwright release evidence is not verified for this exact dossier.',
    );
  }
  const projection = evidenceProjection(evidence);
  return Object.freeze({
    ...dossier,
    selfHosting: Object.freeze({
      ...dossier.selfHosting,
      independentReview: projection.selfHostingIndependentReview
        ? ('complete' as const)
        : ('pending' as const),
    }),
    extraction: Object.freeze({
      schemaVersion: 1 as const,
      steps: candidateExtractionSteps(dossier.release, projection),
    }),
    operationalGates: Object.freeze({
      realPilot: projection.realPilot
        ? ('complete' as const)
        : ('real-pilot-pending' as const),
      fullGate: projection.fullGate
        ? ('complete' as const)
        : ('full-gate-pending' as const),
      registryPublish: 'not-requested' as const,
    }),
    evidence: Object.freeze({
      ...dossier.evidence,
      releaseReadiness: Object.freeze({
        contract: 'jigwright-v1-release-readiness-evidence.v1' as const,
        input: 'verified' as const,
        objectDigest: evidence.objectDigest,
        signedProvenance: projection.signedProvenance
          ? ('complete' as const)
          : ('signed-provenance-pending' as const),
      }),
    }),
  });
}

export function assessJigwrightV1PublishReadiness(
  dossier: JigwrightV1ReleaseCandidateDossier,
  mode: 'candidate' | 'publish',
): JigwrightV1PublishReadiness {
  const blockers: string[] = [];
  if (dossier.release.source.dirty) blockers.push('clean-source-required');
  if (dossier.genericBoundary.status !== 'clear') {
    blockers.push('consumer-policy-extraction-pending');
  }
  if (dossier.selfHosting.independentReview !== 'complete') {
    blockers.push('independent-bootstrap-review-pending');
  }
  if (
    dossier.release.packages.some(({ license }) => license === 'UNLICENSED')
  ) {
    blockers.push('license-decision-pending');
  }
  if (dossier.evidence.releaseReadiness.signedProvenance !== 'complete') {
    blockers.push('signed-provenance-pending');
  }
  if (dossier.operationalGates.realPilot !== 'complete') {
    blockers.push('real-pilot-pending');
  }
  if (dossier.operationalGates.fullGate !== 'complete') {
    blockers.push('full-gate-pending');
  }
  if (dossier.operationalGates.registryPublish !== ('requested' as string)) {
    blockers.push('registry-publish-not-requested');
  }
  const result = Object.freeze({
    status: 'implementation-ready' as const,
    publishable: blockers.length === 0,
    blockers: Object.freeze(blockers),
  });
  if (mode === 'publish' && !result.publishable) {
    throw new Error(
      `Jigwright v1 is not publishable: ${result.blockers.join(', ')}.`,
    );
  }
  return result;
}

function assertBootstrapAuthority(repositoryRoot: string): void {
  const result = runGit(repositoryRoot, [
    'merge-base',
    '--is-ancestor',
    BOOTSTRAP_AUTHORITY_COMMIT,
    'HEAD',
  ]);
  if (result !== '') {
    throw new Error('Unexpected output from Jigwright bootstrap validation.');
  }
}

function assertReproducible(
  firstRoot: string,
  secondRoot: string,
  first: LocalJigwrightReleaseMatrixV1,
  second: LocalJigwrightReleaseMatrixV1,
): void {
  if (
    first.packageSetDigest !== second.packageSetDigest ||
    first.packages.some(
      (entry, index) =>
        entry.digest !== second.packages[index]?.digest ||
        entry.tarball !== second.packages[index]?.tarball,
    )
  ) {
    throw new Error('Jigwright v1 package build is not reproducible.');
  }
  for (const relativePath of [
    'compatibility-matrix.json',
    'integrity.json',
    'provenance.intoto.json',
    'sbom.cdx.json',
    'extraction-sequence.json',
  ]) {
    if (
      !fs
        .readFileSync(path.join(firstRoot, relativePath))
        .equals(fs.readFileSync(path.join(secondRoot, relativePath)))
    ) {
      throw new Error(
        `Jigwright v1 release evidence is not reproducible: ${relativePath}.`,
      );
    }
  }
}

function inspectGenericReleaseBoundary(
  repositoryRoot: string,
): JigwrightV1ReleaseCandidateDossier['genericBoundary'] {
  const consumerRoot = path.join(
    repositoryRoot,
    'packages/workflow-engine/src/adapters/consumer/repository',
  );
  const files = listRegularFiles(consumerRoot).map((filePath) =>
    path.relative(repositoryRoot, filePath).split(path.sep).join('/'),
  );
  return Object.freeze({
    status: files.length === 0 ? 'clear' : 'extraction-pending',
    consumerOwnedAdapterSourceFiles: files.length,
    findingDigest: digestCanonical(files),
  });
}

function readReleaseBindings(repositoryRoot: string): Readonly<{
  providerAvailabilityRecordPath: string;
}> {
  const value: unknown = JSON.parse(
    fs.readFileSync(
      path.join(repositoryRoot, 'release/v1/bindings.json'),
      'utf8',
    ),
  );
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof Reflect.get(value, 'providerAvailabilityRecordPath') !== 'string'
  ) {
    throw new Error('Jigwright release availability binding is invalid.');
  }
  return {
    providerAvailabilityRecordPath: Reflect.get(
      value,
      'providerAvailabilityRecordPath',
    ) as string,
  };
}

function listRegularFiles(root: string): string[] {
  const stats = fs.lstatSync(root, { throwIfNoEntry: false });
  if (stats === undefined) return [];
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Jigwright consumer-owned adapter root is unsafe.');
  }
  const result: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('Jigwright consumer-owned adapter root is unsafe.');
      }
      if (entry.isDirectory()) visit(candidate);
      else if (entry.isFile()) result.push(candidate);
      else throw new Error('Jigwright consumer-owned adapter root is unsafe.');
    }
  };
  visit(root);
  return result;
}

function candidateExtractionSteps(
  release: LocalJigwrightReleaseMatrixV1,
  releaseEvidence: Readonly<{
    objectDigest: Sha256Digest | null;
    fullGate: boolean;
    realPilot: boolean;
    selfHostingIndependentReview: boolean;
    signedProvenance: boolean;
  }>,
): JigwrightV1ReleaseCandidateDossier['extraction']['steps'] {
  return [
    {
      step: 1,
      name: 'freeze-source-and-public-interface-digests',
      state: release.source.dirty ? 'implementation-ready' : 'complete',
      evidence: release.packageSetDigest,
    },
    {
      step: 2,
      name: 'create-independent-repository-without-history-rewrite',
      state: 'complete',
      evidence: `${release.source.commit}:${release.source.tree}`,
    },
    {
      step: 3,
      name: 'import-packages-tests-fixtures-docs-and-license-state',
      state: 'complete',
      evidence: 'release/compatibility-matrix.json',
    },
    {
      step: 4,
      name: 'configure-n-plus-one-self-hosting-with-n',
      state: releaseEvidence.selfHostingIndependentReview
        ? 'complete'
        : 'implementation-ready',
      evidence:
        releaseEvidence.selfHostingIndependentReview &&
        releaseEvidence.objectDigest !== null
          ? releaseEvidence.objectDigest
          : `${BOOTSTRAP_AUTHORITY_COMMIT}:independent-review-pending`,
    },
    {
      step: 5,
      name: 'rerun-portability-and-supply-chain-assurance',
      state:
        releaseEvidence.signedProvenance &&
        releaseEvidence.realPilot &&
        releaseEvidence.fullGate
          ? 'complete'
          : 'implementation-ready',
      evidence:
        releaseEvidence.signedProvenance &&
        releaseEvidence.realPilot &&
        releaseEvidence.fullGate &&
        releaseEvidence.objectDigest !== null
          ? releaseEvidence.objectDigest
          : 'release/integrity.json:real-pilot-pending',
    },
    {
      step: 6,
      name: 'build-release-candidate-and-fresh-install',
      state: 'complete',
      evidence: 'adoption/consumer/pnpm-lock.yaml',
    },
    {
      step: 7,
      name: 'rehearse-exact-upgrade-and-downgrade',
      state: 'complete',
      evidence: 'adoption/downgrade',
    },
    {
      step: 8,
      name: 'publish-v1-and-record-support-policy',
      state: 'operational-gate-pending',
      evidence: 'registry-publish-not-requested',
    },
  ];
}

function evidenceProjection(
  evidence: VerifiedJigwrightV1ReleaseEvidence | null,
): Readonly<{
  objectDigest: Sha256Digest | null;
  fullGate: boolean;
  realPilot: boolean;
  selfHostingIndependentReview: boolean;
  signedProvenance: boolean;
}> {
  return Object.freeze({
    objectDigest: evidence?.objectDigest ?? null,
    fullGate: evidence?.claims.fullGate ?? false,
    realPilot: evidence?.claims.realPilot ?? false,
    selfHostingIndependentReview:
      evidence?.claims.selfHostingIndependentReview ?? false,
    signedProvenance: evidence?.claims.signedProvenance ?? false,
  });
}

function parseReleaseEvidenceEnvelope(value: unknown): Readonly<{
  payload: Readonly<{
    schemaVersion: 1;
    kind: 'jigwright-v1-release-readiness-evidence.v1';
    signatureNamespace: typeof JIGWRIGHT_V1_RELEASE_EVIDENCE_SIGNATURE_NAMESPACE;
    signerIdentity: string;
    subject: JigwrightV1ReleaseEvidenceSubject;
    claims: readonly Readonly<{
      kind: ReleaseEvidenceClaimKind;
      result: 'complete';
      artifactDigest: Sha256Digest;
    }>[];
  }>;
  payloadDigest: Sha256Digest;
  signature: string;
}> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['payload', 'payloadDigest', 'signature'])
  ) {
    throw new Error('Jigwright release evidence envelope is invalid.');
  }
  const payload = parseReleaseEvidencePayload(value.payload);
  if (
    !isSha256Digest(value.payloadDigest) ||
    value.payloadDigest !== digestCanonical(payload) ||
    typeof value.signature !== 'string' ||
    Buffer.byteLength(value.signature) > RELEASE_EVIDENCE_SIGNATURE_BYTES_MAX ||
    !value.signature.startsWith('-----BEGIN SSH SIGNATURE-----\n') ||
    !value.signature.endsWith('-----END SSH SIGNATURE-----\n')
  ) {
    throw new Error(
      'Jigwright release evidence envelope is forged or invalid.',
    );
  }
  return Object.freeze({
    payload,
    payloadDigest: value.payloadDigest,
    signature: value.signature,
  });
}

function parseReleaseEvidencePayload(value: unknown): Readonly<{
  schemaVersion: 1;
  kind: 'jigwright-v1-release-readiness-evidence.v1';
  signatureNamespace: typeof JIGWRIGHT_V1_RELEASE_EVIDENCE_SIGNATURE_NAMESPACE;
  signerIdentity: string;
  subject: JigwrightV1ReleaseEvidenceSubject;
  claims: readonly Readonly<{
    kind: ReleaseEvidenceClaimKind;
    result: 'complete';
    artifactDigest: Sha256Digest;
  }>[];
}> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'claims',
      'kind',
      'schemaVersion',
      'signatureNamespace',
      'signerIdentity',
      'subject',
    ]) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'jigwright-v1-release-readiness-evidence.v1' ||
    value.signatureNamespace !==
      JIGWRIGHT_V1_RELEASE_EVIDENCE_SIGNATURE_NAMESPACE ||
    typeof value.signerIdentity !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/u.test(value.signerIdentity) ||
    !Array.isArray(value.claims) ||
    value.claims.length === 0 ||
    value.claims.length > RELEASE_EVIDENCE_CLAIM_KINDS.length
  ) {
    throw new Error('Jigwright release evidence payload is invalid.');
  }
  const subject = parseReleaseEvidenceSubject(value.subject);
  const claims = value.claims.map(parseReleaseEvidenceClaim);
  const observedKinds = claims.map(({ kind }) => kind);
  const sortedKinds = [...new Set(observedKinds)].sort();
  if (
    observedKinds.length !== sortedKinds.length ||
    observedKinds.some((kind, index) => kind !== sortedKinds[index])
  ) {
    throw new Error(
      'Jigwright release evidence claims must be sorted and unique.',
    );
  }
  return Object.freeze({
    schemaVersion: 1 as const,
    kind: 'jigwright-v1-release-readiness-evidence.v1' as const,
    signatureNamespace: JIGWRIGHT_V1_RELEASE_EVIDENCE_SIGNATURE_NAMESPACE,
    signerIdentity: value.signerIdentity,
    subject,
    claims: Object.freeze(claims),
  });
}

function parseReleaseEvidenceSubject(
  value: unknown,
): JigwrightV1ReleaseEvidenceSubject {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'kind',
      'packageSetDigest',
      'releaseMatrix',
      'sourceCommit',
      'sourceTree',
    ]) ||
    value.kind !== 'jigwright-v1-release-subject.v1' ||
    !isGitObjectId(value.sourceCommit) ||
    !isGitObjectId(value.sourceTree) ||
    !isSha256Digest(value.packageSetDigest) ||
    !isRecord(value.releaseMatrix) ||
    !hasExactKeys(value.releaseMatrix, [
      'digest',
      'kind',
      'releaseChannel',
      'schemaVersion',
    ]) ||
    value.releaseMatrix.schemaVersion !== 1 ||
    value.releaseMatrix.kind !== 'jigwright-release-compatibility-matrix.v1' ||
    !['local-candidate', 'release-candidate', 'stable'].includes(
      value.releaseMatrix.releaseChannel as string,
    ) ||
    !isSha256Digest(value.releaseMatrix.digest)
  ) {
    throw new Error('Jigwright release evidence subject is invalid.');
  }
  return Object.freeze({
    kind: 'jigwright-v1-release-subject.v1' as const,
    sourceCommit: value.sourceCommit,
    sourceTree: value.sourceTree,
    packageSetDigest: value.packageSetDigest,
    releaseMatrix: Object.freeze({
      schemaVersion: 1 as const,
      kind: 'jigwright-release-compatibility-matrix.v1' as const,
      releaseChannel: value.releaseMatrix
        .releaseChannel as LocalJigwrightReleaseMatrixV1['releaseChannel'],
      digest: value.releaseMatrix.digest,
    }),
  });
}

function parseReleaseEvidenceClaim(value: unknown): Readonly<{
  kind: ReleaseEvidenceClaimKind;
  result: 'complete';
  artifactDigest: Sha256Digest;
}> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['artifactDigest', 'kind', 'result']) ||
    !RELEASE_EVIDENCE_CLAIM_KINDS.includes(
      value.kind as ReleaseEvidenceClaimKind,
    ) ||
    value.result !== 'complete' ||
    !isSha256Digest(value.artifactDigest)
  ) {
    throw new Error('Jigwright release evidence claim is invalid.');
  }
  return Object.freeze({
    kind: value.kind as ReleaseEvidenceClaimKind,
    result: 'complete' as const,
    artifactDigest: value.artifactDigest,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function isGitObjectId(value: unknown): value is string {
  return (
    typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)
  );
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function runGit(repositoryRoot: string, args: string[]): string {
  const { spawnSync } = requireChildProcess();
  const result = spawnSync('git', args, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

function requireChildProcess(): typeof import('node:child_process') {
  // Kept behind a helper so importing the candidate schema has no process side
  // effect. The module is still code-owned and never reads a repo command.
  return process.getBuiltinModule('node:child_process')!;
}

function digestCanonical(value: unknown): `sha256:${string}` {
  return `sha256:${crypto
    .createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')}`;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex < 0 || process.argv[outputIndex + 1] === undefined) {
    throw new Error(
      'Usage: node --experimental-strip-types scripts/prepare-jigwright-v1-release.ts --output <directory> [--evidence-object <local-sha256-object.json>]',
    );
  }
  const evidenceIndex = process.argv.indexOf('--evidence-object');
  if (evidenceIndex >= 0 && process.argv[evidenceIndex + 1] === undefined) {
    throw new Error('--evidence-object requires a local object path.');
  }
  const dossier = prepareJigwrightV1ReleaseCandidate(
    process.cwd(),
    process.argv[outputIndex + 1]!,
    {
      ...(evidenceIndex >= 0
        ? { releaseEvidenceObjectPath: process.argv[evidenceIndex + 1]! }
        : {}),
    },
  );
  process.stdout.write(`${JSON.stringify(dossier)}\n`);
}
