/** Create fixture files and their manifest through the production closure APIs. */
import fs from 'node:fs';
import path from 'node:path';
import {
  REQUIRED_PROTECTED_CAPABILITIES,
  computeProtectedCapabilityEntryDigestsFromWorktree,
  parseProtectedCapabilitiesManifestSource,
} from '../../src/runtime/repository-validation/protected-capabilities.ts';
import { BOOTSTRAP_RUNTIME_NAMES } from './bootstrap-runtime-fixture.ts';

export function createFixtureProtectedManifest(
  repository: string,
  extraAuthorizationDependencies: readonly string[] = [],
) {
  const entries = REQUIRED_PROTECTED_CAPABILITIES.map((capability) => {
    const entrypoints = [`protected/${capability}/entry.ts`];
    const dependencies = [
      ...new Set([
        `protected/${capability}/dependency.ts`,
        ...(capability === 'adoption.journal'
          ? ['workflow/protected-capabilities.json']
          : []),
        ...(capability === 'authorization.verify'
          ? extraAuthorizationDependencies
          : []),
        ...(capability === 'policy.classify'
          ? [
              'packages/workflow-engine/src/runtime/repository-validation/protected-capabilities.ts',
            ]
          : []),
        ...(capability === 'control-plane.update'
          ? BOOTSTRAP_RUNTIME_NAMES.map(
              (name) => `packages/workflow-engine/bootstrap/${name}`,
            )
          : []),
      ]),
    ].sort();
    for (const filePath of [...entrypoints, ...dependencies]) {
      if (filePath === 'workflow/protected-capabilities.json') continue;
      const absolute = path.join(repository, filePath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      if (!fs.existsSync(absolute)) {
        fs.writeFileSync(absolute, `fixture protected file: ${filePath}\n`);
      }
    }
    return {
      capability,
      entrypoints,
      dependencies,
      ...computeProtectedCapabilityEntryDigestsFromWorktree(repository, {
        entrypoints,
        dependencies,
      }),
    };
  });
  return parseProtectedCapabilitiesManifestSource({
    kind: 'protected-capability-manifest.v1',
    schemaVersion: 1,
    manifestPath: 'workflow/protected-capabilities.json',
    entries,
  });
}
