/** Session-private Finding records and append-only dispositions. Immutable Source resolution is bound by the intake facade. */
import path from 'node:path';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { publishCreateOnlyCanonical, FINDING_FILE_MODE, readStableGovernanceBytes, sameGovernanceFileSnapshot, } from "./governance-intake-storage.js";
import { TextDecoder } from 'node:util';
import fs from 'node:fs';
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import crypto from 'node:crypto';
export function createGovernanceFindingOperations(bindings) {
    const { readGovernanceSource, intakeInvalid, isRecord, hasExactKeys, sourceReference, } = bindings;
    const FINDING_ID = /^FND-[0-9a-f]{64}$/;
    const FINDING_RECORD_NAME = /^(FND-[0-9a-f]{64})\.json$/;
    const FINDING_DISPOSITION_RECORD_NAME = /^(FND-[0-9a-f]{64})\.disposition\.json$/;
    const FINDING_SESSION_DIRECTORY = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,511}$/;
    const FINDING_DIRECTORY_MODE = 0o700;
    const GOVERNANCE_FINDING_DISPOSITION_KIND = 'governance-finding-disposition.v1';
    function recordGovernanceFinding(context, input, now = () => new Date().toISOString()) {
        const normalized = normalizeFindingInput(input);
        for (const sourceRef of normalized.sourceRefs) {
            readGovernanceSource(context.repositoryRoot, sourceRef);
        }
        const payload = {
            schemaVersion: 1,
            createdAt: canonicalTimestamp(now()),
            sessionId: boundedIdentifier(context.sessionId, 'session'),
            changeId: boundedIdentifier(context.changeId, 'change'),
            repositoryRoot: path.resolve(context.repositoryRoot),
            branch: boundedIdentifier(context.branch, 'branch'),
            head: gitOid(context.head),
            tree: gitOid(context.tree),
            text: normalized.text,
            sourceRefs: normalized.sourceRefs,
        };
        const finding = {
            ...payload,
            id: `FND-${digestHex(canonicalJson(payload))}`,
        };
        const directory = path.join(context.runtimeRoot, 'findings', finding.sessionId);
        ensurePrivateFindingDirectory(context.runtimeRoot, directory);
        const findingPath = path.join(directory, `${finding.id}.json`);
        const created = publishCreateOnlyCanonical(findingPath, finding, FINDING_FILE_MODE, 'GOVERNANCE_FINDING_COLLISION');
        return { finding, path: findingPath, created };
    }
    function listGovernanceFindings(runtimeRoot) {
        const store = readGovernanceFindingStore(runtimeRoot);
        const findings = [];
        for (const [findingId, stored] of store.findings) {
            const storedDisposition = store.dispositions.get(findingId) ?? null;
            if (storedDisposition !== null &&
                path.dirname(storedDisposition.path) !== path.dirname(stored.path)) {
                throw intakeInvalid('Governance Finding disposition and Finding paths do not agree.');
            }
            const receipt = storedDisposition?.receipt ?? null;
            if (receipt !== null &&
                Date.parse(receipt.recordedAt) < Date.parse(stored.finding.createdAt)) {
                throw intakeInvalid('Governance Finding disposition predates its immutable Finding.');
            }
            findings.push(toGovernanceFindingReadModel(stored.finding, receipt));
        }
        for (const findingId of store.dispositions.keys()) {
            if (!store.findings.has(findingId)) {
                throw intakeInvalid('Governance Finding disposition has no immutable Finding.');
            }
        }
        return findings.sort((left, right) => left.id.localeCompare(right.id));
    }
    function dismissGovernanceFinding(runtimeRoot, requestedFindingId, reason, now = () => new Date().toISOString()) {
        return recordGovernanceFindingDisposition(runtimeRoot, requestedFindingId, {
            schemaVersion: 1,
            disposition: 'dismissed',
            reason,
            target: null,
        }, now);
    }
    function convertGovernanceFinding(runtimeRoot, requestedFindingId, requestedWorkItemId, now = () => new Date().toISOString()) {
        return recordGovernanceFindingDisposition(runtimeRoot, requestedFindingId, {
            schemaVersion: 1,
            disposition: 'converted',
            reason: 'Converted to one deterministic inbox Work Item.',
            target: {
                kind: 'work-item',
                id: requestedWorkItemId,
            },
        }, now);
    }
    function linkGovernanceFinding(runtimeRoot, requestedFindingId, requestedChangeId, now = () => new Date().toISOString()) {
        return recordGovernanceFindingDisposition(runtimeRoot, requestedFindingId, {
            schemaVersion: 1,
            disposition: 'linked',
            reason: 'Linked to one existing change without widening its task scope.',
            target: {
                kind: 'change',
                id: requestedChangeId,
            },
        }, now);
    }
    function recordGovernanceFindingDisposition(runtimeRoot, requestedFindingId, input, now = () => new Date().toISOString()) {
        const findingId = findingReference(requestedFindingId);
        const normalized = normalizeFindingDispositionInput(input);
        const current = listGovernanceFindings(runtimeRoot).find((finding) => finding.id === findingId);
        if (current === undefined) {
            throw intakeInvalid('Governance Finding does not exist.');
        }
        const dispositionPath = path.join(path.resolve(runtimeRoot), 'findings', current.sessionId, `${findingId}.disposition.json`);
        if (current.disposition !== 'pending') {
            if (current.disposition === normalized.disposition &&
                current.reason === normalized.reason &&
                canonicalJson(current.target) === canonicalJson(normalized.target)) {
                return { finding: current, path: dispositionPath, created: false };
            }
            throw findingDispositionCollision();
        }
        const receipt = {
            schemaVersion: 1,
            kind: GOVERNANCE_FINDING_DISPOSITION_KIND,
            findingId,
            disposition: normalized.disposition,
            reason: normalized.reason,
            target: normalized.target,
            recordedAt: canonicalTimestamp(now()),
        };
        ensurePrivateFindingDirectory(runtimeRoot, path.dirname(dispositionPath));
        const created = publishCreateOnlyCanonical(dispositionPath, receipt, FINDING_FILE_MODE, 'GOVERNANCE_FINDING_DISPOSITION_COLLISION');
        const finding = listGovernanceFindings(runtimeRoot).find((candidate) => candidate.id === findingId);
        if (finding === undefined || finding.disposition === 'pending') {
            throw intakeInvalid('Governance Finding disposition was not published.');
        }
        return { finding, path: dispositionPath, created };
    }
    function readGovernanceFindingStore(runtimeRoot) {
        const findingRoot = path.join(path.resolve(runtimeRoot), 'findings');
        const sessionEntries = readStablePrivateFindingDirectory(findingRoot, true);
        const findings = new Map();
        const dispositions = new Map();
        for (const sessionEntry of sessionEntries) {
            if (sessionEntry.isSymbolicLink() ||
                !sessionEntry.isDirectory() ||
                !FINDING_SESSION_DIRECTORY.test(sessionEntry.name)) {
                throw findingStoreUnsafe();
            }
            const sessionRoot = path.join(findingRoot, sessionEntry.name);
            for (const recordEntry of readStablePrivateFindingDirectory(sessionRoot)) {
                if (recordEntry.isSymbolicLink() || !recordEntry.isFile()) {
                    throw findingStoreUnsafe();
                }
                const dispositionMatch = FINDING_DISPOSITION_RECORD_NAME.exec(recordEntry.name);
                if (dispositionMatch !== null) {
                    const findingId = findingReference(dispositionMatch[1]);
                    if (dispositions.has(findingId)) {
                        throw intakeInvalid('Governance Finding disposition is ambiguous.');
                    }
                    const recordPath = path.join(sessionRoot, recordEntry.name);
                    const receipt = readGovernanceFindingDispositionReceipt(recordPath, findingId);
                    dispositions.set(findingId, { receipt, path: recordPath });
                    continue;
                }
                const findingMatch = FINDING_RECORD_NAME.exec(recordEntry.name);
                if (findingMatch === null)
                    throw findingStoreUnsafe();
                const findingId = findingReference(findingMatch[1]);
                if (findings.has(findingId)) {
                    throw intakeInvalid('Governance Finding identity is ambiguous.');
                }
                const recordPath = path.join(sessionRoot, recordEntry.name);
                const finding = readGovernanceFindingRecord(recordPath, findingId);
                if (finding.sessionId !== sessionEntry.name) {
                    throw intakeInvalid('Governance Finding session and path do not agree.');
                }
                findings.set(findingId, { finding, path: recordPath });
            }
        }
        return { findings, dispositions };
    }
    function readGovernanceFindingRecord(recordPath, expectedFindingId) {
        const bytes = readStableGovernanceBytes(recordPath, FINDING_FILE_MODE, findingStoreUnsafe);
        let serialized;
        let value;
        try {
            serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            value = JSON.parse(serialized);
        }
        catch {
            throw intakeInvalid('Governance Finding is invalid.');
        }
        const finding = parseGovernanceFinding(value);
        if (finding.id !== expectedFindingId ||
            serialized !== `${canonicalJson(finding)}\n`) {
            throw intakeInvalid('Governance Finding path, identity, or canonical bytes are invalid.');
        }
        return finding;
    }
    function readGovernanceFindingDispositionReceipt(recordPath, expectedFindingId) {
        const bytes = readStableGovernanceBytes(recordPath, FINDING_FILE_MODE, findingStoreUnsafe);
        let serialized;
        let value;
        try {
            serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            value = JSON.parse(serialized);
        }
        catch {
            throw intakeInvalid('Governance Finding disposition is invalid.');
        }
        const receipt = parseGovernanceFindingDispositionReceipt(value);
        if (receipt.findingId !== expectedFindingId ||
            serialized !== `${canonicalJson(receipt)}\n`) {
            throw intakeInvalid('Governance Finding disposition path or canonical bytes are invalid.');
        }
        return receipt;
    }
    function parseGovernanceFinding(value) {
        if (!isRecord(value) || !hasExactKeys(value, FINDING_KEYS)) {
            throw intakeInvalid('Governance Finding is invalid.');
        }
        if (typeof value.id !== 'string' ||
            typeof value.createdAt !== 'string' ||
            typeof value.sessionId !== 'string' ||
            typeof value.changeId !== 'string' ||
            typeof value.branch !== 'string' ||
            typeof value.head !== 'string' ||
            typeof value.tree !== 'string') {
            throw intakeInvalid('Governance Finding is invalid.');
        }
        const sourceRefs = findingSourceReferences(value.sourceRefs, true);
        const finding = {
            schemaVersion: value.schemaVersion,
            id: findingReference(value.id),
            createdAt: canonicalTimestamp(value.createdAt),
            sessionId: boundedIdentifier(value.sessionId, 'session'),
            changeId: boundedIdentifier(value.changeId, 'change'),
            repositoryRoot: canonicalRepositoryRoot(value.repositoryRoot),
            branch: boundedIdentifier(value.branch, 'branch'),
            head: gitOid(value.head),
            tree: gitOid(value.tree),
            text: findingText(value.text),
            sourceRefs,
        };
        if (finding.schemaVersion !== 1) {
            throw intakeInvalid('Governance Finding is invalid.');
        }
        const { id: _id, ...payload } = finding;
        if (finding.id !== `FND-${digestHex(canonicalJson(payload))}`) {
            throw intakeInvalid('Governance Finding identity is invalid.');
        }
        return finding;
    }
    function parseGovernanceFindingDispositionReceipt(value) {
        if (!isRecord(value) || !hasExactKeys(value, FINDING_DISPOSITION_KEYS)) {
            throw intakeInvalid('Governance Finding disposition is invalid.');
        }
        if (typeof value.findingId !== 'string' ||
            typeof value.disposition !== 'string' ||
            typeof value.reason !== 'string' ||
            typeof value.recordedAt !== 'string') {
            throw intakeInvalid('Governance Finding disposition is invalid.');
        }
        const normalized = normalizeFindingDispositionInput({
            schemaVersion: value.schemaVersion,
            disposition: value.disposition,
            reason: value.reason,
            target: value.target,
        });
        if (value.kind !== GOVERNANCE_FINDING_DISPOSITION_KIND) {
            throw intakeInvalid('Governance Finding disposition is invalid.');
        }
        return {
            schemaVersion: 1,
            kind: GOVERNANCE_FINDING_DISPOSITION_KIND,
            findingId: findingReference(value.findingId),
            disposition: normalized.disposition,
            reason: normalized.reason,
            target: normalized.target,
            recordedAt: canonicalTimestamp(value.recordedAt),
        };
    }
    function toGovernanceFindingReadModel(finding, receipt) {
        return receipt === null
            ? {
                ...finding,
                disposition: 'pending',
                reason: null,
                target: null,
                disposedAt: null,
            }
            : {
                ...finding,
                disposition: receipt.disposition,
                reason: receipt.reason,
                target: receipt.target,
                disposedAt: receipt.recordedAt,
            };
    }
    function normalizeFindingDispositionInput(input) {
        if (input.schemaVersion !== 1 ||
            !['converted', 'linked', 'dismissed'].includes(input.disposition)) {
            throw intakeInvalid('Governance Finding disposition input is invalid.');
        }
        const reason = findingReason(input.reason);
        const target = findingDispositionTarget(input.target);
        if ((input.disposition === 'dismissed' && target !== null) ||
            (input.disposition === 'converted' && target?.kind !== 'work-item') ||
            (input.disposition === 'linked' && target?.kind !== 'change')) {
            throw intakeInvalid('Governance Finding disposition target is invalid.');
        }
        return {
            schemaVersion: 1,
            disposition: input.disposition,
            reason,
            target,
        };
    }
    function findingDispositionTarget(value) {
        if (value === null)
            return null;
        if (!isRecord(value) || !hasExactKeys(value, ['id', 'kind'])) {
            throw intakeInvalid('Governance Finding disposition target is invalid.');
        }
        if (value.kind === 'work-item' &&
            typeof value.id === 'string' &&
            /^WORK-[0-9A-HJKMNP-TV-Z]{26}$/.test(value.id)) {
            return { kind: 'work-item', id: value.id };
        }
        if (value.kind === 'change' &&
            typeof value.id === 'string' &&
            /^[a-z0-9][a-z0-9-]{0,127}$/.test(value.id)) {
            return { kind: 'change', id: value.id };
        }
        throw intakeInvalid('Governance Finding disposition target is invalid.');
    }
    function readStablePrivateFindingDirectory(directory, allowMissing = false) {
        let before;
        try {
            before = fs.lstatSync(directory, {
                bigint: true,
                throwIfNoEntry: false,
            });
        }
        catch {
            throw findingStoreUnsafe();
        }
        if (before === undefined) {
            if (allowMissing)
                return [];
            throw findingStoreUnsafe();
        }
        if (!isSafeGovernanceDirectory(before))
            throw findingStoreUnsafe();
        try {
            const entries = fs
                .readdirSync(directory, { withFileTypes: true })
                .sort((left, right) => left.name.localeCompare(right.name));
            const after = fs.lstatSync(directory, {
                bigint: true,
                throwIfNoEntry: false,
            });
            if (after === undefined ||
                !isSafeGovernanceDirectory(after) ||
                !sameGovernanceFileSnapshot(before, after)) {
                throw findingStoreUnsafe();
            }
            return entries;
        }
        catch {
            throw findingStoreUnsafe();
        }
    }
    function isSafeGovernanceDirectory(stats) {
        return (stats.isDirectory() &&
            !stats.isSymbolicLink() &&
            (process.platform === 'win32' ||
                (stats.mode & 511n) === BigInt(FINDING_DIRECTORY_MODE)) &&
            (typeof process.getuid !== 'function' ||
                stats.uid === BigInt(process.getuid())));
    }
    function findingReference(value) {
        if (!FINDING_ID.test(value)) {
            throw intakeInvalid('Governance Finding reference is invalid.');
        }
        return value;
    }
    function findingText(value) {
        if (typeof value !== 'string' ||
            value.length === 0 ||
            Buffer.byteLength(value, 'utf8') > 8_192 ||
            value.includes('\0')) {
            throw intakeInvalid('Governance Finding input is invalid.');
        }
        return value;
    }
    function findingReason(value) {
        if (typeof value !== 'string' ||
            value.trim().length === 0 ||
            Buffer.byteLength(value, 'utf8') > 2_000 ||
            value.includes('\0')) {
            throw intakeInvalid('Governance Finding disposition reason is invalid.');
        }
        return value;
    }
    function findingSourceReferences(value, requireCanonicalOrder) {
        if (!Array.isArray(value)) {
            throw intakeInvalid('Governance Finding Source references are invalid.');
        }
        const sourceRefs = value.map((sourceRef) => {
            if (typeof sourceRef !== 'string') {
                throw intakeInvalid('Governance Finding Source reference is invalid.');
            }
            return sourceReference(sourceRef);
        });
        if (new Set(sourceRefs).size !== sourceRefs.length) {
            throw intakeInvalid('Governance Finding Source references are duplicated.');
        }
        const canonical = [...sourceRefs].sort();
        if (requireCanonicalOrder &&
            JSON.stringify(sourceRefs) !== JSON.stringify(canonical)) {
            throw intakeInvalid('Governance Finding Source references are not canonical.');
        }
        return canonical;
    }
    function canonicalRepositoryRoot(value) {
        if (typeof value !== 'string' ||
            !path.isAbsolute(value) ||
            path.resolve(value) !== value) {
            throw intakeInvalid('Governance Finding repository root is invalid.');
        }
        return value;
    }
    const FINDING_KEYS = [
        'branch',
        'changeId',
        'createdAt',
        'head',
        'id',
        'repositoryRoot',
        'schemaVersion',
        'sessionId',
        'sourceRefs',
        'text',
        'tree',
    ];
    const FINDING_DISPOSITION_KEYS = [
        'disposition',
        'findingId',
        'kind',
        'reason',
        'recordedAt',
        'schemaVersion',
        'target',
    ];
    function normalizeFindingInput(input) {
        if (input.schemaVersion !== 1) {
            throw intakeInvalid('Governance Finding input is invalid.');
        }
        return {
            text: findingText(input.text),
            sourceRefs: findingSourceReferences(input.sourceRefs, false),
        };
    }
    function ensurePrivateFindingDirectory(runtimeRoot, targetDirectory) {
        const resolvedRoot = path.resolve(runtimeRoot);
        const resolvedTarget = path.resolve(targetDirectory);
        if (resolvedTarget !== resolvedRoot &&
            !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
            throw intakeInvalid('Governance Finding path escapes its runtime root.');
        }
        fs.mkdirSync(resolvedTarget, { recursive: true, mode: 0o700 });
        let current = resolvedRoot;
        for (const segment of path
            .relative(resolvedRoot, resolvedTarget)
            .split(path.sep)) {
            if (segment.length > 0)
                current = path.join(current, segment);
            const stats = fs.lstatSync(current);
            if (!stats.isDirectory() ||
                stats.isSymbolicLink() ||
                (stats.mode & 0o077) !== 0) {
                throw workflowError('GOVERNANCE_FINDING_STORE_UNSAFE', 'Governance Finding storage must use private plain directories.', ExitCode.unsafeEnvironment);
            }
        }
    }
    function boundedIdentifier(value, kind) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,511}$/.test(value)) {
            throw intakeInvalid(`Governance Finding ${kind} identity is invalid.`);
        }
        return value;
    }
    function gitOid(value) {
        if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) {
            throw intakeInvalid('Governance Finding Git identity is invalid.');
        }
        return value;
    }
    function canonicalTimestamp(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.valueOf()) || date.toISOString() !== value) {
            throw intakeInvalid('Governance Finding timestamp is invalid.');
        }
        return value;
    }
    function digestHex(value) {
        return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
    }
    function findingStoreUnsafe() {
        return workflowError('GOVERNANCE_FINDING_STORE_UNSAFE', 'Governance Finding storage must contain only private canonical records.', ExitCode.unsafeEnvironment);
    }
    function findingDispositionCollision() {
        return workflowError('GOVERNANCE_FINDING_DISPOSITION_COLLISION', 'Governance Finding already has a different terminal disposition.', ExitCode.conflict);
    }
    return {
        recordGovernanceFinding,
        listGovernanceFindings,
        dismissGovernanceFinding,
        convertGovernanceFinding,
        linkGovernanceFinding,
        GOVERNANCE_FINDING_DISPOSITION_KIND,
    };
}
