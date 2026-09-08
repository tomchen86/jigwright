/**
 * Bind provider prompts and runtime evidence to the current durable workflow context.
 *
 * Invariants:
 * - Context digests, epoch rollover, retention bindings, and authority checks stay exact.
 * - Public repair APIs continue through the original entrypoint.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  inspectDurableRetentionCatalog,
  storeDurableEvidence,
  inspectDurableEpochContextStore,
  initializeDurableEpochContextStore,
  rolloverDurableEpochContextStore,
  type ContextManifest,
  buildContextManifest,
  type WorkflowContextState,
  assembleCurrentPromptFromStore,
  withCurrentDurableEpochContextStore,
} from '../../modules/authority/execution-governance.ts';
import {
  WorkflowError,
  workflowError,
  ExitCode,
} from '../../foundation/errors/errors.ts';
import { assertInvestigationId } from '../session-workspace/paths.ts';
import type { ProviderInvocationRequest } from '../../modules/provider-orchestration/provider-contracts.ts';
import type { ProviderPromptContextBinding } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import {
  providerContextInvalid,
  isTimestamp,
  sha256Hex,
  providerContextStale,
  digestCanonical,
  isDigest,
} from './provider-governance-values.ts';

export type {
  ProviderPromptContextBinding,
  ProviderRepairAuthorityBinding,
} from '../../modules/provider-orchestration/agent-runtime-port.ts';
export {
  type ProviderRepairFailureInput,
  type ProviderRepairEvidence,
  type ProviderRepairLineage,
  preflightProviderRepairRetry,
  extractProviderRepairFailure,
  persistProviderRepairEvidence,
  readProviderRepairEvidence,
  loadProviderExecutionRepairContext,
  createProviderRepairLineage,
  readProviderRepairLineage,
  readProviderRepairPromptContext,
  readProviderRepairPrompt,
  readProviderRepairAuthorityBinding,
  assertProviderRepairAuthorityCurrent,
} from './provider-repair-governance.ts';

export type ProviderPromptContextRetentionBinding = Readonly<{
  workflowId: string;
  epoch: number;
  contextDigest: string;
  currentEpoch: number;
  currentContextDigest: string;
  currentGeneration: number;
}>;

/**
 * Resolve the investigation root from the already-canonical invocation
 * directory accepted by the provider runner. No repository or caller path is
 * searched for context data.
 */
export function providerPromptContextStoreRoot(
  invocationDirectory: string,
): string {
  const absolute = path.resolve(invocationDirectory);
  const invocations = path.dirname(absolute);
  if (
    !path.isAbsolute(invocationDirectory) ||
    absolute !== invocationDirectory ||
    path.basename(invocations) !== 'invocations'
  ) {
    throw providerContextInvalid(
      'Provider invocation directory is not an exact runtime invocation path.',
    );
  }
  return path.dirname(invocations);
}

/**
 * Materialize the provider input manifest as the sole item in an
 * exact durable epoch context. Replays verify the complete expected manifest;
 * they never discover or append evidence by walking historical storage.
 */
export function ensureProviderPromptContext(
  storeRoot: string,
  request: ProviderInvocationRequest,
  manifestValue: unknown,
  requestedOwnerWorkflowId: string,
): ProviderPromptContextBinding {
  return resolveProviderPromptContext(
    storeRoot,
    request,
    manifestValue,
    requestedOwnerWorkflowId,
    { allowRollover: false, now: new Date() },
  );
}

/**
 * Publish the context selected by a newly-created lifecycle-owned invocation.
 * This is the sole provider bridge allowed to advance an existing context: a
 * worker replay continues to use ensureProviderPromptContext and therefore
 * cannot roll the current manifest back to stale request bytes.
 */
export function prepareProviderPromptContextForInvocation(
  storeRoot: string,
  request: ProviderInvocationRequest,
  manifestValue: unknown,
  requestedOwnerWorkflowId: string,
  now: Date,
): ProviderPromptContextBinding {
  return resolveProviderPromptContext(
    storeRoot,
    request,
    manifestValue,
    requestedOwnerWorkflowId,
    { allowRollover: true, now },
  );
}

