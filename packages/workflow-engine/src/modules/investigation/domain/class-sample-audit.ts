/**
 * Draws deterministic class samples and resolves first- and second-sample review failures.
 *
 * Invariants:
 * - A sealed seed and member set produce the same samples regardless of input order.
 * - Missing answers, unsolicited answers, and repeated failures retain their exact outcomes.
 * - Failed classes require individual dispositions before a plan can commit.
 *
 * Depends on: class membership, recorded sample outcomes, and workflow errors.
 * Failure modes: incomplete review is accepted or valid class compression is rejected.
 */
import crypto from 'node:crypto';

import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';

const SEED_PATTERN = /^[0-9a-f]{64}$/;

export type SampleAuditOutcome =
  'passed' | 'member-misclassified' | 'rationale-wrong' | 'type-wrong';

export type ClassSamplePlan = Readonly<{
  classId: string;
  memberCount: number;
  sampled: readonly string[];
}>;

export type SampleAudit = Readonly<{
  classId: string;
  groupId: string;
  outcome: SampleAuditOutcome;
}>;

export type ClassAuditResult = Readonly<{
  classId: string;
  admitted: boolean;
  failures: readonly SampleAuditOutcome[];
  /** Extra members to review before this class may be trusted again. */
  additionalSampleRequired: number;
}>;

export type SampleAuditResolution = Readonly<{
  classes: readonly ClassAuditResult[];
  /** Classes that must be written out group by group instead. */
  expandIndividually: readonly string[];
}>;

/** At least three members, or a tenth of the class, whichever is larger. */
export function classSampleSize(memberCount: number): number {
  return Math.min(memberCount, Math.max(3, Math.ceil(memberCount / 10)));
}

export function planClassSampleAudits(
  sealedSeed: string,
  classes: readonly { classId: string; members: readonly string[] }[],
): readonly ClassSamplePlan[] {
  if (!SEED_PATTERN.test(sealedSeed)) {
    throw auditInvalid(
      'The sampling seed must be a sealed 32-byte hex value drawn before the classes.',
    );
  }
  return Object.freeze(
    classes.map(({ classId, members }) => {
      if (members.length === 0) {
        throw auditInvalid(`Class ${classId} has no members to sample.`);
      }
      // Ranking by digest rather than position means reordering the member
      // list cannot change which members are examined.
      const ranked = [...members].sort((left, right) => {
        const order = rank(sealedSeed, classId, left).localeCompare(
          rank(sealedSeed, classId, right),
        );
        return order !== 0 ? order : left.localeCompare(right);
      });
      return Object.freeze({
        classId,
        memberCount: members.length,
        sampled: Object.freeze(
          ranked.slice(0, classSampleSize(members.length)).sort(),
        ),
      });
    }),
  );
}

/**
 * Judges the audits and applies the escalation an author cannot opt out of.
 *
 * A failed class is not merely dropped. A wrong rationale is evidence about
 * how the classes were drawn, not only about the one that was caught, so the
 * remaining classes owe a second sample of the same depth. A second failure
 * ends class compression for the whole change: at that point the cheapest
 * honest answer is that the equivalence judgements are not reliable here.
 */
export function resolveSampleAudits(
  plan: readonly ClassSamplePlan[],
  audits: readonly SampleAudit[],
): SampleAuditResolution {
  const byClass = new Map(plan.map((entry) => [entry.classId, entry]));
  const answered = new Map<string, Map<string, SampleAuditOutcome>>();
  for (const audit of audits) {
    const planned = byClass.get(audit.classId);
    if (planned === undefined) {
      throw auditInvalid(`Audit names unknown class ${audit.classId}.`);
    }
    if (!planned.sampled.includes(audit.groupId)) {
      throw auditInvalid(
        `Group ${audit.groupId} was not sampled for ${audit.classId}; answering it proves nothing about the sample.`,
      );
    }
    const forClass = answered.get(audit.classId) ?? new Map();
    if (forClass.has(audit.groupId)) {
      throw auditInvalid(
        `Group ${audit.groupId} has more than one audit outcome for ${audit.classId}.`,
      );
    }
    forClass.set(audit.groupId, audit.outcome);
    answered.set(audit.classId, forClass);
  }

  const missing = plan.flatMap(({ classId, sampled }) =>
    sampled.filter((groupId) => !answered.get(classId)?.has(groupId)),
  );
  if (missing.length > 0) {
    throw workflowError(
      'CLASS_SAMPLE_AUDIT_INCOMPLETE',
      `${missing.length} sampled member(s) have not been reviewed; a plan may not commit on an unfinished sample.`,
      ExitCode.verification,
      { details: { missing } },
    );
  }

  const failuresByClass = new Map(
    plan.map(({ classId }) => [
      classId,
      [...(answered.get(classId)?.values() ?? [])].filter(
        (outcome) => outcome !== 'passed',
      ),
    ]),
  );
  const failedClasses = plan
    .map(({ classId }) => classId)
    .filter((classId) => (failuresByClass.get(classId)?.length ?? 0) > 0);

  const abandonAll = failedClasses.length >= 2;
  return Object.freeze({
    classes: Object.freeze(
      plan.map(({ classId, memberCount }) => {
        const failures = failuresByClass.get(classId) ?? [];
        const failedItself = failures.length > 0;
        const additionalSampleRequired =
          abandonAll || failedItself || failedClasses.length === 0
            ? 0
            : classSampleSize(memberCount);
        return Object.freeze({
          classId,
          admitted: !abandonAll && !failedItself && failedClasses.length === 0,
          failures: Object.freeze(failures),
          additionalSampleRequired,
        });
      }),
    ),
    expandIndividually: Object.freeze(
      abandonAll
        ? plan.map(({ classId }) => classId).sort()
        : failedClasses.sort(),
    ),
  });
}

