/** Canonical OpenSpec diagnostic values shared by the provider and repository doctor. */
export const OPENSPEC_PACKAGE_NAME = '@fission-ai/openspec';

export type OpenSpecDiagnostic = {
  severity: 'error' | 'warning' | 'info';
  code: string;
  message: string;
  target?: string;
  fix?: string;
  causeCode?: string;
};

type InstallationDiagnostic = {
  ok: boolean;
  packageName: typeof OPENSPEC_PACKAGE_NAME;
  declaredVersion: '1.6.0';
  lockfileVersion: string | null;
  lockedVersion: string | null;
  integrity: string | null;
  buildScriptsAllowed: boolean | null;
  installedVersion: string | null;
  packageDirectory: string | null;
  binPath: string | null;
};

type RuntimeDiagnostic = {
  ok: boolean;
  version: string | null;
};

type RootDiagnostic = {
  ok: boolean;
  path: string | null;
  source: 'nearest' | null;
  healthy: boolean | null;
  storeActive: boolean | null;
};

export type SchemaDiagnostic = {
  name: string;
  expectedSource: 'package' | 'project';
  ok: boolean;
  resolution: { source: 'package' | 'project'; path: string } | null;
  validation: { valid: boolean; issueCount: number } | null;
};

export type OpenSpecDiagnosticReport = {
  expectedVersion: '1.6.0';
  healthy: boolean;
  installation: InstallationDiagnostic;
  runtime: RuntimeDiagnostic;
  root: RootDiagnostic;
  schemas: SchemaDiagnostic[];
  diagnostics: OpenSpecDiagnostic[];
};
