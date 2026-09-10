/**
 * Loads and validates the public workflow conformance corpus.
 *
 * Invariants:
 * - All registered domains must be present and nonempty, and vector
 *   identities must be unique across domains.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from './canonical-json.ts';

export const WORKFLOW_CONFORMANCE_DOMAIN_IDS_V2 = Object.freeze([
  'canonical-json',
  'digest-identity',
  'managed-trailer',
  'journal-record',
  'manifest-plan-review',
  'central-grant',
  'collaboration-grant-envelope',
  'agent-protocol-frame',
  'planning-binding',
] as const);

export type WorkflowConformanceDomainIdV2 =
  (typeof WORKFLOW_CONFORMANCE_DOMAIN_IDS_V2)[number];

export type WorkflowConformanceVectorV2 = Readonly<{
  id: string;
  [key: string]: unknown;
}>;

export type WorkflowConformanceVectorsV2 = Readonly<{
  kind: 'jigwright.workflow-conformance-vectors.v2';
  schemaVersion: 2;
  algorithms: Readonly<Record<string, string>>;
  domains: Readonly<
    Record<
      WorkflowConformanceDomainIdV2,
      readonly WorkflowConformanceVectorV2[]
    >
  >;
  vectorSetDigest: `sha256:${string}`;
}>;

const DEFAULT_VECTOR_PATH = fileURLToPath(
  new URL('../conformance/workflow-conformance-v2.json', import.meta.url),
);
const VECTOR_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/u;

/** Load and authenticate the public, language-neutral T3 conformance corpus. */
export function loadWorkflowConformanceVectorsV2(
  options: Readonly<{ vectorPath?: string }> = {},
): WorkflowConformanceVectorsV2 {
  const requestedPath = path.resolve(options.vectorPath ?? DEFAULT_VECTOR_PATH);
  const stats = fs.lstatSync(requestedPath, { throwIfNoEntry: false });
  if (
    !stats?.isFile() ||
    stats.isSymbolicLink() ||
    stats.size === 0 ||
    stats.size > 1024 * 1024
  ) {
    throw new Error(
      'Workflow conformance vectors must be a bounded plain file.',
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(requestedPath, 'utf8')) as unknown;
  } catch (error) {
    throw new Error('Workflow conformance vectors are malformed JSON.', {
      cause: error,
    });
  }
  if (
    !isRecord(value) ||
    value.kind !== 'jigwright.workflow-conformance-vectors.v2' ||
    value.schemaVersion !== 2 ||
    !isRecord(value.algorithms) ||
    !isRecord(value.domains) ||
    !PREFIXED_SHA256.test(String(value.vectorSetDigest))
  ) {
    throw new Error('Workflow conformance vector header is invalid.');
  }
  assertExactKeys(value, [
    'algorithms',
    'domains',
    'kind',
    'schemaVersion',
    'vectorSetDigest',
  ]);
  const domainValues = value.domains;
  assertExactKeys(domainValues, [...WORKFLOW_CONFORMANCE_DOMAIN_IDS_V2]);
  const ids = new Set<string>();
  const domains = Object.fromEntries(
    WORKFLOW_CONFORMANCE_DOMAIN_IDS_V2.map((domain) => {
      const candidates = domainValues[domain];
      if (!Array.isArray(candidates) || candidates.length === 0) {
        throw new Error(`Workflow conformance domain ${domain} is empty.`);
      }
      const parsed = candidates.map((candidate, index) => {
        if (!isRecord(candidate) || !VECTOR_ID.test(String(candidate.id))) {
          throw new Error(
            `Workflow conformance vector ${domain}/${index + 1} is invalid.`,
          );
        }
        const id = String(candidate.id);
        if (ids.has(id)) {
          throw new Error(
            `Workflow conformance vector ID is duplicated: ${id}`,
          );
        }
        ids.add(id);
        return deepFreeze(
          structuredClone(candidate),
        ) as WorkflowConformanceVectorV2;
      });
      return [domain, Object.freeze(parsed)] as const;
    }),
  ) as Record<
    WorkflowConformanceDomainIdV2,
    readonly WorkflowConformanceVectorV2[]
  >;
  const algorithms = Object.fromEntries(
    Object.entries(value.algorithms).map(([key, algorithm]) => {
      if (
        !VECTOR_ID.test(key) ||
        typeof algorithm !== 'string' ||
        algorithm.length === 0
      ) {
        throw new Error('Workflow conformance algorithm registry is invalid.');
      }
      return [key, algorithm];
    }),
  );
  const payload = {
    kind: value.kind,
    schemaVersion: value.schemaVersion,
    algorithms,
    domains,
  };
  const expectedDigest = digest(canonicalJson(payload));
  if (value.vectorSetDigest !== expectedDigest) {
    throw new Error('Workflow conformance vector digest does not match.');
  }
  return deepFreeze({
    ...payload,
    vectorSetDigest: expectedDigest,
  }) as WorkflowConformanceVectorsV2;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): void {
  const actual = Object.keys(value).sort();
  expected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      'Workflow conformance vector object has unknown or missing keys.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function digest(value: string): `sha256:${string}` {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}
