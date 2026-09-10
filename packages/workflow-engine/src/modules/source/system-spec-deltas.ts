/**
 * Groups planning deltas by their canonical colocated specification.
 *
 * Invariants:
 * - Each delta must resolve to a known capability and readable content
 *   before grouped projection.
 */
import {
  combineOpenSpecDeltas,
  type OpenSpecDeltaInput,
} from '@jigwright/openspec-adapter/archive-projection';
import { systemSpecCatalog } from './system-spec-catalog.ts';
import type { SystemDescriptionSnapshot } from './spec-ownership.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export function readSystemSpecDeltaInputs(
  snapshot: SystemDescriptionSnapshot,
  deltaPaths: readonly string[],
  readDelta: (path: string) => string | undefined = snapshot.readText,
): OpenSpecDeltaInput[] | null {
  const catalog = systemSpecCatalog(snapshot);
  if (!catalog.length) return null;
  const grouped = new Map<
    string,
    {
      capability: string;
      baseSpecPath: string;
      before: string;
      deltas: string[];
    }
  >();
  for (const deltaPath of [...deltaPaths].sort()) {
    const capability = /\/specs\/([a-z0-9]+(?:-[a-z0-9]+)*)\/spec.md$/.exec(
      deltaPath,
    )?.[1];
    const spec = catalog.find(
      (entry) => capability && entry.aliases.includes(capability),
    );
    const delta = readDelta(deltaPath);
    if (!spec || delta === undefined)
      throw workflowError(
        'SYSTEM_SPEC_DELTA_UNRESOLVED',
        `Resolve ${deltaPath} to a colocated spec with a matching capability before archive.`,
        ExitCode.verification,
      );
    const group = grouped.get(spec.path) ?? {
      capability: spec.capability,
      baseSpecPath: spec.path,
      before: spec.text,
      deltas: [],
    };
    group.deltas.push(delta);
    grouped.set(spec.path, group);
  }
  return [...grouped.values()].map(({ deltas, ...entry }) => ({
    ...entry,
    delta: combineOpenSpecDeltas(deltas),
  }));
}
