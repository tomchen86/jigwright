import { createMaintainerSessionInspection } from './maintainer-session-inspection.ts';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { deriveAuthorityAuditRepositoryId } from '../../runtime/storage-journal/authority-audit-ledger.ts';
import type { AuthorityAuditServiceHooks } from '../../runtime/storage-journal/authority-audit-service.ts';
import {
  authorityRefusalDigest,
  withAuthorityRefusalAudit,
  type AuthorityRefusalAuditBinding,
} from '../../modules/authority/authority-refusal-audit.ts';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  pinCheckRunner,
  runCheck,
  type CheckEvidence,
  type PinnedCheckRunner,
} from '../../adapters/consumer/repository/work-registry/check-runner.ts';
import type { CheckDefinition } from '../../adapters/consumer/repository/work-registry/contracts.ts';
import {
  assertDisposableDatabaseForRepository,
  createCheckEnvironmentForRepository,
} from '../../adapters/consumer/repository/work-registry/database-policy.ts';
import {
  ExitCode,
  WorkflowError,
  workflowError,
} from '../../foundation/errors/errors.ts';
import {
  assertPostApprovalAdmissionDeadline,
  discoverRepository,
  enterPostApprovalTerminalCleanup,
  fingerprintWorkingState,
  isPostApprovalAdmissionFailure,
  listChangedPaths,
  runGit,
  type PostApprovalAdmissionDeadline,
} from '../../runtime/repository-transaction/git.ts';
import {
  commitFacts,
  previewExactStaging,
} from '../../runtime/repository-transaction/git-transitions.ts';
import {
  acceptApplyPrestate,
  assertCandidateV2ChecksFresh,
  readDurableRefGenerationLedger,
} from '../../modules/authority/maintainer-candidate.ts';
import { currentCandidateDependencySnapshot } from './maintainer-candidate-dependencies.ts';
import {
  canonicalMaintainerGrantV2Envelope,
  maintainerChecksEnvironmentDigest,
  validateMaintainerGrantV2AuthorityBinding,
  type MaintainerGrantV2Envelope,
} from '../../modules/authority/maintainer-grant-v2.ts';
import { verifyPatchManifestAgainstWorktree } from '../../modules/authority/maintainer-manifest.ts';
import {
  parseMaintainerPolicy,
  type MaintainerPolicy,
} from '../../modules/authority/maintainer-policy.ts';
import type { MaintainerSignerProvider } from '../../modules/authority/maintainer-signer-port.ts';
import { writeAuthorityCheckReport } from '../../runtime/storage-journal/maintainer-report.ts';
import {
  inspectMaintainerGrants,
  maintainerGrantStorePaths,
  readReservedMaintainerGrant,
  releaseMaintainerReservation,
  reserveMaintainerGrant,
  terminallyFailMaintainerReservation,
  terminallyExpireMaintainerReservation,
  terminallyInvalidateMaintainerReservation,
  terminallyRevokeMaintainerReservation,
} from '../../runtime/storage-journal/maintainer-store.ts';
import {
  assertChangeId,
  assertSessionId,
} from '../../runtime/session-workspace/paths.ts';
import {
  createSessionId,
  runtimePaths,
  withRepositoryLifecycleOperation,
} from '../../runtime/session-workspace/session-store.ts';
import type { TaskMandateBinding } from '../../modules/authority/task-mandate.ts';
import { loadStableValidatedChangeContract } from '../../composition-root/validated-contract-context.ts';

export type AuthorityPinnedCheck = {
  checkId: string;
  definition: CheckDefinition;
  runner: PinnedCheckRunner;
};

