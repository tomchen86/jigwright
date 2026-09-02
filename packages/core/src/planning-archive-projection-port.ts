import path from 'node:path';

import { isRecord } from './contract-values.ts';
import {
  planningProviderBindingDigest,
  planningProviderBindingPath,
  type PlanningProviderBindingV1,
  type ResolvedPlanningProviderBinding,
} from './planning-provider-binding.ts';
import { normalizeExactRepositoryPath } from './repository-path.ts';

const CHANGE_ID = /^[a-z][a-z0-9-]{0,127}$/u;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const REVISION = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/**
 * Thrown when a planning archive projection port, its bound context, or its
 * normalized evidence fails the implementation-neutral contract.
 */
export class PlanningArchiveProjectionPortContractError extends TypeError {
  readonly code = 'PLANNING_ARCHIVE_PROJECTION_PORT_INVALID';

  constructor() {
    super('Planning archive projection port input or result is invalid.');
    this.name = 'PlanningArchiveProjectionPortContractError';
  }
}

/**
 * The caller owns the disposable projection root and all Git state. A port may
 * inspect or mutate only that root; it never creates worktrees, writes refs,
 * stages, commits, or authorizes a transition.
 */
export type PlanningArchiveProjectionContext = Readonly<{
  repositoryRoot: string;
  projectionRoot: string;
  sourceRevision: string;
  changeId: string;
  mode: 'projection' | 'replay';
  planningProvider: ResolvedPlanningProviderBinding;
}>;

export type PlanningArchiveProjectionDiagnostic = Readonly<{
  level: 'ERROR' | 'WARNING' | 'INFO';
  path: string;
  message: string;
  line?: number;
  column?: number;
}>;

export type PlanningArchiveReadiness = Readonly<{
  providerId: string;
  adapterContractVersion: number;
  providerVersion: string;
  ready: boolean;
  diagnostics: readonly PlanningArchiveProjectionDiagnostic[];
}>;

export type PlanningArchiveTotals = Readonly<{
  added: number;
  modified: number;
  removed: number;
  renamed: number;
}>;

/** A normalized, provider-neutral result from a disposable archive root. */
export type PlanningArchiveProjection = Readonly<{
  providerId: string;
  adapterContractVersion: number;
  providerVersion: string;
  archiveName: string;
  archivePath: string;
  specsUpdated: boolean;
  totals?: PlanningArchiveTotals;
}>;

export type PlanningArchiveProjectedSpecValidation = Readonly<{
  providerId: string;
  adapterContractVersion: number;
  providerVersion: string;
  valid: boolean;
  diagnostics: readonly PlanningArchiveProjectionDiagnostic[];
}>;

export interface PlanningArchiveProjectionPort {
  readonly id: string;
  readonly contractVersion: number;
  inspectArchiveReadiness(
    context: PlanningArchiveProjectionContext,
  ): PlanningArchiveReadiness;
  prepareArchive(
    context: PlanningArchiveProjectionContext,
  ): PlanningArchiveProjection;
  validateProjectedSpecs(
    context: PlanningArchiveProjectionContext,
  ): PlanningArchiveProjectedSpecValidation;
}

export function inspectPlanningArchiveReadiness(
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): PlanningArchiveReadiness {
  const { normalizedContext, normalizedPort } = assertInvocation(port, context);
  return normalizeReadiness(
    normalizedPort.inspectArchiveReadiness(normalizedContext),
    normalizedPort,
    normalizedContext,
  );
}

export function preparePlanningArchiveProjection(
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): PlanningArchiveProjection {
  const { normalizedContext, normalizedPort } = assertInvocation(port, context);
  return normalizeProjection(
    normalizedPort.prepareArchive(normalizedContext),
    normalizedPort,
    normalizedContext,
  );
}

export function validatePlanningArchiveProjectedSpecs(
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): PlanningArchiveProjectedSpecValidation {
  const { normalizedContext, normalizedPort } = assertInvocation(port, context);
  return normalizeProjectedSpecValidation(
    normalizedPort.validateProjectedSpecs(normalizedContext),
    normalizedPort,
    normalizedContext,
  );
}

