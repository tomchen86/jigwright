/**
 * Run reviewed provider profiles through preflight and one governed synchronous or asynchronous lifecycle.
 *
 * Invariants:
 * - Provider selection, authority reads, projection checks, and launch ordering stay exact.
 * - Concurrency cleanup and wrapper error handling remain attached to each runner lifecycle.
 */

import path from 'node:path';
import { preflightProviderSnapshot } from './provider-runner-preflight.ts';

import { spawnSync } from 'node:child_process';
import { AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT } from '../provider-policy/ai-adapter-policy.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { loadWorkflowConfig } from '../repository-observation/workflow-configuration.ts';
import { createProviderExecutionEnvironment } from '../process-environment/execution-environment.ts';
import { executionJobStatePath } from '../storage-journal/execution-store.ts';
import {
  discoverRepository,
  captureGovernedProviderProjection,
  compareGovernedProviderProjections,
} from '../repository-transaction/git.ts';
import { readPrivateCanonicalJson } from '../storage-journal/investigation-private-files.ts';
import {
  investigationRuntimePaths,
  type InvestigationRuntimePaths,
} from '../session-workspace/paths.ts';
import { assertInvocationId } from '../../foundation/repository-path/repository-path.ts';
import {
  readProviderInvocationRequest,
  readProviderExecutionPolicySnapshot,
  providerExecutionPolicySnapshotPath,
} from '../storage-journal/provider-invocation-store.ts';
import {
  type ProviderId,
  isProviderId,
} from '../../modules/provider-orchestration/provider-registry.ts';
import {
  providerPromptContextStoreRoot,
  assembleProviderPromptManifest,
  readProviderRepairPrompt,
  assertProviderPromptContextCurrent,
} from '../storage-journal/provider-execution-governance.ts';
import {
  type BuiltInProviderAdapterCatalog,
  type ProviderExecutableIdentity,
  type ProviderProcessOutcome,
  type ProviderRunnerReport,
  type ProviderInvocationPlan,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import type {
  AgentRuntimeProcessActivity,
  AgentRuntimeSingleShotInput,
  ProviderInvocationAcceptanceBinding,
  AgentRuntimeSingleShotOptions,
  AgentRuntimeAsyncSingleShotOptions,
  AgentRuntimeGovernedInput,
} from '../../modules/provider-orchestration/agent-runtime-port.ts';
import { type ProviderWrapperProtocolExecution } from '@jigwright/core/harness-jsonl-v1-contracts';
import { PROVIDER_RUNNER_RESIDUALS } from '../../modules/provider-orchestration/provider-runtime-evidence.ts';
import {
  type BuiltInReviewedProviderProfileSnapshot,
  assertAgentProviderProfileSnapshot,
} from '@jigwright/core/agent-provider-config';
import { type ProviderDefinitionSnapshot } from '@jigwright/core/provider-definition-snapshot';
import {
  type ProviderExecutableObservation,
  inspectProviderExecutable,
} from '@jigwright/agent-runtime/provider-executable-identity';
import { spawnBoundedProviderProcess } from './bounded-provider-process.ts';
import { resolveBuiltInProviderDefinitionSnapshot } from '@jigwright/core/built-in-provider-definition';
import {
  type ProviderPreflightSpec,
  normalizeCandidateInspection,
} from './provider-runner-preflight.ts';
import {
  requestUnbound,
  providerProfileStale,
  wrapperProtocolAsyncRequired,
  isPromiseLike,
  configBaselineMismatch,
  runtimeDirectoryUnsafe,
  durableRequestMismatch,
  repositoryMismatch,
  inputManifestMismatch,
  sha256,
  isRecord,
  policyBaselineMismatch,
  baselineMismatch,
  policyMismatch,
  providerDisabled,
  outputSchemaUnbound,
  providerUnavailable,
  executableIdentityDrift,
  governedProjectionDrift,
  wrapperReportedError,
  wrapperProtocolInvalid,
  deepFreeze,
} from './provider-runner-values.ts';
import {
  fileDigestAtBaseline,
  readPlainFileDigest,
  canonicalDirectoryOrThrow,
  createExclusiveRuntimeDirectory,
  createExclusiveRuntimeFile,
  assertExclusiveRuntimeFile,
  sameIdentity,
} from './provider-runner-files.ts';
import { renderManagedProviderPrompt } from './provider-runner-prompts.ts';
import { acquireProviderSlot } from './provider-runner-slots.ts';
import {
  tryReadWrapperProtocolReceipt,
  enforceProcessOutcome,
  observeProtocolReceipt,
  enforceRawOutputLimit,
  readWrapperProtocolReceipt,
  readNativeSemanticOutput,
  readWrapperSemanticOutput,
  validateSemanticOutput,
} from './provider-runner-output.ts';

export type {
  ProviderExecutableIdentity,
  ProviderRunnerReport,
} from '../../modules/provider-orchestration/provider-contracts.ts';
export { PROVIDER_RUNNER_RESIDUALS } from '../../modules/provider-orchestration/provider-runtime-evidence.ts';

export type ProviderProbeInput = {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type ProviderExecuteInput = ProviderProbeInput & {
  stdinSource: string;
  stdinContent: Buffer;
};

export type ProviderAsyncExecutionControl = Readonly<{
  signal?: AbortSignal;
  onActivity?: (event: AgentRuntimeProcessActivity) => void;
  wrapperProtocol?: ProviderWrapperProtocolExecution;
}>;

/**
 * The injectable host of real operating-system effects. Only the explicitly
 * named `createProviderRunnerForTesting` seam may substitute this; the
 * production `preflightBuiltInProvider`/`runBuiltInProvider` surface always uses
 * the real code-owned operations.
 */
export type ProviderRunnerHost = {
  inspectCandidate(
    candidatePath: string,
  ): ProviderExecutableIdentity | ProviderExecutableObservation | null;
  runProbe(input: ProviderProbeInput): ProviderProcessOutcome;
  execute(input: ProviderExecuteInput): ProviderProcessOutcome;
  executeAsync?(
    input: ProviderExecuteInput,
    control: ProviderAsyncExecutionControl,
  ): Promise<ProviderProcessOutcome>;
};

export type ProviderPreflightOptions = {
  platform: NodeJS.Platform;
  enabled: boolean;
  sourceEnvironment: NodeJS.ProcessEnv;
  temporaryDirectory: string;
};

export type ProviderResolutionStatus =
  | 'disabled'
  | 'unsupported-platform'
  | 'absent'
  | 'unsafe-candidate'
  | 'incompatible'
  | 'unauthenticated'
  | 'available';

export type ProviderResolution = {
  status: ProviderResolutionStatus;
  executable?: ProviderExecutableIdentity;
  version?: string;
};

export type ProviderRunInput = Omit<
  AgentRuntimeSingleShotInput,
  'semanticOutputSchema' | 'acceptanceBinding' | 'reviewSnapshotRoot'
> & {
  semanticOutputSchema: unknown;
  acceptanceBinding?: ProviderInvocationAcceptanceBinding;
  reviewSnapshotRoot?: string | null;
};

export type ProviderRunOptions = AgentRuntimeSingleShotOptions;

export type ProviderAsyncRunOptions = AgentRuntimeAsyncSingleShotOptions;

function preflightSpecs(
  adapters: BuiltInProviderAdapterCatalog,
): Readonly<Record<ProviderId, ProviderPreflightSpec>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(adapters).map(([providerId, adapter]) => [
        providerId,
        adapter.preflight,
      ]),
    ),
  ) as Readonly<Record<ProviderId, ProviderPreflightSpec>>;
}

