/** Canonical safe directory and atomic metadata replacement used by closure generators. */
import fs from 'node:fs';
import path from 'node:path';

export function replaceFile(filePath: string, content: string): void {
  const temporary = `${filePath}.${process.pid}.tmp`;
  const observed = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (
    observed !== undefined &&
    (!observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1)
  ) {
    throw new Error(`Built-in closure output is unsafe: ${filePath}`);
  }
  if (fs.lstatSync(temporary, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(
      `Built-in closure temporary path is occupied: ${temporary}`,
    );
  }
  try {
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o644 });
    fs.chmodSync(temporary, 0o644);
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o644);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function requireContainedDirectory(
  root: string,
  segments: string[],
): string {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (
      stats === undefined ||
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      fs.realpathSync(current) !== current
    ) {
      throw new Error(`Built-in closure directory is unsafe: ${current}`);
    }
  }
  return current;
}
