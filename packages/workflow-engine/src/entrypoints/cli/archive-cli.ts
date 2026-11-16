/**
 * Parses and dispatches managed archive and archive publication commands.
 *
 * Invariants:
 * - Archive publication options must be recognized, paired, and unique.
 */
import { loadStableValidatedChangeContract } from '../../composition-root/validated-contract-context.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  commitArchiveTransition,
  preparePostMergeArchivePullRequest,
} from '../../composition-root/archive-cli-production.ts';
import { discoverArchivePullRequestCandidates } from '../../composition-root/cli-command-services.ts';
import type { GitHubArchiveAdapterModuleV1 } from '../../composition-root/cli-command-services.ts';

import type { GitHubArchiveAdapterConfigV1 } from '@jigwright/github-adapter';
import {
  workflowError,
  ExitCode,
  WorkflowError,
} from '../../foundation/errors/errors.ts';
import { type ArchivePullRequestCliDependencies } from '../../composition-root/archive-cli-production.ts';
import {
  type CommandResult,
  shellCommandArgument,
  usage,
  requireArgumentCount,
  usageText,
} from './cli-input.ts';

export async function dispatchArchivePullRequest(
  args: string[],
  cwd: string,
  dependencies: ArchivePullRequestCliDependencies,
): Promise<CommandResult> {
  const [, action, ...rest] = args;
  if (action === 'doctor') {
    if (rest.length !== 2 || rest[0] !== '--base') {
      throw archivePullRequestUsage();
    }
    return {
      command: 'archive-pr',
      action,
      ok: true,
      result: dependencies.discover(
        loadStableValidatedChangeContract,
        cwd,
        rest[1]!,
      ),
    };
  }
  if (action === 'status') {
    if (rest.length !== 1) throw archivePullRequestUsage();
    return {
      command: 'archive-pr',
      action,
      ok: true,
      result: dependencies.inspect(cwd, rest[0]!),
    };
  }
  if (action === 'dry-run') {
    const parsed = parseArchivePullRequestCliOptions(
      'archive-pr dry-run',
      rest,
      {
        requireConfig: false,
        requireGrant: false,
      },
    );
    const local = dependencies.prepare(cwd, parsed.changeId, {
      ...(parsed.workspaceParent === undefined
        ? {}
        : { workspaceParent: parsed.workspaceParent }),
    });
    return {
      command: 'archive-pr',
      action,
      ok: true,
      result: {
        schemaVersion: 1,
        kind: 'archive-pr-dry-run.v1',
        remoteState: 'not-observed',
        operationalGate: 'pending',
        local,
      },
    };
  }
  if (action !== 'prepare' && action !== 'open') {
    throw archivePullRequestUsage();
  }
  const parsed = parseArchivePullRequestCliOptions(
    `archive-pr ${action}`,
    rest,
    {
      requireConfig: true,
      requireGrant: action === 'open',
    },
  );
  const configValue = readArchivePullRequestJson(
    cwd,
    parsed.configPath!,
    'ARCHIVE_PR_GITHUB_CONFIG_INVALID',
  );
  let adapter: GitHubArchiveAdapterModuleV1;
  try {
    adapter = await dependencies.loadAdapter();
  } catch {
    throw workflowError(
      'ARCHIVE_PR_GITHUB_ADAPTER_UNAVAILABLE',
      'Remote archive request preparation requires the optional @jigwright/github-adapter package.',
      ExitCode.unsafeEnvironment,
    );
  }
  let config: GitHubArchiveAdapterConfigV1;
  try {
    config = adapter.parseGitHubArchiveAdapterConfig(configValue);
  } catch {
    throw workflowError(
      'ARCHIVE_PR_GITHUB_CONFIG_INVALID',
      'Remote archive publication configuration is invalid or contains forbidden credential material.',
      ExitCode.guard,
    );
  }
  const publicationTarget = dependencies.resolvePublicationTarget(cwd, config);
  const local = dependencies.prepare(cwd, parsed.changeId, {
    ...(parsed.workspaceParent === undefined
      ? {}
      : { workspaceParent: parsed.workspaceParent }),
  });
  if (action === 'prepare') {
    const grant = await dependencies.requestGrant(
      cwd,
      local.preparation.preparationIdentity,
      config,
      'Authorize only this exact immutable archive preparation for create-only branch publication and one idempotent pull-request opening; preserve adapter, configuration, ruleset, credential, stale-state, and collision checks.',
    );
    return {
      command: 'archive-pr',
      action,
      ok: true,
      result: {
        schemaVersion: 1,
        kind: 'workflow-fail-grant-required.v1',
        changeId: parsed.changeId,
        preparationIdentity: local.preparation.preparationIdentity,
        state: 'human-action-required',
        nextAction: 'human-action',
        failure: {
          code: 'ARCHIVE_PR_PUBLICATION_GRANT_REQUIRED',
          message:
            'The exact locally assured archive publication requires Human Gate authorization.',
        },
        grant,
        local,
        externalPublicationPending: true,
        inputSchema: {
          schemaVersion: 1,
          kind: 'central-grant-resolution.v1',
          inspectCommand: `pnpm workflow grant human inspect ${grant.challengeId} --json`,
          decisionCommand: `pnpm workflow grant human decide ${grant.challengeId} --json`,
          publishAfterDecision: archivePullRequestOpenCommand(
            parsed,
            grant.challengeId,
          ),
        },
      },
    };
  }
  const environment = dependencies.environment ?? process.env;
  const fetchImplementation = dependencies.fetch ?? globalThis.fetch;
  const published = await dependencies.publish(cwd, local, config, {
    environment,
    ...(fetchImplementation === undefined
      ? {}
      : { fetch: fetchImplementation }),
    loadAdapter: async () => adapter,
    grantChallengeId: parsed.grantChallengeId!,
    publicationTarget,
    rulesetObserver: dependencies.createRulesetObserver({
      config,
      environment,
      ...(fetchImplementation === undefined
        ? {}
        : { fetch: fetchImplementation }),
    }),
    branchPublisher: dependencies.createBranchPublisher(),
  });
  return {
    command: 'archive-pr',
    action,
    ok: true,
    result: published,
  };
}