export type AuthoritySession = {
  schemaVersion: 1;
  sessionId: string;
  state: 'active' | 'failed' | 'aborted' | 'committed';
  grantVersion: 2;
  grantId: string;
  changeId: string;
  repositoryRoot: string;
  gitCommonDirectory: string;
  branch: string;
  baseCommit: string;
  baselineTree: string;
  policyBlob: string;
  policyDigest: string;
  grantDigest: string;
  signer: string;
  contractDigest: string;
  contractArtifacts: Record<string, string>;
  allowedPaths: string[];
  requiredChecks: string[];
  pinnedChecks: AuthorityPinnedCheck[];
  candidateCommit: string | null;
  resultTree: string | null;
  candidateBundleDigest: string | null;
  mandateBinding: TaskMandateBinding | null;
  expectedRefGeneration: number | null;
  createdAt: string;
  latestCheckReportId?: string;
  failedAt?: string;
  failureReason?: string;
  abortedAt?: string;
  abortReason?: string;
  committedAt?: string;
  commitHash?: string;
};

export type AuthoritySessionOptions = {
  now?: Date;
  signer?: MaintainerSignerProvider;
  environment?: NodeJS.ProcessEnv;
  /** Trusted current snapshots for checks that declare external-state. */
  externalStateDigests?: Readonly<Record<string, string>>;
  allowSignedV2Candidate?: boolean;
  lifecycleAssertOwned?: () => void;
  testRefusalAuditServiceHooks?: AuthorityAuditServiceHooks;
  /** Engine-owned post-approval token; never populated from CLI input. */
  postApprovalDeadline?: PostApprovalAdmissionDeadline;
};

/**
 * Derive refusal authority only after the caller has validated this exact v2
 * envelope against its repository trust base. Raw session or caller input is
 * never sufficient to call this helper.
 */
export function verifiedV2AuthorityLifecycleRefusalBinding(
  repositoryRoot: string,
  envelope: MaintainerGrantV2Envelope,
  input: Readonly<{
    operation: string;
    subjectId: string;
    bindingEvidence: unknown;
    refusalIdentity: Readonly<Record<string, unknown>>;
  }>,
): AuthorityRefusalAuditBinding {
  const mandateBinding = envelope.payload.mandateBinding;
  return {
    scope: {
      externalAuditRoot: mandateBinding.externalAuditRoot,
      repositoryRoot,
      repositoryId: deriveAuthorityAuditRepositoryId(
        envelope.payload.repositoryId,
      ),
    },
    family: 'authority-lifecycle',
    operation: input.operation,
    subjectId: input.subjectId,
    actor: { kind: 'engine', identity: 'workflow-engine' },
    taskId: mandateBinding.mandateTaskId,
    changeId: mandateBinding.changeId,
    workflowId: mandateBinding.mandateId,
    grantDigest: authorityRefusalDigest(
      canonicalMaintainerGrantV2Envelope(envelope),
    ),
    bindingDigest: authorityRefusalDigest(input.bindingEvidence),
    refusalIdentity: input.refusalIdentity,
  };
}

