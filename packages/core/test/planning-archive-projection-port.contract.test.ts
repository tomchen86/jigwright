import assert from 'node:assert/strict';
import test from 'node:test';

import {
  inspectPlanningArchiveReadiness,
  PlanningArchiveProjectionPortContractError,
  preparePlanningArchiveProjection,
  validatePlanningArchiveProjectedSpecs,
  type PlanningArchiveProjectionContext,
  type PlanningArchiveProjectionPort,
} from '../src/planning-archive-projection-port.ts';
import {
  planningProviderBindingDigest,
  planningProviderBindingPath,
} from '../src/planning-provider-binding.ts';

const binding = {
  schemaVersion: 1 as const,
  changeId: 'demo-change',
  providerId: 'fixture-provider',
  adapterContractVersion: 7,
  providerRequirement: {
    package: '@fixture/planning-provider',
    version: '7.0.0',
  },
  planningRoot: 'fixture/changes/demo-change',
};

const context: PlanningArchiveProjectionContext = {
  repositoryRoot: '/fixture/repository',
  projectionRoot: '/fixture/projection',
  sourceRevision: 'a'.repeat(40),
  changeId: 'demo-change',
  mode: 'projection',
  planningProvider: {
    binding,
    source: 'explicit',
    artifactPath: planningProviderBindingPath(binding.changeId),
    bindingDigest: planningProviderBindingDigest(binding),
  },
};

const port: PlanningArchiveProjectionPort = {
  id: binding.providerId,
  contractVersion: binding.adapterContractVersion,
  inspectArchiveReadiness: () => ({
    providerId: binding.providerId,
    adapterContractVersion: binding.adapterContractVersion,
    providerVersion: binding.providerRequirement.version,
    ready: true,
    diagnostics: [],
  }),
  prepareArchive: () => ({
    providerId: binding.providerId,
    adapterContractVersion: binding.adapterContractVersion,
    providerVersion: binding.providerRequirement.version,
    archiveName: '2026-09-02-demo-change',
    archivePath: 'fixture/changes/archive/2026-09-02-demo-change',
    specsUpdated: true,
    totals: { added: 1, modified: 2, removed: 3, renamed: 4 },
  }),
  validateProjectedSpecs: () => ({
    providerId: binding.providerId,
    adapterContractVersion: binding.adapterContractVersion,
    providerVersion: binding.providerRequirement.version,
    valid: false,
    diagnostics: [
      {
        level: 'ERROR' as const,
        path: 'fixture/specs/demo/spec.md',
        message: 'Fixture specification is invalid.',
      },
    ],
  }),
};

test('planning archive projection port binds every operation to one exact provider binding and disposable root', () => {
  assert.deepEqual(inspectPlanningArchiveReadiness(port, context), {
    providerId: binding.providerId,
    adapterContractVersion: binding.adapterContractVersion,
    providerVersion: binding.providerRequirement.version,
    ready: true,
    diagnostics: [],
  });
  assert.deepEqual(preparePlanningArchiveProjection(port, context), {
    providerId: binding.providerId,
    adapterContractVersion: binding.adapterContractVersion,
    providerVersion: binding.providerRequirement.version,
    archiveName: '2026-09-02-demo-change',
    archivePath: 'fixture/changes/archive/2026-09-02-demo-change',
    specsUpdated: true,
    totals: { added: 1, modified: 2, removed: 3, renamed: 4 },
  });
  assert.deepEqual(validatePlanningArchiveProjectedSpecs(port, context), {
    providerId: binding.providerId,
    adapterContractVersion: binding.adapterContractVersion,
    providerVersion: binding.providerRequirement.version,
    valid: false,
    diagnostics: [
      {
        level: 'ERROR',
        path: 'fixture/specs/demo/spec.md',
        message: 'Fixture specification is invalid.',
      },
    ],
  });
});

test('planning archive projection port rejects forged bindings, port authority, and malformed provider results', () => {
  assert.throws(
    () =>
      preparePlanningArchiveProjection(port, {
        ...context,
        planningProvider: {
          ...context.planningProvider,
          bindingDigest: '0'.repeat(64),
        },
      }),
    invalid,
  );
  assert.throws(
    () =>
      preparePlanningArchiveProjection(port, {
        ...context,
        mode: 'unbound' as never,
      }),
    invalid,
  );
  assert.throws(
    () =>
      preparePlanningArchiveProjection(port, {
        ...context,
        projectionRoot: context.repositoryRoot,
      }),
    invalid,
  );
  assert.throws(
    () =>
      preparePlanningArchiveProjection(
        { ...port, commit: () => undefined } as never,
        context,
      ),
    invalid,
  );
  assert.throws(
    () =>
      preparePlanningArchiveProjection(
        {
          ...port,
          prepareArchive: () => ({
            ...port.prepareArchive(context),
            providerVersion: 'forged-version',
          }),
        },
        context,
      ),
    invalid,
  );
  assert.throws(
    () =>
      preparePlanningArchiveProjection(
        {
          ...port,
          prepareArchive: () => ({
            ...port.prepareArchive(context),
            providerId: 'forged-provider',
          }),
        },
        context,
      ),
    invalid,
  );
  assert.throws(
    () =>
      validatePlanningArchiveProjectedSpecs(
        {
          ...port,
          validateProjectedSpecs: () => ({
            ...port.validateProjectedSpecs(context),
            valid: true,
          }),
        },
        context,
      ),
    invalid,
  );
});

function invalid(error: unknown): boolean {
  return error instanceof PlanningArchiveProjectionPortContractError;
}
