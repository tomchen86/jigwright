import crypto from 'node:crypto';
import { SCAN_HIT_MAX_CONTEXT_BYTES, } from "./investigation-scanner.js";
import { canonicalJson } from "../../../foundation/canonical-json/canonical-json.js";
import { ExitCode, WorkflowError, workflowError, } from "../../../foundation/errors/errors.js";
import { assertMutationClassPolicy, assertPathIdentity, classifyMutationPath, } from "../../source/mutation-class-policy.js";
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const GIT_MODES = new Set(['100644', '100755', '120000', '160000']);
const SCAN_SKIP_REASONS = new Set([
    'symlink',
    'submodule',
    'binary',
    'invalid-utf8',
    'oversize',
    'sensitive-path',
    'sensitive-suppressed',
    'total-budget',
    'unsupported',
]);
const RELATIONSHIP_KINDS = new Set(['generated', 'mirror']);
const HIT_KEYS = [
    'path',
    'sourceObject',
    'surface',
    'byteOffset',
    'byteLength',
];
const HIT_KEYS_WITH_CONTEXT = [...HIT_KEYS, 'contextWindow'];
const CONTEXT_WINDOW_KEYS = [
    'rawBase64',
    'utf8',
    'byteOffset',
    'byteLength',
    'truncated',
];
function hasOnlyKeys(value, keys) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const present = Object.keys(value);
    return (present.length === keys.length && present.every((key) => keys.includes(key)));
}
function assertContextWindow(value, invalid) {
    const window = assertExactKeys(value, [...CONTEXT_WINDOW_KEYS], invalid);
    if (typeof window.rawBase64 !== 'string' ||
        (window.utf8 !== null && typeof window.utf8 !== 'string') ||
        !Number.isSafeInteger(window.byteOffset) ||
        window.byteOffset < 0 ||
        !Number.isSafeInteger(window.byteLength) ||
        window.byteLength <= 0 ||
        window.byteLength > SCAN_HIT_MAX_CONTEXT_BYTES ||
        typeof window.truncated !== 'boolean') {
        throw invalid('Scan hit context window is malformed.');
    }
    return {
        rawBase64: window.rawBase64,
        utf8: window.utf8,
        byteOffset: window.byteOffset,
        byteLength: window.byteLength,
        truncated: window.truncated,
    };
}
/**
 * Derive mechanical Hit and Group facts directly from the current scanner domain
 * result without constructing a generic evidence envelope.
 */
