import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import type { InvestigationManifestV3 } from '../src/modules/investigation/manifest/investigation-manifest-types.ts';
import { readInvestigationSession } from '../src/runtime/storage-journal/investigation-session-records.ts';
import { loadInvestigationRuntimeContext } from '../src/composition-root/lifecycle-context.ts';
import {
  createScanSaturationAcceptanceEnvelope,
  getProposeStatus,
  resumePropose,
} from '../src/composition-root/propose-production.ts';
import { isWorkflowError } from './fixture.ts';
import { driveProposeToDispositions } from './propose-drive-fixture.ts';

const SATURATED_TERM = 'SaturatedNeedle';

test('propose requires and durably records an exact scan saturation acceptance', () => {
  const fixture = driveProposeToDispositions('scan-saturation-acceptance', {
    files: {
      'src/dense.txt': `${`${SATURATED_TERM} `.repeat(513)}\n`,
    },
    explicitPaths: ['src/dense.txt'],
    explicitSymbols: [],
    mainTerm: SATURATED_TERM,
    surveyTerm: 'BlindSurveyNeedle',
    prepareRepository(repository) {
      fs.writeFileSync(
        path.join(repository, 'workflow/path-roles.json'),
        `${canonicalJson({
          schemaVersion: 1,
          kind: 'path-role-registry',
          roles: { ordinary: ['src/**'] },
        })}\n`,
        'utf8',
      );
    },
  });
  try {
    assert.equal(fixture.output.state, 'scan-saturation-acceptance-required');
    assert.equal(fixture.output.nextAction, 'accept-scan-saturation');
    assert.equal(fixture.output.work, null);

    const contribution = {
      rationale:
        'Read the whole dense fixture; its repeated hits exceed the ceiling. Keep the incomplete scan explicit.',
      semanticAuthor: 'codex',
    };
    const envelope = createScanSaturationAcceptanceEnvelope(
      fixture.output,
      contribution,
    );
    assert.equal(envelope.saturatedTermIds.length, 1);

    assert.throws(
      () =>
        resumePropose(fixture.repository, fixture.changeId, {
          ...envelope,
          saturatedTermIds: ['0'.repeat(64)],
        }),
      (error) =>
        isWorkflowError(
          error,
          'INVESTIGATION_SCAN_SATURATION_ACCEPTANCE_MISMATCH',
        ),
    );

    const accepted = resumePropose(
      fixture.repository,
      fixture.changeId,
      envelope,
    );
    assert.equal(accepted.state, 'awaiting-group-dispositions');
    assert.equal(accepted.nextAction, 'submit-group-dispositions');
    assert.equal(
      accepted.work?.groups.some(
        ({ termId }) => termId === envelope.saturatedTermIds[0],
      ),
      true,
    );
    const saturatedGroup = accepted.work?.groups.find(
      ({ termId }) => termId === envelope.saturatedTermIds[0],
    );
    assert.ok(saturatedGroup);
    assert.throws(
      () =>
        fixture.submit({
          dispositions: [],
          classes: [
            {
              schemaVersion: 1,
              kind: 'class-disposition',
              classId: 'saturated-search-results',
              predicate: { contains: SATURATED_TERM },
              classification: 'load-bearing',
              rationale:
                'All visible hits have the same spelling, but the scan is incomplete.',
              author: 'codex',
              members: [saturatedGroup.groupId],
            },
          ],
        }),
      (error) =>
        isWorkflowError(error, 'CLASS_DISPOSITION_INVALID') &&
        error instanceof Error &&
        error.message.includes('saturated term'),
    );

    const context = loadInvestigationRuntimeContext(fixture.repository);
    const session = readInvestigationSession(
      context.runtime,
      fixture.investigationId,
    );
    assert.deepEqual(
      session.scanSaturationAcceptance?.envelope.saturatedTermIds,
      envelope.saturatedTermIds,
    );
    assert.equal(session.semanticRevision, 3);

    const replayed = resumePropose(
      fixture.repository,
      fixture.changeId,
      envelope,
    );
    assert.equal(
      replayed.investigation?.revision,
      accepted.investigation?.revision,
    );
    assert.deepEqual(
      getProposeStatus(fixture.repository, fixture.investigationId).work,
      accepted.work,
    );

    const dispositions = fixture.submit({
      dispositions: accepted.work!.groups.map(({ groupId }) => ({
        groupId,
        classification: 'load-bearing',
        rationale:
          'Read this deterministic fixture source as part of the saturated scan.',
        author: 'codex',
      })),
    });
    const sealed = fixture.submit({
      answers: dispositions.work!.fullBlobManifest.map(
        ({ manifestEntryId }) => ({
          manifestEntryId,
          why: 'This fixture source is in the pinned saturated investigation.',
          protectedInvariant:
            'The incomplete scan remains explicitly acknowledged.',
          reviewerQuestion:
            'Does the Manifest preserve the exact acceptance and its author?',
          answer:
            'The dense fixture repeats one symbol 513 times; the hit ceiling does not establish complete coverage.',
          semanticAuthor: 'codex',
          readComplete: true,
        }),
      ),
    });
    assert.equal(sealed.state, 'awaiting-planning-contribution');
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(
          fixture.repository,
          'openspec/changes',
          fixture.changeId,
          'investigation.json',
        ),
        'utf8',
      ),
    ) as InvestigationManifestV3;
    assert.equal(manifest.applicability.kind, 'ordinary');
    if (manifest.applicability.kind !== 'ordinary')
      assert.fail('ordinary Manifest required');
    assert.deepEqual(
      manifest.applicability.semanticDelta.scanSaturationDecision,
      {
        saturatedTermIds: envelope.saturatedTermIds,
        acknowledgeIncompleteScan: true,
        rationale: contribution.rationale,
        semanticAuthor: {
          id: contribution.semanticAuthor,
          provenance: `scan-saturation-acceptance:${session.scanSaturationAcceptance!.envelopeDigest}`,
        },
        provenanceDigest: session.scanSaturationAcceptance!.envelopeDigest,
      },
    );
    assert.equal(
      getProposeStatus(fixture.repository, fixture.investigationId).state,
      'awaiting-planning-contribution',
    );
    assert.equal(
      resumePropose(fixture.repository, fixture.changeId, envelope).state,
      'awaiting-planning-contribution',
    );
  } finally {
    fixture.dispose();
  }
});
