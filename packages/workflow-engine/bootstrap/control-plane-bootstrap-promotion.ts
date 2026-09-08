/** Frozen promotion candidates, maintainer policy, and SSH signature verification. */
import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from './canonical-json.ts';
import {
  isRecord,
  isDigest,
  supervisorNotTerminal,
  isNonEmptyTrimmed,
  CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
  CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
  hasExactKeys,
  isCanonicalIso,
  canonicalDigest,
  sortedUniqueStrings,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  PROCESS_TIMEOUT_MS,
  PROCESS_MAX_BUFFER_BYTES,
} from './control-plane-bootstrap-values.ts';
import type {
  BootstrapPaths,
  InitialSupervisorProvenance,
  Sha256Digest,
  BootstrapTrustedSigner,
} from './control-plane-bootstrap-types.ts';
import {
  bootstrapInterventionStateRoot,
  assertPrivateDirectory,
  readCanonicalPrivateRecord,
} from './control-plane-bootstrap-files.ts';
import {
  readBootstrapRemoteBaseOid,
  bootstrapCommitIsAncestor,
  exactBootstrapGitOutput,
} from './control-plane-bootstrap-provenance.ts';
import { verifiedProtectedCapabilityManifest } from './control-plane-bootstrap-protected.ts';
import {
  assertedPromotionLineageV3,
  assertedGrantPayloadV3,
  validExactChangesV2,
} from './control-plane-bootstrap-promotion-records.ts';

export function assertV3PromotionHumanSignatures(
  paths: BootstrapPaths,
  initialProvenance: InitialSupervisorProvenance,
  material: Record<string, unknown>,
  lineage: ReturnType<typeof assertedPromotionLineageV3>,
  reviewEnvelope: Record<string, unknown>,
  grantPayload: ReturnType<typeof assertedGrantPayloadV3>,
  grantSignature: string,
  beforeManifest: Record<string, unknown>,
): Record<string, unknown> & {
  expectedOldCommit: string;
  candidateCommit: string;
} {
  if (
    !isRecord(reviewEnvelope.payload) ||
    typeof reviewEnvelope.signature !== 'string' ||
    !isRecord(material.mandateBinding) ||
    !isDigest(material.frozenCandidateBundleDigest)
  ) {
    throw supervisorNotTerminal();
  }
  const candidate = readFrozenControlPlaneCandidate(
    paths,
    initialProvenance,
    material,
    beforeManifest,
  );
  if (
    candidate.expectedOldCommit !== lineage.previousActiveTrustCommit ||
    candidate.candidateCommit !== lineage.candidateTrustCommit
  ) {
    throw supervisorNotTerminal();
  }
  const policy = readBootstrapMaintainerPolicyAt(
    initialProvenance.packageRoot,
    candidate.expectedOldCommit,
    grantPayload.repositoryId,
  );
  const reviewPayload = reviewEnvelope.payload;
  if (
    !isNonEmptyTrimmed(reviewPayload.reviewer) ||
    reviewPayload.reviewer === grantPayload.humanSigner
  ) {
    throw supervisorNotTerminal();
  }
  const reviewer = policy.trustedSigners.find(
    (signer) => signer.identity === reviewPayload.reviewer,
  );
  const grantSigner = policy.trustedSigners.find(
    (signer) => signer.identity === grantPayload.humanSigner,
  );
  if (reviewer === undefined || grantSigner === undefined) {
    throw supervisorNotTerminal();
  }
  verifyBootstrapSshSignature(
    `${canonicalJson(reviewPayload)}\n`,
    reviewEnvelope.signature,
    reviewer,
    CONTROL_PLANE_REVIEW_SIGNATURE_NAMESPACE_V3,
  );
  verifyBootstrapSshSignature(
    `${canonicalJson(grantPayload)}\n`,
    grantSignature,
    grantSigner,
    CONTROL_PLANE_SIGNATURE_NAMESPACE_V3,
  );
  const worktreeRoot = path.dirname(
    path.dirname(initialProvenance.packageRoot),
  );
  const remoteTip = readBootstrapRemoteBaseOid(
    worktreeRoot,
    initialProvenance.remoteBaseRef,
  );
  if (
    !bootstrapCommitIsAncestor(
      worktreeRoot,
      candidate.expectedOldCommit,
      remoteTip,
    )
  ) {
    throw supervisorNotTerminal();
  }
  return candidate;
}

