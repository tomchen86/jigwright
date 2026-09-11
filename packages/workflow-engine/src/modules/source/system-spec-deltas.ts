/**
 * Groups planning deltas by their canonical colocated specification.
 *
 * Invariants:
 * - Each delta must resolve to a known capability and readable content
 *   before grouped projection.
 */
import { systemSpecCatalog } from './system-spec-catalog.ts';
import type { SystemDescriptionSnapshot } from './spec-ownership.ts';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';

export type SystemSpecDeltaGroup = {
  capability: string;
  baseSpecPath: string;
  before: string;
  deltas: string[];
};

/** Provider-combined text for each canonical colocated specification. */
export type SystemSpecDeltaInput = Readonly<
  Omit<SystemSpecDeltaGroup, 'deltas'> & { delta: string }
>;
export type ReadSystemSpecDeltaInputs = (
  snapshot: SystemDescriptionSnapshot,
  deltaPaths: readonly string[],
  readDelta?: (path: string) => string | undefined,
) => SystemSpecDeltaInput[] | null;

/** The selected provider names the capability; colocated ownership remains an engine rule. */
export type ReadDeltaCapability = (deltaPath: string) => string | undefined;

export function readSystemSpecDeltaGroups(
  readCapability: ReadDeltaCapability,
  snapshot: SystemDescriptionSnapshot,
  deltaPaths: readonly string[],
  readDelta: (path: string) => string | undefined = snapshot.readText,
): SystemSpecDeltaGroup[] | null {
  const catalog = systemSpecCatalog(snapshot);
  if (!catalog.length) return null;
  const grouped = new Map<string, SystemSpecDeltaGroup>();
  for (const deltaPath of [...deltaPaths].sort()) {
    const capability = readCapability(deltaPath);
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
  return [...grouped.values()];
}
