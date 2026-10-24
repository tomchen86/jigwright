import crypto from 'node:crypto';
import {
  AUTHORITY_ATTESTATION_TAG_PREFIX,
  canonicalAttestationEnvelope,
  parseAuthorityAttestationEnvelope,
  type AuthorityAttestationEnvelope,
} from '../authority/authority-attestation.ts';
import type { VerifiedRoleContextSharingTerminalReceiptV1 } from '../authority/role-context-sharing-grant-lifecycle-port.ts';
import type { MaintainerGrantV2Envelope } from '../authority/maintainer-grant-v2-codec.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
  type TrustedMaintainerSigner,
} from '../authority/maintainer-policy.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
export type AttestedAuthority = {
  grantId: string;
  changeId: string;
  originalCommit: string;
  mainCommit: string;
};

export type DirectAuthority = {
  grantId: string;
  changeId: string;
  commit: string;
};

export type CiAttestationResult = {
  attestedAuthorities: AttestedAuthority[];
  directAuthorities: DirectAuthority[];
  roleContextSharingTerminalReceipts: VerifiedRoleContextSharingTerminalReceiptV1[];
};

export type GrantTagRecord = {
  grantId: string;
  target: string;
  envelope: MaintainerGrantV2Envelope;
};
export function parseAttestationTag(
  grantId: string,
  raw: string,
): AuthorityAttestationEnvelope {
  const tagRef = `${AUTHORITY_ATTESTATION_TAG_PREFIX}${grantId}`;
  const separator = raw.indexOf('\n\n');
  if (separator === -1) {
    throw invalidAttestationTag(grantId);
  }
  const headers = raw.slice(0, separator).split('\n');
  const objectHeaders = headers.filter((line) => line.startsWith('object '));
  const typeHeaders = headers.filter((line) => line.startsWith('type '));
  const tagHeaders = headers.filter((line) => line.startsWith('tag '));
  const envelope = (() => {
    try {
      return parseAuthorityAttestationEnvelope(raw.slice(separator + 2));
    } catch {
      throw invalidAttestationTag(grantId);
    }
  })();
  if (
    objectHeaders.length !== 1 ||
    objectHeaders[0] !== `object ${envelope.payload.originalCommit}` ||
    typeHeaders.length !== 1 ||
    typeHeaders[0] !== 'type commit' ||
    tagHeaders.length !== 1 ||
    tagHeaders[0] !== `tag ${tagRef.slice('refs/tags/'.length)}` ||
    canonicalAttestationEnvelope(envelope) !== raw.slice(separator + 2)
  ) {
    throw invalidAttestationTag(grantId);
  }
  return envelope;
}
export function parseBasePolicy(content: string | undefined): MaintainerPolicy {
  if (content === undefined) {
    throw attestationError(
      'CI_ATTESTATION_POLICY_MISSING',
      'Protected history contains authority transitions without a base maintainer policy.',
    );
  }
  try {
    return parseMaintainerPolicy(JSON.parse(content));
  } catch {
    throw attestationError(
      'CI_ATTESTATION_POLICY_MISSING',
      'The base maintainer policy is invalid.',
    );
  }
}
export function parseProtectedBranches(content: string | undefined): string[] {
  if (content !== undefined) {
    try {
      const parsed = JSON.parse(content) as { protectedBranches?: unknown };
      if (
        Array.isArray(parsed.protectedBranches) &&
        parsed.protectedBranches.every((value) => typeof value === 'string')
      ) {
        return parsed.protectedBranches;
      }
    } catch {
      // fall through to the fail-closed error below
    }
  }
  throw attestationError(
    'CI_ATTESTATION_POLICY_MISSING',
    'The base workflow config does not declare protected branches.',
  );
}
export function wrapMapping<T>(commitHash: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof WorkflowError) {
      throw attestationError(
        'CI_ATTESTATION_MAPPING_INVALID',
        'An attested transition mapping failed identity validation.',
        { commit: commitHash, cause: error.message },
      );
    }
    throw error;
  }
}

export function trustedSigner(
  policy: MaintainerPolicy,
  identity: string,
): TrustedMaintainerSigner {
  const signer = policy.trustedSigners.find(
    (candidate) => candidate.identity === identity,
  );
  if (!signer) {
    throw attestationError(
      'CI_ATTESTATION_SIGNER_UNTRUSTED',
      'An attestation or grant signer is absent from the base trusted lineage.',
      { identity },
    );
  }
  return signer;
}

export function invalidAttestationTag(grantId: string) {
  return attestationError(
    'CI_ATTESTATION_TAG_INVALID',
    `Attestation tag for ${grantId} is malformed or noncanonical.`,
  );
}

export function invalidGrantTag(grantId: string) {
  return attestationError(
    'CI_ATTESTATION_GRANT_INVALID',
    `Protected grant tag ${grantId} is malformed or noncanonical.`,
  );
}

export function attestationError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, { details });
}

import type { CiRepositoryObservations } from './commit-replay/ci-git.ts';
import type {
  CiAuthorityReplayOperations,
  CiAuthorityReplayServices,
} from './commit-replay/ci-authority.ts';
import type { HumanResolutionAuditTagReader } from '../investigation/domain/human-resolution-grant-contract.ts';
export type CiAttestationServices = Pick<
  CiRepositoryObservations,
  | 'listFirstParentHashes'
  | 'commitFacts'
  | 'listTagRefs'
  | 'readTagObject'
  | 'readHistoricalPolicyBlob'
  | 'readHistoricalPolicyContent'
  | 'resolveTagCommit'
  | 'resolveCommitTree'
  | 'readFileAtCommit'
> &
  Pick<
    CiAuthorityReplayServices,
    'verifySshDataSignature' | 'verifyTrustedCommitSignature'
  > &
  Pick<CiAuthorityReplayOperations, 'validateCiAuthorityCommit'> & {
    listVerifiedRoleContextSharingTerminalReceipts(
      repositoryRoot: string,
    ): VerifiedRoleContextSharingTerminalReceiptV1[];
    readHumanResolutionAuditTag: HumanResolutionAuditTagReader;
  };
