import assert from 'node:assert/strict';
import test from 'node:test';

import type { InvestigationWhyOverlayV3 } from '../src/modules/investigation/manifest/investigation-manifest.ts';
import {
  projectInvestigationManifestLedger,
  validateInvestigationManifestLedgerProjection,
} from '../src/modules/projection/investigation-design-projection.ts';
import { isWorkflowError } from './fixture.ts';

const START = '<!-- workflow:investigation-ledger:start v1 -->';
const END = '<!-- workflow:investigation-ledger:end v1 -->';
const FENCE = '```';

test('current WHY surface omits EvidenceNode v1 runtime and projector', async () => {
  const [whyRuntime, projection] = await Promise.all([
    import('../src/adapters/planning/investigation/investigation-why.ts'),
    import('../src/modules/projection/investigation-design-projection.ts'),
  ]);

  assert.deepEqual(Object.keys(whyRuntime), []);
  assert.equal('projectInvestigationLedger' in projection, false);
  assert.equal('validateInvestigationLedgerProjection' in projection, false);
  assert.equal(
    typeof projection.projectInvestigationManifestLedger,
    'function',
  );
  assert.equal(
    typeof projection.validateInvestigationManifestLedgerProjection,
    'function',
  );
});

test('Manifest v3 WHY overlays render and validate the exact managed design region', () => {
  const overlays = [whyOverlay()];
  const design = [
    '# Design',
    '',
    'Authored prefix.',
    '',
    START,
    'stale projection',
    END,
    '',
    'Authored suffix.',
    '',
  ].join('\n');

  const projected = projectInvestigationManifestLedger(design, overlays);
  assert.equal(
    projectInvestigationManifestLedger(projected, overlays),
    projected,
  );
  assert.match(projected, /Manifest v3 load-bearing source 1/);
  assert.match(projected, /src\/load-bearing\.ts/);
  assert.match(projected, new RegExp(overlays[0]!.overlayId));
  assert.match(projected, /Source anchors/);
  assert.match(projected, /Authored prefix\./);
  assert.match(projected, /Authored suffix\./);
  assert.deepEqual(
    validateInvestigationManifestLedgerProjection(projected, overlays),
    { valid: true, rowCount: 1 },
  );
  assert.throws(
    () =>
      validateInvestigationManifestLedgerProjection(
        projected.replace('Protected invariant', 'Edited invariant'),
        overlays,
      ),
    (error) => isWorkflowError(error, 'INVESTIGATION_LEDGER_INVALID'),
  );
});

