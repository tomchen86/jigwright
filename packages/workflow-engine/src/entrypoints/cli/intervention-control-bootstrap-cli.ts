/** Parse retained intervention commands and preserve their wire results. */
import { interventionMetadataDisposition } from '../../composition-root/human-revocation-production.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  BootstrapInterventionCliDependencies,
  LocalEngineBinding,
} from '../../modules/authority/intervention-bootstrap-contract.ts';
import type { Sha256Digest } from '../../modules/authority/intervention-control-values.ts';
import type { PersistedInterventionRecord } from '../../runtime/storage-journal/intervention-persistence-contracts.ts';
export type { BootstrapInterventionCliDependencies } from '../../modules/authority/intervention-bootstrap-contract.ts';
export interface BootstrapInterventionCliResult {
  kind: 'bootstrap-intervention-cli-result.v1';
  action: 'status' | 'revoke-intervention';
  stateRoot: string;
  bindingPath: string | null;
  parentChangeId: string | null;
  checkpointId: Sha256Digest | null;
  workspaceId: Sha256Digest | null;
  intervention: PersistedInterventionRecord | null;
  parentSession: LocalEngineBinding | null;
  effectsPerformed: boolean;
}
export function assertSupportedBootstrapInterventionCommand(
  argv: readonly string[],
): void {
  if (
    !(argv[0] === 'status' && argv.length === 2 && isNonEmpty(argv[1])) &&
    !(
      argv[0] === 'change' &&
      argv[1] === 'revoke-intervention' &&
      argv.length === 5 &&
      isNonEmpty(argv[2]) &&
      argv[3] === '--reason' &&
      isNonEmpty(argv[4])
    )
  ) {
    throw workflowError(
      'INTERVENTION_BOOTSTRAP_COMMAND_UNSUPPORTED',
      bootstrapInterventionUsage(),
      ExitCode.usage,
    );
  }
}
export function dispatchBootstrapInterventionCommand(
  argv: readonly string[],
  cwd: string,
  dependencies: BootstrapInterventionCliDependencies = {},
): BootstrapInterventionCliResult {
  assertSupportedBootstrapInterventionCommand(argv);
  if (
    argv[0] === 'change' &&
    argv[1] === 'revoke-intervention' &&
    argv.length === 5 &&
    isNonEmpty(argv[2]) &&
    argv[3] === '--reason' &&
    isNonEmpty(argv[4])
  ) {
    return result({
      action: 'revoke-intervention',
      ...interventionMetadataDisposition.revoke(
        cwd,
        argv[2],
        argv[4],
        dependencies,
      ),
    });
  }

  return result({
    action: 'status',
    ...interventionMetadataDisposition.inspect(cwd, argv[1]!),
  });
}
export function bootstrapInterventionUsage(): string {
  return [
    'Usage:',
    '  pnpm workflow change revoke-intervention <parent-change-id> --reason <text> [--json]',
    '  pnpm workflow intervention status <parent-change-id> [--json]',
  ].join('\n');
}

function result(
  input: Partial<BootstrapInterventionCliResult> &
    Pick<
      BootstrapInterventionCliResult,
      'action' | 'stateRoot' | 'effectsPerformed'
    >,
): BootstrapInterventionCliResult {
  return {
    kind: 'bootstrap-intervention-cli-result.v1',
    bindingPath: null,
    parentChangeId: null,
    checkpointId: null,
    workspaceId: null,
    intervention: null,
    parentSession: null,
    ...input,
  };
}
function isNonEmpty(value: unknown): value is string {
  return (
    typeof value === 'string' && value.trim() === value && value.length > 0
  );
}
