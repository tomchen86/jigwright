/** Exact private preparation persistence and current-policy observation. */
import fs from 'node:fs';
import path from 'node:path';
import { canonicalHumanRevocationAuthorization, parseHumanRevocationAuthorization, invalidRevocation, revocationConflict, } from "../../modules/authority/human-revocation-contract.js";
import { ensurePlainDirectory } from "../repository-transaction/filesystem-safety.js";
export const persistExactPreparation = (preparationPath, authorization) => {
    if (!path.isAbsolute(preparationPath))
        throw invalidRevocation();
    const parent = path.dirname(preparationPath);
    ensurePlainDirectory(parent);
    fs.chmodSync(parent, 0o700);
    const bytes = canonicalHumanRevocationAuthorization(authorization);
    const existing = readOptionalPreparation(preparationPath);
    if (existing !== null) {
        if (canonicalHumanRevocationAuthorization(existing) !== bytes) {
            throw revocationConflict();
        }
        return;
    }
    let descriptor;
    try {
        descriptor = fs.openSync(preparationPath, fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW, 0o600);
        fs.writeFileSync(descriptor, bytes, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fsyncDirectory(parent);
    }
    catch (error) {
        if (descriptor !== undefined)
            fs.closeSync(descriptor);
        if (isNodeError(error) && error.code === 'EEXIST') {
            const raced = readOptionalPreparation(preparationPath);
            if (raced !== null &&
                canonicalHumanRevocationAuthorization(raced) === bytes) {
                return;
            }
            throw revocationConflict();
        }
        throw error;
    }
};
export const readOptionalPreparation = (preparationPath) => {
    const stats = fs.lstatSync(preparationPath, { throwIfNoEntry: false });
    if (!stats)
        return null;
    if (!stats.isFile() ||
        stats.isSymbolicLink() ||
        (stats.mode & 0o777) !== 0o600) {
        throw invalidRevocation();
    }
    return parseHumanRevocationAuthorization(fs.readFileSync(preparationPath, 'utf8'));
};
function fsyncDirectory(directory) {
    const descriptor = fs.openSync(directory, 'r');
    try {
        fs.fsyncSync(descriptor);
    }
    finally {
        fs.closeSync(descriptor);
    }
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
