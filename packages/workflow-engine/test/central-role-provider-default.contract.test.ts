import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createCentralRoleProviderDefault,
  parseCentralRoleProviderDefault,
  providerPartitionChoices,
  providerRuleChoices,
  renderCentralRoleProviderDefault,
  renderCentralRoleProviderDefaultSummary,
  sessionPartitionChoices,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';

const logicalProviders = ['claude', 'codex', 'gemini', 'local'] as const;
const sourceRepositoryRoot = path.resolve(import.meta.dirname, '../../..');

test('repository central default keeps the current three-role floor provider-independent', () => {
  const configuration = parseCentralRoleProviderDefault(
    fs.readFileSync(
      path.join(sourceRepositoryRoot, 'workflow/role-provider-default.json'),
      'utf8',
    ),
  );
  assert.deepEqual(
    configuration.providerGroups.map(({ roles }) => roles),
    [['author'], ['builder'], ['reviewer']],
  );
  assert.deepEqual(configuration.globalProviderRanking, ['claude', 'codex']);
  assert.equal(
    configuration.configurationDigest,
    '6bbd9ffd708bcbfadf5eef016d5e0b93fc01b67a3e2e7d301c580d0af5264baf',
  );
});

test('central role defaults expose the five provider partitions and only necessary session questions', () => {
  assert.deepEqual(
    providerPartitionChoices().map(({ groups }) => groups),
    [
      [['author'], ['builder'], ['reviewer']],
      [['author', 'builder'], ['reviewer']],
      [['author'], ['builder', 'reviewer']],
      [['author', 'reviewer'], ['builder']],
      [['author', 'builder', 'reviewer']],
    ],
  );

  assert.deepEqual(sessionPartitionChoices(['author']), []);
  assert.deepEqual(
    sessionPartitionChoices(['author', 'builder']).map(
      ({ sessionGroups }) => sessionGroups,
    ),
    [[['author'], ['builder']], [['author', 'builder']]],
  );
  assert.deepEqual(
    sessionPartitionChoices(['author', 'builder', 'reviewer']).map(
      ({ sessionGroups }) => sessionGroups,
    ),
    [
      [['author'], ['builder'], ['reviewer']],
      [['author', 'builder'], ['reviewer']],
      [['author'], ['builder', 'reviewer']],
      [['author', 'reviewer'], ['builder']],
      [['author', 'builder', 'reviewer']],
    ],
  );

  const noncontiguousProviderGroup = createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: [
      {
        roles: ['author', 'reviewer'],
        sessionGroups: [['author', 'reviewer']],
        providerRule: { kind: 'adaptive-author' },
      },
      {
        roles: ['builder'],
        sessionGroups: [['builder']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: 'codex',
        },
      },
    ],
    globalProviderRanking: ['claude', 'codex'],
  });
  assert.deepEqual(noncontiguousProviderGroup.providerGroups[0]?.roles, [
    'author',
    'reviewer',
  ]);

  const partialSessionGroup = createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: [
      {
        roles: ['author', 'builder', 'reviewer'],
        sessionGroups: [['author', 'reviewer'], ['builder']],
        providerRule: { kind: 'adaptive-author' },
      },
    ],
    globalProviderRanking: ['claude', 'codex'],
  });
  assert.deepEqual(partialSessionGroup.providerGroups[0]?.sessionGroups, [
    ['author', 'reviewer'],
    ['builder'],
  ]);
});

test('Adaptive is offered only to the provider group containing Author', () => {
  assert.deepEqual(
    providerRuleChoices(['author', 'builder'], logicalProviders).map(
      ({ rule }) => rule,
    ),
    [
      { kind: 'adaptive-author' },
      { kind: 'ranked-fallback', preferredLogicalProviderId: 'claude' },
      { kind: 'ranked-fallback', preferredLogicalProviderId: 'codex' },
      { kind: 'ranked-fallback', preferredLogicalProviderId: 'gemini' },
      { kind: 'ranked-fallback', preferredLogicalProviderId: 'local' },
    ],
  );
  assert.deepEqual(
    providerRuleChoices(['reviewer'], logicalProviders).map(({ rule }) => rule),
    [
      { kind: 'ranked-fallback', preferredLogicalProviderId: null },
      { kind: 'ranked-fallback', preferredLogicalProviderId: 'claude' },
      { kind: 'ranked-fallback', preferredLogicalProviderId: 'codex' },
      { kind: 'ranked-fallback', preferredLogicalProviderId: 'gemini' },
      { kind: 'ranked-fallback', preferredLogicalProviderId: 'local' },
    ],
  );
});

test('central role defaults round-trip canonically without persisting or presenting a caller resolution', () => {
  const configuration = createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: [
      {
        roles: ['author', 'builder'],
        sessionGroups: [['author'], ['builder']],
        providerRule: { kind: 'adaptive-author' },
      },
      {
        roles: ['reviewer'],
        sessionGroups: [['reviewer']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: 'claude',
        },
      },
    ],
    globalProviderRanking: [...logicalProviders],
  });

  assert.match(configuration.configurationDigest, /^[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(configuration), true);
  assert.equal(Object.isFrozen(configuration.providerGroups), true);
  const rendered = renderCentralRoleProviderDefault(configuration);
  assert.deepEqual(parseCentralRoleProviderDefault(rendered), configuration);

  const summary = renderCentralRoleProviderDefaultSummary(configuration);
  assert.match(summary, /Author \/ Builder \| Reviewer/u);
  assert.match(summary, /Adaptive \(current caller per change\)/u);
  assert.match(summary, /Prefer claude; fallback by ranking/u);
  assert.doesNotMatch(summary, /->|resolved provider|setup caller/iu);
  assert.doesNotMatch(rendered, /callerId|resolvedProvider|assignment/u);
});

test('central defaults reject malformed partitions, non-Author Adaptive, and noncanonical bytes', () => {
  const base = {
    schemaVersion: 1 as const,
    kind: 'central-role-provider-default' as const,
    providerGroups: [
      {
        roles: ['author'] as const,
        sessionGroups: [['author']] as const,
        providerRule: {
          kind: 'ranked-fallback' as const,
          preferredLogicalProviderId: null,
        },
      },
      {
        roles: ['builder', 'reviewer'] as const,
        sessionGroups: [['builder'], ['reviewer']] as const,
        providerRule: {
          kind: 'ranked-fallback' as const,
          preferredLogicalProviderId: 'codex',
        },
      },
    ],
    globalProviderRanking: [...logicalProviders],
  };

  assert.throws(() =>
    createCentralRoleProviderDefault({
      ...base,
      providerGroups: [base.providerGroups[0], base.providerGroups[0]],
    }),
  );
  assert.throws(() =>
    createCentralRoleProviderDefault({
      ...base,
      providerGroups: [
        base.providerGroups[0],
        {
          ...base.providerGroups[1],
          providerRule: { kind: 'adaptive-author' },
        },
      ],
    }),
  );

  const configuration = createCentralRoleProviderDefault(base);
  const rendered = renderCentralRoleProviderDefault(configuration);
  assert.throws(() =>
    parseCentralRoleProviderDefault(rendered.replace(/^\{/u, '{\n ')),
  );
  assert.throws(() =>
    parseCentralRoleProviderDefault(
      rendered.replace(
        '"configurationDigest"',
        '"callerId":"codex","configurationDigest"',
      ),
    ),
  );
});