function assertInvocation(
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): {
  normalizedPort: PlanningArchiveProjectionPort;
  normalizedContext: PlanningArchiveProjectionContext;
} {
  const normalizedContext = normalizeContext(context);
  const normalizedPort = normalizePort(
    port,
    normalizedContext.planningProvider,
  );
  return { normalizedPort, normalizedContext };
}

function normalizeContext(
  value: PlanningArchiveProjectionContext,
): PlanningArchiveProjectionContext {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'changeId',
      'mode',
      'planningProvider',
      'projectionRoot',
      'repositoryRoot',
      'sourceRevision',
    ]) ||
    typeof value.repositoryRoot !== 'string' ||
    typeof value.projectionRoot !== 'string' ||
    !isCanonicalAbsolutePath(value.repositoryRoot) ||
    !isCanonicalAbsolutePath(value.projectionRoot) ||
    value.repositoryRoot === value.projectionRoot ||
    typeof value.sourceRevision !== 'string' ||
    !REVISION.test(value.sourceRevision) ||
    typeof value.changeId !== 'string' ||
    !CHANGE_ID.test(value.changeId) ||
    (value.mode !== 'projection' && value.mode !== 'replay')
  ) {
    throw invalidPort();
  }
  const planningProvider = normalizeResolvedBinding(
    value.planningProvider,
    value.changeId,
  );
  return Object.freeze({
    repositoryRoot: value.repositoryRoot,
    projectionRoot: value.projectionRoot,
    sourceRevision: value.sourceRevision,
    changeId: value.changeId,
    mode: value.mode,
    planningProvider,
  });
}

function normalizeResolvedBinding(
  value: unknown,
  changeId: string,
): ResolvedPlanningProviderBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'artifactPath',
      'binding',
      'bindingDigest',
      'source',
    ]) ||
    value.source !== 'explicit' ||
    typeof value.artifactPath !== 'string' ||
    typeof value.bindingDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.bindingDigest)
  ) {
    throw invalidPort();
  }
  const binding = normalizeBinding(value.binding, changeId);
  let expectedArtifactPath: string;
  let expectedDigest: string;
  try {
    expectedArtifactPath = planningProviderBindingPath(changeId);
    expectedDigest = planningProviderBindingDigest(binding);
  } catch {
    throw invalidPort();
  }
  if (
    value.artifactPath !== expectedArtifactPath ||
    value.bindingDigest !== expectedDigest
  ) {
    throw invalidPort();
  }
  return Object.freeze({
    binding,
    source: 'explicit',
    artifactPath: value.artifactPath,
    bindingDigest: value.bindingDigest,
  });
}

function normalizeBinding(
  value: unknown,
  changeId: string,
): PlanningProviderBindingV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'adapterContractVersion',
      'changeId',
      'planningRoot',
      'providerId',
      'providerRequirement',
      'schemaVersion',
    ]) ||
    value.schemaVersion !== 1 ||
    value.changeId !== changeId ||
    typeof value.providerId !== 'string' ||
    !PROVIDER_ID.test(value.providerId) ||
    typeof value.adapterContractVersion !== 'number' ||
    !Number.isSafeInteger(value.adapterContractVersion) ||
    value.adapterContractVersion < 1 ||
    !isRecord(value.providerRequirement) ||
    !hasExactKeys(value.providerRequirement, ['package', 'version']) ||
    typeof value.providerRequirement.package !== 'string' ||
    value.providerRequirement.package.length === 0 ||
    typeof value.providerRequirement.version !== 'string' ||
    value.providerRequirement.version.length === 0 ||
    typeof value.planningRoot !== 'string'
  ) {
    throw invalidPort();
  }
  let planningRoot: string;
  try {
    planningRoot = normalizeExactRepositoryPath(value.planningRoot);
  } catch {
    throw invalidPort();
  }
  if (planningRoot !== value.planningRoot) throw invalidPort();
  return Object.freeze({
    schemaVersion: 1,
    changeId,
    providerId: value.providerId,
    adapterContractVersion: value.adapterContractVersion,
    providerRequirement: Object.freeze({
      package: value.providerRequirement.package,
      version: value.providerRequirement.version,
    }),
    planningRoot,
  });
}

