/**
 * Enumerate and verify bounded physical artifacts for provider retention receipts.
 *
 * Invariants:
 * - Artifact names, byte limits, staging identities, and stable file checks remain exact.
 * - Host-wrapper creation prefixes and completion candidates retain their separate rules.
 */

import fs from 'node:fs';
import path from 'node:path';
import { canonicalJson } from '../../foundation/canonical-json/canonical-json.ts';
import {
  assertPrivateInvestigationDirectory,
  privatePathExists,
} from '../storage-journal/investigation-private-files.ts';
import type { InvestigationRuntimePaths } from '../session-workspace/paths.ts';
import {
  readProviderInvocationRequest,
  readProviderInvocationManifest,
} from '../storage-journal/provider-invocation-store.ts';
import {
  type ProviderRetentionArtifactName,
  providerRetentionStagingDirectory,
  PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS,
  type ProviderRetentionReceipt,
  providerRetentionReviewRootArtifact,
} from '../storage-journal/provider-retention-receipt.ts';
import type { InvocationBinding } from './provider-retention-observation.ts';
import {
  runtimeUnsafe,
  normalizeDigest,
  receiptUnsafe,
  sha256,
} from './provider-retention-values.ts';
import {
  stagingName,
  providerCompletionCandidatePath,
  HOST_WRAPPER_PROBE_DIRECTORY,
  HOST_WRAPPER_TURN_DIRECTORY,
  MAX_HOST_WRAPPER_PROBE_BYTES,
  MAX_HOST_WRAPPER_TURN_REQUEST_BYTES,
  sourcePathForArtifact,
  maxBytesForRetentionArtifact,
  MAX_RAW_ARTIFACT_BYTES,
  readPrivateFile,
} from './provider-retention-files.ts';

const RUNTIME_ARTIFACTS = [
  'runtime/prompt.json',
  'runtime/schema.json',
  'runtime/semantic-output.json',
] as const satisfies readonly ProviderRetentionArtifactName[];

export type PhysicalArtifact = Readonly<{
  receiptName: ProviderRetentionArtifactName;
  physicalName: string;
  sourcePath: string;
  stagingPath: string;
  digest: string;
  bytes: number;
  maxBytes: number;
}>;

export function collectPhysicalArtifacts(
  paths: InvestigationRuntimePaths,
  binding: InvocationBinding,
): PhysicalArtifact[] {
  const invocationId = binding.record.invocationId;
  const request = readProviderInvocationRequest(paths, invocationId);
  const invocationDirectory = path.join(paths.invocations, invocationId);
  const stagingDirectory = providerRetentionStagingDirectory(
    paths,
    invocationId,
  );
  const artifacts: PhysicalArtifact[] = [];
  const runtimeDirectory = path.join(invocationDirectory, 'runtime');
  const runtimeStats = fs.lstatSync(runtimeDirectory, {
    throwIfNoEntry: false,
  });
  if (runtimeStats) {
    assertPrivateInvestigationDirectory(paths, runtimeDirectory, runtimeUnsafe);
    const names = fs.readdirSync(runtimeDirectory).sort();
    if (
      canonicalJson(names) !==
      canonicalJson(RUNTIME_ARTIFACTS.map((name) => path.basename(name)).sort())
    ) {
      throw runtimeUnsafe();
    }
    for (const name of RUNTIME_ARTIFACTS) {
      artifacts.push(
        physicalArtifact(
          name,
          name,
          path.join(invocationDirectory, name),
          path.join(stagingDirectory, stagingName(name)),
        ),
      );
    }
  }

  artifacts.push(
    ...collectHostWrapperPhysicalArtifacts(
      paths,
      invocationDirectory,
      stagingDirectory,
      request.limits.aggregateOutputBytes,
    ),
  );

  const candidatePath = providerCompletionCandidatePath(paths, invocationId);
  const candidateExists = privatePathExists(
    paths,
    candidatePath,
    runtimeUnsafe,
  );
  const rawRuntimeObserved =
    runtimeStats !== undefined ||
    artifacts.some(({ receiptName }) =>
      PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS.includes(
        receiptName as (typeof PROVIDER_RETENTION_HOST_WRAPPER_ARTIFACTS)[number],
      ),
    );
  if (candidateExists && rawRuntimeObserved) {
    if (
      binding.record.state !== 'succeeded' ||
      binding.record.result === null ||
      !binding.state.results.some(
        (result) =>
          result.attemptId === binding.attempt.attemptId &&
          normalizeDigest(binding.record.result!.outputDigest) ===
            result.outputDigest,
      )
    ) {
      throw runtimeUnsafe();
    }
    artifacts.push(
      physicalArtifact(
        'completion-candidate',
        'completion-candidate',
        candidatePath,
        path.join(stagingDirectory, stagingName('completion-candidate')),
      ),
    );
  }
  const manifest = readProviderInvocationManifest(paths, invocationId);
  if (
    manifest.kind === 'plan-review-manifest' &&
    manifest.planningTarget !== undefined
  ) {
    const reviewRoot = path.join(invocationDirectory, 'review-root');
    assertPrivateInvestigationDirectory(paths, reviewRoot, runtimeUnsafe);
    const names = fs.readdirSync(reviewRoot).sort();
    const expected = manifest.planningTarget.artifacts.map(
      ({ snapshotFile }) => snapshotFile,
    );
    if (canonicalJson(names) !== canonicalJson(expected)) {
      throw runtimeUnsafe();
    }
    for (const snapshot of manifest.planningTarget.artifacts) {
      artifacts.push(
        physicalArtifact(
          'review-root',
          `review-root/${snapshot.snapshotFile}`,
          path.join(reviewRoot, snapshot.snapshotFile),
          path.join(stagingDirectory, `review-root-${snapshot.snapshotFile}`),
          { digest: snapshot.sha256, bytes: snapshot.byteLength },
        ),
      );
    }
  }
  return artifacts.sort((left, right) =>
    left.physicalName.localeCompare(right.physicalName),
  );
}

