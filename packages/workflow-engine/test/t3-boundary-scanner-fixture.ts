/** T3 syntax-bound source and JSON finding scans and canonical identities. */
import { scanT3BoundarySource as scanT3BoundarySourceWithNamespace } from '../src/modules/assurance/t3-boundary-scanner.ts';
import fs from 'node:fs';
import path from 'node:path';
import {
  ts,
  listRegularFiles,
  compareText,
  digestText,
  assertPlainObject,
} from './boundary-contract-fixture.ts';

type T3StaticLiteralFinding = {
  path: string;
  start: number;
  length: number;
  normalizedValue: string;
  syntaxForm:
    | 'exact-string'
    | 'embedded-string'
    | 'template-static'
    | 'folded'
    | 'path-join'
    | 'path-resolve'
    | 'fs-readdir'
    | 'fs-readdir-sync'
    | 'namespace-fragment';
};

type T3BoundarySourceFindings = {
  workflowPaths: T3StaticLiteralFinding[];
  splitWorkflowPaths: T3StaticLiteralFinding[];
  dynamicWorkflowDirectories: T3StaticLiteralFinding[];
  namespace: T3StaticLiteralFinding[];
};

export type T3JsonStringFinding = {
  path: string;
  jsonPointer: string;
  normalizedValue: string;
};

export const scanT3BoundarySource = (
  api: typeof ts,
  file: string,
  source: string,
  extension: string,
) =>
  scanT3BoundarySourceWithNamespace(
    api,
    file,
    source,
    extension,
    'expense-app.workflow.',
  );

export function scanTypeScriptBoundaryLiterals(
  root: string,
  relativeRoot: string,
  extension: string,
): T3BoundarySourceFindings {
  const result: T3BoundarySourceFindings = {
    workflowPaths: [],
    splitWorkflowPaths: [],
    dynamicWorkflowDirectories: [],
    namespace: [],
  };
  for (const file of listRegularFiles(root, relativeRoot)) {
    if (!file.endsWith(extension)) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const structural = scanT3BoundarySource(ts, file, source, extension);
    result.workflowPaths.push(...structural.workflowPaths);
    result.namespace.push(...structural.namespace);
    result.splitWorkflowPaths.push(...structural.splitWorkflowPaths);
    result.dynamicWorkflowDirectories.push(
      ...structural.dynamicWorkflowDirectories,
    );
  }
  result.workflowPaths.sort(compareStaticFinding);
  result.splitWorkflowPaths.sort(compareStaticFinding);
  result.dynamicWorkflowDirectories.sort(compareStaticFinding);
  result.namespace.sort(compareStaticFinding);
  return result;
}

function compareStaticFinding(
  left: T3StaticLiteralFinding,
  right: T3StaticLiteralFinding,
): number {
  return (
    compareText(left.path, right.path) ||
    left.start - right.start ||
    compareText(left.normalizedValue, right.normalizedValue) ||
    compareText(left.syntaxForm, right.syntaxForm)
  );
}

export function digestStaticFindings(
  findings: readonly T3StaticLiteralFinding[],
): string {
  return digestText(
    findings
      .map((finding) =>
        [finding.path, finding.normalizedValue, finding.syntaxForm].join('\0'),
      )
      .sort(compareText)
      .join('\n'),
  );
}

export function scanWorkflowJsonNamespaces(
  root: string,
): T3JsonStringFinding[] {
  const result: T3JsonStringFinding[] = [];
  for (const finding of scanJsonStringLeaves(
    root,
    'workflow',
    (_file, _pointer, value) => value.includes('expense-app.workflow.'),
  )) {
    let matched = false;
    for (const match of finding.normalizedValue.matchAll(
      /expense-app\.workflow\.[A-Za-z0-9._-]+/gu,
    )) {
      matched = true;
      result.push({ ...finding, normalizedValue: match[0] });
    }
    if (!matched) {
      result.push({
        ...finding,
        normalizedValue: 'expense-app.workflow.',
      });
    }
  }
  return result.sort(compareJsonFindings);
}

