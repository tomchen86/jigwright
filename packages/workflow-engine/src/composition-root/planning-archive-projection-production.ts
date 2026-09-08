import { createColocatedOpenSpecViewDependencies } from './openspec-adapter-production.ts';
import { readSystemDescriptionSnapshot } from '../runtime/repository-transaction/system-description-snapshot.ts';
import path from 'node:path';

import { parseOpenSpecValidationPayloadV1 } from '@jigwright/openspec-adapter/validation-payload';

import {
  type PlanningArchiveProjectedSpecValidation,
  type PlanningArchiveProjection,
  type PlanningArchiveProjectionContext,
  type PlanningArchiveProjectionDiagnostic,
  type PlanningArchiveProjectionPort,
  type PlanningArchiveReadiness,
  type PlanningArchiveTotals,
} from '../modules/planning-provider/planning-archive-projection-port.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import {
  createOpenSpecProcess,
  resolveOpenSpecInstallation,
  type OpenSpecInstallation,
  type OpenSpecProcess,
} from '../adapters/planning/openspec/documents/openspec-executor.ts';
import {
  parseSchemaResolution,
  parseSchemaValidation,
  parseStatus,
  parseValidation,
} from '../adapters/planning/openspec/documents/openspec-payloads.ts';
import { inspectOpenSpecSchemaContract } from '../adapters/planning/openspec/documents/openspec-schema-contract.ts';
import {
  prepareColocatedArchiveView,
  withColocatedOpenSpecView,
} from '../adapters/planning/openspec/documents/colocated-openspec-view.ts';

const OPENSPEC_PROVIDER_ID = 'openspec' as const;
const OPENSPEC_ARCHIVE_PROJECTION_CONTRACT_VERSION = 1 as const;

/**
 * The only production composition point that understands the pinned OpenSpec
 * executor and payloads for archive projection. It receives a caller-owned
 * disposable root and never creates worktrees, applies a patch, or touches a
 * ref.
 */
export function createOpenSpecPlanningArchiveProjectionPort(): PlanningArchiveProjectionPort {
  return Object.freeze({
    id: OPENSPEC_PROVIDER_ID,
    contractVersion: OPENSPEC_ARCHIVE_PROJECTION_CONTRACT_VERSION,
    inspectArchiveReadiness(context: PlanningArchiveProjectionContext) {
      const { installation, openspec } =
        context.mode === 'replay'
          ? openSpecArchiveProcess(context)
          : {
              installation: resolveOpenSpecInstallation(context.repositoryRoot),
            };
      const ready =
        context.mode === 'replay'
          ? inspectArchiveReplayReadiness(context, openspec!)
          : true;
      return Object.freeze({
        providerId: OPENSPEC_PROVIDER_ID,
        adapterContractVersion: OPENSPEC_ARCHIVE_PROJECTION_CONTRACT_VERSION,
        providerVersion: installation.version,
        ready,
        diagnostics: ready
          ? Object.freeze([])
          : Object.freeze([
              {
                level: 'ERROR' as const,
                path: `${context.planningProvider.binding.planningRoot}/.openspec.yaml`,
                message:
                  'The bound planning provider rejected immutable archive replay inputs.',
              },
            ]),
      }) satisfies PlanningArchiveReadiness;
    },
    prepareArchive(context: PlanningArchiveProjectionContext) {
      return withColocatedOpenSpecView(
        context.projectionRoot,
        (view) => {
          const publish = prepareColocatedArchiveView(
            context.projectionRoot,
            view,
            context.planningProvider.binding.planningRoot,
          );
          const nativeContext = { ...context, projectionRoot: view.root };
          const { installation, openspec } = openSpecArchiveProcess(context);
          const native =
            view.root === context.projectionRoot
              ? openspec
              : createOpenSpecProcess(installation, {
                  executionRoot: view.root,
                });
          const projection = parseArchiveProjection(
            native.archive(context.changeId),
            nativeContext,
            installation.version,
          );
          publish(projection.archivePath);
          return projection;
        },
        createColocatedOpenSpecViewDependencies(),
      );
    },
    validateProjectedSpecs(context: PlanningArchiveProjectionContext) {
      return withColocatedOpenSpecView(
        context.projectionRoot,
        (view) => {
          const { installation, openspec } = openSpecArchiveProcess(context);
          const native =
            view.root === context.projectionRoot
              ? openspec
              : createOpenSpecProcess(installation, {
                  executionRoot: view.root,
                });
          return parseProjectedSpecValidation(
            native.validateAllSpecs(),
            { ...context, projectionRoot: view.root },
            installation.version,
          );
        },
        createColocatedOpenSpecViewDependencies(),
      );
    },
  });
}

export function createArchiveProjectionDependencies() {
  return {
    archiveProjectionPort: createOpenSpecPlanningArchiveProjectionPort(),
    readSystemDescriptionSnapshot,
  };
}

