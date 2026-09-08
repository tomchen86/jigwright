/** Public bootstrap-only engine selection and terminal-state routing. */
import fs from 'node:fs';
import path from 'node:path';
import {
  trustError,
  deepFreeze,
  supervisorNotTerminal,
  identityFileName,
  isRecord,
} from './control-plane-bootstrap-values.ts';
import type {
  BootstrapControlPlaneSupervisorState,
  BootstrapPaths,
} from './control-plane-bootstrap-types.ts';
import {
  bootstrapPaths,
  assertPrivateDirectory,
  readSupervisor,
  readCanonicalPrivateRecord,
} from './control-plane-bootstrap-files.ts';
import {
  assertNoOrphanedGlobalControlPlaneState,
  assertInitialBootstrapTerminalSelection,
} from './control-plane-bootstrap-initial.ts';
import { assertTerminalSelectionV3 } from './control-plane-bootstrap-history.ts';
import { runRestartProbe } from './control-plane-bootstrap-executable.ts';
export type {
  BootstrapControlPlaneSupervisorState,
  BootstrapControlPlaneEngineArtifact,
  BootstrapWorktreeIdentity,
  BootstrapRepositoryIdentity,
  BootstrapInitialSupervisorHooks,
  BootstrapLocalEngineSelection,
  BootstrapParentInterventionFence,
  BootstrapRecoveryQuarantineMarker,
  InitialControlPlaneSupervisorAnchorEvidence,
} from './control-plane-bootstrap-types.ts';
export { bootstrapInterventionStateRoot } from './control-plane-bootstrap-files.ts';
export {
  bootstrapRecoveryAuthorityStateRoot,
  resolveRecoveryQuarantineMarker,
  resolveRecoveryOperationalTrustRootFence,
} from './control-plane-bootstrap-quarantine.ts';
export { verifyBootstrapRepositoryIdentity } from './control-plane-bootstrap-provenance.ts';
export {
  initializeBuiltInControlPlaneSupervisor,
  readInitialControlPlaneSupervisorAnchorEvidence,
} from './control-plane-bootstrap-initial.ts';
export {
  readBuiltInControlPlaneEngineArtifact,
  verifyBuiltInEngineClosure,
} from './control-plane-bootstrap-closure.ts';
export {
  resolveParentInterventionFence,
  assertParentInterventionFenceCleared,
  resolveLocalEngineSelection,
} from './control-plane-bootstrap-local.ts';

/**
 * Resolve the exact active engine using only bootstrap-owned verification.
 * Null is allowed only for a repository that has never materialized a
 * supervisor artifact or promotion bundle.
 */
export function resolveControlPlaneEngineSelection(
  storageRoot: string,
  expectedRepositoryId?: string,
): BootstrapControlPlaneSupervisorState | null {
  const paths = bootstrapPaths(storageRoot);
  const supervisor = fs.lstatSync(paths.supervisor, { throwIfNoEntry: false });
  if (supervisor === undefined) {
    assertNoOrphanedGlobalControlPlaneState(paths);
    return null;
  }

  assertPrivateDirectory(paths.root, 'CONTROL_PLANE_STATE_UNSAFE');
  const state = readSupervisor(paths);
  if (
    expectedRepositoryId !== undefined &&
    state.repositoryId !== expectedRepositoryId
  ) {
    throw trustError(
      'CONTROL_PLANE_SUPERVISOR_REPOSITORY_MISMATCH',
      'Control-plane supervisor belongs to another trusted repository identity.',
      11,
    );
  }
  assertTerminalSelection(paths, state);
  runRestartProbe(paths, state);
  return deepFreeze(structuredClone(state));
}

function assertTerminalSelection(
  paths: BootstrapPaths,
  supervisor: BootstrapControlPlaneSupervisorState,
): void {
  const transition = supervisor.transition;
  if (transition === null) {
    try {
      assertInitialBootstrapTerminalSelection(paths, supervisor);
    } catch {
      throw supervisorNotTerminal();
    }
    return;
  }
  assertPrivateDirectory(paths.controlUpdates, 'CONTROL_PLANE_STATE_UNSAFE');
  const recordPath = path.join(
    paths.controlUpdates,
    `${identityFileName('control-update', transition.grantId)}.json`,
  );
  const value = readCanonicalPrivateRecord(recordPath);
  if (isRecord(value) && value.kind === 'persisted-control-plane-update.v3') {
    try {
      assertTerminalSelectionV3(paths, supervisor, value);
    } catch {
      throw supervisorNotTerminal();
    }
    return;
  }
  throw supervisorNotTerminal();
}