export function startAuthoritySession(
  cwd: string,
  requestedChangeId: string,
  requestedGrantId: string,
  options: AuthoritySessionOptions = {},
): AuthoritySession {
  const changeId = assertChangeId(requestedChangeId);
  const initial = discoverRepository(cwd);
  if (
    (!options.allowSignedV2Candidate && initial.statusEntries.length > 0) ||
    !initial.branch
  ) {
    throw authorityError(
      'AUTHORITY_START_DIRTY',
      'Authority start requires a clean named branch.',
    );
  }
  const sessionId = createSessionId();
  const reservation = reserveMaintainerGrant(
    initial.gitCommonDirectory,
    requestedGrantId,
    {
      sessionId,
      repositoryRoot: initial.repositoryRealPath,
      now: options.now,
    },
  );
  try {
    assertPostApprovalAdmissionDeadline(options.postApprovalDeadline);
    const envelope = reservation.envelope;
    if (
      reservation.repositoryRoot !== initial.repositoryRealPath ||
      envelope.payload.changeId !== changeId ||
      envelope.payload.baseCommit !== initial.head
    ) {
      throw authorityError(
        'AUTHORITY_GRANT_MISMATCH',
        'The reserved grant does not match this repository, change, or base.',
      );
    }
    const { policy, policyContent, policyBlob } = loadBasePolicy(
      initial.repositoryRoot,
      initial.head,
    );
    validateReservedGrantAuthorityBinding(
      initial.repositoryRoot,
      envelope,
      policy,
      {
        now: exactDate(options.now ?? new Date()),
        expectedBase: initial.head,
        expectedPolicyBlob: policyBlob,
        signer: options.signer,
      },
      initial.gitCommonDirectory,
      envelope.payload.grantId,
    );
    const refusalBinding = verifiedV2AuthorityLifecycleRefusalBinding(
      initial.repositoryRealPath,
      envelope,
      {
        operation: 'authority.start',
        subjectId: envelope.payload.grantId,
        bindingEvidence: {
          mandateBinding: envelope.payload.mandateBinding,
          grantDigest: digest(canonicalMaintainerGrantV2Envelope(envelope)),
        },
        refusalIdentity: {
          changeId,
          grantId: envelope.payload.grantId,
          branch: initial.branch,
          head: initial.head,
          allowSignedV2Candidate: options.allowSignedV2Candidate ?? false,
        },
      },
    );
    return withAuthorityRefusalAudit(
      refusalBinding,
      {
        now: options.now,
        serviceHooks: options.testRefusalAuditServiceHooks,
      },
      () => {
        if (initial.statusEntries.length > 0) {
          if (!options.allowSignedV2Candidate) {
            throw authorityError(
              'AUTHORITY_START_DIRTY',
              'A dirty v2 candidate requires the atomic approve-and-apply route.',
            );
          }
          verifyPatchManifestAgainstWorktree(
            initial.repositoryRoot,
            envelope.payload.manifest,
          );
          const candidate = envelope.payload.candidateBundle;
          const preview = previewExactStaging(
            initial.repositoryRoot,
            initial.head,
            envelope.payload.allowedPaths,
          );
          const facts = candidate
            ? commitFacts(initial.repositoryRoot, candidate.candidateCommit)
            : null;
          if (candidate) {
            acceptApplyPrestate(
              readDurableRefGenerationLedger(
                initial.gitCommonDirectory,
                candidate.targetRef,
                true,
              ),
              candidate.expectedOldCommit,
              candidate.expectedRefGeneration,
            );
          }
          if (
            candidate === null ||
            candidate.targetRef !== `refs/heads/${initial.branch}` ||
            candidate.expectedOldCommit !== initial.head ||
            candidate.resultTree !== preview.tree ||
            facts?.tree !== candidate.resultTree ||
            JSON.stringify(facts.parents) !== JSON.stringify([initial.head]) ||
            facts.message !== candidate.commitMessage
          ) {
            throw authorityError(
              'AUTHORITY_CANDIDATE_BINDING_INVALID',
              'Atomic approve-and-apply requires an exact immutable candidate commit and result tree.',
            );
          }
          if (envelope.payload.checksAttestation === null) {
            throw authorityError(
              'AUTHORITY_CHECK_REPORT_REQUIRED',
              'Atomic approve-and-apply requires signed pre-approval checks.',
            );
          }
        }
        assertExactAuditTag(initial.repositoryRoot, envelope, policy);
        const { git, contract } = loadStableValidatedChangeContract(
          initial,
          changeId,
        );
        const expectedBranch = contract.config.branchTemplate.replace(
          '{changeId}',
          changeId,
        );
        if (
          git.branch !== expectedBranch ||
          git.head !== envelope.payload.baseCommit
        ) {
          throw authorityError(
            'AUTHORITY_BRANCH_INVALID',
            `Authority start requires branch ${expectedBranch} at the exact grant base.`,
          );
        }
        const requiredChecks = [...envelope.payload.requiredChecks];
        const pinnedChecks = requiredChecks.map((checkId) => {
          const definition = contract.checks.checks[checkId];
          if (!definition) {
            throw authorityError(
              'AUTHORITY_CHECK_UNKNOWN',
              `Authority policy references unknown check ${checkId}.`,
            );
          }
          return {
            checkId,
            definition,
            runner: pinCheckRunner(git.repositoryRoot, checkId, definition),
          };
        });
        const createdAt = exactDate(options.now ?? new Date()).toISOString();
        const session: AuthoritySession = {
          schemaVersion: 1,
          sessionId,
          state: 'active',
          grantVersion: envelope.payload.version,
          grantId: envelope.payload.grantId,
          changeId,
          repositoryRoot: git.repositoryRealPath,
          gitCommonDirectory: git.gitCommonDirectory,
          branch: git.branch,
          baseCommit: git.head,
          baselineTree: git.tree,
          policyBlob,
          policyDigest: digest(policyContent),
          grantDigest: digest(canonicalMaintainerGrantV2Envelope(envelope)),
          signer: envelope.payload.signer,
          contractDigest: contract.contractDigest,
          contractArtifacts: Object.fromEntries(
            Object.entries(contract.artifactDigests).filter(
              ([filePath]) => !envelope.payload.allowedPaths.includes(filePath),
            ),
          ),
          allowedPaths: [...envelope.payload.allowedPaths],
          requiredChecks,
          pinnedChecks,
          candidateCommit:
            envelope.payload.candidateBundle?.candidateCommit ?? null,
          resultTree: envelope.payload.candidateBundle?.resultTree ?? null,
          candidateBundleDigest: envelope.payload.candidateBundleDigest,
          mandateBinding: envelope.payload.mandateBinding,
          expectedRefGeneration:
            envelope.payload.candidateBundle?.expectedRefGeneration ?? null,
          createdAt,
        };
        if (envelope.payload.checksAttestation !== null) {
          const fingerprint = fingerprintWorkingState(
            git.repositoryRoot,
            git.head,
            git.statusEntries,
          );
          const environmentDigest = maintainerChecksEnvironmentDigest(
            pinnedChecks.some(
              ({ definition }) => definition.destructiveDatabase,
            )
              ? assertDisposableDatabaseForRepository(
                  git.repositoryRoot,
                  options.environment ?? process.env,
                ).identity
              : null,
          );
          const checks = assertPreapprovalChecksCurrent(
            envelope.payload.checksAttestation,
            pinnedChecks,
            fingerprint,
            environmentDigest,
          );
          assertV2CandidateFresh(
            git.repositoryRoot,
            envelope,
            exactDate(options.now ?? new Date()),
            environmentDigest,
            options.environment,
            options.externalStateDigests,
          );
          const paths = maintainerGrantStorePaths(git.gitCommonDirectory);
          session.latestCheckReportId = writeAuthorityCheckReport(
            paths.runtime.reports,
            {
              sessionId,
              changeId,
              grantId: envelope.payload.grantId,
              baseCommit: git.head,
              policyBlob,
              contractDigest: contract.contractDigest,
              allowedPaths: session.allowedPaths,
              changedPaths: session.allowedPaths,
              requiredChecks,
              checks,
              fingerprint,
              createdAt:
                envelope.payload.checksAttestation.checks.at(-1)?.completedAt ??
                createdAt,
            },
          );
        }
        withRepositoryLifecycleOperation(
          runtimePaths(initial.gitCommonDirectory, 'workflow-engine'),
          (assertOwned) => {
            assertPostApprovalAdmissionDeadline(options.postApprovalDeadline);
            validateMaintainerGrantV2AuthorityBinding(
              initial.repositoryRoot,
              envelope,
              policy,
              {
                now: exactDate(options.now ?? new Date()),
                expectedBase: initial.head,
                expectedPolicyBlob: policyBlob,
                signer: options.signer,
                assertLifecycleOwned: assertOwned,
              },
            );
            const currentReservation = readReservedMaintainerGrant(
              initial.gitCommonDirectory,
              envelope.payload.grantId,
            );
            if (currentReservation.sessionId !== sessionId) {
              throw authorityError(
                'AUTHORITY_RESERVATION_MISMATCH',
                'Authority reservation changed before durable session publication.',
              );
            }
            assertPostApprovalAdmissionDeadline(options.postApprovalDeadline);
            writeAuthoritySession(session, true);
          },
          { allowMaintainerGrantId: envelope.payload.grantId },
        );
        return session;
      },
    );
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) {
      enterPostApprovalTerminalCleanup(options.postApprovalDeadline);
      terminallyFailMaintainerReservation(
        initial.gitCommonDirectory,
        reservation.grantId,
        sessionId,
        failureReason(error),
        options.now,
      );
      throw error;
    }
    // Everything before the durable session write is read-only, so a start
    // failure is a recoverable precondition: return the grant to the
    // available store instead of burning the one-shot signature. Fall back
    // to terminal revocation only if the release itself cannot complete.
    try {
      const evaluatedAt = exactDate(options.now ?? new Date());
      if (
        Date.parse(reservation.envelope.payload.expiresAt) <
        evaluatedAt.getTime()
      ) {
        terminallyExpireMaintainerReservation(
          initial.gitCommonDirectory,
          reservation.grantId,
          sessionId,
          failureReason(error),
          evaluatedAt,
        );
      } else {
        releaseMaintainerReservation(
          initial.gitCommonDirectory,
          reservation.grantId,
          sessionId,
        );
      }
    } catch {
      terminallyRevokeMaintainerReservation(
        initial.gitCommonDirectory,
        reservation.grantId,
        sessionId,
        failureReason(error),
        options.now,
      );
    }
    throw error;
  }
}

