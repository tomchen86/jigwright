import fs from 'node:fs';
import path from 'node:path';

import {
  createProductionWorkflowGrantCoordinator,
  requestArchivePullRequestPublicationGrant,
  requestChangeRoutingContinuationGrant,
  requestInvestigationV3Grant,
  requestWorkRegistryPromotionGrant,
  requestWorkRegistryReviewGrant,
  type WorkItemReviewV1,
} from '../../composition-root/grant-production.ts';
import { publishProtectedBaseInitializationAfterGrant } from '../../composition-root/protected-base-initialization-production.ts';
import type {
  GrantCoordinator,
  GrantExecutionResult,
} from '../../modules/authority/grant-coordinator.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';

type HumanGrantCliDependencies = Readonly<{
  coordinator(cwd: string): GrantCoordinator;
  requestInvestigationV3(
    cwd: string,
    investigationId: string,
    proposedReason: string,
  ): Promise<unknown>;
  requestChangeRoutingContinuation(
    cwd: string,
    changeId: string,
    proposedReason: string,
  ): Promise<unknown>;
  requestWorkItemReview(
    cwd: string,
    workItemId: string,
    review: WorkItemReviewV1,
    proposedReason: string,
  ): Promise<unknown>;
  requestWorkItemPromotion(
    cwd: string,
    workItemId: string,
    changeId: string,
    expectedDigest: string,
    proposedReason: string,
  ): Promise<unknown>;
  requestArchivePullRequestPublication?(
    cwd: string,
    preparationIdentity: string,
    proposedReason: string,
  ): Promise<unknown>;
  publishProtectedBaseInitialization(
    cwd: string,
    grant: GrantExecutionResult,
  ): Promise<unknown | null> | unknown | null;
}>;

const PRODUCTION_DEPENDENCIES: HumanGrantCliDependencies = Object.freeze({
  coordinator: createProductionWorkflowGrantCoordinator,
  requestInvestigationV3: requestInvestigationV3Grant,
  requestChangeRoutingContinuation: requestChangeRoutingContinuationGrant,
  requestWorkItemReview: requestWorkRegistryReviewGrant,
  requestWorkItemPromotion: requestWorkRegistryPromotionGrant,
  requestArchivePullRequestPublication:
    requestArchivePullRequestPublicationGrant,
  publishProtectedBaseInitialization:
    publishProtectedBaseInitializationAfterGrant,
});

export function isHumanGrantCliInvocation(argv: readonly string[]): boolean {
  return argv[0] === 'grant' && argv[1] === 'human';
}

export async function dispatchHumanGrantCli(
  argv: readonly string[],
  cwd: string,
  dependencies: HumanGrantCliDependencies = PRODUCTION_DEPENDENCIES,
): Promise<Record<string, unknown>> {
  if (!isHumanGrantCliInvocation(argv)) throw humanGrantUsage();
  const action = argv[2];
  if (
    action === 'request-archive-publication' &&
    argv.length === 6 &&
    argv[4] === '--reason'
  ) {
    const request = dependencies.requestArchivePullRequestPublication;
    if (request === undefined) {
      throw workflowError(
        'ARCHIVE_PR_GRANT_CLI_UNAVAILABLE',
        'Archive publication Grant request composition is unavailable.',
        ExitCode.unsafeEnvironment,
      );
    }
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: await request(cwd, argv[3]!, argv[5]!),
    };
  }
  if (
    action === 'request-investigation-v3' &&
    argv.length === 6 &&
    argv[4] === '--reason'
  ) {
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: await dependencies.requestInvestigationV3(
        cwd,
        argv[3]!,
        argv[5]!,
      ),
    };
  }
  if (
    action === 'request-change-routing-continuation' &&
    argv.length === 6 &&
    argv[4] === '--reason'
  ) {
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: await dependencies.requestChangeRoutingContinuation(
        cwd,
        argv[3]!,
        argv[5]!,
      ),
    };
  }
  if (
    action === 'request-work-item-review' &&
    argv.length === 8 &&
    argv[4] === '--input' &&
    argv[6] === '--reason'
  ) {
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: await dependencies.requestWorkItemReview(
        cwd,
        argv[3]!,
        readWorkItemReview(cwd, argv[5]!),
        argv[7]!,
      ),
    };
  }
  if (
    action === 'request-work-item-promotion' &&
    argv.length === 10 &&
    argv[4] === '--change' &&
    argv[6] === '--expected' &&
    argv[8] === '--reason'
  ) {
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: await dependencies.requestWorkItemPromotion(
        cwd,
        argv[3]!,
        argv[5]!,
        argv[7]!,
        argv[9]!,
      ),
    };
  }
  if (action === 'inspect' && argv.length === 4) {
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: dependencies.coordinator(cwd).inspectChallenge(argv[3]!),
    };
  }
  if (action === 'decide' && argv.length === 4) {
    const grant = await dependencies
      .coordinator(cwd)
      .resolveChallenge(argv[3]!);
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: await attachProtectedBasePublication(cwd, grant, dependencies),
    };
  }
  if (action === 'recover' && argv.length === 4) {
    const grant = await dependencies
      .coordinator(cwd)
      .recoverChallenge(argv[3]!);
    return {
      command: 'grant',
      family: 'human',
      action,
      ok: true,
      result: await attachProtectedBasePublication(cwd, grant, dependencies),
    };
  }
  throw humanGrantUsage();
}

