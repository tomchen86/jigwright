import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { type CommandResult, usage } from './cli-input.ts';
import { workflowError, ExitCode } from '../../foundation/errors/errors.ts';
import {
  discoverRepository,
  projectAuthorityRemap,
  loadWorkflowConformanceVectorsV2,
  inspectT3BoundaryInventory,
  type AuthorityRemapPair,
  type T3BoundaryTypeScriptApi,
} from '../../composition-root/cli-operational-services.ts';

const toolingRequire = createRequire(import.meta.url);
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
function loadT3BoundaryTypeScript(): T3BoundaryTypeScriptApi {
  try {
    return toolingRequire('typescript') as T3BoundaryTypeScriptApi;
  } catch {
    throw workflowError(
      'T3_BOUNDARY_SCANNER_UNAVAILABLE',
      'The T3 boundary inventory is a Jigwright source-repository command and requires its development TypeScript parser.',
      ExitCode.verification,
    );
  }
}
export function dispatchBoundaryCommand(
  rest: string[],
  cwd: string,
): CommandResult {
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
    (subcommand !== 'inventory' && subcommand !== 'vectors') ||
    (options.length !== 0 &&
      !(options.length === 1 && options[0] === '--check'))
  ) {
    throw usage(
      'Usage: pnpm workflow boundary <inventory|vectors> [--check] [--json]\n       pnpm workflow boundary remap --input <request.json> [--json]',
    );
  }
  if (subcommand === 'vectors') {
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
  return {
    command,
    ok: true,
    result: inspectT3BoundaryInventory({
      repositoryRoot: discoverRepository(cwd).repositoryRoot,
      check: options[0] === '--check',
      typescript: loadT3BoundaryTypeScript(),
    }),
  };
}