function normalizePort(
  value: PlanningArchiveProjectionPort,
  binding: ResolvedPlanningProviderBinding,
): PlanningArchiveProjectionPort {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'contractVersion',
      'id',
      'inspectArchiveReadiness',
      'prepareArchive',
      'validateProjectedSpecs',
    ]) ||
    typeof value.id !== 'string' ||
    value.id !== binding.binding.providerId ||
    typeof value.contractVersion !== 'number' ||
    value.contractVersion !== binding.binding.adapterContractVersion ||
    !Number.isSafeInteger(value.contractVersion) ||
    value.contractVersion < 1 ||
    typeof value.inspectArchiveReadiness !== 'function' ||
    typeof value.prepareArchive !== 'function' ||
    typeof value.validateProjectedSpecs !== 'function'
  ) {
    throw invalidPort();
  }
  return value;
}

function normalizeReadiness(
  value: unknown,
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): PlanningArchiveReadiness {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'adapterContractVersion',
      'diagnostics',
      'providerId',
      'providerVersion',
      'ready',
    ]) ||
    typeof value.ready !== 'boolean' ||
    !Array.isArray(value.diagnostics)
  ) {
    throw invalidPort();
  }
  const diagnostics = normalizeDiagnostics(value.diagnostics);
  assertProviderResultIdentity(value, port, context);
  if (
    (value.ready && diagnostics.some(({ level }) => level === 'ERROR')) ||
    (!value.ready && !diagnostics.some(({ level }) => level === 'ERROR'))
  ) {
    throw invalidPort();
  }
  return Object.freeze({
    providerId: value.providerId,
    adapterContractVersion: value.adapterContractVersion,
    providerVersion: value.providerVersion,
    ready: value.ready,
    diagnostics,
  });
}

function normalizeProjection(
  value: unknown,
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): PlanningArchiveProjection {
  const requiredKeys = [
    'adapterContractVersion',
    'archiveName',
    'archivePath',
    'providerId',
    'providerVersion',
    'specsUpdated',
  ];
  if (
    !isRecord(value) ||
    !(
      hasExactKeys(value, requiredKeys) ||
      hasExactKeys(value, [...requiredKeys, 'totals'])
    ) ||
    typeof value.archiveName !== 'string' ||
    !isSafeArchiveName(value.archiveName) ||
    typeof value.archivePath !== 'string' ||
    typeof value.specsUpdated !== 'boolean'
  ) {
    throw invalidPort();
  }
  let archivePath: string;
  try {
    archivePath = normalizeExactRepositoryPath(value.archivePath);
  } catch {
    throw invalidPort();
  }
  if (archivePath !== value.archivePath) throw invalidPort();
  assertProviderResultIdentity(value, port, context);
  return Object.freeze({
    providerId: value.providerId,
    adapterContractVersion: value.adapterContractVersion,
    providerVersion: value.providerVersion,
    archiveName: value.archiveName,
    archivePath,
    specsUpdated: value.specsUpdated,
    ...(value.totals === undefined
      ? {}
      : { totals: normalizeTotals(value.totals) }),
  });
}

function normalizeProjectedSpecValidation(
  value: unknown,
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): PlanningArchiveProjectedSpecValidation {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'adapterContractVersion',
      'diagnostics',
      'providerId',
      'providerVersion',
      'valid',
    ]) ||
    typeof value.valid !== 'boolean' ||
    !Array.isArray(value.diagnostics)
  ) {
    throw invalidPort();
  }
  const diagnostics = normalizeDiagnostics(value.diagnostics);
  assertProviderResultIdentity(value, port, context);
  if (
    (value.valid && diagnostics.some(({ level }) => level === 'ERROR')) ||
    (!value.valid && !diagnostics.some(({ level }) => level === 'ERROR'))
  ) {
    throw invalidPort();
  }
  return Object.freeze({
    providerId: value.providerId,
    adapterContractVersion: value.adapterContractVersion,
    providerVersion: value.providerVersion,
    valid: value.valid,
    diagnostics,
  });
}

