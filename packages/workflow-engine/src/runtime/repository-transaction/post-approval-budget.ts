/**
 * Tracks one post-approval admission deadline across Git and signer subprocesses.
 *
 * Invariants:
 * - Async-local deadline state, monotonic clocks, and completion obligations retain their semantics.
 * - Test hooks cannot raise the production admission cap or alter terminal cleanup exceptions.
 *
 * Depends on: monotonic time, async-local storage, and workflow timeout errors.
 * Failure modes: approval expires mid-transaction or mandatory cleanup is incorrectly denied.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export const POST_APPROVAL_ADMISSION_LIMIT_MS = 10_000;

export type PostApprovalBudgetTestOptions = {
  /** Test-only shorter limit; production callers cannot raise the code-owned cap. */
  limitMs?: number;
  monotonicNow?: () => number;
  onArm?: () => void;
  beforeGit?: (input: { args: string[]; timeoutMs: number }) => void;
  beforeProcess?: (input: {
    kind: 'ssh-keygen';
    executable: string;
    args: string[];
    timeoutMs: number;
  }) => void;
  onCompletionObligatory?: () => void;
};

export type PostApprovalAdmissionDeadline = {
  readonly limitMs: number;
  readonly monotonicNow: () => number;
  readonly enforceProcessTimeout: boolean;
  readonly testHooks: Omit<
    PostApprovalBudgetTestOptions,
    'limitMs' | 'monotonicNow'
  >;
  phase: 'unarmed' | 'admission' | 'completion-obligatory' | 'terminal-cleanup';
  startedAtMonotonicMs: number | null;
  lastObservedMonotonicMs: number | null;
};

const postApprovalDeadlineStorage =
  new AsyncLocalStorage<PostApprovalAdmissionDeadline>();

export function createPostApprovalAdmissionDeadline(
  testOptions: PostApprovalBudgetTestOptions = {},
): PostApprovalAdmissionDeadline {
  const limitMs = testOptions.limitMs ?? POST_APPROVAL_ADMISSION_LIMIT_MS;
  if (
    !Number.isInteger(limitMs) ||
    limitMs < 1 ||
    limitMs > POST_APPROVAL_ADMISSION_LIMIT_MS
  ) {
    throw workflowError(
      'AUTHORITY_POST_APPROVAL_BUDGET_INVALID',
      'Post-approval admission uses a positive code-owned timeout bound.',
      ExitCode.usage,
    );
  }
  return {
    limitMs,
    monotonicNow: testOptions.monotonicNow ?? (() => performance.now()),
    enforceProcessTimeout: testOptions.monotonicNow === undefined,
    testHooks: {
      onArm: testOptions.onArm,
      beforeGit: testOptions.beforeGit,
      beforeProcess: testOptions.beforeProcess,
      onCompletionObligatory: testOptions.onCompletionObligatory,
    },
    phase: 'unarmed',
    startedAtMonotonicMs: null,
    lastObservedMonotonicMs: null,
  };
}

export function withPostApprovalAdmissionDeadline<T>(
  deadline: PostApprovalAdmissionDeadline,
  operation: () => T,
): T {
  return postApprovalDeadlineStorage.run(deadline, operation);
}

export function armPostApprovalAdmissionDeadline(
  deadline: PostApprovalAdmissionDeadline,
): void {
  if (deadline.phase !== 'unarmed') {
    throw workflowError(
      'AUTHORITY_POST_APPROVAL_BUDGET_INVALID',
      'Post-approval admission may be armed exactly once.',
      ExitCode.guard,
    );
  }
  deadline.startedAtMonotonicMs = readPostApprovalMonotonicClock(deadline);
  deadline.phase = 'admission';
  deadline.testHooks.onArm?.();
}

export function assertPostApprovalAdmissionDeadline(
  deadline: PostApprovalAdmissionDeadline | undefined,
): void {
  if (deadline === undefined || deadline.phase !== 'admission') return;
  remainingPostApprovalAdmissionMillis(deadline);
}

export function assertPostApprovalAdmissionPhase(
  deadline: PostApprovalAdmissionDeadline,
): void {
  if (deadline.phase === 'unarmed' || deadline.phase === 'admission') return;
  throw workflowError(
    'AUTHORITY_POST_APPROVAL_BUDGET_INVALID',
    'Pre-CAS authority work requires an unarmed or active admission deadline.',
    ExitCode.guard,
  );
}

export function enterPostApprovalCompletionObligation(
  deadline: PostApprovalAdmissionDeadline | undefined,
  options: { allowExpired?: boolean } = {},
): void {
  if (deadline === undefined || deadline.phase === 'completion-obligatory') {
    return;
  }
  if (deadline.phase === 'terminal-cleanup') {
    throw workflowError(
      'AUTHORITY_POST_APPROVAL_BUDGET_INVALID',
      'A terminal-cleanup authority transaction cannot become completion-obligatory.',
      ExitCode.guard,
    );
  }
  if (deadline.phase === 'unarmed') {
    if (options.allowExpired) {
      deadline.phase = 'completion-obligatory';
      deadline.testHooks.onCompletionObligatory?.();
      return;
    }
    armPostApprovalAdmissionDeadline(deadline);
  }
  if (!options.allowExpired) assertPostApprovalAdmissionDeadline(deadline);
  deadline.phase = 'completion-obligatory';
  deadline.testHooks.onCompletionObligatory?.();
}

