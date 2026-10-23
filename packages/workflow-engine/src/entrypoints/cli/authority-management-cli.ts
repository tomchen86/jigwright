import fs from 'node:fs';
import path from 'node:path';
import { taskDiffCollaborationGrantSelection } from '../../composition-root/cli-authority-production.ts';
import type {
  ApproveAndApplyMaintainerGrantV2Request,
  AuthorityAttestationRequest,
  AuthorityPlanIntent,
  CandidateExternalEffect,
  ExternalEffectGrantRequest,
  ExternalEffectKind,
  ExternalEffectReconciliationRequest,
  ExternalEffectRollbackPlan,
  ExternalEffectTarget,
  MaintainerEvidenceWaiver,
  MaintainerGrantV2PreflightRequest,
  ReissueAndApplyMaintainerGrantV2Request,
} from '../../composition-root/cli-command-services.ts';
import {
  EXTERNAL_EFFECT_MAX_TTL_SECONDS,
  assertInteractiveSignerContext,
  assertMaintainerGrantId,
  discoverRepository,
  externalEffectStorePaths,
  inspectAuthorityPlan,
  inspectInvestigationQuarantineState,
  inspectMaintainerGrants,
  loadWorkflowConfig,
  maintainerGrantStorePaths,
  parseExecutionBudgetGrantRequest,
  parseMaintainerEvidenceWaivers,
  parseMaintainerPolicy,
  parseTaskMandateRequest,
  prepareTaskRevisionApprovalBinding,
  revokeMaintainerGrantV2,
  runtimePaths,
} from '../../composition-root/cli-command-services.ts';
import {
  executePublishGrant,
  inspectExternalEffectGrant,
  issueExternalEffectGrant,
  reconcileExternalEffectGrant,
  revokeExternalEffectGrant,
} from '../../composition-root/external-effect-production.ts';
import { productionConsumedRoleResultReplayPort } from '../../composition-root/grant-verifier-composition.ts';
import {
  discardHumanResolutionGrantPublication,
  inspectHumanResolutionGrantPublicationRecoveries,
  inspectHumanResolutionGrants,
  revokeHumanResolutionGrant,
} from '../../composition-root/human-resolution-grant-production.ts';
import { loadInvestigationRuntimeContext } from '../../composition-root/lifecycle-context.ts';
import type { MaintainerAuthorityOperations } from '../../composition-root/maintainer-authority-production.ts';
import { resumeDirectHumanTaskDiffReview } from '../../composition-root/task-diff-review-production.ts';
import { taskMandateOperations } from '../../composition-root/task-mandate-production.ts';
import { issueTaskRevisionApproval } from '../../composition-root/task-revision-approval-production.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import { readFileAtRevision } from '../../runtime/repository-transaction/git-command.ts';
import { dispatchAuthorityAuditCommand } from './authority-audit-cli.ts';
import {
  requireArgumentCount,
  usage,
  usageText,
  type CommandResult,
} from './cli-input.ts';
import {
  dispatchCollaborationGrantCommand,
  isCollaborationGrantCommand,
} from './collaboration-grant-cli.ts';
import {
  inspectIssuedExecutionBudgetGrant,
  issueExecutionBudgetGrant,
  revokeIssuedExecutionBudgetGrant,
} from './execution-grant-cli.ts';
import {
  assertSupportedBootstrapInterventionCommand,
  dispatchBootstrapInterventionCommand,
} from './intervention-control-bootstrap-cli.ts';
import { dispatchRoleContextSharingGrantCommand } from './role-context-sharing-grant-cli.ts';
import { parseTaskDiffReviewCliInput } from './task-review-cli-input.ts';

const {
  inspectActiveTaskMandateBinding,
  authorizeTaskMandate,
  inspectTaskMandate,
  revokeTaskMandate,
} = taskMandateOperations;

/**
 * Parses and dispatches authority, maintainer, mandate, and external-effect
 * commands.
 *
 * Invariants:
 * - Task Mandate requests must be readable JSON manifests accepted by the
 *   contract parser.
 */

function maintainerTaskDiffReviewUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer review-diff-attest <session-id> --input <typed-envelope.json> --grant <grant-id> [--json]',
  );
}

function parseMaintainerGrantV2PreflightArguments(
  args: string[],
): MaintainerGrantV2PreflightRequest {
  if (
    args.length !== 4 ||
    args[0] !== 'grant' ||
    args[1] !== 'preflight' ||
    args[2] !== '--profile' ||
    !args[3]
  ) {
    throw maintainerGrantV2PreflightUsage();
  }
  return { profileId: args[3] };
}

