/** Validates repository containment and UTF-8, and atomically writes guidance files. */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeExactRepositoryPath } from '@jigwright/core/repository-path';
import { assertPolicyPathInsideRepository } from '@jigwright/repository-runtime/paths';
import { ExitCode, workflowError } from '../../foundation/errors/errors.ts';
import { replaceTextAtomic } from '../repository-transaction/atomic-text.ts';
import type { AgentGuidanceStorage } from '../../modules/adoption/agent-guidance.ts';
export function createAgentGuidanceStorage(
  repositoryRoot: string,
): AgentGuidanceStorage {
  return {
    assertTarget(target) {
      checkedPath(repositoryRoot, target);
    },
    isRegularFile(target) {
      try {
        return fs.lstatSync(checkedPath(repositoryRoot, target)).isFile();
      } catch {
        return false;
      }
    },
    read(target) {
      const absolute = checkedPath(repositoryRoot, target);
      return fs.existsSync(absolute) ? readUtf8(absolute) : null;
    },
    write(target, content) {
      replaceTextAtomic(checkedPath(repositoryRoot, target), content, {
        allowCreate: true,
      });
    },
  };
}
function checkedPath(repositoryRoot: string, target: string): string {
  try {
    normalizeExactRepositoryPath(target);
    assertPolicyPathInsideRepository(repositoryRoot, target);
  } catch (error) {
    throw workflowError(
      'AGENT_GUIDANCE_UNSAFE_TARGET',
      error instanceof Error
        ? error.message
        : `Unsafe guidance path: ${target}`,
      ExitCode.usage,
    );
  }
  const segments = target.split('/');
  let current = repositoryRoot;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (index === segments.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw workflowError(
        'AGENT_GUIDANCE_UNSAFE_TARGET',
        `Guidance path must resolve to a regular file: ${target}`,
        ExitCode.usage,
      );
    }
  }
  return path.join(repositoryRoot, target);
}

function readUtf8(filePath: string): string {
  const bytes = fs.readFileSync(filePath);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw workflowError(
      'AGENT_GUIDANCE_UNSUPPORTED_ENCODING',
      `Guidance files must be valid UTF-8: ${filePath}`,
      ExitCode.usage,
    );
  }
  return text;
}
