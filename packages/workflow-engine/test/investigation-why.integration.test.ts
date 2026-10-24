import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import type { InvestigationWhyOverlayV3 } from '../src/modules/investigation/manifest/investigation-manifest-types.ts';
import {
  projectInvestigationManifestLedger,
  validateInvestigationManifestLedgerProjection,
} from '../src/modules/investigation/domain/investigation-design-ledger.ts';
import { isWorkflowError } from './fixture.ts';

const START = '<!-- workflow:investigation-ledger:start v1 -->';
const END = '<!-- workflow:investigation-ledger:end v1 -->';
const FENCE = '```';

test('WHY projection sorts raw path bytes, keeps input order and renders non-UTF8 and empty overlays', () => {
  const overlays = [
    whyOverlay({
      pathIdentity: {
        rawBase64: Buffer.from([255]).toString('base64'),
        utf8: null,
      },
    }),
    whyOverlay({
      pathIdentity: {
        rawBase64: Buffer.from('z').toString('base64'),
        utf8: 'z',
      },
    }),
    whyOverlay({
      pathIdentity: {
        rawBase64: Buffer.from('a').toString('base64'),
        utf8: 'a',
      },
    }),
  ];
  const before = structuredClone(overlays);
  const design = `😀prefix\r\n${START}\r\nold\r\n${END}\r\n尾`;
  const projected = projectInvestigationManifestLedger(design, overlays);
  assert.ok(projected.indexOf('### a') < projected.indexOf('### z'));
  assert.ok(projected.indexOf('### z') < projected.indexOf('### Source 3'));
  assert.match(projected, /path is not representable as UTF-8/);
  assert.ok(projected.startsWith('😀prefix\r\n'));
  assert.ok(projected.endsWith('\r\n尾'));
  assert.deepEqual(overlays, before);
  assert.equal(
    projectInvestigationManifestLedger(design, []),
    `😀prefix\r\n${START}\n\n${END}\r\n尾`,
  );
});

test('WHY projection preserves render-first failures and untyped missing-design behavior', () => {
  const failure = new Error('overlay unavailable');
  const overlay = whyOverlay();
  Object.defineProperty(overlay, 'why', {
    get() {
      throw failure;
    },
  });
  for (const design of [null, undefined, 0, '# missing markers']) {
    assert.throws(
      () => projectInvestigationManifestLedger(design as never, [overlay]),
      (error) => error === failure,
    );
  }
  assert.equal(projectInvestigationManifestLedger(null as never, []), '');
  assert.throws(
    () => projectInvestigationManifestLedger(undefined as never, []),
    TypeError,
  );
  assert.throws(
    () => projectInvestigationManifestLedger(0 as never, []),
    (error) => isWorkflowError(error, 'INVESTIGATION_LEDGER_INVALID'),
  );
});

test('current WHY surface omits EvidenceNode v1 runtime and projector', async () => {
  const projection =
    await import('../src/modules/investigation/domain/investigation-design-ledger.ts');

  assert.equal(
    fs.existsSync(
      new URL(
        '../src/adapters/planning/investigation/investigation-why.ts',
        import.meta.url,
      ),
    ),
    false,
  );
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
  assert.match(projected, /### src\/load-bearing\.ts/);
  assert.match(projected, /src\/load-bearing\.ts/);
  assert.equal(projected.includes(overlays[0]!.overlayId), false);
  assert.match(projected, /Source locations: bytes/);
  assert.match(projected, /The v3 overlay explains the load-bearing source\./);
  assert.doesNotMatch(
    projected,
    /Overlay ID:|Blob OID:|Semantic author:|"why"/,
  );
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
  assert.equal(projected.includes(overlays[0]!.overlayId), false);
  assert.equal(projected.includes(overlays[0]!.contentSha256), false);
  assert.equal(
    projected.includes(overlays[0]!.groupRefs[0]!.leafDigest),
    false,
  );
  assert.match(
    projected,
    /Reviewed claim; full source reading is actor-attested\./,
  );
  assert.equal(projected.includes(injectedMarker), false);
  assert.match(
    projected,
    /&lt;!-- workflow:investigation-ledger:end v1 --&gt; is not authority/,
  );
  assert.equal(projected.includes(injectedMarkdown), false);
  assert.ok(projected.includes('\\[click\\]\\(javascript:alert\\(1\\)\\)'));
  assert.equal(overlays[0]!.why.includes(injectedMarkdown), true);
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