export function deriveInvestigationGroupFacts(input) {
    const { scanFacts } = input;
    if (scanFacts.schemaVersion !== 1 ||
        scanFacts.kind !== 'investigation-scan-facts' ||
        !DIGEST_PATTERN.test(scanFacts.treeDigest) ||
        !DIGEST_PATTERN.test(scanFacts.policyDigest) ||
        scanFacts.inventory.treeDigest !== scanFacts.treeDigest) {
        throw groupsInvalid('Scanner domain facts are malformed.');
    }
    const context = normalizeContext(input.mutationPolicy, input.declaredRoots, input.reviewedRelationships);
    const hitRecords = [];
    const hitKeys = new Set();
    const termIds = new Set();
    for (const termFacts of scanFacts.terms) {
        if (!DIGEST_PATTERN.test(termFacts.term.termId) ||
            termIds.has(termFacts.term.termId)) {
            throw groupsInvalid('Scanner domain term identity is malformed.');
        }
        termIds.add(termFacts.term.termId);
        for (const value of termFacts.hits) {
            const hit = parseHit(value, groupsInvalid);
            const summary = buildInvestigationHitFact(scanFacts.treeDigest, scanFacts.policyDigest, termFacts.term.termId, hit);
            if (hitKeys.has(summary.hitKey)) {
                throw groupsInvalid('Scanner domain facts contain a duplicate hit.');
            }
            hitKeys.add(summary.hitKey);
            hitRecords.push({ hitKey: summary.hitKey, summary });
        }
    }
    const accumulators = new Map();
    for (const record of hitRecords) {
        const baseSelector = baseSelectorFor(record.summary.termId, record.summary, context);
        const selector = {
            termId: baseSelector.termId,
            rootId: baseSelector.rootId,
            extension: baseSelector.extension,
            mutationClass: baseSelector.mutationClass,
            relationshipId: baseSelector.relationshipId,
            splitId: null,
        };
        const key = baseSelector.selectorId;
        let group = accumulators.get(key);
        if (group === undefined) {
            group = { key, selector, members: new Map() };
            accumulators.set(key, group);
        }
        group.members.set(record.hitKey, record);
    }
    const groups = [...accumulators.values()]
        .map((group) => {
        const members = [...group.members.values()].sort((left, right) => left.hitKey < right.hitKey ? -1 : left.hitKey > right.hitKey ? 1 : 0);
        const memberKeys = members.map(({ hitKey }) => hitKey);
        const leafDigest = sha256(canonicalJson({
            schema: 'investigation.mechanical-group.v3',
            key: group.key,
            hitKeys: memberKeys,
        }));
        return {
            key: group.key,
            leafDigest,
            selector: group.selector,
            hitKeys: memberKeys,
            hits: members.map(({ summary }) => summary),
            sourceObjects: dedupeSourceObjects(members.map(({ summary }) => summary.sourceObject)),
        };
    })
        .sort((left, right) => left.leafDigest < right.leafDigest
        ? -1
        : left.leafDigest > right.leafDigest
            ? 1
            : 0);
    return {
        schemaVersion: 1,
        kind: 'investigation-group-facts',
        treeDigest: scanFacts.treeDigest,
        scanPolicyDigest: scanFacts.policyDigest,
        groupingPolicyDigest: context.groupingPolicyDigest,
        hits: hitRecords
            .map(({ summary }) => summary)
            .sort((left, right) => left.hitKey < right.hitKey ? -1 : left.hitKey > right.hitKey ? 1 : 0),
        groups,
    };
}
function normalizeContext(mutationPolicy, declaredRoots, reviewedRelationships) {
    let normalizedMutationPolicy;
    try {
        normalizedMutationPolicy = assertMutationClassPolicy(mutationPolicy);
    }
    catch (error) {
        if (error instanceof WorkflowError) {
            throw groupsInvalid(error.message);
        }
        throw error;
    }
    const seenRootIds = new Set();
    const seenRootPaths = new Set();
    const roots = [...declaredRoots].sort((left, right) => left.rootId < right.rootId ? -1 : left.rootId > right.rootId ? 1 : 0);
    for (const root of roots) {
        const record = assertExactKeys(root, ['rootId', 'path'], groupsInvalid);
        if (typeof record.rootId !== 'string' ||
            record.rootId.length === 0 ||
            typeof record.path !== 'string') {
            throw groupsInvalid('Declared root is malformed.');
        }
        if (seenRootIds.has(record.rootId)) {
            throw groupsInvalid(`Duplicate declared root ID: ${record.rootId}`);
        }
        if (seenRootPaths.has(record.path)) {
            throw groupsInvalid(`Ambiguous declared root path: ${record.path}`);
        }
        seenRootIds.add(record.rootId);
        seenRootPaths.add(record.path);
    }
    const relationships = [...reviewedRelationships].sort((left, right) => left.relationshipId < right.relationshipId
        ? -1
        : left.relationshipId > right.relationshipId
            ? 1
            : 0);
    const seenRelationshipIds = new Set();
    const counterpartOf = new Map();
    const subjectOf = new Map();
    for (const relationship of relationships) {
        const record = assertExactKeys(relationship, ['relationshipId', 'kind', 'subjectPath', 'counterpartPath', 'reference'], groupsInvalid);
        if (typeof record.relationshipId !== 'string' ||
            record.relationshipId.length === 0 ||
            typeof record.kind !== 'string' ||
            !RELATIONSHIP_KINDS.has(record.kind) ||
            typeof record.reference !== 'string' ||
            record.reference.trim().length === 0) {
            throw groupsInvalid('Reviewed relationship is malformed.');
        }
        assertPathIdentity(record.subjectPath, groupsInvalid);
        assertPathIdentity(record.counterpartPath, groupsInvalid);
        if (seenRelationshipIds.has(record.relationshipId)) {
            throw groupsInvalid(`Duplicate relationship ID: ${record.relationshipId}`);
        }
        seenRelationshipIds.add(record.relationshipId);
        const counterpartKey = relationship.counterpartPath.rawBase64;
        if (counterpartOf.has(counterpartKey)) {
            throw groupsInvalid('Ambiguous reviewed relationship: counterpart claimed twice.');
        }
        counterpartOf.set(counterpartKey, relationship.relationshipId);
        const subjectKey = relationship.subjectPath.rawBase64;
        const existing = subjectOf.get(subjectKey) ?? [];
        existing.push(relationship.relationshipId);
        subjectOf.set(subjectKey, existing);
    }
    for (const subjectKey of subjectOf.keys()) {
        if (counterpartOf.has(subjectKey)) {
            throw groupsInvalid('Ambiguous relationship chain: a path is both subject and counterpart.');
        }
    }
    const groupingPolicyDigest = sha256(canonicalJson({
        schema: 'investigation.grouping-policy.v1',
        mutationPolicyDigest: normalizedMutationPolicy.policyDigest,
        roots: roots.map((root) => ({ rootId: root.rootId, path: root.path })),
        relationships: relationships.map((relationship) => ({
            relationshipId: relationship.relationshipId,
            kind: relationship.kind,
            reference: relationship.reference,
            subjectPath: {
                rawBase64: relationship.subjectPath.rawBase64,
                utf8: relationship.subjectPath.utf8,
            },
            counterpartPath: {
                rawBase64: relationship.counterpartPath.rawBase64,
                utf8: relationship.counterpartPath.utf8,
            },
        })),
    }));
    return {
        mutationPolicy: normalizedMutationPolicy,
        roots,
        counterpartOf,
        subjectOf,
        groupingPolicyDigest,
    };
}
function baseSelectorFor(termId, hit, context) {
    const rootId = nearestRoot(hit.path.utf8, context.roots);
    const extension = rawExtension(hit.path);
    const { mutationClass } = classifyMutationPath(context.mutationPolicy, {
        rawBase64: hit.path.rawBase64,
        utf8: hit.path.utf8,
    });
    const relationshipId = relationshipFor(hit.path.rawBase64, context);
    const fields = {
        termId,
        rootId,
        extension,
        mutationClass,
        relationshipId,
        splitId: null,
    };
    return { selectorId: selectorId(fields), ...fields };
}
function relationshipFor(rawBase64, context) {
    const counterpart = context.counterpartOf.get(rawBase64);
    if (counterpart !== undefined) {
        return `counterpart:${sha256(canonicalJson([counterpart]))}`;
    }
    const subject = context.subjectOf.get(rawBase64);
    if (subject !== undefined) {
        // A structured canonical digest of the exact sorted relationship-ID set keeps
        // two distinct sets from colliding on a lossy delimiter join.
        return `source:${sha256(canonicalJson([...subject].sort()))}`;
    }
    return null;
}
function buildInvestigationHitFact(treeDigest, scanPolicyDigest, termId, hit) {
    const fields = {
        termId,
        path: hit.path,
        sourceObject: hit.sourceObject,
        surface: hit.surface,
        byteOffset: hit.byteOffset,
        byteLength: hit.byteLength,
    };
    const hitKey = sha256(canonicalJson({
        schema: 'investigation.hit-fact.v3',
        treeDigest,
        scanPolicyDigest,
        ...fields,
    }));
    return { hitKey, ...fields };
}
function dedupeSourceObjects(sourceObjects) {
    const byId = new Map();
    for (const sourceObject of sourceObjects) {
        const existing = byId.get(sourceObject.objectId);
        if (existing !== undefined &&
            canonicalJson(existing) !== canonicalJson(sourceObject)) {
            throw groupsInvalid('One Git object ID carries conflicting source-object metadata.');
        }
        if (existing === undefined) {
            byId.set(sourceObject.objectId, sourceObject);
        }
    }
    return [...byId.values()].sort((left, right) => left.objectId < right.objectId
        ? -1
        : left.objectId > right.objectId
            ? 1
            : 0);
}
function parseHit(value, invalid) {
    // Context windows are optional scan facts, so both exact key sets are valid.
    const hit = hasOnlyKeys(value, HIT_KEYS_WITH_CONTEXT)
        ? assertExactKeys(value, [...HIT_KEYS_WITH_CONTEXT], invalid)
        : assertExactKeys(value, [...HIT_KEYS], invalid);
    const path = assertFilePathIdentity(hit.path, invalid);
    const sourceObject = assertSourceObject(hit.sourceObject, invalid);
    if ((hit.surface !== 'path' && hit.surface !== 'content') ||
        !Number.isSafeInteger(hit.byteOffset) ||
        hit.byteOffset < 0 ||
        !Number.isSafeInteger(hit.byteLength) ||
        hit.byteLength <= 0 ||
        (hit.surface === 'content' && sourceObject.skipReason !== null)) {
        throw invalid('Scan hit fields are malformed.');
    }
    return {
        path,
        sourceObject,
        surface: hit.surface,
        byteOffset: hit.byteOffset,
        byteLength: hit.byteLength,
        ...(hit.contextWindow === undefined
            ? {}
            : { contextWindow: assertContextWindow(hit.contextWindow, invalid) }),
    };
}
function assertSourceObject(value, invalid) {
    const record = assertExactKeys(value, [
        'objectId',
        'objectType',
        'mode',
        'byteSize',
        'contentSha256',
        'skipReason',
    ], invalid);
    if (typeof record.objectId !== 'string' ||
        !GIT_OBJECT_ID_PATTERN.test(record.objectId) ||
        typeof record.objectType !== 'string' ||
        record.objectType.length === 0 ||
        typeof record.mode !== 'string' ||
        !GIT_MODES.has(record.mode) ||
        (record.byteSize !== null &&
            (typeof record.byteSize !== 'number' ||
                !Number.isSafeInteger(record.byteSize) ||
                record.byteSize < 0)) ||
        (record.contentSha256 !== null &&
            (typeof record.contentSha256 !== 'string' ||
                !DIGEST_PATTERN.test(record.contentSha256))) ||
        (record.skipReason !== null &&
            (typeof record.skipReason !== 'string' ||
                !SCAN_SKIP_REASONS.has(record.skipReason))) ||
        (record.skipReason === null && record.contentSha256 === null) ||
        (record.skipReason !== null && record.contentSha256 !== null)) {
        throw invalid('Source object is malformed.');
    }
    return {
        objectId: record.objectId,
        objectType: record.objectType,
        mode: record.mode,
        byteSize: record.byteSize,
        contentSha256: record.contentSha256,
        skipReason: record.skipReason,
    };
}
function assertFilePathIdentity(value, invalid) {
    const record = assertExactKeys(value, ['rawBase64', 'utf8'], invalid);
    const identity = assertPathIdentity(record, invalid);
    if (identity.raw.includes(0x00) ||
        identity.raw[0] === 0x2f ||
        identity.raw.at(-1) === 0x2f) {
        throw invalid('Path identity is malformed.');
    }
    return {
        rawBase64: identity.raw.toString('base64'),
        utf8: identity.utf8,
    };
}
function nearestRoot(utf8Path, roots) {
    let bestRootId = null;
    let bestLength = -1;
    for (const root of roots) {
        const matches = root.path === '' ||
            (utf8Path !== null &&
                (utf8Path === root.path || utf8Path.startsWith(`${root.path}/`)));
        if (matches && root.path.length > bestLength) {
            bestLength = root.path.length;
            bestRootId = root.rootId;
        }
    }
    if (bestRootId === null) {
        throw groupsInvalid('No declared root contains the hit path.');
    }
    return bestRootId;
}
function rawExtension(path) {
    const raw = Buffer.from(path.rawBase64, 'base64');
    const lastSlash = raw.lastIndexOf(0x2f);
    const basename = raw.subarray(lastSlash + 1);
    const lastDot = basename.lastIndexOf(0x2e);
    const extBytes = lastDot > 0 ? basename.subarray(lastDot) : Buffer.alloc(0);
    let utf8;
    try {
        utf8 = new TextDecoder('utf-8', { fatal: true }).decode(extBytes);
    }
    catch {
        utf8 = null;
    }
    return { rawBase64: extBytes.toString('base64'), utf8 };
}
function selectorId(fields) {
    return sha256(canonicalJson({ schema: 'investigation.selector.v1', ...fields }));
}
function assertExactKeys(output, keys, invalid) {
    if (typeof output !== 'object' || output === null || Array.isArray(output)) {
        throw invalid('Evidence node output is malformed.');
    }
    const record = output;
    const own = Object.keys(record);
    if (own.length !== keys.length ||
        !keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))) {
        throw invalid('Investigation grouping input keys are unexpected.');
    }
    return record;
}
function sha256(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}
function groupsInvalid(message = 'Investigation grouping input is malformed.') {
    return workflowError('INVESTIGATION_GROUPS_INVALID', message, ExitCode.usage);
}
/**
 * Rejoins each group's hits with the context windows their scans recorded.
 *
 * A mechanical group fact summarises its hits without their windows, so it
 * cannot answer whether a class predicate describes what
 * the search actually found. The scans still hold that text, and the join is
 * exact: a hit is the same hit when its term, path, and byte range agree.
 *
 * This is the only bridge between what the engine grouped and what a class may
 * claim, which is why it recomputes rather than trusting anything an author
 * sends. A hit whose scan carried no window arrives with a null window and can
 * therefore satisfy no predicate: silence is not evidence of a match.
 */
