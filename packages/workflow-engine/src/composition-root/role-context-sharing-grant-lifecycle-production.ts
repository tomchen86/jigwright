import type { RoleContextSharingGrantLifecyclePortV1 } from '../modules/authority/role-context-sharing-grant-lifecycle-port.ts';
import {
  consumeOrReadExactRoleContextSharingGrantUnderLifecycleLock,
  readRoleContextSharingRecord,
  reserveOrReadExactRoleContextSharingGrantUnderLifecycleLock,
  roleContextSharingStorePaths,
} from '../runtime/storage-journal/role-context-sharing-store.ts';

export const productionRoleContextSharingGrantLifecyclePort: RoleContextSharingGrantLifecyclePortV1 =
  Object.freeze({
    read: readRoleContextSharingRecord,
    reserveOrReadExactUnderLifecycleLock(
      gitCommonDirectory,
      grantId,
      options,
      assertOwned,
    ) {
      return reserveOrReadExactRoleContextSharingGrantUnderLifecycleLock(
        roleContextSharingStorePaths(gitCommonDirectory),
        grantId,
        options,
        assertOwned,
      );
    },
    consumeOrReadExactUnderLifecycleLock(
      gitCommonDirectory,
      grantId,
      options,
      assertOwned,
    ) {
      return consumeOrReadExactRoleContextSharingGrantUnderLifecycleLock(
        roleContextSharingStorePaths(gitCommonDirectory),
        grantId,
        options,
        assertOwned,
      );
    },
  });