function collectHostWrapperPhysicalArtifacts(
  paths: InvestigationRuntimePaths,
  invocationDirectory: string,
  stagingDirectory: string,
  aggregateOutputBytes: number,
): PhysicalArtifact[] {
  const probeDirectory = path.join(
    invocationDirectory,
    HOST_WRAPPER_PROBE_DIRECTORY,
  );
  const turnDirectory = path.join(
    invocationDirectory,
    HOST_WRAPPER_TURN_DIRECTORY,
  );
  const probeStats = fs.lstatSync(probeDirectory, { throwIfNoEntry: false });
  const turnStats = fs.lstatSync(turnDirectory, { throwIfNoEntry: false });
  if (!probeStats) {
    if (turnStats) throw runtimeUnsafe();
    return [];
  }
  assertPrivateInvestigationDirectory(paths, probeDirectory, runtimeUnsafe);
  const probeNames = fs.readdirSync(probeDirectory).sort();
  if (!isCreationPrefix(probeNames, ['request.json', 'probe-result.json'])) {
    throw runtimeUnsafe();
  }
  if (turnStats) {
    assertPrivateInvestigationDirectory(paths, turnDirectory, runtimeUnsafe);
  }
  const turnNames = turnStats ? fs.readdirSync(turnDirectory).sort() : [];
  if (
    !isCreationPrefix(turnNames, ['request.json', 'semantic-output.json']) ||
    (turnStats && probeNames.length !== 2)
  ) {
    throw runtimeUnsafe();
  }
  const descriptors = [
    ...probeNames.map((name) => ({
      receiptName:
        `${HOST_WRAPPER_PROBE_DIRECTORY}/${name}` as ProviderRetentionArtifactName,
      maxBytes: MAX_HOST_WRAPPER_PROBE_BYTES,
    })),
    ...turnNames.map((name) => ({
      receiptName:
        `${HOST_WRAPPER_TURN_DIRECTORY}/${name}` as ProviderRetentionArtifactName,
      maxBytes:
        name === 'request.json'
          ? MAX_HOST_WRAPPER_TURN_REQUEST_BYTES
          : Math.min(MAX_HOST_WRAPPER_TURN_REQUEST_BYTES, aggregateOutputBytes),
    })),
  ];
  return descriptors.map(({ receiptName, maxBytes }) =>
    physicalArtifact(
      receiptName,
      receiptName,
      path.join(invocationDirectory, receiptName),
      path.join(stagingDirectory, stagingName(receiptName)),
      undefined,
      maxBytes,
    ),
  );
}

