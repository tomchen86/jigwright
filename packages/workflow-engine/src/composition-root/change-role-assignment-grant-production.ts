import { loadChangeContract } from '../adapters/consumer/repository/work-registry/contracts.ts';
import { canonicalJson } from '../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../foundation/errors/errors.ts';
import {
  assertChangeRoleAssignmentGrantParameters,
  changeRoleAssignmentGrantRequirementDigestV1,
  type ChangeRoleAssignmentGrantObservationV1,
  type ChangeRoleAssignmentGrantParametersV1,
  type ChangeRoleAssignmentGrantPort,
} from '../modules/provider-orchestration/change-role-assignment-grant.ts';
import type { AgentRole } from '../modules/provider-orchestration/agent-role-plan.ts';
import type { ChangeRoleAssignmentRecordV1 } from '../modules/provider-orchestration/change-role-assignment-record.ts';
import type { ProviderInvocationRequest } from '../modules/provider-orchestration/provider-contracts.ts';
import { resolveCurrentAgentRuntimeAssignmentPreGrantV1 } from './change-role-assignment-production.ts';
import { inspectHistoricalChangeRoleAssignmentRecordV1 } from '../runtime/storage-journal/change-role-assignment-store.ts';
import {
  activateChangeRoleAssignmentGrant,
  observeChangeRoleAssignmentGrantActivation,
} from '../runtime/storage-journal/change-role-assignment-grant-store.ts';
import {
  readProviderInvocation,
  readProviderInvocationRequest,
} from '../runtime/storage-journal/provider-invocation-store.ts';
import { discoverRepository } from '../runtime/repository-transaction/git.ts';
import { loadInvestigationRuntimeContext } from './lifecycle-context.ts';

const ROLE_BY_PURPOSE = Object.freeze({
  survey: 'author',
  'plan-review': 'reviewer',
  'task-diff-review': 'reviewer',
  'task-implementation': 'builder',
} as const satisfies Readonly<
  Record<ProviderInvocationRequest['purpose'], AgentRole>
>);

type ChangeRoleAssignmentGrantProductionOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  configFilePath?: string;
}>;

const CURRENT_SOURCE_DRIFT_CODES = new Set([
  'CHANGE_ROLE_ASSIGNMENT_GRANT_CURRENT_MANIFEST_REQUIRED',
  'AGENT_RUNTIME_CURRENT_MANIFEST_REQUIRED',
  'AGENT_RUNTIME_DATA_AUTHORIZATION_STALE',
  'AGENT_PROVIDER_CONFIG_FILE_STALE',
  'AGENT_RUNTIME_ASSIGNMENT_SOURCE_STALE',
  'AGENT_RUNTIME_ASSIGNMENT_UNSATISFIED',
  'AGENT_RUNTIME_DATA_AUTHORIZATION_DENIED',
  'AGENT_RUNTIME_PROVIDER_REGISTRY_MISMATCH',
  'AGENT_RUNTIME_DEFINITION_MISMATCH',
]);

export function createProductionChangeRoleAssignmentGrantPort(
  cwd: string,
  options: ChangeRoleAssignmentGrantProductionOptions = {},
): ChangeRoleAssignmentGrantPort {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const context = loadInvestigationRuntimeContext(repositoryRoot);
  return Object.freeze({
    observe(candidate: ChangeRoleAssignmentGrantParametersV1) {
      const parameters = assertChangeRoleAssignmentGrantParameters(candidate);
      const observation = observeChangeRoleAssignmentGrantActivation(
        context.runtime,
        parameters,
      );
      if (observation.activation === null) {
        try {
          assertPreparedInvocationMatches(
            repositoryRoot,
            context.runtime,
            parameters,
            readProviderInvocation(context.runtime, parameters.invocationId),
            readProviderInvocationRequest(
              context.runtime,
              parameters.invocationId,
            ),
            options,
          );
        } catch (error) {
          rethrowChangeRoleAssignmentGrantCurrentSourceDrift(error);
        }
      }
      return observation;
    },
    activate(transitionContext) {
      const parameters = assertChangeRoleAssignmentGrantParameters(
        transitionContext.parameters,
      );
      try {
        assertPreparedInvocationMatches(
          repositoryRoot,
          context.runtime,
          parameters,
          readProviderInvocation(context.runtime, parameters.invocationId),
          readProviderInvocationRequest(
            context.runtime,
            parameters.invocationId,
          ),
          options,
        );
      } catch (error) {
        rethrowChangeRoleAssignmentGrantCurrentSourceDrift(error);
      }
      return activateChangeRoleAssignmentGrant(
        context.runtime,
        transitionContext,
      );
    },
  });
}