function parseMaintainerApproveAndApplyArguments(
  args: string[],
  cwd: string,
): ApproveAndApplyMaintainerGrantV2Request {
  if (args[0] !== 'grant' || args[1] !== 'approve-and-apply') {
    throw maintainerApproveAndApplyUsage();
  }
  const values = args.slice(2);
  const scalar = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (
      !option ||
      !value ||
      ![
        '--change',
        '--task',
        '--profile',
        '--reason',
        '--message',
        '--effects-file',
        '--waivers-file',
      ].includes(option) ||
      scalar.has(option)
    ) {
      throw maintainerApproveAndApplyUsage();
    }
    scalar.set(option, value);
  }
  const changeId = scalar.get('--change');
  const taskId = scalar.get('--task');
  const profileId = scalar.get('--profile');
  const reason = scalar.get('--reason');
  const message = scalar.get('--message');
  const effectsFile = scalar.get('--effects-file');
  const waiversFile = scalar.get('--waivers-file');
  if (
    !changeId ||
    !taskId ||
    !profileId ||
    !reason ||
    !message ||
    !effectsFile
  ) {
    throw maintainerApproveAndApplyUsage();
  }
  return {
    changeId,
    taskId,
    profileId,
    reason,
    message,
    externalEffects:
      effectsFile === 'none'
        ? []
        : readCandidateExternalEffectsDeclaration(effectsFile, cwd),
    ...(waiversFile === undefined
      ? {}
      : {
          evidenceWaivers:
            waiversFile === 'none'
              ? []
              : readMaintainerEvidenceWaiversDeclaration(waiversFile, cwd),
        }),
  };
}

function parseMaintainerReissueAndApplyArguments(
  args: string[],
  cwd: string,
): ReissueAndApplyMaintainerGrantV2Request {
  if (args[0] !== 'grant' || args[1] !== 'reissue-and-apply') {
    throw maintainerReissueAndApplyUsage();
  }
  const values = args.slice(2);
  const scalar = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (
      !option ||
      !value ||
      !['--grant', '--reason', '--ttl-minutes', '--waivers-file'].includes(
        option,
      ) ||
      scalar.has(option)
    ) {
      throw maintainerReissueAndApplyUsage();
    }
    scalar.set(option, value);
  }
  const priorGrantId = scalar.get('--grant');
  const reason = scalar.get('--reason');
  const waiversFile = scalar.get('--waivers-file');
  if (!priorGrantId || !reason) {
    throw maintainerReissueAndApplyUsage();
  }
  const requestedTtlMinutes = scalar.get('--ttl-minutes');
  if (
    requestedTtlMinutes !== undefined &&
    !/^[1-9][0-9]*$/.test(requestedTtlMinutes)
  ) {
    throw maintainerReissueAndApplyUsage();
  }
  const ttlMinutes =
    requestedTtlMinutes === undefined
      ? undefined
      : Number.parseInt(requestedTtlMinutes, 10);
  if (
    ttlMinutes !== undefined &&
    (!Number.isSafeInteger(ttlMinutes) || ttlMinutes < 1)
  ) {
    throw maintainerReissueAndApplyUsage();
  }
  return {
    priorGrantId,
    reason,
    ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
    ...(waiversFile === undefined
      ? {}
      : {
          evidenceWaivers:
            waiversFile === 'none'
              ? []
              : readMaintainerEvidenceWaiversDeclaration(waiversFile, cwd),
        }),
  };
}

function readCandidateExternalEffectsDeclaration(
  requestedPath: string,
  cwd: string,
): CandidateExternalEffect[] {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.resolve(cwd, requestedPath), 'utf8'),
    ) as unknown;
    if (!Array.isArray(value)) throw new Error('not an array');
    return value as CandidateExternalEffect[];
  } catch {
    throw workflowError(
      'APPLY_CANDIDATE_EFFECTS_DECLARATION_INVALID',
      'External effects declaration must be a readable JSON array or explicit none.',
      ExitCode.usage,
    );
  }
}

function readMaintainerEvidenceWaiversDeclaration(
  requestedPath: string,
  cwd: string,
): MaintainerEvidenceWaiver[] {
  try {
    return parseMaintainerEvidenceWaivers(
      JSON.parse(
        fs.readFileSync(path.resolve(cwd, requestedPath), 'utf8'),
      ) as unknown,
    );
  } catch {
    throw workflowError(
      'MAINTAINER_EVIDENCE_WAIVER_DECLARATION_INVALID',
      'Evidence waiver declaration must be a readable JSON array of sorted {checkId, reason} entries or explicit none.',
      ExitCode.usage,
    );
  }
}

