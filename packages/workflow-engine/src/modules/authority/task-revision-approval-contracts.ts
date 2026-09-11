/**
 * Validates and encodes exact task-revision widening approvals, including
 * their paths and validity windows.
 *
 * Invariants:
 * - assertTaskRevisionApprovalPayload rejects when the signer equals the
 *   binding's actorAuthorityId, is not a trusted signer, or the TTL exceeds
 *   min(policy.maxTtlMinutes, 5) minutes.
 * - assertPolicyPaths requires normalized, sorted, unique paths.
 */
import crypto from 'node:crypto';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { type MaintainerPolicy } from './maintainer-policy.ts';
import type {
  CreateTaskRevisionApprovalContractsBindings,
  TaskRevisionApprovalBinding,
  TaskRevisionApprovalEnvelope,
  TaskRevisionApprovalPayload,
  TaskRevisionApprovalValidationOptions,
} from './task-revision-approval.ts';

export function createTaskRevisionApprovalContracts({
  TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT,
  TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
  TASK_REVISION_APPROVAL_TTL_MINUTES,
  assertChangeId,
  assertSessionId,
  assertTaskId,
  normalizePolicyPath,
}: CreateTaskRevisionApprovalContractsBindings) {
  const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

  const SHA256 = /^[0-9a-f]{64}$/;

  const LEASE_ID =
    /^revision-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

  const AUTHORITY_ID = /^[A-Za-z0-9][A-Za-z0-9._@:+/-]{0,127}$/;

  function taskRevisionApprovalTargetDigest(
    requested: TaskRevisionApprovalBinding,
  ): string {
    const binding = assertTaskRevisionApprovalBinding(requested);
    return crypto
      .createHash('sha256')
      .update('task-revision-approval-target.v1\0')
      .update(canonicalJson(binding))
      .digest('hex');
  }

  function canonicalTaskRevisionApprovalPayload(
    payload: TaskRevisionApprovalPayload,
  ): string {
    return `${canonicalJson({
      version: payload.version,
      kind: payload.kind,
      repositoryId: payload.repositoryId,
      repositoryOrigin: payload.repositoryOrigin,
      policyBlob: payload.policyBlob,
      binding: payload.binding,
      targetDigest: payload.targetDigest,
      authorizedEffect: payload.authorizedEffect,
      rationale: payload.rationale,
      issuedAt: payload.issuedAt,
      expiresAt: payload.expiresAt,
      signer: payload.signer,
    })}\n`;
  }

  function canonicalTaskRevisionApprovalEnvelope(
    envelope: TaskRevisionApprovalEnvelope,
  ): string {
    const payload = JSON.parse(
      canonicalTaskRevisionApprovalPayload(envelope.payload),
    );
    const signatureNamespace = taskRevisionApprovalSignatureNamespace(envelope);
    return `${canonicalJson({
      payload,
      signatureNamespace,
      signature: envelope.signature,
    })}\n`;
  }

  function taskRevisionApprovalRecordId(
    createdAt: string,
    envelope: TaskRevisionApprovalEnvelope,
  ): string {
    return crypto
      .createHash('sha256')
      .update(
        `${JSON.stringify(
          {
            schemaVersion: 1,
            kind: 'task-revision-approval-record.v1',
            createdAt,
            envelope,
          },
          null,
          2,
        )}\n`,
      )
      .digest('hex');
  }

  function assertTaskRevisionApprovalEnvelope(
    value: unknown,
  ): TaskRevisionApprovalEnvelope {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['payload', 'signatureNamespace', 'signature']) ||
      value.signatureNamespace !== TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE ||
      typeof value.signature !== 'string'
    ) {
      throw approvalInvalid('Task-revision approval envelope is malformed.');
    }
    assertArmoredSignature(value.signature);
    const envelope = {
      payload: assertTaskRevisionApprovalPayloadShape(value.payload),
      signatureNamespace: TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE,
      signature: value.signature,
    };
    const canonical = canonicalTaskRevisionApprovalEnvelope(envelope);
    const reparsed = JSON.parse(canonical) as TaskRevisionApprovalEnvelope;
    if (
      canonicalTaskRevisionApprovalEnvelope(reparsed) !== canonical ||
      canonicalJson(reparsed.payload) !== canonicalJson(envelope.payload)
    ) {
      throw approvalInvalid(
        'Task-revision approval envelope is not canonical.',
      );
    }
    return Object.freeze(envelope);
  }

  function taskRevisionApprovalSignatureNamespace(
    envelope: TaskRevisionApprovalEnvelope,
  ): typeof TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE {
    if (
      envelope.signatureNamespace === TASK_REVISION_APPROVAL_SIGNATURE_NAMESPACE
    ) {
      return envelope.signatureNamespace;
    }
    throw approvalInvalid(
      'Task-revision approval signature namespace is invalid.',
    );
  }

  function assertTaskRevisionApprovalPayloadShape(
    value: unknown,
  ): TaskRevisionApprovalPayload {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'version',
        'kind',
        'repositoryId',
        'repositoryOrigin',
        'policyBlob',
        'binding',
        'targetDigest',
        'authorizedEffect',
        'rationale',
        'issuedAt',
        'expiresAt',
        'signer',
      ]) ||
      value.version !== 1 ||
      value.kind !== 'task-revision-approval.v1' ||
      typeof value.repositoryId !== 'string' ||
      typeof value.repositoryOrigin !== 'string' ||
      typeof value.policyBlob !== 'string' ||
      typeof value.targetDigest !== 'string' ||
      value.authorizedEffect !== TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT ||
      typeof value.rationale !== 'string' ||
      typeof value.issuedAt !== 'string' ||
      typeof value.expiresAt !== 'string' ||
      typeof value.signer !== 'string'
    ) {
      throw approvalInvalid('Task-revision approval payload is malformed.');
    }
    return Object.freeze({
      version: 1,
      kind: 'task-revision-approval.v1',
      repositoryId: value.repositoryId,
      repositoryOrigin: value.repositoryOrigin,
      policyBlob: value.policyBlob,
      binding: assertTaskRevisionApprovalBinding(value.binding),
      targetDigest: value.targetDigest,
      authorizedEffect: TASK_REVISION_APPROVAL_AUTHORIZED_EFFECT,
      rationale: value.rationale,
      issuedAt: value.issuedAt,
      expiresAt: value.expiresAt,
      signer: value.signer,
    });
  }

  function assertTaskRevisionApprovalPayload(
    value: TaskRevisionApprovalPayload,
    policy: MaintainerPolicy,
    expectedPolicyBlob: string,
    expectedBinding: TaskRevisionApprovalBinding,
    options: TaskRevisionApprovalValidationOptions,
  ): void {
    const payload = assertTaskRevisionApprovalPayloadShape(value);
    const issuedAt = Date.parse(payload.issuedAt);
    const expiresAt = Date.parse(payload.expiresAt);
    const now = exactDate(options.now).getTime();
    if (
      payload.repositoryId !== policy.repository.id ||
      payload.repositoryOrigin !== policy.repository.origin ||
      payload.policyBlob !== expectedPolicyBlob ||
      canonicalJson(payload.binding) !== canonicalJson(expectedBinding) ||
      payload.targetDigest !==
        taskRevisionApprovalTargetDigest(expectedBinding) ||
      payload.signer === expectedBinding.actorAuthorityId ||
      !policy.trustedSigners.some(
        ({ identity }) => identity === payload.signer,
      ) ||
      !OID.test(payload.policyBlob) ||
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      issuedAt > expiresAt ||
      expiresAt - issuedAt >
        Math.min(policy.maxTtlMinutes, TASK_REVISION_APPROVAL_TTL_MINUTES) *
          60_000 ||
      issuedAt > now + 30_000 ||
      (!options.allowExpired && (now < issuedAt || now >= expiresAt))
    ) {
      throw approvalStale(
        'Task-revision approval is stale or does not match the exact widening candidate.',
      );
    }
    assertRationale(payload.rationale);
  }

  function assertTaskRevisionApprovalBinding(
    value: unknown,
  ): TaskRevisionApprovalBinding {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'changeId',
        'taskId',
        'sessionId',
        'leaseId',
        'actorAuthorityId',
        'baselineCommit',
        'baselineTree',
        'priorContractDigest',
        'candidateContractDigest',
        'candidatePlanningGenerationId',
        'implementationFingerprint',
        'revisionReasonDigest',
        'previousAllowedPaths',
        'nextAllowedPaths',
        'previousRequiredChecks',
        'nextRequiredChecks',
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'task-revision-approval-binding.v1' ||
      typeof value.changeId !== 'string' ||
      typeof value.taskId !== 'string' ||
      typeof value.sessionId !== 'string' ||
      typeof value.leaseId !== 'string' ||
      typeof value.actorAuthorityId !== 'string' ||
      typeof value.baselineCommit !== 'string' ||
      typeof value.baselineTree !== 'string' ||
      typeof value.priorContractDigest !== 'string' ||
      typeof value.candidateContractDigest !== 'string' ||
      typeof value.candidatePlanningGenerationId !== 'string' ||
      typeof value.implementationFingerprint !== 'string' ||
      typeof value.revisionReasonDigest !== 'string' ||
      !Array.isArray(value.previousAllowedPaths) ||
      !Array.isArray(value.nextAllowedPaths) ||
      !Array.isArray(value.previousRequiredChecks) ||
      !Array.isArray(value.nextRequiredChecks)
    ) {
      throw approvalInvalid('Task-revision approval binding is malformed.');
    }
    assertChangeId(value.changeId);
    assertTaskId(value.taskId);
    assertSessionId(value.sessionId);
    if (
      !LEASE_ID.test(value.leaseId) ||
      !AUTHORITY_ID.test(value.actorAuthorityId) ||
      !OID.test(value.baselineCommit) ||
      !OID.test(value.baselineTree) ||
      !SHA256.test(value.priorContractDigest) ||
      !SHA256.test(value.candidateContractDigest) ||
      !SHA256.test(value.candidatePlanningGenerationId) ||
      !SHA256.test(value.implementationFingerprint) ||
      !SHA256.test(value.revisionReasonDigest)
    ) {
      throw approvalInvalid('Task-revision approval binding is invalid.');
    }
    const previousAllowedPaths = assertPolicyPaths(value.previousAllowedPaths);
    const nextAllowedPaths = assertPolicyPaths(value.nextAllowedPaths);
    const previousRequiredChecks = assertStringSet(
      value.previousRequiredChecks,
      'previous required checks',
    );
    const nextRequiredChecks = assertStringSet(
      value.nextRequiredChecks,
      'next required checks',
    );
    return Object.freeze({
      schemaVersion: 1,
      kind: 'task-revision-approval-binding.v1',
      changeId: value.changeId,
      taskId: value.taskId,
      sessionId: value.sessionId,
      leaseId: value.leaseId,
      actorAuthorityId: value.actorAuthorityId,
      baselineCommit: value.baselineCommit,
      baselineTree: value.baselineTree,
      priorContractDigest: value.priorContractDigest,
      candidateContractDigest: value.candidateContractDigest,
      candidatePlanningGenerationId: value.candidatePlanningGenerationId,
      implementationFingerprint: value.implementationFingerprint,
      revisionReasonDigest: value.revisionReasonDigest,
      previousAllowedPaths,
      nextAllowedPaths,
      previousRequiredChecks,
      nextRequiredChecks,
    });
  }

  function assertPolicyPaths(value: unknown[]): string[] {
    const paths = value.map((candidate) => {
      if (typeof candidate !== 'string') {
        throw approvalInvalid('Task-revision approval path is invalid.');
      }
      return normalizePolicyPath(candidate);
    });
    if (!isSortedUnique(paths)) {
      throw approvalInvalid(
        'Task-revision approval paths must be normalized, sorted, and unique.',
      );
    }
    return paths;
  }

  function assertStringSet(value: unknown[], label: string): string[] {
    const strings = value.map((candidate) => {
      if (
        typeof candidate !== 'string' ||
        candidate.length === 0 ||
        candidate.length > 128
      ) {
        throw approvalInvalid(`Task-revision approval ${label} are invalid.`);
      }
      return candidate;
    });
    if (!isSortedUnique(strings)) {
      throw approvalInvalid(
        `Task-revision approval ${label} must be sorted and unique.`,
      );
    }
    return strings;
  }

  function assertRationale(value: string): string {
    const normalized = value.trim();
    if (
      normalized !== value ||
      normalized.length < 8 ||
      normalized.length > 2_000
    ) {
      throw approvalInvalid(
        'Task-revision approval rationale must contain 8 to 2000 trimmed characters.',
      );
    }
    return normalized;
  }

  function exactDate(value: Date): Date {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw approvalInvalid('Task-revision approval clock is invalid.');
    }
    return new Date(value.getTime());
  }

  function assertArmoredSignature(value: string): void {
    if (
      !value.startsWith('-----BEGIN SSH SIGNATURE-----\n') ||
      !value.endsWith('-----END SSH SIGNATURE-----\n') ||
      value.length > 16_384
    ) {
      throw approvalInvalid('Task-revision approval signature is malformed.');
    }
  }

  function isSortedUnique(values: readonly string[]): boolean {
    return values.every(
      (value, index) => index === 0 || values[index - 1]! < value,
    );
  }

  function approvalInvalid(message: string) {
    return workflowError(
      'TASK_REVISION_APPROVAL_INVALID',
      message,
      ExitCode.guard,
    );
  }

  function approvalStale(message: string) {
    return workflowError(
      'TASK_REVISION_APPROVAL_STALE',
      message,
      ExitCode.staleState,
    );
  }

  function hasExactKeys(
    value: Record<string, unknown>,
    expected: readonly string[],
  ): boolean {
    const keys = Object.keys(value).sort();
    return (
      keys.length === expected.length &&
      keys.every((key, index) => key === [...expected].sort()[index])
    );
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  return {
    OID,
    SHA256,
    approvalInvalid,
    approvalStale,
    assertArmoredSignature,
    assertRationale,
    assertTaskRevisionApprovalBinding,
    assertTaskRevisionApprovalEnvelope,
    assertTaskRevisionApprovalPayload,
    canonicalTaskRevisionApprovalPayload,
    exactDate,
    hasExactKeys,
    taskRevisionApprovalRecordId,
    taskRevisionApprovalSignatureNamespace,
    taskRevisionApprovalTargetDigest,
  } as const;
}
