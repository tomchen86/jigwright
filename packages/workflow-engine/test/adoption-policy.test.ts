import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentGuidanceService } from '../src/application/adoption/agent-guidance.ts';
import { createConsumerSetupService } from '../src/application/adoption/consumer-setup.ts';
import {
  AGENT_GUIDANCE_CONFIG,
  guidanceSourceContent,
  parseAgentGuidanceConfiguration,
  type AgentGuidanceStorage,
} from '../src/modules/adoption/agent-guidance.ts';
import {
  CONFIG_PATH,
  PROFILE_PATH,
  SETUP_QUESTIONS,
  renderProviderConfiguration,
  type Answers,
  type SetupProviderDefinition,
} from '../src/modules/adoption/setup-questions.ts';

const fails = (code: string) => (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;
function guidanceFixture() {
  const files = new Map<string, string>([
    ['AGENTS.md', '# Owner rules\r\nKeep bytes.\r\n'],
  ]);
  const events: string[] = [];
  const unsafe = new Set<string>();
  const storage: AgentGuidanceStorage = {
    assertTarget(target) {
      events.push(`preflight:${target}`);
      if (unsafe.has(target)) throw Error('unsafe target');
    },
    isRegularFile: (target) => files.has(target) && !unsafe.has(target),
    read(target) {
      storage.assertTarget(target);
      events.push(`read:${target}`);
      return files.get(target) ?? null;
    },
    write(target, content) {
      storage.assertTarget(target);
      events.push(`write:${target}`);
      files.set(target, content);
    },
  };
  const service = createAgentGuidanceService(
    storage,
    () => '  Exact owner text.\r\nNo reflow.\n',
    (diff) => events.push(`diff:${diff}`),
  );
  return { files, events, unsafe, service };
}

test('memory guidance uses explicit targets only, preserves exact Source bytes and path-keyed labels', () => {
  const f = guidanceFixture();
  assert.equal(f.service.installAgentGuidance().confirmationRequired, true);
  assert.equal(
    f.events.some((event) => event.startsWith('write:')),
    false,
  );
  f.files.set(
    AGENT_GUIDANCE_CONFIG,
    JSON.stringify({ targets: [], sourceRefs: [`SRC-${'a'.repeat(64)}`] }),
  );
  f.service.installAgentGuidance([{ path: 'AGENTS.md', label: 'first' }]);
  const projected = f.files.get('AGENTS.md')!;
  assert.ok(projected.startsWith('# Owner rules\r\nKeep bytes.\r\n'));
  assert.ok(projected.includes('  Exact owner text.\r\nNo reflow.\n'));
  assert.ok(projected.includes('<!-- prettier-ignore-start -->'));
  f.service.installAgentGuidance(['AGENTS.md']);
  assert.equal(f.service.readAgentGuidanceTargets()[0]!.label, 'first');
  assert.equal(f.service.statusAgentGuidance().targets[0]!.state, 'current');
  f.service.removeAgentGuidance();
  assert.ok(f.files.get('AGENTS.md')!.includes('Keep bytes.'));
  assert.equal(f.service.statusAgentGuidance().targets[0]!.state, 'removed');
});

test('memory guidance preflights every target and malformed region before writes', () => {
  const f = guidanceFixture();
  f.unsafe.add('unsafe.md');
  assert.throws(
    () => f.service.installAgentGuidance(['AGENTS.md', 'unsafe.md']),
    /unsafe target/,
  );
  assert.equal(
    f.events.some((event) => event.startsWith('write:')),
    false,
  );
  f.unsafe.clear();
  f.files.set(
    'bad.md',
    '<!-- jigwright:region id=guidance.agent-section v=oops -->\n',
  );
  assert.throws(() => f.service.installAgentGuidance(['AGENTS.md', 'bad.md']));
  assert.equal(
    f.events.some((event) => event.startsWith('write:')),
    false,
  );
});

test('memory guidance refuses concurrent config edits during preview without overwriting either target', () => {
  const f = guidanceFixture();
  const before = f.files.get('AGENTS.md');
  assert.throws(
    () =>
      f.service.installAgentGuidance(['AGENTS.md'], {
        onDiff() {
          f.files.set(
            AGENT_GUIDANCE_CONFIG,
            '{"targets":[{"path":"OTHER.md"}]}',
          );
        },
      }),
    fails('AGENT_GUIDANCE_CONFIG_CHANGED'),
  );
  assert.equal(f.files.get('AGENTS.md'), before);
  assert.equal(
    f.events.some((event) => event.startsWith('write:')),
    false,
  );
});

test('guidance policy rejects duplicate path identity and preserves literal line endings', () => {
  assert.throws(
    () =>
      parseAgentGuidanceConfiguration({
        targets: [
          { path: 'A.md', label: 'one' },
          { path: 'A.md', label: 'two' },
        ],
      }),
    fails('AGENT_GUIDANCE_CONFIG_INVALID'),
  );
  assert.equal(
    guidanceSourceContent(['x\r\ny\n'], 'rules'),
    '\n<!-- prettier-ignore-start -->\n\nx\r\ny\n\n\nrules\n\n<!-- prettier-ignore-end -->\n',
  );
});

const definitions: readonly SetupProviderDefinition[] = [
  {
    providerFamily: 'codex',
    trustTier: 'local',
    enabled: true,
    protocol: 'test',
    executableCandidates: ['/host/first', '/host/installed'],
  },
];
function setupFixture() {
  const files = new Map<string, Answers>();
  const providerFiles = new Map<string, string>();
  const events: string[] = [];
  let hostState: Answers = {};
  const service = createConsumerSetupService(
    {
      root: '/repository',
      read: (target) => structuredClone(files.get(target) ?? {}),
      exists: (target) => files.has(target),
      assertPath(target) {
        events.push(`preflight:${target}`);
      },
      write(target, value) {
        events.push(`write:${target}`);
        files.set(target, structuredClone(value));
      },
      profileDigest: () => `sha256:${'a'.repeat(64)}`,
    },
    {
      readState: () => ({
        path: '/host/state.json',
        value: structuredClone(hostState),
      }),
      defaultProviderPath: () => null,
      exists: (target) => providerFiles.has(target),
      canonicalPath: (target) => target,
      validateProviderPath(target) {
        events.push(`provider-preflight:${target}`);
        if (target.startsWith('/repository/'))
          throw Error('repository provider rejected');
        return target;
      },
      providerDefaults: () => ({
        providers: definitions,
        existingExecutables: ['/host/installed'],
      }),
      validateProviderDocument() {
        events.push('provider-document-preflight');
      },
      createProviderConfig(target, document) {
        if (providerFiles.has(target)) throw Error('exists');
        events.push('write:provider');
        providerFiles.set(target, document);
      },
      writeState(_target, value) {
        events.push('write:host');
        hostState = structuredClone(value);
      },
    },
    {
      suggestions: () => ['AGENTS.md'],
      install(targets) {
        events.push(`write:guidance:${targets.join(',')}`);
      },
    },
  );
  return { service, files, events, providerFiles };
}

test('memory setup fills missing defaults, remembers explicit declines and is idempotent', async () => {
  const f = setupFixture();
  const first = await f.service.initialize({
    answers: { providerConfig: null, guidanceTargets: [] },
  });
  assert.equal('status' in first && first.status, 'initialized');
  assert.ok(f.files.has(PROFILE_PATH));
  assert.equal(
    f.events.some((event) => event.startsWith('write:guidance')),
    false,
  );
  f.events.length = 0;
  const repeat = await f.service.initialize({ answers: {} });
  assert.equal('status' in repeat && repeat.status, 'unchanged');
  assert.equal(
    f.events.some((event) => event.startsWith('write:')),
    false,
  );
});

test('memory setup completes configuration and provider preflight before any requested write', async () => {
  const f = setupFixture();
  await f.service.initialize({
    answers: {
      providerConfig: '/host/provider.toml',
      providers: [
        { id: 'local', family: 'codex', executable: '/host/installed' },
      ],
      guidanceTargets: ['AGENTS.md'],
    },
  });
  const firstWrite = f.events.findIndex((event) => event.startsWith('write:'));
  assert.ok(firstWrite > f.events.indexOf('provider-document-preflight'));
  assert.ok(
    f.events
      .slice(0, firstWrite)
      .some((event) => event.startsWith('preflight:')),
  );
  assert.equal(f.providerFiles.size, 1);
  f.events.length = 0;
  await assert.rejects(
    f.service.initialize({
      answers: {
        providers: [
          { id: 'local', family: 'codex', executable: '/host/installed' },
        ],
      },
    }),
    fails('JIGWRIGHT_INIT_ANSWER_INVALID'),
  );
  assert.equal(
    f.events.some((event) => event.startsWith('write:')),
    false,
  );
});

test('memory setup rejects invalid existing schema before explicit guidance and keeps terminal ownership outside policy', async () => {
  const f = setupFixture();
  f.files.set(CONFIG_PATH, {
    schemaVersion: 999,
    repositoryName: 'repository',
  });
  let closed = false;
  await assert.rejects(
    f.service.initialize({
      answers: { providerConfig: null, guidanceTargets: ['AGENTS.md'] },
      openPrompt: () => ({
        ask: async () => '',
        close() {
          closed = true;
        },
      }),
    }),
  );
  assert.equal(closed, true);
  assert.equal(
    f.events.some((event) => event.startsWith('write:')),
    false,
  );
});

test('setup catalog derives provider defaults solely from supplied platform/executable facts', () => {
  const question = SETUP_QUESTIONS.find(
    (question) => question.id === 'providers',
  )!;
  assert.deepEqual(
    question.defaultValue({
      providers: definitions,
      existingExecutables: ['/host/installed'],
    }),
    [{ id: 'codex-local', family: 'codex', executable: '/host/installed' }],
  );
  assert.equal(
    question.valid([{ id: 'local', family: 'unknown', executable: '/host/a' }]),
    false,
  );
  const rendered = renderProviderConfiguration(
    [{ id: 'local', family: 'codex', executable: '/host/installed' }],
    definitions,
  );
  assert.ok(rendered.includes('global_ranking = ["local"]'));
  assert.ok(rendered.includes('executable = "/host/installed"'));
});
