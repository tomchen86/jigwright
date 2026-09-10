/**
 * Resolves planning capability names and aliases to their colocated
 * canonical contracts.
 *
 * Invariants:
 * - A capability alias cannot name more than one canonical spec.
 */
import path from 'node:path';
import { markdownLines } from '@jigwright/core/markdown-sections';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { systemSpecPaths } from "./system-documents.js";
export function systemSpecCatalog(snapshot) {
    const catalog = systemSpecPaths(snapshot.listPaths()).map((specPath) => {
        const text = snapshot.readText(specPath);
        if (text === undefined)
            throw invalid(`Cannot read canonical spec ${specPath}.`);
        const directory = path.posix.dirname(specPath);
        const capability = directory === '.' ? 'repository' : path.posix.basename(directory);
        const fields = [];
        for (const line of markdownLines(text)) {
            if (line.fenced)
                continue;
            if (/^##\s/.test(line.text))
                break;
            if (line.text.startsWith('capabilities:'))
                fields.push(line.text);
        }
        if (fields.length > 1)
            throw invalid(`Duplicate capabilities metadata in ${specPath}.`);
        const match = fields.length
            ? /^capabilities:\s*\[([^\]]*)\]\s*$/.exec(fields[0])
            : null;
        if (fields.length && !match)
            throw invalid(`Invalid capabilities metadata in ${specPath}.`);
        const aliases = match?.[1]
            ?.split(',')
            .map((entry) => entry.trim().replace(/^(['"])(.*)\1$/, '$2'))
            .filter(Boolean) ?? [];
        if ([capability, ...aliases].some((entry) => !/^[a-z0-9][a-z0-9-]*$/.test(entry)))
            throw invalid(`Invalid capability name in ${specPath}.`);
        return Object.freeze({
            path: specPath,
            capability,
            aliases: Object.freeze([...new Set([capability, ...aliases])]),
            text,
        });
    });
    const pathsByAlias = new Map();
    for (const spec of catalog) {
        for (const alias of spec.aliases) {
            const previous = pathsByAlias.get(alias);
            if (previous && previous !== spec.path)
                throw invalid(`Capability ${alias} is ambiguous between ${previous} and ${spec.path}.`);
            pathsByAlias.set(alias, spec.path);
        }
    }
    return Object.freeze(catalog);
}
export function resolveCanonicalSystemSpec(snapshot, capability) {
    return (systemSpecCatalog(snapshot).find((spec) => spec.aliases.includes(capability))?.path ?? null);
}
export function baseSpecPathForCapability(snapshot, capability) {
    const catalog = systemSpecCatalog(snapshot);
    if (!catalog.length)
        return `openspec/specs/${capability}/spec.md`;
    const spec = catalog.find((entry) => entry.aliases.includes(capability));
    if (!spec)
        throw invalid(`Capability ${capability} has no colocated canonical spec.`);
    return spec.path;
}
export function isBaseSpecificationPath(file) {
    return (/^openspec\/specs\/[^/]+\/spec.md$/.test(file) ||
        systemSpecPaths([file]).length === 1);
}
function invalid(message) {
    return workflowError('SYSTEM_SPEC_CATALOG_INVALID', message, ExitCode.verification);
}
