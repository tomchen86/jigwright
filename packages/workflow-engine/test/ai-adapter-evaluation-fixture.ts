/** Diagnostic policy, external host provider configuration, and CLI fixtures. */
import { DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING } from '../src/runtime/provider-policy/ai-adapter-policy.ts';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sourceRepositoryRoot } from './fixture.ts';

export const REQUIRED_CONTROLS = [
  'separate-security-principal',
  'kernel-enforced-write-boundary',
  'git-common-directory-isolation',
  'network-egress-control',
  'secret-isolation',
  'subprocess-tree-confinement',
  'resource-limits',
  'immutable-runtime',
];

export function validPolicy(): Record<string, unknown> {
  return {
    schemaVersion: 4,
    mode: 'managed-read-only',
    launchPolicy: 'lifecycle-only',
    requiredControls: [...REQUIRED_CONTROLS],
    providers: providersPolicy(),
    limits: limitsPolicy(),
    retryAccounting: structuredClone(DEFAULT_AI_ADAPTER_RETRY_ACCOUNTING),
  };
}

export function hostProviderConfiguration(markerPath: string): string {
  const executable = JSON.stringify(
    process.platform === 'win32'
      ? 'C:\\Tools\\provider-wrapper.exe'
      : '/usr/local/bin/provider-wrapper',
  );
  const marker = JSON.stringify(markerPath);
  return `
schema_version = 2
global_ranking = ["author-claude", "builder-codex", "reviewer-claude"]

[[providers]]
id = "author-claude"
logical_provider_id = "claude"
family = "claude"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = ${executable}
start_args = ["run", "--marker", ${marker}, "--request", "{request_file}"]
resume_args = ["resume", "--session", "{native_session_id}", "--marker", ${marker}, "--request", "{request_file}"]
prompt_input = "stdin"
cancel = "process-group"

[[providers]]
id = "builder-codex"
logical_provider_id = "codex"
family = "codex"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = ${executable}
start_args = ["run", "--marker", ${marker}, "--request", "{request_file}"]
resume_args = ["resume", "--session", "{native_session_id}", "--marker", ${marker}, "--request", "{request_file}"]
prompt_input = "stdin"
cancel = "process-group"

[[providers]]
id = "reviewer-claude"
logical_provider_id = "claude"
family = "claude"
capabilities = ["fresh-session", "plan-review", "survey", "task-diff-review", "task-implementation"]
trust_tier = "host-wrapper"
enabled = true
protocol = "harness-jsonl-v2"
executable = ${executable}
start_args = ["run", "--marker", ${marker}, "--request", "{request_file}"]
resume_args = ["resume", "--session", "{native_session_id}", "--marker", ${marker}, "--request", "{request_file}"]
prompt_input = "stdin"
cancel = "process-group"

[provider_preferences]
author = ["author-claude", "builder-codex", "reviewer-claude"]
builder = ["builder-codex", "author-claude", "reviewer-claude"]
reviewer = ["reviewer-claude", "builder-codex", "author-claude"]
`;
}

export function providersPolicy() {
  return {
    codex: { enabled: true },
    claude: { enabled: true },
  };
}

export function limitsPolicy() {
  return {
    timeoutMs: 3_600_000,
    aggregateOutputBytes: 1_048_576,
    maxConcurrent: 2,
  };
}

export function writePolicy(repository: string, value: unknown): void {
  const policyPath = adapterPolicyPath(repository);
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.rmSync(policyPath, { force: true });
  fs.writeFileSync(policyPath, `${JSON.stringify(value, null, 2)}\n`);
}

export function adapterPolicyPath(repository: string): string {
  return path.join(repository, 'workflow/ai-adapter-policy.json');
}

export function runCli(
  repository: string,
  args: string[],
  environment: Record<string, string> = {},
) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      path.join(
        sourceRepositoryRoot,
        'packages/workflow-engine/bootstrap/workflow-engine-host.ts',
      ),
      ...args,
    ],
    {
      cwd: repository,
      encoding: 'utf8',
      env: { ...process.env, ...environment },
    },
  );
}
