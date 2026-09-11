/** Dispatches ordinary Git publication and queries the exact remote ref. */
import { spawnSync } from 'node:child_process';
import { canonicalJson } from '../../../foundation/canonical-json/canonical-json.ts';
import {
  digest,
  publishPoststateDigest,
  type PublishRunnerRequest,
  type PublishRunnerQuery,
  type PublishRunnerFactory,
} from '../../../modules/authority/publish-grant.ts';
export const createProductionPublishRunner: PublishRunnerFactory =
  function createProductionPublishRunner() {
    return {
      dispatch(request) {
        const lease = `${request.target.refName}:${request.target.expectedRemoteOid ?? ''}`;
        const refspec = `${request.target.sourceOid}:${request.target.refName}`;
        const result = spawnSync(
          'git',
          [
            'push',
            `--force-with-lease=${lease}`,
            '--porcelain',
            '--',
            request.target.remoteName,
            refspec,
          ],
          {
            cwd: request.repositoryRoot,
            encoding: 'utf8',
            env: request.environment,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        if (result.error) {
          return {
            state: 'not-issued',
            reason: 'Git publish process could not be started.',
          };
        }
        if (result.status !== 0) {
          return {
            state: 'unknown',
            reason:
              'Git publish returned failure after dispatch; remote state must be queried.',
          };
        }
        const observed = queryPublishedRef(request);
        return observed.state === 'absent'
          ? {
              state: 'unknown',
              reason:
                'Git reported success but the exact remote artifact was not observable.',
            }
          : observed;
      },
      query(request) {
        return queryPublishedRef(request);
      },
    };
  };
function queryPublishedRef(request: PublishRunnerRequest): PublishRunnerQuery {
  const result = spawnSync(
    'git',
    [
      'ls-remote',
      '--refs',
      '--',
      request.target.remoteName,
      request.target.refName,
    ],
    {
      cwd: request.repositoryRoot,
      encoding: 'utf8',
      env: request.environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (result.error || result.status !== 0) {
    return {
      state: 'unknown',
      reason: 'Remote ref query failed after publish dispatch.',
    };
  }
  const lines = String(result.stdout).trim().split('\n').filter(Boolean);
  if (lines.length > 1) {
    return { state: 'unknown', reason: 'Remote ref query was ambiguous.' };
  }
  const observedOid = lines.length === 0 ? null : lines[0]!.split(/\s+/)[0];
  if (observedOid === request.target.sourceOid) {
    return {
      state: 'observed',
      observation: {
        externalReceiptId: digest(
          canonicalJson({
            kind: 'git-ls-remote-receipt.v1',
            idempotencyKey: request.idempotencyKey,
            refName: request.target.refName,
            sourceOid: request.target.sourceOid,
          }),
        ),
        artifactDigest: request.artifactDigest,
        prestateDigest: request.prestateDigest,
        poststateDigest: publishPoststateDigest(request.target.sourceOid),
        observedAt: new Date().toISOString(),
      },
    };
  }
  if (observedOid === request.target.expectedRemoteOid) {
    return { state: 'absent' };
  }
  return {
    state: 'unknown',
    reason: 'Remote ref differs from both the exact prestate and artifact.',
  };
}
