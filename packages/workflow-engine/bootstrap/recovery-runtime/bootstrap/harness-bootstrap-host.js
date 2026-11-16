/** Run recovery only after the independent recovery launcher admits this host closure. */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHarnessBootstrapCli } from "../src/entrypoints/cli/harness-bootstrap-cli.js";
import { harnessBootstrapProduction } from "./harness-bootstrap-production.js";
export const { runHarnessBootstrapCli } = createHarnessBootstrapCli(harnessBootstrapProduction);
const entryPath = process.argv[1];
if (entryPath &&
    import.meta.url === pathToFileURL(path.resolve(entryPath)).href) {
    process.exitCode = runHarnessBootstrapCli(process.argv.slice(2));
}
