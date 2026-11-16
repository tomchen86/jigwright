/** Live task strategy evidence observations; reads are fresh at each invocation. */
import { investigationRuntimePaths } from '@jigwright/repository-runtime/paths';
import { previewExactStaging } from '../repository-transaction/git-transitions.ts';
import { runGit } from '../repository-transaction/git.ts';
import { readTaskStrategyTransaction } from '../storage-journal/task-strategy-store.ts';
import {
  readTaskStrategyPatchCurrentBinding,
  readTaskStrategyPatchRecord,
  readTaskStrategyPatchImportReceipt,
  readTaskStrategyPatchReservation,
} from '../storage-journal/task-strategy-patch-store.ts';
import { readTaskStrategyGreenFailureRecord } from '../storage-journal/task-strategy-correction-store.ts';
import {
  readTaskStrategyImplementationResultBinding,
  readTaskStrategyCallerImplementationBinding,
} from '../storage-journal/task-strategy-provider-store.ts';
import {
  parseTaskStrategyFrozenFile,
  type TaskStrategyGateObservations,
} from '../../modules/assurance/task-strategy-gate.ts';
export function createTaskStrategyGateObservations(
  repositoryRoot: string,
  gitCommonDirectory: string,
  runtimeDirectory: string,
  sessionId: string,
): TaskStrategyGateObservations {
  const runtime = investigationRuntimePaths(
    gitCommonDirectory,
    runtimeDirectory,
  );
  return {
    readTransaction: () => readTaskStrategyTransaction(runtime, sessionId),
    previewTree: (baselineHead, changedPaths) =>
      previewExactStaging(repositoryRoot, baselineHead, [...changedPaths]),
    readFrozenFiles: (tree, paths) =>
      paths.map((candidatePath) => {
        const output = runGit(repositoryRoot, [
          'ls-tree',
          '-z',
          tree,
          '--',
          `:(literal)${candidatePath}`,
        ]);
        return parseTaskStrategyFrozenFile(candidatePath, output);
      }),
    readPatchEvidence(sourceTree, patchDigest) {
      const binding = readTaskStrategyPatchCurrentBinding(
        runtime,
        sessionId,
        sourceTree,
      );
      const record = readTaskStrategyPatchRecord(
        runtime,
        sessionId,
        patchDigest,
        sourceTree,
      );
      const receipt = readTaskStrategyPatchImportReceipt(
        runtime,
        sessionId,
        patchDigest,
        sourceTree,
      );
      const reservation = readTaskStrategyPatchReservation(
        runtime,
        sessionId,
        sourceTree,
      );
      return { binding, record, receipt, reservation };
    },
    readCorrectionFailure: (sourceTree) =>
      readTaskStrategyGreenFailureRecord(runtime, sessionId, sourceTree),
    readImplementationAuthority(subjectDigest) {
      const implementationResult = readTaskStrategyImplementationResultBinding(
        runtime,
        sessionId,
        subjectDigest,
      );
      const callerImplementationResult =
        readTaskStrategyCallerImplementationBinding(
          runtime,
          sessionId,
          subjectDigest,
        );
      return { implementationResult, callerImplementationResult };
    },
  };
}
