import { assertHumanResolutionGrantId, humanResolutionGrantNotFound, } from "../../modules/investigation/domain/human-resolution-values.js";
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
export function createHumanResolutionGrantRevoker(authorizeHumanRevocation, openStore) {
    const revokeStoredHumanResolutionGrant = (paths, cwd, requestedGrantId, options) => {
        const grantId = assertHumanResolutionGrantId(requestedGrantId);
        const store = openStore(paths);
        const current = store.inspect(grantId);
        if (current === null)
            throw humanResolutionGrantNotFound(grantId);
        if (current.state === 'consumed') {
            throw workflowError('HUMAN_REVOCATION_STATE_INVALID', 'Consumed human-resolution authority cannot be revoked.', ExitCode.guard);
        }
        if (current.state === 'reserved' && store.hasPreparedJournal(grantId)) {
            throw workflowError('HUMAN_RESOLUTION_RECOVERY_REQUIRED', 'A prepared human-resolution transaction must be recovered instead of revoked.', ExitCode.conflict);
        }
        const binding = store.binding(current.envelopeBytes, grantId);
        const authorization = authorizeHumanRevocation(cwd, binding, options, store.authorizationPath(grantId), current.revocationAuthorization ?? null);
        return store.publish(grantId, authorization);
    };
    return revokeStoredHumanResolutionGrant;
}
