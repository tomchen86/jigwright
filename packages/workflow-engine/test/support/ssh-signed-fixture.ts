import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MaintainerSignerProvider } from '../../src/adapters/signing/ssh/maintainer-signer.ts';

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_PAYLOAD_BYTES = 1_048_576;
const MAX_SIGNATURE_BYTES = 16_384;
const SAFE_IDENTITY = /^[A-Za-z0-9._@+-]{1,128}$/u;
const SAFE_NAMESPACE = /^[A-Za-z0-9._-]{1,128}$/u;

export type SshSignedFixture = Readonly<{
  trustedSigner: Readonly<{
    identity: string;
    publicKey: string;
    fingerprint: string;
  }>;
  signer(observedNamespaces?: string[]): MaintainerSignerProvider;
  sign(payload: string, namespace: string): string;
  verify(payload: string, signature: string, namespace: string): void;
  dispose(): void;
}>;

/**
 * Create one ephemeral Ed25519 identity whose test signer performs real
 * OpenSSH `-Y sign` and `-Y verify` operations for every signature.
 */
export function createSshSignedFixture(identity: string): SshSignedFixture {
  if (!SAFE_IDENTITY.test(identity))
    throw new TypeError('Unsafe SSH identity.');
  const executable = resolveSshKeygen();
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-ssh-fixture-')),
  );
  fs.chmodSync(root, 0o700);
  const keyPath = path.join(root, 'id_ed25519');
  const generated = runSshKeygen(executable, [
    '-q',
    '-t',
    'ed25519',
    '-N',
    '',
    '-C',
    identity,
    '-f',
    keyPath,
  ]);
  assertSucceeded(generated, 'Fixture SSH key generation failed.');
  const publicKey = fs
    .readFileSync(`${keyPath}.pub`, 'utf8')
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .join(' ');
  const fingerprintResult = runSshKeygen(executable, [
    '-l',
    '-E',
    'sha256',
    '-f',
    `${keyPath}.pub`,
  ]);
  assertSucceeded(fingerprintResult, 'Fixture SSH fingerprint failed.');
  const fingerprint = fingerprintResult.stdout.match(
    /SHA256:[A-Za-z0-9+/]+/u,
  )?.[0];
  if (fingerprint === undefined) {
    fs.rmSync(root, { recursive: true, force: true });
    throw new Error('Fixture SSH fingerprint is missing.');
  }
  const trustedSigner = Object.freeze({ identity, publicKey, fingerprint });

  function sign(payload: string, namespace: string): string {
    assertPayload(payload);
    assertNamespace(namespace);
    return withOperationDirectory(root, (directory) => {
      const payloadPath = path.join(directory, 'payload');
      writePrivateFile(payloadPath, payload);
      const signed = runSshKeygen(executable, [
        '-Y',
        'sign',
        '-f',
        keyPath,
        '-n',
        namespace,
        payloadPath,
      ]);
      assertSucceeded(signed, 'Fixture SSH signing failed.');
      const signature = fs.readFileSync(`${payloadPath}.sig`, 'utf8');
      if (
        Buffer.byteLength(signature) > MAX_SIGNATURE_BYTES ||
        !signature.startsWith('-----BEGIN SSH SIGNATURE-----\n') ||
        !signature.endsWith('-----END SSH SIGNATURE-----\n')
      ) {
        throw new Error('Fixture SSH signature is malformed.');
      }
      return signature;
    });
  }

  function verify(payload: string, signature: string, namespace: string): void {
    assertPayload(payload);
    assertNamespace(namespace);
    if (
      typeof signature !== 'string' ||
      Buffer.byteLength(signature) > MAX_SIGNATURE_BYTES
    ) {
      throw invalidSignature();
    }
    withOperationDirectory(root, (directory) => {
      const allowedSignersPath = path.join(directory, 'allowed-signers');
      const signaturePath = path.join(directory, 'signature');
      writePrivateFile(allowedSignersPath, `${identity} ${publicKey}\n`);
      writePrivateFile(signaturePath, signature);
      const verified = runSshKeygen(
        executable,
        [
          '-Y',
          'verify',
          '-f',
          allowedSignersPath,
          '-I',
          identity,
          '-n',
          namespace,
          '-s',
          signaturePath,
        ],
        payload,
      );
      if (verified.error !== undefined || verified.status !== 0) {
        throw invalidSignature();
      }
    });
  }

  return Object.freeze({
    trustedSigner,
    signer(observedNamespaces: string[] = []) {
      return {
        assertHumanPresent() {},
        identity() {
          return identity;
        },
        sign(payload, namespace) {
          const selected = requireNamespace(namespace);
          observedNamespaces.push(selected);
          return sign(payload, selected);
        },
        verify(payload, signature, requestedIdentity, namespace) {
          const selected = requireNamespace(namespace);
          observedNamespaces.push(selected);
          if (requestedIdentity !== identity) throw invalidSignature();
          verify(payload, signature, selected);
        },
      };
    },
    sign,
    verify,
    dispose() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  });
}

function resolveSshKeygen(): string {
  for (const candidate of ['/usr/bin/ssh-keygen', '/bin/ssh-keygen']) {
    const stats = fs.lstatSync(candidate, { throwIfNoEntry: false });
    if (stats?.isFile() && !stats.isSymbolicLink()) {
      return fs.realpathSync(candidate);
    }
  }
  throw new Error('A trusted system ssh-keygen is required for this fixture.');
}

function runSshKeygen(
  executable: string,
  args: readonly string[],
  input?: string,
): SpawnSyncReturns<string> {
  return spawnSync(executable, [...args], {
    encoding: 'utf8',
    env: {
      LANG: 'C',
      LC_ALL: 'C',
      PATH: path.dirname(executable),
    },
    input,
    shell: false,
    timeout: COMMAND_TIMEOUT_MS,
  });
}

function assertSucceeded(
  result: SpawnSyncReturns<string>,
  message: string,
): void {
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(message, { cause: result.error });
  }
}

function withOperationDirectory<T>(
  root: string,
  operation: (directory: string) => T,
): T {
  const directory = fs.mkdtempSync(path.join(root, 'operation-'));
  fs.chmodSync(directory, 0o700);
  try {
    return operation(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function writePrivateFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, { flag: 'wx', mode: 0o600 });
}

function assertPayload(payload: string): void {
  if (
    typeof payload !== 'string' ||
    Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES ||
    payload.includes('\0')
  ) {
    throw new TypeError('Fixture SSH payload is invalid.');
  }
}

function assertNamespace(namespace: string): void {
  if (!SAFE_NAMESPACE.test(namespace)) {
    throw new TypeError('Fixture SSH namespace is invalid.');
  }
}

function requireNamespace(namespace: string | undefined): string {
  if (namespace === undefined) throw invalidSignature();
  assertNamespace(namespace);
  return namespace;
}

function invalidSignature(): Error & { code: string } {
  const error = new Error('Fixture SSH signature is invalid.') as Error & {
    code: string;
  };
  error.code = 'MAINTAINER_SIGNATURE_INVALID';
  return error;
}
