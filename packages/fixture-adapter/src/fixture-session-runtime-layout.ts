/**
 * Maps fixture session storage onto the public runtime layout port.
 *
 * Invariants:
 * - All fixture locations are derived beneath the supplied runtime
 *   directory in fixture-state.
 */
import path from 'node:path';

import type { SessionRuntimeLayoutPortV1 } from '@jigwright/core/session-runtime-layout-port';

export const fixtureSessionRuntimeLayoutPort: SessionRuntimeLayoutPortV1 = {
  contractVersion: 'jigwright.session-runtime-layout-port.v1',
  resolve({ gitCommonDirectory, runtimeDirectory }) {
    const root = path.join(
      gitCommonDirectory,
      runtimeDirectory,
      'fixture-state',
    );
    return {
      root,
      locks: path.join(root, 'mutex'),
      operations: path.join(root, 'transitions'),
      sessions: path.join(root, 'work-sessions'),
      reports: path.join(root, 'evidence'),
      taskRevisions: path.join(root, 'revisions'),
    };
  },
};
