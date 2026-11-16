/** Exact authority binding carried by execution jobs and Grants. */
export type TaskMandateBinding = {
  schemaVersion: 1;
  mandateTaskId: string;
  mandateId: string;
  mandateDigest: string;
  changeId: string;
  externalAuditRoot: string;
};
