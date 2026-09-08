import {
  WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';
import { workflowGuidanceUsageLines } from '../../composition-root/cli-command-services.ts';

export type CommandResult = Record<string, unknown>;

const STANDALONE_COMMAND_FLAGS = new Set(['--resume']);

const OPTION_SHAPED_TEXT_VALUE_OPTIONS = new Set([
  '--message',
  '--rationale',
  '--reason',
  '--replacement',
  '--resolution-reason',
  '--reviewer',
  '--section',
]);

export function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return (
    keys.length === sorted.length &&
    keys.every((key, index) => key === sorted[index])
  );
}

export function shellCommandArgument(value: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/u.test(value)
    ? value
    : `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function hasTerminalJsonOutputFlag(argv: string[]): boolean {
  if (argv.at(-1) !== '--json') return false;
  const previousArgument = argv.at(-2);
  if (
    previousArgument === undefined ||
    !previousArgument.startsWith('--') ||
    STANDALONE_COMMAND_FLAGS.has(previousArgument)
  ) {
    return true;
  }
  const valueOption = argv.at(-3);
  if (previousArgument === '--json') {
    return (
      valueOption !== undefined &&
      OPTION_SHAPED_TEXT_VALUE_OPTIONS.has(valueOption)
    );
  }
  return !OPTION_SHAPED_TEXT_VALUE_OPTIONS.has(previousArgument);
}

export function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function requireArgumentCount(
  command: string,
  args: string[],
  minimum: number,
  maximum: number,
): void {
  if (args.length < minimum || args.length > maximum) {
    throw usage(`Invalid arguments for workflow ${command}.\n${usageText()}`);
  }
}

export function usage(message: string): WorkflowError {
  return workflowError('INVALID_USAGE', message, ExitCode.usage);
}

export function usageText(): string {
  return [
    'Usage:',
    '  pnpm workflow doctor [--json]',
    '  pnpm workflow validate-change <change-id> [--json]',
    '  pnpm workflow propose <change-id> --intent <intent.json> --mandate <mandate-task-id> [--actor <id>] [--grant <grant-id>] [--json]',
    '  pnpm workflow propose <change-id> --resume --input <envelope.json> [--grant <grant-id>|--role-context-grant <grant-id>] [--json]',
    '  pnpm workflow plan-commit <change-id> [--json]',
    '  pnpm workflow amend-plan --change <change-id> --reason <code> --execution-impact <none|required> [--json]',
    '  pnpm workflow archive <change-id> [--json]',
    '  pnpm workflow archive-candidates --base <origin/protected-branch> [--json]',
    '  pnpm workflow after-merge <change-id> [--workspace-parent <absolute-path>] [--json]',
    '  pnpm workflow archive-pr doctor --base <origin/protected-branch> [--json]',
    '  pnpm workflow archive-pr dry-run <change-id> [--workspace-parent <absolute-path>] [--json]',
    '  pnpm workflow archive-pr status <sha256:preparation-identity> [--json]',
    '  pnpm workflow archive-pr prepare <change-id> --config <github-adapter.json> [--workspace-parent <absolute-path>] [--json]',
    '  pnpm workflow archive-pr open <change-id> --config <github-adapter.json> --grant <challenge-id> [--workspace-parent <absolute-path>] [--json]',
    '  pnpm workflow openspec-assets <generate|check|install-prompts --codex-home <path>> [--json]',
    '  pnpm workflow job list [--json]',
    '  pnpm workflow job status <job-id> [--json]',
    '  pnpm workflow job watch <job-id> [--json]',
    '  pnpm workflow job prune --limit <count> [--json]',
    '  pnpm workflow job retry-pump --limit <count> [--json]',
    '  pnpm workflow job retry-schedules [--json]',
    '  pnpm workflow job retry-receipts [schedule-id] [--json]',
    '  pnpm workflow job retry-request <job-id> --timeout <milliseconds> [--json]',
    '  pnpm workflow job retry <job-id> --grant <grant-id> [--json]',
    '  pnpm workflow job retry-preview <job-id> --timeout <milliseconds> [--json]',
    '  pnpm workflow metrics show [--json]',
    '  pnpm workflow semantic-ledger reconcile --change <change-id> [--input <json>] [--json]',
    '  pnpm workflow retention inspect [--json]',
    '  pnpm workflow retention sweep --limit <count> [--json]',
    '  pnpm workflow retention pin <workflow-id> <evidence-id> --reason <text> [--json]',
    '  pnpm workflow grant approve <grant-request.json> [--uses <count>] [--json] — Authorize the exact requested operation through Grant Core.',
    '  pnpm workflow grant inspect <grant-id> [--json] — Inspect an existing Grant and its state.',
    '  pnpm workflow grant revoke <grant-id> --reason <text> [--json] — Revoke the named Grant with a recorded reason.',
    '  pnpm workflow external-effect issue --grant <uuid> --task <task-id> --kind <kind> --target-file <json> --artifact-digest <sha256:digest> --prestate-digest <sha256:digest> --rollback-plan-file <json|none> --idempotency-key <key> [--ttl-seconds <1..300>] [--json] — Authorize the exact external effect and its recorded prestate.',
    '  pnpm workflow external-effect inspect <grant-id> [--json] — Inspect the external effect authorization.',
    '  pnpm workflow external-effect revoke <grant-id> --reason <text> [--json] — Revoke the external effect authorization.',
    '  pnpm workflow external-effect reconcile <grant-id> --evidence-file <json> [--json] — Record evidence about an uncertain external effect.',
    '  pnpm workflow publish execute --grant <external-effect-grant-id> [--json] — Execute the publication bound to an external effect Grant.',
    '  pnpm workflow task authorize <manifest.json> --audit-root <absolute-external-path> [--json] — Authorize the exact task manifest and its audit destination.',
    '  pnpm workflow task status <task-id> [--json] — Inspect the Task Mandate state.',
    '  pnpm workflow task revoke <task-id> --reason <text> [--json] — Revoke the Task Mandate with a recorded reason.',
    '  pnpm workflow change intervene <parent-change-id> --reason <text> --audit-root <absolute-external-path> [--json] — Request human intervention in the named parent change.',
    '  pnpm workflow change revoke-intervention <parent-change-id> --reason <text> [--json] — Revoke intervention in the named parent change.',
    '  pnpm workflow engine build-artifact <absolute-executable-path> --for <parent-change-id> --protocol-version <positive-integer> --policy-schema-version <positive-integer> --audit-root <absolute-path> [--json] — Build an engine artifact for the exact intervention target.',
    '  pnpm workflow engine adopt <artifact-id> --into <parent-change-id> --audit-root <absolute-external-path> [--json] — Adopt the selected engine artifact into the parent change.',
    '  pnpm workflow intervention status <parent-change-id> [--tx <tx-id>] [--json] — Inspect the durable intervention transaction.',
    '  pnpm workflow intervention recover <tx-id> [--json] — Recover the recorded intervention transaction.',
    '  pnpm workflow control-plane produce <frozen-candidate-bundle-digest> [--json] — Produce a candidate from the frozen control-plane bundle.',
    '  pnpm workflow control-plane approve-and-apply <candidate-id> --task <parent-task-id> [--json] — Authorize and apply the exact control-plane candidate.',
    '  pnpm workflow control-plane recover <grant-id> [--json] — Recover the recorded control-plane operation.',
    '  pnpm workflow control-plane status <grant-id> [--json] — Inspect the recorded control-plane operation.',
    '  pnpm workflow audit show <task-id> --audit-root <absolute-external-path> [--json] — Show audit evidence for the named task.',
    '  pnpm workflow audit verify <repository-id> --audit-root <absolute-external-path> [--json] — Verify the repository audit evidence.',
    '  pnpm workflow run-check <check-id> [--json]',
    '  pnpm workflow ci --base <commit> --head <commit> [--input <integration-review.json>] [--json]',
    '  pnpm workflow adapter evaluate [--config <absolute-host-path>] [--json]',
    '  jigwright agent provider probe <profile-id> --config <absolute-host-path> [--json]',
    '  jigwright agent provider test <profile-id> --config <absolute-host-path> --live [--json]',
    '  pnpm workflow role-config <show|configure --config <absolute-host-path>|simulate --config <absolute-host-path> --caller <logical-provider-id>> [--json]',
    '  pnpm workflow adapter availability-pilot --record <workflow/provider-availability-pilots/name.json> [--json]',
    '  pnpm workflow adapter verify-availability-pilot --record <workflow/provider-availability-pilots/name.json> [--json]',
    '  pnpm workflow source <capture --input <source-envelope.json>|link-change <source-id> --change <change-id>|list|show <source-id>|trace <source-id>> [--json] — Preserve and inspect original requirement wording and its provenance.',
    '  pnpm workflow now <original-text> [--kind <kind>] [--json] — Start work from the supplied request or an existing Work Item.',
    '  pnpm workflow now <work-item-id> [--json] — Start work from the supplied request or an existing Work Item.',
    '  pnpm workflow later <original-text> [--kind <kind>] [--json] — Capture work for later using the selected kind.',
    '  pnpm workflow attach <work-item-id> <original-text>|<SRC-id> [--supersedes <SRC-id>] [--json] — Attach owner wording or an existing Source to a Work Item.',
    '  pnpm workflow correct <work-item-id> <old-SRC-id> <original-text> [--json] — Correct the selected request while preserving its original Source history.',
    '  pnpm workflow finding <add [--session <session-id>] --input <finding-envelope.json>|list [--all]|convert <finding-id> [--kind <kind>] [--now]|link <finding-id> --change <change-id>|link <finding-id> --work-item <work-item-id>|dismiss <finding-id> --reason <reason>> [--json] — Record, inspect, convert, link or dismiss a development observation.',
    '  pnpm workflow work-item <create|review|promote-prepare|promote|list|show|search|trace|recommend|inventory|render|validate> ... [--json] — Manage the built-in work inventory and render its projections.',
    '  pnpm workflow maintainer grant preflight --profile <profile-id> [--json] — Inspect the frozen candidate and required checks before signing.',
    '  pnpm workflow maintainer grant approve-and-apply --change <change-id> --task <mandate-task-id> --profile <profile-id> --reason <text> --message <subject> --effects-file <json|none> [--waivers-file <json|none>] [--json] — Check, authorize and apply the frozen candidate.',
    '  pnpm workflow maintainer grant reissue-and-apply --grant <prior-grant-id> --reason <text> [--ttl-minutes <positive-integer>] [--waivers-file <json|none>] [--json] — Issue fresh authorization for a retained candidate and apply it.',
    '  pnpm workflow maintainer revision-approval <session-id> --target <digest> --reason <text> [--json] — Approve the exact task revision target.',
    '  pnpm workflow maintainer resolution-inspect [grant-id] [--json] — Inspect durable human resolution state.',
    '  pnpm workflow maintainer resolution-publication-discard <grant-id> --expected-publication-state <digest> --reason <text> [--json] — Discard the exact pending resolution publication.',
    '  pnpm workflow maintainer resolution-revoke <grant-id> --reason <text> [--json] — Revoke the named human resolution.',
    '  pnpm workflow maintainer attest --original <commit> --main <commit> [--base <original>=<main> ...] [--json] — Attest the exact original and protected-main transitions.',
    '  pnpm workflow maintainer attestation-relay --original <commit> [--json] — Relay the attestation for the original transition.',
    '  pnpm workflow maintainer inspect [grant-id] [--json] — Inspect local maintainer authority state.',
    '  pnpm workflow maintainer collaboration-grant --change <id> [--task <task-id>] --base <commit> --target <digest> --phase <blind-survey|plan-review|task-diff-review|task-implementation> --author-role <role> --conflicting-role <role> (--provider <codex|claude> --actor-assurance <grade>|--caller <id> --actor-assurance <grade>|--direct-human true) --degraded <same-provider-fresh-session|caller-supplied|direct-human-review> --reason <text> [--ttl <minutes>m] [--uses 1] [--json] — Authorize one precisely bounded collaboration downgrade.',
    '  pnpm workflow maintainer collaboration-inspect [grant-id] [--json] — Inspect collaboration authorization state.',
    '  pnpm workflow maintainer collaboration-revoke <grant-id> --reason <text> [--json] — Revoke the named collaboration authorization.',
    '  pnpm workflow human-resolution-state <investigation-id> [--json] — Inspect the resolution state for an investigation.',
    '  pnpm workflow grant human <request-investigation-v3 <investigation-id> --reason <agent-proposed-reason>|request-change-routing-continuation <change-id> --reason <agent-proposed-reason>|request-work-item-review <work-item-id> --input <review.json> --reason <reason>|request-work-item-promotion <work-item-id> --change <change-id> --expected <digest> --reason <reason>|inspect <challenge-id>|decide <challenge-id>|recover <challenge-id>> [--json] — Request, inspect, decide or recover an exact human authorization.',
    '  pnpm workflow documents validate [--json] — Validate contract references, observed test proof and document projections.',
    '  pnpm workflow documents render [--json] — Regenerate readable document projections from canonical records.',
    '  pnpm workflow documents test [--spec <path>] [--json] — Run the exact tests named by the selected contracts and record their outcomes.',
    '  pnpm workflow documents review <session-id> [--input <review.json>] [--json] — Inspect or record document decisions for the current finalization candidate.',
    '  pnpm workflow document-refresh <propose|show|review|apply> ... [--json]',
    '  pnpm workflow handoff validate [--json]',
    '  pnpm workflow guidance <install [path ...]|refresh|remove|status> [--json]',
    '  pnpm workflow hook <pre-commit|commit-msg|pre-push|post-merge> ... [--json]',
    ...workflowGuidanceUsageLines().map((line) => `  ${line}`),
  ].join('\n');
}
