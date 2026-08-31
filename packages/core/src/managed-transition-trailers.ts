export type TaskManagedTrailers = {
  kind: 'task';
  changeId: string;
  taskId: string;
};

export type PlanManagedTrailers = {
  kind: 'plan';
  changeId: string;
  transition: 'plan';
};

export type ArchiveManagedTrailers = {
  kind: 'archive';
  changeId: string;
  transition: 'archive';
};

export type AuthorityManagedTrailers = {
  kind: 'authority';
  changeId: string;
  transition: 'authority-maintenance';
  grantId: string;
};

export type AuthorityCandidateManagedTrailers = {
  kind: 'authority-candidate';
  changeId: string;
  transition: 'authority-candidate';
};

export type RouteManagedTrailers = {
  kind: 'route';
  transition: 'route';
  routingReview: string;
};

export type CentralAuthorityCommitProvenance = Readonly<{
  candidateDigest: string;
  challengeId: string;
  operationId: string;
  approvalSubjectDigest: string;
  preparedGrantRecordDigest: string;
}>;

export type CentralAuthorityManagedTrailers = Readonly<{
  kind: 'central-authority';
  transition: 'git.authority-candidate.apply.v1';
}> &
  CentralAuthorityCommitProvenance;

/**
 * What an amendment records about itself.
 *
 * A plan revision after execution has to say more than that it happened: which
 * generation it replaces, whether the work already done still stands, and which
 * review looked at the corrected plan. Every one of those is a fact a later
 * reader needs and none of them can be recovered from the diff.
 */
export type AmendPlanManagedTrailers = {
  kind: 'amend-plan';
  changeId: string;
  transition: 'amend-plan';
  planningGeneration: string;
  amendsPlanningGeneration: string;
  executionImpact: 'none' | 'required';
  planReview: string;
};

export type ManagedTrailers =
  | TaskManagedTrailers
  | AmendPlanManagedTrailers
  | PlanManagedTrailers
  | ArchiveManagedTrailers
  | RouteManagedTrailers
  | AuthorityManagedTrailers
  | AuthorityCandidateManagedTrailers
  | CentralAuthorityManagedTrailers;

// Every managed trailer name is reserved, including the amendment's, so an
// ordinary commit cannot fabricate one by writing the line itself.
const RESERVED_TRAILER_LINE =
  /^[\t ]*(?:change|task|transition|grant|planning-generation|amends-planning-generation|execution-impact|plan-review|routing-review|candidate|grant-challenge|grant-operation|approval-subject|prepared-grant)[\t ]*:/i;
const CHANGE_TRAILER = /^Change: ([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const TASK_TRAILER = /^Task: (\d+(?:\.\d+)+)$/;
const TRANSITION_TRAILER =
  /^Transition: (plan|amend-plan|archive|route|authority-maintenance|authority-candidate)$/;
const PLANNING_GENERATION_TRAILER = /^Planning-Generation: ([0-9a-f]{64})$/;
const AMENDS_GENERATION_TRAILER =
  /^Amends-Planning-Generation: ([0-9a-f]{64})$/;
const EXECUTION_IMPACT_TRAILER = /^Execution-Impact: (none|required)$/;
const PLAN_REVIEW_TRAILER = /^Plan-Review: ([0-9a-f]{64})$/;
const ROUTING_REVIEW_TRAILER = /^Routing-Review: ([0-9a-f]{64})$/;
const AMEND_TRAILER_LINES = 6;
const GRANT_TRAILER =
  /^Grant: ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const CENTRAL_TRANSITION_TRAILER =
  /^Transition: (git\.authority-candidate\.apply\.v1)$/;
const PREFIXED_SHA256_TRAILER_VALUE = 'sha256:[0-9a-f]{64}';
const CENTRAL_CANDIDATE_TRAILER = new RegExp(
  `^Candidate: (${PREFIXED_SHA256_TRAILER_VALUE})$`,
);
const CENTRAL_CHALLENGE_TRAILER =
  /^Grant-Challenge: ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const CENTRAL_OPERATION_TRAILER =
  /^Grant-Operation: ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const CENTRAL_APPROVAL_SUBJECT_TRAILER = new RegExp(
  `^Approval-Subject: (${PREFIXED_SHA256_TRAILER_VALUE})$`,
);
const CENTRAL_PREPARED_GRANT_TRAILER = new RegExp(
  `^Prepared-Grant: (${PREFIXED_SHA256_TRAILER_VALUE})$`,
);
const CENTRAL_TRAILER_LINES = 6;
const CENTRAL_PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;
const CENTRAL_UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CENTRAL_PROVENANCE_KEYS = Object.freeze([
  'approvalSubjectDigest',
  'candidateDigest',
  'challengeId',
  'operationId',
  'preparedGrantRecordDigest',
] as const);

export class ManagedTrailerSyntaxError extends Error {
  constructor() {
    super('Commit message contains a non-canonical managed trailer block.');
    this.name = 'ManagedTrailerSyntaxError';
  }
}

/**
 * Returns true for canonical and malformed attempts to use a reserved managed
 * trailer. This is intentionally broader than the canonical grammar so an
 * ordinary commit cannot bypass the workflow by changing case or whitespace.
 */
export function hasManagedTrailerLine(message: string): boolean {
  return message.split('\n').some((line) => RESERVED_TRAILER_LINE.test(line));
}

export function isCentralAuthorityCommitSubject(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 200 &&
    value.trim() === value &&
    !/[\p{Cc}\u2028\u2029]/u.test(value)
  );
}

export function isCentralAuthorityCommitProvenance(
  value: unknown,
): value is CentralAuthorityCommitProvenance {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== CENTRAL_PROVENANCE_KEYS.length ||
    keys.some((key, index) => key !== CENTRAL_PROVENANCE_KEYS[index])
  ) {
    return false;
  }
  return (
    typeof record.candidateDigest === 'string' &&
    CENTRAL_PREFIXED_SHA256.test(record.candidateDigest) &&
    typeof record.challengeId === 'string' &&
    CENTRAL_UUID_V4.test(record.challengeId) &&
    typeof record.operationId === 'string' &&
    CENTRAL_UUID_V4.test(record.operationId) &&
    typeof record.approvalSubjectDigest === 'string' &&
    CENTRAL_PREFIXED_SHA256.test(record.approvalSubjectDigest) &&
    typeof record.preparedGrantRecordDigest === 'string' &&
    CENTRAL_PREFIXED_SHA256.test(record.preparedGrantRecordDigest)
  );
}