type ProviderRunner = {
  preflight(
    providerId: ProviderId,
    options: ProviderPreflightOptions,
  ): ProviderResolution;
  preflightProfile(
    profile: BuiltInReviewedProviderProfileSnapshot,
    options: ProviderPreflightOptions,
  ): ProviderResolution;
  run(
    input: ProviderRunInput,
    options: ProviderRunOptions,
  ): ProviderRunnerReport;
  runAsync(
    input: ProviderRunInput,
    options: ProviderAsyncRunOptions,
  ): Promise<ProviderRunnerReport>;
};

/**
 * The only sanctioned host-injection seam. Tests pass a deterministic host so
 * bounded provider behaviour is exercised without spawning a real process.
 */
export function createProviderRunnerForTesting(
  adapters: BuiltInProviderAdapterCatalog,
  host: ProviderRunnerHost,
): ProviderRunner {
  return createProviderRunner(adapters, host);
}

/**
 * Production preflight using real, code-owned filesystem and process
 * operations. It resolves only the fixed reviewed candidates, canonicalizes and
 * inspects executable identity, and runs bounded version/help/auth probes. It
 * never invokes a model.
 */
export function preflightBuiltInProvider(
  adapters: BuiltInProviderAdapterCatalog,
  providerId: ProviderId,
  options: ProviderPreflightOptions,
): ProviderResolution {
  return createProviderRunner(adapters, realProviderRunnerHost()).preflight(
    providerId,
    options,
  );
}

