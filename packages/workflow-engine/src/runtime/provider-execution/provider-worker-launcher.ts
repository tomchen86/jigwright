/** Launches the hidden worker through the real detached Node/bootstrap protocol. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import type { ProviderWorkerLauncher } from '../../modules/provider-orchestration/provider-dispatch.ts';

export type ProviderDispatcherHost = {
  spawn(
    executable: string,
    args: string[],
    options: {
      cwd: string;
      detached: true;
      stdio: 'ignore';
      env: NodeJS.ProcessEnv;
    },
  ): { pid?: number; unref(): void };
};

/** Construction binds a host without reading process environment or launching. */
export function createProviderWorkerLauncher(
  host: ProviderDispatcherHost,
): ProviderWorkerLauncher {
  return ({ repositoryRoot, invocationId }) => {
    const child = host.spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        path.join(
          import.meta.dirname,
          '../../../bootstrap/workflow-engine-host.ts',
        ),
        'provider-worker',
        invocationId,
        '--json',
      ],
      {
        cwd: repositoryRoot,
        detached: true,
        stdio: 'ignore',
        env: process.env,
      },
    );
    if (!Number.isSafeInteger(child.pid) || child.pid! < 1) {
      throw workflowError(
        'PROVIDER_WORKER_DISPATCH_FAILED',
        'The lifecycle-owned provider worker could not be dispatched.',
        ExitCode.verification,
      );
    }
    child.unref();
    return child.pid!;
  };
}

export const launchProviderWorker = createProviderWorkerLauncher({ spawn });
