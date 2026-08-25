import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  parseCurrentInvestigationManifest,
  parseHistoricalInvestigationArtifact,
} from '../src/adapters/consumer/expense-app/work-registry/contracts.ts';
import { createEvidenceNode } from '../src/adapters/compatibility/investigation-v2/evidence-node.ts';
import type { InvestigationManifestV3 } from '../src/modules/investigation/manifest/investigation-manifest.ts';
import { isWorkflowError } from './fixture.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const CHANGE_ID = 'reuse-evidence-generation-v3';
const TARGET = 'src/reuse-evidence.ts';

test('v3 semantic reuse is current Manifest authority while v1 lineage remains historical-only', () => {
  const fixture = driveProposeToDispositions(CHANGE_ID, {
    files: {
      [TARGET]: 'export const ReuseEvidenceNeedle = true;\n',
    },
    explicitPaths: [TARGET],
    explicitSymbols: ['ReuseEvidenceNeedle'],
  });
  try {
    const afterDispositions = fixture.submit({
      dispositions: (fixture.output.work?.groups ?? []).map(({ groupId }) => ({
        groupId,
        classification: 'load-bearing' as const,
        rationale: 'The source owns the semantic reuse authority boundary.',
        author: 'codex',
      })),
    });
    const sealed = fixture.submit({
      answers: (afterDispositions.work?.fullBlobManifest ?? []).map(
        ({ manifestEntryId }) => ({
          manifestEntryId,
          why: 'The source defines the current semantic reuse contract.',
          protectedInvariant:
            'Semantic reuse remains bound to current v3 source identity.',
          reviewerQuestion:
            'Can historical EvidenceNode lineage satisfy current authority?',
          answer:
            'No. Current authority is reconstructed from the v3 Manifest.',
          semanticAuthor: 'codex',
          readComplete: true as const,
        }),
      ),
    });
    assert.equal(sealed.state, 'awaiting-planning-contribution');
    assert.ok(sealed.semanticReuse);

    const artifactPath = path.join(
      fixture.repository,
      'openspec/changes',
      CHANGE_ID,
      'investigation.json',
    );
    const manifest = JSON.parse(
      fs.readFileSync(artifactPath, 'utf8'),
    ) as InvestigationManifestV3;
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.kind, 'manifest-first-investigation');
    if (manifest.applicability.kind !== 'ordinary') {
      assert.fail(
        'The semantic reuse fixture must use ordinary applicability.',
      );
    }
    const coverageRequirement =
      manifest.applicability.semanticDelta.investigationRequirements.find(
        (requirement) =>
          requirement.kind === 'plan-review-coverage-requirement',
      );
    assert.ok(coverageRequirement);
    assert.deepEqual(
      coverageRequirement.coverage.semanticReuse,
      sealed.semanticReuse,
    );

    const current = parseCurrentInvestigationManifest(manifest, CHANGE_ID, {
      repositoryRoot: fixture.repository,
      expectedRepositoryId: manifest.repositoryId,
      artifactPath,
    });
    assert.equal(current.manifest.manifestDigest, manifest.manifestDigest);
    assert.deepEqual(
      current.manifest.applicability.kind === 'ordinary'
        ? current.manifest.applicability.semanticDelta.investigationRequirements.find(
            (requirement) =>
              requirement.kind === 'plan-review-coverage-requirement',
          )?.coverage.semanticReuse
        : null,
      sealed.semanticReuse,
    );

    const legacyNode = createEvidenceNode({
      type: 'fixture-investigation',
      nodeSchema: 'fixture.investigation.v1',
      evaluator: 'fixture.investigation.v1',
      policyDigest: '1'.repeat(64),
      exactInputDigests: { intent: '2'.repeat(64) },
      semanticParentResultDigests: {},
      provenanceParentNodeIds: {},
      outputSchema: 'fixture.investigation-output.v1',
      output: { sealed: true },
      runtimeMetadata: {},
    });
    const historical = {
      schemaVersion: 1 as const,
      kind: 'investigation-artifact' as const,
      changeId: CHANGE_ID,
      legacyMigration: false,
      nodes: [legacyNode],
      currentRefs: { sealedInvestigation: legacyNode.nodeId },
    };
    assert.equal(
      parseHistoricalInvestigationArtifact(historical, CHANGE_ID).currentRefs
        .sealedInvestigation,
      legacyNode.nodeId,
    );
    assert.throws(
      () =>
        parseCurrentInvestigationManifest(historical, CHANGE_ID, {
          repositoryRoot: fixture.repository,
          expectedRepositoryId: manifest.repositoryId,
          artifactPath,
        }),
      (error) => isWorkflowError(error, 'SCHEMA_V1_FORBIDDEN'),
    );
  } finally {
    fixture.dispose();
  }
});
