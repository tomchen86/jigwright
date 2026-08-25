import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  WORKFLOW_CONFORMANCE_DOMAIN_IDS_V2,
  loadWorkflowConformanceVectorsV2,
} from '../src/conformance-vectors.ts';

test('the public core package ships every T3 3.0 conformance domain', () => {
  const vectors = loadWorkflowConformanceVectorsV2();
  assert.equal(vectors.kind, 'jigwright.workflow-conformance-vectors.v2');
  assert.equal(vectors.schemaVersion, 2);
  assert.deepEqual(
    Object.keys(vectors.domains).sort(),
    [...WORKFLOW_CONFORMANCE_DOMAIN_IDS_V2].sort(),
  );
  for (const domain of WORKFLOW_CONFORMANCE_DOMAIN_IDS_V2) {
    assert.ok(vectors.domains[domain].length > 0, domain);
  }
  assert.match(vectors.vectorSetDigest, /^sha256:[0-9a-f]{64}$/u);
});

test('the vector loader fails closed on same-shape byte drift', () => {
  const source = loadWorkflowConformanceVectorsV2();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'jigwright-conformance-vectors-'),
  );
  try {
    const file = path.join(directory, 'vectors.json');
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        ...source,
        domains: {
          ...source.domains,
          'canonical-json': [
            {
              ...source.domains['canonical-json'][0],
              canonical: 'tampered',
            },
          ],
        },
      })}\n`,
      { mode: 0o600 },
    );
    assert.throws(
      () => loadWorkflowConformanceVectorsV2({ vectorPath: file }),
      /digest does not match/u,
    );
  } finally {
    fs.rmSync(directory, { recursive: true });
  }
});
