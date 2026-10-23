import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
// Independent fixture inventory for the isolated bootstrap runtime.
export const BOOTSTRAP_RUNTIME_NAMES = [
  'built-in-engine-closure-pin.ts',
  'canonical-json.ts',
  'control-plane-bootstrap-closure.ts',
  'control-plane-bootstrap-executable.ts',
  'control-plane-bootstrap-files.ts',
  'control-plane-bootstrap-history.ts',
  'control-plane-bootstrap-initial.ts',
  'control-plane-bootstrap-local.ts',
  'control-plane-bootstrap-promotion-records.ts',
  'control-plane-bootstrap-promotion.ts',
  'control-plane-bootstrap-protected-records.ts',
  'control-plane-bootstrap-protected.ts',
  'control-plane-bootstrap-provenance.ts',
  'control-plane-bootstrap-quarantine.ts',
  'control-plane-bootstrap-types.ts',
  'control-plane-bootstrap-values.ts',
  'control-plane-trust.ts',
  'harness-bootstrap-production.ts',
  'maintainer-authority-production.ts',
  'session-lifecycle-production.ts',
  'workflow-bootstrap-host.ts',
  'workflow-engine-host.ts',
] as const;

/** Seal an explicit fixture host around the fixture engine, using the real host verifier. */
export function sealFixtureWorkflowHost(packageRoot: string): void {
  const bootstrap = path.join(packageRoot, 'bootstrap');
  // These test engines deliberately expose only their small synthetic CLI.
  // Unused production assembly files must not import absent fixture services.
  for (const name of [
    'harness-bootstrap-production.ts',
    'maintainer-authority-production.ts',
    'session-lifecycle-production.ts',
  ]) {
    fs.writeFileSync(path.join(bootstrap, name), 'export {};\n', {
      mode: 0o644,
    });
  }
  fs.writeFileSync(
    path.join(bootstrap, 'workflow-engine-host.ts'),
    "import '../src/entrypoints/cli/workflow-cli.ts';\n",
    { mode: 0o644 },
  );
  const digest = (bytes: string | Buffer) =>
    `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
  const manifest = {
    kind: 'workflow-bootstrap-host.v1',
    entrypoint: 'bootstrap/workflow-engine-host.ts',
    engineManifestDigest: digest(
      fs.readFileSync(path.join(bootstrap, 'built-in-engine-closure.json')),
    ),
    files: BOOTSTRAP_RUNTIME_NAMES.map((name) => ({
      path: `bootstrap/${name}`,
      mode: '100644',
      digest: digest(fs.readFileSync(path.join(bootstrap, name))),
    })),
  };
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(
    path.join(bootstrap, 'workflow-bootstrap-host.json'),
    bytes,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(bootstrap, 'workflow-bootstrap-host-pin.ts'),
    `// Synthetic fixture host pin.\nexport const WORKFLOW_BOOTSTRAP_HOST_MANIFEST_DIGEST = '${digest(bytes)}' as const;\n`,
    { mode: 0o644 },
  );
}
