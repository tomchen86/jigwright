import {
  invalidMetadata,
  parseChangeMetadataText,
} from '../../modules/planning-provider/change-metadata-policy.ts';
/** Read canonical managed metadata using the current consumer policy. */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type {
  ChangeSchemaName,
  ManagedSchemaName,
} from '../../modules/planning-provider/change-contract.ts';
import {
  canonicalRepositoryRoot,
  logicalGitFileMode,
  repositoryRelativePath,
  sameArtifactIdentity,
} from './contract-artifact-observation.ts';
import { loadRepositoryConsumerConfiguration } from './repository-consumer.ts';

export function readManagedSchemaName(
  repositoryRoot: string,
  metadataPath: string,
): ManagedSchemaName {
  const schemaName = readChangeSchemaName(repositoryRoot, metadataPath);
  const policy =
    loadRepositoryConsumerConfiguration(repositoryRoot).configuration.planning;
  if (!policy.managedSchemaNames.includes(schemaName)) {
    throw workflowError(
      'OPENSPEC_MANAGED_SCHEMA_REQUIRED',
      'Managed changes must declare a reviewed consumer schema.',
      ExitCode.verification,
    );
  }
  return schemaName;
}

export function readChangeSchemaName(
  repositoryRoot: string,
  metadataPath: string,
): ChangeSchemaName {
  const policy =
    loadRepositoryConsumerConfiguration(repositoryRoot).configuration.planning;
  let descriptor: number | undefined;
  let content: Buffer;
  try {
    const repository = canonicalRepositoryRoot(repositoryRoot);
    const absolutePath = path.resolve(metadataPath);
    const artifactRelativePath = repositoryRelativePath(
      repository,
      absolutePath,
    );
    if (!artifactRelativePath) {
      throw new Error('metadata path escapes the repository');
    }
    const before = fs.lstatSync(absolutePath, { bigint: true });
    if (
      !before.isFile() ||
      before.isSymbolicLink() ||
      fs.realpathSync(absolutePath) !==
        path.join(repository.canonicalRoot, artifactRelativePath) ||
      logicalGitFileMode(before.mode) !== '100644'
    ) {
      throw new Error('unsafe metadata');
    }
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameArtifactIdentity(before, opened)) {
      throw new Error('metadata identity changed before reading');
    }
    content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    const pathAfter = fs.lstatSync(absolutePath, { bigint: true });
    if (
      !sameArtifactIdentity(opened, after) ||
      !sameArtifactIdentity(before, pathAfter) ||
      fs.realpathSync(absolutePath) !==
        path.join(repository.canonicalRoot, artifactRelativePath)
    ) {
      throw new Error('metadata identity changed while reading');
    }
  } catch {
    throw unsafeManagedMetadata();
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw invalidMetadata();
  }
  return parseChangeMetadataText(text, policy);
}

function unsafeManagedMetadata() {
  return workflowError(
    'OPENSPEC_CHANGE_TREE_UNSAFE',
    'Managed change metadata must be a canonical non-executable repository file.',
    ExitCode.unsafeEnvironment,
  );
}
