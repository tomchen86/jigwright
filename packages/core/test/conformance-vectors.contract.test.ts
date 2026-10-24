import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  WORKFLOW_CONFORMANCE_DOMAIN_IDS_V2,
  parseWorkflowConformanceVectorsV2,
  workflowConformanceVectorsUrl,
} from '../src/conformance-vectors.ts';

const source = fs.readFileSync(workflowConformanceVectorsUrl(), 'utf8');

test('the public core package ships every T3 3.0 conformance domain', () => {
  const vectors = parseWorkflowConformanceVectorsV2(source);
  assert.equal(vectors.kind, 'jigwright.workflow-conformance-vectors.v2');
  assert.equal(vectors.schemaVersion, 2);
  assert.deepEqual(
    Object.keys(vectors.domains).sort(),
    [...WORKFLOW_CONFORMANCE_DOMAIN_IDS_V2].sort(),
  );
  for (const domain of WORKFLOW_CONFORMANCE_DOMAIN_IDS_V2)
    assert.ok(vectors.domains[domain].length > 0, domain);
  assert.equal(
    vectors.vectorSetDigest,
    'sha256:b2113b55d86f6fd83cac7a1f3c62cea5df3b27a9feb0e5df5be011de694b089a',
  );
});

test('the public corpus exposes only the current Collaboration Grant envelope domain', () => {
  const vectors = parseWorkflowConformanceVectorsV2(source);
  const domains = vectors.domains as Readonly<
    Record<string, readonly Readonly<{ id: string }>[]>
  >;
  assert.deepEqual(
    domains['collaboration-grant-envelope']?.map(({ id }) => id),
    ['current-collaboration-grant-envelope'],
  );
  assert.equal(domains['legacy-ssh-envelope'], undefined);
});

test('the vector parser rejects same-shape byte drift without filesystem access', () => {
  const vectors = parseWorkflowConformanceVectorsV2(source);
  const changed = JSON.stringify({
    ...vectors,
    domains: {
      ...vectors.domains,
      'canonical-json': [
        { ...vectors.domains['canonical-json'][0], canonical: 'tampered' },
      ],
    },
  });
  assert.throws(
    () => parseWorkflowConformanceVectorsV2(changed),
    /digest does not match/u,
  );
  assert.throws(
    () => parseWorkflowConformanceVectorsV2('{'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        'Workflow conformance vectors are malformed JSON.',
      );
      assert.ok(error.cause instanceof SyntaxError);
      return true;
    },
  );
});