function maintainerGrantV2PreflightUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer grant preflight --profile <profile-id> [--json]',
  );
}

function maintainerApproveAndApplyUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer grant approve-and-apply --change <change-id> --task <mandate-task-id> --profile <profile-id> --reason <text> --message <subject> --effects-file <json|none> [--waivers-file <json|none>] [--json]',
  );
}

function maintainerReissueAndApplyUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer grant reissue-and-apply --grant <prior-grant-id> --reason <text> [--ttl-minutes <positive-integer>] [--waivers-file <json|none>] [--json]',
  );
}

function parseHumanResolutionPublicationDiscardArguments(args: string[]): {
  grantId: string;
  expectedPublicationStateDigest: string;
  reason: string;
} {
  if (
    args[0] !== 'resolution-publication-discard' ||
    typeof args[1] !== 'string'
  ) {
    throw humanResolutionPublicationDiscardUsage();
  }
  const options = new Map<string, string>();
  for (let index = 2; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (
      typeof key !== 'string' ||
      typeof value !== 'string' ||
      !['--expected-publication-state', '--reason'].includes(key) ||
      options.has(key)
    ) {
      throw humanResolutionPublicationDiscardUsage();
    }
    options.set(key, value);
  }
  const expectedPublicationStateDigest = options.get(
    '--expected-publication-state',
  );
  const reason = options.get('--reason');
  if (
    args.length !== 6 ||
    expectedPublicationStateDigest === undefined ||
    reason === undefined
  ) {
    throw humanResolutionPublicationDiscardUsage();
  }
  return {
    grantId: args[1],
    expectedPublicationStateDigest,
    reason,
  };
}

function humanResolutionPublicationDiscardUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer resolution-publication-discard <grant-id> --expected-publication-state <digest> --reason <text> [--json]',
  );
}

function parseMaintainerAttestArguments(
  args: string[],
): AuthorityAttestationRequest {
  if (args[0] !== 'attest') {
    throw maintainerAttestUsage();
  }
  const values = args.slice(1);
  let originalCommit: string | undefined;
  let mainCommit: string | undefined;
  const grantBasePairs: Array<{ originalBase: string; mainBase: string }> = [];

  for (let index = 0; index < values.length; index += 2) {
    const option = values[index];
    const value = values[index + 1];
    if (!option || !value || !option.startsWith('--')) {
      throw maintainerAttestUsage();
    }
    switch (option) {
      case '--original':
        if (originalCommit !== undefined) {
          throw maintainerAttestUsage();
        }
        originalCommit = value;
        break;
      case '--main':
        if (mainCommit !== undefined) {
          throw maintainerAttestUsage();
        }
        mainCommit = value;
        break;
      case '--base': {
        const separator = value.indexOf('=');
        if (separator === -1) {
          throw maintainerAttestUsage();
        }
        grantBasePairs.push({
          originalBase: value.slice(0, separator),
          mainBase: value.slice(separator + 1),
        });
        break;
      }
      default:
        throw maintainerAttestUsage();
    }
  }
  if (!originalCommit || !mainCommit) {
    throw maintainerAttestUsage();
  }
  return { originalCommit, mainCommit, grantBasePairs };
}

function maintainerAttestUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer attest --original <commit> --main <commit> [--base <original>=<main> ...] [--json]',
  );
}

function maintainerUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow maintainer <review-diff-attest <session-id> --input <typed-envelope.json> --grant <grant-id>|grant ...|resolution-inspect [grant-id]|resolution-publication-discard <grant-id> ...|resolution-revoke <grant-id> --reason <text>|attest ...|attestation-relay --original <commit>|inspect [grant-id]|collaboration-grant ...|collaboration-inspect [grant-id]|collaboration-revoke <grant-id> --reason <text>> [--json]',
  );
}

function authorityPlanUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow authority-plan <prepare --intent <intent.json>|status <plan-id>|approve-and-apply <plan-id>|resume <plan-id>|attest <plan-id>> [--json]',
  );
}

function readAuthorityPlanIntent(
  cwd: string,
  inputPath: string,
): AuthorityPlanIntent {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(cwd, inputPath), 'utf8'),
    ) as AuthorityPlanIntent;
  } catch {
    throw workflowError(
      'AUTHORITY_PLAN_INVALID',
      'Authority plan intent must be a readable exact JSON document.',
      ExitCode.usage,
    );
  }
}