export function deriveClassGroupsWithContextFromFacts(input) {
    if (input.scanFacts.treeDigest !== input.groupFacts.treeDigest ||
        input.scanFacts.policyDigest !== input.groupFacts.scanPolicyDigest) {
        throw groupsInvalid('Class grouping facts do not bind the current scanner replay.');
    }
    const windows = new Map();
    for (const term of input.scanFacts.terms) {
        for (const hit of term.hits) {
            windows.set(scanHitJoinKey(term.term.termId, hit.path.rawBase64, hit.byteOffset, hit.byteLength), hit.contextWindow ?? null);
        }
    }
    return input.groupFacts.groups.map((group) => Object.freeze({
        groupId: group.key,
        termId: group.selector.termId,
        hits: Object.freeze(group.hits.map((hit) => Object.freeze({
            path: hit.path.utf8 ?? `base64:${hit.path.rawBase64}`,
            surface: hit.surface,
            window: windows.get(scanHitJoinKey(hit.termId, hit.path.rawBase64, hit.byteOffset, hit.byteLength)) ?? null,
            matchOffset: hit.byteOffset,
            matchLength: hit.byteLength,
        }))),
    }));
}
function scanHitJoinKey(termId, rawBase64, byteOffset, byteLength) {
    return `${termId} ${rawBase64} ${byteOffset} ${byteLength}`;
}
