/** Grant record transitions over required canonical record persistence. */
import { canonicalJson } from "../../foundation/canonical-json/canonical-json.js";
import { isRecord } from "../../foundation/canonical-json/contract-values.js";
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { assertGrantChallenge, approvalSubjectDigest, } from "./grant-core.js";
import { freezeGrantCanonical, GRANT_UUID_V4, GRANT_SHA256_DIGEST, parseGrantTimestamp, } from "./grant-primitives.js";
import { assertGrantParentBindingV1, createPreparedGrantDescendantTreeV1, } from "./grant-parent-binding.js";
import { assertGrantRecord, assertExactPreparedGrantParentBinding, assertSubjectForChallenge, assertProofModules, assertProofMethod, assertTransitionOutcome, assertGrantAuditRecord, assertChallengeId, storeSafe, storeUnsafe, challengeUnavailable, grantRecordDigest, } from "./grant-records.js";
export function createGrantRecordStore(persistence) {
    function persistGrantChallenge(candidate) {
        persistence.initialize();
        const challenge = storeSafe(() => assertGrantChallenge(candidate));
        const record = freezeGrantCanonical({
            schemaVersion: 1,
            kind: 'grant-record.v1',
            state: 'pending',
            challenge,
            recordedAt: challenge.issuedAt,
        });
        assertChallengeId(challenge.challengeId);
        const existing = persistence.read(challenge.challengeId);
        if (existing !== null) {
            if (existing.state === 'pending' &&
                canonicalJson(existing) === canonicalJson(record)) {
                return existing;
            }
            throw challengeUnavailable(challenge.challengeId);
        }
        persistence.create(challenge.challengeId, record);
        return record;
    }
    function readGrantRecord(challengeId) {
        assertChallengeId(challengeId);
        persistence.assertAccessible();
        const record = persistence.read(challengeId);
        if (record === null) {
            throw workflowError('GRANT_CHALLENGE_NOT_FOUND', `Grant challenge ${challengeId} was not found.`, ExitCode.staleState);
        }
        if (record.challenge.challengeId !== challengeId)
            throw storeUnsafe();
        return record;
    }
    function listGrantRecords() {
        persistence.assertAccessible();
        return persistence.list();
    }
    function listPreparedGrantRecords() {
        return Object.freeze(listGrantRecords().filter((record) => record.state === 'prepared'));
    }
    function inspectPreparedGrantDescendantTree(candidateRoot) {
        const root = assertGrantRecord(candidateRoot);
        if (root.state !== 'prepared')
            throw storeUnsafe();
        const remaining = new Map(listPreparedGrantRecords()
            .filter(({ challenge }) => challenge.challengeId !== root.challenge.challengeId)
            .map((record) => [record.challenge.challengeId, record]));
        const known = new Map([[root.challenge.challengeId, { record: root, depth: 0 }]]);
        const nodes = [];
        let found = true;
        while (found) {
            found = false;
            for (const [challengeId, record] of [...remaining]) {
                const facts = record.challenge.facts;
                if (!isRecord(facts) || !Object.hasOwn(facts, 'parentGrantBinding')) {
                    continue;
                }
                const binding = assertGrantParentBindingV1(facts.parentGrantBinding);
                const parent = known.get(binding.parentChallengeId);
                if (parent === undefined)
                    continue;
                assertExactPreparedGrantParentBinding(parent.record, binding);
                const node = Object.freeze({
                    schemaVersion: 1,
                    kind: 'prepared-grant-descendant.v1',
                    depth: parent.depth + 1,
                    challengeId,
                    challengeDigest: record.challenge.challengeDigest,
                    operationId: record.operationId,
                    approvalSubjectDigest: approvalSubjectDigest(record.approvalSubject),
                    stateBindingDigest: record.challenge.stateBinding.digest,
                    preparedRecordDigest: grantRecordDigest(record),
                    parentBinding: binding,
                });
                nodes.push(node);
                known.set(challengeId, { record, depth: node.depth });
                remaining.delete(challengeId);
                found = true;
            }
        }
        return createPreparedGrantDescendantTreeV1({
            schemaVersion: 1,
            kind: 'prepared-grant-descendant-tree.v1',
            rootChallengeId: root.challenge.challengeId,
            rootPreparedRecordDigest: grantRecordDigest(root),
            nodes,
        });
    }
    function prepareGrantTransition(input) {
        persistence.initialize();
        const challenge = storeSafe(() => assertGrantChallenge(input.challenge));
        assertChallengeId(challenge.challengeId);
        if (!GRANT_UUID_V4.test(input.operationId))
            throw storeUnsafe();
        const subject = assertSubjectForChallenge(challenge, input.subject);
        const preparedAt = parseGrantTimestamp(input.createdAt);
        if (preparedAt === null ||
            preparedAt.getTime() < new Date(challenge.issuedAt).getTime() ||
            preparedAt.getTime() > new Date(challenge.expiresAt).getTime()) {
            throw storeUnsafe();
        }
        const proofModules = assertProofModules(input.proofModules, subject);
        assertProofMethod(subject, proofModules);
        assertChallengeId(challenge.challengeId);
        const current = readGrantRecord(challenge.challengeId);
        if (current.state !== 'pending' ||
            canonicalJson(current.challenge) !== canonicalJson(challenge)) {
            throw challengeUnavailable(challenge.challengeId);
        }
        const prepared = freezeGrantCanonical({
            ...current,
            state: 'prepared',
            operationId: input.operationId,
            approvalSubject: subject,
            proofModules,
            preparedAt: preparedAt.toISOString(),
        });
        persistence.replace(challenge.challengeId, current, prepared);
        return prepared;
    }
    function recordGrantTransitionOutcome(input) {
        assertChallengeId(input.challengeId);
        if (!GRANT_UUID_V4.test(input.operationId) ||
            !GRANT_SHA256_DIGEST.test(input.poststateDigest)) {
            throw storeUnsafe();
        }
        const outcome = assertTransitionOutcome(input.outcome);
        const completedAt = parseGrantTimestamp(input.completedAt);
        if (completedAt === null)
            throw storeUnsafe();
        const current = readGrantRecord(input.challengeId);
        if (current.state === 'completed' || current.state === 'failed') {
            if (current.operationId === input.operationId &&
                current.poststateDigest === input.poststateDigest &&
                canonicalJson(current.outcome) === canonicalJson(outcome) &&
                current.completedAt === completedAt.toISOString() &&
                canonicalJson(current.audit) === canonicalJson(input.audit)) {
                return current;
            }
            throw challengeUnavailable(input.challengeId);
        }
        if (current.state !== 'prepared' ||
            current.operationId !== input.operationId ||
            completedAt.getTime() < new Date(current.preparedAt).getTime()) {
            throw challengeUnavailable(input.challengeId);
        }
        const audit = assertGrantAuditRecord(input.audit, current);
        const terminal = freezeGrantCanonical({
            ...current,
            state: outcome.outcome,
            poststateDigest: input.poststateDigest,
            outcome,
            completedAt: completedAt.toISOString(),
            audit,
        });
        persistence.replace(input.challengeId, current, terminal);
        return terminal;
    }
    return Object.freeze({
        persistGrantChallenge,
        readGrantRecord,
        listGrantRecords,
        listPreparedGrantRecords,
        inspectPreparedGrantDescendantTree,
        prepareGrantTransition,
        recordGrantTransitionOutcome,
    });
}
