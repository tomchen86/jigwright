/** Read workflow/check configuration and apply repository path admission. */
import fs from 'node:fs';
import path from 'node:path';
import { ExitCode, workflowError } from "../../foundation/errors/errors.js";
import { invalidContract } from "../../modules/planning-provider/change-contract-errors.js";
import { parseWorkflowConfig, } from "../../modules/repository-consumer/workflow-config.js";
import { parseChecksConfigSource, } from "../../modules/source/check-command.js";
import { assertPolicyPathInsideRepository } from "../paths/runtime-paths.js";
import { loadRepositoryConsumerConfiguration, repositoryConsumerPath, } from "./repository-consumer.js";
export function repositoryCurrentSchemaName(repositoryRoot) {
    return loadRepositoryConsumerConfiguration(repositoryRoot).configuration
        .planning.currentSchemaName;
}
export function repositoryPlanningPolicy(repositoryRoot) {
    return loadRepositoryConsumerConfiguration(repositoryRoot).configuration
        .planning;
}
export function repositoryHandoffPath(repositoryRoot) {
    return repositoryConsumerPath(repositoryRoot, repositoryHandoffRelativePath(repositoryRoot));
}
export function repositoryHandoffRelativePath(repositoryRoot) {
    return loadRepositoryConsumerConfiguration(repositoryRoot).configuration
        .documents.handoffPath;
}
export function loadWorkflowConfig(repositoryRoot) {
    const configPath = path.join(repositoryRoot, 'workflow/config.json');
    const configuration = parseWorkflowConfig(readJson(configPath, 'workflow configuration'), configPath);
    if (configuration.taskAuthorization !== undefined) {
        assertPolicyPathInsideRepository(repositoryRoot, configuration.taskAuthorization.pathRoleRegistry);
    }
    return configuration;
}
export function loadChecksConfig(repositoryRoot) {
    const checksPath = path.join(repositoryRoot, 'workflow/checks.json');
    const value = readJson(checksPath, 'check configuration');
    const parsed = parseChecksConfigSource(value);
    if (!parsed.ok && parsed.reason === 'invalid-registry') {
        throw invalidContract('INVALID_CHECKS_CONFIG', 'workflow/checks.json does not match schema version 1.', checksPath);
    }
    if (!parsed.ok) {
        throw invalidContract('INVALID_CHECK_DEFINITION', `Invalid check definition: ${parsed.checkId}`, checksPath);
    }
    return parsed.value;
}
export function readJson(filePath, label) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch (error) {
        throw workflowError('UNREADABLE_CONTRACT', `Unable to read ${label}: ${path.relative(process.cwd(), filePath).split(path.sep).join('/')}`, ExitCode.unsafeEnvironment, {
            details: {
                filePath,
                cause: error instanceof Error ? error.message : String(error),
            },
        });
    }
}