async function attachProtectedBasePublication(
  cwd: string,
  grant: GrantExecutionResult,
  dependencies: HumanGrantCliDependencies,
): Promise<GrantExecutionResult | Readonly<Record<string, unknown>>> {
  const publish = dependencies.publishProtectedBaseInitialization;
  const publication = await publish(cwd, grant);
  if (publication === null) return grant;
  return Object.freeze({
    ...grant,
    publication,
  });
}

export async function runHumanGrantCli(
  argv: readonly string[],
  cwd = process.cwd(),
): Promise<number> {
  const json = argv.at(-1) === '--json';
  const args = json ? argv.slice(0, -1) : [...argv];
  try {
    const result = await dispatchHumanGrantCli(args, cwd);
    process.stdout.write(
      json
        ? `${JSON.stringify(result)}\n`
        : `${JSON.stringify(result, null, 2)}\n`,
    );
    return 0;
  } catch (error) {
    const failure =
      error instanceof WorkflowError
        ? error
        : workflowError(
            'INTERNAL_ERROR',
            error instanceof Error ? error.message : String(error),
            ExitCode.internal,
          );
    const rendered = {
      ok: false,
      error: {
        code: failure.code,
        message: failure.message,
        ...(failure.details ? { details: failure.details } : {}),
      },
    };
    process.stderr.write(
      json
        ? `${JSON.stringify(rendered)}\n`
        : `${JSON.stringify(rendered, null, 2)}\n`,
    );
    return failure.exitCode;
  }
}

function humanGrantUsage(): WorkflowError {
  return workflowError(
    'USAGE',
    'Usage: pnpm workflow grant human <request-investigation-v3 <investigation-id> --reason <agent-proposed-reason>|request-change-routing-continuation <change-id> --reason <agent-proposed-reason>|request-work-item-review <work-item-id> --input <review.json> --reason <reason>|request-work-item-promotion <work-item-id> --change <change-id> --expected <digest> --reason <reason>|request-archive-publication <preparation-identity> --reason <reason>|inspect <challenge-id>|decide <challenge-id>|recover <challenge-id>> [--json]',
    ExitCode.usage,
  );
}

function readWorkItemReview(
  cwd: string,
  requestedPath: string,
): WorkItemReviewV1 {
  const inputPath = path.resolve(cwd, requestedPath);
  const stats = fs.lstatSync(inputPath, { throwIfNoEntry: false });
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.size > 65_536) {
    throw humanGrantUsage();
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(inputPath, 'utf8')) as unknown;
  } catch {
    throw humanGrantUsage();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw humanGrantUsage();
  }
  return value as WorkItemReviewV1;
}
