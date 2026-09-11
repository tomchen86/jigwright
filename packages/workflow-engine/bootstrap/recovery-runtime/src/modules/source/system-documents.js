/**
 * Joins colocated contracts to Source wording, file invariants and observed tests.
 *
 * Invariants:
 * - All content comes from the same caller-supplied repository snapshot.
 * - An existing test file is never evidence that its named scenario passed.
 */
import path from 'node:path';
import { parseGovernanceSourceV1, } from '@jigwright/core/governance-source';
import { normalizeExactRepositoryPath } from '@jigwright/core/repository-path';
import { extractFileHeader } from "./file-header.js";
import { findContainingSpec, parseSystemSpec, } from "./spec-ownership.js";
export function readSystemSource(snapshot, ref) {
    if (!/^SRC-[0-9a-f]{64}$/.test(ref))
        throw new Error('Invalid Source reference.');
    const digest = ref.slice(4);
    const raw = snapshot.readText(`workflow/source-ledger/objects/sha256/${digest.slice(0, 2)}/${digest}.json`);
    const source = parseGovernanceSourceV1(JSON.parse(raw ?? 'null'));
    if (source.id !== ref)
        throw new Error('Source identity mismatch.');
    return source;
}
export function systemSpecPaths(paths) {
    return paths
        .filter((candidate) => {
        const parts = candidate.split('/');
        return (parts.at(-1) === 'spec.md' &&
            (parts.length === 1 || ['packages', 'src'].includes(parts[0])) &&
            !parts.some((part) => [
                'node_modules',
                'test',
                'tests',
                'fixtures',
                'dist',
                'coverage',
                'recovery-runtime',
            ].includes(part)));
    })
        .sort();
}
export function resolveSystemReference(snapshot, specPath, reference) {
    const hash = reference.indexOf('#');
    if (hash < 0 || hash === reference.length - 1)
        return null;
    const file = reference.slice(0, hash);
    if (path.posix.isAbsolute(file) || file.includes('\\'))
        return null;
    let direct;
    try {
        direct = normalizeExactRepositoryPath(file);
    }
    catch {
        /* spec-relative paths resolve below */
    }
    const candidate = file === ''
        ? specPath
        : direct && snapshot.readText(direct) !== undefined
            ? direct
            : path.posix.join(path.posix.dirname(specPath), file);
    try {
        return {
            path: normalizeExactRepositoryPath(candidate),
            name: reference.slice(hash + 1),
        };
    }
    catch {
        return null;
    }
}
export function inspectSystemDocuments(snapshot, readTestOutcome = () => 'missing') {
    const paths = snapshot.listPaths();
    const specPaths = systemSpecPaths(paths);
    const report = {
        specs: [],
        sources: new Map(),
        scenarios: [],
        issues: [],
        modules: [],
    };
    const issue = (code, file, message) => report.issues.push({ code, path: file, message });
    for (const specPath of specPaths) {
        let spec;
        try {
            spec = parseSystemSpec(specPath, snapshot.readText(specPath) ?? '');
        }
        catch (error) {
            issue('spec-invalid', specPath, String(error));
            continue;
        }
        report.specs.push(spec);
        if (!spec.purpose || /\bTBD\b/i.test(spec.purpose))
            issue('purpose-missing', specPath, 'Replace the missing or TBD Purpose with the contract purpose.');
        if (spec.requirements.length === 0)
            issue('requirements-missing', specPath, 'Declare at least one cross-file requirement.');
        const titles = new Set();
        for (const requirement of spec.requirements) {
            if (titles.has(requirement.title))
                issue('requirement-duplicate', specPath, `Duplicate requirement: ${requirement.title}.`);
            titles.add(requirement.title);
            if (requirement.scenarios.length === 0)
                issue('scenarios-missing', specPath, `Bind at least one scenario to ${requirement.title}.`);
            if (requirement.sources.length === 0)
                issue('sources-missing', specPath, `Cite Source wording for ${requirement.title}.`);
            for (const ref of [
                ...requirement.sources,
                ...requirement.scenarios.flatMap((scenario) => scenario.sources),
            ]) {
                if (report.sources.has(ref))
                    continue;
                try {
                    report.sources.set(ref, readSystemSource(snapshot, ref));
                }
                catch {
                    issue('source-missing', specPath, `Resolve the cited Source for ${requirement.title}: ${ref}.`);
                }
            }
            for (const scenario of requirement.scenarios) {
                const cover = scenario.covers === null
                    ? null
                    : resolveSystemReference(snapshot, specPath, scenario.covers);
                const invariant = cover && /^Invariants\[([1-9][0-9]*)\]$/.exec(cover.name);
                const validCover = cover &&
                    (invariant
                        ? extractFileHeader(snapshot.readText(cover.path) ?? '')
                            ?.invariants[Number(invariant[1]) - 1] !== undefined
                        : cover.path === specPath &&
                            cover.name.startsWith('Requirement: ') &&
                            spec.requirements.some((entry) => entry.title === cover.name.slice(13)));
                if (!validCover)
                    issue('covers-invalid', specPath, `${scenario.title} must cover an existing file invariant or requirement in this spec.`);
                const binding = scenario.test === null
                    ? null
                    : resolveSystemReference(snapshot, specPath, scenario.test);
                let outcome = 'missing';
                if (binding === null)
                    issue('test-missing', specPath, `Bind ${scenario.title} to <test path>#<exact test name>.`);
                else if (snapshot.readText(binding.path) === undefined)
                    issue('test-path-missing', specPath, `${scenario.title}: test file ${binding.path} is missing.`);
                else {
                    outcome = readTestOutcome(binding.path, binding.name);
                    if (outcome !== 'passed')
                        issue('test-not-passed', specPath, `${scenario.title}: ${binding.path}#${binding.name} is ${outcome}; run its registered check and validate again.`);
                }
                report.scenarios.push({
                    specPath,
                    requirement: requirement.title,
                    scenario: scenario.title,
                    covers: scenario.covers,
                    testPath: binding?.path ?? null,
                    testName: binding?.name ?? null,
                    outcome,
                });
            }
        }
    }
    // Include uncited records: following spec references alone hides precisely
    // the original wording that the coverage view needs to report as unlinked.
    for (const file of [...paths].sort()) {
        const object = /^workflow\/source-ledger\/objects\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})\.json$/.exec(file);
        if (!object || object[1] !== object[2].slice(0, 2))
            continue;
        const ref = `SRC-${object[2]}`;
        if (report.sources.has(ref))
            continue;
        try {
            report.sources.set(ref, readSystemSource(snapshot, ref));
        }
        catch {
            issue('source-missing', file, 'Resolve the recorded Source wording.');
        }
    }
    const modules = new Set();
    const directories = new Set();
    const sourceFiles = [];
    const packages = new Set();
    for (const file of paths) {
        if (!/\.[cm]?[jt]sx?$/.test(file))
            continue;
        if (/(?:^|\/)(?:node_modules|test|tests|fixtures|dist|coverage|recovery-runtime)\//.test(file))
            continue;
        sourceFiles.push(file);
        const packagePath = /^(packages\/[^/]+)\/src\//.exec(file)?.[1];
        if (packagePath)
            packages.add(packagePath);
        directories.add(path.posix.dirname(file));
        const module = /^(.*(?:^|\/)modules\/[^/]+)\//.exec(file)?.[1];
        if (module)
            modules.add(module);
    }
    report.modules = [...modules].sort().map((module) => ({
        path: module,
        specPath: findContainingSpec(`${module}/module.ts`, specPaths),
    }));
    report.directories = [...directories].sort().map((directory) => ({
        path: directory,
        specPath: findContainingSpec(path.posix.join(directory, 'source.ts'), specPaths),
    }));
    const scopes = [
        ...[...packages]
            .sort()
            .map((directory) => ({ path: directory, kind: 'package' })),
        ...[...modules]
            .sort()
            .map((directory) => ({ path: directory, kind: 'module' })),
    ];
    report.documentation = scopes.map((scope) => {
        const prefix = `${scope.path}/${scope.kind === 'package' ? 'src/' : ''}`;
        const files = sourceFiles.filter((file) => file.startsWith(prefix));
        const headers = files.map((file) => extractFileHeader(snapshot.readText(file) ?? ''));
        const readmePath = `${scope.path}/README.md`;
        return {
            ...scope,
            specPath: findContainingSpec(`${scope.path}/source.ts`, specPaths),
            readmePath: snapshot.readText(readmePath) === undefined ? null : readmePath,
            files: files.length,
            headers: headers.filter((header) => header?.responsibility).length,
            invariantHeaders: headers.filter((header) => header?.responsibility && header.invariants.length > 0).length,
        };
    });
    for (const { path: module } of report.modules.filter(({ specPath }) => specPath === null))
        issue('spec-missing', module, 'Add spec.md here or in a containing directory.');
    return report;
}