/**
 * Stable catalog identity for one Attempt's private provider runtime. A pin
 * recorded against this identity is what keeps the raw prompt, schema, and
 * semantic output from expiring on the ordinary schedule.
 *
 * It lives beside the writer so that the module recording the handle and the
 * pass consulting it share one derivation. Two copies of this formula would be
 * two identities, and a pin recorded under one would be invisible to the other.
 */
export function providerRuntimeEvidenceId(attemptId: string): string {
  return `provider-runtime-${crypto
    .createHash('sha256')
    .update(attemptId)
    .digest('hex')
    .slice(0, 32)}`;
}

/**
 * Records the handle a maintainer pins to keep one Attempt's private provider
 * runtime.
 *
 * The pruning pass has always honoured a pin and the pin ceremony has always
 * been reachable, but nothing created the record the two meet on, so the
 * ceremony protected no bytes at all. This is that record, written where the
 * runtime comes into existence: the descriptor names the runtime rather than
 * copying it, so the raw bytes stay where they are.
 *
 * It has to be written now rather than when deletion looms, for two reasons.
 * Only the current epoch may publish active evidence, and a handle that first
 * appears once the bytes are already eligible for deletion would arrive too
 * late for anyone to act on.
 */
export function registerProviderRuntimeEvidence(
  storeRoot: string,
  input: {
    binding: ProviderPromptContextBinding;
    attemptId: string;
    invocationId: string;
    invocationRevision: number;
    now: Date;
  },
): Readonly<{ evidenceId: string; created: boolean }> {
  const evidenceId = providerRuntimeEvidenceId(input.attemptId);
  const catalog = inspectDurableRetentionCatalog(
    storeRoot,
    input.binding.workflowId,
  );
  if (catalog.records.some((record) => record.evidenceId === evidenceId)) {
    return { evidenceId, created: false };
  }
  const content = `${canonicalJson({
    kind: 'provider-runtime-evidence.v1',
    workflowId: input.binding.workflowId,
    epoch: input.binding.epoch,
    attemptId: input.attemptId,
    invocationId: input.invocationId,
    invocationRevision: input.invocationRevision,
  })}\n`;
  storeDurableEvidence(storeRoot, {
    workflowId: input.binding.workflowId,
    expectedCatalogGeneration: catalog.generation,
    record: {
      schemaVersion: 1,
      kind: 'evidence-retention',
      evidenceId,
      itemIdentity: `attempt:${input.attemptId}`,
      workflowId: input.binding.workflowId,
      epoch: input.binding.epoch,
      evidenceClass: 'raw',
      digest: `sha256:${crypto
        .createHash('sha256')
        .update(content)
        .digest('hex')}`,
      retention: 'active',
      createdAt: input.now.toISOString(),
      expiresAt: null,
      pin: null,
    },
    content,
  });
  return { evidenceId, created: true };
}

/**
 * Resolve one already-published invocation manifest against the authoritative
 * durable provider-context epoch without advancing or otherwise mutating it.
 * A compacted or ambiguous historical transition returns null so retention
 * defaults to preserving the raw evidence.
 */
