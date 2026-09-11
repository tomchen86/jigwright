/** Assembles attestation operations from repository, clock, SSH and command adapters. */
import { createAuthorityAttestationOperations } from '../application/control-plane/maintainer-attestation.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { loadWorkflowConfig } from '../runtime/repository-observation/workflow-configuration.ts';
import {
  loadHeadPolicy,
  readGrantEnvelope,
  attestedFacts,
  assertMainContained,
  assertOriginalCommitSignature,
  readRepositoryOrigin,
  requireProtectedBaseRef,
  readAttestationCandidateLog,
  readPolicyContent,
  readPolicyBlob,
  readAuditTagRefs,
  readAttestationRef,
} from '../runtime/repository-observation/maintainer-attestation.ts';
import { createAttestationTag } from '../runtime/repository-transaction/maintainer-attestation-tag.ts';
import { readHumanResolutionAuditTag } from '../runtime/repository-observation/human-resolution-grants.ts';
import { verifyHumanResolutionGrantEnvelope } from './human-revocation-production.ts';
import { createInteractiveSshSigner } from '../adapters/signing/ssh/maintainer-signer.ts';
import {
  authorityAttestCommand,
  authorityTagPublishCommand,
} from '../adapters/remote/github/authority-relay-command.ts';
export const authorityAttestationOperations =
  createAuthorityAttestationOperations({
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
    currentTime: () => new Date(),
  });

export const { projectAuthorityAttestationRelay, issueAuthorityAttestation } =
  authorityAttestationOperations;
