/**
 * Dispatches conformance vector and authority-remap commands.
 *
 * Invariants:
 * - Remap input must be a bounded plain JSON file.
 */
import fs from 'node:fs';
import path from 'node:path';

import { type CommandResult, usage } from './cli-input.ts';

import type * as RepositoryInspection from '../../runtime/repository-transaction/git.ts';
import type * as ConformanceCorpus from '../../runtime/repository-transaction/conformance-vectors.ts';
import type {
  AuthorityRemapPair,
  AuthorityRemapProjector,
} from '../../modules/authority/authority-remap-contract.ts';
export type BoundaryCommandOperations = Pick<
  typeof ConformanceCorpus,
  'loadWorkflowConformanceVectorsV2'
> &
  Readonly<{
    discoverRepository: (
      ...args: Parameters<typeof RepositoryInspection.discoverRepository>
    ) => Pick<
      ReturnType<typeof RepositoryInspection.discoverRepository>,
      'repositoryRoot'
    >;
    projectAuthorityRemap: AuthorityRemapProjector;
  }>;

type AuthorityRemapCliInput = Readonly<{
  schemaVersion: 1;
  kind: 'workflow.authority-remap-request.v1';
  baseCommit: string;
  moveCommit: string;
  materializationCommit: string | null;
  renamePairs: readonly AuthorityRemapPair[];
  authorityPlan: Readonly<{
    changeId: string;
    taskId: string;
    profileId: string;
    reason: string;
    message: string;
  }>;
}>;
function readAuthorityRemapInput(
  cwd: string,
  inputPath: string,
): AuthorityRemapCliInput {
  const resolved = path.resolve(cwd, inputPath);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (
    stat === undefined ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size === 0 ||
    stat.size > 1024 * 1024
  ) {
    throw usage('Authority remap input must be a bounded plain JSON file.');
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown;
  } catch {
    throw usage('Authority remap input must be valid JSON.');
  }
  const isObject = (candidate: unknown): candidate is Record<string, unknown> =>
    typeof candidate === 'object' &&
    candidate !== null &&
    !Array.isArray(candidate);
  const hasStringFields = (
    candidate: unknown,
    fields: readonly string[],
  ): candidate is Record<string, string> =>
    isObject(candidate) &&
    fields.every((field) => typeof candidate[field] === 'string');
  if (
    !isObject(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== 'workflow.authority-remap-request.v1' ||
    typeof value.baseCommit !== 'string' ||
    typeof value.moveCommit !== 'string' ||
    (value.materializationCommit !== null &&
      typeof value.materializationCommit !== 'string') ||
    !Array.isArray(value.renamePairs) ||
    value.renamePairs.some(
      (pair) =>
        !isObject(pair) ||
        typeof pair.from !== 'string' ||
        typeof pair.to !== 'string',
    ) ||
    !hasStringFields(value.authorityPlan, [
      'changeId',
      'taskId',
      'profileId',
      'reason',
      'message',
    ])
  ) {
    throw usage('Authority remap input has an unsupported shape.');
  }
  return value as AuthorityRemapCliInput;
}

export function createBoundaryCommand(operations: BoundaryCommandOperations) {
  const {
    discoverRepository,
    projectAuthorityRemap,
    loadWorkflowConformanceVectorsV2,
  } = operations;
  function dispatchBoundaryCommand(rest: string[], cwd: string): CommandResult {
    const command = 'boundary';
    const [subcommand, ...options] = rest;
    if (subcommand === 'remap') {
      if (
        options.length !== 2 ||
        options[0] !== '--input' ||
        options[1] === undefined
      ) {
        throw usage(
          'Usage: pnpm workflow boundary remap --input <request.json> [--json]',
        );
      }
      const repositoryRoot = discoverRepository(cwd).repositoryRoot;
      const input = readAuthorityRemapInput(cwd, options[1]);
      return {
        command,
        ok: true,
        result: projectAuthorityRemap({
          repositoryRoot,
          baseCommit: input.baseCommit,
          moveCommit: input.moveCommit,
          ...(input.materializationCommit === null
            ? {}
            : { materializationCommit: input.materializationCommit }),
          renamePairs: input.renamePairs,
          authorityPlan: input.authorityPlan,
        }),
      };
    }
    if (
      subcommand !== 'vectors' ||
      (options.length !== 0 &&
        !(options.length === 1 && options[0] === '--check'))
    ) {
      throw usage(
        'Usage: pnpm workflow boundary vectors [--check] [--json]\n       pnpm workflow boundary remap --input <request.json> [--json]',
      );
    }
    const vectors = loadWorkflowConformanceVectorsV2();
    return {
      command,
      ok: true,
      result: {
        kind: 'jigwright.conformance-vectors-check.v1',
        status: 'current',
        domainCount: Object.keys(vectors.domains).length,
        vectorSetDigest: vectors.vectorSetDigest,
      },
    };
  }
  return dispatchBoundaryCommand;
}
