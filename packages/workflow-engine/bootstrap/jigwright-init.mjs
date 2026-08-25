import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const PROFILE_PATH = 'workflow/jigwright-profile.json';

export function initializeJigwrightConsumer(repositoryRoot) {
  const root = path.resolve(repositoryRoot);
  const profilePath = path.join(root, PROFILE_PATH);
  const parent = path.dirname(profilePath);
  assertSafeTarget(root, parent, profilePath);
  const existing = fs.lstatSync(profilePath, { throwIfNoEntry: false });
  if (existing !== undefined) {
    throw initError(
      'JIGWRIGHT_INIT_ALREADY_CONFIGURED',
      'Jigwright init never rewrites an existing repository policy.',
    );
  }
  fs.mkdirSync(parent, { recursive: true });
  const profile = {
    schemaVersion: 1,
    kind: 'jigwright-consumer-profile.v1',
    ordinary: {
      requiredIndependence: 'session-independent',
      providerMode: 'single-provider-allowed',
      roleSessions: ['author', 'builder', 'reviewer'],
      sessionFreshness: 'fresh-per-role',
      perChangeAgentPlan: 'optional-override',
      signedGrants: 0,
      forcedDiversityCalls: 0,
      quietTriggeredDuplicateAttempts: 0,
      repeatedAuthorizedDataEgressPrompts: 0,
    },
    capabilities: {
      agentRuntime: 'optional',
      grants: 'optional-fail-closed-when-required',
      githubAdapter: 'optional',
      workRegistry: 'consumer-owned',
    },
  };
  const bytes = `${JSON.stringify(profile, null, 2)}\n`;
  fs.writeFileSync(profilePath, bytes, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o644,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: 'jigwright-init-result.v1',
    status: 'initialized',
    path: PROFILE_PATH,
    digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
  });
}

function assertSafeTarget(root, parent, target) {
  if (
    parent !== path.join(root, 'workflow') ||
    target !== path.join(root, PROFILE_PATH) ||
    !target.startsWith(`${root}${path.sep}`)
  ) {
    throw initError(
      'JIGWRIGHT_INIT_PATH_UNSAFE',
      'Jigwright init target is unsafe.',
    );
  }
  const workflow = fs.lstatSync(parent, { throwIfNoEntry: false });
  if (workflow?.isSymbolicLink() || (workflow && !workflow.isDirectory())) {
    throw initError(
      'JIGWRIGHT_INIT_PATH_UNSAFE',
      'Jigwright init target is unsafe.',
    );
  }
}

function initError(code, message) {
  return Object.assign(new Error(message), { code });
}
