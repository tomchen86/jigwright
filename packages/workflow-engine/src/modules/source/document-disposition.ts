import { isRecord } from '../../foundation/canonical-json/contract-values.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
/**
 * Finds the contracts and design explanations that a module change must disposition.
 *
 * Invariants:
 * - Both sides of a move or deletion retain their containing document obligations.
 * - Confirmation, an observed update, and deferred work remain distinct statements.
 */

import path from 'node:path';
import { sourceDigest } from './import-dependencies.ts';
import { readModuleReadmeWhy } from './module-readme.ts';
import {
  findContainingSpec,
  type SystemDescriptionSnapshot,
} from './spec-ownership.ts';
import { systemSpecPaths } from './system-documents.ts';

export const SYSTEM_DOCUMENT_DISPOSITION_REQUIRED =
  'SYSTEM_DOCUMENT_DISPOSITION_REQUIRED';

export const SYSTEM_DOCUMENT_DISPOSITION_TRANSITION =
  'system-documents.skip-obligations.v1';

export type SystemDocumentObligation = Readonly<{
  path: string;
  kind: 'spec' | 'readme';
  affectedPaths: readonly string[];
  beforeDigest: string | null;
  afterDigest: string | null;
  contentChanged: boolean;
  explanationPresent?: boolean;
  deltaChangesContract?: boolean;
  deltas?: readonly Readonly<{
    path: string;
    digest: string;
  }>[];
}>;

export type SystemDocumentDisposition = Readonly<{
  path: string;
  disposition: 'still-valid' | 'updated' | 'later';
  reason?: string;
  followUpRef?: string;
}>;

export function collectSystemDocumentObligations(
  before: SystemDescriptionSnapshot,
  after: SystemDescriptionSnapshot,
  changedPaths: readonly string[],
): readonly SystemDocumentObligation[] {
  const affected = new Map<string, Set<string>>();
  for (const snapshot of [before, after]) {
    const paths = snapshot.listPaths();
    const specs = systemSpecPaths(paths);
    const present = new Set(paths);
    for (const changed of changedPaths) {
      const spec = findContainingSpec(changed, specs);
      const readme =
        spec === null
          ? null
          : nearestReadme(changed, snapshot, path.posix.dirname(spec));
      const documents = [spec, readme];
      if (
        path.posix.basename(changed) === 'README.md' &&
        present.has(changed) &&
        hasExplanation(snapshot.readText(changed))
      )
        documents.push(changed);
      for (const document of documents) {
        if (document === null) continue;
        const paths = affected.get(document) ?? new Set<string>();
        paths.add(changed);
        affected.set(document, paths);
      }
    }
  }
  return [...affected]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([document, paths]) => ({
      path: document,
      kind: path.posix.basename(document) === 'spec.md' ? 'spec' : 'readme',
      affectedPaths: [...paths].sort(),
      beforeDigest: digest(before.readText(document)),
      afterDigest: digest(after.readText(document)),
      ...(path.posix.basename(document) === 'README.md'
        ? { explanationPresent: readableExplanation(after.readText(document)) }
        : {}),
      contentChanged:
        path.posix.basename(document) === 'README.md'
          ? explanationChanged(
              before.readText(document),
              after.readText(document),
            )
          : before.readText(document) !== after.readText(document),
    }));
}

export function assessSystemDocumentDispositions(
  obligations: readonly SystemDocumentObligation[],
  dispositions: readonly SystemDocumentDisposition[],
): { missing: string[]; invalid: Array<{ path: string; reason: string }> } {
  const missing: string[] = [];
  const invalid: Array<{ path: string; reason: string }> = [];
  for (const document of obligations) {
    const entries = dispositions.filter(({ path }) => path === document.path);
    if (entries.length === 0) {
      missing.push(document.path);
      continue;
    }
    if (entries.length !== 1) {
      invalid.push({
        path: document.path,
        reason: 'Disposition must be unique.',
      });
      continue;
    }
    const entry = entries[0]!;
    let reason: string | null = null;
    if (
      entry.disposition === 'updated' &&
      !document.contentChanged &&
      !document.deltaChangesContract
    )
      reason =
        'The contract or handwritten explanation has no observed update.';
    else if (
      entry.disposition === 'still-valid' &&
      document.afterDigest === null
    )
      reason = 'A deleted document cannot be confirmed as still present.';
    else if (
      entry.disposition === 'still-valid' &&
      document.kind === 'readme' &&
      !document.explanationPresent
    )
      reason =
        'The handwritten explanation is missing or unreadable; restore it or explicitly defer it.';
    else if (entry.disposition === 'later' && !entry.reason?.trim())
      reason = 'Deferred work needs an explicit reason.';
    else if (!['still-valid', 'updated', 'later'].includes(entry.disposition))
      reason = 'Choose still-valid, updated, or later.';
    if (reason !== null) invalid.push({ path: document.path, reason });
  }
  for (const entry of dispositions) {
    if (!obligations.some(({ path }) => path === entry.path))
      invalid.push({
        path: entry.path,
        reason: 'The document is outside this candidate.',
      });
  }
  return { missing, invalid };
}

function nearestReadme(
  file: string,
  snapshot: SystemDescriptionSnapshot,
  ownerDirectory: string,
): string | null {
  let directory = path.posix.dirname(file);
  while (true) {
    const candidate = path.posix.join(directory, 'README.md');
    if (hasExplanation(snapshot.readText(candidate))) return candidate;
    if (directory === ownerDirectory || directory === '.') return null;
    directory = path.posix.dirname(directory);
  }
}

function digest(content: string | undefined): string | null {
  return content === undefined ? null : sourceDigest(content);
}

function explanationChanged(
  before: string | undefined,
  after: string | undefined,
): boolean {
  if (before === undefined || after === undefined) return before !== after;
  try {
    const current = readModuleReadmeWhy(after);
    return (
      current !== null && readModuleReadmeWhy(before)?.text !== current.text
    );
  } catch {
    return false;
  }
}

function hasExplanation(content: string | undefined): boolean {
  if (content === undefined) return false;
  try {
    return readModuleReadmeWhy(content) !== null;
  } catch {
    return true;
  } // Broken markers still leave an explicit document obligation.
}

function readableExplanation(content: string | undefined): boolean {
  if (content === undefined) return false;
  try {
    return readModuleReadmeWhy(content) !== null;
  } catch {
    return false;
  }
}

export type SystemDocumentGrantBinding = Readonly<{
  challengeId: string;
  operationId: string;
  approvalSubjectDigest: `sha256:${string}`;
}>;

export function parseDispositions(
  value: unknown,
): readonly SystemDocumentDisposition[] {
  if (!Array.isArray(value))
    throw reviewInvalid('dispositions must be an array.');
  return value.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.path !== 'string' ||
      !['still-valid', 'updated', 'later'].includes(
        entry.disposition as string,
      ) ||
      Object.keys(entry).some(
        (key) =>
          !['path', 'disposition', 'reason', 'followUpRef'].includes(key),
      ) ||
      [entry.reason, entry.followUpRef].some(
        (field) =>
          field !== undefined && (typeof field !== 'string' || !field.trim()),
      )
    )
      throw reviewInvalid(
        'Each disposition needs a path and still-valid, updated, or later; reasons and optional references are nonempty text.',
      );
    return entry as SystemDocumentDisposition;
  });
}

export function reviewInvalid(
  message: string,
  details?: Record<string, unknown>,
) {
  return workflowError(
    'SYSTEM_DOCUMENT_REVIEW_INVALID',
    message,
    ExitCode.guard,
    details === undefined ? {} : { details },
  );
}
