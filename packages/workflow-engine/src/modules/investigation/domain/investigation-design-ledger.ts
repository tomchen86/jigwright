/**
 * Projects investigation WHY overlays into the managed ledger region of a
 * design document.
 *
 * Invariants:
 * - Validation requires the stored ledger projection to equal a fresh
 *   projection.
 */
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import type { InvestigationWhyOverlayV3 } from '../manifest/investigation-manifest-types.ts';
import {
  hasExactMarkdownRegion,
  MarkdownRegionBoundsError,
  markdownLines,
  spliceMarkdownRegion,
  type MarkdownRegion,
} from '@jigwright/core/markdown-sections';

const START = '<!-- workflow:investigation-ledger:start v1 -->';
const END = '<!-- workflow:investigation-ledger:end v1 -->';
const MARKER_NAMESPACE = '<!-- workflow:investigation-ledger:';

/**
 * Replace the managed ledger with readable Manifest-v3 WHY explanations.
 * This is a direct Manifest projection: it consumes no historical EvidenceNode
 * envelope and preserves every authored byte outside the existing ledger
 * markers.
 */
export function projectInvestigationManifestLedger(
  design: string,
  whyOverlays: readonly InvestigationWhyOverlayV3[],
): string {
  const expected = renderManifestLedgerRegion(whyOverlays);
  // Preserve the service's missing-region result for untyped null callers.
  if (design === null) return '';
  const region = locateLedgerRegion(design);
  let after: string;
  try {
    after = spliceMarkdownRegion(design, region, expected);
  } catch (error) {
    if (error instanceof MarkdownRegionBoundsError) {
      throw workflowError('PROJECTION_INVALID', error.message, ExitCode.usage);
    }
    throw error;
  }
  if (
    after !== design &&
    !hasExactMarkdownRegion(after, expected, locateLedgerRegion)
  ) {
    throw workflowError(
      'PROJECTION_INVALID',
      'Projection candidate region is not discoverable and exact: investigation.why-ledger.',
      ExitCode.usage,
    );
  }
  return after;
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

export function locateLedgerRegion(design: string): MarkdownRegion {
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

export function renderManifestLedgerRegion(
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
    `### ${renderProse(overlay.pathIdentity.utf8 ?? `Source ${index + 1} (path is not representable as UTF-8)`)}`,
    '',
    renderProse(overlay.why),
    '',
    `Protected invariant: ${renderProse(overlay.protectedInvariant)}`,
    '',
    `Reviewer question: ${renderProse(overlay.reviewerQuestion)}`,
    '',
    `Answer: ${renderProse(overlay.answer)}`,
    '',
    `Source locations: ${overlay.anchors.map(({ byteRange }) => `bytes ${byteRange.start}–${byteRange.end}`).join('; ')}.`,
    '',
    'Reviewed claim; full source reading is actor-attested. Structured provenance remains in the investigation Manifest.',
  ].join('\n');
}

/** Escape Markdown syntax while keeping the explanation readable as prose. */
function renderProse(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]()#|])/g, '\\$1');
}

function ledgerInvalid(
  message = 'Investigation ledger projection is invalid.',
) {
  return workflowError('INVESTIGATION_LEDGER_INVALID', message, ExitCode.usage);
}
