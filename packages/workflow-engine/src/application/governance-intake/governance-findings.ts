/** Finding capture and terminal dispositions over required Source and append-only ref capabilities. */
import { canonicalJson } from '@jigwright/core/canonical-json';
import {
  findingRecordLocation,
  findingRecordPath,
  type GovernanceFindingRefPort,
} from '../../modules/governance-intake/governance-finding-ref.ts';
import {
  intakeInvalid,
  GOVERNANCE_FINDING_DISPOSITION_KIND,
} from '../../modules/governance-intake/governance-intake.ts';
import {
  normalizeFindingInput,
  createGovernanceFinding,
  projectGovernanceFindings,
  findingReference,
  normalizeFindingDispositionInput,
  findingDispositionCollision,
  canonicalTimestamp,
} from '../../modules/governance-intake/governance-findings.ts';
import type { GovernanceSourceV1 } from '@jigwright/core/governance-source';
import type {
  GovernanceFindingContextV1,
  GovernanceFindingAuthoringV1,
  GovernanceFindingV1,
  GovernanceFindingReadModelV1,
  GovernanceFindingDispositionAuthoringV1,
  GovernanceFindingDispositionReceiptV1,
  GovernanceFindingDispositionV1,
  GovernanceFindingDispositionTargetV1,
} from '../../modules/governance-intake/governance-intake.ts';

export type GovernanceFindingServices = Readonly<{
  findingRef: GovernanceFindingRefPort;
  readGovernanceSource(
    repositoryRoot: string,
    sourceId: string,
  ): GovernanceSourceV1;
}>;
export function createGovernanceFindingServices(
  services: GovernanceFindingServices,
) {
  const { readGovernanceSource, findingRef } = services;
  const { readFindingRef, publishFindingRefRecord } = findingRef;

  function recordGovernanceFinding(
    context: GovernanceFindingContextV1,
    input: GovernanceFindingAuthoringV1,
    now: () => string = () => new Date().toISOString(),
  ): { finding: GovernanceFindingV1; path: string; created: boolean } {
    const normalized = normalizeFindingInput(input);
    for (const sourceRef of normalized.sourceRefs) {
      readGovernanceSource(context.repositoryRoot, sourceRef);
    }
    const finding = createGovernanceFinding(context, normalized, now());
    const recordPath = findingRecordPath(finding.sessionId, finding.id);
    listGovernanceFindings(context.runtimeRoot);
    const created = publishFindingRefRecord(
      context.runtimeRoot,
      recordPath,
      Buffer.from(`${canonicalJson(finding)}\n`),
    );
    return { finding, path: findingRecordLocation(recordPath), created };
  }

  function listGovernanceFindings(
    runtimeRoot: string,
  ): GovernanceFindingReadModelV1[] {
    return projectGovernanceFindings(readFindingRef(runtimeRoot).records);
  }

  function dismissGovernanceFinding(
    runtimeRoot: string,
    requestedFindingId: string,
    reason: string,
    now: () => string = () => new Date().toISOString(),
  ): {
    finding: GovernanceFindingReadModelV1;
    path: string;
    created: boolean;
  } {
    return recordGovernanceFindingDisposition(
      runtimeRoot,
      requestedFindingId,
      {
        schemaVersion: 1,
        disposition: 'dismissed',
        reason,
        target: null,
      },
      now,
    );
  }

  function convertGovernanceFinding(
    runtimeRoot: string,
    requestedFindingId: string,
    requestedWorkItemId: string,
    now: () => string = () => new Date().toISOString(),
  ): {
    finding: GovernanceFindingReadModelV1;
    path: string;
    created: boolean;
  } {
    return recordGovernanceFindingDisposition(
      runtimeRoot,
      requestedFindingId,
      {
        schemaVersion: 1,
        disposition: 'converted',
        reason: 'Converted to one deterministic inbox Work Item.',
        target: {
          kind: 'work-item',
          id: requestedWorkItemId as `WORK-${string}`,
        },
      },
      now,
    );
  }

  function linkGovernanceFinding(
    runtimeRoot: string,
    requestedFindingId: string,
    requestedTarget:
      string | Readonly<{ kind: 'work-item'; id: `WORK-${string}` }>,
    now: () => string = () => new Date().toISOString(),
  ): {
    finding: GovernanceFindingReadModelV1;
    path: string;
    created: boolean;
  } {
    return recordGovernanceFindingDisposition(
      runtimeRoot,
      requestedFindingId,
      {
        schemaVersion: 1,
        disposition: 'linked',
        reason:
          typeof requestedTarget === 'string'
            ? 'Linked to one existing change without widening its task scope.'
            : 'Linked to one existing Work Item without creating another inbox item.',
        target:
          typeof requestedTarget === 'string'
            ? { kind: 'change', id: requestedTarget }
            : requestedTarget,
      },
      now,
    );
  }

  function recordGovernanceFindingDisposition(
    runtimeRoot: string,
    requestedFindingId: string,
    input: GovernanceFindingDispositionAuthoringV1,
    now: () => string = () => new Date().toISOString(),
  ): {
    finding: GovernanceFindingReadModelV1;
    path: string;
    created: boolean;
  } {
    const findingId = findingReference(requestedFindingId);
    const normalized = normalizeFindingDispositionInput(input);
    const current = listGovernanceFindings(runtimeRoot).find(
      (finding) => finding.id === findingId,
    );
    if (current === undefined) {
      throw intakeInvalid('Governance Finding does not exist.');
    }
    const recordPath = findingRecordPath(current.sessionId, findingId, true);
    const dispositionPath = findingRecordLocation(recordPath);
    if (current.disposition !== 'pending') {
      if (
        current.disposition === normalized.disposition &&
        current.reason === normalized.reason &&
        canonicalJson(current.target) === canonicalJson(normalized.target)
      ) {
        return { finding: current, path: dispositionPath, created: false };
      }
      throw findingDispositionCollision();
    }
    const receipt: GovernanceFindingDispositionReceiptV1 = {
      schemaVersion: 1,
      kind: GOVERNANCE_FINDING_DISPOSITION_KIND,
      findingId,
      disposition: normalized.disposition,
      reason: normalized.reason,
      target: normalized.target,
      recordedAt: canonicalTimestamp(now()),
    };
    if (Date.parse(receipt.recordedAt) < Date.parse(current.createdAt)) {
      throw intakeInvalid(
        'Governance Finding disposition predates its immutable Finding.',
      );
    }
    let created: boolean;
    try {
      created = publishFindingRefRecord(
        runtimeRoot,
        recordPath,
        Buffer.from(`${canonicalJson(receipt)}\n`),
      );
    } catch (error) {
      // A concurrent identical decision can carry a different capture time.
      const observed = listGovernanceFindings(runtimeRoot).find(
        ({ id }) => id === findingId,
      );
      if (
        observed?.disposition !== normalized.disposition ||
        observed.reason !== normalized.reason ||
        canonicalJson(observed.target) !== canonicalJson(normalized.target)
      )
        throw error;
      return { finding: observed, path: dispositionPath, created: false };
    }
    const finding = listGovernanceFindings(runtimeRoot).find(
      (candidate) => candidate.id === findingId,
    );
    if (finding === undefined || finding.disposition === 'pending') {
      throw intakeInvalid('Governance Finding disposition was not published.');
    }
    return { finding, path: dispositionPath, created };
  }
  return {
    recordGovernanceFinding,
    listGovernanceFindings,
    dismissGovernanceFinding,
    convertGovernanceFinding,
    linkGovernanceFinding,
    GOVERNANCE_FINDING_DISPOSITION_KIND,
  };
}