function isCreationPrefix(
  observedNames: readonly string[],
  creationOrder: readonly string[],
): boolean {
  return Array.from({ length: creationOrder.length + 1 }, (_, length) =>
    [...creationOrder.slice(0, length)].sort(),
  ).some(
    (allowed) =>
      canonicalJson(allowed) === canonicalJson([...observedNames].sort()),
  );
}

export function physicalArtifactsForReceipt(
  paths: InvestigationRuntimePaths,
  receipt: ProviderRetentionReceipt,
): PhysicalArtifact[] {
  const request = readProviderInvocationRequest(paths, receipt.invocationId);
  const stagingDirectory = providerRetentionStagingDirectory(
    paths,
    receipt.invocationId,
  );
  const artifacts = receipt.artifacts.flatMap(
    (artifact): PhysicalArtifact[] => {
      if (artifact.name !== 'review-root') {
        return [
          {
            receiptName: artifact.name,
            physicalName: artifact.name,
            sourcePath: sourcePathForArtifact(
              paths,
              receipt.invocationId,
              artifact.name,
            ),
            stagingPath: path.join(
              stagingDirectory,
              stagingName(artifact.name),
            ),
            digest: artifact.digest,
            bytes: artifact.bytes,
            maxBytes: maxBytesForRetentionArtifact(
              artifact.name,
              request.limits.aggregateOutputBytes,
            ),
          },
        ];
      }
      const manifest = readProviderInvocationManifest(
        paths,
        receipt.invocationId,
      );
      if (
        manifest.kind !== 'plan-review-manifest' ||
        manifest.planningTarget === undefined
      ) {
        throw receiptUnsafe();
      }
      const leaves = manifest.planningTarget.artifacts.map((snapshot) => ({
        name: `review-root/${snapshot.snapshotFile}`,
        digest: snapshot.sha256,
        bytes: snapshot.byteLength,
      }));
      if (
        canonicalJson(providerRetentionReviewRootArtifact(leaves)) !==
        canonicalJson(artifact)
      ) {
        throw receiptUnsafe();
      }
      return leaves.map((leaf) => ({
        receiptName: 'review-root',
        physicalName: leaf.name,
        sourcePath: path.join(
          paths.invocations,
          receipt.invocationId,
          leaf.name,
        ),
        stagingPath: path.join(
          stagingDirectory,
          `review-root-${path.basename(leaf.name)}`,
        ),
        digest: leaf.digest,
        bytes: leaf.bytes,
        maxBytes: MAX_RAW_ARTIFACT_BYTES,
      }));
    },
  );
  return artifacts.sort((left, right) =>
    left.physicalName.localeCompare(right.physicalName),
  );
}

function physicalArtifact(
  receiptName: ProviderRetentionArtifactName,
  physicalName: string,
  sourcePath: string,
  stagingPath: string,
  expected?: { digest: string; bytes: number },
  maxBytes = MAX_RAW_ARTIFACT_BYTES,
): PhysicalArtifact {
  const content = readPrivateFile(sourcePath, maxBytes);
  const digest = sha256(content);
  if (
    expected !== undefined &&
    (expected.digest !== digest || expected.bytes !== content.byteLength)
  ) {
    throw runtimeUnsafe();
  }
  return {
    receiptName,
    physicalName,
    sourcePath,
    stagingPath,
    digest,
    bytes: content.byteLength,
    maxBytes,
  };
}

export function observeArtifact(
  filePath: string,
  artifact: PhysicalArtifact,
): boolean {
  if (artifact.bytes > artifact.maxBytes) throw runtimeUnsafe();
  const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stats) return false;
  const content = readPrivateFile(filePath, artifact.maxBytes);
  if (
    content.byteLength !== artifact.bytes ||
    sha256(content) !== artifact.digest
  ) {
    throw runtimeUnsafe();
  }
  return true;
}