export function abortAuthoritySession(
  cwd: string,
  requestedSessionId: string,
  reason: string,
  now = new Date(),
): AuthoritySession {
  const session = readAuthoritySession(cwd, requestedSessionId);
  if (session.state !== 'active' || !reason || reason.trim() !== reason) {
    throw authorityError(
      'AUTHORITY_ABORT_INVALID',
      'Only an active authority session may be aborted with an exact reason.',
    );
  }
  terminallyRevokeMaintainerReservation(
    session.gitCommonDirectory,
    session.grantId,
    session.sessionId,
    `Authority cancellation: ${reason}`,
    now,
  );
  const aborted: AuthoritySession = {
    ...session,
    state: 'aborted',
    abortedAt: exactDate(now).toISOString(),
    abortReason: reason,
  };
  writeAuthoritySession(aborted, false);
  return aborted;
}

export function readAuthoritySession(
  cwd: string,
  requestedSessionId: string,
): AuthoritySession {
  const git = discoverRepository(cwd);
  const sessionId = assertSessionId(requestedSessionId);
  const paths = maintainerGrantStorePaths(git.gitCommonDirectory);
  const sessionPath = path.join(paths.sessions, `${sessionId}.json`);
  const stats = fs.lstatSync(sessionPath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.nlink !== 1 ||
    (stats.mode & 0o777) !== 0o600
  ) {
    throw authorityError(
      'AUTHORITY_SESSION_INVALID',
      'Authority session state is unavailable or unsafe.',
    );
  }
  try {
    const raw = fs.readFileSync(sessionPath, 'utf8');
    const value = JSON.parse(raw) as AuthoritySession;
    if (
      raw !== `${JSON.stringify(value)}\n` ||
      value.schemaVersion !== 1 ||
      value.sessionId !== sessionId ||
      !['active', 'failed', 'aborted', 'committed'].includes(value.state) ||
      value.gitCommonDirectory !== git.gitCommonDirectory ||
      value.grantVersion !== 2 ||
      typeof value.mandateBinding !== 'object' ||
      value.mandateBinding === null ||
      !Array.isArray(value.allowedPaths) ||
      !Array.isArray(value.requiredChecks) ||
      !Array.isArray(value.pinnedChecks)
    ) {
      throw new Error('invalid authority session');
    }
    return value;
  } catch {
    throw authorityError(
      'AUTHORITY_SESSION_INVALID',
      'Authority session state is malformed.',
    );
  }
}