/**
 * Production preflight for the one immutable host profile selected by the
 * assignment. It never falls through to another safe family candidate.
 */
export function preflightBuiltInProviderProfile(
  adapters: BuiltInProviderAdapterCatalog,
  profile: BuiltInReviewedProviderProfileSnapshot,
  options: ProviderPreflightOptions,
): ProviderResolution {
  return createProviderRunner(
    adapters,
    realProviderRunnerHost(),
  ).preflightProfile(profile, options);
}

/**
 * Production run using real, code-owned operations. This is the lifecycle-only
 * launch surface: it never proposes, completes, or persists durable results
 * (those belong to the invocation store/lifecycle); it only performs one bounded
 * read-only launch and returns the non-durable observation.
 */
export function runBuiltInProvider(
  adapters: BuiltInProviderAdapterCatalog,
  input: ProviderRunInput,
  options: ProviderRunOptions,
): ProviderRunnerReport {
  if (input.acceptanceBinding === undefined) {
    throw requestUnbound();
  }
  return createProviderRunner(adapters, realProviderRunnerHost()).run(
    input,
    options,
  );
}

/**
 * Async production launch preserving the exact single-shot validation and
 * projection contract while replacing only the model process wait with spawn.
 */
export async function runBuiltInProviderAsync(
  adapters: BuiltInProviderAdapterCatalog,
  input: ProviderRunInput,
  options: ProviderAsyncRunOptions,
): Promise<ProviderRunnerReport> {
  if (input.acceptanceBinding === undefined) {
    throw requestUnbound();
  }
  return await createProviderRunner(
    adapters,
    realProviderRunnerHost(),
  ).runAsync(input, options);
}

