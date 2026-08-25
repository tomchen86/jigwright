import fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { RepositoryPathError, normalizeExactRepositoryPath, } from '@jigwright/core/repository-path';
import { assertPolicyPathInsideRepository } from '@jigwright/core/runtime-path-kernel';
import { isRecord } from "../../../foundation/canonical-json/contract-values.js";
import { ExitCode, workflowError, } from "../../../foundation/errors/errors.js";
const CONFIG_PATH = 'workflow/repository-consumer.json';
const WORKFLOW_CONFIG_PATH = 'workflow/config.json';
const MAX_CONFIG_BYTES = 64 * 1024;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFE_SCHEMA_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
export const expenseAppCompatibilityConfiguration = deepFreeze({
    schemaVersion: 1,
    adapterId: 'configured-repository-v1',
    consumerId: 'expense-app',
    planning: {
        providerId: 'openspec',
        packageSchemaNames: ['spec-driven'],
        requiredSchemaNames: ['spec-driven', 'expense-app'],
        supportedSchemaNames: ['spec-driven', 'expense-app', 'expense-app-v2'],
        managedSchemaNames: ['expense-app', 'expense-app-v2'],
        currentSchemaName: 'expense-app-v2',
    },
    documents: {
        adapterId: 'filesystem-documents-v1',
        handoffPath: 'docs/CURRENT_AND_NEXT_STEPS.md',
        issueSourcePath: 'docs/issues/issues.yaml',
        issueLogPath: 'docs/ISSUE_LOG.md',
    },
    workRegistry: {
        adapterId: 'filesystem-work-registry-v1',
        itemRoot: 'docs/work-registry/items',
        inventoryPath: 'docs/work-registry/inventory.json',
        backlogPath: 'docs/BACKLOG.md',
        historyRoot: 'docs/work-history',
        sourceRoot: 'workflow/source-ledger/objects/sha256',
        transitionPolicyPath: 'workflow/work-registry-policy.json',
        changeOriginRoot: 'openspec/changes',
    },
    databasePolicy: { adapterId: 'postgresql-disposable-v1' },
});
export const productionRepositoryConsumerPort = Object.freeze({
    contractVersion: 'jigwright.repository-consumer-port.v1',
    load(repositoryRoot) {
        return loadRepositoryConsumerConfiguration(repositoryRoot).configuration;
    },
});
export function loadRepositoryConsumerConfiguration(requestedRepositoryRoot) {
    const repositoryRoot = canonicalRoot(requestedRepositoryRoot);
    const configPath = path.join(repositoryRoot, CONFIG_PATH);
    const stats = fs.lstatSync(configPath, { throwIfNoEntry: false });
    if (stats === undefined) {
        if (readRepositoryName(repositoryRoot) === 'expense-app') {
            return Object.freeze({
                configuration: expenseAppCompatibilityConfiguration,
                source: 'legacy-expense-app-compatibility',
            });
        }
        throw configError('REPOSITORY_CONSUMER_CONFIG_MISSING', 'A non-expense consumer must provide workflow/repository-consumer.json.', ExitCode.guard);
    }
    const value = readBoundedJson(configPath, stats);
    const configuration = parseRepositoryConsumerConfiguration(value);
    if (configuration.consumerId !== readRepositoryName(repositoryRoot)) {
        throw configInvalid();
    }
    assertConfiguredPathsInsideRepository(repositoryRoot, configuration);
    return Object.freeze({
        configuration,
        source: 'tracked',
    });
}
export function repositoryDocumentConfiguration(repositoryRoot) {
    return productionRepositoryConsumerPort.load(repositoryRoot).documents;
}
export function repositoryPlanningConfiguration(repositoryRoot) {
    return productionRepositoryConsumerPort.load(repositoryRoot).planning;
}
export function repositoryWorkRegistryConfiguration(repositoryRoot) {
    return productionRepositoryConsumerPort.load(repositoryRoot).workRegistry;
}
export function repositoryDatabasePolicyConfiguration(repositoryRoot) {
    return productionRepositoryConsumerPort.load(repositoryRoot).databasePolicy;
}
export function repositoryConsumerPath(repositoryRoot, relativePath) {
    productionRepositoryConsumerPort.load(repositoryRoot);
    return resolveCanonicalRepositoryPath(canonicalRoot(repositoryRoot), safePath(relativePath));
}
export function parseRepositoryConsumerConfiguration(value) {
    if (!isRecord(value) ||
        !hasExactKeys(value, [
            'adapterId',
            'consumerId',
            'databasePolicy',
            'documents',
            'planning',
            'schemaVersion',
            'workRegistry',
        ]) ||
        value.schemaVersion !== 1 ||
        value.adapterId !== 'configured-repository-v1' ||
        typeof value.consumerId !== 'string' ||
        !SAFE_ID.test(value.consumerId) ||
        !isRecord(value.planning) ||
        !hasExactKeys(value.planning, [
            'currentSchemaName',
            'managedSchemaNames',
            'packageSchemaNames',
            'providerId',
            'requiredSchemaNames',
            'supportedSchemaNames',
        ]) ||
        typeof value.planning.providerId !== 'string' ||
        !SAFE_ID.test(value.planning.providerId) ||
        !isSchemaNames(value.planning.packageSchemaNames, true) ||
        !isSchemaNames(value.planning.requiredSchemaNames, false) ||
        !isSchemaNames(value.planning.supportedSchemaNames, false) ||
        !isSchemaNames(value.planning.managedSchemaNames, false) ||
        typeof value.planning.currentSchemaName !== 'string' ||
        !SAFE_SCHEMA_NAME.test(value.planning.currentSchemaName) ||
        !isRecord(value.documents) ||
        !hasExactKeys(value.documents, [
            'adapterId',
            'handoffPath',
            'issueLogPath',
            'issueSourcePath',
        ]) ||
        typeof value.documents.adapterId !== 'string' ||
        !isRecord(value.workRegistry) ||
        !hasExactKeys(value.workRegistry, [
            'adapterId',
            'backlogPath',
            'changeOriginRoot',
            'historyRoot',
            'inventoryPath',
            'itemRoot',
            'sourceRoot',
            'transitionPolicyPath',
        ]) ||
        typeof value.workRegistry.adapterId !== 'string' ||
        !isRecord(value.databasePolicy) ||
        !hasExactKeys(value.databasePolicy, ['adapterId']) ||
        typeof value.databasePolicy.adapterId !== 'string') {
        throw configInvalid();
    }
    if (value.planning.providerId !== 'openspec' ||
        value.documents.adapterId !== 'filesystem-documents-v1' ||
        value.workRegistry.adapterId !== 'filesystem-work-registry-v1' ||
        !['postgresql-disposable-v1', 'disabled-v1'].includes(value.databasePolicy.adapterId)) {
        throw configError('REPOSITORY_CONSUMER_CONFIG_UNSUPPORTED', 'Repository consumer configuration selects an unsupported code-owned adapter.', ExitCode.guard);
    }
    const planning = value.planning;
    const supported = new Set(planning.supportedSchemaNames);
    const packageNames = new Set(planning.packageSchemaNames);
    const managedNames = new Set(planning.managedSchemaNames);
    if (!supported.has(planning.currentSchemaName) ||
        !managedNames.has(planning.currentSchemaName) ||
        [...planning.requiredSchemaNames].some((name) => !supported.has(name)) ||
        [...packageNames].some((name) => !supported.has(name)) ||
        [...managedNames].some((name) => !supported.has(name) || packageNames.has(name)) ||
        packageNames.size + managedNames.size !== supported.size) {
        throw configInvalid();
    }
    const documents = value.documents;
    const workRegistry = value.workRegistry;
    const documentPaths = [
        documents.handoffPath,
        documents.issueSourcePath,
        documents.issueLogPath,
    ].map(safePathValue);
    const registryPaths = [
        workRegistry.itemRoot,
        workRegistry.inventoryPath,
        workRegistry.backlogPath,
        workRegistry.historyRoot,
        workRegistry.sourceRoot,
        workRegistry.transitionPolicyPath,
        workRegistry.changeOriginRoot,
    ].map(safePathValue);
    if (new Set(documentPaths).size !== documentPaths.length ||
        new Set(registryPaths).size !== registryPaths.length ||
        new Set([...documentPaths, ...registryPaths]).size !==
            documentPaths.length + registryPaths.length) {
        throw configInvalid();
    }
    return deepFreeze({
        schemaVersion: 1,
        adapterId: 'configured-repository-v1',
        consumerId: value.consumerId,
        planning: {
            providerId: planning.providerId,
            packageSchemaNames: [...planning.packageSchemaNames],
            requiredSchemaNames: [...planning.requiredSchemaNames],
            supportedSchemaNames: [...planning.supportedSchemaNames],
            managedSchemaNames: [...planning.managedSchemaNames],
            currentSchemaName: planning.currentSchemaName,
        },
        documents: {
            adapterId: 'filesystem-documents-v1',
            handoffPath: documentPaths[0],
            issueSourcePath: documentPaths[1],
            issueLogPath: documentPaths[2],
        },
        workRegistry: {
            adapterId: 'filesystem-work-registry-v1',
            itemRoot: registryPaths[0],
            inventoryPath: registryPaths[1],
            backlogPath: registryPaths[2],
            historyRoot: registryPaths[3],
            sourceRoot: registryPaths[4],
            transitionPolicyPath: registryPaths[5],
            changeOriginRoot: registryPaths[6],
        },
        databasePolicy: { adapterId: value.databasePolicy.adapterId },
    });
}
function assertConfiguredPathsInsideRepository(repositoryRoot, configuration) {
    const paths = [
        configuration.documents.handoffPath,
        configuration.documents.issueSourcePath,
        configuration.documents.issueLogPath,
        configuration.workRegistry.itemRoot,
        configuration.workRegistry.inventoryPath,
        configuration.workRegistry.backlogPath,
        configuration.workRegistry.historyRoot,
        configuration.workRegistry.sourceRoot,
        configuration.workRegistry.transitionPolicyPath,
        configuration.workRegistry.changeOriginRoot,
    ];
    try {
        for (const configuredPath of paths) {
            assertPolicyPathInsideRepository(repositoryRoot, configuredPath);
            resolveCanonicalRepositoryPath(repositoryRoot, configuredPath);
        }
    }
    catch {
        throw configInvalid();
    }
}
function resolveCanonicalRepositoryPath(repositoryRoot, configuredPath) {
    let current = repositoryRoot;
    const segments = configuredPath.split('/');
    for (const [index, segment] of segments.entries()) {
        const candidate = path.join(current, segment);
        const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
        if (stats === undefined) {
            return path.join(current, ...segments.slice(index));
        }
        if (stats.isSymbolicLink() ||
            (index < segments.length - 1 && !stats.isDirectory()) ||
            (index === segments.length - 1 && !stats.isDirectory() && !stats.isFile())) {
            throw new Error('unsafe configured path topology');
        }
        const canonical = fs.realpathSync(candidate);
        assertCanonicalContainment(repositoryRoot, canonical);
        current = canonical;
    }
    return current;
}
function assertCanonicalContainment(repositoryRoot, candidate) {
    const relative = path.relative(repositoryRoot, candidate);
    if (relative === '' ||
        path.isAbsolute(relative) ||
        relative === '..' ||
        relative.startsWith(`..${path.sep}`)) {
        throw new Error('configured path escapes repository');
    }
}
function readRepositoryName(repositoryRoot) {
    const configPath = path.join(repositoryRoot, WORKFLOW_CONFIG_PATH);
    const stats = fs.lstatSync(configPath, { throwIfNoEntry: false });
    if (stats === undefined)
        throw configInvalid();
    const value = readBoundedJson(configPath, stats);
    if (!isRecord(value) ||
        typeof value.repositoryName !== 'string' ||
        !SAFE_ID.test(value.repositoryName)) {
        throw configInvalid();
    }
    return value.repositoryName;
}
function readBoundedJson(filePath, stats) {
    try {
        if (!stats.isFile() ||
            stats.isSymbolicLink() ||
            stats.nlink !== 1 ||
            stats.size < 1 ||
            stats.size > MAX_CONFIG_BYTES ||
            fs.realpathSync(filePath) !== filePath) {
            throw new Error('unsafe configuration file');
        }
        const bytes = fs.readFileSync(filePath);
        if (bytes.byteLength !== stats.size)
            throw new Error('configuration drift');
        return JSON.parse(UTF8.decode(bytes));
    }
    catch {
        throw configInvalid();
    }
}
function canonicalRoot(requestedRepositoryRoot) {
    try {
        const resolved = path.resolve(requestedRepositoryRoot);
        const canonical = fs.realpathSync(resolved);
        if (!fs.statSync(canonical).isDirectory()) {
            throw new Error('unsafe repository root');
        }
        return canonical;
    }
    catch {
        throw configInvalid();
    }
}
function safePathValue(value) {
    if (typeof value !== 'string')
        throw configInvalid();
    return safePath(value);
}
function safePath(value) {
    try {
        if (normalizeExactRepositoryPath(value) !== value)
            throw configInvalid();
        return value;
    }
    catch (error) {
        if (error instanceof RepositoryPathError)
            throw configInvalid();
        throw error;
    }
}
function isSchemaNames(value, allowEmpty) {
    return (Array.isArray(value) &&
        (allowEmpty || value.length > 0) &&
        value.length <= 32 &&
        value.every((entry) => typeof entry === 'string' && SAFE_SCHEMA_NAME.test(entry)) &&
        new Set(value).size === value.length);
}
function hasExactKeys(value, expected) {
    const actual = Object.keys(value).sort();
    return (actual.length === expected.length &&
        actual.every((key, index) => key === [...expected].sort()[index]));
}
function deepFreeze(value) {
    Object.freeze(value.planning.packageSchemaNames);
    Object.freeze(value.planning.requiredSchemaNames);
    Object.freeze(value.planning.supportedSchemaNames);
    Object.freeze(value.planning.managedSchemaNames);
    Object.freeze(value.planning);
    Object.freeze(value.documents);
    Object.freeze(value.workRegistry);
    Object.freeze(value.databasePolicy);
    return Object.freeze(value);
}
function configInvalid() {
    return configError('REPOSITORY_CONSUMER_CONFIG_INVALID', 'Repository consumer configuration does not match schema version 1.', ExitCode.verification);
}
function configError(code, message, exitCode) {
    return workflowError(code, message, exitCode);
}