function readFrozenControlPlaneCandidate(
  paths: BootstrapPaths,
  initialProvenance: InitialSupervisorProvenance,
  material: Record<string, unknown>,
  beforeManifest: Record<string, unknown>,
): Record<string, unknown> & {
  expectedOldCommit: string;
  candidateCommit: string;
} {
  const frozenDigest = material.frozenCandidateBundleDigest;
  if (
    !isDigest(frozenDigest) ||
    !isRecord(material.mandateBinding) ||
    !isNonEmptyTrimmed(material.repositoryId)
  ) {
    throw supervisorNotTerminal();
  }
  const worktreeRoot = path.dirname(
    path.dirname(initialProvenance.packageRoot),
  );
  const gitCommonDirectory = fs.realpathSync(
    exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--path-format=absolute',
      '--git-common-dir',
    ]),
  );
  if (bootstrapInterventionStateRoot(gitCommonDirectory) !== paths.root) {
    throw supervisorNotTerminal();
  }
  const candidateDirectory = path.join(
    gitCommonDirectory,
    'workflow-engine',
    'candidates',
  );
  assertPrivateDirectory(candidateDirectory, 'CONTROL_PLANE_STATE_UNSAFE');
  const candidate = readCanonicalPrivateRecord(
    path.join(
      candidateDirectory,
      `${frozenDigest.slice('sha256:'.length)}.json`,
    ),
    supervisorNotTerminal,
  );
  if (
    !isRecord(candidate) ||
    !hasExactKeys(candidate, [
      'candidateBundleDigest',
      'candidateCommit',
      'checksAttestation',
      'checksAttestationDigest',
      'classification',
      'commitMessage',
      'createdAt',
      'effectsManifestDigest',
      'expectedOldCommit',
      'expectedRefGeneration',
      'humanReadableSummaryDigest',
      'mandateBinding',
      'manifest',
      'manifestDigest',
      'providerInvocationsDigest',
      'recoveryPlanDigest',
      'repositoryId',
      'resultTree',
      'schemaVersion',
      'targetRef',
    ]) ||
    candidate.schemaVersion !== 2 ||
    candidate.classification !== 'control-plane' ||
    candidate.repositoryId !== material.repositoryId ||
    candidate.candidateBundleDigest !== frozenDigest.slice('sha256:'.length) ||
    !/^[0-9a-f]{64}$/.test(String(candidate.candidateBundleDigest)) ||
    !/^[0-9a-f]{64}$/.test(String(candidate.humanReadableSummaryDigest)) ||
    !/^[0-9a-f]{40,64}$/.test(String(candidate.expectedOldCommit)) ||
    !/^[0-9a-f]{40,64}$/.test(String(candidate.candidateCommit)) ||
    !/^[0-9a-f]{40,64}$/.test(String(candidate.resultTree)) ||
    !Number.isSafeInteger(candidate.expectedRefGeneration) ||
    Number(candidate.expectedRefGeneration) < 0 ||
    !isNonEmptyTrimmed(candidate.targetRef) ||
    candidate.targetRef !== initialProvenance.branchRef ||
    !isCanonicalIso(candidate.createdAt) ||
    !validFrozenTaskMandateBinding(
      candidate.mandateBinding,
      material.mandateBinding,
    )
  ) {
    throw supervisorNotTerminal();
  }
  const { candidateBundleDigest: _candidateBundleDigest, ...candidateBody } =
    candidate;
  if (canonicalDigest(candidateBody) !== frozenDigest) {
    throw supervisorNotTerminal();
  }

  const expectedOldCommit = String(candidate.expectedOldCommit);
  const candidateCommit = String(candidate.candidateCommit);
  if (
    exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--verify',
      `${expectedOldCommit}^{commit}`,
    ]) !== expectedOldCommit ||
    exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--verify',
      `${candidateCommit}^{commit}`,
    ]) !== candidateCommit ||
    exactBootstrapGitOutput(worktreeRoot, [
      'rev-parse',
      '--verify',
      `${candidateCommit}^{tree}`,
    ]) !== candidate.resultTree ||
    !bootstrapCommitIsAncestor(
      worktreeRoot,
      initialProvenance.headOid,
      expectedOldCommit,
    )
  ) {
    throw supervisorNotTerminal();
  }
  const parents = exactBootstrapGitOutput(worktreeRoot, [
    'rev-list',
    '--parents',
    '-n',
    '1',
    candidateCommit,
  ]).split(' ');
  if (
    parents.length !== 2 ||
    parents[0] !== candidateCommit ||
    parents[1] !== expectedOldCommit ||
    !isRecord(material.candidateArtifact) ||
    material.candidateArtifact.sourceDigest !==
      frozenCandidateSourceDigestV2(expectedOldCommit, material.exactChanges)
  ) {
    throw supervisorNotTerminal();
  }

  const trustedManifest = verifiedProtectedCapabilityManifest(
    worktreeRoot,
    expectedOldCommit,
    false,
  );
  const { manifestDigest, ...beforeManifestPayload } = beforeManifest;
  if (
    trustedManifest.manifestDigest !== manifestDigest ||
    canonicalJson(trustedManifest.payload) !==
      canonicalJson(beforeManifestPayload)
  ) {
    throw supervisorNotTerminal();
  }
  return candidate as Record<string, unknown> & {
    expectedOldCommit: string;
    candidateCommit: string;
  };
}

