/**
 * Adapts pinned OpenSpec operations into validated repository planning
 * results.
 *
 * Invariants:
 * - Validation exit status must agree with the validity reported by the
 *   result payload.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';
import {
  createOpenSpecProcess,
  resolveOpenSpecInstallation,
  type OpenSpecInstallation,
} from './openspec-executor.ts';
import { assertChangeId } from '../../../../foundation/repository-path/repository-path.ts';
import { loadRepositoryConsumerConfiguration } from '../../../../runtime/repository-observation/repository-consumer.ts';
import { parseDoctor, type OpenSpecDoctor } from './openspec-doctor-payload.ts';
import {
  parseChangeList,
  parseInstructions,
  parseSchemaResolution,
  parseSchemaValidation,
  parseStatus,
  parseValidation,
  type OpenSpecChangeList,
  type OpenSpecInstructions,
  type OpenSpecSchemaResolution,
  type OpenSpecSchemaValidation,
  type OpenSpecStatus,
  type OpenSpecValidation,
} from './openspec-payloads.ts';
import {
  withColocatedOpenSpecView,
  type ColocatedOpenSpecViewDependencies,
} from './colocated-openspec-view.ts';

export { resolveOpenSpecInstallation };
export type { OpenSpecInstallation };

export type OpenSpecAdapterOptions = {
  environment?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
  schemaPolicy?: OpenSpecSchemaPolicy;
};

export type OpenSpecSchemaPolicy = Readonly<{
  packageSchemaNames: readonly string[];
  projectSchemaNames: readonly string[];
  supportedSchemaNames: readonly string[];
  currentSchemaName?: string;
}>;

export type OpenSpecAdapter = {
  version(): '1.6.0';
  doctor(): OpenSpecDoctor;
  listChanges(): OpenSpecChangeList;
  whichSchema(name: string): OpenSpecSchemaResolution;
  validateSchema(name: string): OpenSpecSchemaValidation;
  status(changeId: string, schemaName: string): OpenSpecStatus;
  instructions(
    changeId: string,
    schemaName: string,
    artifactId: string,
  ): OpenSpecInstructions;
  validateChange(changeId: string): OpenSpecValidation;
  validateAllSpecs(): OpenSpecValidation;
};

export function createOpenSpecAdapter(
  repositoryRoot: string,
  options: OpenSpecAdapterOptions,
  colocatedView: ColocatedOpenSpecViewDependencies,
): OpenSpecAdapter {
  const installation = resolveOpenSpecInstallation(repositoryRoot);
  const openspec = createOpenSpecProcess(installation, options);
  const repositoryPolicy =
    options.schemaPolicy === undefined
      ? loadRepositoryConsumerConfiguration(installation.repositoryRoot)
          .configuration.planning
      : undefined;
  const schemaPolicy = validateSchemaPolicy(
    options.schemaPolicy ?? {
      packageSchemaNames: repositoryPolicy!.packageSchemaNames,
      projectSchemaNames: repositoryPolicy!.managedSchemaNames,
      supportedSchemaNames: repositoryPolicy!.supportedSchemaNames,
      currentSchemaName: repositoryPolicy!.currentSchemaName,
    },
  );
  openspec.version();

  return {
    version: () => openspec.version(),
    doctor: () => {
      const executed = openspec.doctor();
      return parseDoctor(
        executed.value,
        installation.repositoryRoot,
        executed.status,
      );
    },
    listChanges: () => {
      const changesDirectory = path.join(
        installation.repositoryRoot,
        'openspec/changes',
      );
      return withCanonicalDirectory(
        installation.repositoryRoot,
        changesDirectory,
        () =>
          parseChangeList(
            openspec.listChanges().value,
            installation.repositoryRoot,
          ),
      );
    },
    whichSchema: (name) => {
      const schema = schemaExpectation(installation, schemaPolicy, name);
      const resolution = parseSchemaResolution(
        openspec.whichSchema(schema.name).value,
        schema,
      );
      assertOpenSpecSchemaDirectory(installation, schema);
      return resolution;
    },
    validateSchema: (name) => {
      const schema = schemaExpectation(installation, schemaPolicy, name);
      const validation = parseSchemaValidation(
        openspec.validateSchema(schema.name).value,
        schema,
      );
      assertOpenSpecSchemaDirectory(installation, schema);
      if (!validation.valid) {
        throw workflowError(
          'OPENSPEC_SCHEMA_INVALID',
          'OpenSpec did not validate the managed schema.',
          ExitCode.verification,
          { details: { schemaName: schema.name } },
        );
      }
      return validation;
    },
    status: (changeId, schemaName) => {
      const change = assertChangeId(changeId);
      const schema = safeName(schemaName);
      return withChangeDirectory(installation.repositoryRoot, change, () =>
        parseStatus(openspec.status(change, schema).value, {
          repositoryRoot: installation.repositoryRoot,
          changeId: change,
          schemaName: schema,
          currentSchemaName: schemaPolicy.currentSchemaName,
        }),
      );
    },
    instructions: (changeId, schemaName, artifactId) => {
      const change = assertChangeId(changeId);
      const schema = safeName(schemaName);
      const artifact = safeName(artifactId);
      return withChangeDirectory(installation.repositoryRoot, change, () =>
        parseInstructions(
          openspec.instructions(change, schema, artifact).value,
          {
            repositoryRoot: installation.repositoryRoot,
            changeId: change,
            schemaName: schema,
            artifactId: artifact,
            currentSchemaName: schemaPolicy.currentSchemaName,
          },
        ),
      );
    },
    validateChange: (changeId) => {
      const change = assertChangeId(changeId);
      return withChangeDirectory(installation.repositoryRoot, change, () => {
        const executed = openspec.validateChange(change);
        const validation = parseValidation(executed.value, {
          repositoryRoot: installation.repositoryRoot,
          expectedType: 'change',
          expectedId: change,
        });
        assertValidationExit(executed.status, validation.valid);
        return validation;
      });
    },
    validateAllSpecs: () => {
      return withColocatedOpenSpecView(
        installation.repositoryRoot,
        (view) => {
          const specsDirectory = path.join(view.root, 'openspec/specs');
          return withCanonicalDirectory(view.root, specsDirectory, () => {
            const native =
              view.root === installation.repositoryRoot
                ? openspec
                : createOpenSpecProcess(installation, {
                    ...options,
                    executionRoot: view.root,
                  });
            const executed = native.validateAllSpecs();
            const validation = parseValidation(executed.value, {
              repositoryRoot: view.root,
              expectedType: 'spec',
            });
            assertValidationExit(executed.status, validation.valid);
            return {
              ...validation,
              root: { ...validation.root, path: installation.repositoryRoot },
            };
          });
        },
        colocatedView,
      );
    },
  };
}

function schemaExpectation(
  installation: OpenSpecInstallation,
  policy: OpenSpecSchemaPolicy,
  requestedName: string,
): { name: string; source: 'package' | 'project'; path: string } {
  const name = safeName(requestedName);
  if (!policy.supportedSchemaNames.includes(name)) {
    throw workflowError(
      'OPENSPEC_SCHEMA_UNSUPPORTED',
      'Only the pinned package schema and reviewed project schema are managed.',
      ExitCode.guard,
    );
  }
  const expected = policy.packageSchemaNames.includes(name)
    ? {
        name,
        source: 'package' as const,
        path: path.join(installation.packageDirectory, 'schemas', name),
      }
    : {
        name,
        source: 'project' as const,
        path: path.join(installation.repositoryRoot, 'openspec/schemas', name),
      };
  assertOpenSpecSchemaDirectory(installation, expected);
  return expected;
}

function validateSchemaPolicy(
  policy: OpenSpecSchemaPolicy,
): OpenSpecSchemaPolicy {
  const supported = new Set(policy.supportedSchemaNames);
  const packageNames = new Set(policy.packageSchemaNames);
  if (
    supported.size === 0 ||
    supported.size !== policy.supportedSchemaNames.length ||
    packageNames.size !== policy.packageSchemaNames.length ||
    new Set(policy.projectSchemaNames).size !==
      policy.projectSchemaNames.length ||
    [...supported].some((name) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) ||
    [...packageNames].some((name) => !supported.has(name)) ||
    policy.projectSchemaNames.some(
      (name) => !supported.has(name) || packageNames.has(name),
    ) ||
    (policy.currentSchemaName !== undefined &&
      !supported.has(policy.currentSchemaName)) ||
    packageNames.size + policy.projectSchemaNames.length !== supported.size
  ) {
    throw workflowError(
      'OPENSPEC_SCHEMA_POLICY_INVALID',
      'OpenSpec schema selection policy is invalid.',
      ExitCode.guard,
    );
  }
  return Object.freeze({
    packageSchemaNames: Object.freeze([...policy.packageSchemaNames]),
    projectSchemaNames: Object.freeze([...policy.projectSchemaNames]),
    supportedSchemaNames: Object.freeze([...policy.supportedSchemaNames]),
    ...(policy.currentSchemaName === undefined
      ? {}
      : { currentSchemaName: policy.currentSchemaName }),
  });
}

export function assertOpenSpecSchemaDirectory(
  installation: OpenSpecInstallation,
  expected: { source: 'package' | 'project'; path: string },
): void {
  assertCanonicalDirectory(
    expected.source === 'package'
      ? installation.packageDirectory
      : installation.repositoryRoot,
    expected.path,
  );
}

function withChangeDirectory<T>(
  repositoryRoot: string,
  changeId: string,
  operation: () => T,
): T {
  return withCanonicalDirectory(
    repositoryRoot,
    path.join(repositoryRoot, 'openspec/changes', changeId),
    operation,
  );
}

function withCanonicalDirectory<T>(
  root: string,
  directory: string,
  operation: () => T,
): T {
  assertCanonicalDirectory(root, directory);
  const result = operation();
  assertCanonicalDirectory(root, directory);
  return result;
}

function assertCanonicalDirectory(root: string, directory: string): void {
  try {
    const canonicalRoot = fs.realpathSync(root);
    const absoluteDirectory = path.resolve(directory);
    const stats = fs.lstatSync(absoluteDirectory);
    const canonicalDirectory = fs.realpathSync(absoluteDirectory);
    const relative = path.relative(canonicalRoot, canonicalDirectory);
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      canonicalDirectory !== absoluteDirectory ||
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error('unsafe OpenSpec directory');
    }
  } catch {
    throw workflowError(
      'OPENSPEC_PATH_UNSAFE',
      'An OpenSpec operation target is not a canonical repository directory.',
      ExitCode.unsafeEnvironment,
    );
  }
}

function safeName(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    throw workflowError(
      'OPENSPEC_IDENTIFIER_INVALID',
      'OpenSpec operation contains an invalid identifier.',
      ExitCode.usage,
    );
  }
  return value;
}

function assertValidationExit(status: number, valid: boolean): void {
  if ((valid && status !== 0) || (!valid && status !== 1)) {
    throw workflowError(
      'OPENSPEC_PAYLOAD_INVALID',
      'OpenSpec validation exit status contradicts its result payload.',
      ExitCode.unsafeEnvironment,
    );
  }
}
