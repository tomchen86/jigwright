/** Resolves current physical context before inspecting intake inventory. */
import type { createGovernanceIntakeCountInspector } from './governance-intake-workflow.ts';
export function createCurrentGovernanceIntakeCounts(operations: {
  observe(cwd: string): { repositoryRoot: string; runtimeRoot: string };
  inspect: ReturnType<typeof createGovernanceIntakeCountInspector>;
}) {
  return function currentGovernanceIntakeCounts(cwd: string) {
    const context = operations.observe(cwd);
    return operations.inspect(context.repositoryRoot, context.runtimeRoot);
  };
}