function createProviderRunner(
  adapters: BuiltInProviderAdapterCatalog,
  host: ProviderRunnerHost,
): ProviderRunner {
  function preflight(
    providerId: ProviderId,
    options: ProviderPreflightOptions,
  ): ProviderResolution {
    if (!options.enabled) {
      return { status: 'disabled' };
    }
    const definitionSnapshot = resolveBuiltInProviderDefinitionSnapshot(
      providerId,
      options.platform,
    );
    if (definitionSnapshot === null) {
      return { status: 'unsupported-platform' };
    }
    return preflightProviderSnapshot(
      host,
      preflightSpecs(adapters),
      definitionSnapshot,
      options,
    );
  }

  function preflightProfile(
    rawProfile: BuiltInReviewedProviderProfileSnapshot,
    options: ProviderPreflightOptions,
  ): ProviderResolution {
    if (!options.enabled) return { status: 'disabled' };
    const profile = assertAgentProviderProfileSnapshot(
      rawProfile,
      options.platform,
    );
    if (
      profile.trustTier !== 'built-in-reviewed' ||
      !isProviderId(profile.family)
    ) {
      throw providerProfileStale();
    }
    const definitionSnapshot = resolveBuiltInProviderDefinitionSnapshot(
      profile.family,
      options.platform,
    );
    if (
      definitionSnapshot === null ||
      definitionSnapshot.protocol !== profile.protocol ||
      !definitionSnapshot.executableCandidates.includes(profile.executable)
    ) {
      throw providerProfileStale();
    }
    return preflightProviderSnapshot(
      host,
      preflightSpecs(adapters),
      definitionSnapshot,
      options,
      profile.executable,
    );
  }

  function run(
    input: ProviderRunInput,
    options: ProviderRunOptions,
  ): ProviderRunnerReport {
    if (input.wrapperProtocol !== undefined) {
      throw wrapperProtocolAsyncRequired();
    }
    const result = runWithExecution(input, options, host.execute);
    if (isPromiseLike(result)) {
      throw new TypeError('Synchronous provider execution returned a promise.');
    }
    return result;
  }

  async function runAsync(
    input: ProviderRunInput,
    options: ProviderAsyncRunOptions,
  ): Promise<ProviderRunnerReport> {
    if (host.executeAsync === undefined) {
      throw new TypeError('Async provider execution host is unavailable.');
    }
    const wrapperProtocol = createWrapperProtocolExecution(input);
    return await runWithExecution(
      input,
      options,
      (executeInput) =>
        host.executeAsync!(executeInput, {
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.onActivity === undefined
            ? {}
            : { onActivity: options.onActivity }),
          ...(wrapperProtocol === null ? {} : { wrapperProtocol }),
        }),
      options.onProtocolReceipt,
    );
  }

  function runWithExecution(
    input: ProviderRunInput,
    options: ProviderRunOptions,
    execute: (
      executeInput: ProviderExecuteInput,
    ) => ProviderProcessOutcome | Promise<ProviderProcessOutcome>,
    onProtocolReceipt?: AgentRuntimeAsyncSingleShotOptions['onProtocolReceipt'],
  ): ProviderRunnerReport | Promise<ProviderRunnerReport> {
    const git = discoverRepository(input.repositoryRoot);
    const config = loadWorkflowConfig(input.repositoryRoot);
    if (
      fileDigestAtBaseline(
        input.repositoryRoot,
        git.head,
        'workflow/config.json',
      ) !==
      readPlainFileDigest(
        path.join(input.repositoryRoot, 'workflow', 'config.json'),
        configBaselineMismatch,
      )
    ) {
      throw configBaselineMismatch();
    }
    const paths = investigationRuntimePaths(
      git.gitCommonDirectory,
      config.runtimeDirectory,
    );
    const invocationId = assertInvocationId(input.request.invocationId);

    // 1. Accept only the exact configured investigation invocation directory for
    //    this request's invocationId — never the worktree or an arbitrary
    //    Git-common location.
    const expectedDirectory = path.join(paths.invocations, invocationId);
    if (
      canonicalDirectoryOrThrow(input.invocationDirectory) !== expectedDirectory
    ) {
      throw runtimeDirectoryUnsafe(input.invocationDirectory);
    }

    // 2. Reconstruct and match the durable canonical request, validate the
    //    repository identity and provider binding, and validate the canonical
    //    manifest digest against the request before any launch.
    const durableRequest = readProviderInvocationRequest(paths, invocationId);
    if (canonicalJson(durableRequest) !== canonicalJson(input.request)) {
      throw durableRequestMismatch();
    }
    if (input.providerId !== input.request.providerId) {
      throw requestUnbound();
    }
    if (input.request.repositoryId !== config.repositoryName) {
      throw repositoryMismatch();
    }
    const manifestValue = readPrivateCanonicalJson(
      paths,
      path.join(expectedDirectory, 'manifest.json'),
      inputManifestMismatch,
    );
    if (
      sha256(canonicalJson(manifestValue)) !== input.request.inputManifestDigest
    ) {
      throw inputManifestMismatch();
    }
    const expectedReviewSnapshotRoot = path.join(
      expectedDirectory,
      'review-root',
    );
    const reviewSnapshotRoot = input.reviewSnapshotRoot ?? null;
    const manifestHasPlanningTarget =
      isRecord(manifestValue) &&
      manifestValue.kind === 'plan-review-manifest' &&
      isRecord(manifestValue.planningTarget);
    const requiresPlanningSnapshot =
      input.request.purpose === 'plan-review' && manifestHasPlanningTarget;
    if (
      (requiresPlanningSnapshot &&
        (reviewSnapshotRoot === null ||
          canonicalDirectoryOrThrow(reviewSnapshotRoot) !==
            expectedReviewSnapshotRoot)) ||
      (!requiresPlanningSnapshot && reviewSnapshotRoot !== null)
    ) {
      throw inputManifestMismatch();
    }
    const contextStoreRoot = providerPromptContextStoreRoot(expectedDirectory);
    const ownerWorkflowId =
      input.acceptanceBinding?.ownerWorkflowId ??
      'investigation-provider-runner-test';
    if (
      input.acceptanceBinding !== undefined &&
      (input.acceptanceBinding.invocationId !== invocationId ||
        input.acceptanceBinding.requestDigest !== input.request.requestDigest)
    ) {
      throw requestUnbound();
    }
    const currentManifestValue = assembleProviderPromptManifest(
      contextStoreRoot,
      input.request,
      manifestValue,
      ownerWorkflowId,
    );
    const managedPrompt = renderManagedProviderPrompt(
      input.request,
      currentManifestValue,
      reviewSnapshotRoot,
      readProviderRepairPrompt(paths, input.request),
    );

    // 3. Keep the tracked policy bytes pinned to the immutable semantic Git
    //    baseline, then load the separately durable per-Attempt execution policy.
    //    This lets a retry adopt newly authorized execution limits without
    //    rebasing the repository content it is reviewing.
    const baselinePolicy =
      AI_ADAPTER_DATA_AUTHORIZATION_POLICY_PORT.readCurrent(
        input.repositoryRoot,
      );
    if (
      fileDigestAtBaseline(
        input.repositoryRoot,
        git.head,
        'workflow/ai-adapter-policy.json',
      ) !== baselinePolicy.digest
    ) {
      throw policyBaselineMismatch();
    }
    if (
      input.request.baseCommit !== git.head ||
      input.request.baseTree !== git.tree
    ) {
      throw baselineMismatch();
    }
    const { loaded, snapshot } = readProviderExecutionPolicySnapshot(
      paths,
      input.request,
    );
    if (input.request.policyDigest !== loaded.digest) {
      throw policyMismatch();
    }
    const providerPolicy = loaded.policy.providers[input.providerId];
    if (!providerPolicy || !providerPolicy.enabled) {
      throw providerDisabled(input.providerId);
    }
    if (
      (input.request.limits.timeoutMs > loaded.policy.limits.timeoutMs &&
        snapshot.schemaVersion !== 3) ||
      input.request.limits.aggregateOutputBytes >
        loaded.policy.limits.aggregateOutputBytes
    ) {
      throw policyMismatch();
    }
    if (
      sha256(canonicalJson(input.semanticOutputSchema)) !==
      input.request.outputSchema.digest
    ) {
      throw outputSchemaUnbound();
    }

    // 4. Acquire a repository-wide concurrency slot before launch; release it in
    //    finally so a failure never leaks the owned slot.
    const slot = acquireProviderSlot(
      paths,
      loaded.policy.limits.maxConcurrent,
      invocationId,
    );
    let releaseSynchronously = true;
    try {
      // 5. Create a fresh private runtime directory and engine files with
      //    exclusive no-follow 0600 single-link ownership so a preplanted
      //    symlink or hardlink is rejected without truncation.
      const runtimeDirectory = path.join(expectedDirectory, 'runtime');
      createExclusiveRuntimeDirectory(runtimeDirectory);
      const promptPath = path.join(runtimeDirectory, 'prompt.json');
      const schemaPath = path.join(runtimeDirectory, 'schema.json');
      const semanticOutputPath = path.join(
        runtimeDirectory,
        'semantic-output.json',
      );
      const schemaContent = canonicalJson(input.semanticOutputSchema);
      const promptIdentity = createExclusiveRuntimeFile(
        promptPath,
        managedPrompt,
      );
      const schemaIdentity = createExclusiveRuntimeFile(
        schemaPath,
        schemaContent,
      );
      const semanticOutputIdentity = createExclusiveRuntimeFile(
        semanticOutputPath,
        '',
      );

      // The engine prompt and schema are automatically part of the governed
      // runtime-input fingerprint, so a provider that mutates either is observed
      // as drift and can never yield a successful result.
      const governedRuntimeInputs: AgentRuntimeGovernedInput[] = [
        ...input.governedRuntimeInputs,
        ...(input.acceptanceBinding === undefined
          ? []
          : providerAcceptanceGovernedRuntimeInputs(
              paths,
              input.acceptanceBinding,
            )),
        ...providerInvocationDurableGovernedRuntimeInputs(paths, invocationId),
        {
          id: 'engine-runtime-tree',
          path: runtimeDirectory,
          kind: 'directory-closure',
          expectedFiles: ['prompt.json', 'schema.json', 'semantic-output.json'],
          mutableContentPaths: ['semantic-output.json'],
        },
        { id: 'engine-prompt', path: promptPath },
        { id: 'engine-schema', path: schemaPath },
      ];

      // 6. Capture the governed before snapshot before any provider
      //    version/help/auth process, and compare after the whole preflight plus
      //    model execution.
      const before = captureGovernedProviderProjection(
        input.repositoryRoot,
        governedRuntimeInputs,
      );

      const providerDefinitionSnapshot =
        resolveBuiltInProviderDefinitionSnapshot(
          input.providerId,
          options.platform,
        );
      if (providerDefinitionSnapshot === null) {
        throw providerUnavailable(input.providerId, 'unsupported-platform');
      }
      const selectedProfile = selectedBuiltInProfile(
        input,
        providerDefinitionSnapshot,
        options.platform,
      );
      const resolution = preflightProviderSnapshot(
        host,
        preflightSpecs(adapters),
        providerDefinitionSnapshot,
        {
          platform: options.platform,
          enabled: true,
          sourceEnvironment: input.sourceEnvironment,
          temporaryDirectory: runtimeDirectory,
        },
        selectedProfile?.executable,
      );
      if (resolution.status !== 'available' || !resolution.executable) {
        throw providerUnavailable(input.providerId, resolution.status);
      }
      const identityBefore = resolution.executable;

      // Preflight executes provider-owned version/help/auth code. Revalidate all
      // three engine files against their creation-time inode and exact expected
      // bytes before the model process receives any path. The prompt itself is
      // fed from the already-rendered in-memory bytes below.
      assertExclusiveRuntimeFile(promptPath, promptIdentity, managedPrompt);
      assertExclusiveRuntimeFile(schemaPath, schemaIdentity, schemaContent);
      assertExclusiveRuntimeFile(
        semanticOutputPath,
        semanticOutputIdentity,
        '',
      );

      const plan = buildInvocationPlan(
        adapters,
        input,
        identityBefore.realPath,
        {
          promptPath,
          schemaPath,
          semanticOutputPath,
        },
      );
      const environment = createProviderExecutionEnvironment(
        input.providerId,
        process.execPath,
        runtimeDirectory,
        input.sourceEnvironment,
      );

      const outcome = execute({
        executable: plan.executable,
        args: plan.args,
        cwd: plan.cwd,
        environment,
        stdinSource: plan.stdinSource,
        stdinContent: Buffer.from(managedPrompt, 'utf8'),
        timeoutMs: input.request.limits.timeoutMs,
        maxOutputBytes: input.request.limits.aggregateOutputBytes,
      });

      const finalizeOutcome = (
        completedOutcome: ProviderProcessOutcome,
      ): ProviderRunnerReport => {
        if (input.acceptanceBinding !== undefined) {
          assertProviderPromptContextCurrent(
            contextStoreRoot,
            input.acceptanceBinding.context,
          );
        }

        // Re-check executable identity around the launch.
        const currentInspection = normalizeCandidateInspection(
          identityBefore.candidatePath,
          host.inspectCandidate(identityBefore.candidatePath),
        );
        if (
          currentInspection.state !== 'observed' ||
          !sameIdentity(identityBefore, currentInspection.identity)
        ) {
          throw executableIdentityDrift();
        }
        const identityAfter = currentInspection.identity;

        const after = captureGovernedProviderProjection(
          input.repositoryRoot,
          governedRuntimeInputs,
        );
        const projection = compareGovernedProviderProjections(before, after);

        const failureProtocolReceipt = tryReadWrapperProtocolReceipt(
          input,
          completedOutcome,
        );
        try {
          enforceProcessOutcome(
            completedOutcome,
            input.request.limits.timeoutMs,
          );
        } catch (error) {
          if (
            failureProtocolReceipt !== null &&
            failureProtocolReceipt.terminal !== 'result'
          ) {
            observeProtocolReceipt(onProtocolReceipt, failureProtocolReceipt);
          }
          throw error;
        }
        enforceRawOutputLimit(
          completedOutcome,
          input.request.limits.aggregateOutputBytes,
        );

        if (!projection.unchanged) {
          throw governedProjectionDrift(projection.changedCategories);
        }

        const wrapperProtocolReceipt = readWrapperProtocolReceipt(
          input,
          completedOutcome,
        );
        if (wrapperProtocolReceipt !== null) {
          if (wrapperProtocolReceipt.terminal === 'error') {
            observeProtocolReceipt(onProtocolReceipt, wrapperProtocolReceipt);
            throw wrapperReportedError();
          }
          if (
            wrapperProtocolReceipt.terminal !== 'result' ||
            wrapperProtocolReceipt.outputSlot !== 'primary'
          ) {
            observeProtocolReceipt(onProtocolReceipt, wrapperProtocolReceipt);
            throw wrapperProtocolInvalid();
          }
        }

        const semanticOutput =
          wrapperProtocolReceipt === null
            ? readNativeSemanticOutput(
                input.providerId,
                completedOutcome,
                semanticOutputPath,
                input.request.limits.aggregateOutputBytes,
              )
            : readWrapperSemanticOutput(
                completedOutcome,
                semanticOutputPath,
                input.request.limits.aggregateOutputBytes,
              );
        validateSemanticOutput(input, semanticOutput);

        const report: ProviderRunnerReport = {
          invocationId: input.request.invocationId,
          providerId: input.providerId,
          purpose: input.request.purpose,
          requestDigest: input.request.requestDigest,
          semanticOutput,
          semanticOutputDigest: sha256(canonicalJson(semanticOutput)),
          assurance: 'unchanged-governed-projection',
          projection,
          sameUserProcessConfined: false,
          residuals: [...PROVIDER_RUNNER_RESIDUALS],
          executable: identityAfter,
          elapsedMs: completedOutcome.elapsedMs,
          providerDefinitionSnapshot,
          ...(wrapperProtocolReceipt === null
            ? {}
            : { wrapperProtocolReceipt }),
        };
        return deepFreeze(report);
      };

      if (isPromiseLike(outcome)) {
        releaseSynchronously = false;
        return Promise.resolve(outcome)
          .then(finalizeOutcome)
          .finally(slot.release);
      }
      return finalizeOutcome(outcome);
    } finally {
      if (releaseSynchronously) slot.release();
    }
  }

  return { preflight, preflightProfile, run, runAsync };
}