/**
 * Terminalize only an obsolete, pre-effect role-assignment challenge. This
 * does not authorize the denied state: after repair the caller must create a
 * fresh challenge bound to the newly current sources.
 */
export function rethrowChangeRoleAssignmentGrantCurrentSourceDrift(
  error: unknown,
): never {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : null;
  if (code !== null && CURRENT_SOURCE_DRIFT_CODES.has(code)) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_STATE_CHANGED',
      'The current role-assignment sources changed before the Central Grant transition applied an effect; the old challenge is invalid and a fresh Grant is required after repair.',
      ExitCode.staleState,
      { details: { sourceErrorCode: code } },
    );
  }
  throw error;
}

export function observeCurrentChangeRoleAssignmentGrantForInvocation(
  cwd: string,
  requestedInvocationId: string,
  options: ChangeRoleAssignmentGrantProductionOptions = {},
): ChangeRoleAssignmentGrantObservationV1 {
  const repositoryRoot = discoverRepository(cwd).repositoryRoot;
  const context = loadInvestigationRuntimeContext(repositoryRoot);
  const invocation = readProviderInvocation(
    context.runtime,
    requestedInvocationId,
  );
  const request = readProviderInvocationRequest(
    context.runtime,
    requestedInvocationId,
  );
  if (invocation.state !== 'prepared') {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_NOT_PREPARED',
      'The exact provider invocation must remain prepared while Central Grant authorization is pending.',
      ExitCode.conflict,
    );
  }
  const planningGeneration = currentPlanningGeneration(
    repositoryRoot,
    invocation.changeId,
  );
  const historical = inspectHistoricalChangeRoleAssignmentRecordV1(
    context.runtime,
    invocation.changeId,
    planningGeneration,
  );
  const record = historical?.record;
  if (record?.grantRequirement === null || record === undefined) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_NOT_APPLICABLE',
      'The exact provider invocation has no durable below-floor role assignment requiring Central Grant.',
      ExitCode.guard,
    );
  }
  assertRecordMatchesRequest(record, request);
  assertCurrentRecordMatches(repositoryRoot, record, request, options);
  const parameters: ChangeRoleAssignmentGrantParametersV1 = Object.freeze({
    schemaVersion: 1,
    kind: 'change-role-assignment-grant-activation.v1',
    repositoryId: request.repositoryId,
    changeId: record.changeId,
    planningGeneration: record.planningGeneration,
    invocationId: request.invocationId,
    recordDigest: record.recordDigest,
    assignmentDigest: record.assignmentDigest,
    grantRequirementDigest: changeRoleAssignmentGrantRequirementDigestV1(
      record.grantRequirement,
    ),
    exactRolePairs: record.grantRequirement.exactRolePairs,
  });
  return createProductionChangeRoleAssignmentGrantPort(
    repositoryRoot,
    options,
  ).observe(parameters);
}