export function scanWorkflowArtifactPaths(root: string): T3JsonStringFinding[] {
  return scanJsonStringLeaves(
    root,
    'workflow',
    (file, _pointer, value) =>
      path.posix.dirname(file) === 'workflow' &&
      (value === 'packages/workflow-engine' ||
        value.startsWith('packages/workflow-engine/')),
  );
}

export function scanJsonSchemaIds(root: string): T3JsonStringFinding[] {
  const result: T3JsonStringFinding[] = [];
  for (const file of listRegularFiles(root, 'workflow/schemas')) {
    if (!file.endsWith('.json')) continue;
    const value = JSON.parse(
      fs.readFileSync(path.join(root, file), 'utf8'),
    ) as unknown;
    assertPlainObject(value, `JSON Schema ${file}`);
    if (
      !Object.prototype.hasOwnProperty.call(value, '$id') ||
      typeof value.$id !== 'string'
    ) {
      throw new Error(`JSON Schema ${file} must have a root string $id.`);
    }
    try {
      new URL(value.$id);
    } catch {
      throw new Error(`JSON Schema ${file} has an invalid $id.`);
    }
    result.push({
      path: file,
      jsonPointer: '/$id',
      normalizedValue: value.$id,
    });
  }
  return result.sort(compareJsonFindings);
}

function scanJsonStringLeaves(
  root: string,
  relativeRoot: string,
  include: (file: string, jsonPointer: string, value: string) => boolean,
): T3JsonStringFinding[] {
  const result: T3JsonStringFinding[] = [];
  for (const file of listRegularFiles(root, relativeRoot)) {
    if (!file.endsWith('.json')) continue;
    const value = JSON.parse(
      fs.readFileSync(path.join(root, file), 'utf8'),
    ) as unknown;
    visitJsonStrings(value, '', (jsonPointer, leaf) => {
      if (include(file, jsonPointer, leaf)) {
        result.push({ path: file, jsonPointer, normalizedValue: leaf });
      }
    });
  }
  return result.sort(compareJsonFindings);
}

function visitJsonStrings(
  value: unknown,
  jsonPointer: string,
  visit: (jsonPointer: string, value: string) => void,
): void {
  if (typeof value === 'string') {
    visit(jsonPointer, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      visitJsonStrings(entry, `${jsonPointer}/${index}`, visit),
    );
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    visitJsonStrings(
      entry,
      `${jsonPointer}/${escapeJsonPointerSegment(key)}`,
      visit,
    );
  }
}

function escapeJsonPointerSegment(value: string): string {
  return value.replace(/~/gu, '~0').replace(/\//gu, '~1');
}

export function summarizeJsonSchemaIdHosts(
  findings: readonly T3JsonStringFinding[],
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const finding of findings) {
    const host = new URL(finding.normalizedValue).host;
    result[host] = (result[host] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(result).sort(([left], [right]) => compareText(left, right)),
  );
}

export function summarizeJsonFindings(
  findings: readonly T3JsonStringFinding[],
): {
  occurrences: number;
  fileCount: number;
  identityDigest: string;
} {
  return {
    occurrences: findings.length,
    fileCount: new Set(findings.map((finding) => finding.path)).size,
    identityDigest: digestJsonFindings(findings),
  };
}

export function digestJsonFindings(
  findings: readonly T3JsonStringFinding[],
): string {
  return digestText(
    findings
      .map((finding) =>
        [finding.path, finding.jsonPointer, finding.normalizedValue].join('\0'),
      )
      .sort(compareText)
      .join('\n'),
  );
}

function compareJsonFindings(
  left: T3JsonStringFinding,
  right: T3JsonStringFinding,
): number {
  return (
    compareText(left.path, right.path) ||
    compareText(left.jsonPointer, right.jsonPointer) ||
    compareText(left.normalizedValue, right.normalizedValue)
  );
}