type ProviderResultIdentity = Readonly<{
  providerId: string;
  adapterContractVersion: number;
  providerVersion: string;
}>;

function assertProviderResultIdentity(
  value: Record<string, unknown>,
  port: PlanningArchiveProjectionPort,
  context: PlanningArchiveProjectionContext,
): asserts value is Record<string, unknown> & ProviderResultIdentity {
  if (
    typeof value.providerId !== 'string' ||
    typeof value.adapterContractVersion !== 'number' ||
    typeof value.providerVersion !== 'string' ||
    value.providerId !== port.id ||
    value.adapterContractVersion !== port.contractVersion ||
    value.providerVersion.length === 0 ||
    value.providerVersion !==
      context.planningProvider.binding.providerRequirement.version
  ) {
    throw invalidPort();
  }
}

function normalizeTotals(value: unknown): PlanningArchiveTotals {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['added', 'modified', 'removed', 'renamed']) ||
    !Object.values(value).every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0,
    )
  ) {
    throw invalidPort();
  }
  return Object.freeze({
    added: value.added as number,
    modified: value.modified as number,
    removed: value.removed as number,
    renamed: value.renamed as number,
  });
}

function normalizeDiagnostics(
  values: readonly unknown[],
): readonly PlanningArchiveProjectionDiagnostic[] {
  const diagnostics = values.map((value) => normalizeDiagnostic(value));
  const ordered = [...diagnostics].sort(compareDiagnostics);
  if (
    JSON.stringify(diagnostics) !== JSON.stringify(ordered) ||
    new Set(diagnostics.map((diagnostic) => JSON.stringify(diagnostic)))
      .size !== diagnostics.length
  ) {
    throw invalidPort();
  }
  return Object.freeze(diagnostics);
}

function normalizeDiagnostic(
  value: unknown,
): PlanningArchiveProjectionDiagnostic {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      ['column', 'level', 'line', 'message', 'path'],
      true,
    ) ||
    (value.level !== 'ERROR' &&
      value.level !== 'WARNING' &&
      value.level !== 'INFO') ||
    typeof value.path !== 'string' ||
    typeof value.message !== 'string' ||
    value.message.length === 0 ||
    value.message.length > 16_384 ||
    (value.line !== undefined &&
      (!Number.isSafeInteger(value.line) || Number(value.line) < 1)) ||
    (value.column !== undefined &&
      (!Number.isSafeInteger(value.column) || Number(value.column) < 1))
  ) {
    throw invalidPort();
  }
  let diagnosticPath: string;
  try {
    diagnosticPath = normalizeExactRepositoryPath(value.path);
  } catch {
    throw invalidPort();
  }
  if (diagnosticPath !== value.path) throw invalidPort();
  return Object.freeze({
    level: value.level,
    path: diagnosticPath,
    message: value.message,
    ...(value.line === undefined ? {} : { line: value.line as number }),
    ...(value.column === undefined ? {} : { column: value.column as number }),
  });
}

function compareDiagnostics(
  left: PlanningArchiveProjectionDiagnostic,
  right: PlanningArchiveProjectionDiagnostic,
): number {
  return (
    compareText(left.path, right.path) ||
    (left.line ?? 0) - (right.line ?? 0) ||
    (left.column ?? 0) - (right.column ?? 0) ||
    compareText(left.level, right.level) ||
    compareText(left.message, right.message)
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  optional = false,
): boolean {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (optional) {
    return observed.every((key) => expected.includes(key));
  }
  return (
    observed.length === expected.length &&
    observed.every((key, index) => key === expected[index])
  );
}

function isCanonicalAbsolutePath(value: string): boolean {
  return (
    value.length > 1 &&
    path.isAbsolute(value) &&
    path.resolve(value) === value &&
    !value.includes('\0')
  );
}

function isSafeArchiveName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value !== '.' &&
    value !== '..' &&
    value === value.normalize('NFC') &&
    !value.includes('/') &&
    !value.includes('\\') &&
    ![...value].some((character) => character.codePointAt(0)! <= 31)
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidPort(): PlanningArchiveProjectionPortContractError {
  return new PlanningArchiveProjectionPortContractError();
}
