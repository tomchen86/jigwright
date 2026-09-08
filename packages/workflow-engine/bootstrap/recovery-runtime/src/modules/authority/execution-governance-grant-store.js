/**
 * Reads private grant records and prepares their grant-specific storage directories.
 *
 * Invariants:
 * - Stored grant records remain canonical, current-schema, single-link private files.
 * - Grant directory checks and exact-byte removal retain their existing error semantics.
 */
import fs from 'node:fs';
import path from 'node:path';
import { workflowError, ExitCode } from "../../foundation/errors/errors.js";
import { MAX_DOCUMENT_BYTES, parseDocument, isWorkflowError, } from "./execution-governance-values.js";
import { unsafeGrantStore, validateGrantRecord, canonicalGrantRecord, } from "./execution-governance-grant-contracts.js";
import { isNodeError, fsyncDirectory, } from "./execution-governance-private-files.js";
export function readGrantRecord(filePath) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 ||
        stats.size > MAX_DOCUMENT_BYTES) {
        throw unsafeGrantStore();
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    try {
        const value = parseDocument(raw);
        validateGrantRecord(value);
        if (canonicalGrantRecord(value) !== raw)
            throw unsafeGrantStore();
        return value;
    }
    catch (error) {
        if (isWorkflowError(error) &&
            (error.code === 'EXECUTION_BUDGET_GRANT_STORE_UNSAFE' ||
                error.code === 'UNSUPPORTED_SCHEMA_VERSION')) {
            throw error;
        }
        throw unsafeGrantStore();
    }
}
export function readGrantRecordRequired(filePath) {
    if (fs.lstatSync(filePath, { throwIfNoEntry: false }) === undefined) {
        throw workflowError('EXECUTION_BUDGET_GRANT_NOT_FOUND', 'Execution-budget grant does not exist or is not available.', ExitCode.staleState);
    }
    return readGrantRecord(filePath);
}
export function ensureExecutionBudgetGrantStore(storeRoot) {
    if (typeof storeRoot !== 'string' || storeRoot.length < 1) {
        throw unsafeGrantStore();
    }
    const root = path.resolve(storeRoot);
    ensurePlainDirectory(root, false);
    const grants = path.join(root, 'execution-budget-grants');
    const pending = path.join(root, 'execution-budget-grants-pending-audit');
    const locks = path.join(root, 'execution-budget-locks');
    ensurePlainDirectory(grants, true);
    ensurePlainDirectory(pending, true);
    ensurePlainDirectory(locks, true);
    return { root, grants, pending, locks };
}
function ensurePlainDirectory(directory, create) {
    if (create) {
        try {
            fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
        }
        catch (error) {
            if (!isNodeError(error) || error.code !== 'EEXIST')
                throw error;
        }
    }
    const stats = fs.lstatSync(directory, { throwIfNoEntry: false });
    if (!stats?.isDirectory() || stats.isSymbolicLink())
        throw unsafeGrantStore();
}
export function unlinkExactPrivateFile(filePath, expected) {
    const stats = fs.lstatSync(filePath, { throwIfNoEntry: false });
    if (!stats?.isFile() ||
        stats.isSymbolicLink() ||
        stats.nlink !== 1 ||
        (stats.mode & 0o777) !== 0o600 ||
        fs.readFileSync(filePath, 'utf8') !== expected) {
        throw unsafeGrantStore();
    }
    fs.unlinkSync(filePath);
    fsyncDirectory(path.dirname(filePath));
}