function inspectArchiveReplayReadiness(
  context: PlanningArchiveProjectionContext,
  openspec: OpenSpecProcess,
): boolean {
  openspec.version();
  const schema = inspectOpenSpecSchemaContract(context.repositoryRoot);
  for (const expected of [
    {
      name: 'spec-driven',
      source: 'package' as const,
      path: schema.packageSchema.directory,
    },
    {
      name: schema.currentSchema.name,
      source: 'project' as const,
      path: path.join(
        context.projectionRoot,
        'openspec/schemas',
        schema.currentSchema.name,
      ),
    },
  ]) {
    parseSchemaResolution(openspec.whichSchema(expected.name).value, expected);
    const validation = parseSchemaValidation(
      openspec.validateSchema(expected.name).value,
      expected,
    );
    if (!validation.valid) return false;
  }
  const status = parseStatus(
    openspec.status(context.changeId, schema.currentSchema.name).value,
    {
      repositoryRoot: context.projectionRoot,
      changeId: context.changeId,
      schemaName: schema.currentSchema.name,
      currentSchemaName: schema.currentSchema.name,
    },
  );
  const executed = openspec.validateChange(context.changeId);
  const validation = parseValidation(executed.value, {
    repositoryRoot: context.projectionRoot,
    expectedType: 'change',
    expectedId: context.changeId,
  });
  return executed.status === 0 && status.isComplete && validation.valid;
}

function openSpecArchiveProcess(context: PlanningArchiveProjectionContext): {
  installation: OpenSpecInstallation;
  openspec: OpenSpecProcess;
} {
  const installation = resolveOpenSpecInstallation(context.repositoryRoot);
  return {
    installation,
    openspec: createOpenSpecProcess(installation, {
      executionRoot: context.projectionRoot,
    }),
  };
}

function parseArchiveProjection(
  executed: { value: unknown; status: number },
  context: PlanningArchiveProjectionContext,
  providerVersion: string,
): PlanningArchiveProjection {
  const value = executed.value;
  if (
    executed.status !== 0 ||
    !isRecord(value) ||
    !hasExactKeys(value, ['archive', 'root']) ||
    !isRecord(value.root) ||
    !hasExactKeys(value.root, ['path', 'source']) ||
    value.root.path !== context.projectionRoot ||
    value.root.source !== 'nearest' ||
    !isRecord(value.archive) ||
    !hasArchiveKeys(value.archive) ||
    value.archive.change !== context.changeId ||
    typeof value.archive.archivedAs !== 'string' ||
    typeof value.archive.path !== 'string' ||
    path.basename(value.archive.path) !== value.archive.archivedAs ||
    path.normalize(value.archive.path) !== value.archive.path ||
    !value.archive.path.startsWith(`${context.projectionRoot}${path.sep}`) ||
    typeof value.archive.specsUpdated !== 'boolean'
  ) {
    throw invalidArchivePayload();
  }
  const archivePath = path.relative(context.projectionRoot, value.archive.path);
  if (
    archivePath.length === 0 ||
    archivePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(archivePath)
  ) {
    throw invalidArchivePayload();
  }
  const totals =
    value.archive.totals === undefined
      ? undefined
      : parseTotals(value.archive.totals);
  return Object.freeze({
    providerId: OPENSPEC_PROVIDER_ID,
    adapterContractVersion: OPENSPEC_ARCHIVE_PROJECTION_CONTRACT_VERSION,
    providerVersion,
    archiveName: value.archive.archivedAs,
    archivePath: archivePath.split(path.sep).join('/'),
    specsUpdated: value.archive.specsUpdated,
    ...(totals === undefined ? {} : { totals }),
  });
}

function parseProjectedSpecValidation(
  executed: { value: unknown; status: number },
  context: PlanningArchiveProjectionContext,
  providerVersion: string,
): PlanningArchiveProjectedSpecValidation {
  const validation = parseOpenSpecValidationPayloadV1(
    executed.value,
    {
      repositoryRoot: context.projectionRoot,
      expectedType: 'spec',
    },
    invalidOpenSpecPayload,
  );
  if (executed.status !== 0 && validation.valid) {
    throw invalidOpenSpecPayload();
  }
  const diagnostics = Object.freeze(
    validation.items
      .flatMap(({ issues }) => issues)
      .map((issue) => ({
        level: issue.level as PlanningArchiveProjectionDiagnostic['level'],
        path: issue.path as string,
        message: issue.message as string,
        ...(typeof issue.line === 'number' ? { line: issue.line } : {}),
        ...(typeof issue.column === 'number' ? { column: issue.column } : {}),
      }))
      .sort(compareDiagnostics),
  );
  return Object.freeze({
    providerId: OPENSPEC_PROVIDER_ID,
    adapterContractVersion: OPENSPEC_ARCHIVE_PROJECTION_CONTRACT_VERSION,
    providerVersion,
    valid: executed.status === 0 && validation.valid,
    diagnostics,
  });
}

function parseTotals(value: unknown): PlanningArchiveTotals {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['added', 'modified', 'removed', 'renamed']) ||
    !Object.values(value).every(
      (count) => Number.isSafeInteger(count) && Number(count) >= 0,
    )
  ) {
    throw invalidArchivePayload();
  }
  return Object.freeze({
    added: value.added as number,
    modified: value.modified as number,
    removed: value.removed as number,
    renamed: value.renamed as number,
  });
}

function hasArchiveKeys(value: Record<string, unknown>): boolean {
  const required = ['archivedAs', 'change', 'path', 'specsUpdated'];
  return (
    hasExactKeys(value, required) ||
    hasExactKeys(value, [...required, 'totals'])
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return (
    actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function invalidArchivePayload(): never {
  throw workflowError(
    'OPENSPEC_ARCHIVE_PAYLOAD_INVALID',
    'OpenSpec archive returned a payload that does not match the pinned operation contract.',
    ExitCode.unsafeEnvironment,
  );
}

function invalidOpenSpecPayload(): Error {
  return workflowError(
    'OPENSPEC_PAYLOAD_INVALID',
    'OpenSpec returned a payload that does not match the pinned operation contract.',
    ExitCode.unsafeEnvironment,
  );
}
