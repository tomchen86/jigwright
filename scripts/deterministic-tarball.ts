import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export function writeDeterministicTarball(
  stageParent: string,
  tarballPath: string,
): void {
  const entries = collectTarEntries(stageParent, 'package');
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const { name, prefix } = splitUstarPath(entry.archivePath);
    const header = Buffer.alloc(512);
    writeTarText(header, 0, 100, name);
    writeTarOctal(header, 100, 8, entry.mode);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, entry.bytes.length);
    writeTarOctal(header, 136, 12, 0);
    header.fill(0x20, 148, 156);
    header[156] = entry.directory ? '5'.charCodeAt(0) : '0'.charCodeAt(0);
    writeTarText(header, 257, 6, 'ustar\0');
    writeTarText(header, 263, 2, '00');
    writeTarText(header, 345, 155, prefix);
    const checksum = header.reduce((sum, value) => sum + value, 0);
    const checksumText = checksum.toString(8).padStart(6, '0');
    writeTarText(header, 148, 6, checksumText);
    header[154] = 0;
    header[155] = 0x20;
    blocks.push(header);
    if (!entry.directory) {
      blocks.push(entry.bytes);
      const remainder = entry.bytes.length % 512;
      if (remainder !== 0) blocks.push(Buffer.alloc(512 - remainder));
    }
  }
  blocks.push(Buffer.alloc(1024));
  const gzip = zlib.gzipSync(Buffer.concat(blocks), { level: 9 });
  gzip.fill(0, 4, 8);
  gzip[9] = 0xff;
  fs.writeFileSync(tarballPath, gzip);
}

function collectTarEntries(
  stageParent: string,
  relativePath: string,
): readonly Readonly<{
  archivePath: string;
  directory: boolean;
  mode: number;
  bytes: Buffer;
}>[] {
  const absolutePath = path.join(stageParent, relativePath);
  const stat = fs.lstatSync(absolutePath);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
    throw new Error(`Unsupported release archive entry: ${relativePath}`);
  }
  if (stat.isDirectory()) {
    const own = {
      archivePath: `${relativePath}/`,
      directory: true,
      mode: 0o755,
      bytes: Buffer.alloc(0),
    } as const;
    const children = fs
      .readdirSync(absolutePath)
      .sort((left, right) => left.localeCompare(right))
      .flatMap((name) =>
        collectTarEntries(stageParent, path.posix.join(relativePath, name)),
      );
    return [own, ...children];
  }
  return [
    {
      archivePath: relativePath,
      directory: false,
      mode: (stat.mode & 0o111) === 0 ? 0o644 : 0o755,
      bytes: fs.readFileSync(absolutePath),
    },
  ];
}

function splitUstarPath(value: string): { name: string; prefix: string } {
  if (Buffer.byteLength(value) <= 100) return { name: value, prefix: '' };
  for (let index = value.lastIndexOf('/'); index > 0;) {
    const prefix = value.slice(0, index);
    const name = value.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
    index = value.lastIndexOf('/', index - 1);
  }
  throw new Error(`Release archive path exceeds ustar bounds: ${value}`);
}

function writeTarText(
  target: Buffer,
  offset: number,
  width: number,
  value: string,
): void {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > width) throw new Error('Release tar field is too long.');
  bytes.copy(target, offset);
}

function writeTarOctal(
  target: Buffer,
  offset: number,
  width: number,
  value: number,
): void {
  const encoded = value.toString(8).padStart(width - 1, '0');
  if (encoded.length > width - 1) {
    throw new Error('Release tar numeric field is too large.');
  }
  writeTarText(target, offset, width - 1, encoded);
  target[offset + width - 1] = 0;
}
