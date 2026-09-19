/**
 * Publishes and reads immutable evidence node objects with exact canonical bytes.
 *
 * Invariants:
 * - Exclusive publication accepts only exact existing bytes and preserves collision failures.
 * - Reads validate the stored envelope after private file and directory safety checks.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  type EvidenceNode,
  assertStoredEvidenceNode,
  canonicalEvidenceNodeEnvelope,
} from '../../foundation/evidence-node/evidence-node.ts';
import { type InvestigationRuntimePaths } from '../paths/runtime-paths.ts';
import {
  assertExactEvidenceObjectFinal,
  assertExactEvidencePublicationAlias,
  evidencePublicationAlias,
  inspectEvidenceObjectFinal,
  reclaimEvidencePublicationAliases,
  unlinkOwnedEvidencePublicationAlias,
} from './evidence-node-publication.ts';
import {
  NO_FOLLOW_CREATE,
  assertNoFollowDirectory,
  ensureNoFollowDirectory,
  fsyncDirectory,
  readNoFollow,
} from './evidence-private-files.ts';
import {
  assertNodeId,
  evidenceObjectPath,
  isNodeError,
  objectInvalid,
  objectUnsafe,
} from './evidence-store-values.ts';

export function writeEvidenceNode(
  paths: InvestigationRuntimePaths,
  node: EvidenceNode,
): string {
  assertStoredEvidenceNode(node, objectInvalid);
  const content = canonicalEvidenceNodeEnvelope(node);
  const contentBytes = Buffer.from(content, 'utf8');
  const objectPath = evidenceObjectPath(paths, node.nodeId);
  const objectDirectory = path.dirname(objectPath);
  ensureNoFollowDirectory(
    paths.base,
    paths.root,
    objectDirectory,
    objectUnsafe,
  );

  let existing = inspectEvidenceObjectFinal(objectPath, contentBytes);
  if (existing === 'exact') {
    reclaimEvidencePublicationAliases(objectPath, contentBytes);
    assertExactEvidenceObjectFinal(objectPath, contentBytes);
    return node.nodeId;
  }
  reclaimEvidencePublicationAliases(objectPath, contentBytes);
  existing = inspectEvidenceObjectFinal(objectPath, contentBytes);
  if (existing === 'exact') {
    reclaimEvidencePublicationAliases(objectPath, contentBytes);
    assertExactEvidenceObjectFinal(objectPath, contentBytes);
    return node.nodeId;
  }

  const publishAlias = evidencePublicationAlias(objectPath);
  let descriptor: number | undefined;
  let publishAliasOwnedStats: fs.Stats | undefined;
  try {
    descriptor = fs.openSync(publishAlias, NO_FOLLOW_CREATE, 0o600);
    fs.fchmodSync(descriptor, 0o600);
    publishAliasOwnedStats = fs.fstatSync(descriptor);
    fs.writeFileSync(descriptor, contentBytes);
    fs.fsyncSync(descriptor);
    const publishAliasStats = fs.fstatSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertExactEvidencePublicationAlias(
      publishAlias,
      publishAliasStats,
      contentBytes,
      1,
    );
    fsyncDirectory(objectDirectory);

    existing = inspectEvidenceObjectFinal(objectPath, contentBytes);
    if (existing === 'absent') {
      try {
        fs.linkSync(publishAlias, objectPath);
      } catch (error) {
        if (!isNodeError(error) || error.code !== 'EEXIST') {
          throw error;
        }
      }
    }
    fsyncDirectory(objectDirectory);
    reclaimEvidencePublicationAliases(objectPath, contentBytes);
    assertExactEvidenceObjectFinal(objectPath, contentBytes);
  } catch (error) {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
    if (publishAliasOwnedStats !== undefined) {
      unlinkOwnedEvidencePublicationAlias(
        publishAlias,
        publishAliasOwnedStats,
        objectDirectory,
      );
    }
    throw error;
  }
  return node.nodeId;
}

export function readEvidenceNode(
  paths: InvestigationRuntimePaths,
  nodeId: string,
): EvidenceNode {
  assertNodeId(nodeId);
  const objectPath = evidenceObjectPath(paths, nodeId);
  assertNoFollowDirectory(
    paths.base,
    paths.root,
    path.dirname(objectPath),
    objectUnsafe,
  );
  const content = readNoFollow(objectPath, objectUnsafe);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw objectInvalid();
  }
  const node = assertStoredEvidenceNode(parsed, objectInvalid);
  if (
    node.nodeId !== nodeId ||
    content !== canonicalEvidenceNodeEnvelope(node)
  ) {
    throw objectInvalid();
  }
  return node;
}