function assertPreparedInvocationMatches(
  repositoryRoot: string,
  _runtime: ReturnType<typeof loadInvestigationRuntimeContext>['runtime'],
  parameters: ChangeRoleAssignmentGrantParametersV1,
  invocation: ReturnType<typeof readProviderInvocation>,
  request: ReturnType<typeof readProviderInvocationRequest>,
  options: ChangeRoleAssignmentGrantProductionOptions,
): void {
  if (
    invocation.state !== 'prepared' ||
    invocation.invocationId !== parameters.invocationId ||
    invocation.changeId !== parameters.changeId ||
    request.invocationId !== parameters.invocationId ||
    request.repositoryId !== parameters.repositoryId
  ) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_STATE_CHANGED',
      'The prepared provider invocation changed after the Central Grant challenge was issued.',
      ExitCode.staleState,
    );
  }
  if (
    currentPlanningGeneration(repositoryRoot, parameters.changeId) !==
    parameters.planningGeneration
  ) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_STATE_CHANGED',
      'The current Manifest generation changed after the Central Grant challenge was issued.',
      ExitCode.staleState,
    );
  }
  const historical = inspectHistoricalChangeRoleAssignmentRecordV1(
    _runtime,
    parameters.changeId,
    parameters.planningGeneration,
  );
  if (historical === null) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_STATE_CHANGED',
      'The exact role assignment is no longer durable.',
      ExitCode.staleState,
    );
  }
  assertRecordMatchesRequest(historical.record, request);
  assertCurrentRecordMatches(
    repositoryRoot,
    historical.record,
    request,
    options,
  );
}

function assertCurrentRecordMatches(
  repositoryRoot: string,
  record: ChangeRoleAssignmentRecordV1,
  request: ProviderInvocationRequest,
  options: ChangeRoleAssignmentGrantProductionOptions,
): void {
  const configFilePath =
    options.configFilePath ??
    (options.environment ?? process.env).JIGWRIGHT_AGENT_PROVIDER_CONFIG;
  if (configFilePath === undefined) {
    throw workflowError(
      'AGENT_RUNTIME_PROVIDER_CONFIG_REQUIRED',
      'Role-assignment Central Grant requires the same explicit host provider configuration used by the provider worker.',
      ExitCode.unsafeEnvironment,
    );
  }
  const current = resolveCurrentAgentRuntimeAssignmentPreGrantV1({
    repositoryRoot,
    changeId: record.changeId,
    request,
    configFilePath,
    platform: options.platform ?? process.platform,
  });
  if (canonicalJson(current) !== canonicalJson(record)) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_STATE_CHANGED',
      'The current authority-eligible role assignment changed after the Central Grant challenge was issued.',
      ExitCode.staleState,
    );
  }
}

function assertRecordMatchesRequest(
  record: ChangeRoleAssignmentRecordV1,
  request: ProviderInvocationRequest,
): void {
  const role = ROLE_BY_PURPOSE[request.purpose];
  const placement = record.resolution.placements.find(
    (candidate) => candidate.role === role,
  );
  const profile = record.host.configuration.providers.find(
    (candidate) => candidate.id === placement?.profileId,
  );
  if (
    record.changeId.length === 0 ||
    record.dataAuthorization.snapshot.policyDigest !== request.policyDigest ||
    record.dataAuthorization.snapshot.relevantTargetDigest !==
      request.targetDigest ||
    placement === undefined ||
    profile === undefined ||
    profile.family !== request.providerId
  ) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_INVOCATION_MISMATCH',
      'The durable role assignment does not match the exact provider invocation requesting Central Grant.',
      ExitCode.verification,
    );
  }
}

function currentPlanningGeneration(
  repositoryRoot: string,
  changeId: string,
): string {
  const contract = loadChangeContract(repositoryRoot, changeId);
  const manifest = contract.investigation?.manifest;
  if (
    manifest?.schemaVersion !== 3 ||
    typeof manifest.manifestDigest !== 'string'
  ) {
    throw workflowError(
      'CHANGE_ROLE_ASSIGNMENT_GRANT_CURRENT_MANIFEST_REQUIRED',
      'Role-assignment Central Grant requires the current authoritative Manifest v3.',
      ExitCode.verification,
    );
  }
  return manifest.manifestDigest;
}
