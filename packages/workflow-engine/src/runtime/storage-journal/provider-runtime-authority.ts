/**
 * Replays durable admission, assignment, completion, and native-session authority for provider runs.
 *
 * Invariants:
 * - Authority objects and refs bind the exact request, execution generation, and completion result.
 * - Terminal preflight and completed-result checks preserve their distinct required evidence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { WorkflowError } from '../../foundation/errors/errors.ts';
import {
  assertAgentRuntimeDurableAssignmentAuthorityV1,
  assertAgentRuntimeDurableNativeSessionAuthorityV1,
  assertChangeRoleAssignmentRefV1,
  assertProviderNativeSessionClaimRefV1,
  assertProviderNativeSessionCompletionRefV1,
} from '../../modules/provider-orchestration/agent-runtime-durable-authority.ts';
import { type AgentRuntimeCompletionReceipt } from '../../modules/provider-orchestration/agent-runtime-port.ts';
import {
  type ProviderInvocationRequest,
  type ProviderProcessResult,
  recreateProviderInvocationRequest,
} from '../../modules/provider-orchestration/provider-contracts.ts';
import {
  assertProviderNativeSessionCompletionV1,
  assertProviderNativeSessionHandleV1,
} from '../../modules/provider-orchestration/provider-native-session.ts';
import { assertAgentRuntimeCompletionReceipt } from '../../modules/provider-orchestration/provider-runtime-evidence.ts';
import { type InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  changeRoleAssignmentObjectPathV1,
  changeRoleAssignmentRefPathV1,
  changeRoleAssignmentStorePathsV1,
  providerNativeSessionClaimObjectPathV1,
  providerNativeSessionClaimRefPathV1,
  providerNativeSessionCompletionObjectPathV1,
  providerNativeSessionCompletionRefPathV1,
  providerNativeSessionContinuationAuthorityObjectPathV1,
  providerNativeSessionHandleObjectPathV1,
  providerNativeSessionStorePathsV1,
} from '../session-workspace/provider-runtime-authority-paths.ts';
import {
  assertPrivateInvestigationDirectory,
  readPrivateCanonicalJson,
} from './investigation-private-files.ts';
import {
  hasExactKeys,
  isDigest,
  isRecord,
  isTimestamp,
  providerInvocationUnsafe,
  sha256,
} from './investigation-store-values.ts';
import {
  type ProviderExecutionAdmissionAuthority,
  assertDurableExecutionAdmissionState,
  assertProviderExecutionAdmissionAuthority,
  MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES,
  providerExecutionAdmissionAuthorityPath,
} from './provider-execution-admission-authority.ts';
import {
  providerRetentionArtifact,
  readCompleteProviderRetentionReceipt,
} from './provider-retention-receipt.ts';
import {
  type ProviderInvocationRuntimeEvidence,
  assertProviderInvocationRuntimeEvidence,
} from './provider-runtime-evidence-contract.ts';

const MAX_PROVIDER_ASSIGNMENT_AUTHORITY_BYTES = 2 * 1_024 * 1_024;

const MAX_PROVIDER_NATIVE_AUTHORITY_BYTES = 512 * 1_024;

const MAX_PROVIDER_AUTHORITY_REF_BYTES = 2 * 1_024;

const MAX_PROVIDER_CONTINUATION_AUTHORITY_BYTES = 8 * 1_024;

const MAX_PROVIDER_COMPLETION_CANDIDATE_BYTES = 16 * 1_024 * 1_024;

const MAX_PROVIDER_ADMISSION_AUTHORITY_FILES = 10_000;

const PROVIDER_ADMISSION_AUTHORITY_FILE = /^[0-9a-f]{64}\.json$/u;

const PROVIDER_ADMISSION_AUTHORITY_TEMPORARY =
  /^[0-9a-f]{64}\.json\.[1-9][0-9]*\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;

export type ProviderInvocationRuntimeGeneration = Readonly<{
  invocationId: string;
  revision: number;
  leaseGeneration: number;
  state: 'prepared' | 'leased' | 'succeeded' | 'failed';
  manifestDigest: string;
  updatedAt: string;
}>;

function readCurrentProviderAdmissionGeneration(
  paths: InvestigationRuntimePaths,
  request: ProviderInvocationRequest,
  generation: ProviderInvocationRuntimeGeneration,
  makeError: () => WorkflowError,
): ProviderExecutionAdmissionAuthority | null {
  if (generation.state !== 'succeeded' && generation.state !== 'failed') {
    return null;
  }
  const directory = path.join(paths.root, 'execution', 'admission-authorities');
  const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw makeError();
  try {
    assertPrivateInvestigationDirectory(paths, directory, makeError);
    const names = fs.readdirSync(directory).sort();
    if (names.length > MAX_PROVIDER_ADMISSION_AUTHORITY_FILES) {
      throw makeError();
    }
    const matches: ProviderExecutionAdmissionAuthority[] = [];
    for (const name of names) {
      if (PROVIDER_ADMISSION_AUTHORITY_TEMPORARY.test(name)) continue;
      if (!PROVIDER_ADMISSION_AUTHORITY_FILE.test(name)) throw makeError();
      const authority = assertProviderExecutionAdmissionAuthority(
        readPrivateCanonicalJson(
          paths,
          path.join(directory, name),
          makeError,
          MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES,
        ),
        makeError,
      );
      if (
        path.basename(
          providerExecutionAdmissionAuthorityPath(
            paths,
            authority.acceptanceBinding,
          ),
        ) !== name
      ) {
        throw makeError();
      }
      const binding = authority.acceptanceBinding;
      if (
        binding.invocationId === generation.invocationId &&
        binding.requestDigest === request.requestDigest &&
        binding.invocationRevision + 1 === generation.revision &&
        binding.leaseGeneration === generation.leaseGeneration
      ) {
        matches.push(authority);
      }
    }
    if (matches.length > 1) throw makeError();
    return matches[0] ?? null;
  } catch {
    throw makeError();
  }
}

function assertCurrentProviderCompletionCandidateReceipt(
  paths: InvestigationRuntimePaths,
  request: ProviderInvocationRequest,
  generation: ProviderInvocationRuntimeGeneration,
  result: ProviderProcessResult | null,
  receipt: AgentRuntimeCompletionReceipt | null,
  makeError: () => WorkflowError,
): void {
  if (generation.state !== 'succeeded') return;
  if (result === null) throw makeError();
  const candidatePath = path.join(
    paths.root,
    'execution',
    'completion-candidates',
    `${sha256(generation.invocationId)}.json`,
  );
  const stats = fs.lstatSync(candidatePath, { throwIfNoEntry: false });
  if (stats === undefined) {
    assertRetainedProviderCompletionCandidateReceipt(
      paths,
      request,
      generation,
      makeError,
    );
    return;
  }
  try {
    const value = readPrivateCanonicalJson(
      paths,
      candidatePath,
      makeError,
      MAX_PROVIDER_COMPLETION_CANDIDATE_BYTES,
    );
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'candidateDigest',
        'completedAt',
        'expectedInvocationRevision',
        'invocationId',
        'kind',
        'leaseGeneration',
        'leaseTokenDigest',
        'requestDigest',
        'result',
        ...(Object.prototype.hasOwnProperty.call(value, 'runtimeReceipt')
          ? ['runtimeReceipt']
          : []),
        'schemaVersion',
      ]) ||
      value.schemaVersion !== 1 ||
      value.kind !== 'provider-completion-candidate' ||
      value.invocationId !== generation.invocationId ||
      value.requestDigest !== request.requestDigest ||
      !Number.isSafeInteger(value.expectedInvocationRevision) ||
      (value.expectedInvocationRevision as number) < 0 ||
      (value.expectedInvocationRevision as number) + 1 !==
        generation.revision ||
      !Number.isSafeInteger(value.leaseGeneration) ||
      (value.leaseGeneration as number) < 1 ||
      value.leaseGeneration !== generation.leaseGeneration ||
      !isDigest(value.leaseTokenDigest) ||
      !isTimestamp(value.completedAt) ||
      !isDigest(value.candidateDigest) ||
      canonicalJson(value.result) !== canonicalJson(result)
    ) {
      throw makeError();
    }
    const body = { ...value };
    delete body.candidateDigest;
    if (sha256(canonicalJson(body)) !== value.candidateDigest) {
      throw makeError();
    }
    const candidateReceipt = Object.prototype.hasOwnProperty.call(
      value,
      'runtimeReceipt',
    )
      ? assertAgentRuntimeCompletionReceipt(value.runtimeReceipt, makeError)
      : null;
    if (
      candidateReceipt !== null &&
      (candidateReceipt.invocationId !== generation.invocationId ||
        candidateReceipt.requestDigest !== request.requestDigest ||
        candidateReceipt.leasedRevision !== value.expectedInvocationRevision ||
        candidateReceipt.terminalRevision !== generation.revision ||
        candidateReceipt.leaseGeneration !== generation.leaseGeneration ||
        candidateReceipt.terminalState !== 'succeeded')
    ) {
      throw makeError();
    }
    if (canonicalJson(receipt) !== canonicalJson(candidateReceipt)) {
      throw makeError();
    }
  } catch {
    throw makeError();
  }
}

function assertRetainedProviderCompletionCandidateReceipt(
  paths: InvestigationRuntimePaths,
  request: ProviderInvocationRequest,
  generation: ProviderInvocationRuntimeGeneration,
  makeError: () => WorkflowError,
): void {
  try {
    const retentionReceipt = readCompleteProviderRetentionReceipt(
      paths,
      generation.invocationId,
      {
        requestDigest: request.requestDigest,
        manifestDigest: generation.manifestDigest,
        invocationRevision: generation.revision,
        terminalState: 'succeeded',
        terminalAt: generation.updatedAt,
      },
    );
    const retainedCandidate =
      retentionReceipt === null
        ? null
        : providerRetentionArtifact(retentionReceipt, 'completion-candidate');
    // The pruning transaction publishes this descriptor only after validating
    // the complete Job/Attempt, provider record, prompt context, and canonical
    // candidate bytes. Its complete self-digesting receipt is the durable
    // replacement for the intentionally deleted raw candidate; terminal state
    // cannot recreate the candidate's pre-terminal lease bytes.
    if (retainedCandidate === null) throw makeError();
  } catch {
    throw makeError();
  }
}

function assertProviderExecutionAdmissionAuthorityForRuntime(
  paths: InvestigationRuntimePaths,
  request: ProviderInvocationRequest,
  generation: ProviderInvocationRuntimeGeneration,
  receipt: AgentRuntimeCompletionReceipt | null,
  makeError: () => WorkflowError,
): void {
  const authority = readCurrentProviderAdmissionGeneration(
    paths,
    request,
    generation,
    makeError,
  );
  if (authority === null) {
    if (generation.state === 'succeeded' || receipt?.schemaVersion === 4) {
      throw makeError();
    }
    return;
  }
  if (authority.receiptRequirement === 'synchronous-no-activity') {
    if (receipt !== null) throw makeError();
    return;
  }
  if (
    receipt?.schemaVersion !== 4 ||
    receipt.acceptanceBinding.receiptRequirement !== 'schema-v4' ||
    canonicalJson(authority.acceptanceBinding) !==
      canonicalJson(receipt.acceptanceBinding) ||
    authority.acceptanceBindingDigest !== receipt.acceptanceBindingDigest ||
    authority.executionStateDigest !== receipt.executionStateDigest
  ) {
    throw makeError();
  }
}

export function assertProviderInvocationOutputManifestBinding(
  runtimeEvidence: ProviderInvocationRuntimeEvidence,
  manifest: unknown,
  makeError: () => WorkflowError,
): void {
  if (
    runtimeEvidence.state !== 'succeeded' ||
    !isRecord(manifest) ||
    manifest.kind !== 'task-strategy-implementation-manifest'
  ) {
    return;
  }
  const output = runtimeEvidence.result?.output;
  if (
    !isRecord(manifest.subject) ||
    !isRecord(output) ||
    output.sessionId !== manifest.subject.sessionId ||
    output.sourceTree !== manifest.subject.sourceTree
  ) {
    throw makeError();
  }
}

export function readAcceptedProviderInvocationRuntimeReceiptAuthority(
  paths: InvestigationRuntimePaths,
  invocationId: string,
  makeError: () => WorkflowError = providerInvocationUnsafe,
): Extract<AgentRuntimeCompletionReceipt, { schemaVersion: 4 }> {
  const directory = path.join(paths.invocations, invocationId);
  let request: ProviderInvocationRequest;
  try {
    request = recreateProviderInvocationRequest(
      readPrivateCanonicalJson(
        paths,
        path.join(directory, 'request.json'),
        makeError,
      ),
    );
  } catch {
    throw makeError();
  }
  const evidence = assertProviderInvocationRuntimeEvidence(
    readPrivateCanonicalJson(
      paths,
      path.join(directory, 'state.json'),
      makeError,
    ),
    request,
    makeError,
  );
  if (
    evidence.state !== 'succeeded' ||
    evidence.result === null ||
    evidence.runtimeReceipt?.schemaVersion !== 4 ||
    evidence.runtimeReceipt.terminalState !== 'succeeded' ||
    evidence.runtimeReceipt.terminalDisposition !== 'accepted' ||
    evidence.runtimeReceipt.failureCode !== null ||
    evidence.runtimeReceipt.protocolReceipt?.kind !==
      'provider-wrapper-session-protocol-receipt' ||
    evidence.runtimeReceipt.protocolReceipt.terminal !== 'result' ||
    evidence.runtimeReceipt.hostExecutionBinding?.phase !== 'native-terminal' ||
    evidence.runtimeReceipt.hostExecutionBinding.nativeSessionClaim === null ||
    evidence.runtimeReceipt.hostExecutionBinding
      .nativeSessionCompletionDigest === null ||
    evidence.runtimeReceipt.hostExecutionBinding.nativeSessionClaim
      .invocationId !== invocationId ||
    evidence.runtimeReceipt.hostExecutionBinding.nativeSessionClaim
      .requestDigest !== request.requestDigest ||
    evidence.runtimeReceipt.hostExecutionBinding.nativeSessionClaim
      .attemptId !== evidence.runtimeReceipt.executionAttemptId
  ) {
    throw makeError();
  }
  assertCurrentProviderCompletionCandidateReceipt(
    paths,
    request,
    evidence,
    evidence.result,
    evidence.runtimeReceipt,
    makeError,
  );
  assertProviderExecutionAdmissionAuthorityForRuntime(
    paths,
    request,
    evidence,
    evidence.runtimeReceipt,
    makeError,
  );
  assertProviderHostAssignmentAndProbeAuthorityForRuntime(
    paths,
    request,
    evidence.result,
    evidence.runtimeReceipt,
    makeError,
  );
  const execution = assertDurableExecutionAdmissionState(
    readPrivateCanonicalJson(
      paths,
      path.join(
        paths.root,
        'execution',
        'jobs',
        `${sha256(evidence.runtimeReceipt.executionJobId)}.json`,
      ),
      makeError,
      MAX_PROVIDER_EXECUTION_ADMISSION_AUTHORITY_BYTES,
    ),
    makeError,
  );
  const attempt = execution.attempts.find(
    ({ attemptId }) =>
      attemptId === evidence.runtimeReceipt!.executionAttemptId,
  );
  const acceptedResult = execution.results.find(
    ({ attemptId, acceptance }) =>
      attemptId === evidence.runtimeReceipt!.executionAttemptId &&
      acceptance === 'accepted',
  );
  if (
    execution.revision <= evidence.runtimeReceipt.executionRevision ||
    execution.workflow.workflowId !==
      evidence.runtimeReceipt.acceptanceBinding.ownerWorkflowId ||
    execution.job.jobId !== evidence.runtimeReceipt.executionJobId ||
    execution.job.acceptedAttemptId !==
      evidence.runtimeReceipt.executionAttemptId ||
    attempt?.status !== 'succeeded' ||
    attempt.jobId !== evidence.runtimeReceipt.executionJobId ||
    attempt.leaseGeneration !== evidence.runtimeReceipt.leaseGeneration ||
    attempt.providerInvocation?.invocationId !== invocationId ||
    attempt.providerInvocation.invocationRevision !== evidence.revision ||
    acceptedResult?.outputDigest !== `sha256:${evidence.result.outputDigest}`
  ) {
    throw makeError();
  }
  return evidence.runtimeReceipt;
}

function assertProviderHostAssignmentAndProbeAuthorityForRuntime(
  paths: InvestigationRuntimePaths,
  request: ProviderInvocationRequest,
  result: ProviderProcessResult | null,
  receipt: AgentRuntimeCompletionReceipt | null,
  makeError: () => WorkflowError,
): void {
  const hostBinding = receipt?.hostExecutionBinding;
  if (hostBinding === null || hostBinding === undefined) return;
  try {
    const assignment = hostBinding.assignmentBinding;
    const assignmentPaths = changeRoleAssignmentStorePathsV1(paths);
    const assignmentRef = assertChangeRoleAssignmentRefV1(
      readPrivateCanonicalJson(
        paths,
        changeRoleAssignmentRefPathV1(
          assignmentPaths,
          assignment.changeId,
          assignment.planningGeneration,
        ),
        makeError,
        MAX_PROVIDER_AUTHORITY_REF_BYTES,
      ),
      assignment.changeId,
      assignment.planningGeneration,
      makeError,
    );
    if (assignmentRef.recordDigest !== assignment.recordDigest) {
      throw makeError();
    }
    const assignmentRecord = readPrivateCanonicalJson(
      paths,
      changeRoleAssignmentObjectPathV1(
        assignmentPaths,
        assignmentRef.recordDigest,
      ),
      makeError,
      MAX_PROVIDER_ASSIGNMENT_AUTHORITY_BYTES,
    );
    assertAgentRuntimeDurableAssignmentAuthorityV1(
      assignment,
      assignmentRecord as Parameters<
        typeof assertAgentRuntimeDurableAssignmentAuthorityV1
      >[1],
      {
        purpose: request.purpose,
        providerId: request.providerId,
        inputManifestDigest: request.inputManifestDigest,
        targetDigest: request.targetDigest,
      },
      makeError,
    );
    if (
      hostBinding.probe !== null &&
      result !== null &&
      (result.runtimeObservation === null ||
        canonicalJson(hostBinding.probe.executable) !==
          canonicalJson(result.runtimeObservation.executable))
    ) {
      throw makeError();
    }
  } catch {
    throw makeError();
  }
}

function assertProviderHostDurableAuthoritiesForRuntime(
  paths: InvestigationRuntimePaths,
  request: ProviderInvocationRequest,
  result: ProviderProcessResult | null,
  receipt: AgentRuntimeCompletionReceipt | null,
  makeError: () => WorkflowError,
  options: Readonly<{
    allowPendingNativeContinuationAuthority?: boolean;
  }> = {},
): void {
  if (receipt?.schemaVersion !== 4) return;
  const hostBinding = receipt.hostExecutionBinding;
  if (hostBinding === null) return;
  assertProviderHostAssignmentAndProbeAuthorityForRuntime(
    paths,
    request,
    result,
    receipt,
    makeError,
  );
  try {
    if (hostBinding.phase !== 'native-terminal') {
      if (receipt.protocolReceipt !== null) throw makeError();
      return;
    }
    if (
      hostBinding.nativeSessionClaim === null ||
      hostBinding.nativeSessionCompletionDigest === null
    ) {
      throw makeError();
    }
    const nativePaths = providerNativeSessionStorePathsV1(paths);
    const turns = [];
    for (let turn = 1; turn <= hostBinding.nativeSessionClaim.turn; turn += 1) {
      const claimRef = assertProviderNativeSessionClaimRefV1(
        readPrivateCanonicalJson(
          paths,
          providerNativeSessionClaimRefPathV1(
            nativePaths,
            hostBinding.nativeSessionClaim.scope.scopeKey,
            turn,
          ),
          makeError,
          MAX_PROVIDER_AUTHORITY_REF_BYTES,
        ),
        hostBinding.nativeSessionClaim.scope.scopeKey,
        turn,
        makeError,
      );
      const claim = readPrivateCanonicalJson(
        paths,
        providerNativeSessionClaimObjectPathV1(
          nativePaths,
          claimRef.claimDigest,
        ),
        makeError,
        MAX_PROVIDER_NATIVE_AUTHORITY_BYTES,
      );
      const completionRef = assertProviderNativeSessionCompletionRefV1(
        readPrivateCanonicalJson(
          paths,
          providerNativeSessionCompletionRefPathV1(
            nativePaths,
            hostBinding.nativeSessionClaim.scope.scopeKey,
            turn,
          ),
          makeError,
          MAX_PROVIDER_AUTHORITY_REF_BYTES,
        ),
        hostBinding.nativeSessionClaim.scope.scopeKey,
        turn,
        claimRef.claimDigest,
        makeError,
      );
      const completion = readPrivateCanonicalJson(
        paths,
        providerNativeSessionCompletionObjectPathV1(
          nativePaths,
          completionRef.completionDigest,
        ),
        makeError,
        MAX_PROVIDER_NATIVE_AUTHORITY_BYTES,
      );
      const parsedCompletion =
        assertProviderNativeSessionCompletionV1(completion);
      const continuationPath =
        providerNativeSessionContinuationAuthorityObjectPathV1(
          nativePaths,
          parsedCompletion.completionDigest,
        );
      const continuationExists =
        fs.lstatSync(continuationPath, { throwIfNoEntry: false }) !== undefined;
      const terminalTurn = turn === hostBinding.nativeSessionClaim.turn;
      if (
        terminalTurn &&
        receipt.terminalDisposition === 'accepted' &&
        !continuationExists &&
        options.allowPendingNativeContinuationAuthority !== true
      ) {
        throw makeError();
      }
      if (
        continuationExists &&
        terminalTurn &&
        receipt.terminalDisposition !== 'accepted'
      ) {
        throw makeError();
      }
      const runtimeReceipt = continuationExists
        ? terminalTurn
          ? receipt
          : readAcceptedProviderInvocationRuntimeReceiptAuthority(
              paths,
              parsedCompletion.invocationId,
              makeError,
            )
        : null;
      const continuationAuthority = continuationExists
        ? readPrivateCanonicalJson(
            paths,
            continuationPath,
            makeError,
            MAX_PROVIDER_CONTINUATION_AUTHORITY_BYTES,
          )
        : null;
      turns.push({
        claim,
        claimRef,
        completion: parsedCompletion,
        completionRef,
        continuationAuthority,
        runtimeReceipt,
      });
    }
    const durableNative = assertAgentRuntimeDurableNativeSessionAuthorityV1(
      {
        embeddedClaim: hostBinding.nativeSessionClaim,
        embeddedCompletionDigest: hostBinding.nativeSessionCompletionDigest,
        turns,
      },
      makeError,
    );
    const terminalCompletion = durableNative.completion;
    if (
      canonicalJson(receipt.protocolReceipt) !==
        canonicalJson(terminalCompletion.protocolReceipt) ||
      (receipt.terminalDisposition === 'accepted' &&
        (terminalCompletion.disposition !== 'usable' ||
          terminalCompletion.usable !== true ||
          terminalCompletion.protocolReceipt?.terminal !== 'result')) ||
      (receipt.terminalDisposition === 'failed-before-result' &&
        (terminalCompletion.disposition === 'usable' ||
          terminalCompletion.usable !== false ||
          terminalCompletion.protocolReceipt?.terminal === 'result')) ||
      (receipt.terminalDisposition === 'rejected-after-result' &&
        (terminalCompletion.disposition !== 'rejected' ||
          terminalCompletion.usable !== false ||
          terminalCompletion.handleDigest !== null ||
          terminalCompletion.protocolReceipt?.terminal !== 'result'))
    ) {
      throw makeError();
    }
    for (const { completion } of durableNative.turns) {
      if (completion.usable !== true || completion.handleDigest === null) {
        continue;
      }
      assertProviderNativeSessionHandleV1(
        readPrivateCanonicalJson(
          paths,
          providerNativeSessionHandleObjectPathV1(
            nativePaths,
            completion.handleDigest,
          ),
          makeError,
          MAX_PROVIDER_NATIVE_AUTHORITY_BYTES,
        ),
        { completion, handleDigest: completion.handleDigest },
      );
    }
  } catch {
    throw makeError();
  }
}

export function assertProviderRuntimeDurableAuthorities(
  paths: InvestigationRuntimePaths,
  request: ProviderInvocationRequest,
  generation: ProviderInvocationRuntimeGeneration,
  result: ProviderProcessResult | null,
  receipt: AgentRuntimeCompletionReceipt | null,
  makeError: () => WorkflowError,
  options: Readonly<{
    allowPendingNativeContinuationAuthority?: boolean;
  }> = {},
): void {
  assertCurrentProviderCompletionCandidateReceipt(
    paths,
    request,
    generation,
    result,
    receipt,
    makeError,
  );
  assertProviderExecutionAdmissionAuthorityForRuntime(
    paths,
    request,
    generation,
    receipt,
    makeError,
  );
  assertProviderHostDurableAuthoritiesForRuntime(
    paths,
    request,
    result,
    receipt,
    makeError,
    options,
  );
}

/**
 * Re-admit immutable execution and host authority before publishing a terminal
 * completion candidate or accepted Attempt result. The only relaxed edge is
 * the success continuation marker, which cannot exist until provider state is
 * durably committed.
 */
export function assertProviderRuntimeTerminalAuthorityPreflight(
  paths: InvestigationRuntimePaths,
  request: ProviderInvocationRequest,
  generation: ProviderInvocationRuntimeGeneration,
  result: ProviderProcessResult | null,
  receipt: AgentRuntimeCompletionReceipt | null,
  makeError: () => WorkflowError,
): void {
  if (generation.state !== 'succeeded' && generation.state !== 'failed') {
    throw makeError();
  }
  assertProviderExecutionAdmissionAuthorityForRuntime(
    paths,
    request,
    generation,
    receipt,
    makeError,
  );
  assertProviderHostDurableAuthoritiesForRuntime(
    paths,
    request,
    result,
    receipt,
    makeError,
    { allowPendingNativeContinuationAuthority: true },
  );
}
