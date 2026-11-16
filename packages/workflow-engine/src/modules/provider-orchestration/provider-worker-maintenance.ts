/** Durable warning facts for maintenance after a provider terminal outcome. */
export type ProviderWorkerMaintenanceWarning = Readonly<{
  schemaVersion: 1;
  kind: 'provider-worker-maintenance-warning';
  warningId: string;
  operation:
    'automatic-retry' | 'retry-schedule-pump' | 'retention-maintenance';
  invocationId: string;
  terminalRevision: number;
  terminalState: 'succeeded' | 'failed';
  errorCode: string;
  message: string;
  occurredAt: string;
}>;