export function inspectActiveAuthoritySession(
  cwd: string,
  requestedSessionId: string,
  options: AuthoritySessionOptions = {},
) {
  const session = readAuthoritySession(cwd, requestedSessionId);
  if (session.state !== 'active') {
    throw authorityError(
      'AUTHORITY_SESSION_NOT_ACTIVE',
      `Authority session ${session.sessionId} is ${session.state}.`,
    );
  }
  return { session, ...inspectAuthoritySession(cwd, session, options) };
}

export function markAuthoritySessionCommitted(
  cwd: string,
  expected: AuthoritySession,
  commitHash: string,
  now = new Date(),
): AuthoritySession {
  const current = readAuthoritySession(cwd, expected.sessionId);
  if (current.state === 'committed' && current.commitHash === commitHash) {
    return current;
  }
  if (
    current.state !== 'active' ||
    JSON.stringify(current) !== JSON.stringify(expected) ||
    !/^[0-9a-f]{40,64}$/.test(commitHash)
  ) {
    throw authorityError(
      'AUTHORITY_SESSION_CHANGED',
      'Authority session changed before commit finalization.',
    );
  }
  const committed: AuthoritySession = {
    ...current,
    state: 'committed',
    committedAt: exactDate(now).toISOString(),
    commitHash,
  };
  writeAuthoritySession(committed, false);
  return committed;
}

