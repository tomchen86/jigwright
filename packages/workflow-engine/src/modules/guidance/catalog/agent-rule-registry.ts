import { GOVERNANCE_SOURCE_TEXT_POLICY } from '@jigwright/core/governance-source';
import {
  INTAKE_KINDS,
  INTAKE_POLICY,
  isRequirementKind,
} from '../../governance-intake/intake-policy.ts';
import { resolveManagedWorkflowCommand } from './managed-workflow-command-registry.ts';
import { R000_PRODUCT_PURPOSE } from './agent-rule-sources.ts';

/** Provider-neutral rules; source ownership stays with the behavior or R-000. */
export function renderAgentGuidanceRules(): string {
  const guide = resolveManagedWorkflowCommand('guide').usage[0]!.replace(
    ' [--json]',
    '',
  );
  const observations =
    INTAKE_POLICY.taskDestination === 'finding' ? 'Finding' : 'Work Item';
  const observationKinds = INTAKE_KINDS.filter(
    (kind) => !isRequirementKind(kind),
  ).join('/');
  return [
    `- R-000: ${R000_PRODUCT_PURPOSE}`,
    `- Transcribe the user's wording ${GOVERNANCE_SOURCE_TEXT_POLICY.preservation} and echo \`${GOVERNANCE_SOURCE_TEXT_POLICY.echoField}\` exactly; preserve whitespace and line breaks, without paraphrasing or summarizing.`,
    `- Record your own observations as a ${observations} during an active task. Outside a task, use observation intake (${observationKinds}) without inventing a user Source.`,
    `- When blocked or unsure of the next workflow step, run \`${guide}\` and follow the returned guidance.`,
  ].join('\n');
}