function frozenCandidateSourceDigestV2(
  expectedOldCommit: string,
  changes: unknown,
): Sha256Digest {
  if (!validExactChangesV2(changes)) throw supervisorNotTerminal();
  const entries = changes.map((change) =>
    change.afterDigest === null
      ? { path: change.path, kind: 'deleted' as const }
      : {
          path: change.path,
          kind: 'file' as const,
          mode: change.afterMode,
          contentDigest: change.afterDigest,
        },
  );
  return canonicalDigest({
    kind: 'intervention-engine-source-snapshot.v1',
    head: expectedOldCommit,
    entries,
  });
}

function validFrozenTaskMandateBinding(
  frozen: unknown,
  material: Record<string, unknown>,
): boolean {
  return (
    isRecord(frozen) &&
    hasExactKeys(frozen, [
      'changeId',
      'externalAuditRoot',
      'mandateDigest',
      'mandateId',
      'mandateTaskId',
      'schemaVersion',
    ]) &&
    frozen.schemaVersion === 1 &&
    frozen.mandateTaskId === material.parentTaskId &&
    frozen.mandateId === material.mandateId &&
    frozen.mandateDigest === material.mandateDigest &&
    frozen.changeId === material.changeId &&
    frozen.externalAuditRoot === material.externalAuditRoot
  );
}

