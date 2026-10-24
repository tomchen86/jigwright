/**
 * Presents colocated specifications to native OpenSpec through a disposable
 * view.
 *
 * Invariants:
 * - A colocated view rejects a second canonical openspec/specs tree and
 *   removes its temporary directory after the operation.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SystemDescriptionSnapshot } from '../../../../modules/source/spec-ownership.ts';
import {
  systemSpecCatalog,
  type CanonicalSystemSpec,
} from '../../../../modules/source/system-spec-catalog.ts';
import { readSystemSpecDeltaInputs } from './system-spec-deltas.ts';
import {
  ExitCode,
  workflowError,
} from '../../../../foundation/errors/errors.ts';

export type ColocatedOpenSpecView = Readonly<{
  root: string;
  specs: readonly CanonicalSystemSpec[];
  snapshot?: SystemDescriptionSnapshot;
}>;

export type ColocatedOpenSpecViewDependencies = Readonly<{
  readSnapshot(repositoryRoot: string): SystemDescriptionSnapshot | undefined;
  temporaryDirectory(): string;
}>;

export function withColocatedOpenSpecView<T>(
  repositoryRoot: string,
  operation: (view: ColocatedOpenSpecView) => T,
  dependencies: ColocatedOpenSpecViewDependencies,
): T {
  const snapshot = dependencies.readSnapshot(repositoryRoot);
  const specs = snapshot ? systemSpecCatalog(snapshot) : [];
  if (!specs.length) return operation({ root: repositoryRoot, specs });
  if (
    snapshot!
      .listPaths()
      .some(
        (file) =>
          /^openspec\/specs\/[^/]+\/spec.md$/.test(file) &&
          snapshot!.readText(file) !== undefined,
      )
  ) {
    throw workflowError(
      'SYSTEM_SPEC_CANONICAL_CONFLICT',
      'Colocated contracts and openspec/specs cannot both be canonical. Complete the spec move before validation.',
      ExitCode.verification,
    );
  }
  const temporaryBase = dependencies.temporaryDirectory();
  const temporaryRoot = fs.mkdtempSync(
    path.join(fs.realpathSync(temporaryBase), 'colocated-openspec-'),
  );
  try {
    for (const spec of specs)
      write(
        temporaryRoot,
        `openspec/specs/${spec.capability}/spec.md`,
        spec.text,
      );
    for (const file of ['openspec/config.yaml', 'openspec/config.yml']) {
      if (fs.existsSync(path.join(repositoryRoot, file))) {
        write(
          temporaryRoot,
          file,
          fs.readFileSync(path.join(repositoryRoot, file), 'utf8'),
        );
      }
    }
    const schemas = path.join(repositoryRoot, 'openspec/schemas');
    if (fs.existsSync(schemas))
      fs.cpSync(schemas, path.join(temporaryRoot, 'openspec/schemas'), {
        recursive: true,
      });
    return operation({ root: temporaryRoot, specs, snapshot });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** Native archive computes the specs; the original reviewed artifacts are moved intact. */
export function prepareColocatedArchiveView(
  repositoryRoot: string,
  view: ColocatedOpenSpecView,
  activeRoot: string,
): (archivePath: string) => void {
  if (!view.snapshot) return () => {};
  const inputs = readSystemSpecDeltaInputs(
    view.snapshot,
    view.snapshot
      .listPaths()
      .filter(
        (file) =>
          file.startsWith(`${activeRoot}/specs/`) && file.endsWith('/spec.md'),
      ),
  )!;
  const nativeChange = path.join(view.root, activeRoot);
  fs.mkdirSync(path.dirname(nativeChange), { recursive: true });
  fs.cpSync(path.join(repositoryRoot, activeRoot), nativeChange, {
    recursive: true,
  });
  fs.rmSync(path.join(nativeChange, 'specs'), { recursive: true, force: true });
  for (const input of inputs)
    write(
      view.root,
      `${activeRoot}/specs/${input.capability}/spec.md`,
      input.delta,
    );
  return (archivePath) => {
    const outputs = inputs.map((input) => ({
      path: input.baseSpecPath,
      text: fs.readFileSync(
        path.join(view.root, `openspec/specs/${input.capability}/spec.md`),
        'utf8',
      ),
    }));
    const destination = path.join(repositoryRoot, archivePath);
    if (fs.existsSync(destination))
      throw workflowError(
        'ARCHIVE_DESTINATION_COLLISION',
        `Archive destination already exists: ${archivePath}.`,
        ExitCode.verification,
      );
    for (const output of outputs)
      write(repositoryRoot, output.path, output.text);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(path.join(repositoryRoot, activeRoot), destination);
  };
}

function write(root: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}