function assertControllingTerminal(): void {
  assertInteractiveSignerContext({
    stdinIsTty: process.stdin.isTTY === true,
    stdoutIsTty: process.stdout.isTTY === true,
    stderrIsTty: process.stderr.isTTY === true,
  });
}

function readTaskMandateRequest(manifestPath: string, cwd: string) {
  let value: unknown;
  try {
    value = JSON.parse(
      fs.readFileSync(path.resolve(cwd, manifestPath), 'utf8'),
    ) as unknown;
  } catch {
    throw workflowError(
      'TASK_MANDATE_INVALID',
      'Task mandate request must be a readable JSON manifest.',
      ExitCode.guard,
    );
  }
  return parseTaskMandateRequest(value);
}

function taskMandateUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow task <authorize <manifest.json> --audit-root <absolute-external-path>|status <task-id>|revoke <task-id> --reason <text>> [--json]',
  );
}

function readExternalEffectJson<T>(manifestPath: string, cwd: string): T {
  try {
    return JSON.parse(
      fs.readFileSync(path.resolve(cwd, manifestPath), 'utf8'),
    ) as T;
  } catch {
    throw workflowError(
      'EXTERNAL_EFFECT_GRANT_INVALID',
      'External effect target and rollback inputs must be readable JSON files.',
      ExitCode.guard,
    );
  }
}

function externalEffectUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow external-effect <issue --grant <uuid> --task <task-id> --kind <kind> --target-file <json> --artifact-digest <sha256:digest> --prestate-digest <sha256:digest> --rollback-plan-file <json|none> --idempotency-key <key> [--ttl-seconds <1..300>]|inspect <grant-id>|revoke <grant-id> --reason <text>|reconcile <grant-id> --evidence-file <json>> [--json]',
  );
}

function publishUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow publish execute --grant <external-effect-grant-id> [--json]',
  );
}

type StoredGrantFamily = 'execution-budget' | 'apply' | 'external-effect';

function resolveStoredGrantFamily(
  cwd: string,
  requestedGrantId: string,
): StoredGrantFamily {
  const grantId = assertMaintainerGrantId(requestedGrantId);
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const runtime = runtimePaths(
    repository.gitCommonDirectory,
    config.runtimeDirectory,
  );
  const maintainer = maintainerGrantStorePaths(repository.gitCommonDirectory);
  const external = externalEffectStorePaths(repository.gitCommonDirectory);
  const recordExists = (filePath: string): boolean =>
    fs.lstatSync(filePath, { throwIfNoEntry: false }) !== undefined;
  const recordName = `${grantId}.json`;
  const families: StoredGrantFamily[] = [
    ...(recordExists(
      path.join(runtime.root, 'execution-budget-grants', recordName),
    )
      ? (['execution-budget'] as const)
      : []),
    ...([maintainer.available, maintainer.reserved, maintainer.terminal].some(
      (directory) => recordExists(path.join(directory, recordName)),
    )
      ? (['apply'] as const)
      : []),
    ...([external.available, external.transactions, external.terminal].some(
      (directory) => recordExists(path.join(directory, recordName)),
    )
      ? (['external-effect'] as const)
      : []),
  ];
  if (families.length === 0) {
    throw workflowError(
      'GRANT_NOT_FOUND',
      `Grant ${grantId} does not exist in local authoritative state.`,
      ExitCode.guard,
    );
  }
  if (families.length !== 1) {
    throw workflowError(
      'GRANT_FAMILY_AMBIGUOUS',
      `Grant ${grantId} exists in more than one authority family.`,
      ExitCode.staleState,
    );
  }
  return families[0]!;
}

function executionGrantUsage(): WorkflowError {
  return usage(
    'Usage: pnpm workflow grant <approve <grant-request.json> [--uses <count>]|inspect <grant-id>|revoke <grant-id> --reason <text>> [--json]',
  );
}