export function inspectProviderPromptContextRetentionBinding(
  storeRoot: string,
  request: ProviderInvocationRequest,
  manifestValue: unknown,
  requestedOwnerWorkflowId: string,
  invocationCreatedAt: string,
): ProviderPromptContextRetentionBinding | null {
  const ownerWorkflowId = assertInvestigationId(requestedOwnerWorkflowId);
  if (!isTimestamp(invocationCreatedAt)) return null;
  const content = canonicalJson(manifestValue);
  if (sha256Hex(content) !== request.inputManifestDigest) return null;
  const workflowId = providerContextWorkflowId(ownerWorkflowId, request);
  let current: ReturnType<typeof inspectDurableEpochContextStore>;
  try {
    current = inspectDurableEpochContextStore(storeRoot, workflowId);
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      error.code === 'EXECUTION_CONTEXT_NOT_FOUND'
    ) {
      return null;
    }
    throw error;
  }
  const candidateEpochs = new Set<number>([
    current.workflow.currentEpoch,
    ...current.transitionReceipts.flatMap(({ fromEpoch, toEpoch }) => [
      fromEpoch,
      toEpoch,
    ]),
  ]);
  const createdAt = Date.parse(invocationCreatedAt);
  const matches = [...candidateEpochs]
    .sort((left, right) => left - right)
    .flatMap((epoch) => {
      const contractVersions = new Set<number>([
        ...(epoch === current.workflow.currentEpoch
          ? [current.workflow.contractVersion]
          : []),
        ...current.transitionReceipts.flatMap((receipt) => [
          ...(receipt.fromEpoch === epoch ? [receipt.fromContractVersion] : []),
          ...(receipt.toEpoch === epoch ? [receipt.toContractVersion] : []),
        ]),
      ]);
      const enteredAt = current.transitionReceipts.find(
        ({ toEpoch }) => toEpoch === epoch,
      )?.createdAt;
      const exitedAt = current.transitionReceipts.find(
        ({ fromEpoch }) => fromEpoch === epoch,
      )?.createdAt;
      if (
        (enteredAt !== undefined && createdAt < Date.parse(enteredAt)) ||
        (exitedAt !== undefined && createdAt > Date.parse(exitedAt))
      ) {
        return [];
      }
      return [...contractVersions].flatMap((contractVersion) => {
        const manifest = providerPromptManifest(
          request,
          workflowId,
          epoch,
          contractVersion,
          content,
        );
        const digestBound =
          (epoch === current.workflow.currentEpoch &&
            canonicalJson(manifest) ===
              canonicalJson(current.currentManifest)) ||
          current.transitionReceipts.some(
            (receipt) =>
              (receipt.fromEpoch === epoch &&
                receipt.previousContextDigest === manifest.contextDigest) ||
              (receipt.toEpoch === epoch &&
                receipt.newContextDigest === manifest.contextDigest),
          );
        return digestBound
          ? [{ epoch, contextDigest: manifest.contextDigest }]
          : [];
      });
    });
  if (matches.length !== 1) return null;
  return Object.freeze({
    workflowId,
    epoch: matches[0]!.epoch,
    contextDigest: matches[0]!.contextDigest,
    currentEpoch: current.workflow.currentEpoch,
    currentContextDigest: current.workflow.contextDigest,
    currentGeneration: current.generation,
  });
}