/**
 * Parse the exact, final managed trailer block from a raw Git commit message.
 * Truly unmanaged messages return undefined; any reserved-but-invalid shape
 * fails closed instead of being reclassified as unmanaged.
 */
/**
 * The amendment block is fixed and exact: six lines in one order, or nothing.
 *
 * Reading it positionally, like the other managed blocks, is what stops an
 * ordinary commit from claiming an amendment by writing a few of the lines and
 * leaving the rest to be assumed.
 */
function parseAmendmentTrailers(
  lines: readonly string[],
): AmendPlanManagedTrailers | undefined {
  const start = -AMEND_TRAILER_LINES;
  if (
    TRANSITION_TRAILER.exec(lines.at(start + 1) ?? '')?.[1] !== 'amend-plan'
  ) {
    return undefined;
  }
  const change = CHANGE_TRAILER.exec(lines.at(start) ?? '');
  const generation = PLANNING_GENERATION_TRAILER.exec(
    lines.at(start + 2) ?? '',
  );
  const amends = AMENDS_GENERATION_TRAILER.exec(lines.at(start + 3) ?? '');
  const impact = EXECUTION_IMPACT_TRAILER.exec(lines.at(start + 4) ?? '');
  const review = PLAN_REVIEW_TRAILER.exec(lines.at(start + 5) ?? '');
  const earlierReservedLine = lines
    .slice(0, start)
    .some((line) => RESERVED_TRAILER_LINE.test(line));
  if (
    lines.at(start - 1) !== '' ||
    !change ||
    !generation ||
    !amends ||
    !impact ||
    !review ||
    earlierReservedLine ||
    // An amendment that claims to replace itself has recorded nothing.
    generation[1] === amends[1]
  ) {
    throw new ManagedTrailerSyntaxError();
  }
  return {
    kind: 'amend-plan',
    changeId: change[1],
    transition: 'amend-plan',
    planningGeneration: generation[1],
    amendsPlanningGeneration: amends[1],
    executionImpact: impact[1] as 'none' | 'required',
    planReview: review[1],
  };
}

