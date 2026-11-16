/**
 * Verifies native session composition boundaries and exact assignment-bound continuation evidence.
 *
 * Invariants:
 * - Production consumers remain explicitly inventoried and native identities stay private.
 * - Completion and resume require the exact assignment, receipt, and predecessor bindings.
 *
 * Depends on: provider-native session contracts, wrapper protocol, and production consumers.
 * Failure modes: untracked consumers or stale continuation evidence can escape the session boundary.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

import { createProviderWrapperSessionProtocolParser } from '@jigwright/agent-runtime';
import {
  parseAgentProviderConfigToml,
  type AgentProviderConfigSnapshot,
} from '@jigwright/core/agent-provider-config';
import {
  providerNativeSessionIdDigest,
  renderProviderWrapperSessionFrame,
  type ProviderWrapperNativeSessionIdentityObservation,
  type ProviderWrapperSessionProtocolBinding,
} from '@jigwright/core/harness-jsonl-v2-contracts';

import { canonicalJson } from '../src/foundation/canonical-json/canonical-json.ts';
import {
  agentRolePlanV2Digest,
  createAgentRolePlanV2Snapshot,
  renderAgentRolePlanV2,
  type AgentRolePlanBodyV2,
} from '../src/modules/provider-orchestration/agent-role-plan.ts';
import {
  createCentralRoleProviderDefault,
  createCentralRoleProviderDefaultSnapshotV1,
  renderCentralRoleProviderDefault,
} from '../src/modules/provider-orchestration/central-role-provider-default.ts';
import { createChangeRoleAssignmentRecordV1 } from '../src/modules/provider-orchestration/change-role-assignment-record.ts';
import {
  createChangeRoleAssignmentProtectedContextV1,
  resolveChangeRoleAssignmentV1,
} from '../src/modules/provider-orchestration/change-role-assignment.ts';
import {
  createProviderNativeSessionClaimV1,
  createProviderNativeSessionCompletionV1,
  deriveProviderNativeSessionScopeV1,
} from '../src/modules/provider-orchestration/provider-native-session.ts';

const CHANGE_ID = 'native-session-foundation';
const PLANNING_GENERATION = 'a'.repeat(64);

function sourceFiles(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(candidate);
    return entry.isFile() && candidate.endsWith('.ts') ? [candidate] : [];
  });
}

test('provider-native session foundation has one explicit production composition boundary', () => {
  const sourceRoot = path.resolve(import.meta.dirname, '../src');
  const moduleSource = fs.readFileSync(
    path.join(
      sourceRoot,
      'modules/provider-orchestration/provider-native-session.ts',
    ),
    'utf8',
  );
  assert.doesNotMatch(
    moduleSource,
    /ProviderNativeSession(?:Claim|Completion|Handle).*V2|ProviderNativeTurnBinding/u,
  );
  const owningModules = new Set([
    path.join(
      sourceRoot,
      'modules/provider-orchestration/provider-native-session.ts',
    ),
    path.join(
      sourceRoot,
      'runtime/storage-journal/provider-native-session-store.ts',
    ),
    path.join(
      sourceRoot,
      'runtime/storage-journal/provider-native-session-chain.ts',
    ),
    path.join(
      sourceRoot,
      'runtime/storage-journal/provider-native-session-contracts.ts',
    ),
    path.join(
      sourceRoot,
      'runtime/storage-journal/provider-native-session-files.ts',
    ),
    path.join(
      sourceRoot,
      'runtime/storage-journal/provider-native-session-publication-recovery.ts',
    ),
    path.join(
      sourceRoot,
      'runtime/storage-journal/provider-native-session-publication.ts',
    ),
    path.join(
      sourceRoot,
      'runtime/storage-journal/provider-native-session-values.ts',
    ),
  ]);
  const consumers = sourceFiles(sourceRoot)
    .filter((filePath) => !owningModules.has(filePath))
    .filter((filePath) =>
      fs.readFileSync(filePath, 'utf8').includes('provider-native-session'),
    )
    .map((filePath) => path.relative(sourceRoot, filePath));

  assert.deepEqual(consumers, [
    'composition-root/change-role-assignment-production.ts',
    'modules/provider-orchestration/agent-runtime-durable-authority.ts',
    'modules/provider-orchestration/agent-runtime-host-execution-binding.ts',
    'modules/provider-orchestration/agent-runtime-port.ts',
    'modules/provider-orchestration/agent-runtime-protocol.ts',
    'runtime/session-workspace/provider-runtime-authority-paths.ts',
    'runtime/storage-journal/provider-invocation-completion.ts',
    'runtime/storage-journal/provider-runtime-authority.ts',
  ]);
  const source = (file: string) =>
    fs.readFileSync(path.join(sourceRoot, file), 'utf8');
  const applicationPath =
    'application/provider-worker/provider-worker-execution.ts';
  const productionPath = 'composition-root/provider-worker-production.ts';
  const applicationSource = source(applicationPath);
  const productionSource = source(productionPath);
  const ast = (file: string, text: string) =>
    ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const compact = (node: ts.Node, tree: ts.SourceFile) =>
    node.getText(tree).replace(/\s/g, '');
  function descendants<T extends ts.Node>(
    node: ts.Node,
    predicate: (candidate: ts.Node) => candidate is T,
  ): T[] {
    const found: T[] = [];
    const visit = (candidate: ts.Node) => {
      if (predicate(candidate)) found.push(candidate);
      candidate.forEachChild(visit);
    };
    visit(node);
    return found;
  }
  function namedFunction(tree: ts.SourceFile, name: string) {
    const declaration = tree.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.ok(declaration?.body);
    return declaration;
  }
  function variable(block: ts.SourceFile | ts.Block, name: string) {
    const declarations = block.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations]);
    const declaration = declarations.find(
      (node) => ts.isIdentifier(node.name) && node.name.text === name,
    );
    assert.ok(declaration?.initializer);
    return declaration;
  }
  function importBinding(
    tree: ts.SourceFile,
    local: string,
    imported: string,
    owner: string,
  ) {
    const entries = tree.statements
      .filter(ts.isImportDeclaration)
      .filter(
        (node) =>
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === owner,
      )
      .flatMap((node) => {
        const bindings = node.importClause?.namedBindings;
        return bindings && ts.isNamedImports(bindings)
          ? [...bindings.elements]
          : [];
      });
    assert.equal(
      entries.filter(
        (node) =>
          node.name.text === local &&
          (node.propertyName?.text ?? node.name.text) === imported,
      ).length,
      1,
    );
  }
  function assertNativeWiring(executionText: string, bindingText: string) {
    const executionAst = ast(applicationPath, executionText);
    const bindingAst = ast(productionPath, bindingText);
    const entryAst = ast(
      'worker.ts',
      source('entrypoints/worker/provider-worker.ts'),
    );
    const entry = entryAst.statements.filter(ts.isExportDeclaration);
    assert.equal(entry.length, 1);
    assert.equal(
      entry[0]!.moduleSpecifier?.getText(entryAst),
      "'../../composition-root/provider-worker-production.ts'",
    );
    const exports = entry[0]!.exportClause;
    assert.ok(exports && ts.isNamedExports(exports));
    assert.deepEqual(
      exports.elements
        .filter((node) => !node.isTypeOnly)
        .map((node) => [node.name.text, node.propertyName?.text]),
      [
        ['runProviderWorkerWithMandate', undefined],
        ['runProviderWorkerAsyncWithMandate', undefined],
        ['runProviderWorker', undefined],
        ['runProviderWorkerAsync', undefined],
      ],
    );
    function bound(name: string) {
      const declaration = variable(bindingAst, name);
      assert.ok(
        ts.isVariableStatement(declaration.parent.parent) &&
          declaration.parent.parent.modifiers?.some(
            (node) => node.kind === ts.SyntaxKind.ExportKeyword,
          ),
      );
      const call = declaration.initializer!;
      assert.ok(
        ts.isCallExpression(call) &&
          ts.isPropertyAccessExpression(call.expression),
      );
      assert.equal(call.expression.name.text, 'bind');
      assert.equal(call.arguments.length, 2);
      assert.equal(call.arguments[0]?.getText(bindingAst), 'undefined');
      return {
        target: call.expression.expression.getText(bindingAst),
        dependency: call.arguments[1]!.getText(bindingAst),
      };
    }
    const sync = bound('runProviderWorkerWithMandate');
    const async = bound('runProviderWorkerAsyncWithMandate');
    assert.equal(sync.dependency, async.dependency);
    importBinding(
      bindingAst,
      sync.target,
      'runProviderWorkerWithMandate',
      '../application/provider-worker/provider-worker-execution.ts',
    );
    importBinding(
      bindingAst,
      async.target,
      'runProviderWorkerAsyncWithMandate',
      '../application/provider-worker/provider-worker-execution.ts',
    );
    assert.deepEqual(bound('runProviderWorker'), {
      target: 'runProviderWorkerWithMandate',
      dependency: 'taskMandateOperations',
    });
    assert.deepEqual(bound('runProviderWorkerAsync'), {
      target: 'runProviderWorkerAsyncWithMandate',
      dependency: 'taskMandateOperations',
    });
    importBinding(
      bindingAst,
      'taskMandateOperations',
      'taskMandateOperations',
      './task-mandate-production.ts',
    );
    const effects = variable(bindingAst, sync.dependency).initializer!;
    assert.ok(ts.isObjectLiteralExpression(effects));
    const runtime = effects.properties.find(
      (property) =>
        property.name?.getText(bindingAst) === 'productionAgentRuntime',
    );
    assert.ok(runtime && ts.isShorthandPropertyAssignment(runtime));
    importBinding(
      bindingAst,
      runtime.name.text,
      'productionAgentRuntime',
      './agent-runtime-production.ts',
    );
    const resolution = effects.properties.find(
      (property) => property.name?.getText(bindingAst) === 'resolveAssignment',
    );
    assert.ok(
      resolution && ts.isMethodDeclaration(resolution) && resolution.body,
    );
    assert.equal(resolution.body.statements.length, 1);
    const returned = resolution.body.statements[0]!;
    assert.ok(
      ts.isReturnStatement(returned) &&
        returned.expression &&
        ts.isCallExpression(returned.expression),
    );
    assert.equal(
      returned.expression.expression.getText(bindingAst),
      'resolveCurrentProviderWorkerAssignment',
    );
    importBinding(
      bindingAst,
      'resolveCurrentProviderWorkerAssignment',
      'resolveCurrentProviderWorkerAssignment',
      './provider-worker-assignment-production.ts',
    );

    const execution = namedFunction(
      executionAst,
      'runProviderWorkerWithExecution',
    ).body!;
    const injected = execution.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find(
        (declaration) =>
          declaration.initializer?.getText(executionAst) === 'effects',
      );
    assert.ok(injected && ts.isObjectBindingPattern(injected.name));
    for (const name of ['productionAgentRuntime', 'resolveAssignment']) {
      const binding: ts.BindingElement[] = injected.name.elements.filter(
        (element) => element.name.getText(executionAst) === name,
      );
      assert.equal(binding.length, 1);
      assert.equal(binding[0]!.propertyName, undefined);
    }
    const selected = variable(execution, 'agentRuntime').initializer!;
    assert.equal(
      compact(selected, executionAst),
      'resolveAgentRuntime(options,productionAgentRuntime)',
    );
    const selector = namedFunction(executionAst, 'resolveAgentRuntime');
    assert.equal(
      selector.parameters.at(-1)!.name.getText(executionAst),
      'productionAgentRuntime',
    );
    const fallback = selector.body!.statements.at(-1)!;
    assert.ok(ts.isReturnStatement(fallback));
    assert.equal(
      fallback.expression?.getText(executionAst),
      'productionAgentRuntime',
    );
    const mainTry = execution.statements.find(ts.isTryStatement);
    assert.ok(mainTry);
    const assignment = variable(mainTry.tryBlock, 'assignment');
    assert.equal(
      compact(assignment.initializer!, executionAst),
      'resolveAssignment(context,initial,request,options)',
    );
    const input = variable(mainTry.tryBlock, 'runtimeInput');
    const inputObject = input.initializer!;
    assert.ok(ts.isObjectLiteralExpression(inputObject));
    function conditionalFields(
      spread: ts.ObjectLiteralElementLike | undefined,
      condition: string,
    ) {
      assert.ok(spread && ts.isSpreadAssignment(spread));
      assert.ok(ts.isParenthesizedExpression(spread.expression));
      const branch = spread.expression.expression;
      assert.ok(ts.isConditionalExpression(branch));
      assert.equal(compact(branch.condition, executionAst), condition);
      assert.ok(ts.isObjectLiteralExpression(branch.whenTrue));
      assert.equal(branch.whenTrue.properties.length, 0);
      assert.ok(ts.isObjectLiteralExpression(branch.whenFalse));
      return branch.whenFalse.properties;
    }
    const assignmentFields = conditionalFields(
      inputObject.properties.at(-1),
      'assignment===null',
    );
    assert.equal(assignmentFields.length, 2);
    const binding = assignmentFields[0]!;
    assert.ok(ts.isPropertyAssignment(binding));
    assert.equal(binding.name.getText(executionAst), 'assignmentBinding');
    assert.equal(
      binding.initializer.getText(executionAst),
      'assignment.binding',
    );
    const turnFields = conditionalFields(
      assignmentFields[1],
      'assignment.nativeSessionTurn===null',
    );
    assert.equal(turnFields.length, 1);
    const turn = turnFields[0]!;
    assert.ok(ts.isPropertyAssignment(turn));
    assert.equal(turn.name.getText(executionAst), 'nativeSessionTurn');
    assert.equal(
      turn.initializer.getText(executionAst),
      'assignment.nativeSessionTurn',
    );
    assert.ok(assignment.end < input.pos);
    const report = variable(mainTry.tryBlock, 'report');
    assert.equal(
      compact(report.initializer!, executionAst),
      'execute(agentRuntime,runtimeInput,runtimeOptions)',
    );
    assert.ok(input.end < report.pos);
    for (const [wrapper, method] of [
      ['runProviderWorkerWithMandate', 'runSingleShot'],
      ['runProviderWorkerAsyncWithMandate', 'runSingleShotAsync'],
    ]) {
      const body = namedFunction(executionAst, wrapper!).body!;
      const result = variable(body, 'result').initializer!;
      const call = ts.isAwaitExpression(result) ? result.expression : result;
      assert.ok(ts.isCallExpression(call));
      assert.equal(
        call.expression.getText(executionAst),
        'runProviderWorkerWithExecution',
      );
      assert.equal(call.arguments[0]?.getText(executionAst), 'effects');
      const execute = call.arguments[5];
      assert.ok(execute && ts.isArrowFunction(execute));
      assert.deepEqual(
        execute.parameters.map((parameter) =>
          parameter.name.getText(executionAst),
        ),
        ['agentRuntime', 'input', 'runtimeOptions'],
      );
      let expression: ts.Node = execute.body;
      if (ts.isBlock(expression)) {
        assert.equal(expression.statements.length, 1);
        const returned = expression.statements[0]!;
        assert.ok(ts.isReturnStatement(returned) && returned.expression);
        expression = returned.expression;
      }
      const runtimeCalls = descendants(expression, ts.isCallExpression).filter(
        (node) =>
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === method,
      );
      assert.equal(runtimeCalls.length, 1);
      const runtimeCall = runtimeCalls[0]!;
      assert.ok(ts.isPropertyAccessExpression(runtimeCall.expression));
      assert.equal(
        runtimeCall.expression.expression.getText(executionAst),
        'agentRuntime',
      );
      assert.equal(runtimeCall.arguments[0]?.getText(executionAst), 'input');
      if (method === 'runSingleShot')
        assert.equal(
          runtimeCall.arguments[1]?.getText(executionAst),
          'runtimeOptions',
        );
      else {
        const options = runtimeCall.arguments[1];
        assert.ok(options && ts.isObjectLiteralExpression(options));
        assert.equal(
          options.properties[0]?.getText(executionAst),
          '...runtimeOptions',
        );
      }
    }
  }
  assertNativeWiring(applicationSource, productionSource);
  assert.throws(
    () =>
      assertNativeWiring(
        applicationSource,
        productionSource.replace(
          '  productionAgentRuntime,',
          '  productionAgentRuntime: fakeRuntime,',
        ) + '\nconst unusedRuntime = { productionAgentRuntime };',
      ),
    assert.AssertionError,
  );
  assert.throws(
    () =>
      assertNativeWiring(
        applicationSource.replace(
          'nativeSessionTurn: assignment.nativeSessionTurn',
          'unusedTurn: assignment.nativeSessionTurn',
        ) +
          '\nconst unusedInput = { nativeSessionTurn: assignment.nativeSessionTurn };',
        productionSource,
      ),
    assert.AssertionError,
  );
  assert.throws(
    () =>
      assertNativeWiring(
        applicationSource.replace(
          'execute(agentRuntime, runtimeInput, runtimeOptions)',
          'execute(agentRuntime, runtimeInputBase, runtimeOptions)',
        ),
        productionSource,
      ),
    assert.AssertionError,
  );
  for (const [field, value] of [
    ['nativeSessionTurn', 'assignment.nativeSessionTurn'],
    ['assignmentBinding', 'assignment.binding'],
  ] as const) {
    assert.throws(
      () =>
        assertNativeWiring(
          applicationSource.replace(
            `${field}: ${value}`,
            `unusedInput: { ${field}: ${value} }`,
          ),
          productionSource,
        ),
      assert.AssertionError,
    );
  }
  const runtimeSource = source('composition-root/agent-runtime-production.ts');
  assert.match(
    runtimeSource,
    /runHostWrapperProviderThroughAgentRuntimeV1\(input, options\)/u,
  );
  assert.match(runtimeSource, /input\.nativeSessionTurn === undefined/u);
});

function hostConfiguration(
  options: Readonly<{
    protocol?: 'harness-jsonl-v2' | 'single-shot';
    resumable?: boolean;
  }> = {},
): AgentProviderConfigSnapshot {
  const protocol = options.protocol ?? 'harness-jsonl-v2';
  const resumable = options.resumable ?? true;
  const profiles = ['alpha', 'beta', 'gamma'];
  const capabilities = [
    'fresh-session',
    'plan-review',
    ...(resumable ? ['resumable-session'] : []),
    'survey',
    'task-diff-review',
    'task-implementation',
  ];
  const providers = profiles
    .map((logicalProviderId) => {
      if (protocol === 'single-shot') {
        return `[[providers]]
id = "${logicalProviderId}-primary"
logical_provider_id = "${logicalProviderId}"
family = "${logicalProviderId}"
capabilities = [${capabilities.map((value) => `"${value}"`).join(', ')}]
trust_tier = "built-in-reviewed"
enabled = true
protocol = "${logicalProviderId}-jsonl-v1"
executable = "/opt/providers/${logicalProviderId}"`;
      }
      return `[[providers]]
id = "${logicalProviderId}-primary"
logical_provider_id = "${logicalProviderId}"
family = "${logicalProviderId}"
capabilities = [${capabilities.map((value) => `"${value}"`).join(', ')}]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = "/opt/providers/${logicalProviderId}"
start_args = ["start", "--request", "{request_file}"]
resume_args = [${
        resumable
          ? '"resume", "--session", "{native_session_id}", "--request", "{request_file}"'
          : ''
      }]
prompt_input = "stdin"
cancel = "process-group"`;
    })
    .join('\n\n');
  return parseAgentProviderConfigToml(
    `schema_version = 2
global_ranking = ["alpha-primary", "beta-primary", "gamma-primary"]

${providers}

[provider_preferences]
author = ["alpha-primary", "beta-primary", "gamma-primary"]
builder = ["beta-primary", "alpha-primary", "gamma-primary"]
reviewer = ["gamma-primary", "alpha-primary", "beta-primary"]
`,
    { platform: 'linux' },
  );
}

function assignmentRecord(
  options: Parameters<typeof hostConfiguration>[0] &
    Readonly<{ belowFloor?: boolean }> = {},
) {
  const configuration = hostConfiguration(options);
  const central = createCentralRoleProviderDefault({
    schemaVersion: 1,
    kind: 'central-role-provider-default',
    providerGroups: [
      {
        roles: ['author'],
        sessionGroups: [['author']],
        providerRule: { kind: 'adaptive-author' },
      },
      {
        roles: ['builder'],
        sessionGroups: [['builder']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: 'beta',
        },
      },
      {
        roles: ['reviewer'],
        sessionGroups: [['reviewer']],
        providerRule: {
          kind: 'ranked-fallback',
          preferredLogicalProviderId: 'gamma',
        },
      },
    ],
    globalProviderRanking: ['alpha', 'beta', 'gamma'],
  });
  const caller = {
    logicalProviderId: 'alpha',
    profileId: 'alpha-primary',
    engineSessionId: 'caller-session-alpha',
    adoptableRoles: ['author'] as const,
  };
  const dataAuthorization = {
    policyDigest: 'c'.repeat(64),
    inputManifestDigest: '4'.repeat(64),
    relevantTargetDigest: '5'.repeat(64),
    profiles: configuration.providers.map(({ id }) => ({
      profileId: id,
      allowed: true,
      reason: 'AUTHORIZED',
    })),
  };
  const sessionCapabilities = configuration.providers.map(({ id }) => ({
    profileId: id,
    canStartFresh: true,
    canResume: options.resumable ?? true,
  }));
  const providerRegistry = {
    schemaVersion: 1 as const,
    policyDigest: 'd'.repeat(64),
    providers: ['alpha', 'beta', 'gamma'].map((logicalProviderId, index) => ({
      logicalProviderId,
      providerFamily: logicalProviderId,
      enabled: true,
      definitionDigest: String(index + 1).repeat(64),
    })),
  };
  const providerRegistryDigest = crypto
    .createHash('sha256')
    .update(canonicalJson(providerRegistry))
    .digest('hex');
  const changeOverrideBody: AgentRolePlanBodyV2 = {
    schemaVersion: 2,
    changeId: CHANGE_ID,
    baseCentralConfigurationDigest: central.configurationDigest,
    roleLanes: [],
    pairwiseRequirements: options.belowFloor
      ? [
          { pair: 'author-builder', required: 'session-independent' },
          { pair: 'author-reviewer', required: 'session-independent' },
          { pair: 'builder-reviewer', required: 'session-independent' },
        ]
      : [],
    customWrapperPolicy: 'allowed',
    grantReferences: [],
  };
  const changeOverridePlan = {
    ...changeOverrideBody,
    planDigest: agentRolePlanV2Digest(changeOverrideBody),
  };
  const resolved = resolveChangeRoleAssignmentV1({
    changeId: CHANGE_ID,
    planningGeneration: PLANNING_GENERATION,
    providerRegistryDigest,
    centralDefault: central,
    changeOverride: changeOverridePlan,
    providerConfiguration: configuration,
    caller,
    dataAuthorization,
    sessionCapabilities,
    protectedContext: createChangeRoleAssignmentProtectedContextV1({
      classification: 'ordinary',
      pathRoleSourceDigest: '6'.repeat(64),
      policySourceDigest: '7'.repeat(64),
      inputManifestDigest: '4'.repeat(64),
      relevantTargetDigest: '5'.repeat(64),
    }),
  });
  assert.notEqual(resolved.outcome, 'unsatisfied');
  const centralSource = renderCentralRoleProviderDefault(central);
  const changeOverrideSource = renderAgentRolePlanV2(changeOverridePlan);
  const changeOverride = createAgentRolePlanV2Snapshot({
    pinnedCommit: 'b'.repeat(40),
    blobObjectId: crypto
      .createHash('sha1')
      .update(`blob ${Buffer.byteLength(changeOverrideSource)}\0`)
      .update(changeOverrideSource)
      .digest('hex'),
    plan: changeOverridePlan,
  });
  return createChangeRoleAssignmentRecordV1({
    central: createCentralRoleProviderDefaultSnapshotV1({
      pinnedCommit: 'b'.repeat(40),
      blobObjectId: crypto
        .createHash('sha1')
        .update(`blob ${Buffer.byteLength(centralSource)}\0`)
        .update(centralSource)
        .digest('hex'),
      configuration: central,
    }),
    host: { sourceDigest: 'e'.repeat(64), configuration },
    changeOverride,
    caller,
    dataAuthorization,
    sessionCapabilities,
    providerRegistry,
    resolution: (
      resolved as Exclude<typeof resolved, { outcome: 'unsatisfied' }>
    ).resolution,
  });
}

function slotFor(
  record: ReturnType<typeof assignmentRecord>,
  role: 'author' | 'builder' | 'reviewer',
) {
  return record.sessionSlots.find((slot) => slot.roles.includes(role))!;
}

function successfulTerminal(
  binding: ProviderWrapperSessionProtocolBinding,
  nativeSessionId: string,
) {
  let privateIdentityObservation:
    ProviderWrapperNativeSessionIdentityObservation | undefined;
  const parser = createProviderWrapperSessionProtocolParser({
    binding,
    privateNativeSessionIdentitySink(identity) {
      privateIdentityObservation = identity;
    },
  });
  parser.push(
    Buffer.from(
      [
        {
          schemaVersion: 2 as const,
          type: 'hello' as const,
          sequence: 1,
          protocol: 'harness-jsonl-v2' as const,
        },
        {
          schemaVersion: 2 as const,
          type: 'session' as const,
          sequence: 2,
          action: binding.sessionControl.action,
          nativeSessionId,
        },
        {
          schemaVersion: 2 as const,
          type: 'result' as const,
          sequence: 3,
          outputSlot: 'primary' as const,
        },
      ]
        .map(renderProviderWrapperSessionFrame)
        .join(''),
    ),
  );
  const outcome = parser.finish({ cancellationForced: false });
  assert.notEqual(privateIdentityObservation, undefined);
  return {
    kind: 'protocol-outcome' as const,
    outcome,
    privateIdentityObservation: privateIdentityObservation!,
  };
}

test('a below-floor assignment cannot create provider-native launch scope before Central Grant activation', () => {
  const record = assignmentRecord({ belowFloor: true });
  assert.notEqual(record.grantRequirement, null);

  assert.throws(
    () =>
      deriveProviderNativeSessionScopeV1(
        record,
        slotFor(record, 'builder').sessionSlotId,
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_ASSIGNMENT_AUTHORITY_REQUIRED',
  );
});

test('a below-floor assignment requires one exact authority verifier before deriving launch scope', () => {
  const record = assignmentRecord({ belowFloor: true });
  const slot = slotFor(record, 'builder');
  let verificationCalls = 0;
  const scope = deriveProviderNativeSessionScopeV1(
    record,
    slot.sessionSlotId,
    (candidate) => {
      verificationCalls += 1;
      assert.equal(candidate.recordDigest, record.recordDigest);
      assert.equal(candidate.assignmentDigest, record.assignmentDigest);
    },
  );
  assert.equal(verificationCalls, 1);
  assert.equal(scope.assignmentRecordDigest, record.recordDigest);

  assert.throws(
    () =>
      deriveProviderNativeSessionScopeV1(record, slot.sessionSlotId, () => {
        throw new Error('exact completed role-assignment Grant is stale');
      }),
    /exact completed role-assignment Grant is stale/,
  );
});

test('scope and public terminal records bind the exact assignment-wide slot without raw native identity', () => {
  const record = assignmentRecord();
  const builderSlot = slotFor(record, 'builder');
  const scope = deriveProviderNativeSessionScopeV1(
    record,
    builderSlot.sessionSlotId,
  );
  const replay = deriveProviderNativeSessionScopeV1(
    record,
    builderSlot.sessionSlotId,
  );

  assert.deepEqual(scope, replay);
  assert.equal(scope.assignmentRecordDigest, record.recordDigest);
  assert.equal(scope.resolutionDigest, record.resolution.resolutionDigest);
  assert.equal(scope.sessionSlotId, builderSlot.sessionSlotId);
  assert.equal(scope.profileId, 'beta-primary');
  assert.equal(
    scope.providerConfigurationDigest,
    record.resolution.providerConfigurationDigest,
  );
  assert.equal(
    scope.providerRegistryDigest,
    record.resolution.providerRegistryDigest,
  );
  assert.match(scope.scopeKey, /^[0-9a-f]{64}$/u);

  const binding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-start-1',
    requestDigest: '1'.repeat(64),
    attemptId: 'native-attempt-1',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
  const claim = createProviderNativeSessionClaimV1({
    scope,
    turn: 1,
    predecessorCompletion: null,
    binding,
  });
  const nativeSessionId = 'provider-native-secret-1';
  const materialized = createProviderNativeSessionCompletionV1({
    claim,
    binding,
    terminal: successfulTerminal(binding, nativeSessionId),
  });

  assert.equal(materialized.completion.disposition, 'usable');
  assert.equal(materialized.completion.protocolReceipt?.terminal, 'result');
  assert.equal(materialized.handle?.nativeSessionId, nativeSessionId);
  assert.equal(canonicalJson(scope).includes(nativeSessionId), false);
  assert.equal(canonicalJson(claim).includes(nativeSessionId), false);
  assert.equal(
    canonicalJson(materialized.completion).includes(nativeSessionId),
    false,
  );
  assert.equal(Object.isFrozen(materialized.completion), true);
});

test('usable completion requires the exact receipt-bound private identity observation', () => {
  const record = assignmentRecord();
  const scope = deriveProviderNativeSessionScopeV1(
    record,
    slotFor(record, 'builder').sessionSlotId,
  );
  const binding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-observation-binding',
    requestDigest: '9'.repeat(64),
    attemptId: 'native-observation-attempt',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
  const claim = createProviderNativeSessionClaimV1({
    scope,
    turn: 1,
    predecessorCompletion: null,
    binding,
  });
  const terminal = successfulTerminal(
    binding,
    'provider-native-observation-secret',
  );

  assert.throws(
    () =>
      createProviderNativeSessionCompletionV1({
        claim,
        binding,
        terminal: {
          kind: 'protocol-outcome',
          outcome: terminal.outcome,
        } as never,
      }),
    /Provider-native session state is invalid or unsupported\./u,
  );
  assert.throws(
    () =>
      createProviderNativeSessionCompletionV1({
        claim,
        binding,
        terminal: {
          ...terminal,
          privateIdentityObservation: {
            ...terminal.privateIdentityObservation,
            protocolReceiptDigest: '8'.repeat(64),
          },
        },
      }),
    /Provider-native session state is invalid or unsupported\./u,
  );
  const substitutedNativeSessionId = 'provider-native-substituted-secret';
  assert.throws(
    () =>
      createProviderNativeSessionCompletionV1({
        claim,
        binding,
        terminal: {
          ...terminal,
          privateIdentityObservation: {
            ...terminal.privateIdentityObservation,
            nativeSessionId: substitutedNativeSessionId,
            nativeSessionIdDigest: providerNativeSessionIdDigest(
              substitutedNativeSessionId,
            ),
          },
        },
      }),
    /Provider-native session state is invalid or unsupported\./u,
  );
});

test('resume binds the exact usable predecessor and never serializes its raw native identity', () => {
  const record = assignmentRecord();
  const scope = deriveProviderNativeSessionScopeV1(
    record,
    slotFor(record, 'builder').sessionSlotId,
  );
  const startBinding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-start-2',
    requestDigest: '2'.repeat(64),
    attemptId: 'native-attempt-2',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
  const firstClaim = createProviderNativeSessionClaimV1({
    scope,
    turn: 1,
    predecessorCompletion: null,
    binding: startBinding,
  });
  const nativeSessionId = 'provider-native-secret-2';
  const first = createProviderNativeSessionCompletionV1({
    claim: firstClaim,
    binding: startBinding,
    terminal: successfulTerminal(startBinding, nativeSessionId),
  });
  const resumeBinding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-resume-2',
    requestDigest: '3'.repeat(64),
    attemptId: 'native-attempt-3',
    sessionControl: {
      action: 'resume',
      nativeSessionIdentityMode: 'engine-supplied',
      expectedNativeSessionId: nativeSessionId,
    },
  };
  const resumeClaim = createProviderNativeSessionClaimV1({
    scope,
    turn: 2,
    predecessorCompletion: first.completion,
    binding: resumeBinding,
  });

  assert.equal(resumeClaim.action, 'resume');
  assert.equal(
    resumeClaim.predecessorCompletionDigest,
    first.completion.completionDigest,
  );
  assert.equal(
    resumeClaim.expectedNativeSessionIdDigest,
    first.completion.nativeSessionIdDigest,
  );
  assert.equal(canonicalJson(resumeClaim).includes(nativeSessionId), false);

  assert.throws(
    () =>
      createProviderNativeSessionClaimV1({
        scope,
        turn: 3,
        predecessorCompletion: {
          ...first.completion,
          disposition: 'timeout',
        } as typeof first.completion,
        binding: resumeBinding,
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_INVALID',
  );
});

test('caller-existing, V1/single-shot profiles, and missing resume evidence fail closed', () => {
  const current = assignmentRecord();
  assert.throws(
    () =>
      deriveProviderNativeSessionScopeV1(
        current,
        slotFor(current, 'author').sessionSlotId,
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_CALLER_EXISTING_UNSUPPORTED',
  );

  const singleShot = assignmentRecord({ protocol: 'single-shot' });
  assert.throws(
    () =>
      deriveProviderNativeSessionScopeV1(
        singleShot,
        slotFor(singleShot, 'builder').sessionSlotId,
      ),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_PROTOCOL_UNSUPPORTED',
  );

  const nonResumable = assignmentRecord({ resumable: false });
  const scope = deriveProviderNativeSessionScopeV1(
    nonResumable,
    slotFor(nonResumable, 'builder').sessionSlotId,
  );
  const startBinding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-start-no-resume',
    requestDigest: '4'.repeat(64),
    attemptId: 'native-attempt-no-resume',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
  const claim = createProviderNativeSessionClaimV1({
    scope,
    turn: 1,
    predecessorCompletion: null,
    binding: startBinding,
  });
  const nativeSessionId = 'provider-native-no-resume';
  const completed = createProviderNativeSessionCompletionV1({
    claim,
    binding: startBinding,
    terminal: successfulTerminal(startBinding, nativeSessionId),
  });
  assert.throws(
    () =>
      createProviderNativeSessionClaimV1({
        scope,
        turn: 2,
        predecessorCompletion: completed.completion,
        binding: {
          invocationId: 'native-resume-without-evidence',
          requestDigest: '5'.repeat(64),
          attemptId: 'native-attempt-without-evidence',
          sessionControl: {
            action: 'resume',
            nativeSessionIdentityMode: 'engine-supplied',
            expectedNativeSessionId: nativeSessionId,
          },
        },
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'PROVIDER_NATIVE_SESSION_CAPABILITY_UNSUPPORTED',
  );
});

test('error, cancellation, timeout, and claim-crash are terminal and unusable', () => {
  const record = assignmentRecord();
  const scope = deriveProviderNativeSessionScopeV1(
    record,
    slotFor(record, 'builder').sessionSlotId,
  );
  const binding: ProviderWrapperSessionProtocolBinding = {
    invocationId: 'native-terminal-1',
    requestDigest: '6'.repeat(64),
    attemptId: 'native-terminal-attempt-1',
    sessionControl: {
      action: 'start',
      nativeSessionIdentityMode: 'provider-observed',
      expectedNativeSessionId: null,
    },
  };
  const claim = createProviderNativeSessionClaimV1({
    scope,
    turn: 1,
    predecessorCompletion: null,
    binding,
  });
  const parser = createProviderWrapperSessionProtocolParser({ binding });
  parser.push(
    Buffer.from(
      [
        {
          schemaVersion: 2 as const,
          type: 'hello' as const,
          sequence: 1,
          protocol: 'harness-jsonl-v2' as const,
        },
        {
          schemaVersion: 2 as const,
          type: 'error' as const,
          sequence: 2,
          code: 'PROVIDER_FAILED',
        },
      ]
        .map(renderProviderWrapperSessionFrame)
        .join(''),
    ),
  );
  const providerError = createProviderNativeSessionCompletionV1({
    claim,
    binding,
    terminal: {
      kind: 'protocol-outcome',
      outcome: parser.finish({ cancellationForced: false }),
      privateIdentityObservation: null,
    },
  });
  const timeout = createProviderNativeSessionCompletionV1({
    claim,
    binding,
    terminal: { kind: 'timeout' },
  });
  const crash = createProviderNativeSessionCompletionV1({
    claim,
    binding,
    terminal: { kind: 'claim-crash' },
  });

  assert.equal(providerError.completion.disposition, 'error');
  assert.equal(providerError.handle, null);
  assert.equal(timeout.completion.disposition, 'timeout');
  assert.equal(timeout.handle, null);
  assert.equal(crash.completion.disposition, 'indeterminate');
  assert.equal(crash.handle, null);
  assert.equal(
    [providerError, timeout, crash].every(
      ({ completion }) => completion.usable === false,
    ),
    true,
  );
});
