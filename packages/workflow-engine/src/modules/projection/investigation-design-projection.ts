import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { EvidenceNode } from '../../adapters/planning/investigation/evidence-node.ts';
import type { InvestigationWhyOverlayV3 } from '../investigation/manifest/investigation-manifest.ts';
import {
  readInvestigationWhyNode,
  type InvestigationWhyOutput,
} from '../../adapters/planning/investigation/investigation-why.ts';
import { markdownLines } from '@jigwright/core/markdown-sections';

const START = '<!-- workflow:investigation-ledger:start v1 -->';
const END = '<!-- workflow:investigation-ledger:end v1 -->';
const MARKER_NAMESPACE = '<!-- workflow:investigation-ledger:';

/**
 * Replace the single managed investigation-ledger region with a freshly rendered
 * table derived from the WHY evidence, preserving every authored byte outside the
 * region. The exact v1 markers own the region; marker-like text inside Markdown
 * code fences is ignored, and a missing, duplicate, nested, reversed, or
 * malformed marker fails closed. All dynamic content is HTML-escaped so semantic
 * text can neither forge a marker nor inject Markdown structure — which also
 * keeps the projection idempotent.
 */
export function projectInvestigationLedger(
  design: string,
  whyNodes: EvidenceNode[],
): string {
  const region = locateLedgerRegion(design);
  const prefix = design.slice(0, region.start);
  const suffix = design.slice(region.end);
  return `${prefix}${renderLedgerRegion(whyNodes)}${suffix}`;
}

/**
 * Confirm the projection's managed region is exactly the region a fresh render of
 * the same WHY evidence would produce, byte for byte, with every authored byte
 * outside it preserved. Any edit to the region, or a malformed marker, fails
 * closed.
 */
export function validateInvestigationLedgerProjection(
  projected: string,
  whyNodes: EvidenceNode[],
): { valid: true; rowCount: number } {
  const reprojected = projectInvestigationLedger(projected, whyNodes);
  if (reprojected !== projected) {
    throw ledgerInvalid('Projection does not match the rendered ledger.');
  }
  return { valid: true, rowCount: whyNodes.length };
}

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

function renderLedgerRegion(whyNodes: EvidenceNode[]): string {
  const rows = whyNodes
    .map(readInvestigationWhyNode)
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.path.rawBase64, 'base64'),
        Buffer.from(right.path.rawBase64, 'base64'),
      ),
    )
    .map((why, index) => renderRow(why, index));
  return rows.length > 0
    ? `${START}\n\n${rows.join('\n\n')}\n\n${END}`
    : `${START}\n\n${END}`;
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

function renderRow(why: InvestigationWhyOutput, index: number): string {
  return [
    `### Load-bearing file ${index + 1}`,
    '',
    `- Manifest entry ID: ${renderValue(why.manifestEntryId)}`,
    `- Path identity: ${renderValue(why.path)}`,
    `- Tree digest: ${renderValue(why.treeDigest)}`,
    `- Blob: ${renderValue(why.blob)}`,
    `- Covered hit IDs: ${renderValue(why.coveredHitIds)}`,
    `- Matched term IDs: ${renderValue(why.matchedTermIds)}`,
    `- Group IDs: ${renderValue(why.groupIds)}`,
    `- Disposition node IDs: ${renderValue(why.dispositionNodeIds)}`,
    `- Relevant locations: ${renderValue(why.relevantLocations)}`,
    `- Relationships to change: ${renderValue(why.relationshipsToChange)}`,
    `- Why: ${renderValue(why.why)}`,
    `- Protected invariant: ${renderValue(why.protectedInvariant)}`,
    `- Reviewer question: ${renderValue(why.reviewerQuestion)}`,
    `- Answer: ${renderValue(why.answer)}`,
    `- Semantic author: ${renderValue(why.semanticAuthor)}`,
    `- Read complete: ${renderValue(why.readComplete)}`,
    `- Semantic assurance: ${renderValue(
      why.semanticAssurance,
    )} — actor-attested, not engine-verified`,
  ].join('\n');
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
