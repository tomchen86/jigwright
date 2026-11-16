/** Planning workspace identity and operations required by proposal and task activation. */
export type PlanningDraftWorkspaceRecord = Readonly<{
  schemaVersion: 1;
  kind: 'planning-draft-workspace.v1';
  changeId: string;
  branch: string;
  baseCommit: string;
  gitCommonDirectory: string;
  worktreePath: string;
  createdAt: string;
}>;

export type PreparedPlanningDraftWorkspace = PlanningDraftWorkspaceRecord &
  Readonly<{ status: 'created' | 'reused' }>;

export type PreparePlanningDraftWorkspaceOptions = Readonly<{
  baseCommit?: string;
  workspaceParent?: string;
  adoptCurrentWorktree?: boolean;
  now?: Date;
  testBeforeWorktreeAdd?: () => void;
}>;
export type PlanningDraftWorkspacePort = Readonly<{
  preparePlanningDraftWorkspace(
    cwd: string,
    changeId: string,
    options?: PreparePlanningDraftWorkspaceOptions,
  ): PreparedPlanningDraftWorkspace;
  readPlanningDraftWorkspace(
    cwd: string,
    changeId: string,
  ): PlanningDraftWorkspaceRecord | null;
  inspectPlanningDraftWorkspace(
    cwd: string,
    changeId: string,
  ): PlanningDraftWorkspaceRecord | null;
}>;
