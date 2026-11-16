/** Coordinates authority attestation admission and relay selection through required operations. */
import crypto from 'node:crypto';
import {
  assertAuthorityAttestationPayload,
  AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE,
  authorityAttestationTagRef,
  canonicalAttestationEnvelope,
  canonicalAttestationPayload,
  validateAttestedTransitionPair,
  type AttestationGrantBaseMapping,
  type AttestedCommitFacts,
  type AuthorityAttestationEnvelope,
  type AuthorityAttestationPayload,
} from '../../modules/authority/authority-attestation.ts';
import {
  authorityApplicationReceiptTagPrefix,
  type AuthorityApplicationReceiptOperations,
} from '../../modules/authority/authority-application-receipt.ts';
import {
  canonicalMaintainerGrantV2Payload,
  maintainerGrantV2SignatureNamespace,
  type MaintainerGrantV2Envelope,
} from '../../modules/authority/maintainer-grant-v2-codec.ts';
import type { MaintainerPolicy } from '../../modules/authority/maintainer-policy.ts';
import type {
  MaintainerSignerProvider,
  MaintainerSignerFactory,
} from '../../modules/authority/maintainer-signer-port.ts';
import type {
  HumanResolutionAuditTagReader,
  HumanResolutionServices,
} from '../../modules/investigation/domain/human-resolution-grant-contract.ts';

import type { GitState } from '../../modules/repository-consumer/repository-git-state.ts';
import type { WorkflowConfig } from '../../modules/repository-consumer/workflow-config.ts';
import {
  COMMIT_OID,
  invalidRequest,
  grantMissing,
  grantInvalid,
} from '../../modules/authority/authority-attestation-admission.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { parseManagedTrailers } from '@jigwright/core/managed-transition-trailers';

export type AuthorityAttestationRequest = {
  originalCommit: string;
  mainCommit: string;
  grantBasePairs: Array<{ originalBase: string; mainBase: string }>;
};

export type AuthorityAttestationIssueOptions = {
  now?: Date;
  signer?: MaintainerSignerProvider;
};

export type AuthorityAttestationIssueResult = {
  grantId: string;
  tagRef: string;
  publishCommand: string;
  envelope: AuthorityAttestationEnvelope;
};

export type AuthorityAttestationRelayProjection = {
  grantId: string;
  originalCommit: string;
  mainCommit: string;
  grantBasePairs: Array<{ originalBase: string; mainBase: string }>;
  attestCommand: string;
  tagRef: string;
  publishCommand: string;
};

export type AuthorityAttestationServices = {
  discoverRepository: (cwd: string) => GitState;
  loadHeadPolicy: (repositoryRoot: string) => MaintainerPolicy;
  readRepositoryOrigin: (repositoryRoot: string) => string;
  loadWorkflowConfig: (repositoryRoot: string) => WorkflowConfig;
  requireProtectedBaseRef: (
    repositoryRoot: string,
    protectedBranch: string,
  ) => string;
  readAttestationCandidateLog: (
    repositoryRoot: string,
    kind: 'authority' | 'authority-candidate',
    protectedRef: string,
  ) => string;
  attestedFacts: (
    repositoryRoot: string,
    commitOid: string,
  ) => AttestedCommitFacts;
  assertOriginalCommitSignature: (
    repositoryRoot: string,
    policy: MaintainerPolicy,
    commitOid: string,
  ) => void;
  assertMainContained: (
    repositoryRoot: string,
    protectedRef: string,
    commitOid: string,
  ) => void;
  readGrantEnvelope: (
    repositoryRoot: string,
    policy: MaintainerPolicy,
    grantId: string,
  ) => MaintainerGrantV2Envelope;
  readPolicyContent: (repositoryRoot: string, baseCommit: string) => string;
  readPolicyBlob: (repositoryRoot: string, baseCommit: string) => string;
  readAuditTagRefs: (repositoryRoot: string, prefix: string) => string[];
  readAttestationRef: (repositoryRoot: string, tagRef: string) => string;
  createAttestationTag: (
    repositoryRoot: string,
    targetCommit: string,
    tagRef: string,
    message: string,
    signerIdentity: string,
  ) => void;
  readHumanResolutionAuditTag: HumanResolutionAuditTagReader;
  verifyHumanResolutionGrantEnvelope: HumanResolutionServices['verifyHumanResolutionGrantEnvelope'];
  createInteractiveSshSigner: MaintainerSignerFactory;
  authorityAttestCommand: (binding: AuthorityAttestationRequest) => string;
  authorityTagPublishCommand: (
    repositoryOrigin: string,
    tagRef: string,
  ) => string;
  currentTime: () => Date;
};

