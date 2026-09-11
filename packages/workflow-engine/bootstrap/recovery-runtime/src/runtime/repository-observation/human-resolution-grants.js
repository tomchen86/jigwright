/** Reads historical Grant policy, exact annotated tags and successor sessions. */
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { parseMaintainerPolicy, } from "../../modules/authority/maintainer-policy.js";
import { canonicalHumanResolutionGrantEnvelope, parseHumanResolutionGrantEnvelope, assertMaintainerGrantId, assertHumanResolutionAuditPayload, humanResolutionGrantInvalid, } from "../../modules/authority/maintainer-grant-contracts.js";
import { runGit } from "../repository-transaction/git.js";
import { readInvestigationSession } from "../storage-journal/investigation-session-records.js";
export const readHumanResolutionAuditTag = (repositoryRoot, policy, observedRef) => {
    const resolutionPrefix = `${policy.auditTagPrefix}resolution-`;
    if (!observedRef.startsWith(resolutionPrefix)) {
        return null;
    }
    try {
        const observedGrantId = observedRef.slice(resolutionPrefix.length);
        assertMaintainerGrantId(observedGrantId);
        const raw = runGit(repositoryRoot, ['cat-file', 'tag', observedRef]);
        const separator = raw.indexOf('\n\n');
        if (separator === -1) {
            throw new Error('missing tag message');
        }
        const headers = raw.slice(0, separator).split('\n');
        const objectHeaders = headers.filter((line) => line.startsWith('object '));
        const typeHeaders = headers.filter((line) => line.startsWith('type '));
        const tagHeaders = headers.filter((line) => line.startsWith('tag '));
        const message = raw.slice(separator + 2);
        const envelope = parseHumanResolutionGrantEnvelope(message);
        const payload = envelope.payload;
        if (payload.grantId !== observedGrantId ||
            objectHeaders.length !== 1 ||
            objectHeaders[0] !== `object ${payload.trustBaseCommit}` ||
            typeHeaders.length !== 1 ||
            typeHeaders[0] !== 'type commit' ||
            tagHeaders.length !== 1 ||
            tagHeaders[0] !== `tag ${observedRef.slice('refs/tags/'.length)}` ||
            canonicalHumanResolutionGrantEnvelope(envelope) !== message ||
            runGit(repositoryRoot, [
                'rev-parse',
                `${observedRef}^{commit}`,
            ]).trim() !== payload.trustBaseCommit) {
            throw new Error('tag binding mismatch');
        }
        const trustBase = loadMaintainerPolicyForResolution(repositoryRoot, payload.trustBaseCommit);
        assertHumanResolutionAuditPayload(payload, policy, trustBase.policy, trustBase.policyBlob);
        return envelope;
    }
    catch {
        throw workflowError('HUMAN_RESOLUTION_AUDIT_TAG_INVALID', `Human-resolution audit tag ${observedRef} is malformed or noncanonical.`, ExitCode.guard);
    }
};
export function assertHumanResolutionAuditTag(repositoryRoot, envelope, policy) {
    const tagRef = `${policy.auditTagPrefix}resolution-${envelope.payload.grantId}`;
    try {
        const observed = readHumanResolutionAuditTag(repositoryRoot, policy, tagRef);
        if (observed === null ||
            canonicalHumanResolutionGrantEnvelope(observed) !==
                canonicalHumanResolutionGrantEnvelope(envelope)) {
            throw new Error('audit mismatch');
        }
    }
    catch {
        throw workflowError('HUMAN_RESOLUTION_AUDIT_TAG_INVALID', 'The exact human-resolution audit tag is missing or different.', ExitCode.guard);
    }
}
export const loadMaintainerPolicyForResolution = (repositoryRoot, trustBaseCommit) => {
    return {
        policy: loadBasePolicy(repositoryRoot, trustBaseCommit),
        policyBlob: runGit(repositoryRoot, [
            'rev-parse',
            `${trustBaseCommit}:workflow/maintainer-policy.json`,
        ]).trim(),
    };
};
function loadBasePolicy(repositoryRoot, baseCommit) {
    try {
        return parseMaintainerPolicy(JSON.parse(runGit(repositoryRoot, [
            'show',
            `${baseCommit}:workflow/maintainer-policy.json`,
        ])));
    }
    catch (error) {
        if (error && typeof error === 'object' && 'code' in error) {
            throw error;
        }
        throw workflowError('MAINTAINER_POLICY_INVALID', 'The base commit does not contain a valid maintainer policy.', ExitCode.guard);
    }
}
export const assertResolutionDecisionTarget = (paths, state, decision) => {
    const successor = decision.kind === 'repair'
        ? decision.parameters.successorInvestigationId
        : decision.kind === 'supersede'
            ? decision.parameters.successorInvestigationId
            : null;
    if (successor === null) {
        return;
    }
    const session = readInvestigationSession(paths, successor);
    if (session.changeId !== state.envelope.changeId ||
        successor === state.envelope.investigationId) {
        throw humanResolutionGrantInvalid('A resolution successor must be a different readable investigation for the same change.');
    }
};
