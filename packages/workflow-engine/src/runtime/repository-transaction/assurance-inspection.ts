import fs from 'node:fs';
import path from 'node:path';

import {
  assessAssurance,
  type AssuranceAssessmentChain,
  type AssuranceFloors,
  type CoverageTier,
  type InvestigationChangeClass,
} from '../../modules/assurance/assurance-assessment-chain.ts';
import {
  loadWorkflowConfig,
  parseCurrentInvestigationManifest,
  type CurrentInvestigationManifest,
} from '../../adapters/consumer/repository/work-registry/contracts.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { discoverRepository } from './git.ts';
import { parsePathRoleRegistry } from '../../modules/source/path-role-registry.ts';
import {
  readLedgerIndex,
  readLedgerEntry,
} from '../storage-journal/semantic-ledger-store.ts';
import {
  planSemanticReuse,
  type ReusePlan,
} from '../../modules/why-knowledge/semantic-reuse.ts';
import type { FreshnessObservation } from '../../modules/why-knowledge/semantic-freshness.ts';
import type { LedgerEntry } from '../../modules/why-knowledge/semantic-ledger.ts';
import { materializeInvestigationEvidenceView } from '../../modules/investigation/manifest/investigation-materializer.ts';

export type AssuranceInspection = Readonly<{
  schemaVersion: 1;
  kind: 'assurance-inspection';
  changeId: string;
  declaredChangeClasses: readonly string[];
  hitPathCount: number;
  floors: AssuranceFloors;
  coverageTier: CoverageTier;
  escalated: boolean;
  reasons: readonly string[];
  chain: AssuranceAssessmentChain;
  /**
   * What the ledger already explains and what this change still owes. Present
   * only once a ledger exists; a repository without one owes everything, which
   * is the state every repository starts in.
   */
  semanticReuse: ReusePlan | null;
}>;

/**
 * Answers what a change owes from its exact current v3 Manifest authority.
 * Ordinary investigations replay their pinned scan; exemptions use only their
 * explicit declared paths and classes. Read-only: running it twice on an
 * unchanged Manifest and private current ref gives the same answer.
 */
export function inspectChangeAssurance(
  cwd: string,
  changeId: string,
  options: { now?: Date } = {},
): AssuranceInspection {
  const repository = discoverRepository(cwd);
  const config = loadWorkflowConfig(repository.repositoryRoot);
  const registry = parsePathRoleRegistry(
    readJson(
      path.join(repository.repositoryRoot, 'workflow/path-roles.json'),
      'Path role registry is unavailable.',
    ),
  );
  const investigationPath = path.join(
    repository.repositoryRoot,
    config.changeRoot,
    changeId,
    'investigation.json',
  );
  const investigation = parseCurrentInvestigationManifest(
    readJson(
      investigationPath,
      `Change ${changeId} has no investigation to assess.`,
    ),
    changeId,
    {
      repositoryRoot: repository.repositoryRoot,
      expectedRepositoryId: config.repositoryName,
      artifactPath: investigationPath,
    },
  );

  const subject = inspectionSubject(repository.repositoryRoot, investigation);
  const at = (options.now ?? new Date()).toISOString();
  const assessment = assessAssurance({
    changeId,
    declaredChangeClasses: subject.declaredChangeClasses,
    registry,
    hitPaths: subject.hitPaths,
    ...(subject.floorOverflow === null
      ? {}
      : { floorOverflow: subject.floorOverflow }),
    at,
  });

  return Object.freeze({
    semanticReuse: inspectSemanticReuse(
      repository.repositoryRoot,
      subject.hitPaths,
    ),
    schemaVersion: 1,
    kind: 'assurance-inspection',
    changeId,
    declaredChangeClasses: assessment.declaredChangeClasses,
    hitPathCount: assessment.hitPathCount,
    floors: assessment.floors,
    coverageTier: assessment.coverageTier,
    escalated: assessment.escalated,
    reasons: assessment.reasons,
    chain: assessment.chain,
  });
}

/**
 * Resolves each touched path against the ledger. A path with no recorded
 * understanding is not skipped — it is charged, which is why a fresh
 * repository sees a reuse rate of zero rather than a reassuring silence.
 */