function validateReservedGrantAuthorityBinding(
  repositoryRoot: string,
  envelope: MaintainerGrantV2Envelope,
  policy: MaintainerPolicy,
  options: Parameters<typeof validateMaintainerGrantV2AuthorityBinding>[3],
  gitCommonDirectory: string,
  grantId: string,
): void {
  if (options.assertLifecycleOwned) {
    validateMaintainerGrantV2AuthorityBinding(
      repositoryRoot,
      envelope,
      policy,
      options,
    );
    return;
  }
  withRepositoryLifecycleOperation(
    runtimePaths(gitCommonDirectory, 'workflow-engine'),
    (assertOwned) =>
      validateMaintainerGrantV2AuthorityBinding(
        repositoryRoot,
        envelope,
        policy,
        { ...options, assertLifecycleOwned: assertOwned },
      ),
    { allowMaintainerGrantId: grantId },
  );
}

function assertV2CandidateFresh(
  repositoryRoot: string,
  envelope: import('../../modules/authority/maintainer-grant-v2.ts').MaintainerGrantV2Envelope,
  now: Date,
  environmentDigest: string,
  environment: NodeJS.ProcessEnv | undefined,
  externalStateDigests: Readonly<Record<string, string>> | undefined,
): void {
  const candidate = envelope.payload.candidateBundle;
  if (candidate === null) return;
  assertCandidateV2ChecksFresh(candidate.checksAttestation, {
    now,
    candidateTree: candidate.resultTree,
    patchDigest: envelope.payload.patchDigest,
    trustBaseCommit: envelope.payload.baseCommit,
    requiredChecks: envelope.payload.requiredChecks,
    waivedFreshnessCheckIds: envelope.payload.evidenceWaivers.map(
      ({ checkId }) => checkId,
    ),
    environmentDigest,
    currentDependencySnapshot: currentCandidateDependencySnapshot({
      cwd: repositoryRoot,
      repositoryId: envelope.payload.repositoryId,
      candidateTree: candidate.resultTree,
      baseCommit: envelope.payload.baseCommit,
      policyDigest: envelope.payload.policyDigest,
      checks: candidate.checksAttestation.checks,
      environment,
      externalStateDigests,
    }),
  });
}

export function failAuthoritySession(
  session: AuthoritySession,
  error: unknown,
  now = new Date(),
): void {
  const evaluatedAt = exactDate(now);
  const grant = inspectMaintainerGrants(
    session.gitCommonDirectory,
    session.grantId,
  )[0];
  const terminalize = isPostApprovalAdmissionFailure(error)
    ? terminallyFailMaintainerReservation
    : grant !== undefined &&
        Date.parse(grant.expiresAt) <= evaluatedAt.getTime()
      ? terminallyExpireMaintainerReservation
      : isSemanticAuthorityInvalidation(error)
        ? terminallyInvalidateMaintainerReservation
        : terminallyRevokeMaintainerReservation;
  terminalize(
    session.gitCommonDirectory,
    session.grantId,
    session.sessionId,
    failureReason(error),
    evaluatedAt,
  );
  writeAuthoritySession(
    {
      ...session,
      state: 'failed',
      failedAt: evaluatedAt.toISOString(),
      failureReason: failureReason(error),
    },
    false,
  );
}

