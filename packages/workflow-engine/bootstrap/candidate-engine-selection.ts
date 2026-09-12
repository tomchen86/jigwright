/** Bind fresh bootstrap verification to candidate dependency admission in this process. */
import { createCandidateHarnessEngineDigestReader } from '../src/modules/authority/candidate-engine-selection.ts';
import { bootstrapInterventionStateRoot } from './control-plane-bootstrap-files.ts';
import { resolveLocalEngineSelection } from './control-plane-bootstrap-local.ts';
import { resolveControlPlaneEngineSelection } from './control-plane-trust.ts';
import { BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST } from './built-in-engine-closure-pin.ts';

export const resolveCandidateHarnessEngineDigest =
  createCandidateHarnessEngineDigestReader({
    bootstrapInterventionStateRoot,
    resolveLocalEngineSelection,
    resolveControlPlaneEngineSelection,
    BUILT_IN_ENGINE_CLOSURE_MANIFEST_DIGEST,
  });