function inspectSemanticReuse(
  repositoryRoot: string,
  hitPaths: readonly string[],
): ReusePlan | null {
  const index = readLedgerIndex(repositoryRoot);
  const subjectIds = Object.keys(index.subjects);
  if (subjectIds.length === 0) return null;

  const entries = new Map<string, LedgerEntry>();
  for (const subjectId of subjectIds) {
    try {
      entries.set(
        subjectId,
        readLedgerEntry(
          repositoryRoot,
          index.subjects[subjectId].currentEntryId,
        ),
      );
    } catch {
      // A named entry that cannot be read is a missing entry, not a fresh one.
    }
  }
  const touched = new Set(hitPaths);
  const observations = new Map<string, FreshnessObservation>();
  for (const [subjectId, entry] of entries) {
    // A subject the scan never reached is not evidence of anything changing,
    // so its recorded understanding stands.
    if (!touched.has(entry.subject.path)) {
      observations.set(subjectId, {
        present: true,
        sourceDigest: entry.binding.sourceDigest,
        semanticDigest: entry.binding.semanticDigest,
        currentDependencyEntryIds: Object.fromEntries(
          entry.semanticDependencies.map(({ subjectId: id, entryId }) => [
            id,
            entryId,
          ]),
        ),
        currentPolicyDigest: entry.policyDigest,
      });
    }
    // A touched subject is left unobserved on purpose: the engine cannot see
    // its current meaning from here, and unobserved resolves to regenerate.
  }
  return planSemanticReuse([...entries.keys()].sort(), entries, observations);
}

function inspectionSubject(
  repositoryRoot: string,
  current: CurrentInvestigationManifest,
): Readonly<{
  declaredChangeClasses: InvestigationChangeClass[];
  hitPaths: string[];
  floorOverflow: Readonly<{
    escalated: boolean;
    reasons: readonly string[];
  }> | null;
}> {
  const applicability = current.manifest.applicability;
  if (applicability.kind === 'exemption') {
    return {
      declaredChangeClasses: [...applicability.declaredChangeClasses],
      hitPaths: [...new Set(applicability.declaredPaths)].sort(),
      floorOverflow: null,
    };
  }

  const replay = applicability.replayContract;
  const semantic = applicability.semanticDelta;
  const view = materializeInvestigationEvidenceView({
    repositoryRoot,
    authoring: {
      baseline: replay.baseline,
      termContributions: replay.termContributions,
      canonicalTerms: replay.canonicalTerms,
      scanner: {
        limits: replay.scanner.limits,
        allowSaturatedTerms: replay.scanner.allowSaturatedTerms,
        saturationDecision: semantic.scanSaturationDecision,
      },
      grouping: {
        mutationPolicy: replay.grouping.mutationPolicy,
        declaredRoots: replay.grouping.declaredRoots,
        reviewedRelationships: replay.grouping.reviewedRelationships,
      },
      semanticGroupDecisions: semantic.semanticGroupDecisions,
      dispositionDecisions: semantic.dispositions.map((disposition) => ({
        groupKey: disposition.groupRef.key,
        classification: disposition.classification,
        rationale: disposition.rationale,
        semanticAuthor: disposition.semanticAuthor,
      })),
    },
  });
  const paths = new Set<string>();
  for (const term of view.scanFacts.terms) {
    for (const hit of term.hits) {
      if (hit.path.utf8 !== null && hit.path.utf8 !== '') {
        paths.add(hit.path.utf8);
      }
    }
  }
  const floorOverflow = semantic.floorOverflowDecision;
  return {
    // Ordinary intent currently has no non-reserved declared class field. Its
    // absence is assessed as behavioral by the shared assurance tax table.
    declaredChangeClasses: [],
    hitPaths: [...paths].sort(),
    floorOverflow:
      floorOverflow === null
        ? null
        : {
            escalated: floorOverflow.escalated,
            reasons: floorOverflow.reasons,
          },
  };
}

function readJson(filePath: string, absentMessage: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw workflowError(
      'ASSURANCE_INSPECTION_UNAVAILABLE',
      absentMessage,
      ExitCode.guard,
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw workflowError(
      'ASSURANCE_INSPECTION_UNAVAILABLE',
      `${filePath} is not readable JSON.`,
      ExitCode.guard,
    );
  }
}
