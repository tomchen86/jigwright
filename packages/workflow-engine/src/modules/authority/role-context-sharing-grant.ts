/**
 * Validates role-context-sharing Grants and applies their reserve and
 * consume transitions.
 *
 * Invariants:
 * - validateDomainPayload throws bindingMismatch unless policy.maxUses and
 *   payload.maxUses are both 1 and the payload signer is a trusted policy
 *   signer.
 * - The signed lifetime (expiresAt−issuedAt) may not exceed
 *   min(policy.maxTtlMinutes, 30) minutes, else the grant is rejected as
 *   expired.
 */
import crypto from 'node:crypto';

import {
  ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
  type RoleContextSharingGrantEnvelopeV1,
  type RoleContextSharingGrantExpectedBindingV1,
  type RoleContextSharingGrantPayloadV1,
} from '@jigwright/core/role-context-sharing-grant-codec';
import { isRoleContextSharingGrantError } from './grant-errors.ts';
import type { VerifiedRoleContextSharingGrantCapabilityV1 } from '@jigwright/grants/role-context-sharing-degradation';

import {
  GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
  type GrantLifecycleClockPortV1,
  type GrantLifecycleStoragePortV1,
  type GrantLifecycleTransitionResultV1,
} from '@jigwright/core/grant-lifecycle-contracts';

import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import type { GrantVerifierPort } from './grant-verifier-port.ts';
import {
  assertAuthoritativeRoleContextSharingGrantVerifier,
  type AuthoritativeRoleContextSharingGrantVerifier,
} from './role-context-sharing-grant-verifier-port.ts';
import type { MaintainerPolicy } from './maintainer-policy.ts';

export const ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1 =
  'workflow.role-context-sharing-eligibility.v1' as const;
export const ROLE_CONTEXT_SHARING_MAX_TTL_MINUTES = 30;
export const ROLE_CONTEXT_SHARING_POLICY = deepFreeze({
  schemaVersion: 1 as const,
  policyId: 'workflow.role-context-sharing-policy.v1' as const,
  authorizedEffect: 'role-context-sharing-degradation' as const,
  exactRolePairs: [
    'author-builder',
    'author-reviewer',
    'builder-reviewer',
  ] as const,
  maxUses: 1 as const,
  maxTtlMinutes: ROLE_CONTEXT_SHARING_MAX_TTL_MINUTES,
  defaultEligibility: 'deny-unless-explicitly-listed' as const,
  retainedBoundaries: [
    'provider-data-authorization',
    'repository-policy',
    'managed-transition-authority',
  ] as const,
});
export const ROLE_CONTEXT_SHARING_POLICY_DIGEST = crypto
  .createHash('sha256')
  .update(JSON.stringify(ROLE_CONTEXT_SHARING_POLICY))
  .digest('hex');
export function isKnownRoleContextSharingPolicyDigest(digest: string): boolean {
  return digest === ROLE_CONTEXT_SHARING_POLICY_DIGEST;
}

export type RoleContextSharingEligibilityPortV1 = Readonly<{
  contractVersion: typeof ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1;
  policyDigest: string;
  assertEligible(binding: RoleContextSharingGrantExpectedBindingV1): void;
}>;

export type RoleContextSharingGrantValidationOptions = Readonly<{
  now: Date;
  expected: RoleContextSharingGrantExpectedBindingV1;
  verifier: GrantVerifierPort;
  eligibility?: RoleContextSharingEligibilityPortV1;
}>;

export type RoleContextSharingGrantTransitionRequest = Readonly<{
  envelope: RoleContextSharingGrantEnvelopeV1;
  policy: MaintainerPolicy;
  options: RoleContextSharingGrantValidationOptions;
  event: 'reserve' | 'consume';
}>;

function assertEligibilityPort(
  value: RoleContextSharingEligibilityPortV1 | undefined,
): RoleContextSharingEligibilityPortV1 {
  if (
    value?.contractVersion !==
      ROLE_CONTEXT_SHARING_ELIGIBILITY_CONTRACT_VERSION_V1 ||
    !/^[0-9a-f]{64}$/.test(value.policyDigest) ||
    typeof value.assertEligible !== 'function'
  ) {
    throw ineligible();
  }
  return value;
}

function exactDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw invalidGrant();
  }
  return new Date(value.getTime());
}

function exactTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString() === value
    ? timestamp
    : undefined;
}

function bindingMismatch(): WorkflowError {
  return workflowError(
    'ROLE_CONTEXT_SHARING_GRANT_BINDING_MISMATCH',
    'Role-context-sharing grant does not match the exact requested authority binding.',
    ExitCode.guard,
  );
}

function ineligible(cause?: unknown): WorkflowError {
  return workflowError(
    'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE',
    'Role-context-sharing grant subject is not explicitly eligible.',
    ExitCode.guard,
    cause === undefined ? {} : { details: errorDetails(cause) },
  );
}

function invalidGrant(cause?: unknown): WorkflowError {
  return workflowError(
    'ROLE_CONTEXT_SHARING_GRANT_INVALID',
    'Role-context-sharing grant is invalid.',
    ExitCode.guard,
    cause === undefined ? {} : { details: errorDetails(cause) },
  );
}

