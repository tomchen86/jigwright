/**
 * Declares the context manifest binding an execution epoch to its planned
 * inputs.
 *
 * Invariants:
 * - Manifest items carry both identity and digest, and the manifest fixes
 *   schema version 1.
 */
export type ContextManifestItemReference = {
  identity: string;
  digest: string;
};

export type ContextManifest = {
  schemaVersion: 1;
  kind: 'epoch-context-manifest';
  workflowId: string;
  epoch: number;
  contractVersion: number;
  baselineDigest: string;
  intentDigest: string;
  termSetDigest: string;
  planningSnapshotDigest: string;
  contextDigest: string;
  items: ContextManifestItemReference[];
};