function selectedBuiltInProfile(
  input: ProviderRunInput,
  definition: ProviderDefinitionSnapshot,
  platform: NodeJS.Platform,
): BuiltInReviewedProviderProfileSnapshot | null {
  const binding = input.assignmentBinding;
  if (binding === undefined) return null;
  let profile;
  try {
    profile = assertAgentProviderProfileSnapshot(
      binding.providerProfileSnapshot,
      platform,
    );
  } catch {
    throw providerProfileStale();
  }
  if (
    profile.trustTier !== 'built-in-reviewed' ||
    !isProviderId(profile.family) ||
    profile.family !== input.providerId ||
    profile.id !== binding.providerProfileId ||
    profile.protocol !== definition.protocol ||
    binding.definitionDigest !== definition.definitionDigest ||
    !definition.executableCandidates.includes(profile.executable)
  ) {
    throw providerProfileStale();
  }
  return profile;
}

export function providerAcceptanceGovernedRuntimeInputs(
  paths: InvestigationRuntimePaths,
  binding: ProviderInvocationAcceptanceBinding,
): AgentRuntimeGovernedInput[] {
  const inputs: AgentRuntimeGovernedInput[] = [
    {
      id: 'engine-durable-execution-job',
      path: executionJobStatePath(paths, binding.executionJobId),
    },
    {
      id: 'engine-provider-repair-lineage',
      path: binding.repair.lineagePath,
    },
    {
      id: 'engine-provider-repair-current-evidence',
      path: binding.repair.currentEvidencePath,
    },
  ];
  if (binding.repair.evidencePath !== null) {
    inputs.push({
      id: 'engine-provider-repair-predecessor-evidence',
      path: binding.repair.evidencePath,
    });
  }
  return inputs;
}