type AttestedTransitionIdentity = {
  kind: 'authority' | 'authority-candidate';
  changeId: string;
  grantId: string;
};

export function createAuthorityAttestationOperations({
  discoverRepository,
  loadHeadPolicy,
  readRepositoryOrigin,
  loadWorkflowConfig,
  requireProtectedBaseRef,
  readAttestationCandidateLog,
  attestedFacts,
  assertOriginalCommitSignature,
  assertMainContained,
  readGrantEnvelope,
  readPolicyContent,
  readPolicyBlob,
  readAuditTagRefs,
  readAttestationRef,
  createAttestationTag,
  readHumanResolutionAuditTag,
  verifyHumanResolutionGrantEnvelope,
  createInteractiveSshSigner,
  authorityAttestCommand,
  authorityTagPublishCommand,
  currentTime,
}: AuthorityAttestationServices) {
  function projectAuthorityAttestationRelay(
    authorityApplicationReceipts: AuthorityApplicationReceiptOperations,
    cwd: string,
    requestedOriginalCommit: string,
  ): AuthorityAttestationRelayProjection {
    const repository = discoverRepository(cwd);
    const repositoryRoot = repository.repositoryRoot;
    const policy = loadHeadPolicy(repositoryRoot);
    const origin = readRepositoryOrigin(repositoryRoot);
    if (origin !== policy.repository.origin) {
      throw workflowError(
        'MAINTAINER_REPOSITORY_MISMATCH',
        'The repository origin does not match the trusted maintainer policy.',
        ExitCode.guard,
      );
    }
    const original = attestedFacts(repositoryRoot, requestedOriginalCommit);
    assertOriginalCommitSignature(repositoryRoot, policy, original.oid);
    const originalTrailers = parseAttestableTrailers(original.message);
    const originalIdentity = attestedTransitionIdentity(
      authorityApplicationReceipts,
      repositoryRoot,
      policy,
      original,
      originalTrailers,
    );

    const config = loadWorkflowConfig(repositoryRoot);
    const protectedBranch = config.protectedBranches[0];
    if (!protectedBranch) {
      throw invalidRequest('No protected branch is configured.');
    }
    const protectedRef = requireProtectedBaseRef(
      repositoryRoot,
      protectedBranch,
    );
    const candidateOids = readAttestationCandidateLog(
      repositoryRoot,
      originalIdentity.kind,
      protectedRef,
    )
      .split('\n')
      .filter((oid) => oid.length > 0 && oid !== original.oid);
    const matches: AttestedCommitFacts[] = [];
    for (const candidateOid of candidateOids) {
      const candidate = attestedFacts(repositoryRoot, candidateOid);
      try {
        const candidateTrailers = validateAttestedTransitionPair(
          original,
          candidate,
        );
        if (
          candidateTrailers.kind === originalIdentity.kind &&
          candidateTrailers.changeId === originalIdentity.changeId &&
          (candidateTrailers.kind !== 'authority' ||
            candidateTrailers.grantId === originalIdentity.grantId)
        ) {
          matches.push(candidate);
        }
      } catch {
        // A grep hit is only a candidate. Exact transition validation is the
        // authority for whether it is the rewritten protected-main commit.
      }
    }
    if (matches.length === 0) {
      throw workflowError(
        'AUTHORITY_ATTESTATION_RELAY_NOT_READY',
        'The protected branch does not contain the exact rewritten authority commit.',
        ExitCode.conflict,
      );
    }
    if (matches.length !== 1) {
      throw workflowError(
        'AUTHORITY_ATTESTATION_RELAY_AMBIGUOUS',
        'More than one protected-main commit matches the original authority transition.',
        ExitCode.guard,
      );
    }
    const main = matches[0];
    const originalBase = original.parentOids[0];
    const mainBase = main.parentOids[0];
    if (!originalBase || !mainBase) {
      throw invalidRelayOriginal();
    }
    const grantBasePairs =
      originalBase === mainBase ? [] : [{ originalBase, mainBase }];
    const tagRef = authorityAttestationTagRef(originalIdentity.grantId);
    const commandBinding = {
      originalCommit: original.oid,
      mainCommit: main.oid,
      grantBasePairs,
    };
    return {
      grantId: originalIdentity.grantId,
      ...commandBinding,
      attestCommand: authorityAttestCommand(commandBinding),
      tagRef,
      publishCommand: authorityTagPublishCommand(
        policy.repository.origin,
        tagRef,
      ),
    };
  }

  function issueAuthorityAttestation(
    authorityApplicationReceipts: AuthorityApplicationReceiptOperations,
    cwd: string,
    request: AuthorityAttestationRequest,
    options: AuthorityAttestationIssueOptions = {},
  ): AuthorityAttestationIssueResult {
    const repository = discoverRepository(cwd);
    if (repository.statusEntries.length > 0) {
      throw workflowError(
        'AUTHORITY_ATTESTATION_DIRTY_WORKTREE',
        'Authority attestations can be issued only from a clean worktree.',
        ExitCode.conflict,
      );
    }
    const repositoryRoot = repository.repositoryRoot;
    const policy = loadHeadPolicy(repositoryRoot);
    const origin = readRepositoryOrigin(repositoryRoot);
    if (origin !== policy.repository.origin) {
      throw workflowError(
        'MAINTAINER_REPOSITORY_MISMATCH',
        'The repository origin does not match the trusted maintainer policy.',
        ExitCode.guard,
      );
    }
    assertRequestShape(request);

    const config = loadWorkflowConfig(repositoryRoot);
    const protectedBranch = config.protectedBranches[0];
    if (!protectedBranch) {
      throw invalidRequest('No protected branch is configured.');
    }
    const protectedRef = requireProtectedBaseRef(
      repositoryRoot,
      protectedBranch,
    );

    const original = attestedFacts(repositoryRoot, request.originalCommit);
    const main = attestedFacts(repositoryRoot, request.mainCommit);
    const transitionTrailers = validateAttestedTransitionPair(original, main);
    const identity = attestedTransitionIdentity(
      authorityApplicationReceipts,
      repositoryRoot,
      policy,
      original,
      transitionTrailers,
    );
    assertMainContained(repositoryRoot, protectedRef, main.oid);
    assertOriginalCommitSignature(repositoryRoot, policy, original.oid);

    const now = options.now ? new Date(options.now) : currentTime();
    if (!Number.isFinite(now.getTime())) {
      throw invalidRequest('Authority attestation issue time is invalid.');
    }
    const signer =
      options.signer ?? createInteractiveSshSigner(repositoryRoot, policy);
    signer.assertHumanPresent();

    const primaryEnvelope = readGrantEnvelope(
      repositoryRoot,
      policy,
      identity.grantId,
    );
    if (
      primaryEnvelope.payload.changeId !== identity.changeId ||
      primaryEnvelope.payload.baseCommit !== original.parentOids[0]
    ) {
      throw grantInvalid(identity.grantId);
    }
    validateBoundGrant(repositoryRoot, policy, primaryEnvelope, signer);

    const grantBases = request.grantBasePairs
      .map((pair) =>
        resolveGrantBaseMapping(repositoryRoot, policy, pair, now, signer, {
          protectedRef,
        }),
      )
      .sort((left, right) => (left.originalBase < right.originalBase ? -1 : 1));

    const payload: AuthorityAttestationPayload = {
      version: 1,
      grantId: identity.grantId,
      repositoryId: policy.repository.id,
      repositoryOrigin: policy.repository.origin,
      protectedBranch,
      originalCommit: original.oid,
      mainCommit: main.oid,
      grantBases,
      policyBlob: readPolicyBlob(repositoryRoot, 'HEAD'),
      issuedAt: now.toISOString(),
      signer: signer.identity(),
    };
    assertAuthorityAttestationPayload(payload);

    const tagRef = authorityAttestationTagRef(payload.grantId);
    if (readAttestationRef(repositoryRoot, tagRef)) {
      throw workflowError(
        'AUTHORITY_ATTESTATION_EXISTS',
        `Authority attestation ${payload.grantId} already has a local tag.`,
        ExitCode.conflict,
      );
    }

    const canonicalPayload = canonicalAttestationPayload(payload);
    const signature = signer.sign(
      canonicalPayload,
      AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE,
    );
    signer.verify(
      canonicalPayload,
      signature,
      payload.signer,
      AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE,
    );
    const envelope: AuthorityAttestationEnvelope = {
      payload,
      signatureNamespace: AUTHORITY_ATTESTATION_SIGNATURE_NAMESPACE,
      signature,
    };
    const canonicalEnvelope = canonicalAttestationEnvelope(envelope);

    createAttestationTag(
      repositoryRoot,
      original.oid,
      tagRef,
      canonicalEnvelope,
      payload.signer,
    );

    return {
      grantId: payload.grantId,
      tagRef,
      publishCommand: authorityTagPublishCommand(
        policy.repository.origin,
        tagRef,
      ),
      envelope,
    };
  }

  function resolveGrantBaseMapping(
    repositoryRoot: string,
    policy: MaintainerPolicy,
    pair: { originalBase: string; mainBase: string },
    now: Date,
    signer: MaintainerSignerProvider,
    options: { protectedRef: string },
  ): AttestationGrantBaseMapping {
    const original = attestedFacts(repositoryRoot, pair.originalBase);
    const main = attestedFacts(repositoryRoot, pair.mainBase);
    validateAttestedTransitionPair(original, main);
    assertMainContained(repositoryRoot, options.protectedRef, main.oid);

    const grantIds = listGrantTagIds(repositoryRoot, policy)
      .filter((grantId) => {
        const envelope = readGrantEnvelope(repositoryRoot, policy, grantId);
        return envelope.payload.baseCommit === original.oid;
      })
      .sort();
    if (grantIds.length === 0) {
      throw grantMissing(pair.originalBase);
    }
    for (const grantId of grantIds) {
      validateBoundGrant(
        repositoryRoot,
        policy,
        readGrantEnvelope(repositoryRoot, policy, grantId),
        signer,
      );
    }
    return {
      originalBase: original.oid,
      mainBase: main.oid,
      grantIds,
    };
  }

  function parseAttestableTrailers(
    message: string,
  ): Exclude<ReturnType<typeof parseManagedTrailers>, undefined> {
    let trailers: ReturnType<typeof parseManagedTrailers>;
    try {
      trailers = parseManagedTrailers(message);
    } catch {
      throw invalidRelayOriginal();
    }
    if (
      trailers?.kind !== 'authority' &&
      trailers?.kind !== 'authority-candidate'
    ) {
      throw invalidRelayOriginal();
    }
    return trailers;
  }

  function attestedTransitionIdentity(
    authorityApplicationReceipts: AuthorityApplicationReceiptOperations,
    repositoryRoot: string,
    policy: MaintainerPolicy,
    original: AttestedCommitFacts,
    trailers: Exclude<ReturnType<typeof parseManagedTrailers>, undefined>,
  ): AttestedTransitionIdentity {
    if (trailers.kind === 'authority') {
      return {
        kind: trailers.kind,
        changeId: trailers.changeId,
        grantId: trailers.grantId,
      };
    }
    if (trailers.kind !== 'authority-candidate') {
      throw invalidRelayOriginal();
    }
    const matches = authorityApplicationReceipts
      .listAuthorityApplicationReceiptTagRefs(repositoryRoot, policy)
      .map((ref) =>
        authorityApplicationReceipts.readAuthorityApplicationReceiptTag(
          repositoryRoot,
          ref,
        ),
      )
      .filter(
        ({ target, envelope }) =>
          target === original.oid &&
          envelope.payload.candidateCommit === original.oid &&
          envelope.payload.changeId === trailers.changeId,
      );
    if (matches.length !== 1) {
      throw workflowError(
        'AUTHORITY_ATTESTATION_APPLICATION_RECEIPT_INVALID',
        'A rewritten authority candidate requires one exact portable application receipt.',
        ExitCode.guard,
      );
    }
    authorityApplicationReceipts.verifyAuthorityApplicationReceiptSignature(
      matches[0].envelope,
      policy,
    );
    return {
      kind: trailers.kind,
      changeId: trailers.changeId,
      grantId: matches[0].envelope.payload.grantId,
    };
  }

  function validateBoundGrant(
    repositoryRoot: string,
    policy: MaintainerPolicy,
    envelope: MaintainerGrantV2Envelope,
    signer: MaintainerSignerProvider,
  ): void {
    const baseCommit = envelope.payload.baseCommit;
    const policyContent = readPolicyContent(repositoryRoot, baseCommit);
    const policyBlob = readPolicyBlob(repositoryRoot, baseCommit);
    if (
      envelope.payload.baseCommit !== baseCommit ||
      envelope.payload.policyBlob !== policyBlob ||
      envelope.payload.policyDigest !==
        crypto.createHash('sha256').update(policyContent).digest('hex') ||
      envelope.payload.repositoryId !== policy.repository.id ||
      envelope.payload.repositoryOrigin !== policy.repository.origin ||
      !policy.trustedSigners.some(
        ({ identity }) => identity === envelope.payload.signer,
      )
    ) {
      throw grantInvalid(envelope.payload.grantId);
    }
    signer.verify(
      canonicalMaintainerGrantV2Payload(envelope.payload),
      envelope.signature,
      envelope.payload.signer,
      maintainerGrantV2SignatureNamespace(envelope),
    );
  }

  function listGrantTagIds(
    repositoryRoot: string,
    policy: MaintainerPolicy,
  ): string[] {
    const prefix = policy.auditTagPrefix;
    const refs = readAuditTagRefs(repositoryRoot, prefix);
    const grantIds: string[] = [];
    for (const ref of refs) {
      if (ref.startsWith(authorityApplicationReceiptTagPrefix(policy))) {
        continue;
      }
      const grantId = ref.slice(prefix.length);
      try {
        const resolution = readHumanResolutionAuditTag(
          repositoryRoot,
          policy,
          ref,
        );
        if (resolution !== null) {
          verifyHumanResolutionGrantEnvelope(
            repositoryRoot,
            resolution,
            policy,
          );
          continue;
        }
      } catch {
        throw grantInvalid(grantId);
      }
      grantIds.push(grantId);
    }
    return grantIds;
  }

  function assertRequestShape(request: AuthorityAttestationRequest): void {
    if (
      typeof request !== 'object' ||
      request === null ||
      !COMMIT_OID.test(request.originalCommit) ||
      !COMMIT_OID.test(request.mainCommit) ||
      !Array.isArray(request.grantBasePairs) ||
      request.grantBasePairs.some(
        (pair) =>
          typeof pair !== 'object' ||
          pair === null ||
          !COMMIT_OID.test(pair.originalBase) ||
          !COMMIT_OID.test(pair.mainBase),
      )
    ) {
      throw invalidRequest(
        'Authority attestation requests need full commit object IDs.',
      );
    }
  }

  function invalidRelayOriginal() {
    return workflowError(
      'AUTHORITY_ATTESTATION_RELAY_ORIGINAL_INVALID',
      'The attestation relay requires one signed canonical authority-maintenance commit.',
      ExitCode.guard,
    );
  }
  return { projectAuthorityAttestationRelay, issueAuthorityAttestation };
}

export type AuthorityAttestationOperations = ReturnType<
  typeof createAuthorityAttestationOperations
>;
