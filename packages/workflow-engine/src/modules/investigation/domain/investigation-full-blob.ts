/**
 * Materializes full pinned source bytes and disposition relationships for
 * current WHY authoring requirements.
 *
 * Invariants:
 * - Each full-blob fact must match the required path, blob identity and
 *   actual content digest.
 */
import crypto from 'node:crypto';

import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import { ExitCode, workflowError } from '../../../foundation/errors/errors.ts';
import type { ScanTreeSnapshot } from './investigation-scanner.ts';
import type { AppliedInvestigationDisposition } from './investigation-domain.ts';
import type { InvestigationV3WhyRequirement } from '../manifest/investigation-why-domain.ts';

const DIGEST = /^[0-9a-f]{64}$/;
const GIT_OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const REGULAR_BLOB_MODES = new Set(['100644', '100755']);

export type InvestigationFullBlobFact = Readonly<{
  manifestEntryId: string;
  sourceKey: string;
  path: Readonly<{ rawBase64: string; utf8: string | null }>;
  treeDigest: string;
  blob: Readonly<{
    objectId: string;
    objectType: 'blob';
    mode: string;
    byteSize: number;
    contentSha256: string;
    lineCount: number;
    contentBase64: string;
  }>;
  coveredHitKeys: readonly string[];
  matchedTermIds: readonly string[];
  groupRefs: InvestigationV3WhyRequirement['groupRefs'];
  relevantLocations: readonly Readonly<{
    path: Readonly<{ rawBase64: string; utf8: string | null }>;
    byteOffset: number;
    byteLength: number;
    termId: string;
    hitKey: string;
  }>[];
  relationshipsToChange: readonly Readonly<{
    groupKey: string;
    dispositionDigest: string;
    classification: string;
    rationale: string;
    semanticAuthor: AppliedInvestigationDisposition['semanticAuthor'];
  }>[];
}>;

/**
 * Materialize the temporary full-blob authoring rows owed by current v3 WHY
 * requirements. The tracked Manifest keeps only anchors and semantic overlays;
 * complete bytes remain process-local for the checkpoint and ledger-reuse
 * decisions.
 */
export function deriveInvestigationFullBlobFacts(input: {
  snapshot: ScanTreeSnapshot;
  requirements: readonly InvestigationV3WhyRequirement[];
  dispositions: readonly AppliedInvestigationDisposition[];
}): InvestigationFullBlobFact[] {
  if (!DIGEST.test(input.snapshot.treeDigest)) {
    throw fullBlobInvalid('The pinned investigation tree digest is malformed.');
  }
  const entries = new Map(
    input.snapshot.entries.map((entry) => [entry.path.rawBase64, entry]),
  );
  if (entries.size !== input.snapshot.entries.length) {
    throw fullBlobInvalid('The pinned investigation tree repeats a path.');
  }
  const dispositionByGroup = new Map(
    input.dispositions.map((disposition) => [
      disposition.groupRef.key,
      disposition,
    ]),
  );
  if (dispositionByGroup.size !== input.dispositions.length) {
    throw fullBlobInvalid('Current dispositions repeat a group identity.');
  }

  const seenSources = new Set<string>();
  return input.requirements
    .map((requirement): InvestigationFullBlobFact => {
      if (
        !DIGEST.test(requirement.sourceKey) ||
        seenSources.has(requirement.sourceKey)
      ) {
        throw fullBlobInvalid('Current WHY requirements repeat a source.');
      }
      seenSources.add(requirement.sourceKey);
      const entry = entries.get(requirement.pathIdentity.rawBase64);
      if (
        entry === undefined ||
        canonicalJson(entry.path) !== canonicalJson(requirement.pathIdentity) ||
        entry.skipReason !== undefined ||
        entry.content === undefined ||
        entry.contentSha256 === undefined ||
        entry.objectId !== requirement.blobOid ||
        entry.contentSha256 !== requirement.contentSha256 ||
        entry.objectType !== 'blob' ||
        !GIT_OBJECT.test(entry.objectId) ||
        !REGULAR_BLOB_MODES.has(entry.mode) ||
        entry.byteSize !== entry.content.byteLength ||
        sha256Buffer(entry.content) !== entry.contentSha256
      ) {
        throw fullBlobInvalid(
          'A current load-bearing source has no matching readable pinned blob.',
        );
      }
      const relationshipsToChange = requirement.groupRefs.map((groupRef) => {
        const disposition = dispositionByGroup.get(groupRef.key);
        if (
          disposition === undefined ||
          disposition.classification !== 'load-bearing' ||
          canonicalJson(disposition.groupRef) !== canonicalJson(groupRef)
        ) {
          throw fullBlobInvalid(
            'A current load-bearing source has no exact disposition binding.',
          );
        }
        return Object.freeze({
          groupKey: groupRef.key,
          dispositionDigest: disposition.dispositionDigest,
          classification: disposition.classification,
          rationale: disposition.rationale,
          semanticAuthor: structuredClone(disposition.semanticAuthor),
        });
      });
      const blob = Object.freeze({
        objectId: entry.objectId,
        objectType: 'blob' as const,
        mode: entry.mode,
        byteSize: entry.content.byteLength,
        contentSha256: entry.contentSha256,
        lineCount: countLines(entry.content),
        contentBase64: entry.content.toString('base64'),
      });
      const fields = {
        sourceKey: requirement.sourceKey,
        path: structuredClone(requirement.pathIdentity),
        treeDigest: input.snapshot.treeDigest,
        blob,
        coveredHitKeys: requirement.hits.map(({ hitKey }) => hitKey).sort(),
        matchedTermIds: [
          ...new Set(requirement.hits.map(({ termId }) => termId)),
        ].sort(),
        groupRefs: structuredClone(requirement.groupRefs),
        relevantLocations: requirement.hits
          .map((hit) => ({
            path: structuredClone(requirement.pathIdentity),
            byteOffset: hit.byteRange.start,
            byteLength: hit.byteRange.end - hit.byteRange.start,
            termId: hit.termId,
            hitKey: hit.hitKey,
          }))
          .sort((left, right) => left.hitKey.localeCompare(right.hitKey)),
        relationshipsToChange,
      };
      return Object.freeze({
        // The WHY row answers for these bytes at this path, so its identity is
        // the bytes at the path: hits, terms, and groups may move around a file
        // between revisions without asking for the same reading twice.
        manifestEntryId: sha256({
          schema: 'investigation.full-blob-fact.v3',
          path: fields.path,
          blob: { objectId: blob.objectId, contentSha256: blob.contentSha256 },
        }),
        ...fields,
      });
    })
    .sort((left, right) =>
      Buffer.compare(
        Buffer.from(left.path.rawBase64, 'base64'),
        Buffer.from(right.path.rawBase64, 'base64'),
      ),
    );
}

function countLines(content: Buffer): number {
  if (content.length === 0) return 0;
  let lines = 1;
  for (const byte of content) if (byte === 0x0a) lines += 1;
  return lines;
}

function sha256(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function sha256Buffer(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fullBlobInvalid(message: string) {
  return workflowError(
    'SEMANTIC_COMPLETENESS_FAILURE',
    message,
    ExitCode.guard,
  );
}
