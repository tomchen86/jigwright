import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  isBuiltInProviderFamily,
  type BuiltInProviderFamily,
} from '@jigwright/core/built-in-provider-catalog';
import type { CollaborationAvailableActor } from '../src/modules/authority/collaboration-grant-codec.ts';
import { parseProviderDeclarations } from '../src/modules/authority/task-mandate-policy.ts';
import type {
  TaskMandatePayload,
  TaskMandateRequest,
  TaskMandateProviderInvocationAuditInput,
} from '../src/modules/authority/task-mandate-values.ts';
import { isProviderId } from '../src/modules/provider-orchestration/provider-registry.ts';
import { readRepositoryDependencies } from './support/repository-dependency-graph.ts';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
const completeFamilyContracts: [
  Equal<keyof TaskMandateRequest['providerCalls'], BuiltInProviderFamily>,
  Equal<
    keyof TaskMandatePayload['preparation']['providerCalls'],
    BuiltInProviderFamily
  >,
  Equal<
    Extract<CollaborationAvailableActor, { kind: 'provider' }>['providerId'],
    BuiltInProviderFamily
  >,
  Equal<
    TaskMandateProviderInvocationAuditInput['providerId'],
    BuiltInProviderFamily
  >,
] = [true, true, true, true];
// @ts-expect-error Unknown families cannot enter the authority contract.
const unknownFamily: BuiltInProviderFamily = 'unknown';
void unknownFamily;

test('authority family admission preserves complete types and exact uncoerced membership', () => {
  assert.deepEqual(completeFamilyContracts, [true, true, true, true]);
  const uninspectable = new Proxy(
    {},
    {
      get() {
        assert.fail('Family membership must not inspect or coerce objects.');
      },
    },
  );
  const inputs: unknown[] = [
    'codex',
    'claude',
    'unknown',
    'Codex',
    'codex ',
    '',
    null,
    undefined,
    0,
    NaN,
    true,
    1n,
    Symbol('codex'),
    [],
    uninspectable,
  ];
  for (const value of inputs) {
    const expected = value === 'codex' || value === 'claude';
    assert.equal(isBuiltInProviderFamily(value), expected);
    assert.equal(isProviderId(value), expected);
  }
  const declaration = {
    maxInvocations: 1,
    maxBudget: null,
    dataTypes: ['task-intent'],
    sourceCode: false,
    secrets: false,
    retryOnFailure: false,
    retryRequiresHuman: false,
  };
  assert.deepEqual(
    Object.keys(
      parseProviderDeclarations({ codex: declaration, claude: declaration }),
    ),
    ['claude', 'codex'],
  );
  assert.throws(() => parseProviderDeclarations({ unknown: uninspectable }), {
    code: 'TASK_MANDATE_INVALID',
    message: 'Task mandate names an unknown provider.',
  });
});

test('authority family consumers reject registry value and type backedges', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const reader = readRepositoryDependencies(root);
  const registry =
    'packages/workflow-engine/src/modules/provider-orchestration/provider-registry.ts';
  const catalog = 'packages/core/src/built-in-provider-catalog.ts';
  for (const name of [
    'collaboration-grant-codec',
    'task-mandate-audit',
    'task-mandate-policy',
    'task-mandate-records',
    'task-mandate-values',
  ]) {
    const file = path.join(
      root,
      `packages/workflow-engine/src/modules/authority/${name}.ts`,
    );
    const assertBoundary = (additionalSource = '') => {
      const { edges } = reader.read(file, additionalSource);
      assert.ok(
        !edges.some((edge) => edge.to === registry),
        'Authority family admission depends on the execution registry.',
      );
      const canonical = edges.filter((edge) => edge.to === catalog);
      assert.equal(canonical.length, 1);
      const typeOnly =
        name === 'task-mandate-audit' || name === 'task-mandate-values';
      assert.equal(canonical[0]!.typeOnly, typeOnly);
      assert.equal(canonical[0]!.loadsModule, !typeOnly);
    };
    assertBoundary();
    for (const source of [
      "\nimport { isProviderId as forbidden } from '../provider-orchestration/provider-registry.ts';",
      "\nimport type { ProviderId as Forbidden } from '../provider-orchestration/provider-registry.ts';",
    ]) {
      assert.throws(() => assertBoundary(source), /execution registry/);
    }
  }
});
