/**
 * Captures and reads immutable requirement Sources and composes development
 * Finding operations.
 *
 * Invariants:
 * - A Source read must match its path identity and exact canonical
 *   serialized bytes.
 */
import { createGovernanceFindingOperations } from "./governance-findings.js";
import { createGovernanceSourceV1, parseGovernanceSourceV1, } from '@jigwright/core/governance-source';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { canonicalJson } from '@jigwright/core/canonical-json';
import { GOVERNANCE_SOURCE_LEDGER_ROOT } from '@jigwright/core/repository-consumer-port';
import fs from 'node:fs';
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { publishCreateOnlyCanonical, readStableGovernanceBytes, } from "./governance-intake-storage.js";
const SOURCE_ID = /^SRC-[0-9a-f]{64}$/;
const SOURCE_FILE_MODE = 0o644;
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
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const keys = Object.keys(value).sort();
    return (keys.length === expected.length &&
        keys.every((key, index) => key === expected[index]));
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
function intakeInvalid(message) {
    return workflowError('GOVERNANCE_INTAKE_INVALID', message, ExitCode.usage);
}
export function createGovernanceFindingServices(findingRef) {
    return createGovernanceFindingOperations({
        findingRef,
        readGovernanceSource,
        intakeInvalid,
        isRecord,
        hasExactKeys,
        sourceReference,
    });
}
const GOVERNANCE_FINDING_DISPOSITION_KIND = 'governance-finding-disposition.v1';
