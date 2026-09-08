/** Shared by intake routing and generated agent guidance. */
export const INTAKE_KINDS = [
  'feature',
  'bug',
  'improvement',
  'chore',
  'research',
] as const;

export const INTAKE_POLICY = Object.freeze({
  requirementKinds: ['improvement', 'feature'] as readonly string[],
  taskDestination: 'finding',
  observationDestination: 'work-item',
} as const);

export function isRequirementKind(kind: string): boolean {
  return INTAKE_POLICY.requirementKinds.includes(kind);
}

export function deferredIntakeDestination(
  activeTask: boolean,
): 'finding' | 'work-item' {
  return activeTask
    ? INTAKE_POLICY.taskDestination
    : INTAKE_POLICY.observationDestination;
}