function readBootstrapMaintainerPolicyAt(
  packageRoot: string,
  revision: string,
  repositoryId: string,
): { trustedSigners: BootstrapTrustedSigner[] } {
  const worktreeRoot = path.dirname(path.dirname(packageRoot));
  const raw = exactBootstrapGitOutput(worktreeRoot, [
    'show',
    `${revision}:workflow/maintainer-policy.json`,
  ]);
  let policy: unknown;
  try {
    policy = JSON.parse(raw);
  } catch {
    throw supervisorNotTerminal();
  }
  if (
    !isRecord(policy) ||
    !hasExactKeys(policy, [
      'auditTagPrefix',
      'bootstrapEligiblePaths',
      'maxTtlMinutes',
      'maxUses',
      'phase',
      'repository',
      'requiredChecks',
      'schemaVersion',
      'sealedImmutablePaths',
      'signatureNamespace',
      'trustedSigners',
    ]) ||
    policy.schemaVersion !== 1 ||
    !isRecord(policy.repository) ||
    !hasExactKeys(policy.repository, ['id', 'origin']) ||
    policy.repository.id !== repositoryId ||
    typeof policy.repository.origin !== 'string' ||
    !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(
      policy.repository.origin,
    ) ||
    (policy.phase !== 'bootstrap' && policy.phase !== 'sealed') ||
    typeof policy.auditTagPrefix !== 'string' ||
    !/^refs\/tags\/[a-z0-9][a-z0-9-]*\/$/.test(policy.auditTagPrefix) ||
    policy.signatureNamespace !== 'workflow.maintainer-grant.v1' ||
    policy.maxTtlMinutes !== 30 ||
    policy.maxUses !== 1 ||
    !sortedUniqueStrings(policy.bootstrapEligiblePaths, true) ||
    !sortedUniqueStrings(policy.sealedImmutablePaths, true) ||
    !sortedUniqueStrings(policy.requiredChecks, false) ||
    policy.requiredChecks.some(
      (checkId) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(checkId),
    ) ||
    !Array.isArray(policy.trustedSigners) ||
    policy.trustedSigners.length === 0
  ) {
    throw supervisorNotTerminal();
  }
  const trustedSigners: BootstrapTrustedSigner[] = [];
  for (const signer of policy.trustedSigners) {
    if (
      !isRecord(signer) ||
      !hasExactKeys(signer, ['fingerprint', 'identity', 'publicKey']) ||
      typeof signer.identity !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$/.test(signer.identity) ||
      typeof signer.publicKey !== 'string' ||
      !/^ssh-(?:ed25519|ed25519-sk|rsa|ecdsa-[^ ]+) [A-Za-z0-9+/]+={0,2}$/.test(
        signer.publicKey,
      ) ||
      typeof signer.fingerprint !== 'string' ||
      !/^SHA256:[A-Za-z0-9+/]{20,}$/.test(signer.fingerprint)
    ) {
      throw supervisorNotTerminal();
    }
    trustedSigners.push({
      identity: signer.identity,
      publicKey: signer.publicKey,
      fingerprint: signer.fingerprint,
    });
  }
  if (
    !sortedUniqueStrings(
      trustedSigners.map(({ identity }) => identity),
      false,
    ) ||
    new Set(trustedSigners.map(({ publicKey }) => publicKey)).size !==
      trustedSigners.length ||
    new Set(trustedSigners.map(({ fingerprint }) => fingerprint)).size !==
      trustedSigners.length ||
    exactBootstrapGitOutput(worktreeRoot, [
      'config',
      '--local',
      '--get',
      'remote.origin.url',
    ]) !== policy.repository.origin
  ) {
    throw supervisorNotTerminal();
  }
  return { trustedSigners };
}

function verifyBootstrapSshSignature(
  payload: string,
  signature: string,
  signer: BootstrapTrustedSigner,
  namespace: string,
): void {
  const executable = bootstrapSshKeygenExecutable();
  const temporaryDirectory = fs.mkdtempSync(
    path.join(fs.realpathSync('/tmp'), 'workflow-bootstrap-verify-'),
  );
  fs.chmodSync(temporaryDirectory, PRIVATE_DIRECTORY_MODE);
  const allowedSignersPath = path.join(temporaryDirectory, 'allowed-signers');
  const signaturePath = path.join(temporaryDirectory, 'signature');
  try {
    fs.writeFileSync(
      allowedSignersPath,
      `${signer.identity} ${signer.publicKey}\n`,
      { mode: PRIVATE_FILE_MODE },
    );
    fs.writeFileSync(signaturePath, signature, {
      mode: PRIVATE_FILE_MODE,
    });
    const result = childProcess.spawnSync(
      executable,
      [
        '-Y',
        'verify',
        '-f',
        allowedSignersPath,
        '-I',
        signer.identity,
        '-n',
        namespace,
        '-s',
        signaturePath,
      ],
      {
        encoding: 'utf8',
        input: payload,
        shell: false,
        env: {
          PATH: `${path.dirname(executable)}:/usr/bin:/bin`,
          LANG: 'C',
          LC_ALL: 'C',
          TMPDIR: temporaryDirectory,
        },
        timeout: PROCESS_TIMEOUT_MS,
        maxBuffer: PROCESS_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
    );
    if (
      result.error !== undefined ||
      result.signal !== null ||
      result.status !== 0
    ) {
      throw supervisorNotTerminal();
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function bootstrapSshKeygenExecutable(): string {
  if (process.platform === 'win32') throw supervisorNotTerminal();
  for (const candidate of ['/usr/bin/ssh-keygen', '/bin/ssh-keygen']) {
    const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stats?.isFile() && !stats.isSymbolicLink()) {
      return fs.realpathSync(candidate);
    }
  }
  throw supervisorNotTerminal();
}