export function providerInvocationDurableGovernedRuntimeInputs(
  paths: InvestigationRuntimePaths,
  invocationId: string,
): AgentRuntimeGovernedInput[] {
  const invocationDirectory = path.join(paths.invocations, invocationId);
  return [
    {
      id: 'engine-durable-manifest',
      path: path.join(invocationDirectory, 'manifest.json'),
    },
    {
      id: 'engine-durable-request',
      path: path.join(invocationDirectory, 'request.json'),
    },
    {
      id: 'engine-durable-execution-policy',
      path: providerExecutionPolicySnapshotPath(paths, invocationId),
    },
    {
      id: 'engine-durable-state',
      path: path.join(invocationDirectory, 'state.json'),
    },
  ];
}

function createWrapperProtocolExecution(
  input: ProviderRunInput,
): ProviderWrapperProtocolExecution | null {
  if (input.wrapperProtocol === undefined) return null;
  if (input.wrapperProtocol.protocol !== 'harness-jsonl-v1') {
    throw wrapperProtocolInvalid();
  }
  if (input.acceptanceBinding === undefined) throw requestUnbound();
  return Object.freeze({
    protocol: 'harness-jsonl-v1' as const,
    binding: Object.freeze({
      invocationId: input.request.invocationId,
      requestDigest: input.request.requestDigest,
      attemptId: input.acceptanceBinding.executionAttemptId,
    }),
  });
}