export function enterPostApprovalTerminalCleanup(
  deadline: PostApprovalAdmissionDeadline | undefined,
): void {
  if (deadline === undefined || deadline.phase === 'terminal-cleanup') return;
  if (deadline.phase === 'completion-obligatory') {
    throw workflowError(
      'AUTHORITY_POST_APPROVAL_BUDGET_INVALID',
      'A completion-obligatory authority transaction cannot return to pre-CAS cleanup.',
      ExitCode.guard,
    );
  }
  deadline.phase = 'terminal-cleanup';
}

export function enterActivePostApprovalTerminalCleanup(): void {
  enterPostApprovalTerminalCleanup(postApprovalDeadlineStorage.getStore());
}

export function isPostApprovalAdmissionFailure(error: unknown): boolean {
  if (error === null || typeof error !== 'object' || !('code' in error)) {
    return false;
  }
  return (
    error.code === 'AUTHORITY_POST_APPROVAL_TIMEOUT' ||
    error.code === 'AUTHORITY_POST_APPROVAL_CLOCK_INVALID'
  );
}

export type PostApprovalSubprocessBudget = {
  processTimeoutMs: number | undefined;
};

export function postApprovalSubprocessBudget(
  kind: 'ssh-keygen',
  executable: string,
  args: string[],
): PostApprovalSubprocessBudget | undefined {
  const deadline = postApprovalDeadlineStorage.getStore();
  if (deadline === undefined || deadline.phase !== 'admission') {
    return undefined;
  }
  const timeoutMs = Math.max(
    1,
    Math.ceil(remainingPostApprovalAdmissionMillis(deadline)),
  );
  try {
    deadline.testHooks.beforeProcess?.({
      kind,
      executable,
      args: [...args],
      timeoutMs,
    });
  } catch (error) {
    if (isProcessTimeout(error)) throw postApprovalAdmissionTimeout();
    throw error;
  }
  assertPostApprovalAdmissionDeadline(deadline);
  return {
    processTimeoutMs: deadline.enforceProcessTimeout ? timeoutMs : undefined,
  };
}

export function normalizePostApprovalSubprocessError(
  budget: PostApprovalSubprocessBudget | undefined,
  error: unknown,
): void {
  if (budget !== undefined && isProcessTimeout(error)) {
    throw postApprovalAdmissionTimeout();
  }
}

function remainingPostApprovalAdmissionMillis(
  deadline: PostApprovalAdmissionDeadline,
): number {
  if (
    deadline.phase !== 'admission' ||
    deadline.startedAtMonotonicMs === null
  ) {
    throw workflowError(
      'AUTHORITY_POST_APPROVAL_BUDGET_INVALID',
      'Post-approval admission deadline is not active.',
      ExitCode.guard,
    );
  }
  const remaining =
    deadline.startedAtMonotonicMs +
    deadline.limitMs -
    readPostApprovalMonotonicClock(deadline);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw postApprovalAdmissionTimeout();
  }
  return remaining;
}

function readPostApprovalMonotonicClock(
  deadline: PostApprovalAdmissionDeadline,
): number {
  const observed = deadline.monotonicNow();
  if (
    !Number.isFinite(observed) ||
    (deadline.lastObservedMonotonicMs !== null &&
      observed < deadline.lastObservedMonotonicMs)
  ) {
    throw workflowError(
      'AUTHORITY_POST_APPROVAL_CLOCK_INVALID',
      'Post-approval admission requires a finite monotonic clock.',
      ExitCode.unsafeEnvironment,
    );
  }
  deadline.lastObservedMonotonicMs = observed;
  return observed;
}

export function activePostApprovalGitTimeout(
  args: string[],
): { processTimeoutMs: number | undefined } | undefined {
  const deadline = postApprovalDeadlineStorage.getStore();
  if (deadline === undefined || deadline.phase !== 'admission')
    return undefined;
  const timeoutMs = Math.max(
    1,
    Math.ceil(remainingPostApprovalAdmissionMillis(deadline)),
  );
  try {
    deadline.testHooks.beforeGit?.({ args: [...args], timeoutMs });
  } catch (error) {
    if (isProcessTimeout(error)) throw postApprovalAdmissionTimeout();
    throw error;
  }
  assertPostApprovalAdmissionDeadline(deadline);
  return {
    processTimeoutMs: deadline.enforceProcessTimeout ? timeoutMs : undefined,
  };
}

export function postApprovalAdmissionTimeout() {
  return workflowError(
    'AUTHORITY_POST_APPROVAL_TIMEOUT',
    'Post-approval admission exceeded its code-owned operational deadline before CAS.',
    ExitCode.staleState,
  );
}

export function isProcessTimeout(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'ETIMEDOUT'
  );
}
