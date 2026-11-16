/** Interprets OpenSpec delta paths and combines grammar after canonical colocated grouping. */
import {
  combineOpenSpecDeltas,
  type OpenSpecDeltaInput,
} from '@jigwright/openspec-adapter/archive-projection';
import {
  readSystemSpecDeltaGroups,
  type ReadDeltaCapability,
  type ReadSystemSpecDeltaInputs,
} from '../../../../modules/source/system-spec-deltas.ts';

export const readOpenSpecDeltaCapability: ReadDeltaCapability = (deltaPath) =>
  /\/specs\/([a-z0-9]+(?:-[a-z0-9]+)*)\/spec.md$/.exec(deltaPath)?.[1];

export const readSystemSpecDeltaInputs: ReadSystemSpecDeltaInputs = (
  snapshot,
  deltaPaths,
  readDelta = snapshot.readText,
) => {
  const groups = readSystemSpecDeltaGroups(
    readOpenSpecDeltaCapability,
    snapshot,
    deltaPaths,
    readDelta,
  );
  return (
    groups?.map(({ deltas, ...entry }): OpenSpecDeltaInput => ({
      ...entry,
      delta: combineOpenSpecDeltas(deltas),
    })) ?? null
  );
};