export function createArchivePullRequestCliDispatcherForTesting(
  dependencies: ArchivePullRequestCliDependencies,
): (args: string[], cwd: string) => Promise<CommandResult> {
  return (args, cwd) => dispatchArchivePullRequest(args, cwd, dependencies);
}

function archivePullRequestOpenCommand(
  parsed: Readonly<{
    changeId: string;
    configPath?: string;
    workspaceParent?: string;
  }>,
  challengeId: string,
): string {
  const values = [
    'pnpm workflow archive-pr open',
    shellCommandArgument(parsed.changeId),
    '--config',
    shellCommandArgument(parsed.configPath!),
    '--grant',
    shellCommandArgument(challengeId),
    ...(parsed.workspaceParent === undefined
      ? []
      : ['--workspace-parent', shellCommandArgument(parsed.workspaceParent)]),
    '--json',
  ];
  return values.join(' ');
}

function parseArchivePullRequestCliOptions(
  command: string,
  args: string[],
  requirements: Readonly<{
    requireConfig: boolean;
    requireGrant: boolean;
  }>,
): Readonly<{
  changeId: string;
  configPath?: string;
  grantChallengeId?: string;
  workspaceParent?: string;
}> {
  const changeId = args[0];
  if (!changeId || args.length < 1 || args.length % 2 === 0) {
    throw archivePullRequestUsage(command);
  }
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (
      option === undefined ||
      value === undefined ||
      !['--config', '--grant', '--workspace-parent'].includes(option) ||
      values.has(option)
    ) {
      throw archivePullRequestUsage(command);
    }
    values.set(option, value);
  }
  const configPath = values.get('--config');
  const grantChallengeId = values.get('--grant');
  if (
    (requirements.requireConfig
      ? configPath === undefined
      : configPath !== undefined) ||
    (requirements.requireGrant
      ? grantChallengeId === undefined
      : grantChallengeId !== undefined)
  ) {
    throw archivePullRequestUsage(command);
  }
  return {
    changeId,
    ...(configPath === undefined ? {} : { configPath }),
    ...(grantChallengeId === undefined ? {} : { grantChallengeId }),
    ...(values.get('--workspace-parent') === undefined
      ? {}
      : { workspaceParent: values.get('--workspace-parent') }),
  };
}

function readArchivePullRequestJson(
  cwd: string,
  filePath: string,
  code: string,
): unknown {
  try {
    const absolute = path.resolve(cwd, filePath);
    const stats = fs.lstatSync(absolute);
    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size < 2 ||
      stats.size > 64 * 1024
    ) {
      throw new Error('invalid archive PR input file');
    }
    return JSON.parse(fs.readFileSync(absolute, 'utf8')) as unknown;
  } catch {
    throw workflowError(
      code,
      'Archive pull request input must be one bounded readable JSON file.',
      ExitCode.guard,
    );
  }
}

function archivePullRequestUsage(command = 'archive-pr'): WorkflowError {
  return usage(
    command === 'after-merge'
      ? 'Usage: pnpm workflow after-merge <change-id> [--workspace-parent <absolute-path>] [--json]'
      : 'Usage: pnpm workflow archive-pr doctor --base <origin/protected-branch> [--json]\n       pnpm workflow archive-pr dry-run <change-id> [--workspace-parent <absolute-path>] [--json]\n       pnpm workflow archive-pr status <sha256:preparation-identity> [--json]\n       pnpm workflow archive-pr prepare <change-id> --config <github-adapter.json> [--workspace-parent <absolute-path>] [--json]\n       pnpm workflow archive-pr open <change-id> --config <github-adapter.json> --grant <challenge-id> [--workspace-parent <absolute-path>] [--json]',
  );
}

export function dispatchArchiveCommand(
  args: string[],
  cwd: string,
): CommandResult {
  const [command, ...rest] = args;
  switch (command) {
    case 'archive':
      requireArgumentCount(command, rest, 1, 1);
      return {
        command,
        ok: true,
        result: commitArchiveTransition(cwd, rest[0]),
      };
    case 'archive-candidates': {
      if (rest.length !== 2 || rest[0] !== '--base') {
        throw usage(
          'Usage: pnpm workflow archive-candidates --base <origin/protected-branch> [--json]',
        );
      }
      return {
        command,
        ok: true,
        result: discoverArchivePullRequestCandidates(
          loadStableValidatedChangeContract,
          cwd,
          rest[1]!,
        ),
      };
    }
    case 'after-merge': {
      const parsed = parseArchivePullRequestCliOptions(command, rest, {
        requireConfig: false,
        requireGrant: false,
      });
      return {
        command,
        ok: true,
        result: preparePostMergeArchivePullRequest(cwd, parsed.changeId, {
          ...(parsed.workspaceParent === undefined
            ? {}
            : { workspaceParent: parsed.workspaceParent }),
        }),
      };
    }
    default:
      throw usage(
        command ? `Unknown workflow command: ${command}` : usageText(),
      );
  }
}
