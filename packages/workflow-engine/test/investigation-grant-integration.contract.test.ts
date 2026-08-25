import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { sourceRepositoryRoot } from './fixture.ts';

test('production Grant registry and CLI expose no live v2 Investigation surface', () => {
  const production = fs.readFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/composition-root/grant-production.ts',
    ),
    'utf8',
  );
  const cli = fs.readFileSync(
    path.join(
      sourceRepositoryRoot,
      'packages/workflow-engine/src/entrypoints/cli/human-grant-cli.ts',
    ),
    'utf8',
  );

  for (const retiredName of [
    'investigation-grant-transitions',
    'investigationGrantTransitionDefinitions',
    'requestInvestigationGrant',
  ]) {
    assert.equal(production.includes(retiredName), false, retiredName);
  }
  assert.equal(cli.includes("'request-investigation'"), false);
  assert.equal(cli.includes('requestInvestigation:'), false);
});