test('Manifest v3 projection is fence-aware, injection-safe, and idempotent', () => {
  const injectedMarker = END + ' is not authority';
  const injectedMarkdown =
    '**bold** [click](javascript:alert(1)) ``embedded ticks``';
  const overlays = [
    whyOverlay({
      why: [
        'The v3 overlay explains the load-bearing source.',
        injectedMarker,
        injectedMarkdown,
      ].join('\n'),
    }),
  ];
  const design = [
    '# Design',
    '',
    'Authored prefix.',
    '',
    FENCE + 'md',
    START,
    'A fenced example is not a managed marker.',
    END,
    FENCE,
    '',
    START,
    'stale projection',
    END,
    '',
    'Authored suffix.',
    '',
  ].join('\n');

  const projected = projectInvestigationManifestLedger(design, overlays);
  assert.equal(
    projectInvestigationManifestLedger(projected, overlays),
    projected,
  );
  assert.match(projected, /Authored prefix\./);
  assert.match(projected, /Authored suffix\./);
  assert.match(projected, /src\/load-bearing\.ts/);
  assert.match(projected, new RegExp(overlays[0]!.overlayId));
  assert.match(projected, new RegExp(overlays[0]!.contentSha256));
  assert.match(projected, new RegExp(overlays[0]!.groupRefs[0]!.leafDigest));
  assert.match(projected, /actor-attested-not-engine-verified/);
  assert.match(projected, /Read complete: `true`/);
  assert.match(projected, /actor-attested, not engine-verified/);
  assert.equal(projected.includes(injectedMarker), false);
  assert.match(
    projected,
    /&lt;!-- workflow:investigation-ledger:end v1 --&gt; is not authority/,
  );
  const whyLine = projected
    .split('\n')
    .find((line) => line.startsWith('- Why: '));
  assert.ok(whyLine);
  const codeSpan = /^- Why: (`+)(.*)\1$/.exec(whyLine);
  assert.ok(codeSpan);
  assert.equal(codeSpan[2]!.includes(codeSpan[1]!), false);
  assert.deepEqual(
    validateInvestigationManifestLedgerProjection(projected, overlays),
    { valid: true, rowCount: 1 },
  );
});

test('Manifest v3 projection accepts CRLF markers while preserving authored bytes', () => {
  const overlays = [whyOverlay()];
  const prefix = [
    '# Design',
    '',
    FENCE + 'md',
    START,
    END,
    FENCE,
    '',
    'Authored prefix.',
    '',
  ].join('\r\n');
  const suffix = '\r\nAuthored suffix.\r\n';
  const projected = projectInvestigationManifestLedger(
    prefix + START + '\r\nstale\r\n' + END + suffix,
    overlays,
  );

  assert.equal(projected.startsWith(prefix), true);
  assert.equal(projected.endsWith(suffix), true);
  assert.deepEqual(
    validateInvestigationManifestLedgerProjection(projected, overlays),
    { valid: true, rowCount: 1 },
  );

  const withoutFinalNewline = projectInvestigationManifestLedger(
    START + '\nstale\n' + END,
    overlays,
  );
  assert.equal(withoutFinalNewline.endsWith(END), true);
});

test('Manifest v3 projection rejects malformed managed ledger markers', () => {
  const overlays = [whyOverlay()];

  for (const design of [
    '# Design\n',
    '# Design\n\n' + START + '\n' + END + '\n' + START + '\n' + END + '\n',
    '# Design\n\n' + START + '\n' + START + '\n' + END + '\n' + END + '\n',
    '# Design\n\n' + END + '\n' + START + '\n',
    '# Design\n\n<!-- workflow:investigation-ledger:start v2 -->\n',
    '# Design\n\nprefix ' + START + '\n' + END + '\n',
    '# Design\n\n' +
      START +
      '\n' +
      END +
      '\n<!-- workflow:investigation-ledger:start v2 -->\n',
    [
      '# Design',
      '',
      FENCE + 'bad`info',
      '<!-- workflow:investigation-ledger:start v2 -->',
      FENCE,
      START,
      END,
      '',
    ].join('\n'),
  ]) {
    assert.throws(
      () => projectInvestigationManifestLedger(design, overlays),
      (error) => isWorkflowError(error, 'INVESTIGATION_LEDGER_INVALID'),
    );
  }
});

function whyOverlay(
  overrides: Partial<InvestigationWhyOverlayV3> = {},
): InvestigationWhyOverlayV3 {
  const pathIdentity = {
    rawBase64: Buffer.from('src/load-bearing.ts').toString('base64'),
    utf8: 'src/load-bearing.ts',
  };
  return {
    overlayId: 'a'.repeat(64),
    pathIdentity,
    blobOid: 'b'.repeat(40),
    contentSha256: 'c'.repeat(64),
    groupRefs: [{ index: 0, key: 'load-bearing', leafDigest: 'd'.repeat(64) }],
    anchors: [
      {
        pathIdentity,
        blobOid: 'b'.repeat(40),
        byteRange: { start: 4, end: 12 },
        termId: 'e'.repeat(64),
      },
    ],
    why: 'The v3 overlay explains the load-bearing source.',
    protectedInvariant: 'Preserve the exact Manifest-first behavior.',
    reviewerQuestion: 'Does the plan preserve this source contract?',
    answer: 'Yes; the exact overlay is bound into the planning target.',
    semanticAuthor: { id: 'owner', provenance: 'checkpoint:v3-why' },
    readComplete: true,
    semanticAssurance: 'actor-attested-not-engine-verified',
    ...overrides,
  };
}