function dispatchExternalEffectCommand(
  command: 'external-effect',
  rest: string[],
  cwd: string,
): CommandResult {
  {
    if (
      rest[0] === 'issue' &&
      (rest.length === 17 || rest.length === 19) &&
      rest[1] === '--grant' &&
      rest[3] === '--task' &&
      rest[5] === '--kind' &&
      rest[7] === '--target-file' &&
      rest[9] === '--artifact-digest' &&
      rest[11] === '--prestate-digest' &&
      rest[13] === '--rollback-plan-file' &&
      rest[15] === '--idempotency-key' &&
      (rest.length === 17 || rest[17] === '--ttl-seconds')
    ) {
      const ttlToken = rest.length === 19 ? rest[18]! : undefined;
      if (ttlToken !== undefined && !/^[1-9][0-9]*$/.test(ttlToken)) {
        throw externalEffectUsage();
      }
      const ttlSeconds = ttlToken === undefined ? undefined : Number(ttlToken);
      if (
        ttlSeconds !== undefined &&
        (!Number.isSafeInteger(ttlSeconds) ||
          ttlSeconds < 1 ||
          ttlSeconds > EXTERNAL_EFFECT_MAX_TTL_SECONDS)
      ) {
        throw externalEffectUsage();
      }
      const mandateBinding = inspectActiveTaskMandateBinding(cwd, rest[4]!);
      const target = readExternalEffectJson<ExternalEffectTarget>(
        rest[8]!,
        cwd,
      );
      const rollbackPlan =
        rest[14] === 'none'
          ? null
          : readExternalEffectJson<ExternalEffectRollbackPlan>(rest[14]!, cwd);
      const request: ExternalEffectGrantRequest = {
        mandateBinding,
        effectKind: rest[6]! as ExternalEffectKind,
        target,
        artifactDigest: rest[10]! as `sha256:${string}`,
        prestateDigest: rest[12]! as `sha256:${string}`,
        rollbackPlan,
        ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
        idempotencyKey: rest[16]!,
      };
      const issued = issueExternalEffectGrant(cwd, request, {
        grantId: rest[2]!,
      });
      return {
        command,
        action: 'issue',
        ok: true,
        grantId: issued.grantId,
        grantDigest: issued.grantDigest,
        taskId: issued.envelope.payload.taskId,
        effectKind: issued.envelope.payload.effectKind,
        expiresAt: issued.envelope.payload.expiresAt,
        recordPath: issued.recordPath,
      };
    }
    if (rest[0] === 'inspect' && rest.length === 2) {
      return {
        command,
        action: 'inspect',
        ok: true,
        result: inspectExternalEffectGrant(cwd, rest[1]!),
      };
    }
    if (rest[0] === 'revoke' && rest.length === 4 && rest[2] === '--reason') {
      return {
        command,
        action: 'revoke',
        ok: true,
        result: revokeExternalEffectGrant(cwd, rest[1]!, {
          reason: rest[3]!,
        }),
      };
    }
    if (
      rest[0] === 'reconcile' &&
      rest.length === 4 &&
      rest[2] === '--evidence-file'
    ) {
      return {
        command,
        action: 'reconcile',
        ok: true,
        result: reconcileExternalEffectGrant(
          cwd,
          rest[1]!,
          readExternalEffectJson<ExternalEffectReconciliationRequest>(
            rest[3]!,
            cwd,
          ),
          {},
        ),
      };
    }
    throw externalEffectUsage();
  }
}

