import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { createGovernanceSourceV1, parseGovernanceSourceV1, } from '@jigwright/core/governance-source';
import { GOVERNANCE_SOURCE_LEDGER_ROOT } from '@jigwright/core/repository-consumer-port';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
const SOURCE_ID = /^SRC-[0-9a-f]{64}$/;
const SOURCE_FILE_MODE = 0o644;
const FINDING_FILE_MODE = 0o600;
export function captureGovernanceSource(repositoryRoot, input) {
    const source = createGovernanceSourceV1(input);
    if (source.supersedes !== null) {
        readGovernanceSource(repositoryRoot, source.supersedes);
    }
    const relativePath = governanceSourceRelativePath(source.id);
    const created = publishCreateOnlyCanonical(path.join(repositoryRoot, ...relativePath.split('/')), source, SOURCE_FILE_MODE, 'GOVERNANCE_SOURCE_COLLISION');
    return { source, relativePath, created };
}
export function readGovernanceSource(repositoryRoot, requestedSourceId) {
    const sourceId = sourceReference(requestedSourceId);
    const relativePath = governanceSourceRelativePath(sourceId);
    const sourcePath = path.join(repositoryRoot, ...relativePath.split('/'));
    const bytes = readStableGovernanceBytes(sourcePath, SOURCE_FILE_MODE, () => intakeInvalid('Governance Source must resolve to one plain record.'));
    let serialized;
    let value;
    try {
        serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        value = JSON.parse(serialized);
    }
    catch {
        throw intakeInvalid('Governance Source is invalid.');
    }
    const source = parseGovernanceSourceV1(value);
    if (source.id !== sourceId || serialized !== `${canonicalJson(source)}\n`) {
        throw intakeInvalid('Governance Source path, identity, or canonical bytes are invalid.');
    }
    return source;
}
export function listGovernanceSources(repositoryRoot) {
    const ledgerRoot = path.join(repositoryRoot, ...GOVERNANCE_SOURCE_LEDGER_ROOT.split('/'));
    let rootStats;
    try {
        rootStats = fs.lstatSync(ledgerRoot, { throwIfNoEntry: false });
    }
    catch {
        throw intakeInvalid('Governance Source ledger root must be a plain directory.');
    }
    if (rootStats === undefined)
        return [];
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw intakeInvalid('Governance Source ledger root must be a plain directory.');
    }
    const sources = [];
    for (const prefix of fs.readdirSync(ledgerRoot, { withFileTypes: true })) {
        const prefixRoot = path.join(ledgerRoot, prefix.name);
        const prefixStats = fs.lstatSync(prefixRoot);
        if (prefix.isSymbolicLink() ||
            !prefix.isDirectory() ||
            prefixStats.isSymbolicLink() ||
            !prefixStats.isDirectory() ||
            !/^[0-9a-f]{2}$/.test(prefix.name)) {
            throw intakeInvalid('Governance Source ledger contains a noncanonical prefix entry.');
        }
        for (const entry of fs.readdirSync(prefixRoot, { withFileTypes: true })) {
            const sourcePath = path.join(prefixRoot, entry.name);
            const sourceStats = fs.lstatSync(sourcePath);
            if (entry.isSymbolicLink() ||
                !entry.isFile() ||
                sourceStats.isSymbolicLink() ||
                !sourceStats.isFile() ||
                !/^[0-9a-f]{64}\.json$/.test(entry.name)) {
                throw intakeInvalid('Governance Source ledger contains a noncanonical record entry.');
            }
            const digest = entry.name.slice(0, -'.json'.length);
            if (prefix.name !== digest.slice(0, 2)) {
                throw intakeInvalid('Governance Source path prefix is invalid.');
            }
            sources.push(readGovernanceSource(repositoryRoot, `SRC-${digest}`));
        }
    }
    return sources.sort((left, right) => left.id.localeCompare(right.id));
}
export function recordGovernanceFinding(context, input, now = () => new Date().toISOString()) {
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
function normalizeFindingInput(input) {
    if (input.schemaVersion !== 1 ||
        typeof input.text !== 'string' ||
        input.text.length === 0 ||
        Buffer.byteLength(input.text, 'utf8') > 8_192 ||
        input.text.includes('\0') ||
        !Array.isArray(input.sourceRefs)) {
        throw intakeInvalid('Governance Finding input is invalid.');
    }
    const sourceRefs = input.sourceRefs.map((sourceRef) => {
        if (typeof sourceRef !== 'string' ||
            !/^SRC-[0-9a-f]{64}$/.test(sourceRef)) {
            throw intakeInvalid('Governance Finding Source reference is invalid.');
        }
        return sourceRef;
    });
    if (new Set(sourceRefs).size !== sourceRefs.length) {
        throw intakeInvalid('Governance Finding Source references are duplicated.');
    }
    sourceRefs.sort();
    return { text: input.text, sourceRefs };
}
function governanceSourceRelativePath(sourceId) {
    const digest = sourceId.slice('SRC-'.length);
    return path.posix.join(GOVERNANCE_SOURCE_LEDGER_ROOT, digest.slice(0, 2), `${digest}.json`);
}
function sourceReference(value) {
    if (!SOURCE_ID.test(value)) {
        throw intakeInvalid('Governance Source reference is invalid.');
    }
    return value;
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
function publishCreateOnlyCanonical(filePath, value, mode, collisionCode) {
    const content = `${canonicalJson(value)}\n`;
    const contentBytes = Buffer.from(content, 'utf8');
    const collision = () => workflowError(collisionCode, 'A different immutable governance record already owns this identity.', ExitCode.conflict);
    fs.mkdirSync(path.dirname(filePath), {
        recursive: true,
        mode: mode === FINDING_FILE_MODE ? 0o700 : 0o755,
    });
    let existing;
    try {
        existing = fs.lstatSync(filePath, { throwIfNoEntry: false });
    }
    catch {
        throw collision();
    }
    if (existing) {
        const observed = readStableGovernanceBytes(filePath, mode, collision);
        if (observed.equals(contentBytes)) {
            return false;
        }
        throw collision();
    }
    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor;
    try {
        descriptor = fs.openSync(temporaryPath, 'wx', mode);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        try {
            fs.linkSync(temporaryPath, filePath);
        }
        catch (error) {
            if (isNodeError(error) &&
                error.code === 'EEXIST' &&
                readStableGovernanceBytes(filePath, mode, collision).equals(contentBytes)) {
                return false;
            }
            throw error;
        }
        fsyncDirectory(path.dirname(filePath));
        return true;
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
        fs.rmSync(temporaryPath, { force: true });
    }
}
function readStableGovernanceBytes(filePath, expectedMode, unsafe) {
    let before;
    try {
        before = fs.lstatSync(filePath, {
            bigint: true,
            throwIfNoEntry: false,
        });
    }
    catch {
        throw unsafe();
    }
    if (before === undefined || !isSafeGovernanceFile(before, expectedMode)) {
        throw unsafe();
    }
    let descriptor;
    try {
        descriptor = fs.openSync(filePath, fs.constants.O_RDONLY |
            (process.platform === 'win32' ? 0 : fs.constants.O_NOFOLLOW));
        const openedBefore = fs.fstatSync(descriptor, { bigint: true });
        if (!isSafeGovernanceFile(openedBefore, expectedMode) ||
            !sameGovernanceFileSnapshot(before, openedBefore)) {
            throw unsafe();
        }
        const bytes = fs.readFileSync(descriptor);
        const openedAfter = fs.fstatSync(descriptor, { bigint: true });
        const after = fs.lstatSync(filePath, {
            bigint: true,
            throwIfNoEntry: false,
        });
        if (after === undefined ||
            !isSafeGovernanceFile(openedAfter, expectedMode) ||
            !isSafeGovernanceFile(after, expectedMode) ||
            BigInt(bytes.byteLength) !== openedBefore.size ||
            !sameGovernanceFileSnapshot(openedBefore, openedAfter) ||
            !sameGovernanceFileSnapshot(openedAfter, after)) {
            throw unsafe();
        }
        return bytes;
    }
    catch {
        throw unsafe();
    }
    finally {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
    }
}
function isSafeGovernanceFile(stats, expectedMode) {
    return (stats.isFile() &&
        !stats.isSymbolicLink() &&
        stats.nlink === 1n &&
        (process.platform === 'win32' ||
            (stats.mode & 511n) === BigInt(expectedMode)) &&
        (typeof process.getuid !== 'function' ||
            stats.uid === BigInt(process.getuid())));
}
function sameGovernanceFileSnapshot(left, right) {
    return (left.dev === right.dev &&
        left.ino === right.ino &&
        left.mode === right.mode &&
        left.nlink === right.nlink &&
        left.uid === right.uid &&
        left.gid === right.gid &&
        left.size === right.size &&
        left.mtimeNs === right.mtimeNs &&
        left.ctimeNs === right.ctimeNs);
}
function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
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
function intakeInvalid(message) {
    return workflowError('GOVERNANCE_INTAKE_INVALID', message, ExitCode.usage);
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
