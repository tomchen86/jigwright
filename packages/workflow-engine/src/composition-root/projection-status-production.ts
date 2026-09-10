/**
 * Inspects all registered projections and reports current, missing and
 * error states.
 *
 * Invariants:
 * - Inspection I/O refuses writes, and a failed projection is reported
 *   individually instead of aborting the inventory.
 */
import fs from 'node:fs';
import path from 'node:path';

import {
  loadWorkflowConfig,
  parseCurrentInvestigationManifest,
} from '../adapters/consumer/repository/work-registry/contracts.ts';
import { projectHandoff } from '../adapters/consumer/repository/handoff/handoff.ts';
import { statusAgentGuidance } from '../modules/adoption/agent-guidance.ts';
import { inspectWorkRegistryProjectionStatus } from '../modules/governance-intake/work-registry.ts';
import {
  projectionDefinitions,
  type ProjectionId,
} from '../modules/projection/engine-projection-registry.ts';
import { investigationManifestProjectionBinding } from '../modules/projection/investigation-design-projection.ts';
import {
  createProjectionService,
  type ProjectionStatus,
} from '../modules/projection/projection-service.ts';
import { repositoryDocumentConfiguration } from '../modules/repository-consumer/repository-consumer-config.ts';
import { inspectRepositorySystemDocuments } from '../runtime/managed-documents/validation/system-documents.ts';
import {
  readLedgerIndex,
  readLedgerEntry,
  ledgerIndexPath,
  ledgerObjectPath,
} from '../runtime/storage-journal/semantic-ledger-store.ts';
import { canonicalJson } from '@jigwright/core/canonical-json';

/** Observational only: never project, repair or recover a repository here. */
export function inspectProjectionStatus(repositoryRoot: string) {
  const read = (target: string) => {
    const absolute = path.isAbsolute(target)
      ? target
      : path.join(repositoryRoot, target);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (stat === undefined) return null;
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error(`Unsafe projection target: ${target}`);
    return fs.readFileSync(absolute, 'utf8');
  };
  const io = {
    read,
    write: () => {
      throw new Error('Projection status cannot write.');
    },
  };
  let registry: ProjectionStatus[] | undefined;
  function inspect(id: ProjectionId): ProjectionStatus[] {
    if (id.startsWith('documents.'))
      return inspectRepositorySystemDocuments(repositoryRoot)
        .service.status()
        .filter((row) => row.id === id);
    if (id === 'semantic.binding-index') {
      const index = readLedgerIndex(repositoryRoot);
      if (
        read(ledgerIndexPath()) === null &&
        Object.keys(index.subjects).length === 0
      )
        return [];
      const entries = Object.entries(index.subjects).map(
        ([subjectId, subject]) => {
          const entry = readLedgerEntry(repositoryRoot, subject.currentEntryId);
          if (entry.subject.subjectId !== subjectId)
            throw new Error(
              'Semantic index subject differs from its canonical object.',
            );
          return entry;
        },
      );
      const outputs = [
        { path: ledgerIndexPath(), content: `${canonicalJson(index)}\n` },
        ...entries.map((entry) => ({
          path: ledgerObjectPath(entry.entryId),
          content: `${canonicalJson(entry)}\n`,
        })),
      ];
      return createProjectionService(
        [
          {
            id,
            targetPaths: outputs.map((output) => output.path),
            source: () => outputs,
          },
        ],
        io,
      ).status();
    }
    if (id.startsWith('registry.')) {
      registry ??= inspectWorkRegistryProjectionStatus(repositoryRoot);
      return registry.filter((row) => row.id === id);
    }
    if (id === 'guidance.agent-section')
      return statusAgentGuidance(repositoryRoot).targets;
    if (id === 'handoff.current-and-next-steps') {
      const target =
        repositoryDocumentConfiguration(repositoryRoot).handoffPath;
      const content = projectHandoff(repositoryRoot);
      return createProjectionService(
        [
          {
            id,
            targetPaths: [target],
            source: () => [{ path: target, content }],
          },
        ],
        io,
      ).status();
    }
    const config = loadWorkflowConfig(repositoryRoot);
    const changeRoot = path.join(repositoryRoot, config.changeRoot);
    if (!fs.existsSync(changeRoot)) return [];
    return fs
      .readdirSync(changeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== 'archive')
      .flatMap((entry) => {
        const artifactPath = path.join(
          changeRoot,
          entry.name,
          'investigation.json',
        );
        if (!fs.existsSync(artifactPath)) return [];
        const { manifest } = parseCurrentInvestigationManifest(
          JSON.parse(read(artifactPath)!),
          entry.name,
          {
            repositoryRoot,
            expectedRepositoryId: config.repositoryName,
            artifactPath,
          },
        );
        if (manifest.applicability.kind !== 'ordinary') return [];
        return createProjectionService(
          [
            investigationManifestProjectionBinding([
              {
                path: path.join(config.changeRoot, entry.name, 'design.md'),
                whyOverlays: manifest.applicability.semanticDelta.whyOverlays,
              },
            ]),
          ],
          io,
        ).status();
      });
  }
  return projectionDefinitions().map((definition) => {
    try {
      const targets = inspect(definition.id).map((row) => ({
        ...row,
        path: path.isAbsolute(row.path)
          ? path.relative(repositoryRoot, row.path).split(path.sep).join('/')
          : row.path,
      }));
      return {
        ...definition,
        state:
          targets.length === 0
            ? 'not-configured'
            : targets.every((row) => row.state === 'current')
              ? 'current'
              : 'attention',
        targets,
      };
    } catch (error) {
      return {
        ...definition,
        state: 'error',
        targets: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