export function createAuthorityCommands(
  maintainerAuthority: Pick<
    MaintainerAuthorityOperations,
    | 'createAuthorityPlan'
    | 'resumeAuthorityPlan'
    | 'approveAndApplyAuthorityPlan'
    | 'attestAuthorityPlan'
    | 'preflightMaintainerGrantV2'
    | 'issueAuthorityAttestation'
    | 'projectAuthorityAttestationRelay'
    | 'approveAndApplyMaintainerGrantV2'
    | 'reissueAndApplyMaintainerGrantV2'
  >,
) {
  const {
    createAuthorityPlan,
    resumeAuthorityPlan,
    approveAndApplyAuthorityPlan,
    attestAuthorityPlan,
    preflightMaintainerGrantV2,
    issueAuthorityAttestation,
    projectAuthorityAttestationRelay,
    approveAndApplyMaintainerGrantV2,
    reissueAndApplyMaintainerGrantV2,
  } = maintainerAuthority;
  function dispatchAuthorityCommand(
    args: string[],
    cwd: string,
    createHarnessBootstrapDependencies: (
      cwd: string,
    ) => Parameters<typeof dispatchBootstrapInterventionCommand>[2],
  ): CommandResult {
    const [command, ...rest] = args;
    switch (command) {
      case 'grant': {
        if (rest[0] === 'approve' && (rest.length === 2 || rest.length === 4)) {
          if (rest.length === 4 && rest[2] !== '--uses') {
            throw executionGrantUsage();
          }
          const requestedUses =
            rest.length === 4 ? Number.parseInt(rest[3]!, 10) : undefined;
          if (
            requestedUses !== undefined &&
            (!Number.isSafeInteger(requestedUses) || requestedUses < 1)
          ) {
            throw executionGrantUsage();
          }
          const requestPath = path.resolve(cwd, rest[1]!);
          const request = parseExecutionBudgetGrantRequest(
            fs.readFileSync(requestPath, 'utf8'),
          );
          const issued = issueExecutionBudgetGrant(cwd, request, {
            ...(requestedUses === undefined ? {} : { maxUses: requestedUses }),
          });
          return {
            command,
            action: 'approve',
            ok: true,
            grantId: issued.grantId,
            jobId: issued.envelope.payload.jobId,
            epoch: issued.envelope.payload.epoch,
            maxUses: issued.envelope.payload.maxUses,
            recordPath: issued.recordPath,
          };
        }
        if (rest[0] === 'inspect' && rest.length === 2) {
          return {
            command,
            action: 'inspect',
            ok: true,
            result: inspectIssuedExecutionBudgetGrant(cwd, rest[1]!),
          };
        }
        if (
          rest[0] === 'revoke' &&
          rest.length === 4 &&
          rest[2] === '--reason'
        ) {
          const grantId = rest[1]!;
          const reason = rest[3]!;
          const family = resolveStoredGrantFamily(cwd, grantId);
          const result =
            family === 'execution-budget'
              ? revokeIssuedExecutionBudgetGrant(cwd, grantId, { reason })
              : family === 'apply'
                ? revokeMaintainerGrantV2(cwd, { grantId, reason })
                : revokeExternalEffectGrant(cwd, grantId, { reason });
          return {
            command,
            action: 'revoke',
            family,
            ok: true,
            result,
          };
        }
        throw executionGrantUsage();
      }
      case 'external-effect':
        return dispatchExternalEffectCommand(command, rest, cwd);

      case 'publish': {
        if (
          rest[0] !== 'execute' ||
          rest.length !== 3 ||
          rest[1] !== '--grant'
        ) {
          throw publishUsage();
        }
        return {
          command,
          action: 'execute',
          ok: true,
          result: executePublishGrant(cwd, rest[2]!, {}),
        };
      }
      case 'intervention':
        assertSupportedBootstrapInterventionCommand(rest);
        return {
          command,
          ok: true,
          result: dispatchBootstrapInterventionCommand(
            rest,
            cwd,
            createHarnessBootstrapDependencies(cwd),
          ),
        };
      case 'control-plane':
        throw workflowError(
          'CONTROL_PLANE_UPDATER_COMMAND_UNSUPPORTED',
          'Repository engine self-update commands are no longer supported.',
          ExitCode.usage,
        );

      case 'audit':
        return {
          command,
          ok: true,
          result: dispatchAuthorityAuditCommand(rest, cwd),
        };
      case 'change':
      case 'engine':
        assertSupportedBootstrapInterventionCommand([command, ...rest]);
        return {
          command,
          ok: true,
          result: dispatchBootstrapInterventionCommand(
            [command, ...rest],
            cwd,
            createHarnessBootstrapDependencies(cwd),
          ),
        };
      case 'task': {
        if (
          rest[0] === 'authorize' &&
          rest.length === 4 &&
          rest[2] === '--audit-root'
        ) {
          const request = readTaskMandateRequest(rest[1]!, cwd);
          const mandate = authorizeTaskMandate(cwd, request, {
            externalAuditRoot: rest[3]!,
          });
          return {
            command,
            action: 'authorize',
            ok: true,
            mandateId: mandate.mandateId,
            taskId: mandate.envelope.payload.taskId,
            intent: mandate.envelope.payload.intent,
            inactivityDays: mandate.envelope.payload.validUntil.inactivityDays,
            authoritativeEffects: mandate.envelope.payload.authoritativeEffects,
            controlPlaneMutation: mandate.envelope.payload.controlPlaneMutation,
            recordPath: mandate.recordPath,
            audit: mandate.audit,
          };
        }
        if (rest[0] === 'status' && rest.length === 2) {
          return {
            command,
            action: 'status',
            ok: true,
            result: inspectTaskMandate(cwd, rest[1]!),
          };
        }
        if (
          rest[0] === 'revoke' &&
          rest.length === 4 &&
          rest[2] === '--reason'
        ) {
          return {
            command,
            action: 'revoke',
            ok: true,
            result: revokeTaskMandate(cwd, rest[1]!, {
              reason: rest[3]!,
            }),
          };
        }
        throw taskMandateUsage();
      }
      case 'authority-plan': {
        if (
          rest.length === 3 &&
          rest[0] === 'prepare' &&
          rest[1] === '--intent'
        ) {
          return {
            command,
            action: 'prepare',
            ok: true,
            result: createAuthorityPlan(
              cwd,
              readAuthorityPlanIntent(cwd, rest[2]),
            ),
          };
        }
        if (rest.length === 2 && rest[0] === 'status') {
          return {
            command,
            action: 'status',
            ok: true,
            result: inspectAuthorityPlan(cwd, rest[1]),
          };
        }
        if (rest.length === 2 && rest[0] === 'resume') {
          return {
            command,
            action: 'resume',
            ok: true,
            result: resumeAuthorityPlan(cwd, rest[1]),
          };
        }
        if (rest.length === 2 && rest[0] === 'approve-and-apply') {
          assertControllingTerminal();
          return {
            command,
            action: 'approve-and-apply',
            ok: true,
            result: approveAndApplyAuthorityPlan(cwd, rest[1]),
          };
        }
        if (rest.length === 2 && rest[0] === 'attest') {
          assertControllingTerminal();
          return {
            command,
            action: 'attest',
            ok: true,
            result: attestAuthorityPlan(cwd, rest[1]),
          };
        }
        throw authorityPlanUsage();
      }
      case 'maintainer':
        return dispatchMaintainerCommand(command, rest, cwd);

      case 'human-resolution-state': {
        requireArgumentCount(command, rest, 1, 1);
        const context = loadInvestigationRuntimeContext(cwd);
        const policy = parseMaintainerPolicy(
          JSON.parse(
            readFileAtRevision(
              context.git.repositoryRoot,
              context.git.head,
              'workflow/maintainer-policy.json',
            ),
          ),
        );
        return {
          command,
          ok: true,
          state: inspectInvestigationQuarantineState(
            context.runtime,
            rest[0],
            policy.repository.id,
          ),
        };
      }
      default:
        throw usage(
          command ? `Unknown workflow command: ${command}` : usageText(),
        );
    }
  }

  function dispatchMaintainerCommand(
    command: 'maintainer',
    rest: string[],
    cwd: string,
  ): CommandResult {
    {
      if (rest[0] === 'review-diff-attest') {
        const sessionId = rest[1];
        const inputPath = rest[3];
        const grantId = rest[5];
        if (
          rest.length !== 6 ||
          !sessionId ||
          rest[2] !== '--input' ||
          !inputPath ||
          rest[4] !== '--grant' ||
          !grantId
        ) {
          throw maintainerTaskDiffReviewUsage();
        }
        const parsedInput = parseTaskDiffReviewCliInput(cwd, inputPath);
        if (parsedInput.route === 'provider-response') {
          throw maintainerTaskDiffReviewUsage();
        }
        const collaborationGrant = taskDiffCollaborationGrantSelection(
          cwd,
          grantId,
        );
        return {
          command,
          action: 'review-diff-attest',
          ok: true,
          result: resumeDirectHumanTaskDiffReview(
            cwd,
            sessionId,
            parsedInput.input,
            grantId,
            {
              consumedRoleResultReplay: productionConsumedRoleResultReplayPort,
              ...('verifier' in collaborationGrant
                ? { verifier: collaborationGrant.verifier }
                : {}),
              consumedReplayVerifier: collaborationGrant.consumedReplayVerifier,
            },
          ),
        };
      }
      if (
        rest.length === 6 &&
        rest[0] === 'revision-approval' &&
        rest[2] === '--target' &&
        rest[4] === '--reason'
      ) {
        const binding = prepareTaskRevisionApprovalBinding(cwd, rest[1]!);
        const approval = issueTaskRevisionApproval(cwd, {
          binding,
          expectedTargetDigest: rest[3]!,
          rationale: rest[5]!,
        });
        return {
          command,
          action: 'revision-approval',
          ok: true,
          approvalId: approval.approvalId,
          recordPath: approval.recordPath,
          expiresAt: approval.envelope.payload.expiresAt,
          targetDigest: approval.envelope.payload.targetDigest,
          binding: approval.envelope.payload.binding,
        };
      }
      if (isCollaborationGrantCommand(rest)) {
        return {
          command,
          ...dispatchCollaborationGrantCommand(rest, cwd),
        };
      }
      if (rest[0] === 'role-context-sharing-grant') {
        return {
          command,
          ...dispatchRoleContextSharingGrantCommand(rest, cwd),
        };
      }
      if (rest[0] === 'grant' && rest[1] === 'preflight') {
        const request = parseMaintainerGrantV2PreflightArguments(rest);
        return {
          command,
          action: 'grant-preflight',
          ok: true,
          result: preflightMaintainerGrantV2(cwd, request),
        };
      }
      if (rest[0] === 'grant' && rest[1] === 'issue') {
        throw workflowError(
          'MAINTAINER_V2_MANUAL_ISSUE_DISABLED',
          'Apply Grant v2 is issued only inside the atomic approve-and-apply command.',
          ExitCode.guard,
        );
      }
      if (rest[0] === 'grant' && rest[1] === 'approve-and-apply') {
        const request = parseMaintainerApproveAndApplyArguments(rest, cwd);
        return {
          command,
          action: 'grant-approve-and-apply',
          ok: true,
          result: approveAndApplyMaintainerGrantV2(cwd, request),
        };
      }
      if (rest[0] === 'grant' && rest[1] === 'reissue-and-apply') {
        const request = parseMaintainerReissueAndApplyArguments(rest, cwd);
        return {
          command,
          action: 'grant-reissue-and-apply',
          ok: true,
          result: reissueAndApplyMaintainerGrantV2(cwd, request),
        };
      }
      if (rest[0] === 'resolution-inspect' && rest.length <= 2) {
        const publicationRecoveries =
          inspectHumanResolutionGrantPublicationRecoveries(cwd, rest[1]);
        let grants: ReturnType<typeof inspectHumanResolutionGrants>;
        try {
          grants = inspectHumanResolutionGrants(cwd, rest[1]);
        } catch (error) {
          if (
            publicationRecoveries.length === 0 ||
            !(error instanceof WorkflowError) ||
            error.code !== 'HUMAN_RESOLUTION_GRANT_NOT_FOUND'
          ) {
            throw error;
          }
          grants = [];
        }
        return {
          command,
          action: 'resolution-inspect',
          ok: true,
          grants,
          publicationRecoveries,
        };
      }
      if (rest[0] === 'resolution-publication-discard') {
        const request = parseHumanResolutionPublicationDiscardArguments(rest);
        assertInteractiveSignerContext({
          stdinIsTty: process.stdin.isTTY === true,
          stdoutIsTty: process.stdout.isTTY === true,
          stderrIsTty: process.stderr.isTTY === true,
        });
        return {
          command,
          action: 'resolution-publication-discard',
          ok: true,
          recovery: discardHumanResolutionGrantPublication(
            cwd,
            request.grantId,
            request.expectedPublicationStateDigest,
            request.reason,
          ),
        };
      }
      if (
        rest[0] === 'resolution-revoke' &&
        rest.length === 4 &&
        rest[2] === '--reason'
      ) {
        return {
          command,
          action: 'resolution-revoke',
          ok: true,
          grant: revokeHumanResolutionGrant(cwd, rest[1], {
            reason: rest[3],
          }),
        };
      }
      if (rest[0] === 'attest') {
        const request = parseMaintainerAttestArguments(rest);
        const attestation = issueAuthorityAttestation(cwd, request);
        return {
          command,
          action: 'attest',
          ok: true,
          grantId: attestation.grantId,
          tagRef: attestation.tagRef,
          originalCommit: attestation.envelope.payload.originalCommit,
          mainCommit: attestation.envelope.payload.mainCommit,
          grantBases: attestation.envelope.payload.grantBases,
          publishCommand: attestation.publishCommand,
        };
      }
      if (
        rest[0] === 'attestation-relay' &&
        rest.length === 3 &&
        rest[1] === '--original'
      ) {
        return {
          command,
          action: 'attestation-relay',
          ok: true,
          result: projectAuthorityAttestationRelay(cwd, rest[2]),
        };
      }
      if (rest[0] !== 'inspect') {
        throw maintainerUsage();
      }
      const git = discoverRepository(cwd);
      if (rest[0] === 'inspect' && rest.length <= 2) {
        return {
          command,
          action: 'inspect',
          ok: true,
          grants: inspectMaintainerGrants(git.gitCommonDirectory, rest[1]),
        };
      }
      throw maintainerUsage();
    }
  }
  return { dispatchAuthorityCommand };
}