function parseCentralAuthorityTrailers(
  lines: readonly string[],
): CentralAuthorityManagedTrailers | undefined {
  const start = -CENTRAL_TRAILER_LINES;
  const transition = CENTRAL_TRANSITION_TRAILER.exec(lines.at(start) ?? '');
  if (!transition) return undefined;

  const candidate = CENTRAL_CANDIDATE_TRAILER.exec(lines.at(start + 1) ?? '');
  const challenge = CENTRAL_CHALLENGE_TRAILER.exec(lines.at(start + 2) ?? '');
  const operation = CENTRAL_OPERATION_TRAILER.exec(lines.at(start + 3) ?? '');
  const approvalSubject = CENTRAL_APPROVAL_SUBJECT_TRAILER.exec(
    lines.at(start + 4) ?? '',
  );
  const preparedGrant = CENTRAL_PREPARED_GRANT_TRAILER.exec(
    lines.at(start + 5) ?? '',
  );
  const earlierReservedLine = lines
    // The first line is the approval-bound commit subject, not another
    // trailer. Reserved attempts anywhere in the body still fail closed.
    .slice(1, start)
    .some((line) => RESERVED_TRAILER_LINE.test(line));
  const provenance: CentralAuthorityCommitProvenance = {
    candidateDigest: candidate?.[1] ?? '',
    challengeId: challenge?.[1] ?? '',
    operationId: operation?.[1] ?? '',
    approvalSubjectDigest: approvalSubject?.[1] ?? '',
    preparedGrantRecordDigest: preparedGrant?.[1] ?? '',
  };
  if (
    lines.at(start - 1) !== '' ||
    !isCentralAuthorityCommitSubject(lines.at(0)) ||
    !isCentralAuthorityCommitProvenance(provenance) ||
    earlierReservedLine
  ) {
    throw new ManagedTrailerSyntaxError();
  }
  return {
    kind: 'central-authority',
    transition: 'git.authority-candidate.apply.v1',
    ...provenance,
  };
}

export function parseManagedTrailers(
  message: string,
): ManagedTrailers | undefined {
  if (!hasManagedTrailerLine(message)) {
    return undefined;
  }

  const normalized = message.endsWith('\n') ? message.slice(0, -1) : message;
  const lines = normalized.split('\n');
  const centralAuthority = parseCentralAuthorityTrailers(lines);
  if (centralAuthority !== undefined) return centralAuthority;
  const amendment = parseAmendmentTrailers(lines);
  if (amendment !== undefined) return amendment;
  const routeTransition =
    TRANSITION_TRAILER.exec(lines.at(-2) ?? '')?.[1] === 'route';
  const routingReview = ROUTING_REVIEW_TRAILER.exec(lines.at(-1) ?? '');
  if (routeTransition || routingReview) {
    if (
      !routeTransition ||
      !routingReview ||
      lines.at(-3) !== '' ||
      lines.slice(0, -2).some((line) => RESERVED_TRAILER_LINE.test(line))
    ) {
      throw new ManagedTrailerSyntaxError();
    }
    return {
      kind: 'route',
      transition: 'route',
      routingReview: routingReview[1],
    };
  }
  const authority =
    CHANGE_TRAILER.exec(lines.at(-3) ?? '') &&
    TRANSITION_TRAILER.exec(lines.at(-2) ?? '')?.[1] ===
      'authority-maintenance' &&
    GRANT_TRAILER.exec(lines.at(-1) ?? '');
  const trailerStart = authority ? -3 : -2;
  const change = CHANGE_TRAILER.exec(lines.at(trailerStart) ?? '');
  const task = authority ? null : TASK_TRAILER.exec(lines.at(-1) ?? '');
  const transition = authority
    ? TRANSITION_TRAILER.exec(lines.at(-2) ?? '')
    : TRANSITION_TRAILER.exec(lines.at(-1) ?? '');
  const earlierReservedLine = lines
    .slice(0, trailerStart)
    .some((line) => RESERVED_TRAILER_LINE.test(line));

  if (
    normalized.endsWith('\n') ||
    lines.at(trailerStart - 1) !== '' ||
    !change ||
    earlierReservedLine ||
    (!authority && (task === null) === (transition === null))
  ) {
    throw new ManagedTrailerSyntaxError();
  }

  if (task) {
    return { kind: 'task', changeId: change[1], taskId: task[1] };
  }
  if (authority && transition?.[1] === 'authority-maintenance') {
    return {
      kind: 'authority',
      changeId: change[1],
      transition: 'authority-maintenance',
      grantId: authority[1],
    };
  }
  if (transition?.[1] === 'authority-candidate') {
    return {
      kind: 'authority-candidate',
      changeId: change[1],
      transition: 'authority-candidate',
    };
  }
  if (transition?.[1] === 'plan') {
    return { kind: 'plan', changeId: change[1], transition: 'plan' };
  }
  if (transition?.[1] === 'archive') {
    return { kind: 'archive', changeId: change[1], transition: 'archive' };
  }
  throw new ManagedTrailerSyntaxError();
}
