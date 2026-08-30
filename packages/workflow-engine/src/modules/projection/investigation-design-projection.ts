import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { InvestigationWhyOverlayV3 } from '../investigation/manifest/investigation-manifest.ts';
import { markdownLines } from '@jigwright/core/markdown-sections';

const START = '<!-- workflow:investigation-ledger:start v1 -->';
const END = '<!-- workflow:investigation-ledger:end v1 -->';
const MARKER_NAMESPACE = '<!-- workflow:investigation-ledger:';

/**
 * Replace the managed ledger with the compact Manifest-v3 WHY representation.
 * This is a direct Manifest projection: it consumes no historical EvidenceNode
 * envelope and preserves every authored byte outside the existing ledger
 * markers.
 */
export function projectInvestigationManifestLedger(
  design: string,
  whyOverlays: readonly InvestigationWhyOverlayV3[],
): string {
  const region = locateLedgerRegion(design);
  const prefix = design.slice(0, region.start);
  const suffix = design.slice(region.end);
  return `${prefix}${renderManifestLedgerRegion(whyOverlays)}${suffix}`;
}

/** Confirm the tracked managed region is the exact v3 overlay projection. */
export function validateInvestigationManifestLedgerProjection(
  projected: string,
  whyOverlays: readonly InvestigationWhyOverlayV3[],
): { valid: true; rowCount: number } {
  const reprojected = projectInvestigationManifestLedger(
    projected,
    whyOverlays,
  );
  if (reprojected !== projected) {
    throw ledgerInvalid('Projection does not match the Manifest v3 ledger.');
  }
  return { valid: true, rowCount: whyOverlays.length };
}

type LedgerRegion = { start: number; end: number };

function locateLedgerRegion(design: string): LedgerRegion {
  const lines = markdownLines(design);
  let startLine: number | null = null;
  let endLine: number | null = null;

  lines.forEach((line, index) => {
    if (line.fenced) {
      return;
    }
    if (line.text === START) {
      if (startLine !== null) {
        throw ledgerInvalid('Duplicate investigation-ledger start marker.');
      }
      startLine = index;
      return;
    }
    if (line.text === END) {
      if (endLine !== null) {
        throw ledgerInvalid('Duplicate investigation-ledger end marker.');
      }
      endLine = index;
      return;
    }
    if (line.text.includes(MARKER_NAMESPACE)) {
      throw ledgerInvalid('Malformed investigation-ledger marker text.');
    }
  });

  if (startLine === null || endLine === null) {
    throw ledgerInvalid('Missing investigation-ledger markers.');
  }
  if (endLine <= startLine) {
    throw ledgerInvalid('Reversed investigation-ledger markers.');
  }
  const end = lines[endLine]!;
  return { start: lines[startLine]!.start, end: end.start + END.length };
}

function renderManifestLedgerRegion(
  whyOverlays: readonly InvestigationWhyOverlayV3[],
): string {
  const rows = [...whyOverlays]
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.pathIdentity.rawBase64, 'base64'),
        Buffer.from(right.pathIdentity.rawBase64, 'base64'),
      ),
    )
    .map((overlay, index) => renderManifestRow(overlay, index));
  return rows.length > 0
    ? `${START}\n\n${rows.join('\n\n')}\n\n${END}`
    : `${START}\n\n${END}`;
}

function renderManifestRow(
  overlay: InvestigationWhyOverlayV3,
  index: number,
): string {
  return [
    `### Manifest v3 load-bearing source ${index + 1}`,
    '',
    `- Overlay ID: ${renderValue(overlay.overlayId)}`,
    `- Path identity: ${renderValue(overlay.pathIdentity)}`,
    `- Blob OID: ${renderValue(overlay.blobOid)}`,
    `- Content SHA-256: ${renderValue(overlay.contentSha256)}`,
    `- Group refs: ${renderValue(overlay.groupRefs)}`,
    `- Source anchors: ${renderValue(overlay.anchors)}`,
    `- Why: ${renderValue(overlay.why)}`,
    `- Protected invariant: ${renderValue(overlay.protectedInvariant)}`,
    `- Reviewer question: ${renderValue(overlay.reviewerQuestion)}`,
    `- Answer: ${renderValue(overlay.answer)}`,
    `- Semantic author: ${renderValue(overlay.semanticAuthor)}`,
    `- Read complete: ${renderValue(overlay.readComplete)}`,
    `- Semantic assurance: ${renderValue(
      overlay.semanticAssurance,
    )} — actor-attested, not engine-verified`,
  ].join('\n');
}

/**
 * Render exact canonical JSON in a real Markdown code span whose delimiter is
 * longer than every backtick run in the value. HTML delimiter characters stay
 * entity-escaped so a literal managed marker cannot reappear in the source.
 */
function renderValue(value: unknown): string {
  const rendered = canonicalJson(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const runs = rendered.match(/`+/g) ?? [];
  const delimiter = '`'.repeat(
    runs.reduce((longest, run) => Math.max(longest, run.length), 0) + 1,
  );
  return `${delimiter}${rendered}${delimiter}`;
}

function ledgerInvalid(
  message = 'Investigation ledger projection is invalid.',
) {
  return workflowError('INVESTIGATION_LEDGER_INVALID', message, ExitCode.usage);
}