const SEMANTIC_AUTHORITY_INVALIDATIONS = new Set([
  'AUTHORITY_BASE_DRIFT',
  'AUTHORITY_CANDIDATE_BINDING_INVALID',
  'AUTHORITY_CANDIDATE_TREE_MISMATCH',
  'AUTHORITY_CAS_OUTCOME_AMBIGUOUS',
  'AUTHORITY_CONTRACT_DRIFT',
  'AUTHORITY_POLICY_DRIFT',
  'APPLY_REF_GENERATION_MISMATCH',
  'APPLY_REF_PRESTATE_MISMATCH',
  'MAINTAINER_PATCH_DRIFT',
]);

function isSemanticAuthorityInvalidation(error: unknown): boolean {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code: unknown }).code
      : undefined;
  return typeof code === 'string' && SEMANTIC_AUTHORITY_INVALIDATIONS.has(code);
}

function loadBasePolicy(repositoryRoot: string, baseCommit: string) {
  try {
    const policyContent = runGit(repositoryRoot, [
      'show',
      `${baseCommit}:workflow/maintainer-policy.json`,
    ]);
    const policy = parseMaintainerPolicy(JSON.parse(policyContent));
    const policyBlob = runGit(repositoryRoot, [
      'rev-parse',
      `${baseCommit}:workflow/maintainer-policy.json`,
    ]).trim();
    return { policy, policyContent, policyBlob };
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) throw error;
    throw authorityError(
      'AUTHORITY_POLICY_INVALID',
      'The exact base maintainer policy is unavailable or invalid.',
    );
  }
}

function assertExactAuditTag(
  repositoryRoot: string,
  envelope: MaintainerGrantV2Envelope,
  policy: MaintainerPolicy,
): void {
  const tagRef = `${policy.auditTagPrefix}${envelope.payload.grantId}`;
  try {
    const raw = runGit(repositoryRoot, ['cat-file', 'tag', tagRef]);
    const separator = raw.indexOf('\n\n');
    const headers = raw.slice(0, separator).split('\n');
    const object = headers.find((line) => line.startsWith('object '))?.slice(7);
    const type = headers.find((line) => line.startsWith('type '))?.slice(5);
    const tag = headers.find((line) => line.startsWith('tag '))?.slice(4);
    if (
      separator === -1 ||
      object !== envelope.payload.baseCommit ||
      type !== 'commit' ||
      tag !== tagRef.slice('refs/tags/'.length) ||
      raw.slice(separator + 2) !== canonicalMaintainerGrantV2Envelope(envelope)
    ) {
      throw new Error('audit mismatch');
    }
  } catch (error) {
    if (isPostApprovalAdmissionFailure(error)) throw error;
    throw authorityError(
      'AUTHORITY_AUDIT_TAG_INVALID',
      'The exact maintainer audit tag is missing or different.',
    );
  }
}

