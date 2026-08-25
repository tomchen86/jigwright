import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { sourceRepositoryRoot } from './fixture.ts';

test('legacy v2 investigation Grant transition module remains retired', () => {
  assert.equal(
    fs.existsSync(
      path.join(
        sourceRepositoryRoot,
        'packages/workflow-engine/src/adapters/compatibility/investigation-v2/investigation-grant-transitions.ts',
      ),
    ),
    false,
  );
});
