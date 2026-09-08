/** Assembles native OpenSpec with repository snapshots and trusted temporary storage. */
import fs from 'node:fs';
import path from 'node:path';
import {
  createOpenSpecAdapter as createNativeOpenSpecAdapter,
  type OpenSpecAdapterOptions,
} from '../adapters/planning/openspec/documents/openspec-adapter.ts';
import type { ColocatedOpenSpecViewDependencies } from '../adapters/planning/openspec/documents/colocated-openspec-view.ts';
import { readSystemDescriptionSnapshot } from '../runtime/repository-transaction/system-description-snapshot.ts';
import { createTrustedExecutionEnvironment } from '../runtime/provider-execution/execution-environment.ts';

export function createColocatedOpenSpecViewDependencies(): ColocatedOpenSpecViewDependencies {
  return {
    readSnapshot: (repositoryRoot) =>
      fs.existsSync(path.join(repositoryRoot, '.git'))
        ? readSystemDescriptionSnapshot(repositoryRoot)
        : undefined,
    temporaryDirectory: () => createTrustedExecutionEnvironment().TMPDIR!,
  };
}

export function createOpenSpecAdapter(
  repositoryRoot: string,
  options: OpenSpecAdapterOptions = {},
) {
  return createNativeOpenSpecAdapter(
    repositoryRoot,
    options,
    createColocatedOpenSpecViewDependencies(),
  );
}
