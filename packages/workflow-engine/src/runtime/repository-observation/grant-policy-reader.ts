/** Reads a plain Grant policy file before applying the canonical policy parser. */
import fs from 'node:fs';
import path from 'node:path';
import {
  parseGrantPolicyV2Document,
  policyInvalid,
  type LoadedGrantPolicyV2,
} from '../../modules/authority/grant-policy.ts';

export function loadGrantPolicyV2(repositoryRoot: string): LoadedGrantPolicyV2 {
  return parseGrantPolicyV2Document(readPlainGrantPolicyFile(repositoryRoot));
}

function readPlainGrantPolicyFile(repositoryRoot: string): string {
  const workflowDirectory = path.join(repositoryRoot, 'workflow');
  const policyPath = path.join(workflowDirectory, 'grant-policy.json');
  const directoryStats = fs.lstatSync(workflowDirectory, {
    throwIfNoEntry: false,
  });
  const policyStats = fs.lstatSync(policyPath, { throwIfNoEntry: false });
  if (
    !directoryStats?.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    !policyStats?.isFile() ||
    policyStats.isSymbolicLink()
  ) {
    throw policyInvalid('GRANT_POLICY_INVALID', 'Grant policy is malformed.');
  }

  const noFollow =
    process.platform !== 'win32' && typeof fs.constants.O_NOFOLLOW === 'number'
      ? fs.constants.O_NOFOLLOW
      : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(policyPath, fs.constants.O_RDONLY | noFollow);
    if (!fs.fstatSync(descriptor).isFile()) {
      throw policyInvalid('GRANT_POLICY_INVALID', 'Grant policy is malformed.');
    }
    return fs.readFileSync(descriptor, 'utf8');
  } catch {
    throw policyInvalid('GRANT_POLICY_INVALID', 'Grant policy is malformed.');
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