function errorDetails(cause: unknown): Record<string, unknown> {
  return {
    cause: cause instanceof Error ? cause.message : String(cause),
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}

export type RoleContextSharingGrantOperations = Pick<
  typeof import('@jigwright/grants/role-context-sharing-degradation'),
  | 'bindingFromRoleContextSharingGrantPayloadV1'
  | 'canonicalRoleContextSharingGrantEnvelopeV1'
  | 'verifyRoleContextSharingGrantCapabilityV1'
> &
  Pick<
    typeof import('@jigwright/grants/grant-lifecycle'),
    'executeGrantLifecycleTransitionV1'
  >;

export function createRoleContextSharingGrantServices(
  operations: RoleContextSharingGrantOperations,
) {
  const {
    bindingFromRoleContextSharingGrantPayloadV1,
    canonicalRoleContextSharingGrantEnvelopeV1,
    verifyRoleContextSharingGrantCapabilityV1,
    executeGrantLifecycleTransitionV1,
  } = operations;

  function verifyRoleContextSharingGrantCapability(
    envelope: RoleContextSharingGrantEnvelopeV1,
    policy: MaintainerPolicy,
    options: RoleContextSharingGrantValidationOptions,
  ): VerifiedRoleContextSharingGrantCapabilityV1 {
    assertAuthoritativeRoleContextSharingGrantVerifier(options.verifier);
    const verifier: AuthoritativeRoleContextSharingGrantVerifier =
      options.verifier;
    verifier.assertCurrent();
    const eligibility = assertEligibilityPort(options.eligibility);
    try {
      return verifyRoleContextSharingGrantCapabilityV1({
        readerContractVersion:
          ROLE_CONTEXT_SHARING_GRANT_READER_CONTRACT_VERSION_V1,
        raw: canonicalRoleContextSharingGrantEnvelopeV1(envelope),
        expected: options.expected,
        verifier,
        validatePayload(payload) {
          validateDomainPayload(payload, policy, options, eligibility);
        },
      });
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      if (isRoleContextSharingGrantError(error)) {
        if (error.code === 'ROLE_CONTEXT_SHARING_GRANT_BINDING_MISMATCH') {
          throw bindingMismatch();
        }
        if (error.code === 'ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_INVALID') {
          throw workflowError(
            'ROLE_CONTEXT_SHARING_GRANT_SIGNATURE_INVALID',
            'Role-context-sharing grant signature is invalid.',
            ExitCode.guard,
            { details: errorDetails(error) },
          );
        }
        throw invalidGrant(error);
      }
      throw error;
    }
  }

  function executeRoleContextSharingGrantTransitionV1<Persisted>(
    request: RoleContextSharingGrantTransitionRequest,
    ports: Readonly<{
      clock: GrantLifecycleClockPortV1;
      storage: GrantLifecycleStoragePortV1<
        VerifiedRoleContextSharingGrantCapabilityV1,
        Persisted
      >;
    }>,
  ): GrantLifecycleTransitionResultV1<Persisted> {
    const validation = () =>
      verifyRoleContextSharingGrantCapability(
        request.envelope,
        request.policy,
        request.options,
      );
    return executeGrantLifecycleTransitionV1(
      {
        contractVersion: GRANT_LIFECYCLE_CONTRACT_VERSION_V1,
        grantId: request.envelope.payload.grantId,
        transitionDigest: request.envelope.payload.targetDigest,
        maxUses: request.envelope.payload.maxUses,
        event:
          request.event === 'reserve'
            ? {
                kind: 'reserve',
                expiresAt: request.envelope.payload.expiresAt,
                reason: 'Exact role-context-sharing grant reserved',
                expirationReason:
                  'Role-context-sharing grant expired before reservation',
              }
            : {
                kind: 'consume',
                reason: 'Exact role-context-sharing grant consumed',
              },
        validate: validation,
        ...(request.event === 'consume'
          ? {
              validationFailureReason:
                'Role-context-sharing grant failed exact consume validation',
            }
          : {}),
      },
      ports,
    );
  }

  function validateDomainPayload(
    payload: RoleContextSharingGrantPayloadV1,
    policy: MaintainerPolicy,
    options: RoleContextSharingGrantValidationOptions,
    eligibility: RoleContextSharingEligibilityPortV1,
  ): void {
    if (
      payload.repositoryId !== policy.repository.id ||
      payload.repositoryOrigin !== policy.repository.origin ||
      payload.policyBlob !== options.expected.policyBlob ||
      !isKnownRoleContextSharingPolicyDigest(
        payload.roleContextSharingPolicyDigest,
      ) ||
      payload.eligibilityPolicyDigest !== eligibility.policyDigest ||
      policy.maxUses !== 1 ||
      payload.maxUses !== 1 ||
      !policy.trustedSigners.some(({ identity }) => identity === payload.signer)
    ) {
      throw bindingMismatch();
    }
    const now = exactDate(options.now);
    const issuedAt = exactTimestamp(payload.issuedAt);
    const expiresAt = exactTimestamp(payload.expiresAt);
    if (
      issuedAt === undefined ||
      expiresAt === undefined ||
      issuedAt > expiresAt ||
      issuedAt > now.getTime() + 30_000 ||
      expiresAt < now.getTime() ||
      expiresAt - issuedAt >
        Math.min(policy.maxTtlMinutes, ROLE_CONTEXT_SHARING_MAX_TTL_MINUTES) *
          60_000
    ) {
      throw workflowError(
        'ROLE_CONTEXT_SHARING_GRANT_EXPIRED',
        'Role-context-sharing grant is expired or has invalid time bounds.',
        ExitCode.staleState,
      );
    }
    try {
      eligibility.assertEligible(
        bindingFromRoleContextSharingGrantPayloadV1(payload),
      );
    } catch (cause) {
      if (
        cause instanceof WorkflowError &&
        cause.code === 'ROLE_CONTEXT_SHARING_GRANT_INELIGIBLE'
      ) {
        throw cause;
      }
      throw ineligible(cause);
    }
  }

  return {
    verifyRoleContextSharingGrantCapability,
    executeRoleContextSharingGrantTransitionV1,
  };
}

export type RoleContextSharingGrantServices = ReturnType<
  typeof createRoleContextSharingGrantServices
>;