function resolveProviderPromptContext(
  storeRoot: string,
  request: ProviderInvocationRequest,
  manifestValue: unknown,
  requestedOwnerWorkflowId: string,
  options: { allowRollover: boolean; now: Date },
): ProviderPromptContextBinding {
  const ownerWorkflowId = assertInvestigationId(requestedOwnerWorkflowId);
  const content = canonicalJson(manifestValue);
  if (sha256Hex(content) !== request.inputManifestDigest) {
    throw providerContextInvalid(
      'Provider input manifest bytes do not match the request binding.',
    );
  }
  const workflowId = providerContextWorkflowId(ownerWorkflowId, request);
  const items = [{ identity: 'provider-input-manifest', content }];
  let current: ReturnType<typeof inspectDurableEpochContextStore>;
  try {
    current = inspectDurableEpochContextStore(storeRoot, workflowId);
  } catch (error) {
    if (
      !(error instanceof WorkflowError) ||
      error.code !== 'EXECUTION_CONTEXT_NOT_FOUND'
    ) {
      throw error;
    }
    const manifest = providerPromptManifest(request, workflowId, 1, 1, content);
    const workflow = providerPromptWorkflow(request, manifest);
    try {
      current = initializeDurableEpochContextStore(storeRoot, {
        workflow,
        manifest,
        items,
        now: options.now,
      });
    } catch (initializeError) {
      if (
        !(initializeError instanceof WorkflowError) ||
        initializeError.code !== 'EXECUTION_CONTEXT_EXISTS'
      ) {
        throw initializeError;
      }
      current = inspectDurableEpochContextStore(storeRoot, workflowId);
    }
  }

  const semanticContractChanged =
    current.currentManifest.termSetDigest !==
    providerSemanticContractDigest(request);
  const contractVersion = semanticContractChanged
    ? current.workflow.contractVersion + 1
    : current.workflow.contractVersion;
  let manifest = providerPromptManifest(
    request,
    workflowId,
    current.workflow.currentEpoch,
    contractVersion,
    content,
  );
  let workflow = providerPromptWorkflow(request, manifest);
  if (
    canonicalJson(current.workflow) !== canonicalJson(workflow) ||
    canonicalJson(current.currentManifest) !== canonicalJson(manifest)
  ) {
    if (!options.allowRollover) throw providerContextStale();
    manifest = providerPromptManifest(
      request,
      workflowId,
      current.workflow.currentEpoch + 1,
      contractVersion,
      content,
    );
    const nextItems = new Map(
      manifest.items.map(({ identity, digest }) => [identity, digest]),
    );
    const carriedForward = current.currentManifest.items
      .filter(({ identity, digest }) => nextItems.get(identity) === digest)
      .map(({ identity }) => identity);
    const carriedForwardSet = new Set(carriedForward);
    current = rolloverDurableEpochContextStore(storeRoot, {
      workflowId,
      expectedGeneration: current.generation,
      expectedEpoch: current.workflow.currentEpoch,
      expectedContextDigest: current.workflow.contextDigest,
      nextManifest: manifest,
      items,
      reason: semanticContractChanged
        ? 'Lifecycle selected a new provider semantic output contract.'
        : 'Lifecycle selected a new provider semantic input manifest.',
      restartFrom: request.purpose,
      carriedForward,
      carryForwardManifest: {
        sourceWorkflow: workflowId,
        sourceEpoch: current.workflow.currentEpoch,
        carriedForward: carriedForward.map((identity) => ({
          identity,
          reason:
            'The exact provider input manifest remains selected semantic input in the new epoch.',
        })),
        excluded: current.currentManifest.items
          .filter(({ identity }) => !carriedForwardSet.has(identity))
          .map(({ identity }) => ({
            identity,
            reason:
              'The prior provider input manifest is bound to the superseded semantic request.',
          })),
      },
      invalidated: semanticContractChanged
        ? ['provider-input-manifest', 'provider-semantic-contract']
        : ['provider-input-manifest'],
      verification: null,
      createdAt: options.now,
    });
    workflow = providerPromptWorkflow(request, manifest);
    if (
      canonicalJson(current.workflow) !== canonicalJson(workflow) ||
      canonicalJson(current.currentManifest) !== canonicalJson(manifest)
    ) {
      throw providerContextStale();
    }
  }
  return Object.freeze({
    ownerWorkflowId,
    purpose: request.purpose,
    workflowId,
    generation: current.generation,
    epoch: current.workflow.currentEpoch,
    contextDigest: manifest.contextDigest,
    manifest,
  });
}

function providerPromptManifest(
  request: ProviderInvocationRequest,
  workflowId: string,
  epoch: number,
  contractVersion: number,
  content: string,
): ContextManifest {
  return buildContextManifest({
    workflowId,
    epoch,
    contractVersion,
    baselineDigest: digestCanonical({
      baseCommit: request.baseCommit,
      baseTree: request.baseTree,
    }),
    intentDigest: digestCanonical({ targetDigest: request.targetDigest }),
    termSetDigest: providerSemanticContractDigest(request),
    planningSnapshotDigest: digestCanonical({
      inputManifestDigest: request.inputManifestDigest,
    }),
    items: [{ identity: 'provider-input-manifest', content }],
  });
}

function providerSemanticContractDigest(
  request: ProviderInvocationRequest,
): string {
  return digestCanonical({
    schemaVersion: 1,
    kind: 'provider-semantic-output-contract',
    purpose: request.purpose,
    outputSchema: request.outputSchema,
    evaluatorVersion: request.evaluatorVersion,
  });
}

