/**
 * Locates, renders, and conditionally updates engine-owned document
 * regions.
 *
 * Invariants:
 * - A document cannot contain duplicate markers for the same projection
 *   region.
 */
import crypto from 'node:crypto';
import { markdownLines } from '@jigwright/core/markdown-sections';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { projectionDefinition, isSemanticProjectionPath, } from "./engine-projection-registry.js";
/** Reuse the exact source slice boundary; callers retain their own locators. */
export function spliceProjectionRegion(current, region, replacement) {
    if (!Number.isInteger(region.start) ||
        !Number.isInteger(region.end) ||
        region.start < 0 ||
        region.end < region.start ||
        region.end > current.length) {
        throw invalid('Invalid projection region offsets.');
    }
    return (current.slice(0, region.start) + replacement + current.slice(region.end));
}
const END = '<!-- /jigwright:region -->';
const START = /^<!-- jigwright:region id=([a-z][a-z0-9.-]*) v=([1-9][0-9]*) digest=(sha256:[a-f0-9]{64}) -->$/;
/** Headings are deliberately outside the region. Fenced examples have no
 * identity, and a deleted opening or closing marker means the region was removed. */
export function locateProjectionRegion(current, id) {
    const lines = markdownLines(current).filter((line) => !line.fenced);
    const starts = lines.filter((line) => START.exec(line.text)?.[1] === id);
    if (starts.length > 1)
        throw invalid(`Duplicate projection region: ${id}.`);
    const start = starts[0];
    if (!start) {
        if (lines.some((line) => line.text.startsWith(`<!-- jigwright:region id=${id} `))) {
            throw invalid(`Malformed projection region marker: ${id}.`);
        }
        return null;
    }
    const following = lines.slice(lines.indexOf(start) + 1);
    const end = following.find((line) => line.text === END);
    if (!end)
        return null;
    if (following.some((line) => line.start < end.start && START.test(line.text))) {
        throw invalid(`Nested projection region: ${id}.`);
    }
    const match = START.exec(start.text);
    return {
        start: start.start,
        end: end.start + END.length,
        version: Number(match[2]),
        digest: match[3],
    };
}
export function renderProjectionRegion(id, version, content) {
    return `<!-- jigwright:region id=${id} v=${version} digest=${digest(content)} -->\n${content}\n${END}`;
}
export function createProjectionService(bindings, io) {
    const byId = new Map();
    for (const binding of bindings) {
        const definition = projectionDefinition(binding.id);
        if (byId.has(binding.id))
            throw invalid(`Duplicate projection binding: ${binding.id}.`);
        if (definition.target.kind === 'user-declared' &&
            definition.placement !== 'region') {
            throw invalid('User-declared projections require region placement.');
        }
        byId.set(binding.id, binding);
    }
    function snapshot(id) {
        const definition = projectionDefinition(id);
        const binding = byId.get(id);
        if (!binding)
            throw invalid(`Projection source is not bound: ${id}.`);
        const outputs = binding.source();
        if (new Set(outputs.map(({ path }) => path)).size !== outputs.length) {
            throw invalid(`Duplicate projection target: ${id}.`);
        }
        if (definition.target.kind === 'engine-path') {
            const approvedPaths = binding.targetPaths ?? [definition.target.path];
            if ((binding.targetPaths !== undefined &&
                !definition.target.configKey &&
                definition.id !== 'semantic.binding-index') ||
                (definition.id === 'semantic.binding-index' &&
                    outputs.some(({ path }) => !isSemanticProjectionPath(path))) ||
                new Set(approvedPaths).size !== approvedPaths.length ||
                outputs.some(({ path }) => !approvedPaths.includes(path)) ||
                (binding.targetPaths !== undefined &&
                    outputs.length !== approvedPaths.length)) {
                throw invalid(`Projection source does not match its approved target paths: ${id}.`);
            }
        }
        const locate = binding.region?.locate ??
            ((text) => locateProjectionRegion(text, id));
        return outputs.map((output) => {
            const current = io.read(output.path);
            const region = definition.placement === 'region' && current !== null
                ? locate(current)
                : null;
            const expected = definition.placement === 'region'
                ? (binding.region?.render(output.content) ??
                    renderProjectionRegion(id, definition.version, output.content))
                : output.content;
            const status = statusFor(definition, output.path, output.content, expected, current, region);
            return { definition, output, current, region, expected, status, locate };
        });
    }
    function apply(changes) {
        const changed = changes.filter((change) => change.changed);
        // Preflight every target and show every diff before replacing any target.
        for (const change of changed)
            io.beforeWrite?.(change);
        for (const change of changed)
            assertUnchanged(change);
        for (const change of changed) {
            assertUnchanged(change);
            io.write(change.path, change.after);
        }
        return changes;
    }
    function assertUnchanged(change) {
        if (io.read(change.path) !== change.before) {
            throw workflowError('PROJECTION_TARGET_CHANGED', `Projection target changed after its diff was prepared: ${change.path}.`, ExitCode.verification);
        }
    }
    return {
        project(id, options = {}) {
            return apply(snapshot(id).map(({ definition, current, region, expected, status, locate }) => {
                let after = current ?? '';
                if (definition.placement === 'whole-file')
                    after = expected;
                else if (region)
                    after = spliceProjectionRegion(after, region, expected);
                else if (options.install) {
                    if (options.heading !== undefined &&
                        !/^#{1,6} [^\r\n]+$/.test(options.heading)) {
                        throw invalid('Projection heading must be one Markdown heading.');
                    }
                    const separator = after.length === 0 ||
                        after.endsWith('\n\n') ||
                        after.endsWith('\r\n\r\n')
                        ? ''
                        : after.endsWith('\n')
                            ? '\n'
                            : '\n\n';
                    after +=
                        separator +
                            (options.heading ? `${options.heading}\n` : '') +
                            expected +
                            '\n';
                }
                const changed = current === null
                    ? definition.placement === 'whole-file' ||
                        options.install === true
                    : after !== current;
                if (changed && definition.placement === 'region') {
                    const candidateRegion = locate(after);
                    if (!candidateRegion ||
                        after.slice(candidateRegion.start, candidateRegion.end) !==
                            expected) {
                        throw invalid(`Projection candidate region is not discoverable and exact: ${id}.`);
                    }
                }
                return {
                    ...status,
                    ...(changed
                        ? {
                            state: 'current',
                            version: definition.version,
                            digest: status.expectedDigest,
                        }
                        : {}),
                    changed,
                    before: current,
                    after,
                };
            }));
        },
        validate(id) {
            return snapshot(id).map(({ status }) => status);
        },
        remove(id) {
            if (projectionDefinition(id).target.kind !== 'user-declared') {
                throw invalid('Removal is only available for user-declared projection regions.');
            }
            return apply(snapshot(id).map(({ current, region, status }) => ({
                ...status,
                state: current === null ? 'missing' : 'removed',
                version: null,
                digest: null,
                changed: region !== null,
                before: current,
                after: region
                    ? spliceProjectionRegion(current, region, '')
                    : (current ?? ''),
            })));
        },
        status() {
            return [...byId.keys()].flatMap((id) => snapshot(id).map(({ status }) => status));
        },
    };
}
function statusFor(definition, path, content, expected, current, region) {
    const exists = current !== null &&
        (definition.placement === 'whole-file' || region !== null);
    const actual = region ? current.slice(region.start, region.end) : current;
    return {
        id: definition.id,
        path,
        state: current === null
            ? 'missing'
            : !exists
                ? 'removed'
                : actual === expected
                    ? 'current'
                    : 'drifted',
        version: exists ? (region?.version ?? definition.version) : null,
        expectedVersion: definition.version,
        digest: exists ? (region?.digest ?? digest(actual)) : null,
        expectedDigest: digest(content),
    };
}
function digest(content) {
    return `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
}
function invalid(message) {
    return workflowError('PROJECTION_INVALID', message, ExitCode.usage);
}