function writeAuthoritySession(
  session: AuthoritySession,
  create: boolean,
): void {
  const paths = maintainerGrantStorePaths(session.gitCommonDirectory);
  const target = path.join(paths.sessions, `${session.sessionId}.json`);
  const temporary = `${target}.${process.pid}.tmp`;
  const content = `${JSON.stringify(session)}\n`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (create) {
      try {
        fs.linkSync(temporary, target);
        fs.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw authorityError(
            'AUTHORITY_SESSION_EXISTS',
            'Authority session state already exists.',
          );
        }
        throw error;
      }
    } else {
      fs.renameSync(temporary, target);
    }
    const directory = fs.openSync(paths.sessions, fs.constants.O_RDONLY);
    fs.fsyncSync(directory);
    fs.closeSync(directory);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function sameStringArray(left: string[], right: string[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameRecord(
  left: Record<string, string>,
  right: Record<string, string>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactDate(value: Date): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw authorityError(
      'AUTHORITY_TIME_INVALID',
      'Authority transition requires an exact timestamp.',
    );
  }
  return date;
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function failureReason(error: unknown): string {
  return error instanceof WorkflowError
    ? `${error.code}: ${error.message}`
    : 'AUTHORITY_OPERATION_FAILED';
}

function authorityError(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(code, message, ExitCode.staleState, { details });
}

export type MaintainerSessionInspectionBindings = {
  readAuthoritySession: typeof readAuthoritySession;
  authorityError: typeof authorityError;
  withAuthorityRefusalAudit: typeof withAuthorityRefusalAudit;
  verifiedV2AuthorityLifecycleRefusalBinding: typeof verifiedV2AuthorityLifecycleRefusalBinding;
  authorityRefusalDigest: typeof authorityRefusalDigest;
  listChangedPaths: typeof listChangedPaths;
  verifyPatchManifestAgainstWorktree: typeof verifyPatchManifestAgainstWorktree;
  assertDisposableDatabaseForRepository: typeof assertDisposableDatabaseForRepository;
  fingerprintWorkingState: typeof fingerprintWorkingState;
  runCheck: typeof runCheck;
  createCheckEnvironmentForRepository: typeof createCheckEnvironmentForRepository;
  discoverRepository: typeof discoverRepository;
  maintainerGrantStorePaths: typeof maintainerGrantStorePaths;
  writeAuthorityCheckReport: typeof writeAuthorityCheckReport;
  exactDate: typeof exactDate;
  writeAuthoritySession: typeof writeAuthoritySession;
  failAuthoritySession: typeof failAuthoritySession;
  readReservedMaintainerGrant: typeof readReservedMaintainerGrant;
  digest: typeof digest;
  canonicalMaintainerGrantV2Envelope: typeof canonicalMaintainerGrantV2Envelope;
  loadBasePolicy: typeof loadBasePolicy;
  validateReservedGrantAuthorityBinding: typeof validateReservedGrantAuthorityBinding;
  assertExactAuditTag: typeof assertExactAuditTag;
  loadStableValidatedChangeContract: typeof loadStableValidatedChangeContract;
  sameRecord: typeof sameRecord;
  pinCheckRunner: typeof pinCheckRunner;
  sameStringArray: typeof sameStringArray;
  canonicalJson: typeof canonicalJson;
  maintainerChecksEnvironmentDigest: typeof maintainerChecksEnvironmentDigest;
  assertV2CandidateFresh: typeof assertV2CandidateFresh;
  runGit: typeof runGit;
  isPostApprovalAdmissionFailure: typeof isPostApprovalAdmissionFailure;
};
export type MaintainerSessionInspectionBindingsTypes = {
  AuthoritySessionOptions: AuthoritySessionOptions;
  CheckEvidence: CheckEvidence;
  AuthoritySession: AuthoritySession;
  AuthorityPinnedCheck: AuthorityPinnedCheck;
  CheckDefinition: CheckDefinition;
};

const {
  checkAuthoritySession,
  inspectAuthoritySession,
  assertPreapprovalChecksCurrent,
} = createMaintainerSessionInspection(() => ({
  readAuthoritySession,
  authorityError,
  withAuthorityRefusalAudit,
  verifiedV2AuthorityLifecycleRefusalBinding,
  authorityRefusalDigest,
  listChangedPaths,
  verifyPatchManifestAgainstWorktree,
  assertDisposableDatabaseForRepository,
  fingerprintWorkingState,
  runCheck,
  createCheckEnvironmentForRepository,
  discoverRepository,
  maintainerGrantStorePaths,
  writeAuthorityCheckReport,
  exactDate,
  writeAuthoritySession,
  failAuthoritySession,
  readReservedMaintainerGrant,
  digest,
  canonicalMaintainerGrantV2Envelope,
  loadBasePolicy,
  validateReservedGrantAuthorityBinding,
  assertExactAuditTag,
  loadStableValidatedChangeContract,
  sameRecord,
  pinCheckRunner,
  sameStringArray,
  canonicalJson,
  maintainerChecksEnvironmentDigest,
  assertV2CandidateFresh,
  runGit,
  isPostApprovalAdmissionFailure,
}));
export { checkAuthoritySession };
