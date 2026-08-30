import { renderHandoff } from '../adapters/consumer/repository/handoff/handoff.ts';
import { repositoryHandoffRelativePath } from '../adapters/consumer/repository/work-registry/contracts.ts';

export function renderGovernanceIntakeHandoff(repositoryRoot: string): string {
  renderHandoff(repositoryRoot);
  return repositoryHandoffRelativePath(repositoryRoot);
}