function providerPromptWorkflow(
  request: ProviderInvocationRequest,
  manifest: ContextManifest,
): WorkflowContextState {
  return {
    workflowId: manifest.workflowId,
    currentEpoch: manifest.epoch,
    contractVersion: manifest.contractVersion,
    contextDigest: manifest.contextDigest,
    snapshotDigest: manifest.baselineDigest,
    status: 'active',
    checkpoint: request.purpose,
    blocker: null,
  };
}

export function assembleProviderPromptManifest(
  storeRoot: string,
  request: ProviderInvocationRequest,
  manifestValue: unknown,
  ownerWorkflowId: string,
): unknown {
  const binding = ensureProviderPromptContext(
    storeRoot,
    request,
    manifestValue,
    ownerWorkflowId,
  );
  const assembled = assembleCurrentPromptFromStore(storeRoot, {
    workflowId: binding.workflowId,
    expectedEpoch: binding.epoch,
    expectedContextDigest: binding.contextDigest,
  });
  if (sha256Hex(assembled) !== request.inputManifestDigest) {
    throw workflowError(
      'PROVIDER_CONTEXT_ITEM_MISMATCH',
      'Current durable context did not assemble the exact request manifest.',
      ExitCode.staleState,
    );
  }
  try {
    const parsed = JSON.parse(assembled) as unknown;
    if (canonicalJson(parsed) !== assembled) throw new Error('non-canonical');
    return parsed;
  } catch {
    throw providerContextInvalid(
      'Current durable provider manifest is not canonical JSON.',
    );
  }
}

export function assertProviderPromptContextCurrent(
  storeRoot: string,
  binding: ProviderPromptContextBinding,
): void {
  assertProviderPromptContextBinding(binding);
  const current = inspectDurableEpochContextStore(
    storeRoot,
    binding.workflowId,
  );
  if (
    current.generation !== binding.generation ||
    current.workflow.status !== 'active' ||
    current.workflow.currentEpoch !== binding.epoch ||
    current.workflow.contextDigest !== binding.contextDigest ||
    canonicalJson(current.currentManifest) !== canonicalJson(binding.manifest)
  ) {
    throw providerContextStale();
  }
}

export function withCurrentProviderPromptContext<T>(
  storeRoot: string,
  binding: ProviderPromptContextBinding,
  operation: () => T,
): T {
  assertProviderPromptContextBinding(binding);
  try {
    return withCurrentDurableEpochContextStore(
      storeRoot,
      {
        workflowId: binding.workflowId,
        expectedGeneration: binding.generation,
        expectedEpoch: binding.epoch,
        expectedContextDigest: binding.contextDigest,
        expectedManifest: binding.manifest,
      },
      operation,
    );
  } catch (error) {
    if (
      error instanceof WorkflowError &&
      error.code === 'EXECUTION_CONTEXT_CAS_MISMATCH'
    ) {
      throw providerContextStale();
    }
    throw error;
  }
}

function providerContextWorkflowId(
  ownerWorkflowId: string,
  request: Pick<ProviderInvocationRequest, 'purpose'>,
): string {
  return `provider-context-${request.purpose}-${sha256Hex(
    canonicalJson({
      schemaVersion: 1,
      kind: 'provider-context-owner',
      ownerWorkflowId: assertInvestigationId(ownerWorkflowId),
      purpose: request.purpose,
    }),
  ).slice(0, 32)}`;
}

function assertProviderPromptContextBinding(
  binding: ProviderPromptContextBinding,
): void {
  const ownerWorkflowId = assertInvestigationId(binding.ownerWorkflowId);
  if (
    (binding.purpose !== 'survey' &&
      binding.purpose !== 'plan-review' &&
      binding.purpose !== 'task-diff-review' &&
      binding.purpose !== 'task-implementation') ||
    binding.workflowId !==
      providerContextWorkflowId(ownerWorkflowId, binding) ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation < 1 ||
    !Number.isSafeInteger(binding.epoch) ||
    binding.epoch < 1 ||
    !isDigest(binding.contextDigest) ||
    binding.manifest.workflowId !== binding.workflowId ||
    binding.manifest.epoch !== binding.epoch ||
    binding.manifest.contextDigest !== binding.contextDigest
  ) {
    throw providerContextInvalid('Provider context binding is malformed.');
  }
}
