/**
 * Enumerates configuration and policy files that contribute to workflow
 * contract identity.
 *
 * Invariants:
 * - The sorted result always includes workflow configuration and checks,
 *   and includes optional policies only when present as files.
 */
import fs from 'node:fs';
import path from 'node:path';
export function workflowContractArtifactPaths(repositoryRoot) {
    const required = [
        path.join(repositoryRoot, 'workflow/config.json'),
        path.join(repositoryRoot, 'workflow/checks.json'),
    ];
    const schemasDirectory = path.join(repositoryRoot, 'workflow/schemas');
    const schemas = fs
        .statSync(schemasDirectory, { throwIfNoEntry: false })
        ?.isDirectory()
        ? fs
            .readdirSync(schemasDirectory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
            .map((entry) => path.join(schemasDirectory, entry.name))
        : [];
    const documentPolicy = path.join(repositoryRoot, 'workflow/document-policy.json');
    const repositoryConsumer = path.join(repositoryRoot, 'workflow/repository-consumer.json');
    const maintainerPolicy = path.join(repositoryRoot, 'workflow/maintainer-policy.json');
    const grantPolicy = path.join(repositoryRoot, 'workflow/grant-policy.json');
    const pathRoleRegistry = path.join(repositoryRoot, 'workflow/path-roles.json');
    return [
        ...required,
        ...(fs.statSync(repositoryConsumer, { throwIfNoEntry: false })?.isFile()
            ? [repositoryConsumer]
            : []),
        ...schemas,
        ...(fs.statSync(documentPolicy, { throwIfNoEntry: false })?.isFile()
            ? [documentPolicy]
            : []),
        ...(fs.statSync(maintainerPolicy, { throwIfNoEntry: false })?.isFile()
            ? [maintainerPolicy]
            : []),
        ...(fs.statSync(grantPolicy, { throwIfNoEntry: false })?.isFile()
            ? [grantPolicy]
            : []),
        ...(fs.statSync(pathRoleRegistry, { throwIfNoEntry: false })?.isFile()
            ? [pathRoleRegistry]
            : []),
    ].sort();
}