function buildInvocationPlan(
  adapters: BuiltInProviderAdapterCatalog,
  input: ProviderRunInput,
  executable: string,
  paths: { promptPath: string; schemaPath: string; semanticOutputPath: string },
): ProviderInvocationPlan {
  return adapters[input.providerId].buildInvocation({
    executable,
    repositoryRoot: input.repositoryRoot,
    promptPath: paths.promptPath,
    schemaPath: paths.schemaPath,
    semanticOutputPath: paths.semanticOutputPath,
    semanticOutputSchema: input.semanticOutputSchema,
  });
}

// --- Real host, filesystem, and process primitives ------------------------

function realProviderRunnerHost(): ProviderRunnerHost {
  return {
    inspectCandidate: inspectProviderExecutable,
    runProbe: (input) => spawnBoundedProcess(input),
    execute: (input) => spawnBoundedProcess(input, input.stdinContent),
    executeAsync: (input, control) =>
      spawnBoundedProviderProcess({
        executable: input.executable,
        args: input.args,
        cwd: input.cwd,
        environment: input.environment,
        stdinContent: input.stdinContent,
        timeoutMs: input.timeoutMs,
        maxOutputBytes: input.maxOutputBytes,
        ...(control.signal === undefined ? {} : { signal: control.signal }),
        ...(control.onActivity === undefined
          ? {}
          : { onActivity: control.onActivity }),
        ...(control.wrapperProtocol === undefined
          ? {}
          : { wrapperProtocol: control.wrapperProtocol }),
      }),
  };
}

function spawnBoundedProcess(
  input: ProviderProbeInput,
  stdinContent?: Buffer,
): ProviderProcessOutcome {
  const start = process.hrtime.bigint();
  const result = spawnSync(input.executable, input.args, {
    cwd: input.cwd,
    env: input.environment,
    shell: false,
    input: stdinContent,
    timeout: input.timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer: input.maxOutputBytes + 1,
    encoding: 'utf8',
  });
  const elapsedMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
  const timedOut =
    result.error !== undefined &&
    (result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
  const spawnErrorCode =
    result.error !== undefined && !timedOut
      ? ((result.error as NodeJS.ErrnoException).code ?? 'SPAWN_FAILED')
      : null;
  return {
    exitCode: result.status,
    signal: result.signal,
    timedOut,
    spawnErrorCode,
    elapsedMs,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}