function rank(seed: string, classId: string, groupId: string): string {
  return crypto
    .createHash('sha256')
    .update(`${seed}\0${classId}\0${groupId}`)
    .digest('hex');
}

function auditInvalid(message: string) {
  return workflowError('CLASS_SAMPLE_AUDIT_INVALID', message, ExitCode.usage);
}

/**
 * The seed the class sample is drawn from.
 *
 * It has to be fixed before the classes exist and not be chosen by the author,
 * or an author could see which members would be examined while deciding how
 * carefully to draw them. The investigation identity satisfies both: the engine
 * mints it at the start, nobody selects it, and deriving from it keeps the
 * draw replayable from durable state alone rather than from a stored secret.
 */
export function classSampleSeed(investigationId: string): string {
  return crypto.createHash('sha256').update(investigationId).digest('hex');
}

function planAdditionalClassSampleAudits(
  sealedSeed: string,
  classes: readonly { classId: string; members: readonly string[] }[],
) {
  // Reuse the contract's validation before deriving the next slice locally.
  planClassSampleAudits(sealedSeed, classes);
  return classes.map(({ classId, members }) => {
    const sampleSize = classSampleSize(members.length);
    const ranked = [...members].sort((left, right) => {
      const rank = (groupId: string) =>
        crypto
          .createHash('sha256')
          .update(`${sealedSeed}\0${classId}\0${groupId}`)
          .digest('hex');
      const order = rank(left).localeCompare(rank(right));
      return order !== 0 ? order : left.localeCompare(right);
    });
    return {
      classId,
      memberCount: members.length,
      sampled: ranked
        .slice(sampleSize, Math.min(members.length, sampleSize * 2))
        .sort(),
    };
  });
}

function sampleAuditKey(classId: string, groupId: string): string {
  return `${classId}\0${groupId}`;
}

function rejectedClassSamples(classIds: readonly string[], reason: string) {
  return workflowError(
    'CLASS_SAMPLE_AUDIT_REJECTED',
    `${reason}: ${classIds.join(', ')}.`,
    ExitCode.verification,
    { details: { classIds: [...classIds] } },
  );
}

export function assertClassSampleAuditsComplete(
  sealedSeed: string,
  classes: readonly { classId: string; members: readonly string[] }[],
  audits: readonly SampleAudit[],
): void {
  const plan = planClassSampleAudits(
    sealedSeed,
    classes.map(({ classId, members }) => ({ classId, members })),
  );
  const initiallySampled = new Set(
    plan.flatMap(({ classId, sampled }) =>
      sampled.map((groupId) => sampleAuditKey(classId, groupId)),
    ),
  );
  const initialResolution = resolveSampleAudits(
    plan,
    audits.filter(({ classId, groupId }) =>
      initiallySampled.has(sampleAuditKey(classId, groupId)),
    ),
  );
  if (initialResolution.expandIndividually.length === 0) {
    // Re-run against the complete submission so an unsolicited answer outside
    // the sealed first sample still fails closed rather than being ignored.
    resolveSampleAudits(plan, audits);
    return;
  }

  const initialFailureCount = initialResolution.classes.reduce(
    (count, result) => count + result.failures.length,
    0,
  );
  if (initialFailureCount >= 2) {
    resolveSampleAudits(plan, audits);
    throw rejectedClassSamples(
      plan.map(({ classId }) => classId).sort(),
      'A second failure in the initial sample ended class compression for this change',
    );
  }

  const survivingClasses = classes.filter(
    ({ classId }) => !initialResolution.expandIndividually.includes(classId),
  );
  const additionalPlan = planAdditionalClassSampleAudits(
    sealedSeed,
    survivingClasses.map(({ classId, members }) => ({ classId, members })),
  );
  const additionalByClass = new Map(
    additionalPlan.map(({ classId, sampled }) => [classId, sampled]),
  );
  const doubledPlan = plan.map(({ classId, memberCount, sampled }) => ({
    classId,
    memberCount,
    sampled: [...sampled, ...(additionalByClass.get(classId) ?? [])].sort(),
  }));
  const resolution = resolveSampleAudits(doubledPlan, audits);
  const additionalSampleKeys = new Set(
    additionalPlan.flatMap(({ classId, sampled }) =>
      sampled.map((groupId) => sampleAuditKey(classId, groupId)),
    ),
  );
  const secondSampleFailed = audits.some(
    ({ classId, groupId, outcome }) =>
      additionalSampleKeys.has(sampleAuditKey(classId, groupId)) &&
      outcome !== 'passed',
  );
  if (secondSampleFailed) {
    throw rejectedClassSamples(
      plan.map(({ classId }) => classId).sort(),
      'A failure in the deterministic second sample ended class compression for this change',
    );
  }
  if (resolution.expandIndividually.length > 0) {
    throw rejectedClassSamples(
      resolution.expandIndividually,
      `The hand review rejected ${resolution.expandIndividually.length} class(es); those groups owe individual dispositions`,
    );
  }
}
