import type { AuthorityApplicationReceiptOperations } from '../../authority/authority-application-receipt.ts';
import type { MaintainerDataSignatureVerifier } from '../../authority/maintainer-signer-port.ts';
import type { RangeCommit } from './ci-git.ts';

/** Canonical commit replay contracts and pure predicates. */
import crypto from 'node:crypto';
import { ExitCode } from '../../../foundation/errors/errors.ts';
import { workflowError } from '../../../foundation/errors/errors.ts';
import { parseMaintainerPolicy } from '../../authority/maintainer-policy.ts';
import type { MaintainerPolicy } from '../../authority/maintainer-policy.ts';
import type { TrustedMaintainerSigner } from '../../authority/maintainer-policy.ts';

export type CiAuthorityResult = {
  grantId: string;
  changeId: string;
  allowedPaths: string[];
  requiredCheckDefinitions: Record<string, string>;
};

export function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function workflowErrorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
}

export function assertCurrentMaintainerPolicyTransition(
  parentPolicy: MaintainerPolicy,
  candidate: MaintainerPolicy,
): void {
  if (
    JSON.stringify(candidate.repository) !==
      JSON.stringify(parentPolicy.repository) ||
    candidate.auditTagPrefix !== parentPolicy.auditTagPrefix ||
    candidate.signatureNamespace !== parentPolicy.signatureNamespace ||
    candidate.maxTtlMinutes !== parentPolicy.maxTtlMinutes ||
    candidate.maxUses !== parentPolicy.maxUses ||
    (parentPolicy.phase === 'sealed' && candidate.phase !== 'sealed') ||
    parentPolicy.sealedImmutablePaths.some(
      (filePath) => !candidate.sealedImmutablePaths.includes(filePath),
    ) ||
    parentPolicy.requiredChecks.some(
      (checkId) => !candidate.requiredChecks.includes(checkId),
    )
  ) {
    throw ciAuthorityError(
      'CI_AUTHORITY_POLICY_TRANSITION_INVALID',
      'Authority policy transition changes stable identity, rolls back phase, or weakens trust roots.',
    );
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
    throw ciAuthorityError(
      'CI_AUTHORITY_SIGNER_UNTRUSTED',
      'Authority grant signer is absent from the parent policy.',
    );
  }
  return signer;
}

export function parsePolicy(content: string, code: string): MaintainerPolicy {
  try {
    return parseMaintainerPolicy(JSON.parse(content));
  } catch {
    throw ciAuthorityError(code, 'Maintainer policy is invalid.');
  }
}

export function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

export function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  return (
    JSON.stringify(Object.keys(value).sort()) ===
    JSON.stringify([...expected].sort())
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

export function ciAuthorityError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.verification, { details });
}

export type CiAuthorityReplayOperations = {
  validateCiAuthorityCommit(
    repositoryRoot: string,
    commit: RangeCommit,
    _evaluatedAt?: Date,
  ): CiAuthorityResult;
};

export type CiAuthorityReplayServices = {
  authorityApplicationReceipts: Pick<
    AuthorityApplicationReceiptOperations,
    | 'listAuthorityApplicationReceiptTagRefs'
    | 'readAuthorityApplicationReceiptTag'
    | 'verifyAuthorityApplicationReceiptSignature'
  >;
  verifySshDataSignature: MaintainerDataSignatureVerifier;
  verifyTrustedCommitSignature(
    repositoryRoot: string,
    commitHash: string,
    signer: TrustedMaintainerSigner,
    errorCode: string,
  ): void;
};
